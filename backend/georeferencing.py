"""Exploratory single-image homography from manual control points.

The output is deliberately labelled approximate and must be checked against
independent control points before it is used as a map product.
"""

from __future__ import annotations

from math import sqrt
from typing import Any


def approximate_positions(points: list[dict[str, Any]], buildings: list[dict[str, Any]]) -> dict[str, Any]:
    import cv2
    import numpy as np
    from pyproj import Transformer

    fit = [item for item in points if item.get("role") == "fit"]
    check = [item for item in points if item.get("role") == "check"]
    if len(fit) < 4 or not check:
        raise ValueError("Use at least four fit points and one independent check point.")
    needed = {"image_x", "image_y", "latitude", "longitude", "role"}
    if any(not needed.issubset(item) for item in points):
        raise ValueError("Each point needs image_x, image_y, latitude, longitude, and role.")

    median_longitude = float(np.median([float(p["longitude"]) for p in points]))
    median_latitude = float(np.median([float(p["latitude"]) for p in points]))
    zone = int((median_longitude + 180) // 6) + 1
    epsg = (32600 if median_latitude >= 0 else 32700) + zone
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    to_wgs = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    src = np.array([[float(p["image_x"]), float(p["image_y"])] for p in points], dtype=np.float64)
    east, north = to_utm.transform([float(p["longitude"]) for p in points], [float(p["latitude"]) for p in points])
    target = np.c_[east, north].astype(np.float64)
    fit_index = np.array([i for i, p in enumerate(points) if p["role"] == "fit"], dtype=int)
    check_index = np.array([i for i, p in enumerate(points) if p["role"] == "check"], dtype=int)
    origin = target[fit_index].mean(axis=0)
    matrix, _ = cv2.findHomography(src[fit_index], target[fit_index] - origin, method=0)
    if matrix is None:
        raise ValueError("The selected fit points cannot form a valid homography.")

    def project(values: np.ndarray) -> np.ndarray:
        homogeneous = np.c_[values, np.ones(len(values))] @ matrix.T
        denominator = homogeneous[:, 2]
        if (np.abs(denominator) < 1e-9).any():
            raise ValueError("The transformation projects a point to infinity.")
        return homogeneous[:, :2] / denominator[:, None] + origin

    predicted = project(src)
    errors = np.linalg.norm(predicted - target, axis=1)
    geojson = []
    if buildings:
        centroids = np.array([[item["centroid_x"], item["centroid_y"]] for item in buildings], dtype=np.float64)
        projected = project(centroids)
        longitude, latitude = to_wgs.transform(projected[:, 0], projected[:, 1])
        geojson = [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
             "properties": {"object_id": index, "position_status": "approximate"}}
            for index, (lon, lat) in enumerate(zip(longitude, latitude), start=1)
        ]
    return {
        "method": "single_image_homography_from_manual_control_points",
        "utm_epsg": epsg,
        "position_status": "approximate",
        "fit_rmse_m": round(float(sqrt(np.mean(errors[fit_index] ** 2))), 2),
        "check_rmse_m": round(float(sqrt(np.mean(errors[check_index] ** 2))), 2),
        "geojson": {"type": "FeatureCollection", "features": geojson},
    }
