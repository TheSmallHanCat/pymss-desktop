# AGENTS.md

Guidance for future OpenCode sessions working on pymss-desktop.

## Architecture

Tauri desktop app for audio source separation. Three layers:
- **Frontend**: Vue 3 + TypeScript + Vite + Naive UI (component auto-import)
- **Backend**: Tauri (Rust) orchestrates Python worker
- **Worker**: `python/worker.py` wraps the separate [pymss-project/pymss](https://github.com/pymss-project/pymss) library

The desktop app is a wrapper — core separation logic lives in the external pymss package.

## Development Commands

```bash
# Frontend only (port 1420)
pnpm dev

# Full app (Tauri + frontend hot reload)
pnpm tauri dev

# Typecheck + build frontend
pnpm build

# Production Tauri build (runs pnpm build first)
pnpm tauri build
```

Always run `pnpm build` before committing frontend changes to catch type errors.

## Python Worker Layout

`python/worker.py` expects `pymss` core package at specific locations:

**Development layout** (repo siblings):
```
<workspace>/pymss-desktop/python/worker.py
<workspace>/pymss/...
```

**Portable/release layout**:
```
<root>/python/worker.py
<root>/pymss/...
<root>/python-runtime/python.exe  (embedded interpreter)
```

Override via `PYMSS_STUDIO_PYMSS_PATH` env var. Worker bootstraps `sys.path` on startup.

## Release Process

Windows builds come in two variants: **CUDA** and **CPU** (different PyTorch builds).

Build stages:
1. **Prepare**: Run `scripts/prepare-python-runtime.ps1` to embed Python + deps → `python-runtime/`
2. **Build**: `pnpm tauri build --no-bundle` produces exe
3. **Stage**: Assemble portable directory with exe, worker, pymss source, tools (ffmpeg, VC redist)
4. **Package**: Create 7z archive or Inno Setup installer

CI splits jobs: `prepare` → `7z` / `exe` for each variant to parallelize compression.

Key script: `scripts/prepare-python-runtime.ps1 -Variant cuda|default -TorchVersion ... -TorchIndexUrl ...`

Staged build verification runs `python worker.py env_info` and `list_models` to confirm Python environment.

## Release Artifacts

GitHub releases may split files >2GB using `split` (workflow auto-handles). See `SPLIT-ASSETS-README.txt` in releases for merge instructions.

## Component Auto-Import

`unplugin-vue-components` with `NaiveUiResolver` auto-imports Naive UI components. No manual imports needed for NButton, NCard, etc. Typings are disabled (`dts: false`) to avoid conflicts.

## Environment Variables

- `PYMSS_STUDIO_PYTHON`: Python interpreter path (defaults to `python`)
- `PYMSS_STUDIO_PYMSS_PATH`: Override pymss package location
- `PYMSS_STUDIO_DEFAULT_OUTPUT_DIR`: Default separation output directory

## Important Files

- `python/worker.py`: JSON-based worker protocol for model ops, separation, audio processing
- `python/requirements.txt`: Documents runtime deps (actual deps installed by prepare script)
- `src-tauri/tauri.conf.json`: Bundles `python/*` as resources, defines asset protocol scope
- `scripts/prepare-python-runtime.ps1`: Stages portable Python with PyTorch + deps
- `.gitignore`: Excludes `*.md` and `docs/` — this file is an exception

## Testing

No automated test suite currently. Verification is manual + CI smoke tests (env_info, list_models).
