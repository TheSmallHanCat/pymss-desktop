#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-cuda}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_DIR="${RUNTIME_DIR:-python-runtime}"
TORCH_VERSION="${TORCH_VERSION:-2.7.1}"
TORCH_INDEX_URL="${TORCH_INDEX_URL-https://download.pytorch.org/whl/cu128}"

rm -rf "$RUNTIME_DIR"
"$PYTHON_BIN" -m venv "$RUNTIME_DIR"
PY="$RUNTIME_DIR/bin/python"

"$PY" -m pip install --upgrade pip setuptools wheel
if [[ -n "$TORCH_VERSION" ]]; then
  TORCH_REQUIREMENT="torch==${TORCH_VERSION}"
else
  TORCH_REQUIREMENT="torch"
fi

if [[ -z "$TORCH_INDEX_URL" ]]; then
  "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT"
else
  "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT" --index-url "$TORCH_INDEX_URL"
fi
"$PY" -m pip install --no-cache-dir av librosa numpy pyyaml tqdm

bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
PYTHONDONTWRITEBYTECODE=1 "$PY" - <<'PY'
import torch, librosa, av, yaml, tqdm
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available())
print('librosa', librosa.__version__)
print('av', av.__version__)
PY
bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
