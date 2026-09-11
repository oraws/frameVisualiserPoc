#!/usr/bin/env python3
"""Validate that an enhanced room is usable as the original fixed-camera plate."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, sobel


ROOT = Path(__file__).resolve().parents[2]
ROOM = ROOT / "public/assets/rooms/sofa-gallery"
SOURCE = ROOM / "enhancement-source/beauty-0001.png"
STRUCTURE = ROOM / "enhancement-source/structure-mask.png"
OUTPUT = ROOM / "room-ai-enhanced.png"
REPORT = ROOM / "ai-enhancement-validation.json"


def grey(path: Path, size: tuple[int, int] | None = None) -> np.ndarray:
    image = Image.open(path).convert("L")
    if size:
        image = image.resize(size, Image.Resampling.LANCZOS)
    return np.asarray(image, dtype=np.float32) / 255.0


def edges(image: np.ndarray) -> np.ndarray:
    return np.hypot(sobel(image, axis=0), sobel(image, axis=1))


def main() -> None:
    output_image = Image.open(OUTPUT).convert("RGB")
    source_image = Image.open(SOURCE).convert("RGB")
    output_size = output_image.size
    source_aspect = source_image.width / source_image.height
    output_aspect = output_image.width / output_image.height

    source = grey(SOURCE, output_size)
    output = np.asarray(output_image.convert("L"), dtype=np.float32) / 255.0
    structure = grey(STRUCTURE, output_size)
    source_edges = edges(source)
    output_edges = edges(output)

    # The guide is a soft colour-managed mask, so its strongest gradient is used
    # as the sofa/curtain/floor structural boundary rather than its absolute value.
    structural_boundary = edges(structure) > np.quantile(edges(structure), 0.84)
    strong_output_edges = output_edges > np.quantile(output_edges, 0.82)
    distances = distance_transform_edt(~strong_output_edges)[structural_boundary]

    # The central upper wall must stay quiet so any artwork and frame can be added.
    h, w = output.shape
    hanging_zone = output_edges[int(h * .16):int(h * .55), int(w * .25):int(w * .79)]
    blank_wall_edge_density = float((hanging_zone > np.quantile(output_edges, .90)).mean())

    metrics = {
        "sourceAspect": round(source_aspect, 6),
        "outputAspect": round(output_aspect, 6),
        "outputWidth": output_size[0],
        "outputHeight": output_size[1],
        "structureMedianEdgeDistancePx": round(float(np.median(distances)), 3),
        "structureP90EdgeDistancePx": round(float(np.percentile(distances, 90)), 3),
        "blankWallEdgeDensity": round(blank_wall_edge_density, 6),
        "meanAbsoluteLuminanceChange": round(float(np.mean(np.abs(source - output))), 6),
    }
    checks = {
        "aspectPreserved": abs(output_aspect - source_aspect) < .001,
        "sufficientResolution": output_size[0] >= 1152 and output_size[1] >= 1024,
        "structurePreserved": metrics["structureMedianEdgeDistancePx"] <= 3 and metrics["structureP90EdgeDistancePx"] <= 12,
        "hangingAreaClear": blank_wall_edge_density < .025,
        "meaningfulEnhancement": metrics["meanAbsoluteLuminanceChange"] > .025,
    }
    report = {"status": "passed" if all(checks.values()) else "failed", "checks": checks, "metrics": metrics}
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
