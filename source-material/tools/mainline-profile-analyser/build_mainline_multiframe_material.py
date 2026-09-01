#!/usr/bin/env python3
"""Build isolated PBR material candidates from Mainline supplier spin frames."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
CONFIG = {
    # Keep the black face isolated: the silver sight edge is modelled as its own rail.
    "POL-4508": {"frames": list(range(20, 27)), "crop": (88, 78, 125, 226), "contrast": 1.18, "height": 5.2},
    "POL-4418": {"frames": list(range(20, 27)), "crop": (29, 67, 130, 232), "contrast": 1.12, "height": 4.8},
    "POL-4211": {"frames": list(range(20, 27)), "crop": (29, 67, 130, 232), "contrast": 1.08, "height": 5.4},
}


def normalise_face(image: Image.Image, crop: tuple[int, int, int, int]) -> np.ndarray:
    face = image.crop(crop).convert("RGB")
    values = np.asarray(face, dtype=np.float32)
    illumination = np.asarray(face.filter(ImageFilter.GaussianBlur(18)), dtype=np.float32)
    target = np.median(values.reshape(-1, 3), axis=0)
    corrected = values / np.maximum(illumination, 10.0) * target[None, None, :]
    return np.clip(corrected, 4, 245)


def ridge_signature(face: np.ndarray) -> np.ndarray:
    gray = face.mean(axis=2).mean(axis=0)
    smooth = np.convolve(np.pad(gray, 7, mode="reflect"), np.ones(15) / 15, mode="valid")
    signature = gray - smooth
    return (signature - signature.mean()) / max(signature.std(), 1e-5)


def fuse_faces(sku: str, config: dict) -> tuple[Image.Image, list[int]]:
    spin = ROOT / "source-material/mainline" / sku / "spin"
    faces = [normalise_face(Image.open(spin / f"img{n:02}.jpg"), config["crop"]) for n in config["frames"]]
    reference = ridge_signature(faces[config["frames"].index(23)])
    aligned, shifts = [], []
    for face in faces:
        signature = ridge_signature(face)
        scores = [(shift, float(np.mean(reference[5:-5] * np.roll(signature, shift)[5:-5]))) for shift in range(-4, 5)]
        shift = max(scores, key=lambda item: item[1])[0]
        aligned.append(np.roll(face, shift, axis=1))
        shifts.append(shift)
    fused = np.median(np.stack(aligned), axis=0).astype(np.uint8)
    return ImageEnhance.Contrast(Image.fromarray(fused, "RGB")).enhance(config["contrast"]), shifts


def tile_along_rail(face: Image.Image) -> Image.Image:
    along_rail = face.rotate(90, expand=True)
    mirrored = Image.new("RGB", (along_rail.width * 2, along_rail.height))
    mirrored.paste(along_rail, (0, 0))
    mirrored.paste(ImageOps.mirror(along_rail), (along_rail.width, 0))
    return mirrored.resize((1024, 256), Image.Resampling.LANCZOS)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(sku: str) -> None:
    config = CONFIG[sku]
    output = ROOT / "public/assets/mouldings" / sku / "variants/multiframe-experiment-v1"
    output.mkdir(parents=True, exist_ok=True)
    face, shifts = fuse_faces(sku, config)
    base = tile_along_rail(face)
    base_path = output / "basecolor.jpg"
    base.save(base_path, quality=95, subsampling=0)

    luminance = base.convert("L")
    broad = np.asarray(luminance.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    fine = np.asarray(luminance.filter(ImageFilter.GaussianBlur(1.7)), dtype=np.float32)
    lum = np.asarray(luminance, dtype=np.float32)
    roughness = np.clip(184 + (broad - lum) * 0.65, 138, 226).astype(np.uint8)
    height = np.clip(128 + (lum - fine) * config["height"], 58, 198).astype(np.uint8)
    roughness_path, bump_path = output / "roughness.jpg", output / "bump.jpg"
    Image.fromarray(roughness, "L").save(roughness_path, quality=95)
    Image.fromarray(height, "L").save(bump_path, quality=95)

    diagnostic = Image.new("RGB", (1024, 768), "#111")
    diagnostic.paste(base, (0, 0))
    diagnostic.paste(Image.merge("RGB", (Image.fromarray(roughness),) * 3), (0, 256))
    diagnostic.paste(Image.merge("RGB", (Image.fromarray(height),) * 3), (0, 512))
    diagnostic.save(output / "material-diagnostic.jpg", quality=92)

    spin = ROOT / "source-material/mainline" / sku / "spin"
    contact = Image.new("RGB", (157 * len(config["frames"]), 255), "white")
    for index, frame in enumerate(config["frames"]):
        contact.paste(Image.open(spin / f"img{frame:02}.jpg").convert("RGB"), (157 * index, 0))
    contact.save(output / "source-frames.jpg", quality=92)

    manifest_path = ROOT / "source-material/mainline" / sku / "spin-manifest.json"
    source_manifest = json.loads(manifest_path.read_text())
    manifest = {
        "id": "multiframe-experiment-v1", "sku": sku,
        "label": "Supplier spin multi-frame experiment", "status": "experimental",
        "productUrl": source_manifest["productUrl"], "source": "Mainline Lv2 spin images only",
        "frames": [f"img{n:02}.jpg" for n in config["frames"]], "crop": list(config["crop"]),
        "alignmentShiftsPx": shifts,
        "material": {"basecolor": "basecolor.jpg", "roughness": "roughness.jpg", "bump": "bump.jpg",
                     "sha256": {path.name: digest(path) for path in (base_path, roughness_path, bump_path)}},
        "activation": "Manual review required",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"sku": sku, "output": str(output), "frames": config["frames"], "shifts": shifts}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sku", choices=CONFIG, action="append", required=True)
    args = parser.parse_args()
    for sku in args.sku:
        build(sku)


if __name__ == "__main__":
    main()
