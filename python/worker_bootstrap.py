from __future__ import annotations

import importlib.util
import json
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MANIFEST_PATH = Path(__file__).with_name("runtime-manifest.json")
RUNTIME_ENVS_DIR = Path(os.environ.get("PYMSS_STUDIO_RUNTIME_ENVS_DIR") or Path(sys.executable).resolve().parent / "runtime-envs")
ACTIVE_RUNTIME_FILE = Path(os.environ.get("PYMSS_STUDIO_ACTIVE_RUNTIME_FILE") or RUNTIME_ENVS_DIR / "active-runtime.json")
BUNDLED_RUNTIME_ENVS_DIR: Path | None = Path(v) if (v := os.environ.get("PYMSS_STUDIO_BUNDLED_RUNTIME_ENVS_DIR")) else None

# Distribution name -> import name, for the manifest packages whose two names differ.
# Availability is decided with importlib, so an unmapped dashed name can never be found and the
# environment would read as permanently incomplete. Both detection paths — in-process and the
# probe script below — share this table so they can never disagree.
PACKAGE_IMPORT_NAMES = {
    "pyyaml": "yaml",
    "pysocks": "socks",
    "pymss-core": "pymss_core",
    "typing-extensions": "typing_extensions",
}


def _manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _emit(event_type: str, payload: dict[str, Any], task_id: str | None = None) -> None:
    from worker_protocol import emit
    emit(event_type, payload, task_id=task_id)


def _module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _resolve_runtime_state_from(file: Path) -> dict[str, Any] | None:
    """Read active-runtime.json and resolve relative pythonPath against its parent dir."""
    try:
        state = json.loads(file.read_text(encoding="utf-8"))
    except Exception:
        return None
    python_path = state.get("pythonPath")
    if python_path:
        p = Path(python_path)
        if not p.is_absolute():
            resolved = file.parent / p
            if resolved.is_file():
                state["pythonPath"] = str(resolved)
            else:
                return None
    return state


def _read_runtime_state() -> dict[str, Any] | None:
    state = _resolve_runtime_state_from(ACTIVE_RUNTIME_FILE)
    if state:
        return state
    # Fall back to bundled active-runtime.json
    if BUNDLED_RUNTIME_ENVS_DIR and BUNDLED_RUNTIME_ENVS_DIR.is_dir():
        bundled_file = BUNDLED_RUNTIME_ENVS_DIR / "active-runtime.json"
        if bundled_file.is_file():
            return _resolve_runtime_state_from(bundled_file)
    return None


def _write_runtime_state(state: dict[str, Any]) -> None:
    ACTIVE_RUNTIME_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_RUNTIME_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _env_dir(backend: str) -> Path:
    return RUNTIME_ENVS_DIR / backend


def _env_python_path(backend: str) -> Path:
    env_dir = _env_dir(backend)
    return env_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _env_state_path(backend: str) -> Path:
    return _env_dir(backend) / "pymss-runtime-state.json"


def _env_log_path(backend: str) -> Path:
    return _env_dir(backend) / "pymss-runtime-install.log"


# Bumped when a fixed install path starts recording trustworthy state. States below this
# version may carry another environment's torch build (see _repaired_env_state).
ENV_STATE_VERSION = 2

PYPI_MIRROR_URLS = {
    "ustc": "https://mirrors.ustc.edu.cn/pypi/web/simple",
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun": "https://mirrors.aliyun.com/pypi/simple",
    "tencent": "https://mirrors.cloud.tencent.com/pypi/simple",
    "pypi": "https://pypi.org/simple",
}


def _resolve_pypi_mirror(mirror: str, locale: str) -> tuple[str, str | None]:
    selected = "ustc" if mirror == "auto" and locale.startswith("zh") else "pypi" if mirror == "auto" else mirror
    return selected, PYPI_MIRROR_URLS.get(selected)


def _backend_extra_names(manifest: dict[str, Any], backend: str | None) -> list[str]:
    return [extra.split("=", 1)[0] for extra in manifest["backends"].get(backend or "", {}).get("extras", [])]


def _state_matches_backend(backend: str, state: dict[str, Any]) -> bool:
    """Whether the torch build recorded in an environment's state can belong to that environment.

    MLX ships a CPU torch build, so "cpu" is the correct recording for the mlx backend."""
    recorded = str(state.get("torchBackend") or "")
    if not recorded or recorded.startswith("error:"):
        return True  # Nothing concrete to contradict.
    return recorded == ("cpu" if backend == "mlx" else backend)


def _repaired_env_state(backend: str, state: dict[str, Any]) -> dict[str, Any]:
    """Re-derive an environment's torch facts from its own interpreter.

    Installs used to record whatever the *active* runtime reported, so a CPU environment
    installed while a CUDA runtime was active kept "2.7.1+cu128" and acceleratorAvailable=true
    forever, and the UI faithfully showed it. Nothing rewrites the file on its own, so the lie
    has to be corrected on read."""
    repaired = dict(state)
    try:
        probed = _probe_python_runtime(_env_python_path(backend), _backend_extra_names(_manifest(), backend))
        repaired.update({
            "pythonVersion": probed.get("pythonVersion") or repaired.get("pythonVersion"),
            "torchVersion": probed.get("torchVersion"),
            "torchBackend": probed.get("torchBackend"),
            "acceleratorAvailable": bool(probed.get("acceleratorAvailable")),
            "packages": probed.get("packages") or repaired.get("packages"),
            "stateVersion": ENV_STATE_VERSION,
        })
    except Exception:
        # The truth is unavailable (broken or vanished interpreter). Drop the claim rather than
        # repeat a false one, and leave the file untouched so the next read tries again.
        repaired.update({"torchVersion": None, "torchBackend": None, "acceleratorAvailable": False})
        return repaired
    try:
        _env_state_path(backend).write_text(json.dumps(repaired, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return repaired


def _read_installed_env_state(backend: str) -> dict[str, Any] | None:
    path = _env_state_path(backend)
    try:
        state = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    if int(state.get("stateVersion") or 1) < ENV_STATE_VERSION and not _state_matches_backend(backend, state):
        return _repaired_env_state(backend, state)
    return state


# PCI vendor IDs. Used to name the GPU vendor without depending on torch: a machine running
# a CPU-only environment reports torch.cuda.is_available() == False even with an NVIDIA card,
# which is exactly the case where a CUDA recommendation matters most.
_PCI_VENDORS = {"10de": "nvidia", "1002": "amd", "1022": "amd", "8086": "intel"}


def _vendor_from_pci_id(value: str) -> str | None:
    text = str(value or "").strip().lower()
    if text.startswith("0x"):
        text = text[2:]
    return _PCI_VENDORS.get(text[-4:]) if len(text) >= 4 else None


def _windows_gpu_vendors() -> list[str]:
    import ctypes
    from ctypes import wintypes

    class DISPLAY_DEVICEW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("DeviceName", wintypes.WCHAR * 32),
            ("DeviceString", wintypes.WCHAR * 128),
            ("StateFlags", wintypes.DWORD),
            ("DeviceID", wintypes.WCHAR * 128),
            ("DeviceKey", wintypes.WCHAR * 128),
        ]

    enum_display_devices = ctypes.windll.user32.EnumDisplayDevicesW
    enum_display_devices.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(DISPLAY_DEVICEW), wintypes.DWORD]
    enum_display_devices.restype = wintypes.BOOL

    vendors: list[str] = []
    index = 0
    while index < 32:  # Bounded: mirroring drivers can otherwise enumerate indefinitely.
        device = DISPLAY_DEVICEW()
        device.cb = ctypes.sizeof(DISPLAY_DEVICEW)
        if not enum_display_devices(None, index, ctypes.byref(device), 0):
            break
        index += 1
        match = re.search(r"VEN_([0-9A-Fa-f]{4})", device.DeviceID or "")
        vendor = _vendor_from_pci_id(match.group(1)) if match else None
        if vendor and vendor not in vendors:
            vendors.append(vendor)
    return vendors


LINUX_DRM_ROOT = Path("/sys/class/drm")


def _linux_gpu_vendors(drm_root: Path | None = None) -> list[str]:
    vendors: list[str] = []
    for path in sorted((drm_root or LINUX_DRM_ROOT).glob("card*/device/vendor")):
        try:
            vendor = _vendor_from_pci_id(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        if vendor and vendor not in vendors:
            vendors.append(vendor)
    return vendors


def _detect_gpu_vendors() -> list[str]:
    """Best-effort GPU vendor list, never raising. macOS is deliberately absent: the backend
    there follows from the CPU architecture, which platform.machine() already answers."""
    try:
        if sys.platform == "win32":
            return _windows_gpu_vendors()
        if sys.platform.startswith("linux"):
            return _linux_gpu_vendors()
    except Exception:
        return []
    return []


def _dir_size_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(str(path), onerror=lambda _exc: None):
        for name in files:
            try:
                entry = Path(root) / name
                # Symlinks (common in POSIX venvs) point outside the env; don't double count.
                if entry.is_symlink():
                    continue
                total += entry.stat().st_size
            except OSError:
                continue
    return total


def _incomplete_env_backends(manifest: dict[str, Any]) -> list[str]:
    """Backends whose venv exists but never recorded an install state.

    An interrupted or failed install leaves the venv behind (state is only written on
    success), so these directories can hold gigabytes while not counting as installed.
    Reporting them is what lets the UI offer to reclaim the space."""
    return [
        backend
        for backend in manifest.get("backends", {})
        if _env_python_path(backend).is_file() and not _read_installed_env_state(backend)
    ]


def _env_size_targets(manifest: dict[str, Any]) -> dict[str, Path]:
    """Backends that own a dedicated directory on disk, in the same priority order as
    _installed_envs(). The bootstrap interpreter is deliberately absent: it is the app's own
    runtime, not a removable environment, so reporting a size for it would be misleading."""
    targets: dict[str, Path] = {}
    for backend in manifest.get("backends", {}):
        if _env_python_path(backend).is_file():
            targets[backend] = _env_dir(backend)
    if BUNDLED_RUNTIME_ENVS_DIR and BUNDLED_RUNTIME_ENVS_DIR.is_dir():
        for backend in manifest.get("backends", {}):
            if backend in targets:
                continue
            bundled_env = BUNDLED_RUNTIME_ENVS_DIR / backend
            bundled_python = bundled_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            if bundled_python.is_file():
                targets[backend] = bundled_env
    return targets


def _probe_python_runtime(python_path: Path, extras: list[str] | None = None) -> dict[str, Any]:
    extras = extras or []
    script = """
import importlib.util, json, platform
packages = json.loads(%PACKAGES%)
mapping = json.loads(%MAPPING%)
result = {'pythonVersion': platform.python_version(), 'torchVersion': None, 'torchBackend': 'missing', 'acceleratorAvailable': False, 'packages': {}}
for name in packages:
    result['packages'][name] = importlib.util.find_spec(mapping.get(name, name)) is not None
if importlib.util.find_spec('torch') is not None:
    try:
        import torch
        result['torchVersion'] = torch.__version__
        result['torchBackend'] = 'rocm' if getattr(torch.version, 'hip', None) else 'cuda' if getattr(torch.version, 'cuda', None) else 'cpu'
        result['acceleratorAvailable'] = bool(torch.cuda.is_available())
    except Exception as exc:
        result['torchBackend'] = f'error:{exc}'
print(json.dumps(result, ensure_ascii=False))
""".replace("%PACKAGES%", repr(json.dumps(list(_manifest()["common"].keys()) + extras))) \
   .replace("%MAPPING%", repr(json.dumps(PACKAGE_IMPORT_NAMES)))
    output = subprocess.check_output([str(python_path), "-c", script], text=True, encoding="utf-8", errors="replace")
    return json.loads(output.strip() or "{}")


def _installed_envs(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen_backends: set[str] = set()
    # User-managed environments (highest priority)
    for backend in manifest.get("backends", {}):
        state = _read_installed_env_state(backend)
        python_path = _env_python_path(backend)
        if state and python_path.is_file():
            items.append({
                **state,
                "backend": backend,
                "pythonPath": str(python_path),
                "logPath": str(_env_log_path(backend)),
                "source": "managed",
            })
            seen_backends.add(backend)
    # Bundled pre-installed environments (fallback)
    if BUNDLED_RUNTIME_ENVS_DIR and BUNDLED_RUNTIME_ENVS_DIR.is_dir():
        for backend in manifest.get("backends", {}):
            if backend in seen_backends:
                continue
            bundled_env = BUNDLED_RUNTIME_ENVS_DIR / backend
            bundled_state_path = bundled_env / "pymss-runtime-state.json"
            bundled_python = bundled_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            if bundled_state_path.is_file() and bundled_python.is_file():
                try:
                    state = json.loads(bundled_state_path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                items.append({
                    **state,
                    "backend": backend,
                    "pythonPath": str(bundled_python),
                    "source": "preinstalled",
                })
                seen_backends.add(backend)
    bootstrap_python = Path(os.environ.get("PYMSS_STUDIO_BOOTSTRAP_PYTHON") or sys.executable)
    if not bootstrap_python.is_file():
        bootstrap_python = Path(sys.executable)
    if bootstrap_python.is_file():
        try:
            # On macOS the bundled runtime ships MLX alongside a CPU torch build, so probe for it:
            # without this the environment is reported as plain "cpu" and MLX never surfaces.
            probed = _probe_python_runtime(bootstrap_python, ["mlx"] if sys.platform == "darwin" else None)
            packages = dict(probed.get("packages") or {})
            torch_backend = str(probed.get("torchBackend") or "")
            # mlx is an optional extra, not a completeness requirement — it decides the backend
            # label but must stay out of the "is this environment complete" product.
            has_mlx = bool(packages.pop("mlx", False))
            backend = "mlx" if has_mlx else torch_backend
            if packages and all(packages.values()) and backend in {"cpu", "cuda", "rocm", "mlx"}:
                if not any(item.get("backend") == backend for item in items):
                    items.append({
                        "backend": backend,
                        "pythonPath": str(bootstrap_python),
                        "torchVersion": probed.get("torchVersion"),
                        "torchBackend": torch_backend,
                        "acceleratorAvailable": bool(probed.get("acceleratorAvailable")),
                        "packages": probed.get("packages"),
                        "source": "bundled",
                    })
        except Exception:
            pass
    return items


def _same_path(left: Any, right: Any) -> bool:
    try:
        return os.path.normcase(os.path.normpath(str(left))) == os.path.normcase(os.path.normpath(str(right)))
    except Exception:
        return False


def _envs_with_live_active(
    manifest: dict[str, Any],
    active_python: Path | None,
    active_probe: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Installed environments, with the active one's torch facts taken from the live probe.

    A shipped environment records its state on the build machine, which has no GPU, so a
    pre-installed CUDA environment claims acceleratorAvailable=false forever. The active
    environment was just probed for real, so prefer that answer over the recording. Idle
    environments keep their recorded state — probing each one would spawn an interpreter per
    environment on every refresh."""
    environments = _installed_envs(manifest)
    if not active_probe or not active_python:
        return environments
    for entry in environments:
        if not _same_path(entry.get("pythonPath"), active_python):
            continue
        entry.update({
            "torchVersion": active_probe.get("torchVersion"),
            "torchBackend": active_probe.get("torchBackend"),
            "acceleratorAvailable": bool(active_probe.get("acceleratorAvailable")),
            # Merged, not replaced: the probe's extras follow the requested backend, so a
            # replace could drop a key (mlx) the recording legitimately carries.
            "packages": {**(entry.get("packages") or {}), **(active_probe.get("packages") or {})},
        })
        break
    return environments


def _runtime_info_payload(payload: dict[str, Any]) -> dict[str, Any]:
    manifest = _manifest()
    backend = str(payload.get("backend") or "").strip() or None
    install_state = _read_runtime_state()
    packages = {name: _module_available(PACKAGE_IMPORT_NAMES.get(name, name)) for name in manifest["common"]}
    extra_names = _backend_extra_names(manifest, backend)
    # With no explicit backend the caller is asking "what am I running on"; on macOS that answer
    # depends on whether MLX is present, so probe for it even though no backend was requested.
    if not backend and sys.platform == "darwin" and "mlx" not in extra_names:
        extra_names = [*extra_names, "mlx"]
    for name in extra_names:
        packages[name] = _module_available(name)
    torch_version = None
    torch_backend = "missing"
    accelerator_available = False
    active_probe: dict[str, Any] | None = None
    active_python = Path(str(install_state.get("pythonPath"))) if install_state and install_state.get("pythonPath") else None
    if active_python and active_python.is_file():
        try:
            probed = _probe_python_runtime(active_python, extra_names)
            active_probe = probed
            packages = dict(probed.get("packages") or packages)
            torch_version = probed.get("torchVersion")
            torch_backend = str(probed.get("torchBackend") or torch_backend)
            accelerator_available = bool(probed.get("acceleratorAvailable"))
        except Exception:
            packages = dict(install_state.get("packages") or packages)
            torch_version = install_state.get("torchVersion")
            torch_backend = str(install_state.get("torchBackend") or torch_backend)
            accelerator_available = bool(install_state.get("acceleratorAvailable"))
    elif _module_available("torch"):
        try:
            import torch
            torch_version = torch.__version__
            torch_backend = "rocm" if getattr(torch.version, "hip", None) else "cuda" if getattr(torch.version, "cuda", None) else "cpu"
            accelerator_available = bool(torch.cuda.is_available())
        except Exception as exc:
            packages["torch"] = False
            torch_backend = f"error:{exc}"
    return {
        "manifestVersion": manifest["manifestVersion"],
        "pythonVersion": platform.python_version(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "bootstrapPython": str(Path(os.environ.get("PYMSS_STUDIO_BOOTSTRAP_PYTHON") or sys.executable)),
        "runtimeEnvsDir": str(RUNTIME_ENVS_DIR),
        "activeRuntimeFile": str(ACTIVE_RUNTIME_FILE),
        "bundledRuntimeEnvsDir": str(BUNDLED_RUNTIME_ENVS_DIR) if BUNDLED_RUNTIME_ENVS_DIR else None,
        "backend": backend,
        "installedBackend": install_state.get("backend") if install_state else None,
        "installState": install_state,
        "statePath": str(ACTIVE_RUNTIME_FILE),
        "logPath": str(install_state.get("logPath")) if install_state and install_state.get("logPath") else None,
        "installedEnvironments": _envs_with_live_active(manifest, active_python, active_probe),
        "gpuVendors": _detect_gpu_vendors(),
        "torchVersion": torch_version,
        "torchBackend": torch_backend,
        "acceleratorAvailable": accelerator_available,
        "packages": packages,
        # mlx is an optional extra: it must not drag readiness down when it was probed
        # speculatively (no backend requested). An explicit mlx backend still requires it below.
        "ready": all(v for k, v in packages.items() if k != "mlx" or backend == "mlx") and torch_backend != "missing" and not torch_backend.startswith("error:") and (
            not backend or backend == "cpu" and torch_backend == "cpu"
            or backend == "cuda" and torch_backend == "cuda" and accelerator_available
            or backend == "rocm" and torch_backend == "rocm" and accelerator_available
            or backend == "mlx" and packages.get("mlx", False)
        ),
    }


def cmd_runtime_info(payload: dict[str, Any]) -> int:
    _emit("runtime_info", _runtime_info_payload(payload))
    return 0


def cmd_runtime_env_sizes(payload: dict[str, Any]) -> int:
    """Disk usage per installed environment. Split out of runtime_info on purpose: walking a
    multi-GB venv takes long enough that it would slow down every startup and every refresh."""
    del payload
    sizes: dict[str, int] = {}
    incomplete: list[str] = []
    manifest = _manifest()
    try:
        targets = _env_size_targets(manifest)
        incomplete = _incomplete_env_backends(manifest)
    except Exception:
        # Probing the directories can fail outright (permissions, a vanished data root).
        # Sizes are supplementary, so degrade to "unknown" instead of failing the command.
        targets = {}
    for backend, env_dir in targets.items():
        try:
            sizes[backend] = _dir_size_bytes(env_dir)
        except Exception:
            continue
    _emit("runtime_env_sizes", {
        "sizes": sizes,
        "totalBytes": sum(sizes.values()),
        "incompleteBackends": incomplete,
    })
    return 0


def cmd_activate_runtime(payload: dict[str, Any]) -> int:
    backend = str(payload.get("backend") or "").strip().lower()
    if not backend:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", "Missing runtime backend")
    active: dict[str, Any] | None = None
    # 1. Check user-managed environments
    state = _read_installed_env_state(backend)
    python_path = _env_python_path(backend)
    if state and python_path.is_file():
        active = {
            **state,
            "backend": backend,
            "pythonPath": str(python_path),
            "logPath": str(_env_log_path(backend)),
            "source": "managed",
            "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    # 2. Check bundled pre-installed environments
    if not active and BUNDLED_RUNTIME_ENVS_DIR and BUNDLED_RUNTIME_ENVS_DIR.is_dir():
        bundled_env = BUNDLED_RUNTIME_ENVS_DIR / backend
        bundled_state_path = bundled_env / "pymss-runtime-state.json"
        bundled_python = bundled_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        if bundled_state_path.is_file() and bundled_python.is_file():
            try:
                bundled_state = json.loads(bundled_state_path.read_text(encoding="utf-8"))
                active = {
                    **bundled_state,
                    "backend": backend,
                    "pythonPath": str(bundled_python),
                    "source": "preinstalled",
                    "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            except Exception:
                pass
    # 3. Check bootstrap Python (fallback for old-style bundled builds)
    if not active:
        bootstrap_python = Path(os.environ.get("PYMSS_STUDIO_BOOTSTRAP_PYTHON") or sys.executable)
        if not bootstrap_python.is_file():
            bootstrap_python = Path(sys.executable)
        if bootstrap_python.is_file():
            try:
                probed = _probe_python_runtime(bootstrap_python)
                if str(probed.get("torchBackend") or "") == backend:
                    active = {
                        "backend": backend,
                        "pythonPath": str(bootstrap_python),
                        "torchVersion": probed.get("torchVersion"),
                        "torchBackend": backend,
                        "acceleratorAvailable": bool(probed.get("acceleratorAvailable")),
                        "packages": probed.get("packages"),
                        "source": "bundled",
                        "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
            except Exception:
                pass
    if not active:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} is not installed")
    _write_runtime_state(active)
    _emit("runtime_activated", active)
    return 0


def cmd_delete_runtime(payload: dict[str, Any]) -> int:
    backend = str(payload.get("backend") or "").strip().lower()
    if not backend:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", "Missing runtime backend")
    env_dir = _env_dir(backend)
    python_path = _env_python_path(backend)
    state = _read_installed_env_state(backend)
    if not state and not python_path.is_file():
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} is not installed")
    active = _read_runtime_state()
    if active and str(active.get("backend") or "").lower() == backend and active.get("source") != "bundled":
        from worker_protocol import emit_error
        return emit_error("RUNTIME_DELETE_ACTIVE", f"Cannot delete the currently active runtime ({backend}). Switch to another environment first.")
    import shutil
    try:
        if env_dir.is_dir():
            shutil.rmtree(str(env_dir), ignore_errors=True)
        if active and str(active.get("backend") or "").lower() == backend:
            try:
                ACTIVE_RUNTIME_FILE.unlink()
            except Exception:
                pass
        _emit("runtime_deleted", {"backend": backend})
        return 0
    except Exception as exc:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_DELETE_FAILED", str(exc))


def cmd_install_runtime(payload: dict[str, Any]) -> int:
    """Build and activate an environment for `backend`.

    Cancellation is not handled here: the desktop shell kills this process and its whole tree
    (see cancel_task in app_cmd.rs), which takes pip down with it. The interrupted venv is left
    on disk on purpose — _incomplete_env_backends() reports it so the space can be reclaimed."""
    import venv

    task_id = str(payload.get("taskId") or f"runtime_install_{int(time.time() * 1000)}")
    backend = str(payload.get("backend") or "cpu").strip().lower()
    mirror = str(payload.get("mirror") or "auto").strip().lower()
    locale = str(payload.get("locale") or "").strip().lower()
    manifest = _manifest()
    spec = manifest["backends"].get(backend)
    if not spec:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", f"Unsupported runtime backend: {backend}", task_id=task_id)
    if sys.platform not in spec.get("platforms", []):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_PLATFORM_UNSUPPORTED", f"Backend {backend} is not supported on {sys.platform}", task_id=task_id)
    index_url = None
    mirror, index_url = _resolve_pypi_mirror(mirror, locale)
    env_dir = _env_dir(backend)
    env_dir.mkdir(parents=True, exist_ok=True)
    env_python = _env_python_path(backend)
    install_log_path = _env_log_path(backend)
    if not env_python.is_file():
        builder = venv.EnvBuilder(with_pip=True, clear=True)
        builder.create(str(env_dir))
    install_log_path.write_text(
        f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] install backend={backend} mirror={mirror} manifest={manifest['manifestVersion']}\n",
        encoding="utf-8",
    )
    _emit("runtime_install_started", {"backend": backend, "manifestVersion": manifest["manifestVersion"], "logPath": str(install_log_path)}, task_id)

    def append_log(stage: str, message: str) -> None:
        with install_log_path.open("a", encoding="utf-8", errors="replace") as file:
            file.write(f"[{stage}] {message}\n")

    def run_pip(args: list[str], stage: str, package_index: str | None = None) -> None:
        command = [str(env_python), "-m", "pip", "install", "--no-cache-dir"]
        if stage in {"common", "pymss"}:
            command.extend(["--only-binary=:all:", "--prefer-binary"])
        if package_index or (index_url and stage != "torch"):
            command.extend(["--index-url", package_index or index_url])
        command.extend(args)
        append_log(stage, "pip install " + " ".join(args))
        _emit("runtime_install_stage", {"stage": stage, "command": "pip install " + " ".join(args)}, task_id)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=os.environ.copy())
        assert process.stdout is not None
        for line in process.stdout:
            message = line.rstrip()
            append_log(stage, message)
            _emit("runtime_install_log", {"stage": stage, "message": message}, task_id)
        if process.wait() != 0:
            raise RuntimeError(f"pip failed during {stage} with exit code {process.returncode}")

    def run_pip_with_pypi_fallback(args: list[str], stage: str) -> None:
        try:
            run_pip(args, stage)
        except RuntimeError:
            if mirror == "pypi":
                raise
            append_log(stage, "selected mirror failed, retrying with PyPI")
            _emit("runtime_install_stage", {"stage": stage, "message": "Selected mirror failed, retrying with PyPI"}, task_id)
            run_pip(args, stage, "https://pypi.org/simple")

    try:
        torch = spec.get("torch", {})
        if torch.get("rocmRequirements"):
            run_pip(list(torch["rocmRequirements"]), "rocm-sdk", None)
        torch_args = list(torch.get("requirements", [])) if torch.get("requirements") else [torch["requirement"]]
        run_pip((["--no-deps"] if torch.get("noDeps") else []) + torch_args, "torch", torch.get("indexUrl"))
        common = [value for name, value in manifest["common"].items() if name not in {"pymss", "pymss-core"}]
        pymss_requirement = manifest["common"]["pymss"]
        pymss_core_requirement = manifest["common"]["pymss-core"]
        run_pip_with_pypi_fallback(common, "common")
        run_pip_with_pypi_fallback(["--no-deps", pymss_requirement, pymss_core_requirement], "pymss")
        if spec.get("extras"):
            run_pip_with_pypi_fallback(list(spec["extras"]), "extras")
        # Probe the interpreter that was just built, not _runtime_info_payload(): that one reads
        # the *active* runtime, which at this point is still the previously activated environment
        # — recording its torch build here is what made a CPU env report cu128.
        probed = _probe_python_runtime(env_python, _backend_extra_names(manifest, backend))
        state = {
            "backend": backend,
            "manifestVersion": manifest["manifestVersion"],
            "stateVersion": ENV_STATE_VERSION,
            "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pythonVersion": probed.get("pythonVersion") or platform.python_version(),
            "torchVersion": probed.get("torchVersion"),
            "torchBackend": probed.get("torchBackend"),
            "acceleratorAvailable": bool(probed.get("acceleratorAvailable")),
            "packages": probed.get("packages"),
        }
        _env_state_path(backend).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        active = {
            **state,
            "pythonPath": str(env_python),
            "logPath": str(install_log_path),
            "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_runtime_state(active)
        _emit("runtime_install_finished", {"backend": backend, "state": active, "logPath": str(install_log_path)}, task_id)
        return 0
    except Exception as exc:
        from worker_protocol import emit_error
        append_log("error", str(exc))
        return emit_error(
            "RUNTIME_INSTALL_FAILED",
            str(exc),
            detail=f"详细安装日志：{install_log_path}",
            task_id=task_id,
            recoverable=True,
            extra={"backend": backend, "logPath": str(install_log_path)},
        )
