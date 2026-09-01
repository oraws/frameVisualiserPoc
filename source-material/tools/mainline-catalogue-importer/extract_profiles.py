#!/usr/bin/env python3
"""Derive a metric surface profile from isolated catalogue cross-sections."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def rdp(points: np.ndarray, epsilon: float) -> list[int]:
    if len(points) < 3:
        return list(range(len(points)))
    start, end = points[0], points[-1]
    line = end - start
    length = np.linalg.norm(line)
    offsets = points - start
    distances = np.linalg.norm(offsets, axis=1) if length == 0 else np.abs(line[0] * offsets[:, 1] - line[1] * offsets[:, 0]) / length
    index = int(np.argmax(distances))
    if distances[index] <= epsilon:
        return [0, len(points) - 1]
    left = rdp(points[:index + 1], epsilon)
    right = rdp(points[index:], epsilon)
    return left[:-1] + [index + value for value in right]


def substrate_mask(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    height, width = rgb.shape[:2]
    white = np.all(rgb > 244, axis=2) & ((rgb.max(axis=2) - rgb.min(axis=2)) < 9)
    mask = np.full((height, width), cv2.GC_PR_BGD, np.uint8)
    mask[white] = cv2.GC_BGD
    nonwhite = ~white
    mask[int(height * .46):][nonwhite[int(height * .46):]] = cv2.GC_PR_FGD
    mask[int(height * .88):][nonwhite[int(height * .88):]] = cv2.GC_FGD
    # A narrow lower-left seed is reliable even when a rebate creates white at right.
    seed = np.zeros_like(mask, dtype=bool)
    seed[int(height * .76):, :max(4, int(width * .22))] = True
    mask[seed & nonwhite] = cv2.GC_FGD
    mask[:max(2, int(height * .08))] = cv2.GC_BGD
    background = np.zeros((1, 65), np.float64)
    foreground = np.zeros((1, 65), np.float64)
    cv2.grabCut(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), mask, None, background, foreground, 8, cv2.GC_INIT_WITH_MASK)
    binary = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    binary[white] = 0
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    count, components, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        raise RuntimeError("Substrate segmentation produced no connected component")
    scores = []
    for label in range(1, count):
        component = components == label
        bottom = component[int(height * .82):].sum()
        left_seed = component[int(height * .7):, :max(4, int(width * .3))].sum()
        scores.append((bottom * 4 + left_seed * 2 + stats[label, cv2.CC_STAT_AREA], label))
    selected = max(scores)[1]
    return (components == selected).astype(np.uint8), white


def surface_path(rgb: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    height, width = mask.shape
    valid = np.flatnonzero(mask.sum(axis=0) >= 3)
    if len(valid) < width * .55:
        raise RuntimeError("Substrate boundary does not span enough of the moulding")
    edge_trim = max(2, int(round(width * .012)))
    x0, x1 = max(int(valid.min()), edge_trim), min(int(valid.max()), width - 1 - edge_trim)
    path = np.full(width, np.nan, np.float32)
    for x in valid:
        ys = np.flatnonzero(mask[:, x])
        path[x] = ys.min()
    known = np.flatnonzero(~np.isnan(path))
    path[x0:x1 + 1] = np.interp(np.arange(x0, x1 + 1), known, path[known])
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    vertical = np.linalg.norm(lab[2:] - lab[:-2], axis=2)
    for x in range(x0, x1 + 1):
        centre = int(round(path[x]))
        lo, hi = max(2, centre - 7), min(height - 3, centre + 8)
        if hi > lo:
            path[x] = lo + int(np.argmax(vertical[lo - 1:hi - 1, x]))
    smooth = cv2.medianBlur(path[x0:x1 + 1].reshape(-1, 1), 5).ravel()
    padded = np.pad(smooth, 5, mode="edge")
    local_median = np.array([np.median(padded[index:index + 11]) for index in range(len(smooth))], dtype=np.float32)
    smooth[np.abs(smooth - local_median) > 18] = local_median[np.abs(smooth - local_median) > 18]
    return np.arange(x0, x1 + 1), smooth


def metric_profile(xs: np.ndarray, ys: np.ndarray, width_mm: float, depth_mm: float, rebate_mm: float) -> tuple[list[list[float]], list[list[float]]]:
    points = np.column_stack((xs, ys))
    keep = sorted(set(rdp(points.astype(float), max(1.2, (ys.max() - ys.min()) * .012))))
    if len(keep) < 12:
        keep = sorted(set(keep) | set(np.linspace(0, len(points) - 1, 12).astype(int).tolist()))
    if len(keep) > 70:
        keep = keep[::math.ceil(len(keep) / 70)] + ([keep[-1]] if keep[-1] not in keep[::math.ceil(len(keep) / 70)] else [])
    floor = max(1.0, depth_mm - rebate_mm)
    top, bottom = float(ys.min()), float(ys.max())
    span = max(1.0, bottom - top)
    physical = []
    pixels = []
    for index in reversed(keep):
        x, y = float(xs[index]), float(ys[index])
        u = width_mm * (xs[-1] - x) / max(1.0, xs[-1] - xs[0])
        z = floor + (bottom - y) / span * (depth_mm - floor)
        physical.append([round(u, 3), round(z, 3)])
        pixels.append([round(x, 2), round(y, 2)])
    physical[0][0] = 0.0
    physical[-1][0] = float(width_mm)
    return physical, pixels


def diagnostic(rgb: np.ndarray, mask: np.ndarray, xs: np.ndarray, ys: np.ndarray, profile: list[list[float]], product: dict, output: Path) -> None:
    source = Image.fromarray(rgb).convert("RGB")
    overlay = source.copy()
    draw = ImageDraw.Draw(overlay, "RGBA")
    mask_image = Image.fromarray((mask * 150).astype(np.uint8))
    red = Image.new("RGBA", source.size, (255, 45, 35, 0))
    red.putalpha(mask_image)
    overlay = Image.alpha_composite(overlay.convert("RGBA"), red)
    draw = ImageDraw.Draw(overlay)
    draw.line([(int(x), int(y)) for x, y in zip(xs, ys)], fill=(40, 255, 90, 255), width=3)
    overlay.convert("RGB").save(output / "profile-diagnostic.png")
    graph = Image.new("RGB", (720, 390), "#f1efe9")
    graph_draw = ImageDraw.Draw(graph)
    graph_draw.line((55, 330, 675, 330), fill="#77736c", width=2)
    graph_draw.line((55, 330, 55, 35), fill="#77736c", width=2)
    plotted = [(55 + u / product["widthMm"] * 620, 330 - z / product["depthMm"] * 280) for u, z in profile]
    graph_draw.line(plotted, fill="#cf302d", width=4, joint="curve")
    graph_draw.text((55, 350), "inner / sight edge", fill="#55514c")
    graph_draw.text((560, 350), "outer edge", fill="#55514c")
    graph.save(output / "profile-plot.png")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--public", required=True, type=Path)
    parser.add_argument("--typescript-json", required=True, type=Path)
    parser.add_argument("--manifest", default="catalogue-manifest.json")
    args = parser.parse_args()
    manifest = json.loads((args.root / args.manifest).read_text())
    profiles = {}
    batch_results = {"sourcePdf": manifest["sourcePdf"], "requestedCount": manifest["requestedCount"], "processed": [], "failures": list(manifest.get("failures", []))}
    for product in manifest["products"]:
        try:
            product_root = args.root / product["sku"]
            rgb = np.asarray(Image.open(product_root / product["filename"]).convert("RGB"))
            mask, white = substrate_mask(rgb)
            xs, ys = surface_path(rgb, mask)
            profile, pixels = metric_profile(xs, ys, product["widthMm"], product["depthMm"], product["rebateMm"])
            lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
            core_mean = lab[mask.astype(bool)].mean(axis=0)
            finish_sample = lab[:max(5, int(rgb.shape[0] * .32))][~white[:max(5, int(rgb.shape[0] * .32))]]
            finish_mean = finish_sample.mean(axis=0) if len(finish_sample) else core_mean
            separation = float(np.linalg.norm(core_mean - finish_mean))
            continuity = float(np.exp(-np.mean(np.minimum(np.abs(np.diff(ys, 2)), 20)) / 5)) if len(ys) > 3 else 0
            coverage = float((xs[-1] - xs[0] + 1) / rgb.shape[1])
            confidence = float(np.clip(.34 * min(1, separation / 55) + .33 * continuity + .23 * coverage + .1, 0, 1))
            review_band = "high" if confidence >= .82 else "inspect" if confidence >= .68 else "low"
            result = {
                "supplier": "Mainline", "sku": product["sku"], "source": f"ml_catalogue.pdf page {product['page']}",
                "method": "catalogue-cross-section-grabcut-edge-snap", "widthMm": product["widthMm"],
                "depthMm": product["depthMm"], "rebateMm": product["rebateMm"], "confidence": round(confidence, 4),
                "reviewBand": review_band,
                "scores": {"materialSeparation": round(min(1, separation / 55), 4), "continuity": round(continuity, 4), "coverage": round(coverage, 4), "dimensionCalibration": 1},
                "points": profile, "sourceTracePixelsRightToLeft": pixels, "status": "experimental-catalogue-candidate",
            }
            (product_root / "profile.json").write_text(json.dumps(result, indent=2) + "\n")
            diagnostic(rgb, mask, xs, ys, profile, product, product_root)
            public_root = args.public / product["sku"] / "catalogue"
            public_root.mkdir(parents=True, exist_ok=True)
            Image.open(product_root / product["filename"]).save(public_root / "source.png")
            Image.open(product_root / "profile-diagnostic.png").save(public_root / "profile-diagnostic.png")
            Image.open(product_root / "profile-plot.png").save(public_root / "profile-plot.png")
            (public_root / "profile.json").write_text(json.dumps(result, indent=2) + "\n")
            profiles[product["sku"]] = profile
            batch_results["processed"].append({"sku": product["sku"], "name": product.get("name", ""), "page": product["page"], "points": len(profile), "confidence": round(confidence, 4), "reviewBand": review_band, "coverage": round(coverage, 4)})
            print(f"{product['sku']}: {len(profile)} points, confidence {confidence:.3f}, coverage {coverage:.1%}, {review_band}")
        except Exception as error:
            batch_results["failures"].append({"sku": product["sku"], "reason": str(error)})
            print(f"{product['sku']}: FAILED - {error}")
    args.typescript_json.write_text(json.dumps(profiles, indent=2) + "\n")
    batch_results["successfulCount"] = len(batch_results["processed"])
    batch_results["failureCount"] = len(batch_results["failures"])
    (args.root / "catalogue-batch-results.json").write_text(json.dumps(batch_results, indent=2) + "\n")
    rows = ["| SKU | Page | Points | Confidence | Review |", "| --- | ---: | ---: | ---: | --- |"]
    rows.extend(f"| {item['sku']} | {item['page']} | {item['points']} | {item['confidence']:.3f} | {item['reviewBand']} |" for item in sorted(batch_results["processed"], key=lambda item: item["sku"]))
    failure_text = "\n".join(f"- {item['sku']}: {item['reason']}" for item in batch_results["failures"]) or "- None"
    report = f"""# Mainline catalogue batch results

Processed {len(batch_results['processed'])} of {batch_results['requestedCount']} current Mainline mouldings.

Review bands are confidence gates, not approvals: **high** can move to visual sampling,
**inspect** requires a diagnostic check, and **low** must not replace an existing profile.

{chr(10).join(rows)}

## Failures

{failure_text}
"""
    (args.root / "BATCH-RESULTS.md").write_text(report)


if __name__ == "__main__":
    main()
