# Image index

## Supplier rotations

### POL-4508 — Paramount Black & Silver, 30 × 30 mm

`reference-images/supplier/POL-4508/img01.jpg` through `img45.jpg` are the complete ordered supplier turntable sequence. Views around `img22`–`img24` expose useful end/profile evidence. `img23` is especially important: it shows the silver section as a cove/concavity rather than a convex bead or flat floating strip.

### POL-4875 — Verona Black, 97 × 49 mm

`reference-images/supplier/POL-4875/img01.jpg` through `img45.jpg` are the full supplier sequence. The ornate front decoration is highly visible, but it must not be mistaken for the physical upper cross-section boundary. Views around `img22`–`img24` were used for the SAM benchmark.

### Simple controls

POL-4100, POL-4418 and POL-4211 contain five evenly spaced frames (`img01`, `img12`, `img23`, `img34`, `img45`). These demonstrate why flat profiles are much easier and provide negative controls for an unnecessarily complex reconstruction.

## Real-world photographs

- `PXL_20260824_215732483.jpg`: related 4417-family black moulding. Shows square edges and longitudinal lined/ridged surface texture. It is not an exact POL-4100 product photograph.
- `18312.jpg`: wider contextual view of the black/silver Paramount-style construction.
- `18311.jpg`: close detail of the integrated silver sight edge and black frame.
- `18310.jpg`: oblique view showing that the silver is broad and shaped, not a disconnected line.

## Current renderer comparisons

- `POL-4508-current-tuned.png`: manually corrected/current Paramount interpretation.
- `POL-4508-SAM2-experimental.png`: profile derived from the supplier-spin SAM 2.1 experiment.
- `POL-4875-current-tuned.png`: current hand-estimated Verona profile.
- `POL-4875-SAM2-experimental.png`: automated SAM-derived Verona profile.

These pairs use the same visualiser, materials, view and lighting. Differences are principally profile geometry and, for POL-4508, how the silver and black bands share the 30 mm envelope.

## Historical render failures

- `01-verona-flat-shiny-initial.png`: the original smooth slab; correct overall size but effectively no ornate geometry.
- `02-verona-texture-on-inaccurate-profile.png`: surface imagery added visual detail while the macro profile remained untrustworthy.
- `03-paramount-dark-gap-before-fix.png`: silver/black/mount construction produced an excessive dark gap, illustrating why separate floating meshes and guessed shadows are unsafe.

## Diagnostics

- `POL-4100-section-profile-plot.png`: successful simple-profile extraction example.
- `POL-4508-SAM2-profile.png` and `POL-4508-img23-SAM2-overlay.png`: learned segmentation result and source overlay.
- `POL-4875-SAM2-profile.png` and `POL-4875-img23-SAM2-overlay.png`: learned Verona candidate and overlay.
- `POL-4875-Gemma-profile-overlay.png`: vision-language model attempt.
- `POL-4875-classical-profile-comparison.png`: comparison of classical edge/profile candidates.
- `POL-4875-spec-profile-reference.jpg`: reference crop derived from the supplier spec material.

