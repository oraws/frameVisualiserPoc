#!/usr/bin/env python3
"""Build repeatable PBR material maps from every imported Mainline asset set.

Spin products use seven adjacent, near-frontal frames selected from the actual
manifest length. Products without a spin use the photographed face above the
cut section in the catalogue panel. No SKU needs to be added to this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "source-material/mainline"
PUBLIC_ROOT = ROOT / "public/assets/mouldings"
VARIANT = "supplier-derived-v2"
LEGACY_OVERRIDES = {
    # Preserve the four visually approved crops while the automatic route
    # handles every newly imported SKU.
    "POL-2104": (31, 112, 136, 218),
    "POL-4508": (88, 78, 125, 226),
    "POL-4418": (29, 67, 130, 232),
    "POL-4211": (29, 67, 130, 232),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def foreground_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    """Locate the centred moulding while rejecting white background/watermark."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    h, w = rgb.shape[:2]
    border = np.concatenate((rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3),
                             rgb[:, :6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)))
    background = np.percentile(border, 72, axis=0)
    distance = np.sqrt(np.sum((rgb - background[None, None, :]) ** 2, axis=2))
    mask = distance > 15
    columns = np.flatnonzero(mask.sum(axis=0) > max(4, int(h * .07)))
    rows = np.flatnonzero(mask.sum(axis=1) > max(4, int(w * .07)))
    if len(columns) < w * .12 or len(rows) < h * .2:
        return (int(w * .18), int(h * .46), int(w * .82), int(h * .91))
    x0, x1, y0, y1 = columns[0], columns[-1] + 1, rows[0], rows[-1] + 1
    # The cut end occupies the upper portion. The lower 44% is uninterrupted
    # finish and supplies both colour and along-rail surface variation.
    top = int(y0 + (y1 - y0) * .50)
    bottom = int(y0 + (y1 - y0) * .94)
    inset = max(1, int((x1 - x0) * .025))
    return tuple(int(value) for value in
                 (x0 + inset, top, x1 - inset, max(top + 12, bottom)))


def normalise_face(image: Image.Image, crop: tuple[int, int, int, int]) -> np.ndarray:
    face = image.crop(crop).convert("RGB").resize((320, 160), Image.Resampling.LANCZOS)
    values = np.asarray(face, dtype=np.float32)
    illumination = np.asarray(face.filter(ImageFilter.GaussianBlur(18)), dtype=np.float32)
    target = np.median(values.reshape(-1, 3), axis=0)
    corrected = values / np.maximum(illumination, 10.0) * target[None, None, :]
    return np.clip(corrected, 3, 248)


def ridge_signature(face: np.ndarray) -> np.ndarray:
    gray = face.mean(axis=2).mean(axis=0)
    smooth = np.convolve(np.pad(gray, 7, mode="reflect"), np.ones(15) / 15, mode="valid")
    signature = gray - smooth
    return (signature - signature.mean()) / max(signature.std(), 1e-5)


def spin_source(sku: str) -> tuple[Image.Image, list[str], dict[str, list[int]], list[int], str]:
    manifest_path = SOURCE_ROOT / sku / "spin-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    images = manifest["images"]
    centre = len(images) // 2
    selected = images[max(0, centre - 3):min(len(images), centre + 4)]
    faces, crops = [], {}
    for item in selected:
        image = Image.open(SOURCE_ROOT / sku / "spin" / item["filename"])
        crop = LEGACY_OVERRIDES.get(sku) or foreground_bounds(image)
        crops[item["filename"]] = list(crop)
        faces.append(normalise_face(image, crop))
    reference = ridge_signature(faces[len(faces) // 2])
    aligned, shifts = [], []
    for face in faces:
        signature = ridge_signature(face)
        scores = [(shift, float(np.mean(reference[7:-7] * np.roll(signature, shift)[7:-7])))
                  for shift in range(-6, 7)]
        shift = max(scores, key=lambda item: item[1])[0]
        aligned.append(np.roll(face, shift, axis=1))
        shifts.append(int(shift))
    fused = np.median(np.stack(aligned), axis=0).astype(np.uint8)
    return (ImageEnhance.Contrast(Image.fromarray(fused)).enhance(1.08),
            [item["filename"] for item in selected], crops, shifts, manifest["productUrl"])


def catalogue_source(sku: str) -> tuple[Image.Image, list[str], dict[str, list[int]], list[int], str]:
    path = PUBLIC_ROOT / sku / "catalogue/source.png"
    image = Image.open(path).convert("RGB")
    # Catalogue panels place the finish above the exposed substrate.
    crop = (0, 0, image.width, max(16, int(image.height * .56)))
    face = image.crop(crop).resize((320, 160), Image.Resampling.LANCZOS)
    return face, ["catalogue/source.png"], {"catalogue/source.png": list(crop)}, [0], "ml_catalogue.pdf"


def tile_along_rail(face: Image.Image) -> Image.Image:
    along_rail = face.rotate(90, expand=True)
    mirrored = Image.new("RGB", (along_rail.width * 2, along_rail.height))
    mirrored.paste(along_rail, (0, 0))
    mirrored.paste(ImageOps.mirror(along_rail), (along_rail.width, 0))
    return mirrored.resize((1024, 256), Image.Resampling.LANCZOS)


def maps(base: Image.Image) -> tuple[Image.Image, Image.Image]:
    luminance = base.convert("L")
    broad = np.asarray(luminance.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    fine = np.asarray(luminance.filter(ImageFilter.GaussianBlur(1.55)), dtype=np.float32)
    lum = np.asarray(luminance, dtype=np.float32)
    roughness = np.clip(188 + (broad - lum) * .58, 142, 226).astype(np.uint8)
    height = np.clip(128 + (lum - fine) * 3.6, 72, 188).astype(np.uint8)
    return Image.fromarray(roughness), Image.fromarray(height)


def build(sku: str) -> dict:
    source_kind = "spin" if (SOURCE_ROOT / sku / "spin-manifest.json").exists() else "catalogue"
    if source_kind == "spin":
        face, frames, crops, shifts, product_url = spin_source(sku)
    else:
        face, frames, crops, shifts, product_url = catalogue_source(sku)
    output = PUBLIC_ROOT / sku / f"variants/{VARIANT}"
    output.mkdir(parents=True, exist_ok=True)
    base = tile_along_rail(face)
    roughness, bump = maps(base)
    base_path, roughness_path, bump_path = (output / "basecolor.jpg", output / "roughness.jpg", output / "bump.jpg")
    base.save(base_path, quality=95, subsampling=0)
    roughness.save(roughness_path, quality=95)
    bump.save(bump_path, quality=95)
    diagnostic = Image.new("RGB", (1024, 768), "#111")
    diagnostic.paste(base, (0, 0))
    diagnostic.paste(Image.merge("RGB", (roughness,) * 3), (0, 256))
    diagnostic.paste(Image.merge("RGB", (bump,) * 3), (0, 512))
    diagnostic.save(output / "material-diagnostic.jpg", quality=92)
    manifest = {
        "id": VARIANT, "sku": sku, "label": "Supplier-derived PBR material",
        "status": "generated-review-required", "productUrl": product_url,
        "source": source_kind, "frames": frames, "crops": crops,
        "alignmentShiftsPx": shifts,
        "material": {"basecolor": "basecolor.jpg", "roughness": "roughness.jpg", "bump": "bump.jpg",
                     "sha256": {p.name: digest(p) for p in (base_path, roughness_path, bump_path)}},
        "activation": "Automatic visualiser candidate; compare with supplier references",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return {"sku": sku, "source": source_kind, "frames": len(frames), "output": str(output)}


def available_skus() -> list[str]:
    return sorted(path.name for path in SOURCE_ROOT.iterdir() if path.is_dir() and
                  ((path / "spin-manifest.json").exists() or
                   (PUBLIC_ROOT / path.name / "catalogue/source.png").exists()))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sku", action="append", help="Build selected SKUs; omit to build every imported SKU")
    args = parser.parse_args()
    selected = args.sku or available_skus()
    results = [build(sku) for sku in selected]
    index = {result["sku"]: {"variant": VARIANT, "source": result["source"]} for result in results}
    (ROOT / "src/mouldings/mainlineMaterials.json").write_text(json.dumps(index, indent=2) + "\n")
    print(json.dumps({"count": len(results), "variant": VARIANT, "results": results}, indent=2))


if __name__ == "__main__":
    main()
