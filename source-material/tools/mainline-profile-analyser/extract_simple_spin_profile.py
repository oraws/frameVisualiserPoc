#!/usr/bin/env python3
"""Extract a conservative two-level moulding profile from a Mainline spin sequence.

This route is deliberately limited to flat/simple profiles. It uses the near-front
spin frames to locate the visible cut-end silhouette, then calibrates the two
depth levels with supplier dimensions. Complex profiles are rejected.
"""

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def largest_component_mask(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    corner = np.concatenate((gray[:20, :20].ravel(), gray[:20, -20:].ravel()))
    threshold = min(225, int(np.median(corner) - 28))
    mask = (gray < threshold).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=2)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count < 2:
        raise ValueError("No foreground component found")
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == component).astype(np.uint8), stats[component]


def median_filter(values, width=5):
    pad = width // 2
    padded = np.pad(values, (pad, pad), mode="edge")
    return np.array([np.median(padded[i:i + width]) for i in range(len(values))])


def two_means(values):
    centers = np.array([np.percentile(values, 15), np.percentile(values, 85)], dtype=float)
    for _ in range(30):
        labels = np.argmin(np.abs(values[:, None] - centers[None, :]), axis=1)
        updated = np.array([values[labels == i].mean() if np.any(labels == i) else centers[i] for i in range(2)])
        if np.allclose(updated, centers):
            break
        centers = updated
    order = np.argsort(centers)
    remap = np.zeros(2, dtype=int)
    remap[order] = np.arange(2)
    return centers[order], remap[labels]


def longest_run(values):
    best = (0, 0, values[0])
    start = 0
    for index in range(1, len(values) + 1):
        if index == len(values) or values[index] != values[start]:
            if index - start > best[1] - best[0]:
                best = (start, index, values[start])
            start = index
    return best


def analyse_frame(path):
    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Cannot read {path}")
    mask, stats = largest_component_mask(image)
    x, y, width, height, area = map(int, stats)
    return {"path": path, "image": image, "mask": mask, "bbox": [x, y, width, height],
            "frontScore": width / max(height, 1), "area": area}


def extract_candidate(frame, width_mm, depth_mm, rebate_mm):
    x0, y0, width, height = frame["bbox"]
    mask = frame["mask"]
    xs = np.arange(x0, x0 + width)
    top = np.array([np.flatnonzero(mask[:, x])[0] if np.any(mask[:, x]) else y0 for x in xs], dtype=float)
    top = median_filter(top, 5)

    # Ignore anti-aliased edge columns and short edge fragments. Those fragments
    # otherwise become a false third "level" in a two-cluster fit.
    trim = max(3, int(round(width * 0.045)))
    column_heights = mask[:, xs].sum(axis=0)
    body_columns = np.flatnonzero(column_heights > height * 0.55)
    profile_x_start = int(xs[body_columns[0]])
    profile_x_end = int(xs[body_columns[-1]])
    profile_pixel_width = max(profile_x_end - profile_x_start, 1)
    core = slice(trim, len(top) - trim)
    valid = column_heights[core] > height * 0.55
    fitted = top[core][valid]
    centers, _ = two_means(fitted)
    labels = np.argmin(np.abs(top[core, None] - centers[None, :]), axis=1)
    separation = float(centers[1] - centers[0])
    fitted_labels = np.argmin(np.abs(fitted[:, None] - centers[None, :]), axis=1)
    residual = float(np.mean(np.abs(fitted - centers[fitted_labels])))

    # Smooth isolated labels, then find the dominant transition between the two plateaus.
    labels = median_filter(labels.astype(float), 7).round().astype(int)
    changes = np.flatnonzero(np.diff(labels) != 0) + 1
    high_indices = np.flatnonzero(labels == 0)  # smaller image y = greater physical depth
    if len(high_indices):
        high_start, high_end = int(high_indices[0]), int(high_indices[-1] + 1)
        left_shelf, right_shelf = high_start, len(labels) - high_end
        inner_on_left = left_shelf >= right_shelf
        transition_core = high_start if inner_on_left else high_end
    else:
        inner_on_left = True
        transition_core = len(labels) // 2
    transition_x = x0 + trim + transition_core
    shelf_pixels = transition_x - profile_x_start if inner_on_left else profile_x_end - transition_x
    transition_mm = shelf_pixels / profile_pixel_width * width_mm
    low_z = max(0.0, depth_mm - rebate_mm)

    # POL-4100 is viewed with its rebate/inner edge on the left in the front frames.
    ramp_px = max(1, int(round(profile_pixel_width * 0.025)))
    ramp_mm = ramp_px / profile_pixel_width * width_mm
    points = [
        [0.0, round(low_z, 3)],
        [round(max(0.0, transition_mm - ramp_mm), 3), round(low_z, 3)],
        [round(min(width_mm, transition_mm + ramp_mm), 3), round(depth_mm, 3)],
        [round(width_mm, 3), round(depth_mm, 3)],
    ]

    fitted_range = max(float(np.ptp(fitted)), 1.0)
    fit_score = math.exp(-residual / max(separation * 0.16, 1.0))
    separation_score = min(1.0, separation / max(height * 0.12, 1.0))
    transition_score = math.exp(-max(0, len(changes) - 3) / 3)
    simple_confidence = 0.45 * fit_score + 0.30 * separation_score + 0.25 * transition_score
    is_simple = separation >= 8 and residual <= max(3.0, fitted_range * 0.12) and len(changes) <= 5

    return {
        "xs": xs, "top": top, "centers": centers, "transitionX": transition_x,
        "transitionMm": transition_mm, "points": points, "residualPixels": residual,
        "separationPixels": separation, "changeCount": int(len(changes)),
        "confidence": float(simple_confidence), "isSimple": bool(is_simple),
        "innerEdge": "left" if inner_on_left else "right",
        "pixelCalibration": {
            "widthPixelStart": float(profile_x_start), "widthPixelEnd": float(profile_x_end),
            "depthPixelTop": float(centers[0]),
            "backingBaselinePixel": float(centers[0] + depth_mm * separation / max(rebate_mm, 0.001)),
        },
    }


def write_overlay(frame, candidate, output_path):
    rgb = cv2.cvtColor(frame["image"], cv2.COLOR_BGR2RGB)
    image = Image.fromarray(rgb)
    draw = ImageDraw.Draw(image, "RGBA")
    draw.line([(int(x), int(y)) for x, y in zip(candidate["xs"], candidate["top"])], fill=(40, 255, 95, 255), width=2)
    tx = int(candidate["transitionX"])
    draw.line([(tx, 10), (tx, image.height - 10)], fill=(255, 184, 55, 210), width=1)
    image.save(output_path)


def review_html(record, source_rel, overlay_rel, profile_json_rel):
    points = record["points"]
    graph = " ".join(f"{40 + u / record['widthMm'] * 520:.1f},{270 - z / record['depthMm'] * 210:.1f}" for u, z in points)
    payload = json.dumps(record)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{record['sku']} profile review</title><style>
:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}*{{box-sizing:border-box}}body{{max-width:1180px;margin:auto;padding:32px}}header{{display:flex;justify-content:space-between;gap:24px;align-items:end;border-bottom:1px solid #333;padding-bottom:22px}}h1{{margin:0}}.tag{{padding:7px 10px;border:1px solid #668d6e;color:#9ce2aa}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:24px}}figure,.panel{{margin:0;background:#1b1b1b;padding:16px}}img,svg{{display:block;width:100%;background:white}}figcaption,p,li{{color:#aaa;line-height:1.5}}.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:20px 0}}.metric{{background:#202020;padding:13px}}.metric strong{{display:block;color:#ddb979;font-size:22px}}.actions{{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}}button,a.button{{border:1px solid #555;background:#222;color:#eee;padding:12px 16px;font-weight:650;cursor:pointer;text-decoration:none}}button.primary{{background:#d8b36d;color:#17130c;border-color:#d8b36d}}#status{{min-height:24px;color:#a8d9b0}}@media(max-width:800px){{.grid,.metrics{{grid-template-columns:1fr}}}}</style></head><body>
<header><div><p>MAINLINE SIMPLE PROFILE ROUTE</p><h1>{record['sku']} · {record['name']}</h1></div><div class="tag">{'AUTO ROUTE ELIGIBLE' if record['autoRouteEligible'] else 'FINE TUNING REQUIRED'}</div></header>
<div class="metrics"><div class="metric"><strong>{record['confidence']:.3f}</strong>confidence</div><div class="metric"><strong>{record['widthMm']} mm</strong>width</div><div class="metric"><strong>{record['depthMm']} mm</strong>depth</div><div class="metric"><strong>{record['rebateMm']} mm</strong>rebate</div></div>
<div class="grid"><figure><img src="{source_rel}"><figcaption>Automatically selected near-front frame: {record['sourceFrame']}</figcaption></figure><figure><img src="{overlay_rel}"><figcaption>Green: detected cut-end silhouette. Amber: inferred transition.</figcaption></figure>
<figure><svg viewBox="0 0 600 310"><rect width="600" height="310" fill="#eee"/><path d="M40 270H560M40 270V40" stroke="#777"/><polyline points="{graph}" fill="none" stroke="#139b42" stroke-width="4"/><text x="40" y="296" fill="#555">inner / rebate</text><text x="478" y="296" fill="#555">outer · {record['widthMm']} mm</text></svg><figcaption>Calibrated four-point simple profile candidate.</figcaption></figure>
<section class="panel"><h2>Review decision</h2><p>Accepting downloads an approval record; it does not alter the Three.js renderer. You can also open the red trace editor and correct this route.</p><div class="actions"><button class="primary" id="accept">Accept auto route</button><a class="button" href="../manual/manual-trace.html">Open red manual trace</a><button id="tune">Queue for fine tuning</button><a class="button" href="{profile_json_rel}" download>Profile JSON</a></div><p id="status"></p></section></div>
<script>const profile={payload};function download(status){{const decision={{sku:profile.sku,status,profile:status==='approved-auto'?profile:null,createdAt:new Date().toISOString()}};const blob=new Blob([JSON.stringify(decision,null,2)],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=profile.sku+'-'+status+'.json';a.click();URL.revokeObjectURL(a.href);try{{localStorage.setItem('mainline-profile-decision:'+profile.sku,JSON.stringify(decision))}}catch{{}}document.querySelector('#status').textContent=status==='approved-auto'?'Auto profile accepted; approval JSON downloaded.':'Queued for later manual fine tuning; queue JSON downloaded.'}}document.querySelector('#accept').onclick=()=>download('approved-auto');document.querySelector('#tune').onclick=()=>download('fine-tuning-requested');</script></body></html>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-root", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--width-mm", type=float, required=True)
    parser.add_argument("--depth-mm", type=float, required=True)
    parser.add_argument("--rebate-mm", type=float, required=True)
    args = parser.parse_args()

    root = Path(args.product_root).resolve()
    manifest = json.loads((root / "spin-manifest.json").read_text())
    frames = [analyse_frame(root / "spin" / item["filename"]) for item in manifest["images"]]
    best_front_score = max(frame["frontScore"] for frame in frames)
    near_front = [(index, frame) for index, frame in enumerate(frames)
                  if frame["frontScore"] >= best_front_score * 0.975]
    # The sequences run side-front-side, so the most centred near-max-width view
    # is less perspective-skewed than simply taking the widest bounding box.
    sequence_midpoint = (len(frames) - 1) / 2
    selected_index, selected = min(near_front, key=lambda item: abs(item[0] - sequence_midpoint))
    candidate = extract_candidate(selected, args.width_mm, args.depth_mm, args.rebate_mm)
    output = root / "profile-analysis" / "simple-auto"
    output.mkdir(parents=True, exist_ok=True)
    overlay_name = f"{manifest['images'][selected_index]['label']}-silhouette-overlay.png"
    write_overlay(selected, candidate, output / overlay_name)

    frame_label = manifest["images"][selected_index]["label"]
    record = {
        "supplier": "Mainline", "sku": manifest["sku"], "name": args.name,
        "productUrl": manifest["productUrl"], "method": "spin-front-two-level-silhouette",
        "sourceFrame": frame_label, "widthMm": args.width_mm, "depthMm": args.depth_mm,
        "rebateMm": args.rebate_mm, "points": candidate["points"],
        "confidence": round(candidate["confidence"], 4),
        "innerEdge": candidate["innerEdge"], "calibration": candidate["pixelCalibration"],
        "scores": {"twoLevelResidualPixels": round(candidate["residualPixels"], 3),
                   "levelSeparationPixels": round(candidate["separationPixels"], 3),
                   "transitionCount": candidate["changeCount"]},
        "autoRouteEligible": candidate["isSimple"] and candidate["confidence"] >= 0.72,
        "status": "awaiting-review", "rendererIntegrated": False,
        "limitations": ["Suitable only for simple two-level profiles", "Uses 157x255 supplier spin imagery", "Requires human approval before renderer integration"],
    }
    (output / "profile-candidate.json").write_text(json.dumps(record, indent=2) + "\n")
    html = review_html(record, f"../../spin/{manifest['images'][selected_index]['filename']}", overlay_name, "profile-candidate.json")
    (output / "profile-review.html").write_text(html)
    print(json.dumps({"sku": record["sku"], "sourceFrame": frame_label, "confidence": record["confidence"],
                      "autoRouteEligible": record["autoRouteEligible"], "points": record["points"],
                      "review": str(output / "profile-review.html")}, indent=2))


if __name__ == "__main__":
    main()
