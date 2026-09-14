# Frame Visualiser project status

**Last verified:** 14 September 2026  
**Application:** supplier-grounded framed-art visualiser POC  
**Catalogue validation:** 39 Mainline and 52 Centrado mouldings

This file is the current cross-agent handoff. Update stale facts in place after
meaningful product or pipeline changes; do not use it as a chat transcript.

## Current working-tree state

- Enhanced procedural shader pipeline in `src/renderer/LeaningFrameShadow.tsx`
  for the `floor-lean` room mode ("AI Enhanced · Leaning Floor Gallery"):
  - Resolved horizontal shadow defect: removed artificial `highlightBand`/`highlightSuppression` darkening on the skirting torus (`y in [-1.650, -1.575]`), ensuring the wall shadow rolls smoothly and continuously across the wall and upper skirting.
  - Resolved skirting board highlight defect: calibrated the wall shadow floor cutoff to match the photographed floor line in 3D projection (`wallFloorY = floorY - 0.106 = -2.022` on the wall plane), fully covering the flat face of the skirting board down to the floorboards.
  - Aligned the floor triangular shadow wedge to match the slope from the wall base (`wallFloorY = -2.022`, `wallZ = 0`) to the frame bottom contact line (`floorY = -1.916`, `frontZ`) using dynamic rotation (`-Math.PI / 2 - floorTilt`), eliminating any screen-space seam, overlap, or exposed unshadowed strip.
  - Ground contact ambient occlusion crevice dynamically computed from exact physical profile depth (`depthMm * 0.001 * scale * cos(tilt)`), running directly from underneath the bottom rail out onto the floorboards with depth testing (`depthTest: true`, `renderOrder: -1`). Completely eliminates the detached black line and visible floor gap across all mouldings.
  - Triangular floor shadow wedge strictly bounded by the front contact edge (`frontZ`) and wall base (`wallZ`), with zero overhang past the bottom rail.
- Automated test suite passing: `npm run build`, `npm run validate:moulding-assets`, `npm run test:geometry`, and `node tools/test-generated-room.mjs`.
- Visual realism self-verified via Playwright headless captures on "AI Enhanced · Leaning Floor Gallery" confirming seamless skirting coverage and monotonic luminance profile.

## Implemented product flows

- **Frame detail:** free-orbit 3D inspection of profile, texture, mount, inner
  mount, glazing, rebate depth, artwork size, and material diagnostics.
- **View on wall:** photographic and generated room templates with scale,
  placement, prepared light, material-preserving colour response, glazing, and
  room-specific shadows. Generated rooms use fixed cameras and local scene data.
- **Asset review:** per-moulding Accepted, Needs work, or Pending state plus an
  optional filterable thumbnail grid. Grid items can be queued separately for
  profile and material review.
- **Ollama review:** installed vision-model selection, editable prompts, profile
  and texture/colour helpers, progress, findings, attempts, before/after preview,
  accept/reject, immutable history, and selection of an older retained version.
- **Batch processing:** prepared queues, per-item scopes and status, pause after
  the active moulding, saved recovery/resume after server restart, a full batch
  workspace, item inspector, evidence/prompt inspection, and supplier or
  non-accepted automatic queues.
- **Model benchmark:** runs the same representative mouldings and prompt across
  selected vision models, records automatic and human results, and can save a
  primary/fallback routing policy.
- **High-resolution image:** browser GLB export followed by a local Blender
  render, progress polling, and PNG download.
- **Room administration/test centre:** calibration controls, stored local room
  metadata, and renderer/profile diagnostics.

## Moulding pipeline status

- Exact-SKU supplier images, dimensions, extracted profiles, texture inputs,
  diagnostics, and available family references are attached to catalogue items.
- Mainline catalogue family images have been extracted where available;
  Centrado framed/family references are included when supplier material provides
  them.
- The local review pipeline creates constrained profile candidates plus
  base-colour, bump, and roughness candidates. The vision model returns structured
  analysis and correction parameters; deterministic code applies and scores the
  result. It does not directly invent and save an arbitrary 3D mesh.
- Accepted versions drive the viewer and grid preview. Candidate history is
  retained independently from the active accepted version.

## Room and realism status

- The app supports calibrated photographic rooms and generated 3D room bundles.
- Generated sofa, daylight, and leaning-floor scenes include environment and
  projection data with prepared lighting. AI-enhanced room images are authored
  assets; an image model does not redraw the selected artwork or frame at runtime.
- Frame materials use supplier-grounded base colour and finish controls so room
  light shapes reflections and shadows without washing black, brown, gold, or
  silver mouldings toward the wall colour.
- Leaning-floor realism remains a tuned reference-matching implementation. Test
  across frame dimensions and profile depths when changing camera, placement, or
  room assets.

## Local runtime dependencies

- Node/Astro dev server for the UI and local API middleware.
- Ollama at `127.0.0.1:11434` for supported installed vision models.
- Python virtual environments for profile/material processing, SAM-based tools,
  and optional ComfyUI room enhancement.
- Blender for high-resolution PNG rendering.

## Latest verification

- `npm run build` passed with zero Astro errors, warnings, or hints. Vite emits
  its existing large-chunk advisory.
- `npm run validate:moulding-assets` passed for 91 mouldings.
- `npm run test:geometry` passed with valid sampled coordinates.
- `node tools/test-generated-room.mjs` passed 96 Blender-to-browser landmark
  comparisons and EXR validation.
- Live viewer inspection verified via Playwright screenshots for `8054BG` (deep scoop)
  and `CR1090WH` (flat white) in **AI Enhanced · Leaning Floor Gallery**, confirming
  clean top contact, continuous wall penumbra, and grounded floor rail contact.
- Regression checks verified for mounted **AI Enhanced · Linen Sofa Gallery** and **Frame detail**.

## Material limitations and next checks

- Local model quality varies by SKU and evidence quality. Automatic scores do
  not replace before/after inspection and user acceptance.
- Batch throughput is constrained by one active local review and up to four
  correction attempts. Tiered routing can reduce fallback runs, but must be
  benchmarked using user-rated results.
- High-resolution rendering requires the local server and Blender to remain
  available. The browser restores the last job reference but cannot resume a
  Blender process that the operating system terminated.
- Before processing thousands of mouldings, finish human review of the current
  catalogue, benchmark representative failures, and freeze quality gates for
  geometry, colour, finish, tiling, and supplier evidence.

