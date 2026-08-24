#!/usr/bin/env python3
"""Ask a local Ollama vision model for a review-only macro-profile candidate."""

import argparse
import base64
import json
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw


SCHEMA = {
    "type": "object",
    "properties": {
        "innerEdge": {"type": "string", "enum": ["left", "right"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "points": {
            "type": "array", "minItems": 12, "maxItems": 30,
            "items": {
                "type": "object",
                "properties": {
                    "u": {"type": "number", "minimum": 0, "maximum": 1},
                    "z": {"type": "number", "minimum": 0, "maximum": 1},
                    "type": {"type": "string", "enum": ["hard", "smooth"]},
                },
                "required": ["u", "z", "type"],
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["innerEdge", "confidence", "points", "notes"],
}


def prompt(width, depth, rebate):
    return f"""This is the native supplier profile photograph for a picture-frame moulding.

Identify only the MACRO 2D CROSS-SECTION: the physical upper boundary that determines how far the surface rises above the backing plane as one moves across the face. Do not follow ornamental leaves, dots, engraved patterns, highlights, shadows, colour changes, printed dimension lines or text.

Known dimensions:
- total face width = {width} mm
- maximum depth = {depth} mm
- rebate = {rebate} mm

Return 12-30 normalized control points describing large-scale lips, steps, flat sections, concave curves and convex curves. u must increase monotonically from 0 at the inner/artwork edge to 1 at the outer edge. z=0 is the backing/reference plane and z=1 is the maximum {depth} mm height. Include u=0 and u=1 endpoints. Use hard only for a genuine corner/step and smooth for a curve.

If the photograph is ambiguous, lower confidence and describe the ambiguity in notes. Do not pretend decorative relief is macro geometry. Return JSON only."""


def call_ollama(model, image_path, width, depth, rebate):
    request_body = {
        "model": model,
        "stream": False,
        "format": SCHEMA,
        "options": {"temperature": 0, "seed": 4875},
        "messages": [{
            "role": "user", "content": prompt(width, depth, rebate),
            "images": [base64.b64encode(image_path.read_bytes()).decode("ascii")],
        }],
    }
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat",
        data=json.dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        return request_body, json.loads(response.read())


def validate(result):
    points = sorted(result["points"], key=lambda point: point["u"])
    if not 12 <= len(points) <= 30:
        raise ValueError(f"Gemma returned {len(points)} points; expected 12-30")
    for point in points:
        if not 0 <= point["u"] <= 1 or not 0 <= point["z"] <= 1:
            raise ValueError("Gemma returned an out-of-range point")
    if points[0]["u"] > 0.02 or points[-1]["u"] < 0.98:
        raise ValueError("Gemma omitted an endpoint")
    points[0]["u"] = 0.0
    points[-1]["u"] = 1.0
    result["points"] = points
    return result


def overlay(image_path, metadata, candidate, output_path):
    image = Image.open(image_path).convert("RGB")
    calibration = metadata["calibration"]
    x0, x1 = calibration["widthPixelStart"], calibration["widthPixelEnd"]
    top, baseline = calibration["depthPixelTop"], calibration["backingBaselinePixel"]
    points = []
    for point in candidate["normalizedPoints"]:
        x = (x0 + point["u"] * (x1 - x0)) if candidate["innerEdge"] == "left" else (x1 - point["u"] * (x1 - x0))
        y = baseline - point["z"] * (baseline - top)
        points.append((x, y))
    draw = ImageDraw.Draw(image, "RGBA")
    draw.line(points, fill=(35, 145, 255, 255), width=3, joint="curve")
    for x, y in points:
        draw.ellipse((x - 2.5, y - 2.5, x + 2.5, y + 2.5), fill=(215, 240, 255, 255), outline=(10, 80, 160, 255))
    image.save(output_path)


def inspect_html(candidate, deterministic, metadata):
    def graph(points, width, depth):
        return " ".join(f"{35 + u / width * 510:.1f},{275 - z / depth * 220:.1f}" for u, z in points)

    gemma_graph = graph(candidate["points"], candidate["widthMm"], candidate["depthMm"])
    deterministic_graph = graph(deterministic["points"], deterministic["widthMm"], deterministic["depthMm"])
    data = json.dumps({"gemma": candidate, "deterministic": deterministic})
    notes = "".join(f"<li>{note}</li>" for note in candidate["notes"])
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>POL-4875 candidate inspection</title><style>
:root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}*{{box-sizing:border-box}}body{{max-width:1280px;margin:auto;padding:34px}}header{{border-bottom:1px solid #333;padding-bottom:20px}}.eyebrow{{font:12px ui-monospace,monospace;letter-spacing:.16em;color:#d7b36c}}h1{{margin:7px 0}}p,li,figcaption{{color:#aaa;line-height:1.5}}.warning{{border:1px solid #765f31;background:#211c13;padding:13px;color:#dfc386}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}}figure,.panel{{margin:0;background:#1b1b1b;padding:14px}}img,svg{{display:block;width:100%;background:white}}.metric{{display:flex;gap:28px;margin:14px 0}}.metric b{{color:#d7b36c}}.actions{{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}}button,.manual-link{{border:1px solid #555;background:#222;color:#eee;padding:12px 15px;font-weight:650;cursor:pointer;text-decoration:none}}button.gemma{{background:#247fd2;border-color:#247fd2}}.manual-link{{background:#a82424;border-color:#d44}}#status{{color:#a8d9b0;min-height:24px}}@media(max-width:800px){{.grid{{grid-template-columns:1fr}}}}</style></head><body>
<header><div class="eyebrow">HUMAN REVIEW REQUIRED</div><h1>POL-4875 Verona profile candidates</h1><p>Compare deterministic edge extraction with the local Gemma vision proposal. Neither candidate is connected to the renderer.</p></header><p class="warning">Gemma points are an AI interpretation, not measured geometry. Its 0.85 confidence is self-reported and its reasoning still refers to ornamental leaves as peaks. Accept only after visually checking the blue line against the physical substrate boundary.</p>
<div class="grid"><figure><img src="../native/{metadata['profileNativeFilename']}"><figcaption>Native supplier image</figcaption></figure><figure><img src="gemma-profile-overlay.png"><figcaption>Gemma 4 proposal in blue · {len(candidate['points'])} points</figcaption></figure>
<figure><svg viewBox="0 0 580 315"><rect width="580" height="315" fill="#eee"/><path d="M35 275H545M35 275V42" stroke="#777"/><polyline points="{deterministic_graph}" fill="none" stroke="#20a650" stroke-width="3"/><text x="35" y="301" fill="#555">deterministic candidate</text></svg><figcaption>Classical PDF edge-path consensus · confidence {deterministic['confidence']:.3f}</figcaption></figure>
<figure><svg viewBox="0 0 580 315"><rect width="580" height="315" fill="#eee"/><path d="M35 275H545M35 275V42" stroke="#777"/><polyline points="{gemma_graph}" fill="none" stroke="#247fd2" stroke-width="3"/><text x="35" y="301" fill="#555">Gemma candidate</text></svg><figcaption>Local {candidate['model']} · self-reported confidence {candidate['confidence']:.3f}</figcaption></figure></div>
<section class="panel"><div class="metric"><span>Inner edge: <b>{candidate['innerEdge']}</b></span><span>Model: <b>{candidate['model']}</b></span><span>Inference: <b>{candidate['inferenceSeconds']:.1f}s</b></span></div><h2>Gemma notes</h2><ul>{notes or '<li>No notes returned.</li>'}</ul><div class="actions"><button class="gemma" data-choice="accepted-gemma">Accept Gemma candidate</button><button data-choice="accepted-deterministic">Accept deterministic candidate</button><a class="manual-link" href="../manual/manual-trace.html">Open red manual trace</a></div><p id="status"></p></section>
<script>const candidates={data};document.querySelectorAll('[data-choice]').forEach(button=>button.onclick=()=>{{const status=button.dataset.choice;const profile=status==='accepted-gemma'?candidates.gemma:status==='accepted-deterministic'?candidates.deterministic:null;const decision={{sku:'POL-4875',status,profile,createdAt:new Date().toISOString()}};const blob=new Blob([JSON.stringify(decision,null,2)],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='POL-4875-'+status+'.json';a.click();URL.revokeObjectURL(a.href);try{{localStorage.setItem('mainline-profile-decision:POL-4875',JSON.stringify(decision))}}catch{{}}document.querySelector('#status').textContent=status==='fine-tuning-requested'?'Verona left for manual tracing; queue JSON downloaded.':'Candidate accepted; decision JSON downloaded. The renderer remains unchanged.'}});</script></body></html>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--native-metadata", required=True)
    parser.add_argument("--deterministic", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--sku", default="POL-4875")
    parser.add_argument("--width-mm", type=float, default=97)
    parser.add_argument("--depth-mm", type=float, default=49)
    parser.add_argument("--rebate-mm", type=float, default=16)
    args = parser.parse_args()
    image_path = Path(args.image).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    request_body, raw = call_ollama(args.model, image_path, args.width_mm, args.depth_mm, args.rebate_mm)
    (output / "gemma-request.json").write_text(json.dumps({**request_body, "messages": [{"role": "user", "content": request_body["messages"][0]["content"], "images": ["<base64 image omitted>"]}]}, indent=2) + "\n")
    (output / "gemma-raw-response.json").write_text(json.dumps(raw, indent=2) + "\n")
    result = validate(json.loads(raw["message"]["content"]))
    points = [[round(point["u"] * args.width_mm, 3), round(point["z"] * args.depth_mm, 3)] for point in result["points"]]
    candidate = {
        "supplier": "Mainline", "sku": args.sku, "method": "local-vision-model-proposal",
        "model": args.model, "widthMm": args.width_mm, "depthMm": args.depth_mm, "rebateMm": args.rebate_mm,
        "innerEdge": result["innerEdge"], "confidence": result["confidence"], "points": points,
        "normalizedPoints": result["points"], "notes": result["notes"],
        "inferenceSeconds": raw.get("total_duration", 0) / 1_000_000_000,
        "status": "awaiting-human-review", "rendererIntegrated": False,
        "provenance": {"sourceImage": str(image_path), "promptFilename": "gemma-request.json", "rawResponseFilename": "gemma-raw-response.json"},
    }
    (output / "gemma-profile-candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")
    metadata = json.loads(Path(args.native_metadata).read_text())
    deterministic = json.loads(Path(args.deterministic).read_text())
    overlay(image_path, metadata, candidate, output / "gemma-profile-overlay.png")
    (output / "profile-inspect.html").write_text(inspect_html(candidate, deterministic, metadata))
    print(json.dumps({"model": args.model, "confidence": candidate["confidence"], "points": len(points),
                      "inferenceSeconds": round(candidate["inferenceSeconds"], 1), "inspect": str(output / "profile-inspect.html")}, indent=2))


if __name__ == "__main__":
    main()
