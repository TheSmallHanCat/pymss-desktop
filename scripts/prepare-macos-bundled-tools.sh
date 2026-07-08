#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="${1:-src-tauri/resources/bin}"
mkdir -p "$DEST_DIR/lib"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS." >&2
  exit 1
fi

copy_one() {
  local source="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp -f "$source" "$dest"
  chmod u+w "$dest"
  if [[ -x "$source" ]]; then
    chmod 755 "$dest"
  fi
}

is_bundled_dep() {
  local dep="$1"
  [[ "$dep" == /opt/homebrew/* || "$dep" == /usr/local/* ]]
}

resolve_dep() {
  local dep="$1"
  local base prefix found
  if is_bundled_dep "$dep" && [[ -f "$dep" ]]; then
    printf '%s\n' "$dep"
    return 0
  fi
  if [[ "$dep" == @rpath/* ]]; then
    base="$(basename "$dep")"
    for prefix in /opt/homebrew /usr/local; do
      [[ -d "$prefix" ]] || continue
      if [[ -f "$prefix/lib/$base" ]]; then
        printf '%s\n' "$prefix/lib/$base"
        return 0
      fi
      found="$(find "$prefix" -path "*/lib/$base" -type f -print -quit 2>/dev/null || true)"
      if [[ -n "$found" ]]; then
        printf '%s\n' "$found"
        return 0
      fi
    done
  fi
  return 1
}

declare -a pending=()
declare -a copied_sources=()

is_copied() {
  local source="$1"
  local item
  for item in "${copied_sources[@]}"; do
    if [[ "$item" == "$source" ]]; then
      return 0
    fi
  done
  return 1
}

mark_copied() {
  copied_sources+=("$1")
}

queue_dep() {
  local dep="$1"
  local resolved
  resolved="$(resolve_dep "$dep" || true)"
  if [[ -n "$resolved" ]] && ! is_copied "$resolved"; then
    pending+=("$resolved")
  fi
}

copy_executable() {
  local name="$1"
  local source
  source="$(command -v "$name" || true)"
  if [[ -z "$source" || ! -x "$source" ]]; then
    echo "$name not found in PATH" >&2
    exit 1
  fi
  copy_one "$source" "$DEST_DIR/$name"
  mark_copied "$source"
  while IFS= read -r dep; do
    queue_dep "$dep"
  done < <(otool -L "$source" | awk 'NR > 1 { print $1 }')
}

copy_dylib_graph() {
  local dep dest
  while ((${#pending[@]} > 0)); do
    dep="${pending[0]}"
    pending=("${pending[@]:1}")
    if is_copied "$dep"; then
      continue
    fi
    dest="$DEST_DIR/lib/$(basename "$dep")"
    copy_one "$dep" "$dest"
    mark_copied "$dep"
    while IFS= read -r next_dep; do
      queue_dep "$next_dep"
    done < <(otool -L "$dep" | awk 'NR > 1 { print $1 }')
  done
}

find_openssl_prefix() {
  local prefix
  prefix="$(brew --prefix openssl@3 2>/dev/null || true)"
  if [[ -n "$prefix" && -d "$prefix" ]]; then
    printf '%s\n' "$prefix"
    return 0
  fi
  for prefix in /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3; do
    if [[ -d "$prefix" ]]; then
      printf '%s\n' "$prefix"
      return 0
    fi
  done
  return 1
}

copy_openssl_runtime() {
  if [[ ! -f "$DEST_DIR/lib/libcrypto.3.dylib" && ! -f "$DEST_DIR/lib/libssl.3.dylib" ]]; then
    return 0
  fi

  local openssl_prefix modules_source modules_dest
  openssl_prefix="$(find_openssl_prefix || true)"
  if [[ -z "$openssl_prefix" ]]; then
    echo "OpenSSL-linked bundled tools require Homebrew openssl@3, but openssl@3 was not found." >&2
    exit 1
  fi

  modules_source="$openssl_prefix/lib/ossl-modules"
  modules_dest="$DEST_DIR/openssl/ossl-modules"
  if [[ ! -f "$modules_source/legacy.dylib" ]]; then
    echo "OpenSSL legacy provider not found: $modules_source/legacy.dylib" >&2
    exit 1
  fi

  mkdir -p "$modules_dest"
  while IFS= read -r -d '' module; do
    copy_one "$module" "$modules_dest/$(basename "$module")"
  done < <(find "$modules_source" -maxdepth 1 -type f -name '*.dylib' -print0)

  cat > "$DEST_DIR/openssl/openssl.cnf" <<'EOF'
openssl_conf = openssl_init

[openssl_init]
providers = provider_sect

[provider_sect]
default = default_sect
legacy = legacy_sect

[default_sect]
activate = 1

[legacy_sect]
activate = 1
EOF
}

patch_macho_file() {
  local file="$1"
  local base dep target replacement
  base="$(basename "$file")"
  if [[ "$base" == *.dylib ]]; then
    install_name_tool -id "@loader_path/$base" "$file" || true
  fi
  while IFS= read -r dep; do
    if ! is_bundled_dep "$dep" && [[ "$dep" != @rpath/* ]]; then
      continue
    fi
    target="$(basename "$dep")"
    if [[ "$file" == "$DEST_DIR/lib/"* ]]; then
      replacement="@loader_path/$target"
    elif [[ "$file" == "$DEST_DIR/openssl/ossl-modules/"* ]]; then
      replacement="@loader_path/../../lib/$target"
    else
      replacement="@loader_path/lib/$target"
    fi
    install_name_tool -change "$dep" "$replacement" "$file" || true
  done < <(otool -L "$file" | awk 'NR > 1 { print $1 }')
}

copy_executable ffmpeg
copy_executable ffprobe
copy_executable aria2c
copy_dylib_graph
copy_openssl_runtime

while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    patch_macho_file "$file"
  fi
done < <(find "$DEST_DIR" -type f -print0)

while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    codesign --force --sign - --timestamp=none "$file"
  fi
done < <(find "$DEST_DIR" -type f -print0)

"$DEST_DIR/ffmpeg" -version >/dev/null
"$DEST_DIR/ffprobe" -version >/dev/null
OPENSSL_CONF="$DEST_DIR/openssl/openssl.cnf" \
  OPENSSL_MODULES="$DEST_DIR/openssl/ossl-modules" \
  "$DEST_DIR/aria2c" --version >/dev/null

cat > "$DEST_DIR/THIRD_PARTY_TOOLS.txt" <<EOF
This directory contains command-line tools bundled for Pymss Studio macOS releases.

Bundled tools:
- FFmpeg / ffprobe
  Version: $("$DEST_DIR/ffmpeg" -version | head -n 1)
  Project: https://ffmpeg.org/
  License information: https://ffmpeg.org/legal.html

- aria2 / aria2c
  Version: $(OPENSSL_CONF="$DEST_DIR/openssl/openssl.cnf" OPENSSL_MODULES="$DEST_DIR/openssl/ossl-modules" "$DEST_DIR/aria2c" --version | head -n 1)
  Project: https://aria2.github.io/
  License information: https://github.com/aria2/aria2/blob/master/COPYING
  OpenSSL provider modules are bundled under openssl/ossl-modules for app-local execution.

These binaries and their non-system dynamic library dependencies are copied from
the Homebrew installation available on the macOS release runner, then relinked
for app-local execution.
EOF
