#!/usr/bin/env python3
"""Extract SKU-labelled product panels from the Mainline catalogue PDF.

The catalogue places each moulding photograph immediately above its SKU.  We use
the PDF's text and image geometry to pair them, then rasterise only the required
pages at the catalogue image resolution.  The source PDF is never modified.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

import pdfplumber
from PIL import Image


CORE_PRODUCTS = [
    {"sku": "POL-4875", "name": "Verona Black", "widthMm": 97, "depthMm": 49, "rebateMm": 16, "profileType": "ornate-scoop"},
    {"sku": "POL-4100", "name": "Brushed Black", "widthMm": 41, "depthMm": 13, "rebateMm": 9, "profileType": "flat"},
    {"sku": "POL-4508", "name": "Paramount Black & Silver", "widthMm": 30, "depthMm": 30, "rebateMm": 13, "profileType": "composite"},
    {"sku": "POL-4418", "name": "Flat Bronze", "widthMm": 54, "depthMm": 20, "rebateMm": 14, "profileType": "flat"},
    {"sku": "POL-4211", "name": "Flat Oak", "widthMm": 54, "depthMm": 20, "rebateMm": 14, "profileType": "flat"},
]


def load_products(catalog_json: Path) -> list[dict]:
    imported = json.loads(catalog_json.read_text())
    products = [dict(product) for product in CORE_PRODUCTS]
    seen = {product["sku"] for product in products}
    for product in imported:
        if product.get("supplier") != "Mainline" or product["sku"] in seen:
            continue
        products.append({
            key: product[key] for key in ("sku", "name", "widthMm", "depthMm", "rebateMm", "profileType")
        })
        seen.add(product["sku"])
    return products


def normalise(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def find_labels(words: list[dict], sku: str) -> list[dict]:
    target = normalise(sku)
    matches = []
    for length in (1, 2, 3):
        for index in range(len(words) - length + 1):
            group = words[index:index + length]
            if max(word["bottom"] for word in group) - min(word["top"] for word in group) > 18:
                continue
            if normalise("".join(word["text"] for word in group)) == target:
                matches.append({
                    "x0": min(word["x0"] for word in group),
                    "x1": max(word["x1"] for word in group),
                    "top": min(word["top"] for word in group),
                    "bottom": max(word["bottom"] for word in group),
                    "text": " ".join(word["text"] for word in group),
                })
    if not matches:
        raise RuntimeError(f"Could not locate SKU label {sku}")
    return matches


def find_panel(images: list[dict], label: dict) -> dict:
    candidates = []
    for image in images:
        if image["width"] < 45 or image["height"] < 45 or image["bottom"] > label["top"] + 2:
            continue
        horizontal = abs(image["x0"] - label["x0"])
        gap = max(0, label["top"] - image["bottom"])
        overlap = max(0, min(image["x1"], label["x1"]) - max(image["x0"], label["x0"]))
        candidates.append((horizontal + gap * 0.35 - overlap * 0.2, image))
    if not candidates:
        raise RuntimeError(f"No product image found above label {label['text']}")
    return min(candidates, key=lambda item: item[0])[1]


def render_page(pdf: Path, page_number: int, output: Path, pdftoppm: str) -> None:
    subprocess.run([
        pdftoppm, "-f", str(page_number), "-l", str(page_number), "-r", "180",
        "-png", "-singlefile", str(pdf), str(output.with_suffix("")),
    ], check=True, stdout=subprocess.DEVNULL)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pdftoppm", required=True)
    parser.add_argument("--catalog-json", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    products = load_products(args.catalog_json)
    manifest = {"sourcePdf": str(args.pdf.resolve()), "method": "pdf-layout-image-pairing", "requestedCount": len(products), "products": [], "failures": []}

    with pdfplumber.open(args.pdf) as document, tempfile.TemporaryDirectory(prefix="mainline-catalogue-") as temp:
        temp_root = Path(temp)
        rendered: dict[int, Path] = {}
        page_words = [page.extract_words() for page in document.pages]
        for product in products:
            matching_pages = []
            for page_number, words in enumerate(page_words, 1):
                try:
                    labels = find_labels(words, product["sku"])
                    matching_pages.append((page_number, labels))
                except RuntimeError:
                    continue
            if not matching_pages:
                manifest["failures"].append({"sku": product["sku"], "reason": "SKU label not found in PDF"})
                print(f"{product['sku']}: FAILED - label not found")
                continue
            pairs = []
            for page_number, labels in matching_pages:
                page = document.pages[page_number - 1]
                for possible_label in labels:
                    try:
                        possible_panel = find_panel(page.images, possible_label)
                        pair_score = abs(possible_panel["x0"] - possible_label["x0"]) + abs(possible_label["top"] - possible_panel["bottom"]) * .2
                        pairs.append((pair_score, page_number, possible_label, possible_panel))
                    except RuntimeError:
                        pass
            if not pairs:
                manifest["failures"].append({"sku": product["sku"], "reason": "No product image found above SKU label"})
                print(f"{product['sku']}: FAILED - image/label pair not found")
                continue
            _, page_number, label, panel = min(pairs, key=lambda item: item[0])
            page = document.pages[page_number - 1]
            if page_number not in rendered:
                page_path = temp_root / f"page-{page_number}.png"
                render_page(args.pdf, page_number, page_path, args.pdftoppm)
                rendered[page_number] = page_path
            page_image = Image.open(rendered[page_number]).convert("RGB")
            sx, sy = page_image.width / float(page.width), page_image.height / float(page.height)
            crop_box = (
                max(0, round(panel["x0"] * sx)), max(0, round(panel["top"] * sy)),
                min(page_image.width, round(panel["x1"] * sx)), min(page_image.height, round(panel["bottom"] * sy)),
            )
            product_root = args.output / product["sku"]
            product_root.mkdir(parents=True, exist_ok=True)
            filename = "catalogue-panel.png"
            crop = page_image.crop(crop_box)
            crop.save(product_root / filename)
            record = {
                **product,
                "page": page_number,
                "label": label["text"],
                "filename": filename,
                "pixelWidth": crop.width,
                "pixelHeight": crop.height,
                "pdfImageBox": {key: round(float(panel[key]), 3) for key in ("x0", "top", "x1", "bottom")},
            }
            (product_root / "source.json").write_text(json.dumps(record, indent=2) + "\n")
            manifest["products"].append(record)
            print(f"{product['sku']}: page {page_number} -> {crop.width}x{crop.height}")

    manifest["importedCount"] = len(manifest["products"])
    (args.output / "catalogue-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
