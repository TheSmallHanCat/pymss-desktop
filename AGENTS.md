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

`python/worker.py` imports the published `pymss` package from the active Python environment.
Install it for local development with `python -m pip install pymss`.

**Portable/release layout**:
```
<root>/python/worker.py
<root>/python-runtime/python.exe  (embedded interpreter)
```

## Release Process

Windows builds come in two variants: **CUDA** and **CPU** (different PyTorch builds).

Build stages:
1. **Prepare**: Run `scripts/prepare-python-runtime.ps1` to embed Python + deps → `python-runtime/`
2. **Build**: `pnpm tauri build --no-bundle` produces exe
3. **Stage**: Assemble portable directory with exe, worker, embedded Python runtime, and tools (ffmpeg, VC redist)
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
- `PYMSS_STUDIO_DEFAULT_OUTPUT_DIR`: Default separation output directory

## Important Files

- `python/worker.py`: JSON-based worker protocol for model ops, separation, audio processing
- `python/requirements.txt`: Documents runtime deps (actual deps installed by prepare script)
- `src-tauri/tauri.conf.json`: Bundles `python/*` as resources, defines asset protocol scope
- `scripts/prepare-python-runtime.ps1`: Stages portable Python with PyTorch + deps
- `.gitignore`: Excludes `*.md` and `docs/` — this file is an exception

## Testing

No automated test suite currently. Verification is manual + CI smoke tests (env_info, list_models).

## Accessibility maintenance

The app has an a11y layer that must be preserved when touching UI. Key pieces:

- `src/components/SrText.vue` — visually-hidden text for screen readers (labels icon-only buttons, adds context).
- `src/composables/useLiveAnnouncer.ts` — singleton that writes to the polite/assertive `aria-live` regions mounted by `src/components/A11yProvider.vue` (which also mounts the skip-to-content link).
- `src/composables/useFocusTrap.ts` — focus containment + Esc handling for custom `role="dialog"` overlays rendered outside `n-modal`.
- `src/composables/useRovingTabindex.ts` — roving-tabindex arrow-key navigation for toolbars, tab lists, and track rows.
- i18n `a11y.*` namespace — user-facing accessible strings (skip-link text, live announcements). Add new screen-reader strings here, not as hardcoded text in components.
- `?` opens the keyboard shortcuts help (`src/components/ShortcutsHelpDialog.vue`, wired in `App.vue`). Keep the shortcut list in sync with `src/composables/useEditorShortcuts.ts`.

