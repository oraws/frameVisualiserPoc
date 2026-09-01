#!/usr/bin/env python3
"""Batch-import Centrado mouldings listed in a CSV.

The supplier search redirects exact SKUs to their canonical product pages.
Those pages expose the original 700/1000 px gallery assets, including a clean
dimensioned profile drawing.  Geometry is delegated to the proven importer in
this directory; this module handles discovery, catalogue generation and
automatic material sampling at catalogue scale.
"""

from __future__ import annotations

import argparse
import csv
import html
import importlib.util
import json
import re
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "source-material" / "centrado"
PUBLIC_ROOT = ROOT / "public" / "assets" / "mouldings"
PROFILE_MODULE = ROOT / "src" / "mouldings" / "centradoProfiles.json"
CATALOGUE_MODULE = ROOT / "src" / "mouldings" / "centradoMouldings.json"

spec = importlib.util.spec_from_file_location(
    "centrado_single_import", Path(__file__).with_name("import.py")
)
single = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(single)

SEED_PRODUCTS = single.PRODUCTS
COLOURS = {
    "black": "#171716", "white": "#eceae3", "cream": "#d8d0b8",
    "ivory": "#ddd4bd", "brown": "#654b38", "gold": "#b8903e",
    "silver": "#b9bab8", "bronze": "#735c43", "orange": "#b75b2d",
    "red": "#9e2e29", "yellow": "#d2a92f", "navy": "#26364d",
    "blue": "#334f68", "grey": "#777875", "oak": "#9b7650",
    "pine": "#c7a571", "walnut": "#654834", "midnight": "#20242e",
}
ROW_OVERRIDES = {
    # Invoice extraction joined HS9 with an adjacent 3 and dropped the leading
    # 3 from the dimensions. The official current page confirms 31 × 27 mm.
    "HS93": ("HS9", "31x27mm Raw Pine Stretcher Moulding FSC"),
    # The CSV has no code, but this exact description resolves uniquely.
    "20x14mm Black Cushion Moulding": ("0403BK", "20x14mm Black Cushion Moulding"),
}


def fetch(url: str) -> tuple[str, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "FrameVisualiserPOC/0.2"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.geturl(), response.read()


def original_asset_url(url: str) -> str:
    url = html.unescape(url).replace("\\/", "/")
    return re.sub(r"-\d+x\d+(?=\.[A-Za-z]{3,4}(?:\?|$))", "", url)


def page_assets(document: str) -> list[str]:
    urls = re.findall(
        r"https?://[^\"'<>\\ ]+?/wp-content/uploads/[^\"'<>\\ ]+?\.(?:jpe?g|png|webp)",
        document, re.I,
    )
    result = []
    for value in urls:
        value = original_asset_url(value)
        if value not in result:
            result.append(value)
    return result


def choose_assets(sku: str, urls: list[str]) -> dict[str, str]:
    basename = lambda value: urllib.parse.unquote(value.rsplit("/", 1)[-1]).lower()
    exact = [u for u in urls if basename(u) in {f"{sku.lower()}.jpg", f"{sku.lower()}.jpeg", f"{sku.lower()}.png"}]
    profiles = [u for u in urls if "profile" in basename(u)]
    chevrons = [u for u in urls if "chevron" in basename(u) and sku.lower() in basename(u)]
    macros = [u for u in urls if "macro" in basename(u)]
    details = [u for u in urls if re.search(r"-3d[bf]\.", basename(u)) and sku.lower() in basename(u)]
    galleries = [u for u in urls if "gallery" in basename(u) and "macro" not in basename(u)]
    chosen: dict[str, str] = {}
    if exact: chosen["product-section.jpg"] = exact[0]
    if profiles: chosen["profile-source.png"] = profiles[0]
    if chevrons: chosen["chevron.jpg"] = chevrons[0]
    if macros: chosen["macro.jpg"] = macros[0]
    if galleries: chosen["framed-reference.jpg"] = galleries[0]
    for index, url in enumerate(details[:2], 1):
        chosen[f"product-detail-{index}.jpg"] = url
    return chosen


def dimensions(description: str) -> tuple[float, float]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*mm", description)
    if not match:
        raise ValueError("dimensions missing from description")
    return float(match.group(1)), float(match.group(2))


def colour_tags(description: str) -> list[str]:
    lower = description.lower()
    tags = [name for name in COLOURS if re.search(rf"\b{re.escape(name)}\b", lower)]
    if "gunmetal" in lower and "grey" not in tags:
        tags.append("grey")
    return tags or ["brown"]


def profile_type(description: str) -> str:
    lower = description.lower()
    for label, value in (("stretcher", "flat"), ("l-shape", "l-shape"),
                         ("reverse", "reverse"), ("scoop", "scoop"),
                         ("cushion", "cushion"), ("step", "angled"),
                         ("bevel", "angled"), ("angled", "angled")):
        if label in lower:
            return value
    return "flat"


def automatic_material_maps(source: Path, output_roots: tuple[Path, Path], accent: bool) -> None:
    image = np.asarray(Image.open(source).convert("RGB"))
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    chroma = image.max(axis=2) - image.min(axis=2)
    foreground = ((gray < 242) | (chroma > 18)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, 8)
    if count > 1:
        component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        ys, xs = np.nonzero(labels == component)
    else:
        ys, xs = np.indices(gray.shape)
        ys, xs = ys.ravel(), xs.ravel()
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    width, height = max(1, x1 - x0), max(1, y1 - y0)
    # The physical sample extends towards the right. Sampling the final 58% of
    # its visible run avoids the raw cut face while retaining supplier finish.
    bx0, bx1 = int(x0 + width * .42), max(int(x0 + width * .62), x1)
    by0, by1 = int(y0 + height * .12), int(y0 + height * .76)
    base = Image.fromarray(image).crop((bx0, by0, bx1, max(by0 + 8, by1)))
    if accent:
        ay0, ay1 = int(y0 + height * .70), int(y0 + height * .94)
        accent_image = Image.fromarray(image).crop((bx0, ay0, bx1, max(ay0 + 8, ay1)))
    else:
        accent_image = base
    for label, crop in (("base", base), ("accent", accent_image)):
        crop = crop.resize((1024, 256), Image.Resampling.LANCZOS)
        array = np.asarray(crop)
        local_gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
        broad = cv2.GaussianBlur(local_gray, (0, 0), 10)
        bump = np.clip((local_gray.astype(np.float32) - broad.astype(np.float32)) * 2 + 128,
                       0, 255).astype(np.uint8)
        for root in output_roots:
            crop.save(root / f"{label}-texture.jpg", quality=92)
            Image.fromarray(bump).save(root / f"{label}-bump.jpg", quality=90)


def display_name(title: str, fallback: str) -> str:
    title = html.unescape(re.sub(r"\s+", " ", title)).strip()
    title = re.sub(r"\s*\|\s*[^|]*Centrado.*$", "", title, flags=re.I)
    return title or re.sub(r"^\d+x\d+mm\s+", "", fallback, flags=re.I)


def catalogue_record(record: dict) -> dict:
    tags = record["colourTags"]
    description = record.get("description") or record.get("finish") or record["name"]
    base_tag = next((tag for tag in tags if tag not in {"gold", "silver"}), tags[0])
    accent_tag = next((tag for tag in tags if tag in {"gold", "silver"} and tag != base_tag), None)
    images = []
    labels = {
        "product-section.jpg": "Physical section", "profile-source.png": "Dimensioned profile",
        "chevron.jpg": "Chevron", "macro.jpg": "Material macro",
        "framed-reference.jpg": "Framed reference", "product-detail-1.jpg": "Product detail 1",
        "product-detail-2.jpg": "Product detail 2",
    }
    for asset in record["assets"]:
        images.append({"label": labels.get(asset["filename"], asset["filename"]),
                       "url": f"/assets/mouldings/{record['sku']}/{asset['filename']}"})
    return {
        "sku": record["sku"], "supplier": "Centrado", "supplierCode": "CTR",
        "name": record["name"], "description": description,
        "widthMm": record["widthMm"], "depthMm": record["depthMm"],
        "rebateMm": record["rebateMm"], "profileType": record["profileType"],
        "finish": description, "baseColor": COLOURS.get(base_tag, "#56524c"),
        "accentColor": COLOURS.get(accent_tag) if accent_tag else None,
        "accentWidthMm": record["accentWidthMm"], "colourTags": tags,
        "roughness": .38 if "lustre" in description.lower() else .66,
        "ornament": .72 if any(x in description.lower() for x in ("decorative", "scoop")) else .12,
        "renderStatus": "auto-candidate",
        "confidence": {"shape": "Supplier profile · high", "dimensions": "High",
                       "texture": "Supplier-derived", "colour": "Supplier-derived",
                       "material": "Supplier-derived"},
        "sourceUrl": record["productUrl"], "supplierImages": images,
    }


def import_row(sku: str, description: str, refresh: bool) -> dict:
    width_mm, depth_mm = dimensions(description)
    cached = SOURCE_ROOT / sku / "profile.json"
    if cached.exists() and not refresh:
        record = json.loads(cached.read_text())
        if record.get("method") == "dimensioned-profile-png-v2-batch":
            return record
    search = "https://centrado.co/?" + urllib.parse.urlencode({"s": sku, "post_type": "product"})
    canonical, page_bytes = fetch(search)
    if "/product/" not in canonical:
        raise ValueError("exact product page not found")
    document = page_bytes.decode("utf-8", "replace")
    title_match = re.search(r"<title[^>]*>(.*?)</title>", document, re.I | re.S)
    name = display_name(title_match.group(1) if title_match else "", description)
    chosen = choose_assets(sku, page_assets(document))
    if "product-section.jpg" not in chosen or "profile-source.png" not in chosen:
        raise ValueError(f"required assets missing ({', '.join(chosen)})")
    source, public = SOURCE_ROOT / sku, PUBLIC_ROOT / sku
    source.mkdir(parents=True, exist_ok=True)
    public.mkdir(parents=True, exist_ok=True)
    assets = []
    for filename, url in chosen.items():
        destination = source / filename
        if refresh or not destination.exists():
            single.download(url, destination)
        shutil.copy2(destination, public / filename)
        image = Image.open(destination)
        assets.append({"filename": filename, "originalUrl": url,
                       "width": image.width, "height": image.height})
    points, extraction = single.extract_profile(source / "profile-source.png", width_mm,
                                                 depth_mm, source / "profile-diagnostic.png")
    shutil.copy2(source / "profile-diagnostic.png", public / "profile-diagnostic.png")
    tags = colour_tags(description)
    accent = len(tags) > 1 and any(tag in {"gold", "silver"} for tag in tags)
    accent_width = round(width_mm * .32, 2) if accent else 0
    automatic_material_maps(source / "product-section.jpg", (source, public), accent)
    record = {
        "supplier": "Centrado", "supplierCode": "CTR", "sku": sku, "name": name,
        "description": description, "productUrl": canonical, "widthMm": width_mm,
        "depthMm": depth_mm, "rebateMm": round(max(6, depth_mm * .56), 1),
        "profileType": profile_type(description), "colourTags": tags,
        "method": "dimensioned-profile-png-v2-batch", "accentWidthMm": accent_width,
        "points": points, "extraction": extraction, "assets": assets,
        "rendererIntegrated": True,
    }
    for root in (source, public):
        (root / "profile.json").write_text(json.dumps(record, indent=2) + "\n")
    return record


def seed_records() -> list[dict]:
    records = []
    for sku in ("4925BG", "8054BG"):
        path = SOURCE_ROOT / sku / "profile.json"
        if path.exists():
            source, public = SOURCE_ROOT / sku, PUBLIC_ROOT / sku
            for target, legacy in (("base", "black"), ("accent", "gold")):
                for suffix in ("texture.jpg", "bump.jpg"):
                    for root in (source, public):
                        destination, original = root / f"{target}-{suffix}", root / f"{legacy}-{suffix}"
                        if not destination.exists() and original.exists():
                            shutil.copy2(original, destination)
            records.append(json.loads(path.read_text()))
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    records = {record["sku"]: record for record in seed_records()}
    failures = []
    with args.csv.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        sku, description = (row.get("product_code") or "").strip().upper(), (row.get("description") or "").strip()
        override = ROW_OVERRIDES.get(sku) or ROW_OVERRIDES.get(description)
        if override:
            sku, description = override
        if not sku:
            failures.append({"sku": "", "description": description, "reason": "missing product code"})
            continue
        try:
            record = import_row(sku, description, args.refresh)
            records[sku] = record
            print(f"{sku}: {len(record['points'])} points · {record['productUrl']}")
        except Exception as error:
            failures.append({"sku": sku, "description": description, "reason": str(error)})
            print(f"{sku}: FAILED · {error}")
    ordered = list(records.values())
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    (SOURCE_ROOT / "import-manifest.json").write_text(json.dumps(ordered, indent=2) + "\n")
    (SOURCE_ROOT / "batch-failures.json").write_text(json.dumps(failures, indent=2) + "\n")
    PROFILE_MODULE.write_text(json.dumps({r["sku"]: r["points"] for r in ordered}, indent=2) + "\n")
    CATALOGUE_MODULE.write_text(json.dumps([catalogue_record(r) for r in ordered], indent=2) + "\n")
    print(f"Imported {len(ordered)} total Centrado mouldings; {len(failures)} failures")


if __name__ == "__main__":
    main()
