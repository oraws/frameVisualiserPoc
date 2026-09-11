# Framed Art Visualiser POC

Astro provides the page shell; the interactive renderer is a React + React Three Fiber island. It creates reusable, data-driven frame geometry from moulding metadata and artwork/mount dimensions.

## Run

```bash
npm install
npm run dev
```

## Asset preparation

`npm run asset:prepare -- --sku POL-4875` creates auditable metadata beside the retained supplier source image. The current tool establishes the workflow, rather than claiming automated material extraction: crop and seamless texture selection remain manual; normal/roughness generation is the next pipeline step.

## Ollama review workflow

The Ollama review panel compares supplier references with the generated profile and finish using an installed vision model. Each completed run is saved as an immutable moulding variant. The viewer can switch between the source input and result, accept or reject any saved version, and return to an earlier version without removing later history.

Asset Review stores a separate moulding-level `OK`, `Not OK`, or pending status. Its optional thumbnail grid can be filtered by supplier and status. Each eligible thumbnail can be added to a persistent Ollama queue for profile review, texture review, or both; the selected queue may include accepted mouldings. Automatic batch review can process all eligible non-accepted mouldings or restrict the queue to one supplier. Legacy texture assets are normalized into a review-ready material automatically, while existing supplier dimensions and profile points are carried into profile review. A moulding is excluded only when it has no usable local material image. History removal is intentionally reserved for a separate admin operation.

## Evidence and limitations

The source PDFs are preserved in `source-material/`; per-moulding READMEs document source, approximations and confidence. The POC uses deterministic geometry and PBR response only - it does not use generative rendering. Supplier screenshot images are copied without modification into `public/assets/mouldings/<SKU>/source-product.jpg` as reference material and are not runtime textures yet.
