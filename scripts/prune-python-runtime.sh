#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${1:?runtime dir required}"

rm -rf "$RUNTIME_DIR/Doc" "$RUNTIME_DIR/docs" "$RUNTIME_DIR/include" "$RUNTIME_DIR/libs" "$RUNTIME_DIR/share" "$RUNTIME_DIR/tcl"
find "$RUNTIME_DIR" -type d \( -name '__pycache__' -o -name 'test' -o -name 'tests' \) -prune -exec rm -rf {} + || true
find "$RUNTIME_DIR" -type f \( -name '*.pyc' -o -name '*.pyo' -o -name '*.a' -o -name '*.la' -o -name '*.h' -o -name '*.hpp' \) -delete || true
find "$RUNTIME_DIR" -path '*/site-packages/torch/*' -type f -name '*.lib' -delete || true
find "$RUNTIME_DIR" -path '*/site-packages/torch/share/cmake' -type d -prune -exec rm -rf {} + || true
find "$RUNTIME_DIR" -path '*/site-packages/*' -maxdepth 1 -type d \( -name 'pip' -o -name 'pip-*' -o -name 'setuptools' -o -name 'setuptools-*' -o -name 'wheel' -o -name 'wheel-*' \) -prune -exec rm -rf {} + || true

du -sh "$RUNTIME_DIR" || true

# Note: do not remove site-packages/torch/testing. PyTorch imports torch.testing during normal startup.
