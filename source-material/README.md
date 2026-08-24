# Framed Art Visualiser POC

Astro provides the page shell; the interactive renderer is a React + React Three Fiber island. It creates reusable, data-driven frame geometry from moulding metadata and artwork/mount dimensions.

## Run

```bash
npm install
npm run dev
```

## Asset preparation

`npm run asset:prepare -- --sku POL-4875` creates auditable metadata beside the retained supplier source image. The current tool establishes the workflow, rather than claiming automated material extraction: crop and seamless texture selection remain manual; normal/roughness generation is the next pipeline step.

## Evidence and limitations

The source PDFs are preserved in `source-material/`; per-moulding READMEs document source, approximations and confidence. The POC uses deterministic geometry and PBR response only - it does not use generative rendering. Supplier screenshot images are copied without modification into `public/assets/mouldings/<SKU>/source-product.jpg` as reference material and are not runtime textures yet.
