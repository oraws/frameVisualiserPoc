#!/usr/bin/env python3
"""Iteratively improve and audit moulding materials against supplier imagery.

The vision model is advisory. Deterministic colour, seam, repetition and detail
gates always run and this script never promotes a candidate.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
from datetime import datetime, timezone
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "source-material/mainline"
PUBLIC_ROOT = ROOT / "public/assets/mouldings"
FAMILY_REFERENCE_MANIFEST = ROOT / "public/assets/moulding-families/manifest.json"
INPUT_VARIANTS = ("supplier-derived-v3", "supplier-derived-v2")
NORMALIZED_INPUT_VARIANT = "normalized-legacy-v1"
DEFAULT_OUTPUT_VARIANT = "supplier-matched-v4-candidate"


@dataclass
class Settings:
    seed: int = 0
    colour_strength: float = .72
    contrast: float = 1.02
    patch_width: int = 448
    overlap: int = 160
    roughness_mid: float = 188
    roughness_detail: float = .58
    bump_detail: float = 3.2


DEFAULT_LIMITS = {
    "colourDeltaE": 8.0,
    "colourSpreadError": .35,
    "seamError": .055,
    "maximumAutocorrelation": .62,
    "detailError": .38,
    "clippedPixels": .025,
    "minimumScore": 76.0,
}


def progress(value: int, message: str) -> None:
    print(f"MATERIAL_PROGRESS {value} {message}", flush=True)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def srgb_to_lab(image: Image.Image, size: tuple[int, int]) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB").resize(size, Image.Resampling.LANCZOS), dtype=np.float32) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    matrix = np.array([[.4124564, .3575761, .1804375], [.2126729, .7151522, .0721750],
                       [.0193339, .1191920, .9503041]], dtype=np.float32)
    xyz = np.einsum("...j,ij->...i", linear, matrix) / np.array([.95047, 1., 1.08883], dtype=np.float32)
    delta = 6 / 29
    f = np.where(xyz > delta ** 3, np.cbrt(xyz), xyz / (3 * delta ** 2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])), axis=-1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    f = np.stack((fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200), axis=-1)
    delta = 6 / 29
    xyz = np.where(f > delta, f ** 3, 3 * delta ** 2 * (f - 4 / 29))
    xyz *= np.array([.95047, 1., 1.08883], dtype=np.float32)
    matrix = np.array([[.4124564, .3575761, .1804375], [.2126729, .7151522, .0721750],
                       [.0193339, .1191920, .9503041]], dtype=np.float32)
    linear = np.einsum("...j,ij->...i", xyz, np.linalg.inv(matrix))
    rgb = np.where(linear <= .0031308, 12.92 * linear,
                   1.055 * np.maximum(linear, 0) ** (1 / 2.4) - .055)
    return np.clip(rgb * 255, 0, 255).astype(np.uint8)


def lab_stats(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    lab = srgb_to_lab(image, (512, 128)).reshape(-1, 3)
    low, high = np.percentile(lab, (5, 95), axis=0)
    kept = lab[np.all((lab >= low) & (lab <= high), axis=1)]
    return np.median(kept, axis=0), np.maximum(np.std(kept, axis=0), .5)


def colour_transfer(image: Image.Image, reference: Image.Image, strength: float) -> Image.Image:
    lab = srgb_to_lab(image, image.size)
    source_mean, source_std = lab_stats(image)
    target_mean, target_std = lab_stats(reference)
    matched = (lab - source_mean) * np.clip(target_std / source_std, .72, 1.35) + target_mean
    return Image.fromarray(lab_to_srgb(lab * (1 - strength) + matched * strength))


def constrain_colour_to_source(image: Image.Image, source: Image.Image) -> Image.Image:
    """Keep synthesis from adopting the supplier photograph's studio backdrop.

    The retained material atlas is the reliable global-colour measurement. Room
    photographs and profile sheets remain useful visual evidence, but often
    contain far more pale wall or paper pixels than moulding pixels.
    """
    lab = srgb_to_lab(image, image.size)
    candidate_mean, _ = lab_stats(image)
    source_mean, _ = lab_stats(source)
    permitted_delta = np.array([4., 3., 3.], dtype=np.float32)
    desired_mean = source_mean + np.clip(candidate_mean - source_mean,
                                         -permitted_delta, permitted_delta)
    corrected = lab + (desired_mean - candidate_mean)
    return Image.fromarray(lab_to_srgb(corrected))


def trim_studio_background(image: Image.Image) -> Image.Image:
    """Remove plain supplier-photo surround without trimming pale mouldings."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    height, width = rgb.shape[:2]
    border = np.concatenate((rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3),
                             rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)))
    background = np.percentile(border, 75, axis=0)
    distance = np.linalg.norm(rgb - background[None, None, :], axis=2)
    # A soft studio shadow differs slightly from white but is not product
    # colour. Scale the cut-off to the actual foreground/background separation.
    threshold = max(14., float(np.percentile(distance, 55)) * .35)
    mask = distance > threshold
    def largest_run(indices: np.ndarray) -> np.ndarray:
        if not len(indices):
            return indices
        splits = np.split(indices, np.where(np.diff(indices) > 1)[0] + 1)
        return max(splits, key=len)

    columns = largest_run(np.flatnonzero(mask.sum(axis=0) > max(3, int(height * .18))))
    rows = largest_run(np.flatnonzero(mask.sum(axis=1) > max(3, int(width * .12))))
    if len(columns) < width * .12 or len(rows) < height * .18:
        return image
    x0, x1, y0, y1 = columns[0], columns[-1] + 1, rows[0], rows[-1] + 1
    inset_x, inset_y = max(0, int((x1 - x0) * .015)), max(0, int((y1 - y0) * .015))
    return image.crop((x0 + inset_x, y0 + inset_y, x1 - inset_x, y1 - inset_y))


def _captioned_panel(image: Image.Image, caption: str, family: bool = False) -> Image.Image:
    panel = ImageOps.fit(image.convert("RGB"), (384, 192))
    draw = ImageDraw.Draw(panel)
    draw.rectangle((0, 164, 384, 192), fill="#6c4a21" if family else "#151515")
    draw.text((10, 172), caption[:58], fill="white")
    return panel


def _family_references(sku: str) -> list[dict[str, Any]]:
    if not FAMILY_REFERENCE_MANIFEST.exists():
        return []
    try:
        payload = json.loads(FAMILY_REFERENCE_MANIFEST.read_text())
        return list(payload.get("bySku", {}).get(sku, []))
    except (OSError, json.JSONDecodeError, TypeError):
        return []


def reference_board(sku: str, manifest: dict[str, Any]) -> tuple[Image.Image, list[str], list[str]]:
    paths: list[Path] = []
    panels: list[Image.Image] = []
    crops = manifest.get("crops", {})
    for filename in manifest.get("frames", []):
        path = SOURCE_ROOT / sku / "spin" / filename
        if not path.exists():
            continue
        image = Image.open(path).convert("RGB")
        crop = crops.get(filename)
        if crop and len(crop) == 4:
            image = image.crop(tuple(crop))
        image = trim_studio_background(image)
        # Spin photographs stand the rail vertically. The material atlas runs
        # along a horizontal rail, so compare both in the same orientation.
        image = image.rotate(90, expand=True)
        panels.append(_captioned_panel(image, "EXACT SKU · rotation"))
        paths.append(path)
    for filename in manifest.get("referenceFiles", []):
        path = PUBLIC_ROOT / sku / filename
        if not path.exists() or path in paths:
            continue
        panels.append(_captioned_panel(Image.open(path), f"EXACT SKU · {Path(filename).stem}"))
        paths.append(path)
    if not panels:
        for name in ("source-product.jpg", "product-section.jpg", "chevron.jpg", "macro.jpg",
                     "framed-reference.jpg", "profile-source.jpg", "profile-source.png", "base-texture.jpg"):
            path = PUBLIC_ROOT / sku / name
            if path.exists():
                panels.append(_captioned_panel(Image.open(path), f"EXACT SKU · {path.stem}"))
                paths.append(path)
    if not panels:
        raise FileNotFoundError(f"No supplier reference imagery found for {sku}")
    family_panels: list[Image.Image] = []
    family_paths: list[Path] = []
    for reference in _family_references(sku):
        url = str(reference.get("url", ""))
        path = ROOT / "public" / url.lstrip("/")
        if not url or not path.exists() or path in family_paths:
            continue
        family = str(reference.get("family", "family"))
        family_panels.append(_captioned_panel(Image.open(path), f"FAMILY CONTEXT · {family}", True))
        family_paths.append(path)
    width = 384 * max(len(panels), len(family_panels), 1)
    height = 222 + (222 if family_panels else 0)
    board = Image.new("RGB", (width, height), "#171717")
    ImageDraw.Draw(board).text((10, 8), "EXACT SKU SUPPLIER PHOTOGRAPHS — AUTHORITATIVE", fill="white")
    for index, panel in enumerate(panels):
        board.paste(panel, (index * 384, 30))
    if family_panels:
        ImageDraw.Draw(board).text((10, 230), "ASSEMBLED FAMILY REFERENCES — CONTEXT ONLY", fill="#e9b36f")
        for index, panel in enumerate(family_panels):
            board.paste(panel, (index * 384, 252))
    return (board, [str(path.relative_to(ROOT)) for path in paths],
            [str(path.relative_to(ROOT)) for path in family_paths])


def quilt(source: Image.Image, settings: Settings, width: int = 4096) -> Image.Image:
    rng = np.random.default_rng(settings.seed)
    src = np.asarray(source.convert("RGB").resize((1024, 256), Image.Resampling.LANCZOS), dtype=np.float32)
    patch_width = min(settings.patch_width, src.shape[1])
    overlap = min(settings.overlap, patch_width // 2)
    starts = list(range(0, src.shape[1] - patch_width + 1, 24))
    canvas = np.zeros((256, width, 3), dtype=np.float32)
    filled = 0
    history: list[int] = []
    while filled < width:
        choices: list[tuple[float, int, np.ndarray]] = []
        for start in starts:
            for mirrored in (False, True):
                patch = src[:, start:start + patch_width]
                if mirrored:
                    patch = patch[:, ::-1]
                if filled == 0:
                    score = float(rng.random())
                else:
                    span = min(overlap, filled)
                    left, right = canvas[:, filled - span:filled], patch[:, :span]
                    left = left - left.mean(axis=1, keepdims=True)
                    right = right - right.mean(axis=1, keepdims=True)
                    score = float(np.mean((left - right) ** 2)) * (1.7 if start in history[-2:] else 1)
                choices.append((score, start, patch))
        choices.sort(key=lambda item: item[0])
        _, start, selected = choices[int(rng.integers(0, min(5, len(choices))))]
        history.append(start)
        if filled == 0:
            usable = min(patch_width, width)
            canvas[:, :usable], filled = selected[:, :usable], usable
            continue
        destination = filled - overlap
        usable = min(patch_width, width - destination)
        alpha = np.ones(usable, dtype=np.float32)
        alpha[:overlap] = .5 - .5 * np.cos(np.linspace(0, np.pi, overlap, dtype=np.float32))
        canvas[:, destination:destination + usable] = (canvas[:, destination:destination + usable]
            * (1 - alpha[None, :, None]) + selected[:, :usable] * alpha[None, :, None])
        filled = destination + usable
    edge = min(192, width // 8)
    blend = .5 - .5 * np.cos(np.linspace(0, np.pi, edge, dtype=np.float32))
    common = canvas[:, :edge] * (1 - blend[None, :, None]) + canvas[:, -edge:] * blend[None, :, None]
    canvas[:, :edge] = common
    canvas[:, -edge:] = common
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))


def pbr_maps(base: Image.Image, settings: Settings) -> tuple[Image.Image, Image.Image]:
    luminance = base.convert("L")
    broad = np.asarray(luminance.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    fine = np.asarray(luminance.filter(ImageFilter.GaussianBlur(1.6)), dtype=np.float32)
    values = np.asarray(luminance, dtype=np.float32)
    roughness = np.clip(settings.roughness_mid + (broad - values) * settings.roughness_detail,
                        118, 235).astype(np.uint8)
    bump = np.clip(128 + (values - fine) * settings.bump_detail, 64, 196).astype(np.uint8)
    return Image.fromarray(roughness), Image.fromarray(bump)


def periodicity(image: Image.Image) -> float:
    signal = np.asarray(image.convert("L").resize((2048, 64)), dtype=np.float32).mean(axis=0)
    signal -= signal.mean()
    denominator = float(np.dot(signal, signal)) or 1
    return float(max(np.dot(signal[:-lag], signal[lag:]) / denominator for lag in range(96, 1024)))


def detail_strength(image: Image.Image) -> float:
    gray = np.asarray(image.convert("L").resize((1024, 128)), dtype=np.float32) / 255
    smooth = np.asarray(Image.fromarray((gray * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)), dtype=np.float32) / 255
    return float(np.std(gray - smooth))


def metrics(base: Image.Image, reference: Image.Image) -> dict[str, float]:
    candidate_mean, candidate_std = lab_stats(base)
    reference_mean, reference_std = lab_stats(reference)
    rgb = np.asarray(base, dtype=np.uint8)
    resized = np.asarray(base.resize((2048, 128)), dtype=np.float32) / 255
    values = {
        "colourDeltaE": float(np.linalg.norm(candidate_mean - reference_mean)),
        "colourSpreadError": float(np.mean(np.abs(np.log(candidate_std / reference_std)))),
        "seamError": float(np.mean(np.abs(resized[:, :64] - resized[:, -64:]))),
        "maximumAutocorrelation": periodicity(base),
        "detailError": abs(detail_strength(base) / max(detail_strength(reference), .002) - 1),
        "clippedPixels": float(np.mean(np.any((rgb <= 3) | (rgb >= 252), axis=2))),
    }
    return {name: round(value, 4) for name, value in values.items()}


def score_metrics(values: dict[str, float], limits: dict[str, float]) -> tuple[float, list[str]]:
    weights = {"colourDeltaE": 30, "colourSpreadError": 12, "seamError": 18,
               "maximumAutocorrelation": 22, "detailError": 12, "clippedPixels": 6}
    deductions, failures = 0., []
    for name, weight in weights.items():
        ratio = values[name] / limits[name]
        deductions += weight * min(max(ratio - .35, 0) / 1.15, 1)
        if values[name] > limits[name]:
            failures.append(name)
    return round(max(0, 100 - deductions), 1), failures


def fixed_light_preview(base: Image.Image, roughness: Image.Image, bump: Image.Image) -> Image.Image:
    colour = np.asarray(base.resize((1600, 320)), dtype=np.float32) / 255
    rough = np.asarray(roughness.resize((1600, 320)), dtype=np.float32) / 255
    height = np.asarray(bump.resize((1600, 320)), dtype=np.float32) / 255
    y, x = np.mgrid[0:320, 0:1600]
    diffuse = .72 + .25 * np.clip(1 - x / 1350 - y / 900, 0, 1)
    highlight = np.exp(-((x - 420) / 260) ** 2 - ((y - 80) / 95) ** 2) * (1 - rough) * .35
    rendered = np.clip(colour * (diffuse[..., None] + (height[..., None] - .5) * .18)
                       + highlight[..., None], 0, 1)
    return Image.fromarray((rendered * 255).astype(np.uint8))


def make_review_board(reference: Image.Image, base: Image.Image, preview: Image.Image,
                      values: dict[str, float], attempt: int) -> Image.Image:
    board = Image.new("RGB", (1600, 1080), "#171717")
    contained = ImageOps.contain(reference, (1600, 390))
    board.paste(contained, ((1600 - contained.width) // 2, 0))
    board.paste(base.resize((1600, 320)), (0, 420))
    board.paste(preview, (0, 760))
    draw = ImageDraw.Draw(board)
    draw.text((18, 398), "SUPPLIER EVIDENCE: EXACT SKU ABOVE FAMILY CONTEXT", fill="white")
    draw.text((18, 742), f"CANDIDATE {attempt} / FIXED-LIGHT MATERIAL PREVIEW", fill="white")
    draw.text((18, 1052), "  ".join(f"{key}: {value}" for key, value in values.items()), fill="white")
    return board


def build_profile_candidate(sku: str, reference: Image.Image, output: Path,
                            agents: "OllamaAgents", fault: str) -> dict[str, Any]:
    """Create a constrained physical cross-section and visually audit it.

    Supplier metadata fixes the dimensional envelope. The vision model classifies
    the visible face and edges, but cannot invent dimensions outside that envelope.
    """
    metadata_path = SOURCE_ROOT / sku / "product-metadata.json"
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    supplier_profile_path = PUBLIC_ROOT / sku / "profile.json"
    supplier_profile = json.loads(supplier_profile_path.read_text()) if supplier_profile_path.exists() else {}
    dimensions = metadata.get("dimensions", {})
    known_fallbacks = {
        "POL-4100": {"widthMm": 41, "depthMm": 13, "rebateMm": 9, "profileType": "flat"},
        "POL-4508": {"widthMm": 30, "depthMm": 30, "rebateMm": 13, "profileType": "flat"},
    }
    fallback = known_fallbacks.get(sku, {})
    width = float(dimensions.get("widthMm", supplier_profile.get("widthMm", fallback.get("widthMm", 40))))
    depth = float(dimensions.get("depthMm", supplier_profile.get("depthMm", fallback.get("depthMm", 20))))
    rebate = float(dimensions.get("rebateMm", supplier_profile.get("rebateMm", fallback.get("rebateMm", min(12, depth * .65)))))
    supplier_shape = str(metadata.get("details", {}).get("profile",
                         supplier_profile.get("profileType", fallback.get("profileType", "")))).lower()
    catalogue = PUBLIC_ROOT / sku / "catalogue" / "source.png"
    evidence = Image.new("RGB", (1600, 900), "#171717")
    contained = ImageOps.contain(reference, (1600, 400))
    evidence.paste(contained, ((1600 - contained.width) // 2, 0))
    if catalogue.exists():
        evidence.paste(ImageOps.contain(Image.open(catalogue).convert("RGB"), (700, 420)), (40, 430))
    draw = ImageDraw.Draw(evidence)
    draw.text((780, 450), f"SUPPLIER DIMENSIONS: {width:g} x {depth:g} mm; rebate {rebate:g} mm", fill="white")
    draw.text((780, 485), f"SUPPLIER PROFILE LABEL: {supplier_shape or 'not supplied'}", fill="white")
    draw.text((40, 865), "CATALOGUE / EXTRACTED PROFILE GUIDE — VERIFY EVERY FEATURE IN EXACT PHOTOGRAPHS", fill="#e9b36f")
    evidence_path = output / "profile-evidence.jpg"
    evidence.save(evidence_path, quality=94)
    progress(12, f"Analysing the physical profile with {agents.model or 'supplier metadata'}…")
    profile_analysis = agents.ask("moulding profile analyst",
        "The evidence board explicitly labels exact SKU photographs and assembled family context. Exact SKU photographs and physical sections are authoritative. "
        "Family references show the intended assembled appearance and may support a shared shape family, but never use them to override exact SKU colour, finish or cross-section geometry. "
        "The lower panel contains a catalogue image or an extracted profile guide when available. "
        "Treat the lower profile as an unverified hypothesis: it can suggest geometry, but it may include segmentation edges, shadows or background as false ridges. "
        "For every ridge, bead, bevel, hollow or step, require independent confirmation in a physical section, chevron or oblique rotation photograph. "
        "When the guide conflicts with photographs, the photographs win. A flat sample must remain one planar face; do not turn a highlight, shadow or red trace fluctuation into geometry. "
        "Return shapeClass (flat|convex|concave|stepped|ornate), faceCrownMm (0..6), innerEdgeRadiusMm (0.2..4), "
        "outerEdgeRadiusMm (0.2..4), flatFaceConfirmed (boolean), catalogueTraceAgreement (agree|partial|conflicts|uncertain), "
        "verifiedFeatures (array), rejectedTraceFeatures (array), observations (array), and concerns (array). Preserve the supplied dimensional envelope. "
        f"User's editable request: {fault}", evidence_path) or {}
    requested_shape = str(profile_analysis.get("shapeClass", supplier_shape or "flat")).lower()
    shape = requested_shape if requested_shape in {"flat", "convex", "concave", "stepped", "ornate"} else \
        ("flat" if "flat" in supplier_shape else "stepped")
    crown = 0.0 if shape == "flat" else min(6., max(0., float(profile_analysis.get("faceCrownMm", 1.5))))
    inner_radius = min(4., max(.25, float(profile_analysis.get("innerEdgeRadiusMm", .9))))
    outer_radius = min(4., max(.25, float(profile_analysis.get("outerEdgeRadiusMm", .8))))
    if shape == "flat":
        # Large radii make a genuinely flat face read as a raised perimeter ridge
        # under grazing light. Keep only a minimally broken edge unless the
        # photographs justify a shaped profile instead.
        inner_radius, outer_radius = min(inner_radius, .4), min(outer_radius, .4)
    rebate_floor = max(.5, depth - rebate)
    face_start = min(max(inner_radius, .35), width * .12)
    face_end = max(face_start + 1, width - outer_radius)
    supplied_points = supplier_profile.get("points")
    if shape != "flat" and isinstance(supplied_points, list) and len(supplied_points) >= 3:
        points = [[round(min(width, max(0., float(point[0]))), 3),
                   round(min(depth + 6., max(0., float(point[1]))), 3)]
                  for point in supplied_points if isinstance(point, list) and len(point) >= 2]
        points.sort(key=lambda point: point[0])
    else:
        points = [
            [0., round(rebate_floor, 3)],
            [round(face_start * .42, 3), round(depth - inner_radius * .7, 3)],
            [round(face_start, 3), round(depth, 3)],
        ]
        samples = 8 if crown else 2
        for index in range(1, samples):
            t = index / samples
            z = depth + crown * np.sin(np.pi * t)
            points.append([round(face_start + (face_end - face_start) * t, 3), round(float(z), 3)])
        points.extend([[round(face_end, 3), round(depth, 3)],
                       [round(width, 3), round(max(rebate_floor, depth - outer_radius * .55), 3)]])
    candidate = {"schemaVersion": 1, "sku": sku, "source": "supplier-metadata-and-vision-review",
                 "shapeClass": shape, "widthMm": width, "depthMm": depth, "rebateMm": rebate,
                 "points": points, "analysis": profile_analysis}
    (output / "profile-candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")

    board = evidence.copy()
    graph = Image.new("RGB", (760, 360), "#f0eee8")
    gd = ImageDraw.Draw(graph)
    mapped = [(35 + u / width * 690, 320 - z / max(depth + crown, 1) * 275) for u, z in points]
    material_polygon = mapped + [(725, 320), (35, 320)]
    gd.polygon(material_polygon, fill="#d4b27c")
    gd.line(mapped, fill="#9c6b35", width=7, joint="curve")
    gd.line([(35, 320), (725, 320)], fill="#686868", width=2)
    gd.text((35, 18), "CANDIDATE CROSS-SECTION — INNER SIGHT EDGE TO OUTER EDGE", fill="#202020")
    rebate_top = 320 - depth / max(depth + crown, 1) * 275
    rebate_bottom = 320 - rebate_floor / max(depth + crown, 1) * 275
    gd.line([(70, rebate_top), (70, rebate_bottom)], fill="#2f5d50", width=3)
    gd.line([(62, rebate_top), (78, rebate_top)], fill="#2f5d50", width=3)
    gd.line([(62, rebate_bottom), (78, rebate_bottom)], fill="#2f5d50", width=3)
    gd.text((84, (rebate_top + rebate_bottom) / 2 - 7), f"REBATE DROP {rebate:g} mm", fill="#24483e")
    board.paste(graph, (800, 395))
    board_path = output / "profile-diagnostic.jpg"
    board.save(board_path, quality=94)
    progress(18, "Comparing the candidate profile with supplier evidence…")
    profile_reviewer = agents.ask("final profile reviewer",
        "Compare the candidate cross-section at lower right with the real supplier photographs, catalogue guide and dimensions. "
        "The catalogue/extracted outline is advisory. Independently verify every candidate ridge, bead, bevel, hollow and step in a physical-section, chevron or oblique photograph. "
        "Reject the candidate if any visible feature exists only in the guide, or if a flat photographed face has gained a perimeter ridge. "
        "Return decision (approve|review), confidence (0-1), photoVerified (boolean), unsupportedFeatures (array), "
        "catalogueTraceAgreement (agree|partial|conflicts|uncertain), reasons (array), and concerns (array). The line is the actual browser geometry. "
        f"User's editable request: {fault}", board_path)
    candidate["reviewer"] = profile_reviewer
    (output / "profile-candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")
    return candidate


def profile_review_passed(profile: dict[str, Any] | None, agents: "OllamaAgents") -> bool:
    """Require an explicit photographic confirmation before profile approval."""
    if not profile:
        return True
    if not agents.enabled:
        return False
    review = profile.get("reviewer") or {}
    return (review.get("decision") == "approve" and
            float(review.get("confidence", 0)) >= .78 and
            review.get("photoVerified") is True and
            not review.get("unsupportedFeatures"))


class OllamaAgents:
    def __init__(self, endpoint: str, model: str | None, enabled: bool):
        self.endpoint, self.model, self.enabled = endpoint.rstrip("/"), model, enabled
        self.error: str | None = None

    def request(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.endpoint + path, data=data,
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read())

    def connect(self) -> bool:
        if not self.enabled:
            return False
        try:
            names = [item["name"] for item in self.request("/api/tags").get("models", [])]
            if not self.model:
                preferred = ("qwen3.8", "qwen3.5", "qwen3-vl", "ministral-3", "mistral-small3.2",
                             "gemma3", "minicpm-v4.5", "llava", "llama3.2-vision")
                self.model = next((name for prefix in preferred for name in names if prefix in name.lower()), None)
            if not self.model:
                raise RuntimeError("No local vision model found; pass --ollama-model")
            return True
        except Exception as exc:
            self.error, self.enabled = str(exc), False
            return False

    def ask(self, role: str, prompt: str, image_path: Path) -> dict[str, Any] | None:
        if not self.enabled or not self.model:
            return None
        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        payload = {"model": self.model, "stream": False, "format": "json",
                   "options": {"temperature": .15}, "messages": [
                       {"role": "system", "content": f"You are the {role} in a product-material QA team. Judge only visible evidence. Supplier images may contain lighting and perspective. Treat the user's fault report as a hypothesis rather than proof. For repetition, look for the same distinctive macro feature recurring at regular intervals; do not mistake intentional fine directional grain or brush lines for a tiled repeat. Return strict JSON with no markdown."},
                       {"role": "user", "content": prompt, "images": [encoded]}]}
        try:
            return json.loads(self.request("/api/chat", payload)["message"]["content"])
        except Exception as exc:
            self.error = str(exc)
            return None


def clamp_settings(raw: dict[str, Any], fallback: Settings) -> Settings:
    result = Settings(**asdict(fallback))
    ranges = {"colour_strength": (0, 1), "contrast": (.86, 1.18), "patch_width": (288, 640),
              "overlap": (96, 240), "roughness_mid": (135, 220), "roughness_detail": (.15, 1.1),
              "bump_detail": (.8, 5.5)}
    for name, bounds in ranges.items():
        if name in raw and isinstance(raw[name], (int, float)):
            value = min(max(float(raw[name]), bounds[0]), bounds[1])
            setattr(result, name, int(value) if name in ("patch_width", "overlap") else value)
    result.seed = fallback.seed + 1
    return result


def retry_settings(settings: Settings, values: dict[str, float], limits: dict[str, float]) -> Settings:
    result = Settings(**asdict(settings))
    result.seed += 1
    if values["colourDeltaE"] > limits["colourDeltaE"]:
        result.colour_strength = min(1, settings.colour_strength + .12)
    if values["colourSpreadError"] > limits["colourSpreadError"]:
        result.contrast = 1 + (settings.contrast - 1) * .5
    if values["maximumAutocorrelation"] > limits["maximumAutocorrelation"]:
        result.patch_width, result.overlap = min(640, settings.patch_width + 48), min(220, settings.overlap + 16)
    if values["detailError"] > limits["detailError"]:
        result.contrast = min(1.15, result.contrast + .025)
    return result


def locate_input(sku: str) -> tuple[Path, dict[str, Any]]:
    for variant in INPUT_VARIANTS:
        root = PUBLIC_ROOT / sku / "variants" / variant
        if (root / "manifest.json").exists() and (root / "basecolor.jpg").exists():
            return root, json.loads((root / "manifest.json").read_text())
    asset_root = PUBLIC_ROOT / sku
    source_path = next((asset_root / name for name in
                        ("base-texture.jpg", "black-texture.jpg", "gold-texture.jpg", "accent-texture.jpg")
                        if (asset_root / name).exists()), None)
    if not source_path:
        raise FileNotFoundError(f"{sku}: no material image found")
    normalized = asset_root / "variants" / NORMALIZED_INPUT_VARIANT
    normalized.mkdir(parents=True, exist_ok=True)
    base = Image.open(source_path).convert("RGB")
    roughness, generated_bump = pbr_maps(base, Settings())
    bump_path = next((asset_root / name for name in ("base-bump.jpg", "black-bump.jpg", "accent-bump.jpg")
                      if (asset_root / name).exists()), None)
    bump = Image.open(bump_path).convert("L") if bump_path else generated_bump
    base.save(normalized / "basecolor.jpg", quality=95, subsampling=0)
    roughness.save(normalized / "roughness.jpg", quality=95, subsampling=0)
    bump.save(normalized / "bump.jpg", quality=95, subsampling=0)
    profile_path = asset_root / "profile.json"
    profile = json.loads(profile_path.read_text()) if profile_path.exists() else {}
    reference_files = [item.get("filename") for item in profile.get("assets", [])
                       if item.get("filename") and (asset_root / item["filename"]).exists()]
    if not reference_files:
        reference_files = [name for name in ("source-product.jpg", "product-section.jpg", "chevron.jpg",
                           "macro.jpg", "framed-reference.jpg", "profile-source.jpg", "profile-source.png")
                           if (asset_root / name).exists()]
    manifest = {"schemaVersion": 1, "sku": sku, "inputKind": "normalized-legacy",
                "sourceMaterial": str(source_path.relative_to(ROOT)), "referenceFiles": reference_files}
    (normalized / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return normalized, manifest


def process(sku: str, output_variant: str, max_attempts: int,
            limits: dict[str, float], agents: OllamaAgents, fault: str = "",
            review_scopes: tuple[str, ...] = ("material",),
            fast_review: bool = False) -> dict[str, Any]:
    progress(8, f"Preparing supplier references for {sku}…")
    input_root, source_manifest = locate_input(sku)
    reference, reference_paths, family_reference_paths = reference_board(sku, source_manifest)
    output, attempts_root = PUBLIC_ROOT / sku / "variants" / output_variant, PUBLIC_ROOT / sku / "variants" / output_variant / "attempts"
    attempts_root.mkdir(parents=True, exist_ok=True)
    reference.save(output / "supplier-reference-board.jpg", quality=94, subsampling=0)
    profile = build_profile_candidate(sku, reference, output, agents, fault) if "profile" in review_scopes else None
    if "material" not in review_scopes:
        files = []
        for name in ("basecolor.jpg", "roughness.jpg", "bump.jpg"):
            source_file = input_root / name
            if source_file.exists():
                target = output / name
                shutil.copy2(source_file, target)
                files.append(target)
        profile_review = (profile or {}).get("reviewer") or {}
        approved = profile_review_passed(profile, agents)
        status = "automated-approved-candidate" if approved else "human-review-required"
        report = {"schemaVersion": 2, "sku": sku, "status": status, "promotion": "not-promoted",
                  "createdAt": datetime.now(timezone.utc).isoformat(),
                  "requestedFault": fault, "reviewScopes": list(review_scopes), "profile": profile,
                  "profileGate": {"passed": approved, "requiresPhotoVerification": True},
                  "inputVariant": input_root.name, "outputVariant": output_variant,
                  "referenceImages": reference_paths, "familyReferenceImages": family_reference_paths,
                  "limits": limits, "bestSettings": {},
                  "bestMetrics": {}, "bestFailedGates": [], "attempts": [],
                  "agents": {"enabled": agents.enabled, "model": agents.model,
                             "connectionError": agents.error, "analyst": (profile or {}).get("analysis"),
                             "reviewer": profile_review},
                  "material": {"preservedFrom": input_root.name,
                               "sha256": {path.name: digest(path) for path in files}},
                  "activation": "Candidate only. Inspect in the live visualiser before promotion."}
        for name in ("quality-report.json", "manifest.json"):
            (output / name).write_text(json.dumps(report, indent=2) + "\n")
        progress(100, "Profile review complete.")
        return {"sku": sku, "status": status, "attempts": 0, "score": None,
                "failedGates": [], "output": str(output.relative_to(ROOT))}
    source = Image.open(input_root / "basecolor.jpg").convert("RGB")
    progress(20, f"Analysing the supplier finish with {agents.model or 'deterministic checks'}…")
    fault_context = f" The user reports this fault: {fault}. Prioritise diagnosing and correcting it." if fault else ""
    analyst = agents.ask("supplier-reference analyst",
        "Return keys finishClass, directional, gloss (matte|satin|gloss), preserve (array), risks (array), and suggestedSettings. "
        "The board labels exact SKU photographs separately from assembled family references. Use family references for intended presentation and broad family character only. "
        "Exact SKU photographs control colour, texture, sheen and profile; never sample artwork, mount, wall, furniture or another family member's finish. "
        "Classify gloss from highlight width, edge softness and reflection clarity across the available views. Do not call a material glossy merely because curved profile edges catch a bright light. "
        "Allowed settings and ranges: colour_strength 0..1, contrast .86..1.18, roughness_mid 135..220, roughness_detail .15..1.1, bump_detail .8..5.5." + fault_context,
        output / "supplier-reference-board.jpg")
    settings = clamp_settings((analyst or {}).get("suggestedSettings", {}), Settings(seed=-1))
    attempts: list[dict[str, Any]] = []
    best = None
    for attempt in range(1, max_attempts + 1):
        progress(20 + int((attempt - 1) * 55 / max_attempts), f"Building candidate {attempt} of {max_attempts}…")
        base = ImageEnhance.Contrast(colour_transfer(quilt(source, settings), reference,
                                                     settings.colour_strength)).enhance(settings.contrast)
        base = constrain_colour_to_source(base, source)
        roughness, bump = pbr_maps(base, settings)
        # Deterministic colour/detail gates compare against the retained material
        # atlas. The full supplier board is still shown to both vision agents.
        values = metrics(base, source)
        score, failures = score_metrics(values, limits)
        attempt_dir = attempts_root / f"{attempt:02d}"
        attempt_dir.mkdir(parents=True, exist_ok=True)
        board_path = attempt_dir / "review-board.jpg"
        make_review_board(reference, base, fixed_light_preview(base, roughness, bump), values, attempt).save(board_path, quality=93)
        for name, image in (("basecolor.jpg", base), ("roughness.jpg", roughness), ("bump.jpg", bump)):
            image.save(attempt_dir / name, quality=95, subsampling=0)
        progress(28 + int((attempt - 1) * 55 / max_attempts), f"Reviewing candidate {attempt} with {agents.model or 'image checks'}…")
        # Batch mode asks the vision critic on the first candidate, then lets
        # deterministic image gates tune subsequent candidates. The final best
        # candidate still receives the same independent vision approval. This
        # removes up to three expensive model calls without weakening the final
        # colour, repetition, seam or finish checks.
        critic = None if fast_review and attempt > 1 else agents.ask("candidate critic",
            "Top: supplier finish crops from several views. Middle: unlit atlas. Bottom: fixed-light preview. Return score (0-100), colourMatch, textureMatch, repetition, seam, finishMatch (0-100), blockers (array), observations (array), and suggestedSettings. Allowed ranges: colour_strength 0..1, contrast .86..1.18, patch_width 288..640 pixels, overlap 96..240 pixels, roughness_mid 135..220, roughness_detail .15..1.1, bump_detail .8..5.5." + fault_context, board_path)
        attempts.append({"attempt": attempt, "settings": asdict(settings), "metrics": values,
                         "deterministicScore": score, "failedGates": failures, "agentReview": critic})
        agent_score = float((critic or {}).get("score", score))
        combined = score * .75 + agent_score * .25
        if best is None or combined > best[0]:
            best = (combined, base.copy(), roughness.copy(), bump.copy(), board_path,
                    Settings(**asdict(settings)), values, failures)
        if not failures and score >= limits["minimumScore"] and (not critic or agent_score >= 78):
            break
        suggested = (critic or {}).get("suggestedSettings", {})
        settings = clamp_settings(suggested, settings) if suggested else retry_settings(settings, values, limits)
    assert best is not None
    _, base, roughness, bump, best_board, best_settings, best_values, best_failures = best
    for name, image in (("basecolor.jpg", base), ("roughness.jpg", roughness), ("bump.jpg", bump)):
        image.save(output / name, quality=95, subsampling=0)
    Image.open(best_board).save(output / "material-diagnostic.jpg", quality=94)
    progress(86, "Running the final sales-quality review…")
    reviewer = agents.ask("final material reviewer",
        "Approve only if the candidate retains the exact SKU supplier colour, finish, texture scale and irregularity with no visible seam or obvious repeat. "
        "Family images are labelled context and must not override exact SKU evidence. Return decision (approve|review), confidence (0-1), reasons (array), concerns (array)." + fault_context,
        output / "material-diagnostic.jpg")
    reviewer_approved = bool(reviewer and reviewer.get("decision") == "approve" and float(reviewer.get("confidence", 0)) >= .72)
    final_score = score_metrics(best_values, limits)[0]
    hard_pass = not best_failures and final_score >= limits["minimumScore"]
    profile_approved = profile_review_passed(profile, agents)
    status = "automated-approved-candidate" if hard_pass and profile_approved and (reviewer_approved or not agents.enabled) else "human-review-required"
    files = [output / name for name in ("basecolor.jpg", "roughness.jpg", "bump.jpg")]
    report = {"schemaVersion": 2, "sku": sku, "status": status, "promotion": "not-promoted",
              "createdAt": datetime.now(timezone.utc).isoformat(),
              "requestedFault": fault,
              "reviewScopes": list(review_scopes), "profile": profile,
              "profileGate": {"passed": profile_approved, "requiresPhotoVerification": bool(profile)},
              "inputVariant": input_root.name, "outputVariant": output_variant,
              "referenceImages": reference_paths, "familyReferenceImages": family_reference_paths,
              "limits": limits, "bestSettings": asdict(best_settings),
              "bestMetrics": best_values, "bestFailedGates": best_failures, "attempts": attempts,
              "agents": {"enabled": agents.enabled, "model": agents.model, "connectionError": agents.error,
                         "analyst": analyst, "reviewer": reviewer},
              "material": {"basecolor": "basecolor.jpg", "roughness": "roughness.jpg", "bump": "bump.jpg",
                           "sha256": {path.name: digest(path) for path in files}},
              "activation": "Candidate only. Approve in the live visualiser before adding to a runtime index."}
    for name in ("quality-report.json", "manifest.json"):
        (output / name).write_text(json.dumps(report, indent=2) + "\n")
    progress(100, "Material review complete.")
    return {"sku": sku, "status": status, "attempts": len(attempts), "score": final_score,
            "failedGates": best_failures, "output": str(output.relative_to(ROOT))}


def available_skus() -> list[str]:
    return sorted(path.name for path in PUBLIC_ROOT.iterdir() if path.is_dir() and
                  (any((path / "variants" / variant / "basecolor.jpg").exists() for variant in INPUT_VARIANTS) or
                   any((path / name).exists() for name in ("base-texture.jpg", "black-texture.jpg",
                                                           "gold-texture.jpg", "accent-texture.jpg"))))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sku", action="append", help="Selected SKU; omit for every generated material")
    parser.add_argument("--max-attempts", type=int, default=4)
    parser.add_argument("--output-variant", default=DEFAULT_OUTPUT_VARIANT)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model")
    parser.add_argument("--no-ollama", action="store_true")
    parser.add_argument("--limits", type=Path, help="Optional JSON threshold overrides")
    parser.add_argument("--fault", default="", help="Visible problem to prioritise during review")
    parser.add_argument("--review-scopes", default="material", help="Comma-separated: profile,material")
    parser.add_argument("--fast-review", action="store_true",
                        help="Use deterministic retry tuning after one vision critique; final vision QA is unchanged")
    args = parser.parse_args()
    limits = dict(DEFAULT_LIMITS)
    if args.limits:
        limits.update(json.loads(args.limits.read_text()))
    agents = OllamaAgents(args.ollama_url, args.ollama_model, not args.no_ollama)
    agents.connect()
    review_scopes = tuple(scope for scope in args.review_scopes.split(",") if scope in ("profile", "material")) or ("material",)
    results = []
    for sku in args.sku or available_skus():
        try:
            results.append(process(sku, args.output_variant, max(1, min(args.max_attempts, 8)), limits, agents,
                                   args.fault.strip(), review_scopes, args.fast_review))
        except Exception as exc:
            results.append({"sku": sku, "status": "error", "error": str(exc)})
    summary = {"count": len(results), "ollama": {"enabled": agents.enabled, "model": agents.model,
               "error": agents.error}, "results": results}
    (SOURCE_ROOT / "material-quality-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    if any(result["status"] == "error" for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
