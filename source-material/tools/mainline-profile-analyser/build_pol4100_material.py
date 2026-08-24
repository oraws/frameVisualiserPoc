#!/usr/bin/env python3
"""Build conservative POL-4100 PBR maps from the supplier product photograph.

The crop is taken from the uninterrupted front face of the upright moulding.
Large photographic lighting gradients are removed while the fine vertical brush
marks are retained. The strip is then rotated into rail direction and mirrored
at its repeat boundary so it tiles without a visible join.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public/assets/mouldings/POL-4100/source-product.jpg"
OUTPUT = ROOT / "public/assets/mouldings/POL-4100"


def seamless_strip(image: Image.Image) -> Image.Image:
    # An inset crop avoids the photographed side face, bevel and floor shadow.
    face = image.crop((674, 286, 726, 526)).convert("RGB")
    values = np.asarray(face, dtype=np.float32)
    illumination = np.asarray(face.filter(ImageFilter.GaussianBlur(24)), dtype=np.float32)
    corrected = values / np.maximum(illumination, 8.0) * 47.0
    corrected = np.clip(corrected, 12, 88).astype(np.uint8)
    face = Image.fromarray(corrected, "RGB")
    face = ImageEnhance.Contrast(face).enhance(1.12)

    along_rail = face.rotate(90, expand=True)
    mirrored = Image.new("RGB", (along_rail.width * 2, along_rail.height))
    mirrored.paste(along_rail, (0, 0))
    mirrored.paste(ImageOps.mirror(along_rail), (along_rail.width, 0))
    return mirrored.resize((1024, 256), Image.Resampling.LANCZOS)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    base = seamless_strip(Image.open(SOURCE))
    base.save(OUTPUT / "basecolor.jpg", quality=94, subsampling=0)

    luminance = base.convert("L")
    broad = luminance.filter(ImageFilter.GaussianBlur(12))
    fine = luminance.filter(ImageFilter.GaussianBlur(2.2))
    lum = np.asarray(luminance, dtype=np.float32)
    broad_values = np.asarray(broad, dtype=np.float32)
    fine_values = np.asarray(fine, dtype=np.float32)

    # Brighter rubbed fibres are fractionally smoother; dark grooves rougher.
    roughness = np.clip(176 + (broad_values - lum) * 0.7, 130, 218).astype(np.uint8)
    Image.fromarray(roughness, "L").save(OUTPUT / "roughness.jpg", quality=94)

    # Retain the fine, parallel supplier-image ridges. They remain shallow in
    # geometry, but need enough tonal separation to survive browser mipmapping.
    height = np.clip(128 + (lum - fine_values) * 5.0, 64, 192).astype(np.uint8)
    Image.fromarray(height, "L").save(OUTPUT / "bump.jpg", quality=94)

    preview = Image.new("RGB", (1024, 768), "#111")
    preview.paste(base, (0, 0))
    preview.paste(Image.merge("RGB", (Image.fromarray(roughness),) * 3), (0, 256))
    preview.paste(Image.merge("RGB", (Image.fromarray(height),) * 3), (0, 512))
    preview.save(OUTPUT / "material-diagnostic.jpg", quality=92)

    print(f"Wrote POL-4100 material maps to {OUTPUT}")


if __name__ == "__main__":
    main()
