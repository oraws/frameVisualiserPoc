# Realistic art-on-wall mockups: feasibility and product roadmap

**Audience:** Frame Visualiser product and engineering  
**Date:** 31 August 2026  
**Scope:** The next realism stage for selling art and framed art online, using ArtPlacer as the principal benchmark. This assessment covers curated room mockups, customer-room photos, realistic frame integration, lighting, shadows, perspective, occlusion and high-resolution exports. It does not propose replacing the existing frame-detail visualiser.

## Executive answer

Yes—ArtPlacer-level room mockups are achievable, and the current product is unusually well positioned to exceed the framing fidelity of a typical mockup tool.

The recommended solution is **not** to build a completely modelled, real-time 3D room, and it is **not** to ask a generative model to redraw the finished scene for every customer. It is a hybrid:

1. Keep the existing metric Three.js artwork, mount, glazing and moulding as the exact product source.
2. Render that assembly with a transparent background using a camera matched to a real room photograph.
3. Composite it into a calibrated room template containing wall geometry, real-world scale, lighting metadata, wall and foreground masks, and an optional depth map.
4. Generate a room-matched contact/cast shadow and harmonise exposure, white balance, glass reflections and grain.
5. Use computer vision and image models to **prepare and assist** room templates; keep the final sales preview deterministic so the art, frame and dimensions remain trustworthy.

The present Wall mode already proves the product experience. The missing realism is mostly room calibration and compositing, not new moulding geometry.

## What ArtPlacer is actually demonstrating

ArtPlacer advertises more than 2,900 room scenes, to-scale placement, framing, wall-colour editing, static/video exports and Smart Spaces that let artwork appear behind plants or furniture. Its help documentation exposes controls for shadow angle, spread and opacity plus artwork brightness and contrast. Its Personal Spaces workflow asks a user to mark the wall area and enter its height; angled walls are defined by moving four corners to follow perspective lines. [ArtPlacer Room Mockups](https://www.artplacer.com/room-mockups/), [lighting controls](https://help.artplacer.com/support/solutions/articles/65000185151), [Personal Space setup](https://help.artplacer.com/support/solutions/articles/65000185170-how-to-create-a-personal-space), [angled-wall setup](https://help.artplacer.com/support/solutions/articles/65000190665).

ArtPlacer does not publish its renderer architecture. However, the product behaviour is consistent with a calibrated 2D/2.5D compositor:

- a wall plane or quadrilateral defines perspective;
- one real measurement defines scale;
- foreground masks provide occlusion;
- a blurred, directional shadow is composited behind the artwork;
- brightness/contrast controls harmonise inserted content with the room photograph;
- wall masks allow selective recolouring.

That inference is important: its realism does not require reconstructing every sofa, lamp and wall as a live 3D scene. Competitors converge on the same pattern. Smartist describes automatic perspective, dynamic shadows, foreground-object recognition and own-room wall mapping; Canvy emphasises a large library of customisable photographic rooms; Artrooms exposes shadow refinement and artwork rotation. [Smartist product description](https://smartist.app/), [Canvy](https://canvy.com/), [Artrooms](https://artroomsapp.com/).

The competitive moat is therefore a combination of:

- a good room library;
- reliable wall calibration and scale;
- believable integration controls;
- fast, repeatable exports;
- and, in this product's case, accurate representations of real supplier mouldings.

## The current realism gap

The existing implementation in `src/renderer/FramedArtwork.tsx` is a good concept demonstrator, but Wall mode currently:

- displays the room photograph on a flat `MeshBasicMaterial` plane;
- positions and scales the frame using only one fixed position and scale per room;
- uses the same generic warehouse environment map for every room;
- simulates the wall shadow with a fixed translucent dark rectangle offset behind the frame;
- applies wall colour as a wash over the complete photograph rather than a wall-only mask;
- has no camera calibration, wall plane, foreground occlusion, room depth, light probe or reflection layer.

This explains why it reads as an attractive visualisation rather than a photograph. The frame and background do not yet share the same camera or light field.

## Recommended architecture

### 1. Separate Inspect mode from Mockup mode

Keep the existing interactive 3D inspect view. It is valuable for evaluating profile, texture, glazing and moulding joins.

Create a separate `MockupComposer` for sales imagery. It may still use Three.js, but it should be driven by room metadata rather than the free-orbit inspection camera. The same frame geometry and materials feed both modes.

### 2. Introduce an authored room-template format

Each curated room should be an asset bundle with approximately this data:

```json
{
  "id": "warm-living-01",
  "image": "room.jpg",
  "licensedSource": "...",
  "wallPolygon": [[0.18, 0.10], [0.78, 0.13], [0.81, 0.83], [0.16, 0.86]],
  "wallHeightMm": 2440,
  "camera": { "fov": 48, "roll": 0.2 },
  "anchor": { "x": 0.50, "y": 0.43 },
  "wallMask": "wall-mask.png",
  "foregroundMask": "foreground.png",
  "depthMap": "depth.png",
  "light": {
    "direction": [-0.75, 0.28],
    "softness": 0.72,
    "intensity": 0.24,
    "temperatureK": 5200
  },
  "frameExposure": -0.15,
  "reflectionOverlay": "reflection.png"
}
```

For an ordinary flat wall, the four wall corners define a planar homography. OpenCV documents that a homography maps one plane to another and that `warpPerspective` applies the transform. This is enough to place a rectangular artwork correctly on an angled photographic wall. [OpenCV homography tutorial](https://docs.opencv.org/4.10.0/d9/dab/tutorial_homography.html).

The template should be produced in an internal room-authoring screen. A content editor marks four wall corners, enters one physical measurement, paints or accepts masks, chooses the dominant light direction and tunes a reference frame until it matches the photograph. This controlled authoring is more dependable than trying to infer everything perfectly at customer runtime.

### 3. Render and composite in explicit layers

The desired layer stack, back to front, is:

1. original room photograph;
2. wall-only colour/tone adjustment;
3. wall shadow layer using Multiply blending;
4. transparent PBR frame, mount, artwork and glass render;
5. room-specific glass/reflection overlay;
6. foreground/occlusion layer, such as a plant crossing the artwork;
7. final colour match, grain and output transform.

The current opaque photo plane should no longer be responsible for lighting the frame. Instead, render the product to transparent RGBA and composite it over the room. Three.js supports a transparent canvas, transparent shadow-catching material, shadow-map choices, HDR render targets and output colour management. Its physical material also supports clearcoat and independent clearcoat normals, useful for moulding finish and glazing. [Three.js transparent canvas](https://threejs.org/manual/en/tips.html), [ShadowMaterial](https://threejs.org/docs/pages/ShadowMaterial.html), [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html), [MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html), [colour management](https://threejs.org/manual/en/color-management.html).

### 4. Match room lighting without over-solving it

For the first production version, store a small room-specific light rig:

- key-light direction and colour;
- soft/hard classification;
- ambient fill colour and strength;
- shadow opacity, offset and blur;
- frame exposure/contrast compensation.

A rectangular area light is useful for window-like reflections and broad illumination, although Three.js documents that `RectAreaLight` itself does not cast shadows. A directional or spot light can drive the actual shadow catcher while the area light shapes the reflective material. [Three.js RectAreaLight](https://threejs.org/docs/pages/RectAreaLight.html).

For a later quality tier, estimate a room-specific HDR environment map from the photograph. DiffusionLight and NVIDIA's newer LuxDiT demonstrate single-image HDR illumination estimation intended for realistic virtual-object insertion. This could improve black, gold and silver mouldings because their appearance depends strongly on reflected surroundings. It is promising but should be evaluated behind a feature flag: single-image light estimation is still ambiguous, and an incorrect HDR probe can be less convincing than a manually authored light rig. [DiffusionLight, CVPR 2024](https://github.com/DiffusionLight/DiffusionLight), [LuxDiT](https://research.nvidia.com/labs/toronto-ai/LuxDiT/).

### 5. Preserve exact artwork and product identity

The artwork bitmap must remain pixel-identical apart from declared colour-management, perspective and glazing operations. The selected moulding must remain the selected geometry and material. This is essential for buyer trust.

Frontier image models are valuable in three bounded roles:

- creating or cleaning empty room backgrounds;
- generating foreground, wall and object masks;
- producing optional marketing variations after an exact deterministic preview exists.

They should not be the default final compositor. General image editing may alter the artwork, mat width, moulding profile, corners or dimensions. If a managed generative compositor is tested, Adobe's Firefly API is unusually relevant: its Precise Composite operation claims pixel-perfect subject preservation, while Adaptive Composite trades subject fidelity for lighting/shadow harmonisation. That distinction matches this product's need for an “accurate preview” versus an optional “hero mockup.” Both still require benchmark testing against exact inputs before commercial adoption. [Adobe Object Composite guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/object-composite/).

Adobe says non-beta Firefly outputs may be used commercially and describes its training sources as licensed, openly licensed or public-domain content. That makes it a candidate for room-asset ideation, but it does not remove the need to verify current API terms, output rights and costs before launch. [Adobe Firefly FAQ](https://helpx.adobe.com/firefly/web/get-started/learn-the-basics/adobe-firefly-faq.html).

### 6. Add own-room uploads after curated rooms work

The customer uploads a room photograph, marks the wall with four points and supplies one known measurement—normally wall height, skirting-to-ceiling height, or the width of a known object. This should work manually before automation is added.

AI assistance can then reduce the work:

- SAM 2 can propose wall and foreground-object masks from clicks or boxes;
- Depth Anything V2 can propose relative depth to decide which objects should occlude the frame;
- line/vanishing-point detection can suggest wall perspective;
- a vision model can propose light direction and colour temperature;
- the customer confirms all suggestions before rendering.

Meta describes SAM 2 as promptable, fast segmentation for unfamiliar images, while Depth Anything V2 reports stronger fine-detail and robustness than its predecessor. Neither provides the one absolute real-world measurement needed for trustworthy scale, so the calibration question cannot be removed. [Meta SAM 2](https://ai.meta.com/research/sam2/), [Depth Anything V2](https://depth-anything-v2.github.io/).

## Build, buy or combine

| Route | Advantages | Limitations | Recommendation |
|---|---|---|---|
| Embed ArtPlacer or another widget | Fast market validation and a large room library | Weak differentiation; likely cannot use the exact supplier-derived 3D mouldings as the central asset | Useful only as a temporary UX benchmark |
| Full 3D architectural rooms | Physically coherent lighting, camera movement and parallax | High scene-authoring, asset and performance cost; unnecessary for static wall mockups | Reserve for a later premium experience |
| Deterministic 2.5D compositor | Exact art/frame, fast, controllable, scalable room library, works in browser | Requires template authoring and careful colour/shadow work | **Core recommendation** |
| Generative composite API | Rapid photoreal hero images and background variations | Latency, cost, privacy, vendor dependence and possible product drift | Optional export experiment, never sole source of truth |

## Phased delivery plan

The following are engineering estimates, not vendor commitments.

### Phase 1 — realism spike: 1–2 weeks

- Use one existing room photograph and one deliberately angled room.
- Add room-template JSON, a calibrated camera/wall plane and transparent frame render.
- Replace the dark rectangle with a real shadow catcher or alpha-derived soft shadow.
- Add foreground occlusion to one scene.
- Match room exposure and colour temperature.
- Export 2K and 4K stills.
- Compare the result against ArtPlacer/Smartist examples and a real framed reference.

**Decision gate:** the frame must read as belonging to the photograph at normal viewing size, without a generative model touching the artwork or moulding.

### Phase 2 — curated-room product: another 4–8 weeks

- Build the internal room-template editor.
- Author and license 15–30 high-quality room templates across living, dining, bedroom, office and gallery styles.
- Add room filters, safe placement regions, multi-art layouts, crops and saved designs.
- Add reliable high-resolution export and mobile QA.
- Store exact configuration data with every export for repeatability.

This would provide the commercially valuable ArtPlacer-like workflow while retaining the superior frame catalogue.

### Phase 3 — assisted customer rooms: another 4–8 weeks

- Upload/crop/rotate room photos.
- Four-corner wall calibration plus one real measurement.
- SAM-assisted wall and occluder masks with a simple correction brush.
- Depth/perspective/light suggestions with user confirmation.
- Clear privacy controls, retention policy and deletion.

### Phase 4 — premium outputs

- Evaluate LuxDiT/DiffusionLight HDR probes on reflective black, silver and gold frames.
- Evaluate Firefly Precise Composite against the deterministic render; reject any output that fails an automated artwork/frame difference test.
- Consider server-side Blender/Substance rendering only if browser PBR cannot meet the approved benchmark.
- Add AR after the static and own-room workflows are trusted.

## Quality gates

The feature should be evaluated as a sales tool, not only as a renderer.

1. **Product fidelity:** no changed artwork content; correct SKU, visible width, mount width, outer dimensions and aspect ratio.
2. **Geometric fit:** frame edges follow the wall perspective; no floating or intersection at the wall.
3. **Lighting fit:** shadow direction agrees with visible room shadows; softness and density are plausible; metal/black mouldings reflect a compatible environment.
4. **Occlusion:** plants, lamps and furniture cross in front of the frame cleanly where intended.
5. **Colour:** managed sRGB output; no unintentional saturation or contrast changes to the art.
6. **Performance:** interactive placement remains responsive on a mid-range phone; a high-resolution export completes predictably.
7. **Trust:** the UI distinguishes an accurate visualisation from any AI-enhanced marketing image.

A useful benchmark set would contain 8–12 rooms, 6 representative mouldings (flat black, oak, silver, gold, ornate black and the concave Paramount), three glazing options and both light/dark artworks. Reviewers should compare current Wall mode, the new compositor, a competitor mockup and—where available—a real photograph, without being told which is which.

## Recommendation

Proceed with Phase 1 before expanding the room library or adding a general image-generation API. The existing three designer-room images are enough for the spike, but each must be upgraded from “background image plus frame” to a calibrated room asset bundle.

The first implementation target should be:

> **An exact, supplier-derived 3D frame rendered into a calibrated real room photograph, with matched perspective, soft directional shadow, foreground occlusion and high-resolution export.**

If that succeeds, the product gains a compelling combination that the mockup tools do not obviously offer: buyer-facing environmental realism backed by genuine, measurable framing choices.

## Research limits

- ArtPlacer and competitors do not publish their internal rendering code; references to a 2.5D compositor are an inference from their documented workflows and controls.
- Vendor features and model availability were checked on 31 August 2026 and can change.
- Development ranges assume the existing Astro/React/Three.js codebase and current moulding catalogue remain the base.
- Single-image depth and lighting are estimates, not measurements. Manual confirmation remains necessary for sale-critical scale and placement.

