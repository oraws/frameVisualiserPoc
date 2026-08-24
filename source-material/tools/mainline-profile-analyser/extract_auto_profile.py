#!/usr/bin/env python3
"""Deterministic DP/consensus extraction of a Mainline macro moulding profile."""

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def normalize(array):
    low, high = np.percentile(array, (2, 98))
    return np.clip((array - low) / max(1e-6, high - low), 0, 1).astype(np.float32)


def gradient_magnitude(channel):
    source = channel.astype(np.float32)
    gx = cv2.Sobel(source, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(source, cv2.CV_32F, 0, 1, ksize=3)
    return normalize(cv2.magnitude(gx, gy))


def region_difference(channel, radius=5, gap=2):
    source = channel.astype(np.float32)
    height = source.shape[0]
    result = np.zeros_like(source, dtype=np.float32)
    for y in range(gap + radius, height - gap - radius):
        above = source[y - gap - radius:y - gap].mean(axis=0)
        below = source[y + gap:y + gap + radius].mean(axis=0)
        result[y] = np.abs(above - below)
    return normalize(result)


def edge_evidence(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    gray_sobel = gradient_magnitude(gray)
    lab_gradient = normalize(sum(gradient_magnitude(lab[:, :, index]) for index in range(3)))
    hsv_gradient = normalize(.7 * gradient_magnitude(hsv[:, :, 2]) + .3 * gradient_magnitude(hsv[:, :, 1]))
    canny = cv2.Canny(gray, 35, 105).astype(np.float32) / 255
    local = normalize(np.abs(gray.astype(np.float32) - cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 4)))
    region = normalize(.55 * region_difference(lab[:, :, 0]) + .25 * region_difference(lab[:, :, 1]) + .2 * region_difference(lab[:, :, 2]))
    return {"gray-sobel": gray_sobel, "lab-gradient": lab_gradient, "hsv-gradient": hsv_gradient,
            "canny": canny, "local-contrast": local, "region-consistency": region}


def dp_path(point_cost, y_min, y_max, max_step, smoothness, curvature, endpoint_y=None, endpoint_weight=0):
    cropped = point_cost[y_min:y_max + 1]
    height, width = cropped.shape
    deltas = np.arange(-max_step, max_step + 1)
    count = len(deltas)
    zero = max_step
    previous = np.full((height, count), np.inf, dtype=np.float32)
    previous[:, zero] = cropped[:, 0]
    back = np.full((width, height, count), -1, dtype=np.int8)
    for x in range(1, width):
        current = np.full_like(previous, np.inf)
        for delta_index, delta in enumerate(deltas):
            ys = np.arange(height)
            previous_y = ys - delta
            valid = (previous_y >= 0) & (previous_y < height)
            if not np.any(valid):
                continue
            transition = previous[previous_y[valid], :] + curvature * np.abs(deltas[None, :] - delta)
            best_previous_delta = np.argmin(transition, axis=1)
            current[ys[valid], delta_index] = transition[np.arange(valid.sum()), best_previous_delta] + cropped[ys[valid], x] + smoothness * abs(delta)
            back[x, ys[valid], delta_index] = best_previous_delta.astype(np.int8)
        previous = current
    if endpoint_y is not None:
        endpoint_penalty = endpoint_weight * np.abs(np.arange(height) + y_min - endpoint_y)
        previous = previous + endpoint_penalty[:, None]
    flat = int(np.argmin(previous))
    y_index, delta_index = np.unravel_index(flat, previous.shape)
    path = np.zeros(width, dtype=np.int16)
    path[-1] = y_index + y_min
    for x in range(width - 1, 0, -1):
        delta = deltas[delta_index]
        previous_delta_index = int(back[x, y_index, delta_index])
        y_index -= delta
        delta_index = previous_delta_index
        path[x - 1] = y_index + y_min
    return path


def rdp(points, epsilon):
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


def uncertain_regions(std_pixels, x_start, x_end, width_mm, threshold=4.0):
    uncertain = std_pixels > threshold
    groups = []
    start = None
    for index, value in enumerate(np.r_[uncertain, False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            u0 = width_mm * (1 - (index - 1 - x_start) / (x_end - x_start))
            u1 = width_mm * (1 - (start - x_start) / (x_end - x_start))
            groups.append({"uStartMm": round(max(0, min(u0, u1)), 2), "uEndMm": round(min(width_mm, max(u0, u1)), 2),
                           "maxDisagreementPixels": round(float(std_pixels[start:index].max()), 2)})
            start = None
    return groups


def save_heatmap(array, path):
    image = (normalize(array) * 255).astype(np.uint8)
    cv2.imwrite(str(path), image)


def overlay_paths(rgb, output, dense=None, simplified=None, heuristic=None, uncertainty=None):
    image = Image.fromarray(rgb).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    if uncertainty:
        for start, end in uncertainty:
            draw.rectangle((start, 0, end, image.height), fill=(255, 180, 0, 35))
    if heuristic:
        draw.line([tuple(point) for point in heuristic], fill=(240, 55, 55, 230), width=2)
    if dense is not None:
        draw.line([(x, int(y)) for x, y in enumerate(dense)], fill=(255, 45, 45, 230), width=2)
    if simplified:
        draw.line([tuple(point) for point in simplified], fill=(35, 255, 90, 255), width=3)
    image.save(output)


def spin_top_diagnostics(product_root, output):
    selected = [("img01", "side-oblique"), ("img02", "side-oblique"), ("img11", "front-oblique"),
                ("img23", "front"), ("img34", "rear-oblique"), ("img44", "rear-oblique"), ("img45", "rear-oblique")]
    output.mkdir(parents=True, exist_ok=True)
    cards = []
    cv2.setRNGSeed(4875)
    for label, classification in selected:
        source_path = product_root / "spin" / f"{label}.jpg"
        bgr = cv2.imread(str(source_path))
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        foreground = gray < 185
        pixels = lab[foreground].astype(np.float32)
        _, labels, centers = cv2.kmeans(pixels, 3, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, .1), 8, cv2.KMEANS_PP_CENTERS)
        substrate_cluster = int(np.argmax(centers[:, 0]))
        clustered = np.zeros_like(foreground, dtype=np.uint8)
        clustered[foreground] = (labels.ravel() == substrate_cluster).astype(np.uint8)
        count, components, stats, _ = cv2.connectedComponentsWithStats(clustered, 8)
        if count > 1:
            ordered = np.argsort(stats[1:, cv2.CC_STAT_AREA])[::-1][:2] + 1
            clustered = np.isin(components, ordered).astype(np.uint8)
        overlay = bgr.copy()
        contours, _ = cv2.findContours(clustered, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, (0, 210, 255), 2)
        filename = f"{label}-top-surface-overlay.jpg"
        cv2.imwrite(str(output / filename), overlay)
        cards.append({"label": label, "classification": classification, "source": f"../../spin/{label}.jpg", "overlay": f"spin-top-surface/{filename}"})
    html = "".join(f'<figure><h3>{c["label"]} · {c["classification"]}</h3><div><img src="{c["source"]}"><img src="{c["overlay"]}"></div></figure>' for c in cards)
    return cards, html


def clay_validation(profile_points, output):
    canvas = Image.new("RGB", (720, 420), "#eee9df")
    draw = ImageDraw.Draw(canvas)
    plot = [(70 + u / 97 * 540, 350 - z / 49 * 260) for u, z in profile_points]
    offset = (70, -45)
    rear = [(x + offset[0], y + offset[1]) for x, y in plot]
    polygon = plot + list(reversed(rear))
    draw.polygon(polygon, fill="#777771", outline="#343431")
    draw.line(rear, fill="#aaa9a2", width=3)
    draw.line(plot, fill="#333330", width=4)
    draw.text((24, 20), "Low-resolution clay extrusion for broad silhouette validation only", fill="#333")
    canvas.save(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-root", required=True)
    parser.add_argument("--native-metadata", required=True)
    parser.add_argument("--current-trace")
    args = parser.parse_args()
    product_root = Path(args.product_root).resolve()
    metadata = json.loads(Path(args.native_metadata).read_text())
    native_root = Path(args.native_metadata).parent
    output = product_root / "profile-analysis" / "auto"
    output.mkdir(parents=True, exist_ok=True)
    rgb = np.asarray(Image.open(native_root / metadata["profileNativeFilename"]).convert("RGB"))
    maps = edge_evidence(rgb)
    for name, image in maps.items():
        save_heatmap(image, output / f"edge-{name}.png")
    calibration = metadata["calibration"]
    x_start = max(0, int(round(calibration["widthPixelStart"])))
    x_end = min(rgb.shape[1] - 1, int(round(calibration["widthPixelEnd"])))
    y_min = max(0, int(math.floor(calibration["depthPixelTop"] - 12)))
    y_max = min(rgb.shape[0] - 2, int(math.ceil(calibration["backingBaselinePixel"] - 2)))
    rebate_y = calibration["rebatePixelTop"]
    configs = []
    methods = ["gray-sobel", "lab-gradient", "hsv-gradient", "canny", "local-contrast"]
    for method_index, method in enumerate(methods):
        for variant in range(3):
            configs.append({"method": method, "smoothness": [0.018, .035, .06][variant],
                            "curvature": [.015, .035, .07][variant], "regionWeight": [.25, .4, .55][variant],
                            "maxStep": [7, 6, 5][variant], "endpointWeight": [.012, .02, .03][variant]})
    candidates = []
    crop = slice(x_start, x_end + 1)
    for index, config in enumerate(configs, 1):
        evidence = normalize(.72 * maps[config["method"]] + config["regionWeight"] * maps["region-consistency"])
        point_cost = 1 - evidence
        path_crop = dp_path(point_cost[:, crop], y_min, y_max, config["maxStep"], config["smoothness"], config["curvature"], rebate_y, config["endpointWeight"])
        path = np.full(rgb.shape[1], path_crop[0], dtype=np.int16)
        path[x_start:x_end + 1] = path_crop
        path[:x_start] = path_crop[0]; path[x_end + 1:] = path_crop[-1]
        edge_agreement = float(evidence[path, np.arange(rgb.shape[1])][crop].mean())
        second = np.diff(path_crop.astype(float), 2)
        continuity = float(math.exp(-np.mean(np.minimum(np.abs(second), 12)) / 3.5))
        z_values = (calibration["backingBaselinePixel"] - path_crop) / (calibration["backingBaselinePixel"] - calibration["depthPixelTop"]) * 49
        dimensional = max(0, 1 - abs(float(z_values.max()) - 49) / 49)
        rebate = max(0, 1 - abs(float(z_values[-1]) - 16) / 16)
        initial_score = .55 * edge_agreement + .2 * continuity + .15 * dimensional + .1 * rebate
        record = {"id": f"candidate-{index:02d}", "config": config, "edgeAgreement": round(edge_agreement, 5),
                  "continuity": round(continuity, 5), "dimensionalPlausibility": round(dimensional, 5),
                  "rebateConsistency": round(rebate, 5), "initialScore": round(initial_score, 5), "pathPixels": path.tolist()}
        candidates.append(record)
    path_stack = np.array([candidate["pathPixels"] for candidate in candidates], dtype=float)
    provisional = np.median(path_stack, axis=0)
    for candidate, path in zip(candidates, path_stack):
        agreement = float(math.exp(-np.median(np.abs(path[crop] - provisional[crop])) / 6))
        candidate["consensusAgreement"] = round(agreement, 5)
        candidate["score"] = round(.78 * candidate["initialScore"] + .22 * agreement, 5)
    candidates.sort(key=lambda candidate: candidate["score"], reverse=True)
    selected = candidates[:8]
    selected_paths = np.array([candidate["pathPixels"] for candidate in selected], dtype=float)
    dense = np.median(selected_paths, axis=0)
    std = selected_paths.std(axis=0)
    uncertain = uncertain_regions(std, calibration["widthPixelStart"], calibration["widthPixelEnd"], 97)
    points = np.column_stack((np.arange(x_start, x_end + 1), dense[x_start:x_end + 1]))
    simplified_indices = set(rdp(points.astype(float), 1.45))
    curvature = np.abs(np.diff(dense[x_start:x_end + 1], 2, prepend=dense[x_start], append=dense[x_end]))
    simplified_indices.update(np.flatnonzero(curvature > 2.75).tolist())
    simplified_indices.update([0, len(points) - 1])
    simplified_indices = sorted(simplified_indices)
    if len(simplified_indices) < 25:
        simplified_indices = sorted(set(simplified_indices) | set(np.linspace(0, len(points) - 1, 25).astype(int).tolist()))
    while len(simplified_indices) > 60:
        simplified_indices = simplified_indices[::2] + ([simplified_indices[-1]] if simplified_indices[-1] not in simplified_indices[::2] else [])
        simplified_indices = sorted(set(simplified_indices))
    simplified_pixels = [[int(points[index, 0]), round(float(points[index, 1]), 2)] for index in simplified_indices]
    physical = []
    for x, y in reversed(simplified_pixels):
        u = 97 * (calibration["widthPixelEnd"] - x) / (calibration["widthPixelEnd"] - calibration["widthPixelStart"])
        z = 49 * (calibration["backingBaselinePixel"] - y) / (calibration["backingBaselinePixel"] - calibration["depthPixelTop"])
        physical.append([round(float(np.clip(u, 0, 97)), 3), round(float(np.clip(z, 0, 49)), 3)])
    edge_score = float(np.mean([candidate["edgeAgreement"] for candidate in selected]))
    consensus_score = float(math.exp(-np.mean(std[crop]) / 5))
    dimensional_score = float(np.mean([candidate["dimensionalPlausibility"] for candidate in selected]))
    rebate_score = float(np.mean([candidate["rebateConsistency"] for candidate in selected]))
    confidence = .38 * edge_score + .32 * consensus_score + .18 * dimensional_score + .12 * rebate_score
    auto = {"supplier": "Mainline", "sku": "POL-4875", "source": "Verona_Spec_Sheet.pdf page 2 native xref image",
            "method": "pdf-native-edge-path-consensus", "widthMm": 97, "depthMm": 49, "rebateMm": 16,
            "confidence": round(confidence, 4), "scores": {"edgeAgreement": round(edge_score, 4), "consensusAgreement": round(consensus_score, 4),
            "dimensionalConfidence": round(dimensional_score, 4), "rebateConfidence": round(rebate_score, 4)},
            "calibration": calibration, "selectedCandidateIds": [candidate["id"] for candidate in selected],
            "densePathPixels": [[x, round(float(dense[x]), 2)] for x in range(x_start, x_end + 1)],
            "points": physical, "uncertainRegions": uncertain,
            "status": "experimental-unapproved", "rendererIntegrated": False}
    (output / "profile-auto.json").write_text(json.dumps(auto, indent=2) + "\n")
    for rank, candidate in enumerate(candidates, 1):
        candidate_output = dict(candidate); candidate_output["rank"] = rank
        (output / f'{candidate["id"]}.json').write_text(json.dumps(candidate_output, indent=2) + "\n")
        overlay_paths(rgb, output / f'{candidate["id"]}-overlay.png', dense=np.array(candidate["pathPixels"]))
    current = None
    if args.current_trace and Path(args.current_trace).exists():
        current_data = json.loads(Path(args.current_trace).read_text())
        current = current_data.get("sourceTracePixelsLeftToRight")
    uncertainty_pixels = []
    for region in uncertain:
        px0 = int(calibration["widthPixelEnd"] - region["uEndMm"] / 97 * (calibration["widthPixelEnd"] - calibration["widthPixelStart"]))
        px1 = int(calibration["widthPixelEnd"] - region["uStartMm"] / 97 * (calibration["widthPixelEnd"] - calibration["widthPixelStart"]))
        uncertainty_pixels.append((px0, px1))
    overlay_paths(rgb, output / "dense-path.png", dense=dense)
    overlay_paths(rgb, output / "profile-comparison.png", simplified=simplified_pixels, heuristic=current, uncertainty=uncertainty_pixels)
    spin_cards, spin_html = spin_top_diagnostics(product_root, output / "spin-top-surface")
    clay_validation(physical, output / "clay-profile-validation.png")
    (output / "spin-validation.json").write_text(json.dumps({"views": spin_cards, "method": "deterministic LAB k-means top-surface experiment", "status": "validation-only"}, indent=2) + "\n")
    graph_points = " ".join(f'{30 + u / 97 * 485:.1f},{280 - z / 49 * 220:.1f}' for u, z in physical)
    uncertain_html = "".join(f'<li>{r["uStartMm"]}–{r["uEndMm"]} mm (max disagreement {r["maxDisagreementPixels"]} px)</li>' for r in uncertain) or "<li>None above threshold</li>"
    diagnostic = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>POL-4875 automatic profile diagnostic</title><style>
    :root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:1250px;margin:auto;padding:34px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px}}figure{{margin:0;background:#1b1b1b;padding:14px}}img,svg{{display:block;width:100%;background:white}}p,figcaption,li{{color:#aaa;line-height:1.5}}.scores{{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}}.score{{background:#202020;padding:12px}}.score strong{{display:block;font-size:22px;color:#dabb7a}}.legend b:nth-child(1){{color:#ed3c3c}}.legend b:nth-child(2){{color:#2cff62}}@media(max-width:780px){{.grid,.scores{{grid-template-columns:1fr}}}}</style></head><body>
    <h1>POL-4875 automatic profile extraction</h1><p>Native PDF raster + vector-dimension calibration. Deterministic DP consensus; renderer untouched.</p><div class="scores"><div class="score"><strong>{confidence:.3f}</strong>total</div><div class="score"><strong>{edge_score:.3f}</strong>edge</div><div class="score"><strong>{consensus_score:.3f}</strong>consensus</div><div class="score"><strong>{dimensional_score:.3f}</strong>dimensions</div><div class="score"><strong>{rebate_score:.3f}</strong>rebate</div></div>
    <h2>A. Native source</h2><figure><img src="../native/{metadata["profileNativeFilename"]}"><figcaption>275×229 native JPEG, not a screenshot</figcaption></figure>
    <h2>B. Edge evidence</h2><div class="grid"><figure><img src="edge-gray-sobel.png"><figcaption>grayscale Sobel</figcaption></figure><figure><img src="edge-lab-gradient.png"><figcaption>LAB gradient</figcaption></figure><figure><img src="edge-canny.png"><figcaption>Canny</figcaption></figure><figure><img src="edge-region-consistency.png"><figcaption>above/below material consistency</figcaption></figure></div>
    <h2>C–D. Dense path and simplified comparison</h2><div class="grid"><figure><img src="dense-path.png"><figcaption>Dense automatic path in red</figcaption></figure><figure><img src="profile-comparison.png"><figcaption class="legend"><b>Current heuristic</b> vs <b>new simplified consensus</b>; amber bands indicate disagreement</figcaption></figure></div>
    <h2>E. Physical profile</h2><figure><svg viewBox="0 0 550 320"><rect width="550" height="320" fill="#eee"/><path d="M30 280H520M30 280V45" stroke="#777"/><polyline points="{graph_points}" fill="none" stroke="#139b42" stroke-width="3"/><text x="30" y="305" fill="#555">0 mm inner</text><text x="460" y="305" fill="#555">97 mm outer</text><text x="2" y="65" fill="#555">49 mm</text></svg></figure>
    <h2>F–G. Confidence and uncertain regions</h2><ul>{uncertain_html}</ul><h2>Spin top-surface experiment</h2><p>LAB material clustering only; used for rejection/validation, not tracing.</p>{spin_html}<h2>Clay validation</h2><figure><img src="clay-profile-validation.png"><figcaption>Broad silhouette check only; no pixel-perfect spin alignment claimed.</figcaption></figure></body></html>'''
    (output / "profile-auto-diagnostic.html").write_text(diagnostic)
    print(f'Generated {len(candidates)} deterministic candidates; consensus confidence {confidence:.3f}; {len(physical)} simplified points')
    print(f'Diagnostic: {output / "profile-auto-diagnostic.html"}')


if __name__ == "__main__":
    main()
