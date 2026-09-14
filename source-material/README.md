# Framed Art Visualiser POC

A supplier-grounded framed-art visualiser built with Astro, React, React Three
Fiber, Three.js, local Python pipelines, Ollama vision models, and an optional
local Blender renderer. It creates measurable frame geometry from supplier
moulding profiles and shows the same product in inspection, room, review, batch,
and high-resolution workflows.

Read [the application architecture](docs/APP_ARCHITECTURE.md) for the full data
flow and [the project status](docs/PROJECT_STATUS.md) for the current cross-agent
handoff. Coding agents must follow `AGENTS.md` and `SKILLS.md`.

## Run

```bash
npm install
npm run dev
```

Use the URL printed by Astro. If another viewer is running, Vite may select a
port other than 4321. The base viewer works without Ollama or Blender. Ollama
review requires a supported local vision model; high-resolution output requires
Blender.

## How the app works

- **Frame detail** builds four mitred rails from the selected supplier profile,
  applies the accepted material, and places mount, artwork, glazing, backing,
  and rebate layers at physical depths.
- **View on wall** uses either a calibrated photograph or a fixed-camera
  generated room with prepared lighting and room-specific shadows.
- **Asset review** records Accepted, Needs work, or Pending state and provides a
  filterable moulding grid with profile and material batch selection.
- **Ollama review** sends exact-SKU evidence, available family images, dimensions,
  diagnostics, and an editable prompt to a local vision model. The model returns
  structured correction data; deterministic Python code applies bounded changes
  and writes an immutable before/after candidate.
- **Batch processing and benchmarks** persist queues, progress, model runs, and
  pause/resume state. A benchmark can recommend primary/fallback model routing.
- **High-resolution image** exports the exact browser frame assembly to GLB and
  sends it to local Blender for a downloadable room-rendered PNG.

## Asset preparation

`npm run asset:prepare -- --sku POL-4875` creates auditable metadata beside the
retained supplier source image. Supplier import, profile extraction, material
generation, family-reference extraction, and validation tools live under
`tools/`; read the nearest tool README before running a batch.

## Ollama review workflow

The Ollama review panel compares supplier references with the generated profile and finish using an installed vision model. Each completed run is saved as an immutable moulding variant. The viewer can switch between the source input and result, accept or reject any saved version, and return to an earlier version without removing later history.

Asset Review stores a separate moulding-level Accepted, Needs work, or pending
status. Its optional thumbnail grid can be filtered by supplier and status. Each
eligible thumbnail can be added to a persistent Ollama queue for profile review,
texture review, or both; the selected queue may include accepted mouldings.
Automatic batches can process all eligible non-accepted mouldings or one
supplier. Legacy assets are normalized automatically, while supplier dimensions
and profile points are carried into review. History removal remains a separate
administration operation.

## Evidence and limitations

Source PDFs are preserved in `source-material/`; per-moulding notes and generated
reports document provenance, approximations, and confidence. The product frame
uses deterministic geometry and PBR response. AI may assist room-asset preparation
and analyse moulding candidates, but the viewer does not ask an image model to
redraw the selected artwork or frame at runtime. Supplier images remain evidence
unless a documented pipeline derives an auditable runtime asset from them.

## Checks

```bash
npm run build
npm run validate:moulding-assets
npm run test:geometry
```

Rendering changes also require a direct check in the running viewer.
