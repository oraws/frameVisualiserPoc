#!/usr/bin/env python3
"""Run an isolated VGGT camera/depth probe on supplier spin frames.

This is a research-only feasibility stage. It writes predictions and metrics
under each product's profile-analysis folder and never imports renderer code.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_VGGT_SOURCE = ROOT / ".model-cache" / "vggt-source"
DEFAULT_WEIGHTS = ROOT / ".model-cache" / "VGGT-1B" / "model.pt"


def foreground_mask(image: np.ndarray) -> np.ndarray:
    """Conservative product mask; excludes the textureless studio surround."""
    lab = cv2.cvtColor(image, cv2.COLOR_RGB2LAB).astype(np.float32)
    border = np.concatenate((lab[:6].reshape(-1, 3), lab[-6:].reshape(-1, 3),
                             lab[:, :6].reshape(-1, 3), lab[:, -6:].reshape(-1, 3)))
    background = np.median(border, axis=0)
    distance = np.linalg.norm(lab - background, axis=2)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    mask = ((distance > 23.0) | (gray < 205)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count < 2:
        raise ValueError("No foreground component")
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == component


def square_input(path: Path, target: int = 518) -> tuple[torch.Tensor, np.ndarray, np.ndarray]:
    """Match VGGT square preprocessing and transform the evidence mask with it."""
    source = np.asarray(Image.open(path).convert("RGB"))
    mask = foreground_mask(source)
    height, width = source.shape[:2]
    side = max(width, height)
    left, top = (side - width) // 2, (side - height) // 2
    square = np.zeros((side, side, 3), dtype=np.uint8)
    square_mask = np.zeros((side, side), dtype=np.uint8)
    square[top:top + height, left:left + width] = source
    square_mask[top:top + height, left:left + width] = mask.astype(np.uint8) * 255
    resized = cv2.resize(square, (target, target), interpolation=cv2.INTER_CUBIC)
    resized_mask = cv2.resize(square_mask, (target, target), interpolation=cv2.INTER_NEAREST) > 0
    tensor = torch.from_numpy(resized).permute(2, 0, 1).float() / 255.0
    return tensor, resized, resized_mask


def camera_centres(extrinsics: np.ndarray) -> np.ndarray:
    rotations = extrinsics[:, :3, :3]
    translations = extrinsics[:, :3, 3]
    return -np.einsum("sji,sj->si", rotations, translations)


def fit_camera_plane_and_circle(centres: np.ndarray) -> dict:
    centred = centres - centres.mean(axis=0)
    _, singular, vh = np.linalg.svd(centred, full_matrices=False)
    basis = vh[:2]
    plane_normal = vh[2]
    points = centred @ basis.T
    a = np.column_stack((2 * points[:, 0], 2 * points[:, 1], np.ones(len(points))))
    b = np.sum(points ** 2, axis=1)
    cx, cy, c0 = np.linalg.lstsq(a, b, rcond=None)[0]
    radius = float(np.sqrt(max(c0 + cx * cx + cy * cy, 1e-12)))
    radii = np.linalg.norm(points - np.array([cx, cy]), axis=1)
    angles = np.unwrap(np.arctan2(points[:, 1] - cy, points[:, 0] - cx))
    direction = 1.0 if np.median(np.diff(angles)) >= 0 else -1.0
    directed = direction * angles
    monotonic_fraction = float(np.mean(np.diff(directed) > 0)) if len(points) > 1 else 1.0
    plane_distance = np.abs(centred @ plane_normal)
    return {
        "circleRadius": radius,
        "circleResidualP95Fraction": round(float(np.percentile(np.abs(radii - radius), 95) / radius), 5),
        "planeResidualP95Fraction": round(float(np.percentile(plane_distance, 95) / radius), 5),
        "monotonicAngleFraction": round(monotonic_fraction, 5),
        "cameraCentreSingularValues": [round(float(value), 6) for value in singular],
        "anglesDegrees": [round(float(np.degrees(value - directed[0])), 3) for value in directed],
    }


def load_vggt(source: Path, weights: Path, device: torch.device):
    sys.path.insert(0, str(source))
    from vggt.models.vggt import VGGT

    model = VGGT()
    state = torch.load(weights, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model" in state and not any(key.startswith("aggregator.") for key in state):
        state = state["model"]
    model.load_state_dict(state)
    return model.eval().to(device)


def run(args: argparse.Namespace) -> Path:
    root = Path(args.product_root).resolve()
    manifest = json.loads((root / "spin-manifest.json").read_text())
    all_images = {item["label"]: item for item in manifest["images"]}
    labels = [label.strip() for label in args.frames.split(",") if label.strip()]
    missing = [label for label in labels if label not in all_images]
    if missing:
        raise ValueError(f"Frames missing from manifest: {missing}")

    tensors, display_images, masks = [], [], []
    for label in labels:
        tensor, image, mask = square_input(root / "spin" / all_images[label]["filename"], args.image_size)
        tensors.append(tensor)
        display_images.append(image)
        masks.append(mask)
    images = torch.stack(tensors)[None]
    device = torch.device("mps" if torch.backends.mps.is_available() and not args.cpu else "cpu")
    model = load_vggt(Path(args.vggt_source).resolve(), Path(args.weights).resolve(), device)
    images = images.to(device)
    started = time.perf_counter()
    autocast = torch.autocast(device_type=device.type, dtype=torch.float16,
                              enabled=device.type == "mps")
    with torch.inference_mode(), autocast:
        tokens, patch_start = model.aggregator(images)
        pose_encoding = model.camera_head(tokens)[-1]
        depth, depth_confidence = model.depth_head(tokens, images, patch_start)
    elapsed = time.perf_counter() - started

    from vggt.utils.pose_enc import pose_encoding_to_extri_intri
    from vggt.utils.geometry import unproject_depth_map_to_point_map

    extrinsics, intrinsics = pose_encoding_to_extri_intri(
        pose_encoding.float(), images.shape[-2:])
    extrinsics_np = extrinsics[0].detach().cpu().numpy()
    intrinsics_np = intrinsics[0].detach().cpu().numpy()
    depth_np = depth[0].float().detach().cpu().numpy()
    confidence_np = depth_confidence[0].float().detach().cpu().numpy()
    points_np = unproject_depth_map_to_point_map(depth_np, extrinsics_np, intrinsics_np)

    camera_metrics = fit_camera_plane_and_circle(camera_centres(extrinsics_np))
    focal = intrinsics_np[:, 0, 0]
    camera_metrics["focalLengthMedianPx"] = round(float(np.median(focal)), 3)
    camera_metrics["focalLengthP95VariationFraction"] = round(
        float(np.percentile(np.abs(focal - np.median(focal)), 95) / max(np.median(focal), 1e-9)), 5)

    output = root / "profile-analysis" / "vggt-profile-pilot"
    output.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        output / "predictions.npz",
        labels=np.asarray(labels), images=np.asarray(display_images), masks=np.asarray(masks),
        extrinsics=extrinsics_np, intrinsics=intrinsics_np, depth=depth_np,
        depthConfidence=confidence_np, worldPoints=points_np,
    )
    record = {
        "sku": manifest["sku"],
        "model": "facebook/VGGT-1B research checkpoint",
        "commercialDeploymentAllowed": False,
        "rendererIntegrated": False,
        "device": str(device),
        "imageSize": args.image_size,
        "frames": labels,
        "inferenceSeconds": round(elapsed, 3),
        "cameraMetrics": camera_metrics,
        "outputs": {"predictions": "predictions.npz"},
    }
    (output / "camera-probe.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-root", required=True)
    parser.add_argument(
        "--frames",
        default="img01,img06,img12,img17,img22,img23,img24,img28,img34,img39,img45",
    )
    parser.add_argument("--image-size", type=int, default=518)
    parser.add_argument("--vggt-source", default=str(DEFAULT_VGGT_SOURCE))
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS))
    parser.add_argument("--cpu", action="store_true")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
