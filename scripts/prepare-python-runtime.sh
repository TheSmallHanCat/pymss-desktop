#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-cuda}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_DIR="${RUNTIME_DIR:-python-runtime}"
RUNTIME_HOME="$(cd "$(dirname "$RUNTIME_DIR")" && pwd)/$(basename "$RUNTIME_DIR")"
TORCH_VERSION="${TORCH_VERSION:-2.7.1}"
TORCH_INDEX_URL="${TORCH_INDEX_URL-https://download.pytorch.org/whl/cu128}"
PBS_TAG="${PBS_TAG:-20260602}"
PBS_PYTHON_VERSION="${PBS_PYTHON_VERSION:-3.12.13}"

rm -rf "$RUNTIME_DIR"

if [[ "$OSTYPE" == darwin* ]]; then
  ARCHIVE="cpython-${PBS_PYTHON_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz"
  URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${ARCHIVE//+/%2B}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -L --fail --retry 3 --retry-delay 2 -o "$TMP_DIR/pbs.tar.gz" "$URL"
  tar -xzf "$TMP_DIR/pbs.tar.gz" -C "$TMP_DIR"
  mv "$TMP_DIR/python" "$RUNTIME_DIR"
  PY="$RUNTIME_DIR/bin/python3"
  if [[ ! -x "$PY" ]]; then
    echo "Bundled macOS standalone python executable not found in $RUNTIME_DIR/bin/python3" >&2
    exit 1
  fi
else
  "$PYTHON_BIN" -m venv "$RUNTIME_DIR"
  PY="$RUNTIME_DIR/bin/python"
fi

PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --upgrade pip setuptools wheel
if [[ -n "$TORCH_VERSION" ]]; then
  TORCH_REQUIREMENT="torch==${TORCH_VERSION}"
else
  TORCH_REQUIREMENT="torch"
fi

if [[ -z "$TORCH_INDEX_URL" ]]; then
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT"
else
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT" --index-url "$TORCH_INDEX_URL"
fi
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir --only-binary=:all: --prefer-binary av filelock fsspec jinja2 librosa networkx numpy pysocks requests pyyaml sympy tqdm typing-extensions
if [[ "$VARIANT" == "mlx" || "$VARIANT" == "mps" ]]; then
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir mlx
fi
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir --no-deps "pymss>=2.0.15" pymss-core==0.1.4

bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
PYTHONDONTWRITEBYTECODE=1 PYTHONHOME="$RUNTIME_HOME" "$PY" - <<'PY'
import importlib.util
import pymss, torch, librosa, av, yaml, tqdm
print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__)
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available())
print('librosa', librosa.__version__)
print('av', av.__version__)
print('mlx', importlib.util.find_spec('mlx') is not None)
PY
bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
