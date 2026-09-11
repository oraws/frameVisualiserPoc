# Local AI room enhancement

This pipeline refines a fixed, empty Blender room into an approved photographic
background. The browser continues to render the exact artwork, mount, moulding,
glazing and shadows from the retained camera and light metadata.

The source package contains a beauty image, depth map, normal map, wall mask,
structure mask and the original scene metadata. The editable image model is run
only while preparing a room template; it is never in the interactive frame path.

The preferred runtime is ComfyUI with Qwen-Image-Edit FP8 and the four-step
Lightning LoRA. Runtime files and model weights live under `runtime/` and are
excluded from Git.

Export the structural package:

```sh
/private/tmp/frame-room-blender/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python tools/ai-room-enhancer/export_room_guides.py -- sofa-gallery
```

The approved output belongs at
`public/assets/rooms/sofa-gallery/room-ai-enhanced.png`. It must retain the
source dimensions and fixed composition before it is offered in the viewer.

Run ComfyUI on Apple Silicon (GPU access is required):

```sh
cd tools/ai-room-enhancer/runtime/ComfyUI
../../../../.venv-comfy/bin/python main.py --listen 127.0.0.1 --port 8188 \
  --disable-auto-launch --preview-method none
```

Then submit the four-step room workflow:

```sh
.venv-comfy/bin/python tools/ai-room-enhancer/run_workflow.py
```

Validate the fixed composition and clear hanging area before exposing it in the
visualiser:

```sh
.venv-comfy/bin/python tools/ai-room-enhancer/validate_output.py
```
