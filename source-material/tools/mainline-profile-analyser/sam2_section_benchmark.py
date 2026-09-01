#!/usr/bin/env python3
"""Benchmark SAM 2.1 as an automatic Mainline cut-face refiner.

This experiment consumes only supplier spin frames and the automatic classical
pilot masks. The classical mask supplies coarse positive/negative prompts; SAM
2 decides the pixel boundary. Outputs remain renderer-independent.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw
from scipy.signal import medfilt
from transformers import Sam2Model, Sam2Processor


def lower_boundary(mask: np.ndarray, xs: np.ndarray) -> np.ndarray:
    values = np.full(len(xs), np.nan, dtype=np.float64)
    for offset, x in enumerate(xs):
        rows = np.flatnonzero(mask[:, x])
        if len(rows):
            values[offset] = rows[-1]
    valid = np.isfinite(values)
    if valid.sum() < max(8, len(xs) // 3):
        raise ValueError("Mask has insufficient cut-face coverage")
    values = np.interp(np.arange(len(values)), np.flatnonzero(valid), values[valid])
    if len(values) >= 5:
        values = medfilt(values, kernel_size=5)
    return values


def guided_boundary(mask: np.ndarray, xs: np.ndarray, prior: np.ndarray,
                    max_delta: int) -> tuple[np.ndarray, float]:
    """Choose the learned lower-edge transition nearest the coarse contour."""
    values = np.empty(len(xs), dtype=np.float64)
    fallbacks = 0
    for offset, (x, expected) in enumerate(zip(xs, prior)):
        column = mask[:, x]
        endings = np.flatnonzero(column[:-1] & ~column[1:])
        if len(endings):
            closest = int(endings[np.argmin(np.abs(endings - expected))])
            if abs(closest - expected) <= max_delta:
                values[offset] = closest
                continue
        values[offset] = expected
        fallbacks += 1
    if len(values) >= 5:
        values = medfilt(values, kernel_size=5)
    return values, fallbacks / max(len(values), 1)


def keep_prompt_component(mask: np.ndarray, positive_points: list[list[int]]) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if count < 2:
        return mask
    votes = np.zeros(count, dtype=np.int32)
    for x, y in positive_points:
        votes[labels[min(max(y, 0), mask.shape[0] - 1),
                     min(max(x, 0), mask.shape[1] - 1)]] += 1
    votes[0] = -1
    component = int(np.argmax(votes))
    if votes[component] == 0:
        component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == component


def prompts_from_prior(prior: np.ndarray) -> tuple[list[list[int]], list[int], list[int]]:
    ys, xs = np.nonzero(prior)
    if not len(xs):
        raise ValueError("Empty classical cut-face mask")
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    span = max(x1 - x0, 1)
    positives: list[list[int]] = []
    negatives: list[list[int]] = []
    for fraction in np.linspace(0.10, 0.90, 7):
        x = int(round(x0 + span * fraction))
        rows = np.flatnonzero(prior[:, x])
        if not len(rows):
            continue
        top, bottom = int(rows[0]), int(rows[-1])
        positives.append([x, int(round(top * 0.38 + bottom * 0.62))])
        negatives.append([x, min(prior.shape[0] - 1, bottom + max(4, (y1 - y0) // 12))])
    if len(positives) < 3:
        raise ValueError("Could not derive automatic SAM prompts")
    pad_x = max(3, span // 25)
    pad_y = max(4, (y1 - y0) // 8)
    box = [max(0, x0 - pad_x), max(0, y0 - pad_y),
           min(prior.shape[1] - 1, x1 + pad_x),
           min(prior.shape[0] - 1, y1 + pad_y * 2)]
    return positives + negatives, [1] * len(positives) + [0] * len(negatives), box


def mask_metrics(mask: np.ndarray, prior: np.ndarray, points: list[list[int]],
                 labels: list[int], model_iou: float) -> tuple[float, dict]:
    intersection = int(np.count_nonzero(mask & prior))
    union = int(np.count_nonzero(mask | prior))
    prior_area = max(int(np.count_nonzero(prior)), 1)
    area_ratio = int(np.count_nonzero(mask)) / prior_area
    iou = intersection / max(union, 1)
    positive_hits = []
    negative_hits = []
    for (x, y), label in zip(points, labels):
        hit = bool(mask[y, x])
        (positive_hits if label == 1 else negative_hits).append(hit)
    positive_coverage = sum(positive_hits) / max(len(positive_hits), 1)
    negative_exclusion = 1.0 - sum(negative_hits) / max(len(negative_hits), 1)
    area_penalty = abs(np.log(max(area_ratio, 1e-4)))
    score = (0.32 * float(model_iou) + 0.25 * positive_coverage
             + 0.20 * negative_exclusion + 0.23 * iou - 0.45 * area_penalty)
    constraints_pass = (positive_coverage >= 0.85 and negative_exclusion >= 0.85
                        and 0.40 <= area_ratio <= 2.0)
    if not constraints_pass:
        score -= 5.0
    return score, {
        "modelPredictedIou": round(float(model_iou), 4),
        "classicalMaskIou": round(float(iou), 4),
        "positivePromptCoverage": round(float(positive_coverage), 4),
        "negativePromptExclusion": round(float(negative_exclusion), 4),
        "areaRatioToClassical": round(float(area_ratio), 4),
        "promptAndAreaConstraintsPass": bool(constraints_pass),
        "selectionScore": round(float(score), 4),
    }


def physical_curve(boundary: np.ndarray, width_mm: float, depth_mm: float,
                   samples: int = 241) -> np.ndarray:
    pixels_per_mm = max(len(boundary) / max(width_mm, 1e-6), 1e-6)
    deepest = float(np.percentile(boundary, 98))
    millimetres = np.clip(depth_mm - (deepest - boundary) / pixels_per_mm, 0.0, depth_mm)
    return np.interp(np.linspace(0.0, 1.0, samples),
                     np.linspace(0.0, 1.0, len(millimetres)), millimetres)


def draw_overlay(image: Image.Image, classical: np.ndarray, learned: np.ndarray,
                 xs: np.ndarray, points: list[list[int]], labels: list[int]) -> Image.Image:
    overlay = image.copy()
    draw = ImageDraw.Draw(overlay)
    draw.line([(int(x), float(y)) for x, y in zip(xs, classical)],
              fill="#42dc77", width=2)
    draw.line([(int(x), float(y)) for x, y in zip(xs, learned)],
              fill="#25c9ef", width=2)
    for (x, y), label in zip(points, labels):
        colour = "#f5c94d" if label == 1 else "#ef4e57"
        draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=colour)
    return overlay


def benchmark_frame(model: Sam2Model, processor: Sam2Processor, device: torch.device,
                    image_path: Path, prior_path: Path, output: Path,
                    width_mm: float, depth_mm: float) -> tuple[dict, np.ndarray, np.ndarray]:
    image = Image.open(image_path).convert("RGB")
    prior = cv2.imread(str(prior_path), cv2.IMREAD_GRAYSCALE) > 0
    points, labels, box = prompts_from_prior(prior)
    inputs = processor(images=image, input_points=[[points]], input_labels=[[labels]],
                       input_boxes=[[box]], return_tensors="pt").to(device)
    coarse_mask = cv2.resize(prior.astype(np.float32), (256, 256),
                             interpolation=cv2.INTER_NEAREST)
    inputs["input_masks"] = torch.from_numpy(coarse_mask)[None, None].to(device)
    started = time.perf_counter()
    with torch.inference_mode():
        outputs = model(**inputs, multimask_output=True)
    elapsed = time.perf_counter() - started
    masks = processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"])[0]
    masks = masks.squeeze(0).numpy() > 0
    predicted_ious = outputs.iou_scores.detach().cpu().reshape(-1).numpy()

    candidates = []
    positive_points = [point for point, label in zip(points, labels) if label == 1]
    prior_ys, prior_xs = np.nonzero(prior)
    px0, px1 = int(prior_xs.min()), int(prior_xs.max())
    py0, py1 = int(prior_ys.min()), int(prior_ys.max())
    band_pad = max(6, (py1 - py0) // 7)
    allowed = np.zeros_like(prior)
    allowed[max(0, py0 - band_pad):min(prior.shape[0], py1 + band_pad * 2 + 1),
            max(0, px0 - band_pad):min(prior.shape[1], px1 + band_pad + 1)] = True
    for index, raw_mask in enumerate(masks):
        # SAM occasionally returns a topologically consistent background or
        # whole-product mask. The target is a local refinement of the exposed
        # section, so pixels far outside its automatically detected band are
        # never admissible.
        candidate = keep_prompt_component(raw_mask & allowed, positive_points)
        score, metrics = mask_metrics(candidate, prior, points, labels,
                                      predicted_ious[min(index, len(predicted_ious) - 1)])
        candidates.append((score, index, candidate, metrics))
    _, chosen_index, learned_mask, metrics = max(candidates, key=lambda item: item[0])

    prior_columns = np.flatnonzero(prior.any(axis=0))
    xs = np.arange(int(prior_columns[0]), int(prior_columns[-1]) + 1)
    classical_boundary = lower_boundary(prior, xs)
    max_delta = max(6, int(round((np.percentile(classical_boundary, 98)
                                  - np.percentile(classical_boundary, 2)) * 0.28)))
    learned_boundary, fallback_rate = guided_boundary(
        learned_mask, xs, classical_boundary, max_delta)
    delta = np.abs(classical_boundary - learned_boundary)

    stem = image_path.stem
    mask_name = f"{stem}-sam2-mask.png"
    overlay_name = f"{stem}-sam2-overlay.png"
    Image.fromarray((learned_mask * 255).astype(np.uint8)).save(output / mask_name)
    draw_overlay(image, classical_boundary, learned_boundary, xs, points, labels).save(output / overlay_name)
    record = {
        "frame": stem,
        "source": image_path.name,
        "classicalMask": prior_path.name,
        "learnedMask": mask_name,
        "overlay": overlay_name,
        "selectedCandidate": int(chosen_index),
        "inferenceSeconds": round(elapsed, 3),
        "boundaryMedianDifferencePixels": round(float(np.median(delta)), 3),
        "boundaryP95DifferencePixels": round(float(np.percentile(delta, 95)), 3),
        "boundaryFallbackRate": round(float(fallback_rate), 4),
        "maximumAllowedBoundaryDeltaPixels": int(max_delta),
        "prompts": {"points": points, "labels": labels, "box": box},
        "candidateMetrics": [item[3] for item in candidates],
        **metrics,
    }
    record["boundaryRefinementConstraintsPass"] = bool(
        fallback_rate <= 0.30
        and metrics["positivePromptCoverage"] >= 0.85
        and record["boundaryP95DifferencePixels"] <= max_delta)
    return record, physical_curve(learned_boundary, width_mm, depth_mm), physical_curve(classical_boundary, width_mm, depth_mm)


def profile_plot(curve: np.ndarray, width_mm: float, depth_mm: float, output: Path) -> None:
    canvas = Image.new("RGB", (900, 440), "#f2f1ed")
    draw = ImageDraw.Draw(canvas)
    margin = 55
    draw.line((margin, 380, 850, 380), fill="#777", width=2)
    draw.line((margin, 380, margin, 40), fill="#777", width=2)
    u = np.linspace(0.0, width_mm, len(curve))
    points = [(margin + x / width_mm * 795, 380 - z / depth_mm * 330)
              for x, z in zip(u, curve)]
    draw.line(points, fill="#168dab", width=5, joint="curve")
    canvas.save(output)


def simplify_profile(curve: np.ndarray, width_mm: float) -> list[list[float]]:
    u = np.linspace(0.0, width_mm, len(curve))
    points = np.column_stack((u, curve)).astype(np.float32).reshape(-1, 1, 2)
    simplified = cv2.approxPolyDP(points, max(0.14, width_mm * 0.0025), False).reshape(-1, 2)
    simplified[0, 0], simplified[-1, 0] = 0.0, width_mm
    return [[round(float(x), 3), round(float(z), 3)] for x, z in simplified]


def diagnostic_html(record: dict) -> str:
    cards = "".join(f'''<article><h2>{frame['frame']}</h2><div class="images">
    <figure><img src="../../../spin/{frame['source']}"><figcaption>supplier frame</figcaption></figure>
    <figure><img src="{frame['learnedMask']}"><figcaption>SAM 2.1 cut-face mask</figcaption></figure>
    <figure><img src="{frame['overlay']}"><figcaption><b>green</b> classical · <b>cyan</b> SAM 2.1 · yellow/rose prompts</figcaption></figure>
    </div><p>model IoU {frame['modelPredictedIou']} · classical overlap {frame['classicalMaskIou']} · boundary P95 difference {frame['boundaryP95DifferencePixels']} px · {frame['inferenceSeconds']} s</p></article>'''
                    for frame in record["frames"])
    decision = record["decision"]
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{record['sku']} SAM 2 section benchmark</title><style>:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:1300px;margin:auto;padding:34px}}header{{border-bottom:1px solid #333;padding-bottom:20px}}.decision{{display:inline-block;border:1px solid {'#477654' if decision['learnedImprovesStability'] else '#86514b'};padding:9px 12px}}.metrics{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}}.metric,article,.profile{{background:#1b1b1b;padding:16px}}.metric strong{{display:block;color:#dfbf80;font-size:26px}}.images{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}}figure{{margin:0}}img{{display:block;width:100%;background:#fff}}p,figcaption{{color:#aaa}}figcaption b:first-child{{color:#42dc77}}figcaption b:nth-child(2){{color:#25c9ef}}.profile img{{max-height:430px;object-fit:contain}}@media(max-width:800px){{.metrics,.images{{grid-template-columns:1fr}}}}</style></head><body><header><p>LEARNED SEGMENTATION BENCHMARK · RENDERER UNCHANGED</p><h1>{record['sku']} · SAM 2.1 tiny</h1><div class="decision">{'IMPROVES MULTI-VIEW STABILITY' if decision['learnedImprovesStability'] else 'NO MEASURED IMPROVEMENT'}</div></header><div class="metrics"><div class="metric"><strong>{decision['learnedCrossViewP95Mm']} mm</strong>SAM cross-view P95</div><div class="metric"><strong>{decision['classicalCrossViewP95Mm']} mm</strong>classical cross-view P95</div><div class="metric"><strong>{record['averageInferenceSeconds']} s</strong>average CPU inference</div></div><section class="profile"><h2>Learned fused macro profile</h2><img src="sam2-profile.png"></section>{cards}</body></html>'''


def run_product(model: Sam2Model, processor: Sam2Processor, device: torch.device,
                root: Path, model_name: str) -> dict:
    candidate = json.loads((root / "profile-analysis" / "section-pilot" / "profile-candidate.json").read_text())
    width_mm, depth_mm = float(candidate["widthMm"]), float(candidate["depthMm"])
    model_slug = model_name.split("/")[-1]
    output_folder = f"sam2-section-benchmark-{model_slug}"
    output = root / "profile-analysis" / output_folder
    output.mkdir(parents=True, exist_ok=True)
    frames = []
    learned_curves = []
    classical_curves = []
    for frame in candidate["selectedFrames"]:
        source = root / "spin" / frame["filename"]
        prior = root / "profile-analysis" / "section-pilot" / frame["mask"]
        record, learned, classical = benchmark_frame(
            model, processor, device, source, prior, output, width_mm, depth_mm)
        frames.append(record)
        learned_curves.append(learned)
        classical_curves.append(classical)
    learned_stack = np.stack(learned_curves)
    classical_stack = np.stack(classical_curves)
    learned_fused = np.median(learned_stack, axis=0)
    classical_fused = np.median(classical_stack, axis=0)
    margin = max(4, learned_stack.shape[1] // 25)
    learned_stability = float(np.percentile(
        np.abs(learned_stack[:, margin:-margin] - learned_fused[margin:-margin]), 95))
    classical_stability = float(np.percentile(
        np.abs(classical_stack[:, margin:-margin] - classical_fused[margin:-margin]), 95))
    profile_plot(learned_fused, width_mm, depth_mm, output / "sam2-profile.png")
    record = {
        "sku": candidate["sku"],
        "model": model_name,
        "outputFolder": output_folder,
        "device": str(device),
        "widthMm": width_mm,
        "depthMm": depth_mm,
        "rendererIntegrated": False,
        "promptSource": "automatic-classical-cut-mask",
        "frames": frames,
        "points": simplify_profile(learned_fused, width_mm),
        "averageInferenceSeconds": round(float(np.mean([frame["inferenceSeconds"] for frame in frames])), 3),
        "decision": {
            "learnedCrossViewP95Mm": round(learned_stability, 3),
            "classicalCrossViewP95Mm": round(classical_stability, 3),
            "allBoundaryRefinementsPass": bool(all(
                frame["boundaryRefinementConstraintsPass"] for frame in frames)),
            "learnedImprovesStability": bool(
                all(frame["boundaryRefinementConstraintsPass"] for frame in frames)
                and learned_stability < classical_stability * 0.90),
        },
    }
    (output / "benchmark.json").write_text(json.dumps(record, indent=2) + "\n")
    (output / "diagnostic.html").write_text(diagnostic_html(record))
    return record


def summary_html(records: list[dict]) -> str:
    cards = "".join(f'''<a href="{record['sku']}/profile-analysis/{record['outputFolder']}/diagnostic.html"><strong>{record['sku']}</strong><span>{'IMPROVES' if record['decision']['learnedImprovesStability'] else 'NO IMPROVEMENT'}</span><small>SAM {record['decision']['learnedCrossViewP95Mm']} mm · classical {record['decision']['classicalCrossViewP95Mm']} mm</small></a>''' for record in records)
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:900px;margin:auto;padding:40px}}a{{display:grid;grid-template-columns:130px 1fr;gap:9px;background:#1b1b1b;color:#eee;text-decoration:none;padding:20px;margin:12px 0}}span{{text-align:right;color:#dfbf80}}small{{grid-column:1/3;color:#aaa}}</style></head><body><p>RENDERER-INDEPENDENT MODEL BENCHMARK</p><h1>SAM 2.1 cut-face segmentation</h1>{cards}</body></html>'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default="source-material/mainline")
    parser.add_argument("--skus", default="POL-4508,POL-4875")
    parser.add_argument("--model", default=".model-cache/sam2.1-hiera-base-plus")
    args = parser.parse_args()
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model_path = str(Path(args.model).resolve())
    processor = Sam2Processor.from_pretrained(model_path, local_files_only=True)
    model = Sam2Model.from_pretrained(model_path, local_files_only=True).to(device).eval()
    source_root = Path(args.source_root).resolve()
    records = []
    for sku in [value.strip() for value in args.skus.split(",") if value.strip()]:
        record = run_product(model, processor, device, source_root / sku,
                             f"facebook/{Path(model_path).name}")
        records.append(record)
        print(f"{sku}: SAM {record['decision']['learnedCrossViewP95Mm']} mm vs "
              f"classical {record['decision']['classicalCrossViewP95Mm']} mm")
    (source_root / "sam2-section-benchmark.json").write_text(json.dumps(records, indent=2) + "\n")
    (source_root / "sam2-section-benchmark.html").write_text(summary_html(records))
    print(f"Summary: {source_root / 'sam2-section-benchmark.html'}")


if __name__ == "__main__":
    main()
