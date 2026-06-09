#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "Usage: $0 /path/to/App.app" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS codesign flows." >&2
  exit 1
fi

SIGN_IDENTITY="${SIGN_IDENTITY:--}"

sign_file() {
  local path="$1"
  if file -b "$path" | grep -q 'Mach-O'; then
    codesign --force --sign "$SIGN_IDENTITY" --timestamp=none "$path"
  fi
}

while IFS= read -r -d '' path; do
  sign_file "$path"
done < <(python3 - "$APP_PATH/Contents" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
paths = []
for base, _, files in os.walk(root):
    for name in files:
        path = os.path.join(base, name)
        mode = os.stat(path, follow_symlinks=False).st_mode
        if (
            name.endswith((".so", ".dylib", ".bundle"))
            or stat.S_IXUSR & mode
            or "/bin/" in path
        ):
            paths.append(path)

for path in sorted(paths, key=lambda item: (item.count(os.sep), len(item)), reverse=True):
    sys.stdout.buffer.write(path.encode() + b"\0")
PY
)

while IFS= read -r -d '' bundle; do
  codesign --force --sign "$SIGN_IDENTITY" --timestamp=none "$bundle"
done < <(python3 - "$APP_PATH/Contents" <<'PY'
import os
import sys

root = sys.argv[1]
suffixes = (".app", ".framework", ".xpc", ".appex")
paths = []
for base, dirs, _ in os.walk(root):
    for name in dirs:
        path = os.path.join(base, name)
        if path.endswith(suffixes):
            paths.append(path)

for path in sorted(paths, key=lambda item: (item.count(os.sep), len(item)), reverse=True):
    sys.stdout.buffer.write(path.encode() + b"\0")
PY
)

codesign --force --sign "$SIGN_IDENTITY" --timestamp=none "$APP_PATH"
