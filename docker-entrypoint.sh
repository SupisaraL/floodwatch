#!/bin/sh
set -eu

python - <<'PY'
import os
import sys
import torch

device = os.environ.get("FLOODWATCH_DEVICE", "cuda").strip().lower()
if device == "cpu":
    print(f'CPU inference enabled in Docker: {torch.__version__}')
    raise SystemExit(0)
if device != "cuda" or not torch.cuda.is_available():
    sys.stderr.write('CUDA GPU was not detected inside Docker. Configure GPU access or set FLOODWATCH_DEVICE=cpu.\n')
    raise SystemExit(1)
print(f'CUDA ready in Docker: {torch.__version__} | {torch.cuda.get_device_name(0)}')
PY

exec "$@"
