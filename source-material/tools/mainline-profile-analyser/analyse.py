#!/usr/bin/env python3
"""Experimental silhouette diagnostics for an imported Mainline spin sequence.

This deliberately does not infer or install renderer profile geometry. It produces
reviewable masks, boundary traces and suitability measurements only.
"""

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def largest_component(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    best = []
    for y, x in zip(*np.nonzero(mask & ~visited)):
        if visited[y, x]:
            continue
        queue = deque([(int(y), int(x))])
        visited[y, x] = True
        component = []
        while queue:
            cy, cx = queue.popleft()
            component.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    queue.append((ny, nx))
        if len(component) > len(best):
            best = component
    result = np.zeros_like(mask, dtype=bool)
    if best:
        ys, xs = zip(*best)
        result[np.array(ys), np.array(xs)] = True
    return result


def analyse_image(path: Path, threshold: int):
    image = Image.open(path).convert("RGB")
    rgb = np.asarray(image)
    luminance = rgb.mean(axis=2)
    mask = largest_component(luminance < threshold)
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise RuntimeError(f"No foreground component found in {path}")
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    boundary = []
    x0, y0, x1, y1 = bbox
    for y in range(y0, y1):
        row = np.flatnonzero(mask[y])
        if len(row):
            boundary.append({
                "y": round((y - y0) / max(1, y1 - y0 - 1), 5),
                "left": round((int(row.min()) - x0) / max(1, x1 - x0 - 1), 5),
                "right": round((int(row.max()) - x0) / max(1, x1 - x0 - 1), 5),
            })
    return image, mask, {
        "filename": path.name,
        "width": image.width,
        "height": image.height,
        "bbox": bbox,
        "bboxWidth": x1 - x0,
        "bboxHeight": y1 - y0,
        "foregroundPixels": int(mask.sum()),
        "occupancy": round(float(mask.mean()), 5),
        "boundary": boundary,
    }


def save_diagnostics(image, mask, stem: str, output: Path):
    mask_image = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), mode="L")
    mask_image.save(output / f"{stem}-mask.png")
    overlay = image.copy()
    draw = ImageDraw.Draw(overlay)
    padded = np.pad(mask, 1, constant_values=False)
    eroded = padded[1:-1, 1:-1] & padded[:-2, 1:-1] & padded[2:, 1:-1] & padded[1:-1, :-2] & padded[1:-1, 2:]
    edge_y, edge_x = np.nonzero(mask & ~eroded)
    for x, y in zip(edge_x, edge_y):
        draw.point((int(x), int(y)), fill=(225, 45, 45))
    overlay.save(output / f"{stem}-overlay.png")


def diagnostic_html(sku: str, selected, rankings):
    sections = "".join(
        f'''<section><h2>{item["label"]}</h2><div class="pair">
        <figure><img src="../spin/{item["filename"]}"><figcaption>source</figcaption></figure>
        <figure><img src="{Path(item["filename"]).stem}-overlay.png"><figcaption>threshold silhouette overlay</figcaption></figure>
        <figure><img src="{Path(item["filename"]).stem}-mask.png"><figcaption>largest foreground component</figcaption></figure>
        </div><p>Bounding box: {item["bboxWidth"]} × {item["bboxHeight"]} px · occupancy {item["occupancy"]}</p></section>'''
        for item in selected
    )
    rows = "".join(f'<tr><td>{item["label"]}</td><td>{item["bboxWidth"]}</td><td>{item["bboxHeight"]}</td><td>{item["occupancy"]}</td></tr>' for item in rankings)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{sku} profile-analysis diagnostics</title><style>
    :root{{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#111;color:#eee}}body{{max-width:1250px;margin:auto;padding:32px}}h1{{margin-bottom:4px}}.lede,figcaption,p{{color:#aaa}}section{{border-top:1px solid #333;margin-top:30px;padding-top:20px}}.pair{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}figure{{margin:0;background:#1b1b1b;padding:12px}}img{{display:block;width:100%;image-rendering:auto;background:white}}figcaption{{margin-top:8px;font-size:12px}}table{{border-collapse:collapse;width:100%;margin-top:20px}}th,td{{border-bottom:1px solid #333;padding:8px;text-align:left}}@media(max-width:800px){{.pair{{grid-template-columns:1fr}}}}</style></head><body>
    <h1>{sku} silhouette diagnostics</h1><p class="lede">Experimental evidence only. No renderer profile has been generated or changed.</p>{sections}
    <section><h2>Frames ranked by narrowest foreground bounding box</h2><table><thead><tr><th>Frame</th><th>Width</th><th>Height</th><th>Occupancy</th></tr></thead><tbody>{rows}</tbody></table></section></body></html>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Product directory containing spin-manifest.json and spin/")
    parser.add_argument("--threshold", type=int, default=175)
    parser.add_argument("--selected", default="img01,img02,img23,img44,img45")
    args = parser.parse_args()
    root = Path(args.input).resolve()
    manifest = json.loads((root / "spin-manifest.json").read_text())
    output = root / "profile-analysis"
    output.mkdir(parents=True, exist_ok=True)
    selected_labels = set(args.selected.split(","))
    measurements = []
    selected = []
    boundaries = {}
    source_arrays = []
    for record in manifest["images"]:
        path = root / "spin" / record["filename"]
        image, mask, measurement = analyse_image(path, args.threshold)
        measurement["label"] = record["label"]
        measurements.append(measurement)
        source_arrays.append(np.asarray(image, dtype=np.int16))
        if record["label"] in selected_labels:
            save_diagnostics(image, mask, path.stem, output)
            selected.append(measurement)
            boundaries[record["label"]] = measurement["boundary"]
    rankings = sorted(measurements, key=lambda item: item["bboxWidth"])
    adjacent_differences = [float(np.abs(source_arrays[i] - source_arrays[i - 1]).mean()) for i in range(1, len(source_arrays))]
    endpoint_difference = float(np.abs(source_arrays[0] - source_arrays[-1]).mean())
    result = {
        "sku": manifest["sku"],
        "sourceImageCount": len(measurements),
        "threshold": args.threshold,
        "selectedDiagnostics": sorted(selected_labels),
        "profileCandidates": [item["label"] for item in rankings[:4]],
        "endpointMeanAbsoluteDifference": round(endpoint_difference, 3),
        "medianAdjacentMeanAbsoluteDifference": round(float(np.median(adjacent_differences)), 3),
        "coverageAssessment": "not a closed 360-degree loop; endpoints differ materially and the sequence is an approximately 180-degree inspection arc",
        "suitability": "good for coarse silhouette segmentation; insufficient alone for calibrated CAD/profile recovery",
        "measurements": measurements,
    }
    (output / "analysis-manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    (output / "candidate-boundaries.json").write_text(json.dumps(boundaries, indent=2) + "\n")
    (output / "profile-analysis.html").write_text(diagnostic_html(manifest["sku"], selected, rankings))
    print(f"Analysed {len(measurements)} frames; closest profile candidates: {', '.join(result['profileCandidates'])}")
    print(f"Diagnostics: {output / 'profile-analysis.html'}")


if __name__ == "__main__":
    main()
