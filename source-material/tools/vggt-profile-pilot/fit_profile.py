#!/usr/bin/env python3
"""Fit a metric 2.5D moulding profile from VGGT-aligned supplier views.

Research-only pilot.  This consumes VGGT predictions and existing automatic
cut-face masks, writes diagnostics beside them, and never imports renderer code.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import medfilt, savgol_filter


ROOT = Path(__file__).resolve().parents[2]
FIT_LABELS = ("img22", "img23", "img24")
COLOURS = {"img22": "#df9b52", "img23": "#5fc6db", "img24": "#b486db"}


def square_mask(path: Path, target: int) -> np.ndarray:
    source = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if source is None:
        raise ValueError(f"Cannot read mask {path}")
    height, width = source.shape
    side = max(width, height)
    left, top = (side - width) // 2, (side - height) // 2
    square = np.zeros((side, side), dtype=np.uint8)
    square[top:top + height, left:left + width] = source
    return cv2.resize(square, (target, target), interpolation=cv2.INTER_NEAREST) > 127


def mask_path(product: Path, label: str) -> tuple[Path, str]:
    learned = (product / "profile-analysis" /
               "sam2-section-benchmark-sam2.1-hiera-base-plus" /
               f"{label}-sam2-mask.png")
    if learned.exists():
        return learned, "SAM 2.1 guided cut-face mask"
    classical = product / "profile-analysis" / "section-pilot" / f"{label}-cut-mask.png"
    if classical.exists():
        return classical, "classical cut-face mask"
    raise FileNotFoundError(f"No cut-face mask for {label}")


def extrusion_axis(points: np.ndarray, masks: np.ndarray, confidence: np.ndarray) -> np.ndarray:
    samples = []
    for index in range(len(points)):
        valid = masks[index] & np.isfinite(points[index]).all(axis=2)
        threshold = np.percentile(confidence[index][valid], 35) if valid.any() else np.inf
        valid &= confidence[index] >= threshold
        samples.append(points[index][valid][::20])
    cloud = np.concatenate(samples)
    centre = np.median(cloud, axis=0)
    _, _, vh = np.linalg.svd(cloud - centre, full_matrices=False)
    return vh[0] / np.linalg.norm(vh[0])


def fitted_cut_plane(masks: dict[str, np.ndarray], indices: dict[str, int],
                     points: np.ndarray, confidence: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Robustly fit the shared physical end-cut plane in VGGT world space."""
    samples = []
    for label, mask in masks.items():
        index = indices[label]
        valid = mask & np.isfinite(points[index]).all(axis=2)
        cutoff = np.percentile(confidence[index][valid], 30)
        valid &= confidence[index] >= cutoff
        samples.append(points[index][valid][::6])
    cloud = np.concatenate(samples)
    keep = np.ones(len(cloud), dtype=bool)
    for _ in range(5):
        centre = np.median(cloud[keep], axis=0)
        _, _, vh = np.linalg.svd(cloud[keep] - centre, full_matrices=False)
        normal = vh[-1] / np.linalg.norm(vh[-1])
        residual = np.abs((cloud - centre) @ normal)
        threshold = max(np.percentile(residual[keep], 72), 1e-7)
        keep = residual <= threshold
    offset = float(np.median(cloud[keep] @ normal))
    p95 = float(np.percentile(np.abs(cloud[keep] @ normal - offset), 95))
    return normal, offset, p95


def boundary_world(mask: np.ndarray, extrinsic: np.ndarray, intrinsic: np.ndarray,
                   plane_normal: np.ndarray, plane_offset: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Intersect boundary image rays with the fitted cut plane.

    This deliberately avoids using VGGT's noisy per-pixel depth for the final
    contour. VGGT supplies the cameras and common plane; supplier pixels supply
    the actual section boundary.
    """
    xs = np.flatnonzero(mask.any(axis=0))
    ys = np.array([np.flatnonzero(mask[:, x])[-1] for x in xs])
    pixels = np.column_stack((xs, ys, np.ones(len(xs))))
    rays_camera = (np.linalg.inv(intrinsic) @ pixels.T).T
    rotation, translation = extrinsic[:, :3], extrinsic[:, 3]
    centre = -rotation.T @ translation
    rays_world = (rotation.T @ rays_camera.T).T
    denominator = rays_world @ plane_normal
    distance = (plane_offset - np.dot(centre, plane_normal)) / denominator
    valid = np.isfinite(distance) & (np.abs(denominator) > 1e-5) & (distance > 0)
    coords = centre + distance[valid, None] * rays_world[valid]
    return xs[valid], ys[valid].astype(float), coords


def build_basis(reference: tuple[np.ndarray, np.ndarray, np.ndarray],
                length_axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    _, image_y, curve = reference
    count = len(curve)
    width = np.median(curve[-max(4, count // 12):], axis=0) - np.median(
        curve[:max(4, count // 12)], axis=0)
    width -= length_axis * np.dot(width, length_axis)
    width /= np.linalg.norm(width)
    depth = np.cross(length_axis, width)
    depth /= np.linalg.norm(depth)
    depth_values = curve @ depth
    if np.corrcoef(depth_values, image_y)[0, 1] < 0:
        depth *= -1
    return width, depth


def curve_mm(boundary: tuple[np.ndarray, np.ndarray, np.ndarray], width_axis: np.ndarray,
             depth_axis: np.ndarray, scale: float, width_mm: float,
             depth_mm: float, samples: int = 241) -> np.ndarray:
    _, _, points = boundary
    u = points @ width_axis
    z = points @ depth_axis
    if np.corrcoef(u, np.arange(len(u)))[0, 1] < 0:
        u, z = u[::-1], z[::-1]
    lo, hi = np.percentile(u, (1.5, 98.5))
    normal_u = np.clip((u - lo) / max(hi - lo, 1e-9), 0, 1)
    order = np.argsort(normal_u)
    normal_u, z = normal_u[order], z[order]
    unique_u, unique_indices = np.unique(np.round(normal_u, 5), return_index=True)
    z = z[unique_indices]
    z_mm = depth_mm - (np.percentile(z, 98) - z) * scale
    result = np.interp(np.linspace(0, 1, samples), unique_u, z_mm)
    result = np.clip(result, 0, depth_mm)
    result = medfilt(result, 5)
    return savgol_filter(result, 11, 2)


def simplify(curve: np.ndarray, width_mm: float) -> list[list[float]]:
    points = np.column_stack((np.linspace(0, width_mm, len(curve)), curve)).astype(np.float32)
    reduced = cv2.approxPolyDP(points.reshape(-1, 1, 2), max(0.10, width_mm * .0025), False)
    reduced = reduced.reshape(-1, 2)
    reduced[0, 0], reduced[-1, 0] = 0, width_mm
    return [[round(float(u), 3), round(float(z), 3)] for u, z in reduced]


def leave_one_out(curves: dict[str, np.ndarray]) -> tuple[dict, np.ndarray]:
    fused = np.median(np.stack(list(curves.values())), axis=0)
    margin = max(5, len(fused) // 30)
    records = {}
    for label, curve in curves.items():
        others = [value for key, value in curves.items() if key != label]
        predicted = np.median(np.stack(others), axis=0)
        delta = np.abs(curve - predicted)[margin:-margin]
        records[label] = {
            "medianMm": round(float(np.median(delta)), 3),
            "p95Mm": round(float(np.percentile(delta, 95)), 3),
        }
    return records, fused


def profile_plot(curves: dict[str, np.ndarray], fused: np.ndarray, width_mm: float,
                 depth_mm: float, output: Path) -> None:
    image = Image.new("RGB", (1100, 620), "#f3f1eb")
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = 80, 50, 1040, 550
    draw.line((x0, y1, x1, y1), fill="#777", width=2)
    draw.line((x0, y1, x0, y0), fill="#777", width=2)
    for depth in np.linspace(0, depth_mm, 5):
        y = y1 - depth / depth_mm * (y1 - y0)
        draw.line((x0, y, x1, y), fill="#d6d2c9", width=1)
        draw.text((12, y - 9), f"{depth:.0f} mm", fill="#666")
    u = np.linspace(0, width_mm, len(fused))
    def pixels(curve):
        return [(x0 + value / width_mm * (x1 - x0),
                 y1 - height / depth_mm * (y1 - y0)) for value, height in zip(u, curve)]
    for label, curve in curves.items():
        draw.line(pixels(curve), fill=COLOURS[label], width=3)
    draw.line(pixels(fused), fill="#d52b2b", width=6)
    draw.text((x0, 575), "inner edge", fill="#555")
    draw.text((x1 - 70, 575), "outer edge", fill="#555")
    draw.text((650, 18), "red: fused · orange/cyan/purple: independent views", fill="#555")
    image.save(output)


def overlay(image: np.ndarray, mask: np.ndarray, output: Path) -> None:
    canvas = image.copy()
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(canvas, contours, -1, (255, 58, 48), 3)
    Image.fromarray(canvas).save(output)


def mask_polygon_world(mask: np.ndarray, extrinsic: np.ndarray, intrinsic: np.ndarray,
                       normal: np.ndarray, offset: float) -> np.ndarray:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)
    contour = cv2.approxPolyDP(contour, 1.25, True).reshape(-1, 2)
    pixels = np.column_stack((contour, np.ones(len(contour))))
    rotation, translation = extrinsic[:, :3], extrinsic[:, 3]
    centre = -rotation.T @ translation
    rays = (rotation.T @ (np.linalg.inv(intrinsic) @ pixels.T)).T
    distance = (offset - centre @ normal) / (rays @ normal)
    return centre + distance[:, None] * rays


def extrusion_extent(points: np.ndarray, masks: np.ndarray, confidence: np.ndarray,
                     normal: np.ndarray, front_offset: float) -> float:
    values = []
    for index in range(len(points)):
        valid = masks[index] & np.isfinite(points[index]).all(axis=2)
        cutoff = np.percentile(confidence[index][valid], 30)
        valid &= confidence[index] >= cutoff
        values.append((points[index][valid][::20] @ normal))
    projection = np.concatenate(values)
    low, high = np.percentile(projection, (2, 98))
    return float(low if abs(low - front_offset) > abs(high - front_offset) else high)


def project_polygon(points: np.ndarray, extrinsic: np.ndarray,
                    intrinsic: np.ndarray) -> np.ndarray:
    camera = (extrinsic[:, :3] @ points.T + extrinsic[:, 3:4]).T
    projected = (intrinsic @ camera.T).T
    return projected[:, :2] / np.maximum(projected[:, 2:3], 1e-8)


def render_extrusion(front: np.ndarray, back_offset: float, normal: np.ndarray,
                     extrinsic: np.ndarray, intrinsic: np.ndarray,
                     shape: tuple[int, int]) -> np.ndarray:
    delta = back_offset - float(np.median(front @ normal))
    back = front + delta * normal
    front_2d = project_polygon(front, extrinsic, intrinsic)
    back_2d = project_polygon(back, extrinsic, intrinsic)
    rendered = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(rendered, [np.round(front_2d).astype(np.int32)], 1)
    cv2.fillPoly(rendered, [np.round(back_2d).astype(np.int32)], 1)
    for index in range(len(front)):
        nxt = (index + 1) % len(front)
        face = np.array((front_2d[index], front_2d[nxt], back_2d[nxt], back_2d[index]))
        cv2.fillConvexPoly(rendered, np.round(face).astype(np.int32), 1)
    return rendered.astype(bool)


def rerender_overlay(image: np.ndarray, target: np.ndarray, rendered: np.ndarray,
                     output: Path) -> None:
    canvas = image.copy()
    canvas[target & ~rendered] = (.55 * canvas[target & ~rendered] +
                                  .45 * np.array([255, 180, 40])).astype(np.uint8)
    canvas[rendered & ~target] = (.45 * canvas[rendered & ~target] +
                                  .55 * np.array([255, 50, 60])).astype(np.uint8)
    contours, _ = cv2.findContours(rendered.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(canvas, contours, -1, (40, 220, 105), 2)
    Image.fromarray(canvas).save(output)


def diagnostic_html(record: dict) -> str:
    cards = "".join(
        f'''<article><h3>{item['label']} · {item['maskMethod']}</h3>
        <img src="{item['overlay']}"><p>held-out P95 <b>{record['heldOut'][item['label']]['p95Mm']} mm</b></p></article>'''
        for item in record["evidence"])
    render_cards = "".join(
        f'''<article><h3>{item['label']} · held-out extrusion</h3><img src="{item['overlay']}">
        <p>silhouette IoU <b>{item['iou']}</b> · green prediction, amber missed, red excess</p></article>'''
        for item in record["heldOutRerenders"])
    gate = record["decision"]["passesPilotGate"]
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{record['sku']} VGGT profile pilot</title><style>:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:1250px;margin:auto;padding:36px}}header,.plot,article{{background:#1a1a1a;padding:20px;margin-bottom:18px}}.flag{{display:inline-block;border:1px solid {'#4d8258' if gate else '#96604f'};padding:9px 12px;color:#dfbf80}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}img{{width:100%;display:block;background:white}}p{{color:#aaa}}b{{color:#eee}}code{{color:#dfbf80}}@media(max-width:800px){{.grid{{grid-template-columns:1fr}}}}</style></head><body><header><p>RESEARCH-ONLY · ORIGINAL VGGT CHECKPOINT · RENDERER UNCHANGED</p><h1>{record['sku']} · 3D-rectified section fit</h1><span class="flag">{'PASSES PILOT GATE' if gate else 'DOES NOT PASS PILOT GATE'}</span><p>{record['decision']['reason']}</p></header><section class="plot"><h2>Cross-view profile comparison</h2><img src="profile-fit.png"><p>Worst held-out P95: <b>{record['decision']['worstHeldOutP95Mm']} mm</b> · observed relief: <b>{record['decision']['observedReliefMm']} mm</b></p></section><h2>Cut-face evidence</h2><div class="grid">{cards}</div><h2>Held-out 3D re-renders</h2><div class="grid">{render_cards}</div><p>No visualiser or Three.js files were read or changed by this stage.</p></body></html>'''


def run(product: Path) -> dict:
    pilot = product / "profile-analysis" / "vggt-profile-pilot"
    predictions = np.load(pilot / "predictions.npz")
    labels = [str(value) for value in predictions["labels"]]
    indices = {label: labels.index(label) for label in FIT_LABELS}
    candidate = json.loads((product / "profile-analysis" / "section-pilot" /
                            "profile-candidate.json").read_text())
    width_mm, depth_mm = float(candidate["widthMm"]), float(candidate["depthMm"])
    masks, mask_details = {}, {}
    for label in FIT_LABELS:
        mask_file, method = mask_path(product, label)
        mask = square_mask(mask_file, predictions["images"].shape[1])
        masks[label], mask_details[label] = mask, (mask_file, method)
    length_axis = extrusion_axis(predictions["worldPoints"], predictions["masks"],
                                 predictions["depthConfidence"])
    plane_normal, plane_offset, plane_residual = fitted_cut_plane(
        masks, indices, predictions["worldPoints"], predictions["depthConfidence"])
    boundaries, evidence = {}, []
    for label in FIT_LABELS:
        mask = masks[label]
        mask_file, method = mask_details[label]
        index = indices[label]
        boundaries[label] = boundary_world(mask, predictions["extrinsics"][index],
                                            predictions["intrinsics"][index],
                                            plane_normal, plane_offset)
        overlay_name = f"{label}-3d-evidence.png"
        overlay(predictions["images"][index], mask, pilot / overlay_name)
        evidence.append({"label": label, "mask": str(mask_file.relative_to(product)),
                         "maskMethod": method, "overlay": overlay_name})
    width_axis, depth_axis = build_basis(boundaries["img23"], plane_normal)
    reference_u = boundaries["img23"][2] @ width_axis
    world_span = np.percentile(reference_u, 98.5) - np.percentile(reference_u, 1.5)
    scale = width_mm / max(world_span, 1e-9)
    curves = {label: curve_mm(boundary, width_axis, depth_axis, scale, width_mm, depth_mm)
              for label, boundary in boundaries.items()}
    reference_index = indices["img23"]
    front_polygon = mask_polygon_world(masks["img23"], predictions["extrinsics"][reference_index],
                                       predictions["intrinsics"][reference_index],
                                       plane_normal, plane_offset)
    render_front_offset = float(np.median(front_polygon @ length_axis))
    back_offset = extrusion_extent(predictions["worldPoints"], predictions["masks"],
                                   predictions["depthConfidence"], length_axis, render_front_offset)
    rerenders = []
    for label in ("img01", "img06", "img12", "img17", "img28", "img34", "img39", "img45"):
        if label not in indices and label not in labels:
            continue
        index = labels.index(label)
        rendered = render_extrusion(front_polygon, back_offset, length_axis,
                                    predictions["extrinsics"][index], predictions["intrinsics"][index],
                                    predictions["masks"][index].shape)
        target = predictions["masks"][index].astype(bool)
        union = np.count_nonzero(rendered | target)
        iou = np.count_nonzero(rendered & target) / max(union, 1)
        overlay_name = f"{label}-heldout-rerender.png"
        rerender_overlay(predictions["images"][index], target, rendered, pilot / overlay_name)
        rerenders.append({"label": label, "iou": round(float(iou), 3), "overlay": overlay_name})
    held_out, fused = leave_one_out(curves)
    fused = savgol_filter(medfilt(fused, 5), 13, 2)
    relief = float(np.percentile(fused, 97) - np.percentile(fused, 3))
    worst = max(value["p95Mm"] for value in held_out.values())
    is_control = candidate["sku"] == "POL-4100"
    median_iou = float(np.median([item["iou"] for item in rerenders]))
    passes = (worst <= (1.5 if is_control else 2.5)
              and (relief <= 2.5 if is_control else relief >= 3.0)
              and median_iou >= (0.65 if is_control else 0.55))
    if is_control:
        reason = ("The flat control remains flat and agrees across held-out views."
                  if passes else "The flat control is distorted or cross-view disagreement is too large.")
    else:
        reason = ("The non-flat section retains meaningful relief and agrees across held-out views."
                  if passes else "The recovered relief is not stable enough across held-out supplier views.")
    profile_plot(curves, fused, width_mm, depth_mm, pilot / "profile-fit.png")
    record = {
        "sku": candidate["sku"], "widthMm": width_mm, "depthMm": depth_mm,
        "method": "VGGT shared-3D cut-face rectification plus leave-one-view-out fusion",
        "model": "facebook/VGGT-1B original research checkpoint",
        "commercialDeploymentAllowed": False, "rendererIntegrated": False,
        "fitFrames": list(FIT_LABELS), "heldOut": held_out, "evidence": evidence,
        "heldOutRerenders": rerenders,
        "cutPlaneResidualWorldP95": round(plane_residual, 7),
        "worldUnitsPerMm": round(float(1 / scale), 8),
        "points": simplify(fused, width_mm),
        "decision": {"passesPilotGate": bool(passes), "worstHeldOutP95Mm": round(worst, 3),
                     "observedReliefMm": round(relief, 3),
                     "medianHeldOutSilhouetteIou": round(median_iou, 3), "reason": reason},
    }
    (pilot / "profile-fit.json").write_text(json.dumps(record, indent=2) + "\n")
    (pilot / "diagnostic.html").write_text(diagnostic_html(record))
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default="source-material/mainline")
    parser.add_argument("--skus", default="POL-4100,POL-4508")
    args = parser.parse_args()
    source = Path(args.source_root).resolve()
    records = []
    for sku in [value.strip() for value in args.skus.split(",") if value.strip()]:
        record = run(source / sku)
        records.append(record)
        print(json.dumps({"sku": sku, **record["decision"]}, indent=2))
    (source / "vggt-profile-pilot.json").write_text(json.dumps(records, indent=2) + "\n")
    cards = "".join(
        f'''<a href="{record['sku']}/profile-analysis/vggt-profile-pilot/diagnostic.html"><strong>{record['sku']}</strong><span>{'PASS' if record['decision']['passesPilotGate'] else 'FAIL'}</span><small>profile P95 {record['decision']['worstHeldOutP95Mm']} mm · silhouette IoU {record['decision']['medianHeldOutSilhouetteIou']} · relief {record['decision']['observedReliefMm']} mm</small></a>'''
        for record in records)
    summary = f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VGGT profile pilot</title><style>:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:900px;margin:auto;padding:40px}}.warning{{border:1px solid #8b6734;background:#241f16;padding:18px}}a{{display:grid;grid-template-columns:150px 1fr;gap:8px;background:#1b1b1b;color:#eee;text-decoration:none;padding:20px;margin:12px 0}}span{{text-align:right;color:#dfbf80}}small{{grid-column:1/3;color:#aaa}}</style></head><body><p>ISOLATED RESEARCH PILOT · VISUALISER UNCHANGED</p><h1>VGGT → constrained profile → held-out re-render</h1><div class="warning">The downloaded original VGGT checkpoint is non-commercial research-only. A successful method would still require the separately licensed commercial checkpoint.</div>{cards}</body></html>'''
    (source / "vggt-profile-pilot.html").write_text(summary)
    print(f"Summary: {source / 'vggt-profile-pilot.html'}")


if __name__ == "__main__":
    main()
