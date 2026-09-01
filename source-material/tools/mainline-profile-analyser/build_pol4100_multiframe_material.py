#!/usr/bin/env python3
"""Create an isolated POL-4100 material candidate from supplier spin frames only."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SPIN = ROOT / "source-material/mainline/POL-4100/spin"
OUTPUT = ROOT / "public/assets/mouldings/POL-4100/variants/multiframe-experiment-v1"
FRAMES = [20, 21, 22, 23, 24, 25, 26]
CROP = (34, 56, 126, 230)


def normalise_face(image: Image.Image) -> np.ndarray:
    face = image.crop(CROP).convert("RGB")
    values = np.asarray(face, dtype=np.float32)
    illumination = np.asarray(face.filter(ImageFilter.GaussianBlur(18)), dtype=np.float32)
    corrected = values / np.maximum(illumination, 8.0) * 47.0
    return np.clip(corrected, 10, 92)


def ridge_signature(face: np.ndarray) -> np.ndarray:
    gray = face.mean(axis=2).mean(axis=0)
    smooth = np.convolve(np.pad(gray, 7, mode="reflect"), np.ones(15) / 15, mode="valid")
    signature = gray - smooth
    return (signature - signature.mean()) / max(signature.std(), 1e-5)


def aligned_faces() -> tuple[list[np.ndarray], list[int]]:
    faces = [normalise_face(Image.open(SPIN / f"img{n:02}.jpg")) for n in FRAMES]
    reference = ridge_signature(faces[FRAMES.index(23)])
    aligned, shifts = [], []
    for face in faces:
        signature = ridge_signature(face)
        scores = [(shift, float(np.mean(reference[5:-5] * np.roll(signature, shift)[5:-5]))) for shift in range(-4, 5)]
        shift = max(scores, key=lambda item: item[1])[0]
        aligned.append(np.roll(face, shift, axis=1))
        shifts.append(shift)
    return aligned, shifts


def tile_along_rail(face: Image.Image) -> Image.Image:
    along_rail = face.rotate(90, expand=True)
    mirrored = Image.new("RGB", (along_rail.width * 2, along_rail.height))
    mirrored.paste(along_rail, (0, 0))
    mirrored.paste(ImageOps.mirror(along_rail), (along_rail.width, 0))
    return mirrored.resize((1024, 256), Image.Resampling.LANCZOS)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    faces, shifts = aligned_faces()
    fused = np.median(np.stack(faces), axis=0).astype(np.uint8)
    face = ImageEnhance.Contrast(Image.fromarray(fused, "RGB")).enhance(1.2)
    base = tile_along_rail(face)
    base_path = OUTPUT / "basecolor.jpg"
    base.save(base_path, quality=95, subsampling=0)

    luminance = base.convert("L")
    broad = np.asarray(luminance.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    fine = np.asarray(luminance.filter(ImageFilter.GaussianBlur(1.7)), dtype=np.float32)
    lum = np.asarray(luminance, dtype=np.float32)
    roughness = np.clip(182 + (broad - lum) * 0.72, 136, 224).astype(np.uint8)
    height = np.clip(128 + (lum - fine) * 6.2, 58, 198).astype(np.uint8)
    roughness_path, bump_path = OUTPUT / "roughness.jpg", OUTPUT / "bump.jpg"
    Image.fromarray(roughness, "L").save(roughness_path, quality=95)
    Image.fromarray(height, "L").save(bump_path, quality=95)

    diagnostic = Image.new("RGB", (1024, 768), "#111")
    diagnostic.paste(base, (0, 0))
    diagnostic.paste(Image.merge("RGB", (Image.fromarray(roughness),) * 3), (0, 256))
    diagnostic.paste(Image.merge("RGB", (Image.fromarray(height),) * 3), (0, 512))
    diagnostic.save(OUTPUT / "material-diagnostic.jpg", quality=92)

    contact = Image.new("RGB", (157 * len(FRAMES), 255), "white")
    for index, frame in enumerate(FRAMES):
        contact.paste(Image.open(SPIN / f"img{frame:02}.jpg").convert("RGB"), (157 * index, 0))
    contact.save(OUTPUT / "source-frames.jpg", quality=92)

    manifest = {
        "id": "multiframe-experiment-v1",
        "sku": "POL-4100",
        "label": "Supplier spin multi-frame experiment",
        "status": "experimental-inactive",
        "source": "Mainline Lv2 spin images only",
        "frames": [f"img{n:02}.jpg" for n in FRAMES],
        "crop": list(CROP),
        "alignmentShiftsPx": shifts,
        "profile": {"source": "protected baseline-v1", "changed": False},
        "material": {
            "basecolor": "basecolor.jpg",
            "roughness": "roughness.jpg",
            "bump": "bump.jpg",
            "sha256": {path.name: digest(path) for path in (base_path, roughness_path, bump_path)},
        },
        "activation": "Manual review only; cannot overwrite baseline-v1",
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(OUTPUT), "frames": FRAMES, "alignmentShiftsPx": shifts}, indent=2))


if __name__ == "__main__":
    main()
