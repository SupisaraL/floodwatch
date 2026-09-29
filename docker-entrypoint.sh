#!/bin/sh
set -eu

python - <<'PY'
import sys
import torch

if not torch.cuda.is_available():
    sys.stderr.write('CUDA GPU was not detected inside Docker. Verify Docker Desktop uses WSL 2 and start with GPU access.\n')
    raise SystemExit(1)
print(f'CUDA ready in Docker: {torch.__version__} | {torch.cuda.get_device_name(0)}')
PY

exec "$@"
