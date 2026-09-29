FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/model-cache/huggingface \
    TORCH_HOME=/app/model-cache/torch

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install the CUDA PyTorch build first. requirements.txt deliberately does not
# install a generic CPU-only torch package.
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cu128 \
       torch==2.11.0+cu128 torchvision==0.26.0+cu128

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY data ./data
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p runtime/uploads runtime/results runtime/maps/zone_images \
    && chmod +x docker-entrypoint.sh

EXPOSE 8010
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8010"]
