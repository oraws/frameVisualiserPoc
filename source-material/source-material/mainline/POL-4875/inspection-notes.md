# POL-4875 spin-sequence inspection

- Product: Mainline Verona 97 mm Ornate Black Polcore Moulding (`POL-4875`)
- Ordered frames: 45
- Resolution: 279 x 255 pixels for every downloaded frame
- Coverage: the endpoints are visibly different rather than returning to the initial pose, so this is not a complete 360-degree loop. It appears to be an approximately 180-degree supplier inspection arc spanning the decorated face toward the back.
- Closest side/profile views: `img01` and `img45`; `img02` and `img44` are useful adjacent views for checking ambiguity and perspective.
- Best decorated-face reference: approximately `img21`-`img25`, with `img23` closest to square-on.
- Silhouette suitability: suitable for coarse foreground segmentation because the moulding is dark, isolated and photographed against a nearly white background. The 279 x 255 resolution, soft ground shadow, perspective, diagonal sample cut and lack of a calibrated orthographic side view make it unsuitable as a sole source for precise CAD/profile recovery. Use it with the known 97 x 49 mm dimensions and specification-sheet section.

No profile extraction was attempted in this stage.
