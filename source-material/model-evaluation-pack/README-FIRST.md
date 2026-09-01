# Frame moulding reconstruction: external model evaluation pack

## Executive summary

We are building a commercial frame visualiser in Astro, React and Three.js. A user chooses artwork, mount and a supplier moulding, and the application renders the assembled frame both in a close inspection view and on a photographic designer wall.

Flat, square-edged mouldings now render convincingly. The unresolved problem is the **automatic reconstruction of complex physical moulding cross-sections from supplier assets alone**. We cannot require a gallery to obtain, scan or photograph every moulding. A scalable solution must work from the existing Mainline product photographs, dimensions and rotation sequences.

The supplier assets are not 3D scans. Each product normally has 45 low-resolution JPEGs showing a short moulding sample rotating against a white background. Typical images are only about 255 pixels high. Camera calibration, pose, focal length, turntable angle and lighting are not supplied.

The objective of this evaluation is to determine whether a leading multimodal/frontier model, a specialised vision pipeline, or a hybrid can recover a sufficiently accurate cross-section and material description for a customer-facing render.

## What the renderer needs

The moulding is assumed to have a constant cross-section along its length. The current renderer sweeps an ordered two-dimensional profile around the artwork opening and creates four mitred sides.

The geometry contract is an ordered list of points:

```json
{
  "sku": "POL-4875",
  "widthMm": 97,
  "depthMm": 49,
  "profilePoints": [
    [0.0, 12.0],
    [5.0, 18.0],
    [97.0, 10.0]
  ]
}
```

- `u` is distance in millimetres across the visible face, from the inner/sight edge (`0`) to the outer edge (`widthMm`).
- `z` is height/depth in millimetres away from the backing plane.
- The list must describe the **physical upper boundary of the substrate**, not a decorative pattern, highlight, cast shadow or background boundary.
- Compound products also need material-band ranges, for example a concave silver band from `u=0` to `u=9.5`, followed by black material.
- Small surface grain belongs in colour/roughness/normal or bump maps. Large coves, beads, steps and ridges belong in geometry.

The exact geometry implementation is supplied in `metadata/profileGeometry.ts`; existing profile candidates are in `metadata/current-renderer-profiles.ts`.

## Test cases

| SKU | Product | Supplier dimensions | Role in this pack | Current result |
|---|---|---:|---|---|
| POL-4100 | Brushed Black | 41 mm wide, about 13 mm profile depth | Simple control | Good after a manually calibrated, square-edged profile and supplier-derived texture |
| POL-4418 | Flat Bronze | 54 mm wide | Flat control | Good |
| POL-4211 | Flat Oak | 54 mm wide | Flat control | Good |
| POL-4508 | Paramount Black & Silver | 30 × 30 mm | Medium/compound challenge | Required repeated manual fixes: the silver is an integrated concave section, not a floating line or convex bead |
| POL-4875 | Verona Black | 97 × 49 mm | Hard ornate challenge | No automated profile has been accurate enough; texture can look detailed while the physical silhouette remains wrong |

The real photograph `reference-images/real-world/PXL_20260824_215732483.jpg` is a related 4417-family moulding, not POL-4100 itself. It was useful because it revealed that the family is square edged with directional lined/ridged texture; our earlier render had incorrectly rounded it.

The photographs `18310.jpg`, `18311.jpg` and `18312.jpg` show the real construction relevant to POL-4508: the silver sight-edge section is broad, attached and concave. It must meet the black frame and mount without a floating gap or an over-strong black shadow line.

## Work already attempted

### 1. Flat box geometry

The first POC built each rail as a flat or lightly bevelled slab. Dimensions were correct but ornate products such as Verona became smooth, shiny black rectangles. Surface photography cannot compensate for missing macro geometry.

### 2. Supplier spin importer

We built a Playwright importer that reads every `<img>` inside the supplier `.basicRotate` element, preserves sequence, downloads the assets and writes a manifest. The Mainline sequences contain 45 frames and appear to cover approximately 360 degrees.

This solved asset acquisition but not reconstruction. The object rotates in perspective, the crop changes, the sample occludes itself, and the white/background boundary is not always the desired cross-section boundary.

### 3. Classical silhouette and edge extraction

We tried thresholding, colour-space gradients, Canny/Sobel-style edges, local contrast, region consistency and multi-frame candidate voting. These methods often lock onto:

- cast shadows;
- the white plinth/background;
- ornamental grooves printed or embossed on the face;
- internal highlights;
- the long edge of the sample rather than its end cross-section;
- different physical boundaries in adjacent views.

The result can look plausible as a red polyline while being physically wrong.

### 4. Supplier PDF/spec-sheet tracing

Verona's spec sheet contains detailed imagery, but the visible decorative silhouette is not a clean orthographic engineering section. Automated tracing followed ornament and shadow. A manually estimated trace was also not reliable enough.

### 5. Vision-language model extraction (Gemma)

A local Gemma experiment was asked to interpret the profile. Its overlay is included. It provided a plausible sparse description rather than a metrically reliable boundary. Like a human viewing one ambiguous image, it could name “scoop”, “bead” or “ridge” while placing the geometry incorrectly.

### 6. Manual mask/line editor

We built a Photoshop-like red brush, line and eraser tool with a calibrated preview. It was difficult to trace accurately because the source image itself does not expose a clean boundary. Width-coverage checks also encouraged following the crop rather than the actual substrate. Manual tracing is not viable at catalogue scale.

### 7. Multi-frame material reconstruction

Fusing several supplier views into base-colour, roughness and bump maps materially improved flat mouldings. It also made Verona look more ornate, but this can be deceptive: ornament projected onto an incorrect profile is still incorrect geometry.

### 8. Photo-calibrated manual correction

Real photographs allowed us to correct POL-4100-family edge squareness and POL-4508's silver/black construction. These are useful validation examples, but relying on bespoke photos would prevent a scalable supplier-only product.

### 9. SAM 2.1 benchmark

We ran `facebook/sam2.1-hiera-base-plus` on three near-section views, using automatically generated classical masks as prompts and guardrails.

- POL-4508 cross-view P95 disagreement improved from **3.253 mm** (classical) to **1.682 mm** (SAM 2.1).
- POL-4875 improved from **5.476 mm** to **3.364 mm**.

This is improved segmentation consistency, not proof of physical correctness. The prompt is derived from the same imperfect classical estimate; SAM segments visible regions but does not solve pose, camera calibration, self-occlusion or inverse 3D. The current visualiser contains a `Current / SAM 2.1` switch for these two SKUs. Matched captures are in `reference-images/current-comparison/`.

## Core failure modes that remain

1. **Segmentation is not cross-section recovery.** A good object mask can still yield the wrong physical profile.
2. **Unknown camera and object pose.** Pixel distances cannot safely be converted to millimetres without estimating pose, projection and scale for each frame.
3. **Self-occlusion.** A rotation image often shows the top face, side face and cut end simultaneously; the desired boundary is partly hidden.
4. **Texture/geometry ambiguity.** Black ornate surfaces contain highlights and grooves that resemble shape boundaries.
5. **Low resolution.** A 97 mm ornate face may occupy only about 279 pixels across the source crop; fine features are close to the sampling limit.
6. **Material-band ambiguity.** POL-4508's silver cove was initially treated as a separate floating strip rather than an integrated concave section.
7. **No reliable ground truth.** We have product dimensions and a few real photographs, but no CAD section for most SKUs.
8. **Plausibility is insufficient.** The intended user will compare the render with the supplier product. A smooth but believable invented profile is still a failure.
9. **Scalability.** Any method requiring manual tracing, per-SKU prompt placement or bespoke photography is unsuitable for the commercial goal.

## What a successful automated system should do

The system should be supplier-only and batchable. A strong proposal will probably separate acquisition, pose estimation, geometry inference, material inference and validation rather than ask one vision-language model to emit a polyline from a single image.

Minimum expected stages:

1. Detect the sample, cut end, long axis and candidate physical faces in all 45 frames.
2. Estimate per-frame turntable angle, camera projection and a common metric scale using known face width/depth.
3. Select or weight views that actually constrain the section.
4. Recover a cross-view-consistent profile, ideally by differentiable inverse rendering, analysis-by-synthesis, silhouette visual hull, constrained optimisation, or an equivalent calibrated method.
5. Enforce manufacturing priors: one constant extrusion, ordered non-self-intersecting profile, known envelope, plausible rebate and limited complexity.
6. Separate material bands from geometry and distinguish macro form from microtexture.
7. Re-render the candidate into the observed cameras and report silhouette/reprojection residuals for every useful frame.
8. Detect uncertainty and route only genuinely ambiguous products to manual review.

## Acceptance criteria

An output should not be accepted merely because it resembles one source image. It should:

- respect the supplier's millimetre envelope;
- explain multiple rotation frames with one cross-section;
- preserve concave versus convex form;
- locate steps, coves, beads and material transitions correctly;
- avoid gaps between joined materials;
- reproduce side/profile silhouettes from held-out frames;
- expose uncertainty and failure cases;
- produce deterministic JSON that the Three.js sweep can consume;
- operate without hand tracing or new photography for routine products.

Suggested quantitative checks include held-out silhouette IoU, symmetric boundary distance in millimetres, cross-view profile variance, envelope error, material-boundary error and render-to-reference perceptual comparison. Metrics should be accompanied by overlays because a single aggregate can hide a wrong boundary.

## Evidence map

- `reference-images/supplier/POL-4508/`: all 45 supplier rotation frames for the compound challenge.
- `reference-images/supplier/POL-4875/`: all 45 frames for the ornate challenge.
- `reference-images/supplier/POL-4100/`, `POL-4418/`, `POL-4211/`: five evenly spaced views for simpler controls.
- `reference-images/real-world/`: user photographs that reveal the actual construction and texture.
- `reference-images/current-comparison/`: current tuned versus SAM-derived live renderer captures.
- `reference-images/historical-renders/`: earlier visible failures that motivated the work.
- `reference-images/diagnostics/`: classical, Gemma and SAM outputs plus profile plots.
- `metadata/*-spin-manifest.json`: source URLs, sequence order and image dimensions.
- `metadata/*-SAM2-benchmark.json`: full prompts, masks, candidate metrics and recovered points.
- `documents/Verona_Spec_Sheet.pdf`: supplier Verona reference sheet.

## Requested external finding

Please determine whether an automated supplier-only route is technically credible, and identify the most promising architecture and model/tool choices available now. Do not answer with a generic “use photogrammetry” recommendation: the asset limitations above are fixed. Compare at least:

- calibrated multi-view silhouette/profile optimisation;
- differentiable rendering or analysis-by-synthesis;
- neural inverse rendering / sparse-view reconstruction;
- depth/normal foundation models used as priors rather than unquestioned ground truth;
- frontier multimodal models for semantic decomposition and quality control;
- specialised CAD/profile reconstruction or vectorisation models;
- a hybrid pipeline with automatic confidence-based review.

State what can be tested immediately on the supplied images, what additional metadata could be recovered from the sequence, what accuracy is realistically achievable, and what would constitute a go/no-go result for the commercial POC.

Do not modify the visualiser. Return findings, proposed experiments and—if possible—machine-readable profile candidates for POL-4508 and POL-4875. Clearly distinguish measured evidence from inference.

