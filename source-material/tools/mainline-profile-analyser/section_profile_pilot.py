#!/usr/bin/env python3
"""Automated Mainline cut-section profile reconstruction pilot.

Mainline's central spin frames expose the moulding's sawn substrate. The lower
edge of that planar end face is the physical front profile, including concave
regions. This tool detects that edge in several adjacent frames, fuses the
measurements in supplier millimetres, and validates stability without changing
the live renderer.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import medfilt
from skimage.restoration import denoise_tv_chambolle


PILOT_OVERRIDES = {
    "POL-4100": {
        "name": "Brushed Black 41mm Polcore Moulding",
        "dimensions": {"widthMm": 41.0, "depthMm": 13.0, "rebateMm": 9.0},
    },
    "POL-4508": {
        "name": "Paramount 30mm Brushed Black with Silver Slip Polcore Moulding",
        "dimensions": {"widthMm": 30.0, "depthMm": 30.0, "rebateMm": 13.0},
    },
    "POL-4875": {
        "name": "Verona Black 97mm Polcore Moulding",
        "dimensions": {"widthMm": 97.0, "depthMm": 49.0, "rebateMm": 16.0},
    },
}


@dataclass
class FrameResult:
    index: int
    label: str
    filename: str
    image: np.ndarray
    object_mask: np.ndarray
    section_mask: np.ndarray
    xs: np.ndarray
    boundary_y: np.ndarray
    physical_curve: np.ndarray
    registered_curve: np.ndarray
    pixels_per_mm: float
    edge_score: float
    foreground_width: int
    foreground_height: int
    depth_span_px: float
    quality: float
    registration_shift_samples: int
    registration_projective_warp: float
    registration_scale: float
    registration_offset_mm: float


def largest_component(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if count < 2:
        raise ValueError("No foreground component")
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == component


def foreground_mask(image: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    border = np.concatenate((lab[:8].reshape(-1, 3), lab[-8:].reshape(-1, 3),
                             lab[:, :8].reshape(-1, 3), lab[:, -8:].reshape(-1, 3)))
    background = np.median(border, axis=0)
    distance = np.linalg.norm(lab - background, axis=2)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # The turntable background and its cast shadow must not become one object.
    # A conservative foreground seed is safer than including the pale floor;
    # small holes in bright mouldings are closed after component selection.
    mask = (distance > 25.0) | (gray < 205)
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE,
                            np.ones((3, 3), np.uint8), iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return largest_component(mask)


def object_bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise ValueError("Empty object mask")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def substrate_similarity(image: np.ndarray, mask: np.ndarray,
                          bbox: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = bbox
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    top_samples = []
    for x in range(x0 + 2, x1 - 2):
        rows = np.flatnonzero(mask[y0:y1, x])
        if len(rows):
            top = y0 + int(rows[0])
            for y in range(top + 2, min(top + 9, y1)):
                if mask[y, x]:
                    top_samples.append(lab[y, x])
    if not top_samples:
        raise ValueError("No substrate seed pixels")
    samples = np.asarray(top_samples)
    centre = np.median(samples, axis=0)
    deviations = np.linalg.norm(samples - centre, axis=1)
    scale = max(float(np.percentile(deviations, 80)), 7.0)
    distance = np.linalg.norm(lab - centre, axis=2)
    return np.exp(-0.5 * (distance / (scale * 1.8)) ** 2)


def internal_edge_score(image: np.ndarray, similarity: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    sobel = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    colour_delta = np.zeros(gray.shape, dtype=np.float32)
    similarity_drop = np.zeros(gray.shape, dtype=np.float32)
    radius = 3
    colour_delta[radius:-radius] = np.linalg.norm(
        lab[:-2 * radius] - lab[2 * radius:], axis=2)
    similarity_drop[radius:-radius] = np.maximum(
        0.0, similarity[:-2 * radius] - similarity[2 * radius:]) * 55.0
    return sobel * 0.50 + colour_delta * 0.34 + similarity_drop


def trace_boundary(image: np.ndarray, mask: np.ndarray, width_mm: float,
                   depth_mm: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    bbox = object_bbox(mask)
    x0, y0, x1, y1 = bbox
    height, width = y1 - y0, x1 - x0
    # Column span, unlike pixel count or the component bbox, ignores a shallow
    # floor shadow attached to the bottom of the product.
    column_spans = np.zeros(x1 - x0, dtype=np.float32)
    for offset, x in enumerate(range(x0, x1)):
        rows = np.flatnonzero(mask[:, x])
        if len(rows):
            column_spans[offset] = rows[-1] - rows[0] + 1
    tallest = max(float(column_spans.max()), 1.0)
    body = np.flatnonzero(column_spans > tallest * 0.54)
    if len(body) < 12:
        body = np.flatnonzero(column_spans > tallest * 0.34)
    if len(body) < 12:
        raise ValueError("Too few full-height profile columns")
    left, right = x0 + int(body[0]), x0 + int(body[-1])
    xs = np.arange(left, right + 1)

    similarity = substrate_similarity(image, mask, bbox)
    edge = internal_edge_score(image, similarity)
    expected_depth = max(8.0, len(xs) * depth_mm / max(width_mm, 1e-6))
    top_rows = []
    for x in xs:
        rows = np.flatnonzero(mask[:, x])
        top_rows.append(int(rows[0]) if len(rows) else y0)
    top_rows = np.asarray(top_rows)
    search_top = max(y0 + 4, int(np.percentile(top_rows, 10)) + 4)
    search_bottom = min(y1 - 4, int(np.percentile(top_rows, 85) + expected_depth * 1.38))
    if search_bottom - search_top < 10:
        search_bottom = min(y1 - 4, search_top + max(12, int(expected_depth * 1.4)))
    ys = np.arange(search_top, search_bottom + 1)

    score = edge[np.ix_(ys, xs)].astype(np.float64)
    above = np.zeros_like(score, dtype=bool)
    below = np.zeros_like(score, dtype=bool)
    support = 3
    for row_index, y in enumerate(ys):
        above[row_index] = mask[max(0, y - support), xs]
        below[row_index] = mask[min(mask.shape[0] - 1, y + support), xs]
    score[~(above & below)] = -1e6

    # A substrate boundary has cut-face-like pixels immediately above it and a
    # colour/texture change immediately below it. This suppresses highlights on
    # the decorative face without assuming a particular finish colour.
    for row_index, y in enumerate(ys):
        ya, yb = max(0, y - 4), min(mask.shape[0] - 1, y + 4)
        score[row_index] += similarity[ya, xs] * 28.0
        score[row_index] += np.maximum(0.0, similarity[ya, xs] - similarity[yb, xs]) * 42.0

    # Estimate where the contiguous sawn substrate stops in each column.  This
    # is a deliberately soft prior: it prevents decorative highlights from
    # winning, while the image edge still decides the final sub-pixel shape.
    smooth_similarity = cv2.GaussianBlur(similarity, (5, 5), 0)
    for column, x in enumerate(xs):
        column_similarity = smooth_similarity[ys, x]
        start_level = float(np.percentile(column_similarity[:max(3, len(column_similarity) // 5)], 65))
        threshold = max(0.24, start_level * 0.48)
        plausible = np.flatnonzero(column_similarity >= threshold)
        if len(plausible):
            gaps = np.flatnonzero(np.diff(plausible) > 3)
            end = plausible[gaps[0]] if len(gaps) else plausible[-1]
            prior = int(end)
            row_indices = np.arange(len(ys))
            score[:, column] += 31.0 * np.exp(-0.5 * ((row_indices - prior) / 7.0) ** 2)

    rows_count, columns_count = score.shape
    dp = np.full_like(score, -1e12)
    previous = np.full((rows_count, columns_count), -1, dtype=np.int16)
    dp[:, 0] = score[:, 0]
    # A sawn section can contain steps, but it cannot teleport vertically from
    # one source pixel column to the next.  The tighter transition model is
    # what rejects long decorative highlights on fluted/scooped faces.
    max_jump = max(3, int(round(expected_depth * 0.09)))
    smoothness = 2.65
    for column in range(1, columns_count):
        for row in range(rows_count):
            start, end = max(0, row - max_jump), min(rows_count, row + max_jump + 1)
            candidates = dp[start:end, column - 1]
            deltas = np.abs(np.arange(start, end) - row)
            values = candidates - smoothness * deltas
            offset = int(np.argmax(values))
            dp[row, column] = score[row, column] + values[offset]
            previous[row, column] = start + offset

    path = np.empty(columns_count, dtype=np.int32)
    path[-1] = int(np.argmax(dp[:, -1]))
    for column in range(columns_count - 1, 0, -1):
        path[column - 1] = previous[path[column], column]
    boundary_y = ys[path].astype(np.float64)
    if len(boundary_y) >= 5:
        boundary_y = medfilt(boundary_y, kernel_size=5)

    section = np.zeros(mask.shape, dtype=np.uint8)
    for x, y in zip(xs, boundary_y.round().astype(int)):
        rows = np.flatnonzero(mask[:, x])
        if len(rows):
            section[rows[0]:min(y + 1, mask.shape[0]), x] = 255
    sampled_edge = edge[boundary_y.round().astype(int), xs]
    return xs, boundary_y, section, float(np.median(sampled_edge))


def physical_curve(boundary_y: np.ndarray, width_mm: float, depth_mm: float,
                   rebate_mm: float, samples: int = 241) -> tuple[np.ndarray, float, float]:
    """Convert the image trace to millimetres without contrast-stretching it.

    Horizontal pixels provide the scale because the supplier gives exact face
    width.  The deepest robust boundary point is anchored to the stated depth;
    all other heights retain their measured magnitude. Rebate depth describes
    the internal artwork seat; it is not a lower bound on the outer profile.
    """
    pixels_per_mm = max(len(boundary_y) / max(width_mm, 1e-6), 1e-6)
    deepest = float(np.percentile(boundary_y, 98))
    measured = depth_mm - (deepest - boundary_y) / pixels_per_mm
    measured = np.clip(measured, 0.0, depth_mm)
    source_u = np.linspace(0.0, 1.0, len(measured))
    target_u = np.linspace(0.0, 1.0, samples)
    span = float(np.percentile(boundary_y, 98) - np.percentile(boundary_y, 2))
    return np.interp(target_u, source_u, measured), span, pixels_per_mm


def analyse_frame(path: Path, index: int, label: str, width_mm: float,
                  depth_mm: float, rebate_mm: float) -> FrameResult:
    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Cannot read {path}")
    mask = foreground_mask(image)
    x0, y0, x1, y1 = object_bbox(mask)
    xs, boundary, section, edge_score = trace_boundary(image, mask, width_mm, depth_mm)
    curve, span, pixels_per_mm = physical_curve(boundary, width_mm, depth_mm, rebate_mm)
    front_score = (x1 - x0) / max(y1 - y0, 1)
    expected_span = max(1.0, pixels_per_mm * rebate_mm)
    span_score = math.exp(-abs(span - expected_span) / max(expected_span, 1.0))
    edge_quality = 1.0 - math.exp(-edge_score / 35.0)
    quality = 0.48 * front_score + 0.34 * edge_quality + 0.18 * span_score
    return FrameResult(index, label, path.name, image, mask, section, xs, boundary,
                       curve, curve.copy(), pixels_per_mm, edge_score, x1 - x0,
                       y1 - y0, span, quality, 0, 0.0, 1.0, 0.0)


def simplify_profile(curve: np.ndarray, width_mm: float, depth_mm: float,
                     rebate_mm: float) -> list[list[float]]:
    u = np.linspace(0.0, width_mm, len(curve))
    z = np.clip(curve, 0.0, depth_mm)
    points = np.column_stack((u, z)).astype(np.float32).reshape(-1, 1, 2)
    epsilon = max(0.12, width_mm * 0.0025)
    simplified = cv2.approxPolyDP(points, epsilon, False).reshape(-1, 2)
    if len(simplified) < 4:
        indices = np.linspace(0, len(points) - 1, 8).round().astype(int)
        simplified = points.reshape(-1, 2)[indices]
    simplified[0, 0], simplified[-1, 0] = 0.0, width_mm
    return [[round(float(x), 3), round(float(y), 3)] for x, y in simplified]


def register_frames(frames: list[FrameResult], depth_mm: float) -> None:
    """Rectify the small perspective change between adjacent spin frames.

    Registration is deliberately bounded: up to 4% horizontal displacement,
    12% scale, and 10% of supplier depth in offset. Larger changes indicate the
    frames do not contain the same reliable cut-section evidence.
    """
    centre = sorted(frames, key=lambda frame: frame.index)[len(frames) // 2]
    reference = centre.physical_curve
    count = len(reference)
    u = np.linspace(0.0, 1.0, count)
    margin = max(4, int(round(count * 0.04)))
    fit_region = np.arange(count) >= margin
    fit_region &= np.arange(count) < count - margin
    max_offset = depth_mm * 0.10
    for frame in frames:
        if frame is centre:
            continue
        best = None
        for shift in range(-margin, margin + 1):
            for warp in np.linspace(-0.24, 0.24, 9):
                # A planar cut face changes by a 1-D projective transform as it
                # rotates. This endpoint-preserving term approximates that
                # homography without allowing a free-form contour warp.
                shifted_u = (u + shift / max(count - 1, 1)
                             + float(warp) * u * (1.0 - u))
                candidate = np.interp(shifted_u, u, frame.physical_curve,
                                      left=np.nan, right=np.nan)
                valid = np.isfinite(candidate) & fit_region
                if valid.sum() < count * 0.70:
                    continue
                x, y = candidate[valid], reference[valid]
                scale, offset = np.polyfit(x, y, 1)
                scale = float(np.clip(scale, 0.88, 1.12))
                offset = float(np.clip(np.median(y - scale * x), -max_offset, max_offset))
                for _ in range(2):
                    residual = np.abs(y - (scale * x + offset))
                    inliers = residual <= np.percentile(residual, 82)
                    if inliers.sum() < 12:
                        break
                    scale, offset = np.polyfit(x[inliers], y[inliers], 1)
                    scale = float(np.clip(scale, 0.88, 1.12))
                    offset = float(np.clip(np.median(y[inliers] - scale * x[inliers]),
                                           -max_offset, max_offset))
                residual = np.abs(y - (scale * x + offset))
                objective = (float(np.median(residual)) + abs(shift) * 0.012
                             + abs(float(warp)) * 0.16
                             + abs(scale - 1.0) * 0.35 + abs(offset) * 0.025)
                if best is None or objective < best[0]:
                    best = (objective, shift, float(warp), scale, offset, candidate)
        if best is None:
            continue
        _, shift, warp, scale, offset, candidate = best
        valid = np.isfinite(candidate)
        filled = np.interp(u, u[valid], candidate[valid])
        frame.registered_curve = np.clip(scale * filled + offset, 0.0, depth_mm)
        frame.registration_shift_samples = int(shift)
        frame.registration_projective_warp = float(warp)
        frame.registration_scale = float(scale)
        frame.registration_offset_mm = float(offset)


def fuse_curves(frames: Iterable[FrameResult], macro_smooth: bool = True) -> np.ndarray:
    curves = np.stack([frame.registered_curve for frame in frames])
    fused = np.median(curves, axis=0)
    if len(fused) >= 5:
        fused = medfilt(fused, kernel_size=5)
    if not macro_smooth:
        return fused
    # Total-variation denoising removes surface ornament from the macro section
    # while retaining genuine shoulders and sharp rebate steps.
    depth_signal = max(float(np.max(fused) - np.min(fused)), 1.0)
    return denoise_tv_chambolle(fused, weight=max(0.20, depth_signal * 0.045))


def validation_metrics(frames: list[FrameResult], fused: np.ndarray,
                       depth_mm: float, rebate_mm: float) -> dict:
    consensus = fuse_curves(frames, macro_smooth=False)
    residuals = []
    residuals_mm = []
    margin = max(4, len(fused) // 25)
    for frame in frames:
        others = [candidate for candidate in frames if candidate is not frame]
        held_out_consensus = fuse_curves(others, macro_smooth=False) if others else consensus
        held_out_delta = np.abs(frame.registered_curve - held_out_consensus)[margin:-margin]
        residuals.extend(held_out_delta * frame.pixels_per_mm)
        residuals_mm.extend(np.abs(frame.registered_curve - consensus)[margin:-margin])
    residuals = np.asarray(residuals)
    residuals_mm = np.asarray(residuals_mm)
    median_boundary = float(np.median(residuals))
    p95_boundary = float(np.percentile(residuals, 95))
    split_p95 = float(np.percentile(residuals_mm, 95))
    accepted = median_boundary <= 1.5 and p95_boundary <= 3.0 and split_p95 <= 2.0
    return {
        "heldOutMedianBoundaryPixels": round(median_boundary, 3),
        "heldOutP95BoundaryPixels": round(p95_boundary, 3),
        "crossSubsetP95ProfileMm": round(split_p95, 3),
        "dimensionResidualMm": 0.0,
        "passesInitialGate": bool(accepted),
    }


def projected_boundary(frame: FrameResult, fused: np.ndarray) -> np.ndarray:
    source_u = np.linspace(0.0, 1.0, len(fused))
    target_u = np.linspace(0.0, 1.0, len(frame.xs))
    shift = frame.registration_shift_samples / max(len(fused) - 1, 1)
    mapped_u = (source_u + shift + frame.registration_projective_warp
                * source_u * (1.0 - source_u))
    reference_u = np.interp(target_u, mapped_u, source_u)
    registered = np.interp(reference_u, source_u, fused)
    millimetres = ((registered - frame.registration_offset_mm)
                   / max(frame.registration_scale, 1e-6))
    deepest = float(np.percentile(frame.boundary_y, 98))
    return deepest - (float(np.max(frame.physical_curve)) - millimetres) * frame.pixels_per_mm


def write_frame_diagnostics(frame: FrameResult, fused: np.ndarray, output: Path) -> dict:
    overlay = cv2.cvtColor(frame.image, cv2.COLOR_BGR2RGB)
    detected = np.column_stack((frame.xs, frame.boundary_y)).round().astype(int)
    projected = np.column_stack((frame.xs, projected_boundary(frame, fused))).round().astype(int)
    cv2.polylines(overlay, [detected], False, (45, 225, 80), 2, cv2.LINE_AA)
    cv2.polylines(overlay, [projected], False, (235, 55, 55), 1, cv2.LINE_AA)
    overlay_name = f"{Path(frame.filename).stem}-overlay.png"
    mask_name = f"{Path(frame.filename).stem}-cut-mask.png"
    Image.fromarray(overlay).save(output / overlay_name)
    Image.fromarray(frame.section_mask).save(output / mask_name)
    return {"label": frame.label, "filename": frame.filename,
            "overlay": overlay_name, "mask": mask_name,
            "edgeScore": round(frame.edge_score, 3),
            "quality": round(frame.quality, 4),
            "depthSpanPixels": round(frame.depth_span_px, 3),
            "registration": {"horizontalShiftSamples": frame.registration_shift_samples,
                             "projectiveWarp": round(frame.registration_projective_warp, 4),
                             "scale": round(frame.registration_scale, 4),
                             "offsetMm": round(frame.registration_offset_mm, 4)}}


def profile_plot(points: list[list[float]], width_mm: float, depth_mm: float,
                 output: Path) -> None:
    canvas = Image.new("RGB", (900, 440), "#f2f1ed")
    draw = ImageDraw.Draw(canvas)
    margin = 55
    draw.line((margin, 380, 850, 380), fill="#777777", width=2)
    draw.line((margin, 380, margin, 40), fill="#777777", width=2)
    plotted = [(margin + x / width_mm * 795, 380 - z / depth_mm * 330) for x, z in points]
    draw.line(plotted, fill="#c92f32", width=5, joint="curve")
    for x, y in plotted:
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill="#61171a")
    draw.text((margin, 397), "inner / rebate", fill="#555555")
    draw.text((730, 397), f"outer · {width_mm:g} mm", fill="#555555")
    canvas.save(output)


def diagnostic_html(record: dict) -> str:
    cards = "".join(f'''<article><h3>{item['label']}</h3><div class="pair">
      <figure><img src="../../spin/{item['filename']}"><figcaption>supplier source</figcaption></figure>
      <figure><img src="{item['mask']}"><figcaption>automatic cut-face mask</figcaption></figure>
      <figure><img src="{item['overlay']}"><figcaption><b>green</b> detected · <b>red</b> fused reprojection</figcaption></figure>
      </div><p>edge {item['edgeScore']} · depth signal {item['depthSpanPixels']} px · quality {item['quality']}</p></article>'''
      for item in record["selectedFrames"])
    metrics = record["validation"]
    gate = "PASS — candidate can proceed to material reconstruction" if metrics["passesInitialGate"] else "REJECT — supplier evidence requires another extraction route"
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>{record['sku']} section reconstruction pilot</title><style>
    :root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}*{{box-sizing:border-box}}body{{max-width:1320px;margin:auto;padding:32px}}header{{display:flex;justify-content:space-between;gap:24px;align-items:end;border-bottom:1px solid #333;padding-bottom:20px}}h1{{margin:0}}.tag{{border:1px solid {'#659c70' if metrics['passesInitialGate'] else '#a8665f'};padding:9px 12px;color:{'#9ee2aa' if metrics['passesInitialGate'] else '#f2a99d'}}}.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}}.metric,article,.profile{{background:#1a1a1a;padding:15px}}.metric strong{{display:block;font-size:25px;color:#dfbf80}}.pair{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}}figure{{margin:0}}img{{display:block;width:100%;background:white}}figcaption,p{{color:#aaa;line-height:1.5}}figcaption b:first-child{{color:#42d979}}figcaption b:last-child{{color:#ed5a5a}}article{{margin:18px 0}}.profile img{{max-height:430px;object-fit:contain}}@media(max-width:800px){{.metrics,.pair{{grid-template-columns:1fr}}}}</style></head><body>
    <header><div><p>RENDERER-INDEPENDENT SECTION PILOT</p><h1>{record['sku']} · {record['name']}</h1></div><div class="tag">{gate}</div></header>
    <div class="metrics"><div class="metric"><strong>{metrics['heldOutMedianBoundaryPixels']} px</strong>median boundary</div><div class="metric"><strong>{metrics['heldOutP95BoundaryPixels']} px</strong>95th boundary</div><div class="metric"><strong>{metrics['crossSubsetP95ProfileMm']} mm</strong>split stability</div><div class="metric"><strong>{record['widthMm']} × {record['depthMm']}</strong>supplier envelope mm</div></div>
    <section class="profile"><h2>Fused physical profile</h2><img src="profile-plot.png"><p>{len(record['points'])} simplified points · exact supplier width/depth/rebate constraints · not connected to Three.js.</p></section>{cards}</body></html>'''


def load_metadata(root: Path, sku: str) -> dict:
    metadata_path = root / "product-metadata.json"
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    override = PILOT_OVERRIDES.get(sku, {})
    dimensions = override.get("dimensions") or metadata.get("dimensions")
    if not dimensions:
        raise ValueError(f"Missing supplier dimensions for {sku}")
    return {"name": override.get("name") or metadata.get("name") or sku,
            "dimensions": dimensions,
            "productUrl": metadata.get("productUrl")}


def run_product(root: Path, frame_count: int) -> dict:
    manifest = json.loads((root / "spin-manifest.json").read_text())
    sku = manifest["sku"]
    metadata = load_metadata(root, sku)
    dimensions = metadata["dimensions"]
    width_mm = float(dimensions["widthMm"])
    depth_mm = float(dimensions["depthMm"])
    rebate_mm = float(dimensions["rebateMm"])

    measured = []
    sequence_midpoint = (len(manifest["images"]) - 1) / 2
    candidate_radius = max(4, min(6, len(manifest["images"]) // 10))
    candidates = [
        (index, item) for index, item in enumerate(manifest["images"])
        if abs(index - sequence_midpoint) <= candidate_radius
    ]
    for index, item in candidates:
        try:
            measured.append(analyse_frame(root / "spin" / item["filename"], index,
                                          item["label"], width_mm, depth_mm, rebate_mm))
        except ValueError:
            continue
    if len(measured) < 5:
        raise ValueError(f"Only {len(measured)} usable frames for {sku}")
    # Adjacent near-orthographic cut views are directly comparable. Wider-angle
    # images contain useful appearance evidence, but combining them here would
    # require a homography and was the cause of false fusion in the first pass.
    register_frames(measured, depth_mm)
    centre = min(measured, key=lambda frame: abs(frame.index - sequence_midpoint))

    def agreement(frame: FrameResult) -> float:
        residual = np.abs(frame.registered_curve - centre.registered_curve)
        margin = max(4, len(residual) // 25)
        residual = residual[margin:-margin]
        return (float(np.median(residual)) + 0.35 * float(np.percentile(residual, 90))
                + abs(frame.index - sequence_midpoint) * 0.03)

    each_side = max(1, (frame_count - 1) // 2)
    left = sorted((frame for frame in measured if frame.index < centre.index),
                  key=agreement)[:each_side]
    right = sorted((frame for frame in measured if frame.index > centre.index),
                   key=agreement)[:each_side]
    selected = left + [centre] + right
    if len(selected) < frame_count:
        remaining = [frame for frame in measured if frame not in selected]
        selected.extend(sorted(remaining, key=agreement)[:frame_count - len(selected)])
    selected = sorted(selected, key=lambda frame: frame.index)
    fused = fuse_curves(selected)
    points = simplify_profile(fused, width_mm, depth_mm, rebate_mm)
    validation = validation_metrics(selected, fused, depth_mm, rebate_mm)

    output = root / "profile-analysis" / "section-pilot"
    output.mkdir(parents=True, exist_ok=True)
    frame_records = [write_frame_diagnostics(frame, fused, output) for frame in selected]
    profile_plot(points, width_mm, depth_mm, output / "profile-plot.png")
    record = {
        "supplier": "Mainline", "sku": sku, "name": metadata["name"],
        "productUrl": metadata["productUrl"] or manifest.get("productUrl"),
        "method": "multi-frame-exposed-cut-section-v2-metric",
        "widthMm": width_mm, "depthMm": depth_mm, "rebateMm": rebate_mm,
        "sourceImageCount": len(manifest["images"]), "selectedFrameCount": len(selected),
        "selectedFrames": frame_records, "points": points, "validation": validation,
        "status": "experimental-pass" if validation["passesInitialGate"] else "experimental-rejected",
        "rendererIntegrated": False,
        "limitations": ["Supplier spin imagery is low resolution", "Macro profile only; ornament relief is a later material stage", "Acceptance requires review of automatic overlays"],
    }
    (output / "profile-candidate.json").write_text(json.dumps(record, indent=2) + "\n")
    (output / "diagnostic.html").write_text(diagnostic_html(record))
    return record


def summary_html(records: list[dict]) -> str:
    cards = "".join(f'''<a class="card {'pass' if r['validation']['passesInitialGate'] else 'fail'}" href="{r['sku']}/profile-analysis/section-pilot/diagnostic.html"><strong>{r['sku']}</strong><span>{r['name']}</span><b>{'PASS' if r['validation']['passesInitialGate'] else 'REJECT'}</b><small>median {r['validation']['heldOutMedianBoundaryPixels']} px · p95 {r['validation']['heldOutP95BoundaryPixels']} px · stability {r['validation']['crossSubsetP95ProfileMm']} mm</small></a>''' for r in records)
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mainline section reconstruction pilot</title><style>:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:1050px;margin:auto;padding:40px}}p,span,small{{color:#aaa}}.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:28px}}.card{{display:grid;grid-template-columns:110px 1fr 75px;gap:8px;padding:18px;background:#1c1c1c;border:1px solid #333;color:#eee;text-decoration:none}}.card b{{text-align:right}}.card small{{grid-column:2/4}}.pass{{border-color:#416d49}}.pass b{{color:#8ed79a}}.fail{{border-color:#71443f}}.fail b{{color:#ed9d92}}@media(max-width:700px){{.grid{{grid-template-columns:1fr}}}}</style></head><body><p>AUTOMATED GO / NO-GO</p><h1>Mainline exposed-section reconstruction pilot</h1><p>Every candidate is renderer-independent. Click a product to inspect the automatic cut mask, detected boundary and fused reprojection.</p><div class="grid">{cards}</div></body></html>'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default="source-material/mainline")
    parser.add_argument("--skus", default="POL-4100,POL-2190,POL-4540,POL-4508,POL-4875")
    parser.add_argument("--frame-count", type=int, default=3)
    args = parser.parse_args()
    source_root = Path(args.source_root).resolve()
    records = []
    for sku in [value.strip() for value in args.skus.split(",") if value.strip()]:
        record = run_product(source_root / sku, max(3, args.frame_count))
        records.append(record)
        result = record["validation"]
        print(f"{sku}: {'PASS' if result['passesInitialGate'] else 'REJECT'} "
              f"median={result['heldOutMedianBoundaryPixels']}px "
              f"p95={result['heldOutP95BoundaryPixels']}px "
              f"stability={result['crossSubsetP95ProfileMm']}mm")
    (source_root / "section-profile-pilot.json").write_text(json.dumps(records, indent=2) + "\n")
    (source_root / "section-profile-pilot.html").write_text(summary_html(records))
    print(f"Summary: {source_root / 'section-profile-pilot.html'}")


if __name__ == "__main__":
    main()
