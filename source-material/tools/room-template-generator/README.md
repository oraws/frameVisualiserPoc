# Daylight Gallery room template

Select **View on wall → Room → 3D · Daylight Gallery**, or open
`/?mode=wall&room=generated-gallery` in the existing app.

This is an additive fixed-view pilot. Photographic rooms retain their existing
calibration, overlay shadows, lighting controls and materials. The new room uses:

- An original Blender/Cycles scene with scripted geometry and procedural materials.
- An 1800 × 1400 empty-room JPEG, rendered with AgX.
- A scene-linear EXR captured at the product location for room reflections/fill.
- The exact authored camera and scale, with contain/cover matching.
- A live Three.js frame, mount, lit artwork and full-opening glazing.
- A wall plane receiving live geometry shadows, without an SVG gobo.
- Rendering on demand; furniture geometry is not downloaded to the browser.

`public/assets/rooms/generated-gallery/scene.json` holds the shared camera, light,
frame location and palette. The generator is the source of the room layout;
its saved `daylight-gallery.blend` can also be opened in Blender for refinement.
All room geometry and materials are original scripted assets; no third-party
room photographs or model licences are involved. Existing artwork/moulding
assets retain their original provenance.

## Regeneration

With Blender 4.5 available, run from the project root:

```sh
blender --background --factory-startup --python tools/room-template-generator/generate.py
node tools/test-generated-room.mjs
npm run build
```

The generator writes the JPEG, EXR and camera-projection references beside the
scene JSON. It also saves the editable `.blend` and an environment preview here.
Blender creates/revises templates and produces on-demand high-res exports. Interactive frame changes stay in the browser.

## Practical limits

The browser preview approximates Cycles' area lighting with an area light plus
a directional shadow map; it is not an identical path-traced final render.
Its room environment is captured at one point, so large changes of placement
do not produce position-dependent reflection captures. No free camera movement,
animation or customer-facing chat editor is added in this pilot. High-resolution still export is described below.
Chat refinements can update the generator and shared template, then regenerate.

The default artwork/frame remain supplier-derived approximations. This pilot
does not establish colourimetric accuracy or a measured performance guarantee.
The camera tests compare actual Blender-projected landmarks against Three.js,
including wide and portrait viewports; the EXR is decoded using the runtime loader.

## Sales-view lighting refinement

Source colours is the default for live artwork and bypasses room illumination and cinematic tone compression. Room lighting is available as an alternative. Glazing uses a much lighter
reflection layer to avoid a uniform white veil. The generated-room wall uses a
local Gaussian PCF filter, with its radius derived from window size and frame
depth. This keeps the geometry silhouette while feathering the cast shadow.
Photographic-room materials and shadow filters are unchanged.

## Linen Sofa Gallery and high-resolution renders

The additive **3D · Linen Sofa Gallery** option uses an angled camera, original
upholstered sofa/cushion geometry and folded curtain geometry. Rebuild after
creating the Daylight Gallery shell:

```sh
blender --background --factory-startup --python tools/room-template-generator/generate_sofa.py
```

The linen normal texture is **rough_linen**, Poly Haven, CC0:
https://polyhaven.com/a/rough_linen
Downloaded from the official asset endpoint; no room photograph or purchased
furniture model is included. All other room geometry/materials are authored here.

Both generated rooms now offer **Render high-res**. The local Vite middleware
exports the currently configured Three.js product as an embedded GLB, loads it
in the saved room `.blend`, and renders a 3200-pixel-long-edge PNG with Cycles.
It preserves product geometry, placement, maps, mount and glazing. The browser
continues to use the lightweight image/EXR preview. The export always uses the
full room composition, even when the preview is set to Fill stage.

The service uses `FRAME_RENDER_BLENDER`, `/Applications/Blender.app`, the retained runtime in `~/Library/Application Support/Frame Visualiser`,
or the local prototype runtime if mounted. Restart the dev server after changing its setup.
Run `npm run dev -- --host 127.0.0.1 --port 4321`. Rendering is local-only and
accepts one job at a time. It does not work on a static hosted deployment; a
server rendering service would be needed there. Embedded uploads/intermediate
images are discarded after completion; finished PNGs and logs remain in the
ignored `.render-jobs` directory. Completed downloads remain available after restarting the local server. Refreshing the tab can resume its saved job status.

Source colours uses a separate emission contribution, combined in linear colour
with the room beauty pass after AgX. This preserves the artwork's image colours
while retaining glazing reflections and frame occlusion. It intentionally omits
room colour spill on the print; choose Room lighting for a physical lit print.
Glazing is a thin reflective approximation, not measured optical glass. These
modes are visual aids, not proofing for print or calibrated colour measurement.

The sofa is an original procedural template, not a scanned designer sofa. Its
cloth and styling can be refined further. This adds full-scene still rendering;
video, walkthroughs and a customer chat-based room editor are not included.

Validation:

```sh
node tools/test-generated-room.mjs
node tools/test-high-res-render.mjs
npm run build
```

Colour regression check: run Blender with `--background --factory-startup --python tools/high-res-render/test_colour.py`. A local `--smoke-test` flag after the job directory renders at 320 pixels for integration checks; the browser always requests 3200 pixels.

## Live frame / Cycles matching

Generated-room frame and mount materials now use the full room environment
instead of the legacy per-material reflection damping. The broad window light
is calibrated from the saved window power and area; the wall shadow has a
warmer tint and a narrower feather. This applies only to generated-room live
product lighting. Background images, source-colour artwork and the Cycles
render pipeline are unchanged. The live view remains an approximation,
particularly for self-shadowing and multiple light bounces, and keeps the same
light count and on-demand rendering. Checked with black/gold and white frames.
