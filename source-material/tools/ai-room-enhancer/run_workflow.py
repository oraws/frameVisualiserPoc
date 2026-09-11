"""Submit the approved room-enhancement graph to the local ComfyUI server."""
from __future__ import annotations

import json
import shutil
import sys
import time
import uuid
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[2]
COMFY = ROOT / "tools" / "ai-room-enhancer" / "runtime" / "ComfyUI"
SERVER = "http://127.0.0.1:8188"
workflow = json.loads((ROOT / "tools" / "ai-room-enhancer" / "workflow.json").read_text())
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
            target = ROOT / "public" / "assets" / "rooms" / "sofa-gallery" / "room-ai-enhanced.png"
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
            }
            (target.parent / "ai-enhancement-report.json").write_text(json.dumps(report, indent=2))
            print(f"AI_ROOM_PROGRESS 100 Complete in {report['elapsedSeconds']} seconds", flush=True)
            print(target)
            raise SystemExit(0)
    elapsed = int(time.time() - started)
    print(f"AI_ROOM_PROGRESS {min(90, 10 + elapsed // 6)} Model running", flush=True)
    time.sleep(6)

raise TimeoutError("Local room enhancement exceeded 30 minutes")
