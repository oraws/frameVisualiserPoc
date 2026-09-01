# VGGT profile pilot

Research-only camera calibration, projective profile rectification and held-out
re-render experiment. It is isolated from the Three.js renderer.

The ordinary `facebook/VGGT-1B` checkpoint used by the feasibility run is not
licensed for commercial deployment. A successful experiment must be repeated
with the gated `VGGT-1B-Commercial` checkpoint before production use.

```bash
PYTHONPATH=.model-cache/vggt-source \
  .venv-sam2/bin/python tools/vggt-profile-pilot/camera_probe.py \
  --product-root source-material/mainline/POL-4100

.venv-sam2/bin/python tools/vggt-profile-pilot/fit_profile.py
```

Outputs are written to
`source-material/mainline/<SKU>/profile-analysis/vggt-profile-pilot/` and have
`rendererIntegrated: false`.

## What the pilot tests

1. VGGT estimates a common camera system for 11 supplier spin frames.
2. Existing automatic cut-face masks from frames 22–24 identify section pixels.
3. A robust cut plane is fitted in VGGT world space.
4. Image rays are intersected with that plane. Raw monocular depth is not used
   as the final contour because it visibly curved the flat control.
5. Each adjacent view is withheld in turn and predicted from the other two.
6. The frame-23 cut polygon is extruded and re-rendered into eight unused views.

## Current result

- POL-4100 control: pass; 0.627 mm worst held-out P95 profile error, 0.969 mm
  measured relief, and 0.721 median held-out silhouette IoU.
- POL-4508 complex section: fail; 12.409 mm worst held-out P95 profile error and
  0.351 median held-out silhouette IoU.

The result supports automatic treatment of simple flat sections, but does not
support automatic promotion of complex sections from these supplier assets.
The visualiser remains unchanged.
