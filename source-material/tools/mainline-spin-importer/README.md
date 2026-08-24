# Mainline spin-image importer

Uses Playwright to render a Mainline product page, reads every normal `img` inside `.basicRotate`, preserves the displayed order while removing duplicate URLs, and downloads the originals. It also writes a JSON manifest and a standalone clickable diagnostic page beside the `spin/` directory.

```bash
npm run spin:mainline -- \
  --url https://mainlinemouldings.com/verona-black-97mm-polcore-moulding/ \
  --sku POL-4875
```

Output defaults to `source-material/mainline/<SKU>/`. Set `PLAYWRIGHT_EXECUTABLE_PATH` if Chrome, Edge or Chromium is installed in a non-standard location. The importer deliberately performs no profile or silhouette extraction.
