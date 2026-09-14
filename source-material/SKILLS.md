# Project runbooks

This is the platform-neutral task guide for the Frame Visualiser. Antigravity
workspace rules and `AGENTS.md` direct agents here so every platform follows the
same practical checks.

## Visualiser UI or interaction changes

1. Trace the state and event path in `src/components/Visualiser.tsx` and the
   relevant child component.
2. Preserve selected moulding, accepted variant, batch selection, and saved-job
   restoration behaviour.
3. Exercise affected presentation modes: Frame detail, View on wall, Asset
   review, and Ollama review.
4. Check browser console output and visually inspect the result in the viewer.
5. Run `npm run build`.

## Frame geometry, rebate, mount, glazing, or materials

1. Read `src/mouldings/catalog.ts`, `src/mouldings/profiles.ts`, and the selected
   SKU's files under `public/assets/mouldings/<SKU>/`.
2. Compare exact-SKU supplier images and dimensions. Treat family images as
   secondary presentation evidence.
3. Check at least a flat dark frame, a brown or natural frame, a gold frame, and
   a silver frame when changing shared material or lighting code.
4. Inspect Frame detail at an angle and View on wall at normal viewing size.
5. Run `npm run test:geometry`, `npm run validate:moulding-assets`, and
   `npm run build` as applicable.

## Ollama material/profile review

1. Read `tools/moulding-material-pilot/README.md`, its `plugin.mjs`, and
   `quality_pipeline.py`.
2. Keep exact-SKU images, family references, dimensions, diagnostics, prompt,
   selected model, attempts, and scores visible in the saved result.
3. Keep candidates immutable under
   `public/assets/mouldings/<SKU>/variants/review-*`.
4. Test one review before a batch. For batch changes, test prepare, start, pause,
   server-restart recovery, resume, item inspection, decisions, and completion.
5. The vision model produces structured assessment and correction data.
   Deterministic Python code applies constrained profile and texture changes.

## Room rendering and shadows

1. Read `src/renderer/roomTemplates.ts`, `GeneratedRoomLighting.tsx`,
   `FrameWallContact.tsx`, `LeaningFrameShadow.tsx`, and the relevant room bundle.
2. Preserve physical contact: mounted frames meet the wall; leaning frames meet
   the floor and wall with depth-dependent contact and cast shadows.
3. Compare against the supplied room reference at more than one artwork size
   and with mouldings of different depths.
4. Confirm shadows scale and move with the frame, stay behind the moulding, and
   meet wall/floor junctions without visible planes or hard boxes.
5. Run the generated-room test, build, and a viewer inspection.

## High-resolution rendering

1. Read `tools/high-res-render/README.md`, `plugin.mjs`, and `render.py`.
2. The browser exports the exact framed assembly as GLB. The local Vite plugin
   starts Blender and returns a PNG through `/api/render` endpoints.
3. Verify availability, progress, restart/error feedback, and final download.
   Do not substitute an image model unless the UI labels the result as an
   optional generated marketing image.

## Importing supplier assets

- Mainline workflows live under `tools/mainline-*-importer/` and
  `tools/mainline-profile-analyser/`; Centrado workflows live under
  `tools/centrado-importer/`.
- Retain source provenance and diagnostics. Do not promote inferred geometry or
  colour to accepted status without visual review.
- Run `npm run validate:moulding-assets` after imports.

## Documentation handoff

After a material change, update `docs/PROJECT_STATUS.md`. If system data flow or
service boundaries changed, also update `docs/APP_ARCHITECTURE.md`. Keep these
documents current; Git remains the detailed history.

