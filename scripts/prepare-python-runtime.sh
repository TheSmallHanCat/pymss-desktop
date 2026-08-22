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

RUNTIME_ENVS_DIR="${RUNTIME_ENVS_DIR:-$RUNTIME_DIR/runtime-envs}"
INITIAL_BACKEND="${INITIAL_BACKEND:-}"

if [[ -n "$TORCH_VERSION" ]]; then
  TORCH_REQUIREMENT="torch==${TORCH_VERSION}"
else
  TORCH_REQUIREMENT="torch"
fi

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

if [[ "$OSTYPE" == darwin* && "$INITIAL_BACKEND" == "mlx" ]]; then
  rm -rf "$RUNTIME_ENVS_DIR"
  mkdir -p "$RUNTIME_ENVS_DIR"
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m ensurepip --upgrade
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --upgrade pip setuptools wheel
  ENV_DIR="$RUNTIME_ENVS_DIR/mlx"
  ENV_HOME="$(cd "$(dirname "$ENV_DIR")" && pwd)/$(basename "$ENV_DIR")"
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m venv --copies "$ENV_DIR"
  ENV_PY="$ENV_DIR/bin/python"
  "$ENV_PY" -m pip install --upgrade pip setuptools wheel
  if [[ -z "$TORCH_INDEX_URL" ]]; then
    "$ENV_PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT"
  else
    "$ENV_PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT" --index-url "$TORCH_INDEX_URL"
  fi
  "$ENV_PY" -m pip install --no-cache-dir --only-binary=:all: --prefer-binary av filelock fsspec jinja2 librosa networkx numpy pysocks requests pyyaml sympy tqdm typing-extensions mlx
  "$ENV_PY" -m pip install --no-cache-dir --upgrade --no-deps "pymss>=2.0.15" "pymss-core>=0.1.6"
  bash "$(dirname "$0")/prune-python-runtime.sh" "$ENV_DIR" --keep-venv
  "$ENV_PY" -m pip --version
  python3 - "$RUNTIME_ENVS_DIR" "$ENV_PY" "$(dirname "$0")/../python/runtime-manifest.json" <<'PY'
import json
import platform
import sys
from pathlib import Path

envs = Path(sys.argv[1])
python_path = Path(sys.argv[2]).resolve()
manifest_version = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))["manifestVersion"]
state = {
    "backend": "mlx",
    "manifestVersion": manifest_version,
    "pythonVersion": platform.python_version(),
    "torchBackend": "cpu",
    "acceleratorAvailable": False,
    "packages": {"mlx": True},
}
(python_path.parent.parent / "pymss-runtime-state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
(envs / "active-runtime.json").write_text(json.dumps({**state, "pythonPath": str(python_path)} , indent=2) + "\n", encoding="utf-8")
PY
  exit 0
fi

if [[ "$OSTYPE" == darwin* && -z "$INITIAL_BACKEND" ]]; then
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m ensurepip --upgrade
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --upgrade pip setuptools wheel
  bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR" --keep-venv
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip --version
  exit 0
fi

PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --upgrade pip setuptools wheel

if [[ -z "$TORCH_INDEX_URL" ]]; then
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT"
else
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT" --index-url "$TORCH_INDEX_URL"
fi
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir --only-binary=:all: --prefer-binary av filelock fsspec jinja2 librosa networkx numpy pysocks requests pyyaml sympy tqdm typing-extensions
if [[ "$VARIANT" == "mlx" || "$VARIANT" == "mps" ]]; then
  PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir mlx
fi
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip install --no-cache-dir --upgrade --no-deps "pymss>=2.0.15" "pymss-core>=0.1.6"

bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR" --keep-venv
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip --version
PYTHONDONTWRITEBYTECODE=1 PYTHONHOME="$RUNTIME_HOME" "$PY" - <<'PY'
import importlib.util
import pymss, torch, librosa, av, yaml, tqdm
print('pymss', getattr(pymss, '__version__', 'unknown'), pymss.__file__)
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available())
print('librosa', librosa.__version__)
print('av', av.__version__)
print('mlx', importlib.util.find_spec('mlx') is not None)
PY
bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR" --keep-venv
PYTHONHOME="$RUNTIME_HOME" "$PY" -m pip --version
