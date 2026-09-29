"""FastAPI application serving FloodWatch locally."""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.georeferencing import approximate_positions
from backend.pipeline import AnalysisUnavailable, ResearchPipeline


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
RUNTIME = ROOT / "runtime"
UPLOADS = RUNTIME / "uploads"
RESULTS = RUNTIME / "results"
MAPS = RUNTIME / "maps"
ZONE_IMAGES = MAPS / "zone_images"
DATA = ROOT / "data"
SOURCE_PICTURES = DATA / "map-source-images"
SAMPLE_IMAGES = {
    "TEST_IMAGE_1": DATA / "samples" / "TEST_IMAGE_1.jpg",
    "TEST_IMAGE_2": DATA / "samples" / "TEST_IMAGE_2.jpg",
    "TEST_IMAGE_3": DATA / "samples" / "TEST_IMAGE_3.jpg",
    "TEST_IMAGE_4": DATA / "samples" / "TEST_IMAGE_4.png",
}
for folder in (UPLOADS, RESULTS, MAPS, ZONE_IMAGES):
    folder.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="FloodWatch", version="0.1.0")
app.mount("/assets", StaticFiles(directory=FRONTEND), name="assets")
app.mount("/results", StaticFiles(directory=RESULTS), name="results")
app.mount("/maps", StaticFiles(directory=MAPS), name="maps")
app.mount("/source-pics", StaticFiles(directory=SOURCE_PICTURES), name="source-pics")
pipeline = ResearchPipeline(ROOT / "backend" / "model_assets")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/health")
def health():
    return {
        "service": "FloodWatch local analysis service",
        "model": "DINOv3 + GeoCalib + SAM3",
        "mode": "local GPU inference",
        "note": "The model is loaded only after an image is analysed.",
    }


@app.get("/api/sample-images/{sample_id}")
def sample_image(sample_id: str):
    """Serves the three built-in example images used by the analysis picker."""
    image = SAMPLE_IMAGES.get(sample_id)
    if image is None or not image.is_file():
        raise HTTPException(status_code=404, detail="Sample image not found.")
    media_type = "image/png" if image.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(image, media_type=media_type, filename=image.name)


@app.post("/api/analyse")
async def analyse_image(
    image: UploadFile = File(...),
    apply_geo_filter: bool = Form(True),
):
    suffix = Path(image.filename or "upload.png").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}:
        raise HTTPException(status_code=415, detail="Use a JPG, PNG, or TIFF image.")
    job_id = uuid.uuid4().hex
    input_path = UPLOADS / f"{job_id}{suffix}"
    output_dir = RESULTS / job_id
    try:
        with input_path.open("wb") as target:
            shutil.copyfileobj(image.file, target)
        result = pipeline.analyse(
            input_path, output_dir,
            apply_geo_filter=apply_geo_filter,
        )
    except AnalysisUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Analysis stopped: {type(error).__name__}: {error}") from error
    finally:
        await image.close()

    result.update({
        "job_id": job_id,
        "source_image": f"/results/{job_id}/source{suffix}",
        "images": {name: f"/results/{job_id}/{name}.png" for name in ("semantic", "water", "buildings", "vehicles", "trees")},
    })
    shutil.copy2(input_path, output_dir / f"source{suffix}")
    (output_dir / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


@app.post("/api/map/raster")
async def upload_base_raster(raster: UploadFile = File(...)):
    """Keeps a user raster for the map workspace; no coordinates are inferred."""
    suffix = Path(raster.filename or "base-map.tif").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}:
        raise HTTPException(status_code=415, detail="Use a JPG, PNG, or TIFF base map.")
    raster_id = uuid.uuid4().hex
    target = MAPS / f"{raster_id}{suffix}"
    with target.open("wb") as stream:
        shutil.copyfileobj(raster.file, stream)
    await raster.close()
    return {"raster_id": raster_id, "filename": raster.filename, "message": "Base raster uploaded. Add verified control points before using map coordinates."}


@app.post("/api/map/zone-images")
async def upload_zone_images(images: list[UploadFile] = File(...)):
    """Stores optional thumbnails used by a user-defined image-zone popup."""
    accepted = {".jpg", ".jpeg", ".png", ".webp"}
    uploaded = []
    for image in images:
        suffix = Path(image.filename or "zone-image.png").suffix.lower()
        if suffix not in accepted:
            await image.close()
            raise HTTPException(status_code=415, detail="Zone images must be JPG, PNG, or WEBP.")
        image_id = uuid.uuid4().hex
        target = ZONE_IMAGES / f"{image_id}{suffix}"
        with target.open("wb") as stream:
            shutil.copyfileobj(image.file, stream)
        uploaded.append({
            "name": image.filename or f"image{suffix}",
            "url": f"/maps/zone_images/{target.name}",
        })
        await image.close()
    return {"images": uploaded}


@app.get("/api/map/source-images")
def source_images():
    """Lists original CM flood photographs that can be shown in the fixed zone gallery."""
    accepted = {".jpg", ".jpeg", ".png", ".webp"}
    images = [
        {
            "image_id": image.stem,
            "name": image.name,
            "url": f"/source-pics/{image.name}",
        }
        for image in sorted(SOURCE_PICTURES.iterdir())
        if image.is_file() and image.suffix.lower() in accepted
    ]
    return {"images": images}


@app.post("/api/map/control-points")
async def save_control_points(payload: dict):
    """Stores manually supplied points for the next georeferencing implementation step."""
    points = payload.get("points", [])
    if len(points) < 4:
        raise HTTPException(status_code=422, detail="At least four control points are required.")
    required = {"image_x", "image_y", "latitude", "longitude", "role"}
    if any(not required.issubset(point) for point in points):
        raise HTTPException(status_code=422, detail="Each point needs image_x, image_y, latitude, longitude, and role.")
    control_id = uuid.uuid4().hex
    (MAPS / f"{control_id}.json").write_text(json.dumps(points, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"control_id": control_id, "count": len(points), "status": "saved_for_georeferencing"}


@app.post("/api/map/georeference")
async def georeference_buildings(payload: dict):
    job_id = str(payload.get("job_id", ""))
    points = payload.get("points", [])
    summary_path = RESULTS / job_id / "summary.json"
    if not job_id or not summary_path.exists():
        raise HTTPException(status_code=404, detail="Analyse an image before creating a map layer.")
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        result = approximate_positions(points, summary.get("building_objects_detail", []))
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    geojson_path = RESULTS / job_id / "building_objects_approximate.geojson"
    geojson_path.write_text(json.dumps(result["geojson"], ensure_ascii=False, indent=2), encoding="utf-8")
    result["geojson_url"] = f"/results/{job_id}/building_objects_approximate.geojson"
    return result
