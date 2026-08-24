# Mainline profile analyser

Experimental silhouette diagnostics for a sequence produced by the Mainline spin importer. It segments the largest dark foreground component, ranks frames by narrowness, exports normalized boundary traces for selected views, and generates source/mask/overlay comparisons.

```bash
python3 -m pip install -r tools/mainline-profile-analyser/requirements.txt
npm run analyse:mainline-profile -- \
  --input source-material/mainline/POL-4875
```

This stage does not infer calibrated moulding geometry and does not modify the renderer. The masks are evidence for selecting source views; known dimensions and the supplier section drawing are still required for profile reconstruction.

## Native PDF and automatic contour pipeline

Install the classical dependencies, extract page 2's embedded images and vector calibration, then generate the DP consensus:

```bash
python3 -m pip install -r tools/mainline-profile-analyser/requirements.txt

npm run parse:mainline-spec -- \
  --pdf Verona_Spec_Sheet.pdf \
  --page 2 \
  --output source-material/mainline/POL-4875/profile-analysis/native

npm run extract:mainline-profile -- \
  --product-root source-material/mainline/POL-4875 \
  --native-metadata source-material/mainline/POL-4875/profile-analysis/native/native-metadata.json \
  --current-trace source-material/mainline/POL-4875/profile-analysis/spec-trace-candidate.json
```

`MainlineSpecParser` reads native raster objects, placement matrices, text coordinates and vector measurement lines. The automatic extractor produces 15 edge-path hypotheses, a consensus profile, uncertainty bands, classical top-surface spin diagnostics and a clay silhouette. Outputs remain `experimental-unapproved`; the runtime profile is not changed.

## Conservative simple-profile route

For a flat/two-level moulding, the spin sequence can be used without a native
spec image. This route automatically selects a near-front frame, detects the
cut-end silhouette and calibrates it with supplier dimensions. It rejects
complex silhouettes and always requires a review decision.

```bash
npm run extract:mainline-simple-profile -- \
  --product-root source-material/mainline/POL-4100 \
  --name "Brushed Black 41mm Polcore Moulding" \
  --width-mm 41 --depth-mm 13 --rebate-mm 9
```

The generated `profile-review.html` can download either an auto-approval record
or a fine-tuning queue record. Neither action changes the renderer.

## Local Gemma review candidate

Gemma is an optional semantic proposal, not a measurement source. The adapter
sends the native supplier image to a local Ollama vision model, preserves the
exact request and raw response, validates the structured points, and generates
a comparison page with separate accept/trace decisions.

```bash
npm run extract:mainline-gemma-profile -- \
  --image source-material/mainline/POL-4875/profile-analysis/native/profile-native.jpeg \
  --native-metadata source-material/mainline/POL-4875/profile-analysis/native/native-metadata.json \
  --deterministic source-material/mainline/POL-4875/profile-analysis/auto/profile-auto.json \
  --output source-material/mainline/POL-4875/profile-analysis/gemma
```

The model's confidence is self-reported. Every Gemma candidate remains
`awaiting-human-review` and `rendererIntegrated: false` until a downloaded
decision is deliberately applied in a later stage.

## Manual red profile trace

Generate calibrated, per-moulding canvas editors with a freehand brush,
straight-line tool, stroke eraser, undo, clear, zoom, candidate loading and a
live physical profile preview:

```bash
npm run build:mainline-trace-editors
```

The confirmation action requires at least 96% width coverage and downloads an
`accepted-manual-trace` JSON containing both the simplified millimetre points
and the original red canvas strokes. Drafts persist locally and can also be
downloaded/imported. Confirmation still leaves `rendererIntegrated: false`.
