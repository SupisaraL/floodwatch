"""Inference adapter for the DINOv3 + GeoCalib + SAM3 research pipeline.

This module is intentionally local and GPU-oriented.  It uses the final
semantic head produced by the research run and never substitutes a heuristic
or a fabricated prediction when the model environment is unavailable.
"""

from __future__ import annotations

import hashlib
import os
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class AnalysisUnavailable(RuntimeError):
    """Raised when the local model environment cannot run the research pipeline."""


@dataclass(frozen=True)
class PipelineConfig:
    dino_name: str = "facebook/dinov3-vits16-pretrain-lvd1689m"
    sam_name: str = "facebook/sam3"
    dino_tile: int = 896
    dino_overlap: int = 224
    sam_tile: int = 1008
    sam_overlap: int = 192
    sam_min_pixels: int = 30
    water_threshold: float = 0.50
    sam_threshold: float = 0.50
    sam_mask_threshold: float = 0.50
    geo_confidence_min: float = 0.15
    geo_latitude_limit: float = -15.0


CLASS_NAMES = ["Background", "Water", "Built area", "Green area", "Vehicle"]
CLASS_COLOURS = ["#ECEFF1", "#001D4F", "#A62035", "#26734D", "#D59A22"]


class ResearchPipeline:
    def __init__(self, asset_dir: Path):
        self.asset_dir = asset_dir
        self.model_cache = asset_dir.parents[1] / "model-cache"
        # Keep every foundation-model file inside this deploy bundle.
        os.environ["HF_HOME"] = str(self.model_cache / "huggingface")
        os.environ["TORCH_HOME"] = str(self.model_cache / "torch")
        self.config = PipelineConfig(
            water_threshold=self._threshold("selected_water_threshold.json", "threshold", 0.50),
            # Fixed to the validated instance-F1 selection recorded in model_assets.
            sam_threshold=0.50,
        )
        self._ready = False

    def _threshold(self, filename: str, key: str, fallback: float) -> float:
        path = self.asset_dir / filename
        if not path.exists():
            return fallback
        try:
            return float(json.loads(path.read_text(encoding="utf-8"))[key])
        except (OSError, ValueError, KeyError, TypeError):
            return fallback

    def _load(self) -> None:
        if self._ready:
            return
        try:
            import cv2
            import numpy as np
            import torch
            import torch.nn as nn
            import torch.nn.functional as functional
            from PIL import Image
            from transformers import AutoImageProcessor, AutoModel, Sam3Model, Sam3Processor
            from geocalib import GeoCalib
            from geocalib.perspective_fields import get_perspective_field
        except ImportError as error:
            missing = getattr(error, "name", None) or str(error)
            raise AnalysisUnavailable(
                f"A model dependency could not be imported: {missing}. "
                "Restart FloodWatch from the activated .venv terminal after installing its dependencies."
            ) from error

        if not torch.cuda.is_available():
            raise AnalysisUnavailable(
                "CUDA-enabled PyTorch was not detected. Run "
                "setup_windows_gpu.ps1 from the FloodWatch folder, restart the server, "
                "then try the analysis again. No substitute estimate has been generated."
            )

        checkpoint_path = self.asset_dir / "fullmask_best_head.pt"
        if not checkpoint_path.exists():
            raise AnalysisUnavailable(f"Missing trained semantic head: {checkpoint_path}")

        self.cv2 = cv2
        self.np = np
        self.torch = torch
        self.nn = nn
        self.functional = functional
        self.Image = Image
        self.GeoCalib = GeoCalib
        self.get_perspective_field = get_perspective_field
        self.device = torch.device("cuda")
        self.amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        self.feature_dim = int(checkpoint["feature_dim"])
        # Keep the three foundation models in system RAM until their own stage
        # starts.  A typical RTX 4050 has 6 GB of VRAM and cannot safely keep
        # DINOv3, GeoCalib, and SAM3 resident together.
        self.processor = AutoImageProcessor.from_pretrained(self.config.dino_name, local_files_only=True)
        self.dino = AutoModel.from_pretrained(self.config.dino_name, local_files_only=True).eval()
        self.patch = int(self.dino.config.patch_size)
        if self.feature_dim != int(self.dino.config.hidden_size):
            raise AnalysisUnavailable("The semantic head is incompatible with the loaded DINOv3 encoder.")

        class SegmentationHead(nn.Module):
            def __init__(self, feature_dim: int, class_count: int = 5):
                super().__init__()
                self.layers = nn.Sequential(
                    nn.Conv2d(feature_dim, 128, 1), nn.GroupNorm(8, 128), nn.GELU(),
                    nn.Conv2d(128, 128, 3, padding=1), nn.GroupNorm(8, 128), nn.GELU(),
                    nn.Dropout2d(0.1), nn.Conv2d(128, class_count, 1),
                )

            def forward(self, value):
                return self.layers(value)

        self.head = SegmentationHead(self.feature_dim).eval()
        self.head.load_state_dict(checkpoint["state_dict"])
        self.geo = GeoCalib().eval()
        self.sam = Sam3Model.from_pretrained(self.config.sam_name, local_files_only=True).eval()
        self.sam_processor = Sam3Processor.from_pretrained(self.config.sam_name, local_files_only=True)
        self._ready = True

    def _move_to_gpu(self, *models, reduced_precision: bool = True) -> None:
        """Load only the active model stage into VRAM, using reduced precision."""
        for model in models:
            if reduced_precision:
                model.to(device=self.device, dtype=self.amp_dtype)
            else:
                model.to(device=self.device)

    def _release_gpu(self, *models) -> None:
        """Return a completed stage to RAM before the next stage begins."""
        for model in models:
            model.to("cpu")
        self.torch.cuda.empty_cache()

    @staticmethod
    def _origins(length: int, tile: int, overlap: int) -> list[int]:
        if length <= tile:
            return [0]
        final = length - tile
        step = tile - overlap
        values = list(range(0, final + 1, step))
        if values[-1] != final:
            values.append(final)
        return sorted(set(values))

    def _feature_grid(self, image):
        np, torch, f = self.np, self.torch, self.functional
        height, width = image.shape[:2]
        padded_height = math.ceil(height / self.patch) * self.patch
        padded_width = math.ceil(width / self.patch) * self.patch
        padded = np.pad(image, ((0, padded_height - height), (0, padded_width - width), (0, 0)), mode="edge")
        grid_height, grid_width = padded_height // self.patch, padded_width // self.patch
        feature_sum = np.zeros((self.feature_dim, grid_height, grid_width), dtype=np.float32)
        weights = np.zeros((grid_height, grid_width), dtype=np.float32)

        def feather(length: int, before: bool, after: bool):
            fade = min(max(1, self.config.dino_overlap // self.patch), max(1, length // 2))
            result = np.ones(length, dtype=np.float32)
            ramp = np.linspace(0.15, 1.0, fade, dtype=np.float32)
            if before:
                result[:fade] *= ramp
            if after:
                result[-fade:] *= ramp[::-1]
            return result

        ys = self._origins(padded_height, self.config.dino_tile, self.config.dino_overlap)
        xs = self._origins(padded_width, self.config.dino_tile, self.config.dino_overlap)
        for iy, y in enumerate(ys):
            for ix, x in enumerate(xs):
                tile = padded[y:min(y + self.config.dino_tile, padded_height), x:min(x + self.config.dino_tile, padded_width)]
                inputs = self.processor(images=self.Image.fromarray(tile), do_resize=False, do_center_crop=False, return_tensors="pt").to(self.device)
                tile_h, tile_w = inputs.pixel_values.shape[-2:]
                grid_h, grid_w = tile_h // self.patch, tile_w // self.patch
                with torch.inference_mode(), torch.autocast("cuda", dtype=self.amp_dtype):
                    tokens = self.dino(**inputs).last_hidden_state[:, -grid_h * grid_w:, :]
                    features = f.normalize(tokens.float(), dim=-1).reshape(grid_h, grid_w, self.feature_dim).permute(2, 0, 1)
                value = features.cpu().numpy()
                gy, gx = y // self.patch, x // self.patch
                blend = np.outer(feather(grid_h, iy > 0, iy + 1 < len(ys)), feather(grid_w, ix > 0, ix + 1 < len(xs)))
                feature_sum[:, gy:gy + grid_h, gx:gx + grid_w] += value * blend[None]
                weights[gy:gy + grid_h, gx:gx + grid_w] += blend

        if (weights == 0).any():
            raise AnalysisUnavailable("DINOv3 feature stitching left an uncovered image area.")
        feature_sum /= weights[None]
        feature_sum /= np.maximum(np.linalg.norm(feature_sum, axis=0, keepdims=True), 1e-8)
        return feature_sum, (padded_height, padded_width)

    def _semantic_probabilities(self, image):
        np, torch, f = self.np, self.torch, self.functional
        self._move_to_gpu(self.dino, self.head)
        try:
            features, model_hw = self._feature_grid(image)
            with torch.inference_mode():
                head_input = torch.from_numpy(features[None]).to(self.device, dtype=self.amp_dtype)
                logits = self.head(head_input).float()
                logits = f.interpolate(logits, size=image.shape[:2], mode="bilinear", align_corners=False)[0]
            values = logits.permute(1, 2, 0).cpu().numpy()
            values -= values.max(axis=-1, keepdims=True)
            np.exp(values, out=values)
            values /= np.maximum(values.sum(axis=-1, keepdims=True), 1e-12)
            return values.astype(np.float32)
        finally:
            self._release_gpu(self.dino, self.head)

    def _geo_area(self, image):
        """Returns the near/mid eligible region without exposing it in the result image."""
        np, torch = self.np, self.torch
        self._move_to_gpu(self.geo, reduced_precision=False)
        try:
            height, width = image.shape[:2]
            tensor = torch.from_numpy(image.copy()).permute(2, 0, 1).float().to(self.device) / 255.0
            with torch.inference_mode():
                output = self.geo.calibrate(tensor, camera_model="pinhole")
                _, latitude = self.get_perspective_field(output["camera"], output["gravity"])
            latitude = latitude.detach().float().cpu().numpy().squeeze()
            latitude = self.cv2.resize(latitude, (width, height), interpolation=self.cv2.INTER_LINEAR)
            raw_confidence = output.get("latitude_confidence")
            if raw_confidence is None:
                confidence = np.ones((height, width), dtype=np.float32)
            else:
                confidence = raw_confidence.detach().float().cpu().numpy().squeeze()
                confidence = self.cv2.resize(confidence, (width, height), interpolation=self.cv2.INTER_LINEAR)
                log_value = np.log10(np.maximum(confidence, 1e-12))
                lo, hi = np.percentile(log_value, [2, 98])
                confidence = np.ones_like(log_value) if hi - lo < 1e-6 else np.clip((log_value - lo) / (hi - lo), 0, 1)
            return (latitude <= self.config.geo_latitude_limit) & (confidence >= self.config.geo_confidence_min)
        finally:
            self._release_gpu(self.geo)

    def _sky_safe_fallback(self, shape):
        """Fallback SAM area when GeoCalib cannot establish a near/mid region.

        This is a visible policy choice, not a GeoCalib result: exclude the upper
        22% of an oblique image so a failed calibration cannot invite detections
        in sky and distant horizon pixels.
        """
        eligible = self.np.ones(shape, dtype=bool)
        sky_rows = max(1, int(round(shape[0] * 0.22)))
        eligible[:sky_rows, :] = False
        return eligible

    def _compact_mask(self, mask, offset_x: int, offset_y: int, score: float, internal_edge: bool):
        yy, xx = self.np.nonzero(mask)
        if not len(xx):
            return None
        x1, x2, y1, y2 = int(xx.min()), int(xx.max() + 1), int(yy.min()), int(yy.max() + 1)
        return {
            "mask": mask[y1:y2, x1:x2].astype(bool),
            "bbox": [x1 + offset_x, y1 + offset_y, x2 + offset_x, y2 + offset_y],
            "area_px": int(len(xx)), "score": float(score), "internal_tile_edge": internal_edge,
            "centroid_x": float(xx.mean() + offset_x), "centroid_y": float(yy.mean() + offset_y),
        }

    def _overlap(self, first: dict, second: dict) -> tuple[float, float]:
        ax1, ay1, ax2, ay2 = first["bbox"]
        bx1, by1, bx2, by2 = second["bbox"]
        x1, y1, x2, y2 = max(ax1, bx1), max(ay1, by1), min(ax2, bx2), min(ay2, by2)
        if x2 <= x1 or y2 <= y1:
            return 0.0, 0.0
        intersection = int((first["mask"][y1 - ay1:y2 - ay1, x1 - ax1:x2 - ax1] & second["mask"][y1 - by1:y2 - by1, x1 - bx1:x2 - bx1]).sum())
        return intersection / max(first["area_px"] + second["area_px"] - intersection, 1), intersection / max(min(first["area_px"], second["area_px"]), 1)

    def _sam_instances(self, image, allowed, prompt: str, support_mask=None, threshold: float | None = None):
        np, torch = self.np, self.torch
        threshold = self.config.sam_threshold if threshold is None else float(threshold)
        height, width = image.shape[:2]
        self._move_to_gpu(self.sam)
        candidates: list[dict] = []
        for y in self._origins(height, self.config.sam_tile, self.config.sam_overlap):
            for x in self._origins(width, self.config.sam_tile, self.config.sam_overlap):
                tile = image[y:min(y + self.config.sam_tile, height), x:min(x + self.config.sam_tile, width)]
                if not allowed[y:y + tile.shape[0], x:x + tile.shape[1]].any():
                    continue
                inputs = self.sam_processor(images=self.Image.fromarray(tile), text=prompt, return_tensors="pt").to(self.device)
                with torch.inference_mode(), torch.autocast("cuda", dtype=self.amp_dtype):
                    output = self.sam(**inputs)
                result = self.sam_processor.post_process_instance_segmentation(
                    output, threshold=threshold, mask_threshold=self.config.sam_mask_threshold,
                    target_sizes=inputs.get("original_sizes").tolist(),
                )[0]
                for mask, score in zip(result["masks"], result["scores"]):
                    score = float(score.detach().float().cpu())
                    local = mask.detach().cpu().numpy().astype(bool)
                    if support_mask is not None:
                        # SAM3 can join adjacent roofs into one wide object in
                        # aerial imagery.  Intersect building masks with the
                        # DINOv3 built-area class, then keep the largest joined
                        # component so the displayed box follows one roof.
                        support = support_mask[y:y + tile.shape[0], x:x + tile.shape[1]]
                        local &= support
                        if local.sum() < self.config.sam_min_pixels:
                            continue
                        component_count, component_labels, component_stats, _ = self.cv2.connectedComponentsWithStats(local.astype("uint8"), 8)
                        if component_count > 1:
                            keep = 1 + int(component_stats[1:, self.cv2.CC_STAT_AREA].argmax())
                            local = component_labels == keep
                    if score < threshold or local.sum() < self.config.sam_min_pixels:
                        continue
                    record = self._compact_mask(
                        local, x, y, score,
                        bool((x > 0 and local[:, 0].any()) or (y > 0 and local[0, :].any()) or
                             (x + tile.shape[1] < width and local[:, -1].any()) or (y + tile.shape[0] < height and local[-1, :].any())),
                    )
                    if record:
                        cy, cx = int(round(record["centroid_y"])), int(round(record["centroid_x"]))
                        if allowed[min(cy, height - 1), min(cx, width - 1)]:
                            candidates.append(record)
        ordered = sorted(candidates, key=lambda item: (not item["internal_tile_edge"], item["score"], item["area_px"]), reverse=True)
        kept: list[dict] = []
        for record in ordered:
            if any((lambda pair: pair[0] >= .50 or pair[1] >= .85)(self._overlap(record, other)) for other in kept):
                continue
            kept.append(record)
        result = sorted(kept, key=lambda item: (item["centroid_y"], item["centroid_x"]))
        self._release_gpu(self.sam)
        return result

    def _write_overlay(self, image, prediction, water, buildings, vehicles, directory: Path):
        np = self.np
        directory.mkdir(parents=True, exist_ok=True)
        base = image.astype(np.float32)
        palette = np.asarray([[int(colour[index:index + 2], 16) for index in (1, 3, 5)] for colour in CLASS_COLOURS], dtype=np.float32)
        semantic = (0.52 * base + 0.48 * palette[prediction]).astype(np.uint8)
        water_overlay = base.copy()
        water_overlay[water] = 0.56 * water_overlay[water] + 0.44 * palette[1]
        tree_overlay = base.copy()
        green = prediction == 3
        tree_overlay[green] = 0.48 * tree_overlay[green] + 0.52 * palette[3]
        masks = base.copy()
        rng = np.random.default_rng(42)
        for index, record in enumerate(buildings, start=1):
            record["instance_id"] = f"B{index:03d}"
            x1, y1, x2, y2 = record["bbox"]
            colour = rng.integers(70, 225, size=3)
            local = masks[y1:y2, x1:x2]
            local[record["mask"]] = 0.48 * local[record["mask"]] + 0.52 * colour

            # Use an opaque, thicker yellow boundary so the box remains visible
            # after the result image is scaled down in the browser.
            # The output array is RGB before Pillow writes it, so use RGB yellow.
            border_colour = (255, 212, 0)
            # A 2 px anti-aliased line is only slightly stronger, while preserving
            # the building geometry when dense detections overlap.
            self.cv2.rectangle(masks, (x1, y1), (x2 - 1, y2 - 1), border_colour, thickness=2, lineType=self.cv2.LINE_AA)

            # Keep the building code and confidence, but omit a solid label box
            # so densely detected roofs remain visible.
            label = f'{record["instance_id"]} {record["score"] * 100:.0f}%'
            font = self.cv2.FONT_HERSHEY_SIMPLEX
            font_scale, font_thickness = 0.42, 1
            (label_width, label_height), baseline = self.cv2.getTextSize(label, font, font_scale, font_thickness)
            label_x = max(0, min(x1 + 2, masks.shape[1] - label_width - 2))
            label_y = max(label_height + baseline + 2, y1 + label_height + baseline + 2)
            # A dark outline makes small yellow text readable on both roofs and water.
            self.cv2.putText(
                masks, label, (label_x, label_y), font, font_scale,
                (20, 25, 20), 3, lineType=self.cv2.LINE_AA,
            )
            self.cv2.putText(
                masks, label, (label_x, label_y), font, font_scale,
                border_colour, font_thickness, lineType=self.cv2.LINE_AA,
            )
        vehicle_overlay = base.copy()
        vehicle_colour = np.asarray([220, 52, 52], dtype=np.float32)
        for record in vehicles:
            x1, y1, x2, y2 = record["bbox"]
            local = vehicle_overlay[y1:y2, x1:x2]
            local[record["mask"]] = 0.70 * local[record["mask"]] + 0.30 * vehicle_colour
            # Keep the subtle red mask, with a clear white 2 px vehicle boundary.
            self.cv2.rectangle(vehicle_overlay, (x1, y1), (x2 - 1, y2 - 1), (255, 255, 255), thickness=2, lineType=self.cv2.LINE_AA)
        output = {
            "semantic": semantic,
            "water": water_overlay.astype(np.uint8),
            "buildings": masks.astype(np.uint8),
            "vehicles": vehicle_overlay.astype(np.uint8),
            "trees": tree_overlay.astype(np.uint8),
        }
        for name, value in output.items():
            self.Image.fromarray(value).save(directory / f"{name}.png")
        return output

    def analyse(self, image_path: Path, output_dir: Path, apply_geo_filter: bool = True) -> dict[str, Any]:
        self._load()
        threshold = self.config.sam_threshold
        try:
            image = self.np.asarray(self.Image.open(image_path).convert("RGB"))
            probabilities = self._semantic_probabilities(image)
            prediction = probabilities.argmax(axis=-1).astype(self.np.uint8)
            water = probabilities[..., 1] >= self.config.water_threshold
            allowed = self._geo_area(image) if apply_geo_filter else self.np.ones(water.shape, dtype=bool)
            geo_eligible_percent = 100 * float(allowed.mean())
            geo_filter_effective = bool(apply_geo_filter and geo_eligible_percent >= 1.0)
            if apply_geo_filter and not geo_filter_effective:
                # Do not fall back to the complete image: sky and horizon are
                # explicitly outside the safe analysis area when GeoCalib fails.
                allowed = self._sky_safe_fallback(water.shape)
            eligible_percent = 100 * float(allowed.mean())
            built_support = prediction == 2
            built_support = self.cv2.dilate(built_support.astype("uint8"), self.np.ones((5, 5), dtype="uint8"), iterations=1).astype(bool)
            buildings = self._sam_instances(image, allowed, prompt="building", support_mask=built_support, threshold=threshold)
            # Vehicles follow the same safe region, so a GeoCalib fallback also
            # cannot create vehicle detections in sky or distant horizon pixels.
            vehicle_allowed = allowed
            vehicles = self._sam_instances(image, vehicle_allowed, prompt="vehicle", threshold=threshold)
            self._write_overlay(image, prediction, water, buildings, vehicles, output_dir)
            fractions = {CLASS_NAMES[index]: round(100 * float((prediction == index).mean()), 2) for index in range(5)}
            return {
                "water_percent": round(100 * float(water.mean()), 2),
                "building_objects": len(buildings),
                "vehicle_objects": len(vehicles),
                "class_area_percent": fractions,
                "water_threshold": self.config.water_threshold,
                "sam_threshold": threshold,
                "geo_filter_requested": apply_geo_filter,
                "geo_filter_applied": geo_filter_effective,
                "sam_eligible_area_percent": round(eligible_percent if apply_geo_filter else 100.0, 2),
                "sam_analysis_region": "near_mid" if geo_filter_effective else ("fallback_without_sky" if apply_geo_filter else "full_image"),
                "geo_eligible_area_percent": round(geo_eligible_percent if apply_geo_filter else 100.0, 2),
                "building_objects_detail": [
                    {key: record[key] for key in ("instance_id", "bbox", "area_px", "score", "centroid_x", "centroid_y")}
                    for record in buildings
                ],
                "vehicle_objects_detail": [
                    {key: record[key] for key in ("bbox", "area_px", "score", "centroid_x", "centroid_y")}
                    for record in vehicles
                ],
            }
        finally:
            self._release_gpu(self.dino, self.head, self.geo, self.sam)
