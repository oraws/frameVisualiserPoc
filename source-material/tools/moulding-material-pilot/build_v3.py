#!/usr/bin/env python3
"""Build long, low-repetition material atlases for the three v3 pilot mouldings."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public/assets/mouldings"
SOURCE = ROOT / "source-material/mainline"
VARIANT = "supplier-derived-v3"
PILOTS = {
    "HS9": {"kind": "stochastic", "physicalLengthMm": 1600},
    "3826BK": {"kind": "ornamental", "physicalLengthMm": 1200},
    "POL-4875": {"kind": "ornamental", "physicalLengthMm": 1200},
}


def source_strip(sku: str) -> Image.Image:
    if sku == "POL-4875":
        # Use only the uninterrupted lower face of the near-frontal spin frame.
        # The v2 multi-view median accidentally mixed the grey cut substrate and
        # white studio surround into the colour map.
        image = Image.open(SOURCE / sku / "spin/img23.jpg").convert("RGB")
        return image.crop((13, 112, 266, 226)).rotate(90, expand=True).resize(
            (1024, 256), Image.Resampling.LANCZOS
        )
    return Image.open(PUBLIC / sku / "base-texture.jpg").convert("RGB").resize(
        (1024, 256), Image.Resampling.LANCZOS
    )


def colour_adjust(patch: np.ndarray, gain: float) -> np.ndarray:
    mean = patch.mean(axis=(0, 1), keepdims=True)
    return np.clip(mean + (patch - mean) * gain, 0, 255)


def quilt(source: Image.Image, sku: str, width: int = 4096) -> Image.Image:
    """Overlap-match patches only along the rail axis; profile detail is untouched."""
    rng = np.random.default_rng(int(hashlib.sha256(sku.encode()).hexdigest()[:8], 16))
    src = np.asarray(source, dtype=np.float32)
    height, source_width = src.shape[:2]
    patch_width, overlap = 448, 128
    starts = list(range(0, source_width - patch_width + 1, 16))
    canvas = np.zeros((height, width, 3), dtype=np.float32)
    filled = 0
    previous_start = -1
    while filled < width:
        available = min(patch_width, width - filled)
        candidates: list[tuple[float, int, bool, np.ndarray]] = []
        for start in starts:
            for mirrored in (False, True):
                candidate = src[:, start:start + patch_width]
                if mirrored:
                    candidate = candidate[:, ::-1]
                if filled == 0:
                    score = float(rng.random())
                else:
                    span = min(overlap, available, filled)
                    left = canvas[:, filled - span:filled]
                    right = candidate[:, :span]
                    # Compare local detail after removing broad exposure changes.
                    left_detail = left - left.mean(axis=1, keepdims=True)
                    right_detail = right - right.mean(axis=1, keepdims=True)
                    score = float(np.mean((left_detail - right_detail) ** 2))
                    if start == previous_start:
                        score *= 1.35
                candidates.append((score, start, mirrored, candidate))
        candidates.sort(key=lambda item: item[0])
        score, previous_start, mirrored, selected = candidates[int(rng.integers(0, min(4, len(candidates))))]
        selected = colour_adjust(selected, float(rng.uniform(.97, 1.03)))
        if filled == 0:
            canvas[:, :available] = selected[:, :available]
            filled += available
            continue
        span = min(overlap, available, filled)
        destination = filled - span
        usable = min(patch_width, width - destination)
        alpha = np.ones(usable, dtype=np.float32)
        alpha[:span] = .5 - .5 * np.cos(np.linspace(0, np.pi, span, dtype=np.float32))
        canvas[:, destination:destination + usable] = (
            canvas[:, destination:destination + usable] * (1 - alpha[None, :, None])
            + selected[:, :usable] * alpha[None, :, None]
        )
        filled = destination + usable
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGB")


def pbr_maps(base: Image.Image) -> tuple[Image.Image, Image.Image]:
    luminance = base.convert("L")
    broad = np.asarray(luminance.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    fine = np.asarray(luminance.filter(ImageFilter.GaussianBlur(1.6)), dtype=np.float32)
    values = np.asarray(luminance, dtype=np.float32)
    roughness = np.clip(188 + (broad - values) * .58, 142, 226).astype(np.uint8)
    bump = np.clip(128 + (values - fine) * 3.2, 76, 184).astype(np.uint8)
    return Image.fromarray(roughness, "L"), Image.fromarray(bump, "L")


def periodicity(image: Image.Image) -> float:
    signal = np.asarray(image.convert("L").resize((1024, 64)), dtype=np.float32).mean(axis=0)
    signal -= signal.mean()
    denominator = float(np.dot(signal, signal)) or 1
    return round(max(float(np.dot(signal[:-lag], signal[lag:]) / denominator)
                     for lag in range(48, 512)), 4)


def build(sku: str, settings: dict) -> dict:
    source = source_strip(sku)
    base = ImageEnhance.Contrast(quilt(source, sku)).enhance(1.03)
    roughness, bump = pbr_maps(base)
    output = PUBLIC / sku / "variants" / VARIANT
    output.mkdir(parents=True, exist_ok=True)
    for name, image in (("basecolor.jpg", base), ("roughness.jpg", roughness), ("bump.jpg", bump)):
        image.save(output / name, quality=94, subsampling=0)
    diagnostic = Image.new("RGB", (2048, 384), "#111")
    diagnostic.paste(base.resize((2048, 128)), (0, 0))
    diagnostic.paste(Image.merge("RGB", (roughness,) * 3).resize((2048, 128)), (0, 128))
    diagnostic.paste(Image.merge("RGB", (bump,) * 3).resize((2048, 128)), (0, 256))
    diagnostic.save(output / "material-diagnostic.jpg", quality=92)
    manifest = {
        "id": VARIANT,
        "sku": sku,
        "status": "three-sku-pilot",
        "method": "deterministic-overlap-quilting-v1",
        "finishClass": settings["kind"],
        "atlasPixels": [base.width, base.height],
        "physicalLengthMm": settings["physicalLengthMm"],
        "maximumAutocorrelation": periodicity(base),
        "source": "spin/img23.jpg" if sku == "POL-4875" else "base-texture.jpg",
        "activation": "Pilot only; compare in live visualiser before batch promotion",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    results = {sku: build(sku, settings) for sku, settings in PILOTS.items()}
    index = {sku: {"variant": VARIANT,
                   "physicalLengthMm": result["physicalLengthMm"],
                   "finishClass": result["finishClass"]}
             for sku, result in results.items()}
    (ROOT / "src/mouldings/materialPilotsV3.json").write_text(json.dumps(index, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
