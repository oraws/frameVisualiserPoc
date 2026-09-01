# Stock-room calibration pilot

This tool tests a real-photograph room workflow without claiming that a single
JPEG contains exact Blender scene data.

1. VGGT predicts monocular intrinsics and depth.
2. RANSAC fits a wall hypothesis inside a declared wall ROI.
3. The browser diagnostic overlays an editable four-corner perspective grid.
4. The calibration remains ineligible for the renderer until a reviewer exports
   an approved JSON file.
5. Lighting currently records observable LDR cues only. It is not labelled HDR
   and is not permitted to drive the renderer as an environment map.

Run the geometry draft:

```bash
.venv-sam2/bin/python tools/room-calibrator/analyse_room.py \
  --image source-material/rooms/stock-pilot/room.jpg \
  --output public/assets/rooms/stock-pilot/calibration
```

Then open `/room-calibrator/` through the Astro development server.

The ordinary VGGT research checkpoint is not suitable for commercial
deployment. A successful workflow must be repeated with an appropriately
licensed model or commercial VGGT checkpoint.
