"""Submit the approved room-enhancement graph to the local ComfyUI server."""
from __future__ import annotations

import json
import shutil
import sys
import time
import uuid
from pathlib import Path

import requests
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
COMFY = ROOT / "tools" / "ai-room-enhancer" / "runtime" / "ComfyUI"
SERVER = "http://127.0.0.1:8188"
workflow = json.loads((ROOT / "tools" / "ai-room-enhancer" / "workflow.json").read_text())
room_id = sys.argv[1] if len(sys.argv) > 1 else "sofa-gallery"
room = ROOT / "public" / "assets" / "rooms" / room_id
config_path = room / "enhancement.json"
config = json.loads(config_path.read_text()) if config_path.exists() else {}
input_name = f"{room_id}-empty.jpg"
input_source = ROOT / config["inputImage"] if config.get("inputImage") else room / "room-empty.jpg"
with Image.open(input_source) as prepared:
    prepared = prepared.convert("RGB")
    target_aspect = config.get("inputAspect")
    if target_aspect:
        source_aspect = prepared.width / prepared.height
        if source_aspect < target_aspect:
            target_height = round(prepared.width / target_aspect)
            top = (prepared.height - target_height) // 2
            prepared = prepared.crop((0, top, prepared.width, top + target_height))
        elif source_aspect > target_aspect:
            target_width = round(prepared.height * target_aspect)
            left = (prepared.width - target_width) // 2
            prepared = prepared.crop((left, 0, left + target_width, prepared.height))
    prepared.save(COMFY / "input" / input_name, quality=96)
with Image.open(COMFY / "input" / input_name) as source_image:
    aspect = source_image.width / source_image.height
if aspect >= 1:
    width, height = 1152, round(1152 / aspect / 16) * 16
else:
    height, width = 1152, round(1152 * aspect / 16) * 16
workflow["7"]["inputs"]["image"] = input_name
workflow["8"]["inputs"].update({"width": width, "height": height})
workflow["9"]["inputs"]["prompt"] = config.get("prompt", workflow["9"]["inputs"]["prompt"])
workflow["10"]["inputs"]["prompt"] = config.get("negativePrompt", workflow["10"]["inputs"]["prompt"])
reference_path = config.get("referenceImage")
if reference_path:
    reference_source = ROOT / reference_path
    reference_name = f"{room_id}-style-reference{reference_source.suffix.lower()}"
    shutil.copy2(reference_source, COMFY / "input" / reference_name)
    workflow["15"] = {"class_type": "LoadImage", "inputs": {"image": reference_name}}
    workflow["16"] = {"class_type": "ImageScale", "inputs": {
        "image": ["15", 0], "upscale_method": "lanczos",
        "width": width, "height": height, "crop": "center"
    }}
    workflow["9"]["inputs"]["image2"] = ["16", 0]
    workflow["10"]["inputs"]["image2"] = ["16", 0]
workflow["12"]["inputs"]["seed"] = config.get("seed", workflow["12"]["inputs"]["seed"])
workflow["12"]["inputs"]["denoise"] = config.get("denoise", workflow["12"]["inputs"]["denoise"])
workflow["14"]["inputs"]["filename_prefix"] = f"frame-visualiser/{room_id}-ai"
client_id = str(uuid.uuid4())
started = time.time()

response = requests.post(f"{SERVER}/prompt", json={"prompt": workflow, "client_id": client_id}, timeout=30)
if not response.ok:
    print(response.text, file=sys.stderr)
    response.raise_for_status()
prompt_id = response.json()["prompt_id"]
print(f"AI_ROOM_PROGRESS 5 Submitted {prompt_id}", flush=True)

while time.time() - started < 1800:
    history_response = requests.get(f"{SERVER}/history/{prompt_id}", timeout=30)
    history_response.raise_for_status()
    history = history_response.json().get(prompt_id)
    if history:
        status = history.get("status", {})
        if status.get("status_str") == "error" or not status.get("completed", False):
            messages = status.get("messages", [])
            if any(item and item[0] == "execution_error" for item in messages):
                raise RuntimeError(json.dumps(messages, indent=2))
        outputs = history.get("outputs", {})
        images = outputs.get("14", {}).get("images", [])
        if images:
            image = images[0]
            source = COMFY / "output" / image.get("subfolder", "") / image["filename"]
            target = room / "room-ai-enhanced.png"
            shutil.copy2(source, target)
            report = {
                "promptId": prompt_id,
                "model": workflow["1"]["inputs"]["unet_name"],
                "adapter": workflow["4"]["inputs"]["lora_name"],
                "seed": workflow["12"]["inputs"]["seed"],
                "steps": workflow["12"]["inputs"]["steps"],
                "elapsedSeconds": round(time.time() - started, 2),
                "source": str(source.relative_to(ROOT)),
                "output": str(target.relative_to(ROOT)),
                "prompt": workflow["9"]["inputs"]["prompt"],
                "negativePrompt": workflow["10"]["inputs"]["prompt"],
                "roomId": room_id,
                "denoise": workflow["12"]["inputs"]["denoise"],
                "referenceImage": reference_path,
                "inputImage": config.get("inputImage"),
            }
            (target.parent / "ai-enhancement-report.json").write_text(json.dumps(report, indent=2))
            print(f"AI_ROOM_PROGRESS 100 Complete in {report['elapsedSeconds']} seconds", flush=True)
            print(target)
            raise SystemExit(0)
    elapsed = int(time.time() - started)
    print(f"AI_ROOM_PROGRESS {min(90, 10 + elapsed // 6)} Model running", flush=True)
    time.sleep(6)

raise TimeoutError("Local room enhancement exceeded 30 minutes")
