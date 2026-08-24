# Technology review: accurate moulding-profile extraction

Date: 24 August 2026  
Scope: research and recommendations only; the existing renderer and extraction tools were not changed.

## Executive conclusion

The reliable way to automate this is **not a stronger image-to-3D generator**. The required output is a dimensionally trustworthy 2D cross-section, while most frontier image and image-to-3D models are designed to create a visually plausible object. Those objectives diverge precisely at the small rebates, steps, beads and concavities that matter here.

The best practical architecture is a two-lane pipeline:

1. **Measured lane (preferred):** obtain a short physical offcut and capture its cut end square-on with a flatbed scanner or a backlit, calibrated camera. Segment the resulting high-contrast silhouette, vectorise it, scale it from a calibration target, and ask the user only to approve or correct the result.
2. **Supplier-image lane (fallback):** use a promptable segmentation model to propose the moulding region, then use edge-snapping “intelligent scissors” between a handful of user anchors. Validate against the stated face width/depth and against several spin frames. Mark results as approximate when the source lacks sufficient pixels.

For Verona there is a second, separate problem: its repeating floral and bead decoration varies **along the length** of the moulding. A cross-section extrusion can reproduce the gross profile but cannot reproduce that longitudinal relief. That should be captured independently as a rectified colour texture plus a normal/displacement map, ideally using controlled-light photometric stereo. Profile geometry and surface ornament should therefore be separate assets.

## Why the current inputs hit a hard limit

The imported Mainline manifests contain 45 frames, but POL-4100 frames are only **157 × 255 px** and Verona frames are **279 × 255 px**. Even if the stated face width occupied the entire image width, the theoretical sampling would be only about **0.26 mm/px** for POL-4100 (41/157) and **0.35 mm/px** for Verona (97/279). The physical end face occupies fewer pixels than that, and JPEG compression, blur, shadow and perspective further weaken the true boundary.

This means no algorithm can recover sub-pixel rebates and ornate transitions that were never recorded. AI upscaling can make the image easier to inspect, but it cannot turn an uncertain edge into measured geometry. I also checked likely `Lv1` and `Lv3` variants of the Mainline S3 path: both returned 403, while the known `Lv2` image returned 200, so no public higher-resolution tier was found by that naming convention.

## Technology comparison

| Option | Metric fidelity | Works with current spins? | Human effort | Verdict |
|---|---:|---:|---:|---|
| Supplier CAD/DXF/profile drawing | Excellent, if authoritative | N/A | Very low | First thing to request |
| Flatbed scan of a square-cut offcut | Excellent | Requires sample | Low | Best low-cost solution |
| Backlit camera + scale/fiducial | Very good to excellent | Requires sample | Low | Best scalable capture station |
| Telecentric machine-vision capture | Metrology grade | Requires sample | Low | Best production setup; higher cost |
| Laser line profiler / metrology scanner | Metrology grade | Requires sample | Low after setup | Accurate but excessive for the POC |
| SAM-style mask + intelligent scissors | Moderate; source-limited | Yes | Low to moderate | Best supplier-only workflow |
| Multi-view photogrammetry / neural surface reconstruction | Potentially good with new capture | Poor on current spins | Moderate/high | Useful only after controlled recapture |
| Shape from silhouettes / visual hull | Captures visible envelope only | Possibly | Moderate | Misses invisible concavities |
| Monocular depth/normal estimation | Relative/plausible | Yes | Low | Not suitable for dimensions |
| Frontier VLM polygon output | Semantic proposal, not metrology | Yes | Low | Helper or second opinion only |
| TRELLIS / Stable Fast 3D / img2threejs | Visually plausible asset | Yes | Low/moderate | Wrong tool for SKU-accurate geometry |

### 1. Promptable segmentation plus edge snapping

[Meta’s SAM 2](https://github.com/facebookresearch/sam2) can create and iteratively refine masks from clicks, boxes and prior masks. This is useful for identifying “moulding substrate” despite distracting texture and shadows. It should propose a mask, not own the final coordinates.

The strongest UI improvement is to replace freehand drawing with a **few anchor clicks** and calculate the minimum-cost boundary between them. OpenCV provides an implementation of the classic [Intelligent Scissors](https://docs.opencv.org/4.13.0/javadoc/org/opencv/imgproc/IntelligentScissorsMB.html) approach; Photoshop describes the equivalent Magnetic Lasso as a selection that [snaps to image edges while dragging](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/selection-tools-overview.html). For difficult sections, a geodesic active contour can refine the proposal; scikit-image’s [segmentation module](https://scikit-image.org/docs/stable/api/skimage.segmentation) includes active-contour, MorphGAC, random-walker and watershed methods.

Recommended sequence:

1. User clicks inside the substrate and outside in two or three places.
2. SAM 2 proposes one or more masks.
3. The boundary is refined against a denoised gradient image.
4. The user places anchors at the inner lip, rebates, sharp corners and outer edge.
5. Intelligent scissors snaps each segment to the strongest continuous physical boundary.
6. Known face width and profile depth calibrate x/y independently; perspective is corrected before scaling.
7. Straight sections are line-fitted, curves are spline-fitted, and the maximum fitting error remains visible.

This would feel much closer to Photoshop’s selection workflow than the current brush. It also makes correction local: move one anchor or choose the next-best path instead of redrawing the profile.

After segmentation, OpenCV’s [Canny detector](https://docs.opencv.org/5.0/tutorials/imgproc/imgtrans/canny_detector/canny_detector.html) and contour extraction can produce a pixel boundary. A tracer such as [Potrace](https://potrace.sourceforge.net/) can convert a bitmap boundary into smooth vectors, but vectorisation does not repair a wrong mask; Potrace’s own paper notes that no tracing algorithm can always determine the uniquely intended outline from a bitmap.

### 2. Better acquisition: the largest accuracy gain

A square-cut end of an extruded moulding already *is* the desired cross-section. Capturing that end removes the need to infer 3D shape from shading.

Low-cost version:

- Cut or obtain a 20–40 mm offcut with a clean, square end.
- Put the cut face directly on a flatbed scanner with a matte contrasting surround and a small certified scale or gauge in the same plane.
- Scan losslessly at 600–1200 dpi; store the raw image and calibration.
- Threshold the silhouette, retain holes/rebates, fit vectors under a declared maximum error, and render a measured-grid overlay for approval.

An ordinary consumer scanner can already oversample the required accuracy: for example, Epson specifies 4,800 dpi optical resolution for the [Perfection V39](https://www.epson.co.uk/en_GB/products/scanners/consumer/perfection-v39/p/14157). The practical accuracy must still be verified with a gauge because optical resolution is not the same as dimensional accuracy.

Production version:

- Fixed camera and fixed working distance.
- Diffuse or telecentric backlight for a high-contrast silhouette.
- Object-space telecentric lens if tight tolerances are required.
- Calibration plate/scale in the profile plane and periodic verification.

Telecentric optics keep magnification nearly constant as object distance changes and reduce perspective/parallax; paired backlighting improves edge contrast. Edmund Optics describes these properties specifically for [metrology and dimensional measurement](https://www.edmundoptics.com/knowledge-center/industry-expertise/imaging-assemblies/metrology-and-3d-measurements/) and shows why [telecentric illumination sharpens silhouettes](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/telecentric-illumination-why-you-need-it-in-machine-vision-applications/).

If the project eventually needs certified reverse engineering, laser profilers and metrology scanners are available. KEYENCE describes laser-line profilers as direct 2D profile measurement devices with micrometre-range capabilities in some configurations ([technology overview](https://www.keyence.com/products/measure/laser-2d/)); Artec advertises 0.02 mm accuracy for its [Point II metrology scanner](https://www.artec3d.com/portable-3d-scanners/laser-point). These are strong technical fits but economically disproportionate unless many thousands of mouldings will be captured or formal tolerances are required.

### 3. Multi-view reconstruction, NeRFs and Gaussian methods

Classical photogrammetry can reconstruct measured surfaces when the capture is controlled. [COLMAP’s guidance](https://colmap.github.io/tutorial) calls for overlapping, well-textured images from different viewpoints with stable illumination, and warns against specular surfaces. Apple’s [Object Capture](https://developer.apple.com/documentation/realitykit/realitykit-object-capture) similarly expects many well-lit, overlapping views.

The current Mainline spins are a poor input for this family: they are tiny, dark, glossy, have limited end-profile pixels, and were made for visual rotation rather than calibrated reconstruction. Camera intrinsics, turntable angle and a scale reference are absent. Neural surface methods such as [Neuralangelo](https://openaccess.thecvf.com/content/CVPR2023/html/Li_Neuralangelo_High-Fidelity_Neural_Surface_Reconstruction_CVPR_2023_paper.html) can recover detailed surfaces from multi-view imagery, but they do not remove the capture requirements or create metric scale by themselves.

Shape-from-silhouette could combine masks across views, but a visual hull cannot recover concavities that never affect an outline—the central limitation identified in Laurentini’s [visual-hull work](https://doi.org/10.1109/34.273735). For an ornate moulding, those hidden or weakly visible recesses are important.

Verdict: only revisit this route if Mainline can provide original high-resolution, calibrated 360° images or if we create our own turntable capture. Even then, scanning the cut end is simpler for the cross-section.

### 4. Monocular depth, normals and frontier image models

Modern monocular models such as [Depth Anything V2](https://arxiv.org/abs/2406.09414) produce strong relative depth and offer metric-depth variants. They remain learned estimates from a single view, so small dark-on-dark moulding steps and absolute scale are not observations. They could help separate broad raised and recessed regions, but should not generate the accepted profile.

Frontier multimodal models can help semantically. Google documents direct polygon-mask output for [Gemini image segmentation](https://ai.google.dev/gemini-api/docs/image-understanding), and a model could be asked to distinguish substrate, shadow, background and ornament. The right role is to propose candidate masks, flag suspicious areas, select the most profile-like spin frame, or compare two deterministic contours. It should not emit the final engineering coordinates. This conclusion is also consistent with the local Gemma experiment: the result was visually interpretable but spatially inaccurate.

### 5. Generative image-to-3D systems

[TRELLIS](https://github.com/microsoft/TRELLIS) and [Stable Fast 3D](https://stability.ai/s/SF3D-10.pdf) generate 3D assets from image prompts. They are valuable for fast content creation, but their training objective rewards plausible asset generation rather than dimensional agreement with an unseen cross-section.

The same limitation applies to [img2threejs](https://github.com/img2threejs/img2threejs). It reconstructs a reference as procedural Three.js code and explicitly describes itself as reconstruction-by-code rather than photogrammetry or mesh extraction; its documentation also acknowledges that one image cannot guarantee exact hidden geometry. It is interesting for editable visual prototypes, but not as the source of truth for moulding dimensions.

## Treat profile and ornament as different assets

For simple POL-4100, the measured cross-section plus a brushed colour/roughness texture may be enough. For Verona, a faithful asset needs at least:

- **Profile curve:** the constant 97 × 49 mm section, captured from a square-cut end.
- **Colour/roughness strip:** rectified photography of the face along the moulding.
- **Relief:** a normal or displacement map for beads, floral carving and grooves that repeat along its length.

Controlled-light photometric stereo estimates surface normals from several photographs taken from the same viewpoint under different lighting. Research demonstrates that varying illumination can improve surface reconstruction over single-image shape-from-shading ([photometric-stereo study](https://opg.optica.org/josaa/abstract.cfm?uri=josaa-10-5-855)). This is a better match for Verona’s shallow ornament than asking a VLM to invent relief. Glossy black finishes remain challenging, so cross-polarised lights/camera and a matte developer spray on a sacrificial sample may be required for capture.

## Recommended product workflow

1. **Asset intake:** request manufacturer profile PDF/DXF/CAD first; record provenance and stated dimensions.
2. **Quality gate:** score source resolution, end-view angle, blur, occlusion and scale evidence. Automatically refuse “verified” status when the image cannot support the target tolerance.
3. **Auto proposal:** SAM 2 mask plus classical denoising/edges; optionally compare a frontier-model mask as a second opinion.
4. **Anchor review:** show 6–15 suggested anchors at corners and curvature changes. The user drags anchors; magnetic paths update live.
5. **Constraint fit:** enforce overall face/depth dimensions, preserve rebates, line-fit flats, spline-fit curves and show residual error.
6. **Approval choice:** `Accept measured`, `Accept approximate`, or `Needs better source/manual work`—not a single pass/fail coverage percentage.
7. **Separate surface capture:** create colour, roughness and relief assets where the moulding has longitudinal ornament.
8. **Audit:** save source hashes, calibration, mask, anchors, vector, fit error, reviewer and status in the manifest.

## The next experiment I recommend

Do not spend the next iteration testing another generative model. Run one acquisition experiment on POL-4100:

1. Obtain a short offcut.
2. Make a lossless 1200 dpi flatbed scan of the square-cut end with a steel rule or calibration target in the same plane.
3. Automatically threshold and vectorise the silhouette.
4. Compare face width, depth and two or three caliper measurements against the derived vector.
5. Set a concrete acceptance target—initially **≤0.25 mm maximum boundary error** and correct topology for the rebate/steps.

If that passes, repeat with Verona for its gross section, then run a separate controlled-light capture for its ornament. If no sample can be obtained, the best next software experiment is the SAM-plus-intelligent-scissors editor; it will be substantially easier than freehand tracing, but its output should remain labelled approximate because the supplier pixels cannot support metrology-grade claims.

## Decision

**Recommended now:** build a source-quality gate and anchored edge-snapping review workflow, while establishing an offcut scanning process as the authoritative lane.  
**Explore later:** controlled-light normal/displacement capture for ornate faces; calibrated multi-view reconstruction only if new high-resolution capture becomes available.  
**Do not use as source of truth:** Gemma/frontier VLM coordinates, monocular depth, TRELLIS/Stable Fast 3D, img2threejs, or any other single-image generative 3D output.
