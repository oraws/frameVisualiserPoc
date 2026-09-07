# Centrado importer

Supplier-specific importer for Centrado mouldings. It downloads the product
section, dimensioned profile drawing, chevron, macro and framed reference.

Unlike Mainline's spin-image pipeline, geometry comes from the clean
orthographic profile drawing. The beige section is segmented deterministically,
scaled to the supplier dimensions and converted into renderer profile points.

```bash
.venv-sam2/bin/python tools/centrado-importer/import.py --refresh
```

Source evidence is stored under `source-material/centrado/<SKU>/`. Runtime
copies are stored under `public/assets/mouldings/<SKU>/`.

For an invoice-derived CSV containing `product_code` and `description`, use:

```bash
.venv-sam2/bin/python tools/centrado-importer/batch_import.py /path/to/unique_mouldings.csv
```

The batch importer resolves canonical product URLs through Centrado's SKU
search, discovers original gallery assets without assuming a fixed image
count, and records any ambiguous or incomplete rows in `batch-failures.json`.

After importing, run `npm run validate:moulding-assets`. Each Centrado product
must have a metric `profile.json`, base colour/bump maps, and separate accent
maps when the supplier record has an accent width. The final QA step is a live
visualiser comparison of the rendered section, tone and finish against the
supplier profile and gallery thumbnails; importer success alone is not visual
approval.
