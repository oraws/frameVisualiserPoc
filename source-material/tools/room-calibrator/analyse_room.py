#!/usr/bin/env python3
"""Create an evidence-backed draft calibration for a single room photograph.

The output is deliberately *not* renderer-ready. VGGT provides monocular camera
intrinsics and depth; a robust plane fit provides a wall hypothesis. A person
must inspect the diagnostic grid and set ``approved`` before the visualiser may
consume the calibration.
"""

from __future__ import annotations

import argparse
import json
import math
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


def load_vggt(source: Path, weights: Path, device: torch.device):
    sys.path.insert(0, str(source))
    from vggt.models.vggt import VGGT

    model = VGGT()
    state = torch.load(weights, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model" in state and not any(
        key.startswith("aggregator.") for key in state
    ):
        state = state["model"]
    model.load_state_dict(state)
    return model.eval().to(device)


def normalise_image(path: Path, target: int = 518) -> tuple[torch.Tensor, np.ndarray, dict]:
    source = np.asarray(Image.open(path).convert("RGB"))
    height, width = source.shape[:2]
    scale = target / max(width, height)
    resized_width = max(14, round(width * scale / 14) * 14)
    resized_height = max(14, round(height * scale / 14) * 14)
    resized = cv2.resize(source, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    canvas = np.full((target, target, 3), 255, dtype=np.uint8)
    left = (target - resized_width) // 2
    top = (target - resized_height) // 2
    canvas[top : top + resized_height, left : left + resized_width] = resized
    tensor = torch.from_numpy(canvas).permute(2, 0, 1).float() / 255.0
    mapping = {
        "sourceWidth": width,
        "sourceHeight": height,
        "modelSize": target,
        "resizedWidth": resized_width,
        "resizedHeight": resized_height,
        "left": left,
        "top": top,
        "scaleX": resized_width / width,
        "scaleY": resized_height / height,
    }
    return tensor, canvas, mapping


def fit_plane_ransac(points: np.ndarray, seed: int = 17) -> tuple[np.ndarray, float, np.ndarray]:
    rng = np.random.default_rng(seed)
    centre = np.median(points, axis=0)
    extent = float(np.median(np.linalg.norm(points - centre, axis=1)))
    threshold = max(extent * 0.012, 1e-4)
    best_mask = np.zeros(len(points), dtype=bool)
    best_plane = None
    for _ in range(900):
        sample = points[rng.choice(len(points), 3, replace=False)]
        normal = np.cross(sample[1] - sample[0], sample[2] - sample[0])
        length = np.linalg.norm(normal)
        if length < 1e-9:
            continue
        normal /= length
        distance = -float(np.dot(normal, sample[0]))
        mask = np.abs(points @ normal + distance) < threshold
        if mask.sum() > best_mask.sum():
            best_mask = mask
            best_plane = np.r_[normal, distance]
    if best_plane is None or best_mask.sum() < 30:
        raise RuntimeError("Wall plane could not be fitted")

    inliers = points[best_mask]
    centre = inliers.mean(axis=0)
    _, _, vectors = np.linalg.svd(inliers - centre, full_matrices=False)
    normal = vectors[-1]
    if normal[2] > 0:
        normal *= -1
    distance = -float(np.dot(normal, centre))
    residual = np.abs(inliers @ normal + distance)
    return np.r_[normal, distance], float(np.percentile(residual, 95)), best_mask


def percentile_map(values: np.ndarray, inverse: bool = False) -> np.ndarray:
    finite = values[np.isfinite(values)]
    low, high = np.percentile(finite, (2, 98))
    mapped = np.clip((values - low) / max(high - low, 1e-9), 0, 1)
    if inverse:
        mapped = 1 - mapped
    return (mapped * 255).astype(np.uint8)


def estimate_light(image: np.ndarray, wall_roi: tuple[int, int, int, int]) -> dict:
    """Extract observable LDR cues without pretending they are a recovered HDR map."""
    x0, y0, x1, y1 = wall_roi
    linear = np.power(image.astype(np.float32) / 255.0, 2.2)
    luminance = linear[..., 0] * 0.2126 + linear[..., 1] * 0.7152 + linear[..., 2] * 0.0722
    blur = cv2.GaussianBlur(luminance, (0, 0), sigmaX=max(image.shape[:2]) / 30)
    crop = blur[y0:y1, x0:x1]
    _, peak, _, location = cv2.minMaxLoc(crop)
    px = x0 + location[0]
    py = y0 + location[1]
    height, width = image.shape[:2]
    bright = image[luminance >= np.percentile(luminance, 92)]
    colour = np.median(bright, axis=0) if len(bright) else np.array([255, 244, 228])
    return {
        "status": "ldr-cue-only",
        "method": "bright-region centroid and colour; no HDR radiance recovery",
        "dominantImagePoint": [round(px / width, 5), round(py / height, 5)],
        "dominantColourSrgb": [int(value) for value in colour],
        "peakLinearLuminance": round(float(peak), 5),
        "exposureClippedFraction": round(float(np.mean(luminance > 0.97)), 5),
        "rendererUseAllowed": False,
    }


def run(args: argparse.Namespace) -> None:
    image_path = Path(args.image).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = np.asarray(Image.open(image_path).convert("RGB"))
    tensor, model_image, mapping = normalise_image(image_path, args.image_size)
    images = tensor[None, None]
    device = torch.device("mps" if torch.backends.mps.is_available() and not args.cpu else "cpu")
    model = load_vggt(Path(args.vggt_source).resolve(), Path(args.weights).resolve(), device)
    images = images.to(device)

    started = time.perf_counter()
    with torch.inference_mode():
        tokens, patch_start = model.aggregator(images)
        pose_encoding = model.camera_head(tokens)[-1]
        depth, depth_confidence = model.depth_head(tokens, images, patch_start)
    elapsed = time.perf_counter() - started

    from vggt.utils.geometry import unproject_depth_map_to_point_map
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri

    extrinsics, intrinsics = pose_encoding_to_extri_intri(
        pose_encoding.float(), images.shape[-2:]
    )
    extrinsics_np = extrinsics[0].detach().cpu().numpy()
    intrinsics_np = intrinsics[0].detach().cpu().numpy()
    depth_np = depth[0].float().detach().cpu().numpy()
    confidence_np = depth_confidence[0].float().detach().cpu().numpy()
    points_np = unproject_depth_map_to_point_map(depth_np, extrinsics_np, intrinsics_np)[0]
    depth_map = np.squeeze(depth_np[0])
    confidence_map = np.squeeze(confidence_np[0])

    height, width = source.shape[:2]
    wall_roi_source = (
        round(width * args.wall_left),
        round(height * args.wall_top),
        round(width * args.wall_right),
        round(height * args.wall_bottom),
    )
    sx0, sy0, sx1, sy1 = wall_roi_source
    mx0 = round(sx0 * mapping["scaleX"] + mapping["left"])
    mx1 = round(sx1 * mapping["scaleX"] + mapping["left"])
    my0 = round(sy0 * mapping["scaleY"] + mapping["top"])
    my1 = round(sy1 * mapping["scaleY"] + mapping["top"])
    region_points = points_np[my0:my1:2, mx0:mx1:2].reshape(-1, 3)
    region_confidence = confidence_map[my0:my1:2, mx0:mx1:2].reshape(-1)
    valid = np.isfinite(region_points).all(axis=1)
    if valid.any():
        confidence_cutoff = np.percentile(region_confidence[valid], 35)
        valid &= region_confidence >= confidence_cutoff
    plane, residual_p95, plane_inliers = fit_plane_ransac(region_points[valid])
    inlier_fraction = float(plane_inliers.mean())
    normal = plane[:3]
    yaw = math.degrees(math.atan2(normal[0], -normal[2]))
    pitch = math.degrees(math.atan2(normal[1], math.hypot(normal[0], normal[2])))

    depth_visual = cv2.applyColorMap(percentile_map(depth_map, inverse=True), cv2.COLORMAP_TURBO)
    confidence_visual = cv2.applyColorMap(percentile_map(confidence_map), cv2.COLORMAP_VIRIDIS)
    cv2.rectangle(depth_visual, (mx0, my0), (mx1, my1), (255, 255, 255), 2)
    cv2.imwrite(str(output / "depth-diagnostic.png"), depth_visual)
    cv2.imwrite(str(output / "confidence-diagnostic.png"), confidence_visual)
    Image.fromarray(model_image).save(output / "model-input.png")
    np.savez_compressed(
        output / "geometry-prediction.npz",
        depth=depth_map,
        confidence=confidence_map,
        intrinsics=intrinsics_np[0],
        extrinsics=extrinsics_np[0],
        wallPlane=plane,
    )

    focal = float(intrinsics_np[0, 0, 0])
    fov = math.degrees(2 * math.atan(args.image_size / (2 * focal)))
    lighting = estimate_light(source, wall_roi_source)
    record = {
        "schemaVersion": 1,
        "roomId": args.room_id,
        "sourceImage": image_path.name,
        "sourceDimensions": {"width": width, "height": height},
        "status": "draft-needs-grid-approval",
        "approved": False,
        "rendererUseAllowed": False,
        "geometry": {
            "model": "facebook/VGGT-1B research checkpoint",
            "commercialDeploymentAllowed": False,
            "device": str(device),
            "inferenceSeconds": round(elapsed, 3),
            "modelInput": mapping,
            "camera": {
                "intrinsicsModelPixels": intrinsics_np[0].round(6).tolist(),
                "horizontalFovDegrees": round(fov, 4),
            },
            "wallHypothesis": {
                "sourceRoi": [sx0, sy0, sx1, sy1],
                "planeCameraCoordinates": plane.round(7).tolist(),
                "normal": normal.round(7).tolist(),
                "yawDegrees": round(yaw, 4),
                "pitchDegrees": round(pitch, 4),
                "ransacInlierFraction": round(inlier_fraction, 5),
                "residualP95ModelUnits": round(residual_p95, 7),
            },
        },
        "manualCalibration": {
            "method": "four-corner wall quad with perspective grid",
            "quadNormalised": [
                [args.quad_tl_x, args.quad_tl_y],
                [args.quad_tr_x, args.quad_tr_y],
                [args.quad_br_x, args.quad_br_y],
                [args.quad_bl_x, args.quad_bl_y],
            ],
            "reviewedAt": None,
            "reviewer": None,
        },
        "lighting": lighting,
        "evidence": {
            "depth": "depth-diagnostic.png",
            "confidence": "confidence-diagnostic.png",
            "prediction": "geometry-prediction.npz",
        },
    }
    (output / "calibration-draft.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--room-id", default="stock-pilot")
    parser.add_argument("--image-size", type=int, default=518)
    parser.add_argument("--wall-left", type=float, default=0.07)
    parser.add_argument("--wall-top", type=float, default=0.08)
    parser.add_argument("--wall-right", type=float, default=0.72)
    parser.add_argument("--wall-bottom", type=float, default=0.72)
    parser.add_argument("--quad-tl-x", type=float, default=0.25)
    parser.add_argument("--quad-tl-y", type=float, default=0.27)
    parser.add_argument("--quad-tr-x", type=float, default=0.68)
    parser.add_argument("--quad-tr-y", type=float, default=0.27)
    parser.add_argument("--quad-br-x", type=float, default=0.68)
    parser.add_argument("--quad-br-y", type=float, default=0.71)
    parser.add_argument("--quad-bl-x", type=float, default=0.25)
    parser.add_argument("--quad-bl-y", type=float, default=0.71)
    parser.add_argument("--vggt-source", default=str(DEFAULT_VGGT_SOURCE))
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS))
    parser.add_argument("--cpu", action="store_true")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
