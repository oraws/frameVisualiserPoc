#!/usr/bin/env python3
"""Import Centrado product assets and derive a metric moulding profile.

Centrado provides a clean, dimensioned orthographic profile PNG, so this
supplier deliberately uses deterministic image segmentation rather than the
Mainline spin/depth pipeline.
"""

from __future__ import annotations

import argparse
import json
import shutil
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "source-material" / "centrado"
PUBLIC_ROOT = ROOT / "public" / "assets" / "mouldings"
PROFILE_MODULE = ROOT / "src" / "mouldings" / "centradoProfiles.json"

PRODUCTS = {
    "4925BG": {
        "name": "Bergen Black and Gold Angled",
        "url": "https://centrado.co/product/bergen-black-and-gold-angled-4925bg/",
        "widthMm": 49,
        "depthMm": 25,
        "rebateMm": 14,
        "profileType": "angled",
        "colourTags": ["black", "gold"],
        "accentWidthMm": 16,
        "materialCrops": {"black": [230, 185, 695, 420], "gold": [230, 445, 695, 520]},
        "assets": {
            "product-section.jpg": "https://centrado.co/wp-content/uploads/2026/08/4925BG.JPG",
            "profile-source.png": "https://centrado.co/wp-content/uploads/2026/08/4925-Profile.png",
            "chevron.jpg": "https://centrado.co/wp-content/uploads/2026/08/4925BG_Chevron.jpg",
            "macro.jpg": "https://centrado.co/wp-content/uploads/2026/08/Bergen-Macro_Gallery-3.jpg",
            "framed-reference.jpg": "https://centrado.co/wp-content/uploads/2026/08/Bergen-BG_Gallery-1.jpg",
        },
    },
    "8054BG": {
        "name": "Luxe Wentworth Black/Gold Scoop",
        "url": "https://centrado.co/product/luxe-wentworth-black-gold-scoop-8054bg/",
        "widthMm": 80,
        "depthMm": 54,
        "rebateMm": 26,
        "profileType": "ornate-scoop",
        "colourTags": ["black", "gold"],
        "accentWidthMm": 15,
        "materialCrops": {"black": [430, 75, 695, 520], "gold": [430, 535, 695, 630]},
        "assets": {
            "product-section.jpg": "https://centrado.co/wp-content/uploads/2026/08/8054BG.JPG",
            "profile-source.png": "https://centrado.co/wp-content/uploads/2026/08/8054-Profile.png",
            "chevron.jpg": "https://centrado.co/wp-content/uploads/2026/08/8054BG_Chevron.jpg",
            "macro.jpg": "https://centrado.co/wp-content/uploads/2026/08/Wentworth-Macro_Gallery-6.jpg",
            "framed-reference.jpg": "https://centrado.co/wp-content/uploads/2026/08/Wentworth-BG_Gallery-1.jpg",
        },
    },
}


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "FrameVisualiserPOC/0.1"})
    with urllib.request.urlopen(request, timeout=45) as response:
        destination.write_bytes(response.read())


def beige_profile_mask(image: np.ndarray) -> np.ndarray:
    """Select the filled profile while excluding black dimensions and white."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    # The diagrams use a consistent warm beige fill. Chroma is much more
    # reliable than edge tracing because the dimension arrows are black too.
    mask = cv2.inRange(lab, np.array((120, 125, 132), np.uint8),
                       np.array((250, 154, 180), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count < 2:
        raise ValueError("Profile fill could not be segmented")
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == component).astype(np.uint8) * 255


def simplify_profile(points: np.ndarray, width_mm: float) -> list[list[float]]:
    curve = points.astype(np.float32).reshape(-1, 1, 2)
    # Sub-millimetre tolerance keeps shaped beads and coves while removing the
    # staircase introduced by raster pixels.
    simplified = cv2.approxPolyDP(curve, max(.10, width_mm * .0015), False).reshape(-1, 2)
    simplified[0, 0], simplified[-1, 0] = 0, width_mm
    return [[round(float(u), 3), round(float(z), 3)] for u, z in simplified]


def visible_surface(mask: np.ndarray) -> np.ndarray:
    """Return the ordered sight-to-outer face, including any overhangs.

    Sampling one y per x destroys deep scoops because those sections can double
    back horizontally. Following the actual contour preserves them.
    """
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = max(contours, key=cv2.contourArea).reshape(-1, 2)
    x0, x1 = contour[:, 0].min(), contour[:, 0].max()
    right = np.flatnonzero(contour[:, 0] >= x1 - 1)
    left = np.flatnonzero(contour[:, 0] <= x0 + 1)
    start = int(right[np.argmin(contour[right, 1])])
    end = int(left[np.argmin(contour[left, 1])])
    if start <= end:
        forward = contour[start:end + 1]
        backward = np.concatenate((contour[start::-1], contour[:end - 1:-1]))
    else:
        forward = np.concatenate((contour[start:], contour[:end + 1]))
        backward = contour[end:start + 1][::-1]
    # The alternate route follows the base and rebate. The visible face is the
    # path that stays nearer the top of the drawing.
    return min((forward, backward), key=lambda path: float(np.percentile(path[:, 1], 70)))


def extract_profile(source: Path, width_mm: float, depth_mm: float,
                    output: Path) -> tuple[list[list[float]], dict]:
    image = cv2.imread(str(source))
    if image is None:
        raise ValueError(f"Cannot read {source}")
    mask = beige_profile_mask(image)
    ys, xs = np.nonzero(mask)
    x0, x1, baseline = int(xs.min()), int(xs.max()), int(ys.max())
    top = int(ys.min())
    pixel_width, pixel_depth = x1 - x0, baseline - top
    contour = visible_surface(mask)
    samples = np.column_stack(((x1 - contour[:, 0]) / max(pixel_width, 1) * width_mm,
                               (baseline - contour[:, 1]) / max(pixel_depth, 1) * depth_mm))
    samples = samples[np.r_[True, np.linalg.norm(np.diff(samples, axis=0), axis=1) > 1e-6]]
    points = simplify_profile(samples, width_mm)
    metrics = {
        "sourceBoundsPixels": {"left": x0, "right": x1, "top": top, "baseline": baseline},
        "pixelsPerMmX": round(pixel_width / width_mm, 4),
        "pixelsPerMmZ": round(pixel_depth / depth_mm, 4),
        "anisotropyFraction": round(abs(pixel_width / width_mm - pixel_depth / depth_mm) /
                                    max(pixel_width / width_mm, pixel_depth / depth_mm), 5),
        "sampleCount": len(samples),
        "simplifiedPointCount": len(points),
    }
    diagnostic(image, mask, points, width_mm, depth_mm, output)
    return points, metrics


def diagnostic(source: np.ndarray, mask: np.ndarray, points: list[list[float]],
               width_mm: float, depth_mm: float, output: Path) -> None:
    rgb = cv2.cvtColor(source, cv2.COLOR_BGR2RGB)
    overlay = rgb.copy()
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(overlay, contours, -1, (255, 55, 45), 3)
    overlay = Image.fromarray(overlay).resize((520, 520))
    canvas = Image.new("RGB", (1040, 520), "#f2f0ea")
    canvas.paste(overlay, (0, 0))
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = 575, 45, 995, 465
    draw.line((left, bottom, right, bottom), fill="#777", width=2)
    draw.line((left, bottom, left, top), fill="#777", width=2)
    mapped = [(left + u / width_mm * (right - left),
               bottom - z / depth_mm * (bottom - top)) for u, z in points]
    draw.line(mapped, fill="#d52d2d", width=4, joint="curve")
    draw.text((left, 485), "inner / sight edge", fill="#555")
    draw.text((right - 80, 485), "outer edge", fill="#555")
    draw.text((575, 15), f"metric profile · {width_mm:g} × {depth_mm:g} mm", fill="#333")
    canvas.save(output)


def material_maps(source: Path, crops: dict, destinations: tuple[Path, Path]) -> None:
    image = Image.open(source).convert("RGB")
    for material, bounds in crops.items():
        crop = image.crop(bounds).resize((1024, 256), Image.Resampling.LANCZOS)
        array = np.asarray(crop)
        gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
        broad = cv2.GaussianBlur(gray, (0, 0), 10)
        bump = np.clip((gray.astype(np.float32) - broad.astype(np.float32)) * 2.0 + 128,
                       0, 255).astype(np.uint8)
        for destination in destinations:
            crop.save(destination / f"{material}-texture.jpg", quality=92)
            Image.fromarray(bump).save(destination / f"{material}-bump.jpg", quality=90)


def import_product(sku: str, product: dict, refresh: bool) -> dict:
    source = SOURCE_ROOT / sku
    public = PUBLIC_ROOT / sku
    source.mkdir(parents=True, exist_ok=True)
    public.mkdir(parents=True, exist_ok=True)
    assets = []
    for filename, url in product["assets"].items():
        destination = source / filename
        if refresh or not destination.exists():
            download(url, destination)
        shutil.copy2(destination, public / filename)
        image = Image.open(destination)
        assets.append({"filename": filename, "originalUrl": url,
                       "width": image.width, "height": image.height})
    points, metrics = extract_profile(source / "profile-source.png", product["widthMm"],
                                      product["depthMm"], source / "profile-diagnostic.png")
    shutil.copy2(source / "profile-diagnostic.png", public / "profile-diagnostic.png")
    material_maps(source / "product-section.jpg", product["materialCrops"], (source, public))
    record = {
        "supplier": "Centrado", "supplierCode": "CTR", "sku": sku,
        "name": product["name"], "productUrl": product["url"],
        "widthMm": product["widthMm"], "depthMm": product["depthMm"],
        "rebateMm": product["rebateMm"], "profileType": product["profileType"],
        "colourTags": product["colourTags"], "method": "dimensioned-profile-png-v1",
        "accentWidthMm": product["accentWidthMm"],
        "points": points, "extraction": metrics, "assets": assets,
        "rendererIntegrated": True,
    }
    for root in (source, public):
        (root / "profile.json").write_text(json.dumps(record, indent=2) + "\n")
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skus", default=",".join(PRODUCTS))
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    selected = [value.strip().upper() for value in args.skus.split(",") if value.strip()]
    records = []
    for sku in selected:
        records.append(import_product(sku, PRODUCTS[sku], args.refresh))
        print(f"{sku}: {records[-1]['extraction']['simplifiedPointCount']} profile points")
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    (SOURCE_ROOT / "import-manifest.json").write_text(json.dumps(records, indent=2) + "\n")
    PROFILE_MODULE.write_text(json.dumps(
        {record["sku"]: record["points"] for record in records}, indent=2) + "\n")


if __name__ == "__main__":
    main()
