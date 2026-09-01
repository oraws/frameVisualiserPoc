# Mainline catalogue importer

This importer extracts individual moulding panels from Mainline's searchable
catalogue PDF by pairing each PDF image rectangle with the SKU printed directly
below it. It does not alter the PDF or use screenshots selected by hand.

The first pilot deliberately spans difficult geometry: Verona (`POL-4875`),
Paramount (`POL-4508`), Contemporary Classics (`POL-2104`), Watercolour reverse
(`POL-4540`), and a real-wood Fletcher scoop (`010-1009`).

Generated data lives under `source-material/mainline/catalogue-profiles/`, where
the second script derives and scores the visible cross-section boundary.

Run the repeatable batch for every current Mainline moulding with:

```sh
npm run batch:mainline-catalogue
```

The extractor uses seeded GrabCut material separation, retains the substrate
component connected to the lower edge, snaps its visible upper boundary to the
strongest local LAB transition, and calibrates the result to the supplier width,
depth, and rebate dimensions. Existing profiles are not overwritten.
