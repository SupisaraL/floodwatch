# FloodWatch deployment bundle

This standalone bundle contains the current FloodWatch UI, its fixed study assets, built-in samples, map source images, the trained semantic head, and cached SAM3/DINOv3/GeoCalib model files.

## What is trained in this study

`backend/model_assets/fullmask_best_head.pt` is the study-trained semantic classification head (about 0.76 MiB). It is used with the frozen, pretrained DINOv3 encoder in `model-cache/` (about 82 MiB). The encoder is still required at inference time because the small trained head only interprets DINOv3 features; it is not a complete replacement for DINOv3.

SAM3 was not fine-tuned in this project. The validated SAM confidence threshold is fixed at 50%, but the base SAM3 checkpoint is still required to generate building masks. That checkpoint is about 3.2 GiB and is the main reason this bundle is large. GeoCalib adds about 111 MiB.

## Windows setup with NVIDIA GPU

The application requires a CUDA-enabled PyTorch build. From the project root, run this once in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows_gpu.ps1
```

The setup replaces a CPU-only PyTorch installation with the CUDA 12.8 build verified with this project and then checks that CUDA is available. It downloads Python packages but does not modify the model cache or study files.

Start the web server afterwards:

```powershell
powershell -ExecutionPolicy Bypass -File .\start_windows_gpu.ps1
```

Open `http://127.0.0.1:8010` in a browser. Use `0.0.0.0` only as the server bind address, not as the browser URL.

Runtime uploads and results are written to `runtime/`; mount that directory as a persistent volume in Docker if user-created results must survive a container restart.

## Docker (local GPU test)

Docker Desktop must be running with the WSL 2 backend and GPU support enabled. The model cache remains on the host and is mounted read-only, so it is not copied into the Docker image.

If `docker` is not recognized in the VS Code terminal after Docker Desktop starts, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\prepare_docker_cli.ps1
```

```powershell
docker compose up --build
```

Open `http://localhost:8010`, upload an image, and confirm that the analysis completes. The first build downloads the Linux CUDA PyTorch packages and can take time. Stop the service with `docker compose down`.

The Docker build intentionally excludes `.venv`, `model-cache`, and generated `runtime` outputs. The `model-cache` folder and its 3.4 GiB of files must stay alongside `docker-compose.yml` while the container runs.
"# floodwatch" 
