#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-cuda}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_DIR="${RUNTIME_DIR:-python-runtime}"
TORCH_VERSION="${TORCH_VERSION:-2.7.1}"
TORCH_INDEX_URL="${TORCH_INDEX_URL-https://download.pytorch.org/whl/cu128}"

rm -rf "$RUNTIME_DIR"

if [[ "$OSTYPE" == darwin* ]]; then
  PY_INFO="$("$PYTHON_BIN" - <<'PY'
import sys
print(sys.base_prefix)
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
)"
  BASE_PREFIX="$(printf '%s\n' "$PY_INFO" | sed -n '1p')"
  PY_VERSION="$(printf '%s\n' "$PY_INFO" | sed -n '2p')"

  mkdir -p "$RUNTIME_DIR"
  rsync -a \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'include' \
    --exclude 'pkgs' \
    --exclude 'envs' \
    --exclude 'conda-meta' \
    --exclude 'condabin' \
    --exclude 'libexec' \
    --exclude 'shell' \
    --exclude 'man' \
    --exclude 'doc' \
    --exclude 'docs' \
    --exclude 'share/doc' \
    --exclude 'share/man' \
    "$BASE_PREFIX/" "$RUNTIME_DIR/"

  PY="$RUNTIME_DIR/bin/python3"
  if [[ ! -x "$PY" ]]; then
    PY="$RUNTIME_DIR/bin/python"
  fi
  if [[ ! -x "$PY" ]]; then
    echo "Bundled macOS python executable not found in $RUNTIME_DIR/bin" >&2
    exit 1
  fi

  LINKED_PYTHON="$(otool -L "$PY" | awk '/Python\.framework\/Versions\/[0-9.]+\/Python$/ { print $1; exit }')"
  if [[ -n "${LINKED_PYTHON:-}" && -f "$RUNTIME_DIR/Python" ]]; then
    for EXE in "$RUNTIME_DIR/bin/python" "$RUNTIME_DIR/bin/python3" "$RUNTIME_DIR/bin/python${PY_VERSION}"; do
      if [[ -f "$EXE" ]]; then
        install_name_tool -change "$LINKED_PYTHON" "@executable_path/../Python" "$EXE"
      fi
    done
    install_name_tool -id "@loader_path/Python" "$RUNTIME_DIR/Python"
  fi

  FRAMEWORK_DIR="$RUNTIME_DIR/Python.framework/Versions/$PY_VERSION"
  mkdir -p "$FRAMEWORK_DIR"
  ln -sfn "../../../Python" "$FRAMEWORK_DIR/Python"
  ln -sfn "$PY_VERSION" "$RUNTIME_DIR/Python.framework/Versions/Current"
  ln -sfn "Versions/Current/Python" "$RUNTIME_DIR/Python.framework/Python"
else
  "$PYTHON_BIN" -m venv "$RUNTIME_DIR"
  PY="$RUNTIME_DIR/bin/python"
fi

"$PY" -m pip install --upgrade pip setuptools wheel
if [[ -n "$TORCH_VERSION" ]]; then
  TORCH_REQUIREMENT="torch==${TORCH_VERSION}"
else
  TORCH_REQUIREMENT="torch"
fi

if [[ -z "$TORCH_INDEX_URL" ]]; then
  PYTHONHOME="$RUNTIME_DIR" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT"
else
  PYTHONHOME="$RUNTIME_DIR" "$PY" -m pip install --no-cache-dir "$TORCH_REQUIREMENT" --index-url "$TORCH_INDEX_URL"
fi
PYTHONHOME="$RUNTIME_DIR" "$PY" -m pip install --no-cache-dir av librosa numpy pyyaml tqdm
if [[ "$VARIANT" == "mlx" || "$VARIANT" == "mps" ]]; then
  PYTHONHOME="$RUNTIME_DIR" "$PY" -m pip install --no-cache-dir mlx
fi

bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
PYTHONDONTWRITEBYTECODE=1 DYLD_FRAMEWORK_PATH="$RUNTIME_DIR" PYTHONHOME="$RUNTIME_DIR" "$PY" - <<'PY'
import importlib.util
import torch, librosa, av, yaml, tqdm
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'cuda_available', torch.cuda.is_available())
print('librosa', librosa.__version__)
print('av', av.__version__)
print('mlx', importlib.util.find_spec('mlx') is not None)
PY
bash "$(dirname "$0")/prune-python-runtime.sh" "$RUNTIME_DIR"
