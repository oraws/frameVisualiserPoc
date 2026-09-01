# Prompt to give the external model

Read `README-FIRST.md` and inspect the supplied images and metadata before answering.

Act as a senior computer-vision, inverse-graphics and 3D reconstruction researcher. We need a scalable, supplier-only method to recover a constant picture-frame moulding cross-section and material bands from 45 low-resolution turntable JPEGs plus known width/depth. New scanning, bespoke photography and routine manual tracing are not allowed.

Your task is to:

1. Diagnose why the included classical, Gemma and SAM 2.1 attempts fail physically even when they look plausible.
2. Compare viable current approaches, including frontier multimodal models, but do not assume that a vision-language description is metrically accurate.
3. Propose the strongest automated pipeline, with named model/tool candidates, calibration method, optimisation objective, priors, confidence checks and batch-processing design.
4. Use the provided POL-4100/POL-4418/POL-4211 controls and the POL-4508/POL-4875 challenges to define an experiment that could produce a clear go/no-go result.
5. If your capabilities permit, infer candidate `[[u_mm,z_mm], ...]` profiles and material-band ranges for POL-4508 and POL-4875, and explain which images constrain each feature. Do not invent certainty where the evidence is ambiguous.
6. Explain how to validate any candidate through held-out multi-view re-rendering rather than visual plausibility in one view.
7. Return the result using `FINDINGS-TEMPLATE.md`, including direct references to image filenames.

Important: the physical cross-section is not the same thing as the visible decorative pattern on the front face. Separate macro geometry, micro-relief and material/texture. Do not modify or redesign the visualiser.

