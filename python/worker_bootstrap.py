from __future__ import annotations

import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

MANIFEST_PATH = Path(__file__).with_name("runtime-manifest.json")


def _default_runtime_envs_dir() -> Path:
    executable = Path(sys.executable).resolve()
    if executable.parent.name.lower() in {"scripts", "bin"}:
        env_dir = executable.parent.parent
        if (env_dir / "pyvenv.cfg").is_file():
            return env_dir.parent
        return env_dir / "runtime-envs"
    return executable.parent / "runtime-envs"


RUNTIME_ENVS_DIR = Path(os.environ.get("PYMSS_STUDIO_RUNTIME_ENVS_DIR") or _default_runtime_envs_dir())
ACTIVE_RUNTIME_FILE = Path(os.environ.get("PYMSS_STUDIO_ACTIVE_RUNTIME_FILE") or RUNTIME_ENVS_DIR / "active-runtime.json")
BUNDLED_RUNTIME_ENVS_DIR = Path(os.environ["PYMSS_STUDIO_BUNDLED_RUNTIME_ENVS_DIR"]) if os.environ.get("PYMSS_STUDIO_BUNDLED_RUNTIME_ENVS_DIR") else None

# Distribution name -> import name, for the manifest packages whose two names differ.
# Availability is decided with importlib, so an unmapped dashed name can never be found and the
# environment would read as permanently incomplete. Both detection paths — in-process and the
# probe script below — share this table so they can never disagree.
PACKAGE_IMPORT_NAMES = {
    "pyyaml": "yaml",
    "pymss-core": "pymss_core",
    "typing-extensions": "typing_extensions",
}


def _manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _pin_manifest_requirement(requirement: Any, version: str) -> str:
    """Pin a manifest requirement while retaining any extras it declares."""
    spec = str(requirement or "").strip()
    name_match = re.match(r"([A-Za-z0-9_.-]+)", spec)
    name = name_match.group(1) if name_match else "pymss"
    extras_match = re.search(r"(\[[^\]]+\])", spec)
    extras = extras_match.group(1) if extras_match else ""
    return f"{name}{extras}=={version}"


def _supported_backend(backend: str, manifest: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]] | None:
    normalized = str(backend or "").strip().lower()
    if not normalized or "/" in normalized or "\\" in normalized or normalized in {".", ".."}:
        return None
    manifest = manifest or _manifest()
    spec = manifest.get("backends", {}).get(normalized)
    return (normalized, spec) if isinstance(spec, dict) else None


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
                state["pythonPath"] = str(resolved.resolve())
            else:
                return None
    state.pop("source", None)
    return state


def _read_runtime_state() -> dict[str, Any] | None:
    state = _resolve_runtime_state_from(ACTIVE_RUNTIME_FILE)
    if state and state.get("pythonPath"):
        supported = _supported_backend(str(state.get("backend") or ""))
        if supported:
            try:
                env_dir = _runtime_env_dir_for_python(Path(str(state["pythonPath"])))
            except (OSError, ValueError):
                env_dir = None
            python_path = Path(str(state["pythonPath"]))
            if env_dir and (
                (env_dir.name == supported[0] and (_is_user_runtime_env(env_dir) or _is_bundled_runtime_env(env_dir)))
                or _is_bundled_bootstrap_python(python_path)
            ):
                if _is_bundled_runtime_env(env_dir) or _is_bundled_bootstrap_python(python_path):
                    state["source"] = "bundled"
                return state
    if BUNDLED_RUNTIME_ENVS_DIR:
        bundled = _resolve_runtime_state_from(BUNDLED_RUNTIME_ENVS_DIR / "active-runtime.json")
        if bundled and bundled.get("pythonPath"):
            bundled["source"] = "bundled"
            return bundled
    return None


def _write_runtime_state(state: dict[str, Any]) -> None:
    ACTIVE_RUNTIME_FILE.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(ACTIVE_RUNTIME_FILE, state)


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    _atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _atomic_write_text(path: Path, content: str) -> None:
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _env_dir(backend: str) -> Path:
    return RUNTIME_ENVS_DIR / backend


def _env_python_path(backend: str) -> Path:
    env_dir = _env_dir(backend)
    return env_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _env_state_path(backend: str) -> Path:
    return _env_dir(backend) / "pymss-runtime-state.json"


def _env_log_path(backend: str) -> Path:
    return _env_dir(backend) / "pymss-runtime-install.log"


def _recover_reinstall_backups() -> None:
    import shutil

    if not RUNTIME_ENVS_DIR.is_dir():
        return
    for backup in RUNTIME_ENVS_DIR.glob(".*.reinstalling"):
        backend = backup.name.removeprefix(".").removesuffix(".reinstalling")
        if not _supported_backend(backend):
            continue
        target = _env_dir(backend)
        try:
            state = _read_installed_env_state(backend)
            python_path = _env_python_path(backend)
            if state and python_path.is_file():
                shutil.rmtree(backup)
                continue
            if target.exists():
                shutil.rmtree(target)
            backup.rename(target)
        except OSError:
            continue


def _bootstrap_python_path() -> Path:
    python_path = Path(os.environ.get("PYMSS_STUDIO_BOOTSTRAP_PYTHON") or sys.executable)
    return python_path if python_path.is_file() else Path(sys.executable)


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
            "packageVersions": probed.get("packageVersions") or repaired.get("packageVersions"),
            "pymssVersion": probed.get("pymssVersion") or repaired.get("pymssVersion"),
            "pymssCoreVersion": probed.get("pymssCoreVersion") or repaired.get("pymssCoreVersion"),
            "stateVersion": ENV_STATE_VERSION,
        })
    except Exception:
        # The truth is unavailable (broken or vanished interpreter). Drop the claim rather than
        # repeat a false one, and leave the file untouched so the next read tries again.
        repaired.update({"torchVersion": None, "torchBackend": None, "acceleratorAvailable": False})
        return repaired
    try:
        _atomic_write_json(_env_state_path(backend), repaired)
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
        state = _repaired_env_state(backend, state)
    state.pop("source", None)
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
from importlib import metadata
packages = json.loads(%PACKAGES%)
mapping = json.loads(%MAPPING%)
result = {'pythonVersion': platform.python_version(), 'torchVersion': None, 'torchBackend': 'missing', 'acceleratorAvailable': False, 'packages': {}, 'packageVersions': {}, 'pymssVersion': None, 'pymssCoreVersion': None}
for name in packages:
    result['packages'][name] = importlib.util.find_spec(mapping.get(name, name)) is not None
    try:
        result['packageVersions'][name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        result['packageVersions'][name] = None
result['pymssVersion'] = result['packageVersions'].get('pymss')
result['pymssCoreVersion'] = result['packageVersions'].get('pymss-core')
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


def _probe_python_package_versions(python_path: Path, package_names: list[str]) -> dict[str, str | None]:
    if not python_path.is_file() or not package_names:
        return {}
    script = """
import json
from importlib import metadata
names = json.loads(%NAMES%)
result = {}
for name in names:
    try:
        result[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        result[name] = None
print(json.dumps(result, ensure_ascii=False))
""".replace("%NAMES%", repr(json.dumps(package_names)))
    try:
        output = subprocess.check_output([str(python_path), "-c", script], text=True, encoding="utf-8", errors="replace")
        data = json.loads(output.strip() or "{}")
        return {name: (str(data.get(name)) if data.get(name) else None) for name in package_names}
    except Exception:
        return {}


def _installed_envs(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen_backends: set[str] = set()
    # User-managed environments (highest priority)
    for backend in manifest.get("backends", {}):
        env_dir = _env_dir(backend)
        if env_dir.is_dir() and not _is_bundled_runtime_env(env_dir):
            try:
                _repair_runtime_venv_config(env_dir)
                _make_posix_venv_relocatable(env_dir)
            except OSError:
                pass
        state = _read_installed_env_state(backend)
        python_path = _env_python_path(backend)
        if state and python_path.is_file():
            package_versions = _probe_python_package_versions(python_path, ["pymss", "pymss-core"])
            items.append({
                **state,
                "backend": backend,
                "pythonPath": str(python_path),
                "logPath": str(_env_log_path(backend)),
                "coreUpdateSupported": True,
                "packageVersions": {**(state.get("packageVersions") or {}), **package_versions},
                "pymssVersion": (package_versions.get("pymss") or state.get("pymssVersion")),
                "pymssCoreVersion": (package_versions.get("pymss-core") or state.get("pymssCoreVersion")),
            })
            seen_backends.add(backend)
    bundled_state = _resolve_runtime_state_from(BUNDLED_RUNTIME_ENVS_DIR / "active-runtime.json") if BUNDLED_RUNTIME_ENVS_DIR else None
    if bundled_state:
        bundled_state["source"] = "bundled"
    bundled_python = _bundled_bootstrap_python()
    bundled_backend = str(bundled_state.get("backend") or "") if bundled_state else ""
    if (
        bundled_state
        and bundled_state.get("source") == "bundled"
        and bundled_python
        and bundled_backend in manifest.get("backends", {})
        and bundled_backend not in seen_backends
    ):
        try:
            probed = _probe_python_runtime(bundled_python, _backend_extra_names(manifest, bundled_backend))
            if _runtime_probe_is_ready(bundled_backend, probed, manifest):
                items.append({
                    **bundled_state,
                    "backend": bundled_backend,
                    "pythonPath": str(bundled_python),
                    "source": "bundled",
                    "coreUpdateSupported": False,
                    "packages": probed.get("packages"),
                    "packageVersions": probed.get("packageVersions"),
                    "pymssVersion": probed.get("pymssVersion"),
                    "pymssCoreVersion": probed.get("pymssCoreVersion"),
                })
        except Exception:
            pass
    if BUNDLED_RUNTIME_ENVS_DIR and BUNDLED_RUNTIME_ENVS_DIR.is_dir():
        for backend in manifest.get("backends", {}):
            if backend in seen_backends:
                continue
            bundled_env = BUNDLED_RUNTIME_ENVS_DIR / backend
            bundled_state_path = bundled_env / "pymss-runtime-state.json"
            bundled_python = bundled_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            if not bundled_state_path.is_file() or not bundled_python.is_file():
                continue
            try:
                state = json.loads(bundled_state_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            package_versions = _probe_python_package_versions(bundled_python, ["pymss", "pymss-core"])
            items.append({
                **state,
                "backend": backend,
                "pythonPath": str(bundled_python),
                "source": "bundled",
                "coreUpdateSupported": False,
                "packageVersions": {**(state.get("packageVersions") or {}), **package_versions},
                "pymssVersion": package_versions.get("pymss") or state.get("pymssVersion"),
                "pymssCoreVersion": package_versions.get("pymss-core") or state.get("pymssCoreVersion"),
            })
            seen_backends.add(backend)
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

    A packaged environment records its state on the build machine, which has no GPU, so a
    CUDA environment may claim acceleratorAvailable=false forever. The active
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
            "packageVersions": {**(entry.get("packageVersions") or {}), **(active_probe.get("packageVersions") or {})},
            "pymssVersion": active_probe.get("pymssVersion") or entry.get("pymssVersion"),
            "pymssCoreVersion": active_probe.get("pymssCoreVersion") or entry.get("pymssCoreVersion"),
        })
        break
    return environments


def _latest_pypi_version(distribution: str) -> str | None:
    url = f"https://pypi.org/pypi/{distribution}/json"
    with urllib.request.urlopen(url, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))
    version = payload.get("info", {}).get("version")
    return str(version) if version else None


def _runtime_env_dir_for_python(python_path: Path) -> Path:
    return python_path.parent.parent if python_path.parent.name.lower() in {"scripts", "bin"} else python_path.parent


def _is_user_runtime_env(env_dir: Path) -> bool:
    try:
        return env_dir.resolve().is_relative_to(RUNTIME_ENVS_DIR.resolve())
    except (OSError, ValueError):
        return False


def _is_bundled_runtime_env(env_dir: Path) -> bool:
    if not BUNDLED_RUNTIME_ENVS_DIR:
        return False
    try:
        return env_dir.resolve().is_relative_to(BUNDLED_RUNTIME_ENVS_DIR.resolve())
    except (OSError, ValueError):
        return False


def _bundled_bootstrap_python() -> Path | None:
    if not BUNDLED_RUNTIME_ENVS_DIR:
        return None
    runtime_root = BUNDLED_RUNTIME_ENVS_DIR.parent
    candidates = [
        runtime_root / "python.exe",
        runtime_root / "bin" / "python3",
        runtime_root / "bin" / "python",
    ]
    return next((path for path in candidates if path.is_file()), None)


def _is_bundled_bootstrap_python(path: Path) -> bool:
    bundled = _bundled_bootstrap_python()
    try:
        return bool(bundled and path.resolve() == bundled.resolve())
    except OSError:
        return False


def _target_runtime_from_payload(payload: dict[str, Any], backend: str) -> tuple[dict[str, Any] | None, Path, Path, Path] | None:
    if not _supported_backend(backend):
        return None
    target_python = Path(str(payload.get("pythonPath"))) if payload.get("pythonPath") else None

    if target_python:
        if not target_python.is_file():
            return None
        if _is_bundled_bootstrap_python(target_python):
            state = _resolve_runtime_state_from(BUNDLED_RUNTIME_ENVS_DIR / "active-runtime.json") if BUNDLED_RUNTIME_ENVS_DIR else None
            if state and str(state.get("backend") or "").strip().lower() == backend:
                state["source"] = "bundled"
                return state, target_python.parent, Path(), target_python
            return None
        env_dir = _runtime_env_dir_for_python(target_python)
        if (not _is_user_runtime_env(env_dir) and not _is_bundled_runtime_env(env_dir)) or env_dir.name != backend:
            return None
        env_state_path = env_dir / "pymss-runtime-state.json"
        state = None
        if env_state_path.is_file():
            try:
                state = json.loads(env_state_path.read_text(encoding="utf-8"))
            except Exception:
                state = None
            if state and str(state.get("backend") or "").strip().lower() not in {"", backend}:
                return None
        if state is not None and _is_bundled_runtime_env(env_dir):
            state["source"] = "bundled"
        return state, env_dir, env_state_path, target_python

    active = _read_runtime_state()
    active_python = Path(str(active.get("pythonPath"))) if active and active.get("pythonPath") else None
    if active and str(active.get("backend") or "").strip().lower() == backend and active_python and active_python.is_file():
        env_dir = _runtime_env_dir_for_python(active_python)
        env_state_path = env_dir / "pymss-runtime-state.json"
        state = dict(active)
        if env_state_path.is_file():
            try:
                state = json.loads(env_state_path.read_text(encoding="utf-8"))
            except Exception:
                state = dict(active)
        if _is_bundled_runtime_env(env_dir):
            state["source"] = "bundled"
        return state, env_dir, env_state_path, active_python

    state = _read_installed_env_state(backend)
    env_dir = _env_dir(backend)
    env_state_path = _env_state_path(backend)
    python_path = _env_python_path(backend)
    if state and python_path.is_file():
        return state, env_dir, env_state_path, python_path

    if python_path.is_file():
        return None, env_dir, env_state_path, python_path

    if BUNDLED_RUNTIME_ENVS_DIR:
        bundled_env = BUNDLED_RUNTIME_ENVS_DIR / backend
        bundled_python = bundled_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        bundled_state_path = bundled_env / "pymss-runtime-state.json"
        if bundled_python.is_file():
            bundled_state = None
            if bundled_state_path.is_file():
                try:
                    bundled_state = json.loads(bundled_state_path.read_text(encoding="utf-8"))
                except Exception:
                    bundled_state = None
            if bundled_state is not None:
                bundled_state["source"] = "bundled"
            return bundled_state, bundled_env, bundled_state_path, bundled_python

    bundled_state = _resolve_runtime_state_from(BUNDLED_RUNTIME_ENVS_DIR / "active-runtime.json") if BUNDLED_RUNTIME_ENVS_DIR else None
    bundled_python = _bundled_bootstrap_python()
    if (
        bundled_state
        and str(bundled_state.get("backend") or "") == backend
        and bundled_python
    ):
        bundled_state["source"] = "bundled"
        return bundled_state, bundled_python.parent, Path(), bundled_python

    return None


def _runtime_probe_is_ready(backend: str, probed: dict[str, Any], manifest: dict[str, Any]) -> bool:
    packages = probed.get("packages") or {}
    required = [*manifest.get("common", {})]
    required.extend(_backend_extra_names(manifest, backend))
    if not all(packages.get(name) is True for name in required):
        return False
    expected_torch_backend = "cpu" if backend == "mlx" else backend
    if probed.get("torchBackend") != expected_torch_backend:
        return False
    return True


def _runtime_info_payload(payload: dict[str, Any]) -> dict[str, Any]:
    manifest = _manifest()
    backend = str(payload.get("backend") or "").strip() or None
    install_state = _read_runtime_state()
    packages = {name: _module_available(PACKAGE_IMPORT_NAMES.get(name, name)) for name in manifest["common"]}
    package_versions = None
    pymss_version = None
    pymss_core_version = None
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
            package_versions = probed.get("packageVersions")
            pymss_version = probed.get("pymssVersion")
            pymss_core_version = probed.get("pymssCoreVersion")
            torch_version = probed.get("torchVersion")
            torch_backend = str(probed.get("torchBackend") or torch_backend)
            accelerator_available = bool(probed.get("acceleratorAvailable"))
        except Exception:
            packages = dict(install_state.get("packages") or packages)
            package_versions = install_state.get("packageVersions")
            pymss_version = install_state.get("pymssVersion")
            pymss_core_version = install_state.get("pymssCoreVersion")
            torch_version = install_state.get("torchVersion")
            torch_backend = str(install_state.get("torchBackend") or torch_backend)
            accelerator_available = bool(install_state.get("acceleratorAvailable"))
    elif _module_available("torch"):
        try:
            probed = _probe_python_runtime(Path(sys.executable), extra_names)
            active_probe = probed
            packages = dict(probed.get("packages") or packages)
            package_versions = probed.get("packageVersions")
            pymss_version = probed.get("pymssVersion")
            pymss_core_version = probed.get("pymssCoreVersion")
            import torch
            torch_version = torch.__version__
            torch_backend = "rocm" if getattr(torch.version, "hip", None) else "cuda" if getattr(torch.version, "cuda", None) else "cpu"
            accelerator_available = bool(torch.cuda.is_available())
        except Exception as exc:
            packages["torch"] = False
            torch_backend = f"error:{exc}"
    if not pymss_version and package_versions:
        pymss_version = package_versions.get("pymss")
    if not pymss_core_version and package_versions:
        pymss_core_version = package_versions.get("pymss-core")
    return {
        "manifestVersion": manifest["manifestVersion"],
        "pythonVersion": platform.python_version(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "bootstrapPython": str(_bootstrap_python_path()),
        "runtimeEnvsDir": str(RUNTIME_ENVS_DIR),
        "activeRuntimeFile": str(ACTIVE_RUNTIME_FILE),
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
        "packageVersions": package_versions,
        "pymssVersion": pymss_version,
        "pymssCoreVersion": pymss_core_version,
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
    _recover_reinstall_backups()
    _emit("runtime_info", _runtime_info_payload(payload))
    return 0


def cmd_runtime_core_versions(payload: dict[str, Any]) -> int:
    del payload
    packages: dict[str, dict[str, str | None]] = {}
    for name in ("pymss", "pymss-core"):
        try:
            packages[name] = {"latestVersion": _latest_pypi_version(name)}
        except Exception as exc:
            packages[name] = {"latestVersion": None, "error": str(exc)}
    _emit("runtime_core_versions", {"packages": packages})
    return 0


def cmd_runtime_env_sizes(payload: dict[str, Any]) -> int:
    """Disk usage per installed environment. Split out of runtime_info on purpose: walking a
    multi-GB venv takes long enough that it would slow down every startup and every refresh."""
    del payload
    sizes: dict[str, int] = {}
    incomplete: list[str] = []
    _recover_reinstall_backups()
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
    supported = _supported_backend(backend)
    if not supported:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", f"Unsupported runtime backend: {backend or 'missing'}")
    backend, _spec = supported
    target = _target_runtime_from_payload(payload, backend)
    if not target:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} is not installed")
    state, env_dir, _env_state_path_value, python_path = target
    if not state and not _is_bundled_runtime_env(env_dir) and not _is_bundled_bootstrap_python(python_path):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} has no completed installation state")
    if _is_bundled_runtime_env(env_dir) or _is_bundled_bootstrap_python(python_path):
        try:
            ACTIVE_RUNTIME_FILE.unlink()
        except FileNotFoundError:
            pass
        active = {
            **(state or {}),
            "backend": backend,
            "pythonPath": str(python_path),
            "source": "bundled",
            "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _emit("runtime_activated", active)
        return 0
    manifest = _manifest()
    try:
        probed = _probe_python_runtime(python_path, _backend_extra_names(manifest, backend))
    except Exception as exc:
        from worker_protocol import emit_error
        return emit_error(
            "RUNTIME_ACTIVATION_FAILED",
            f"Runtime {backend} failed validation: {exc}",
            recoverable=True,
        )
    if not _runtime_probe_is_ready(backend, probed, manifest):
        from worker_protocol import emit_error
        return emit_error(
            "RUNTIME_ACTIVATION_FAILED",
            f"Runtime {backend} failed validation: torchBackend={probed.get('torchBackend')}, "
            f"acceleratorAvailable={probed.get('acceleratorAvailable')}",
            recoverable=True,
        )
    active = {
        **(state or {}),
        "backend": backend,
        "pythonPath": str(python_path),
        "logPath": str(env_dir / "pymss-runtime-install.log"),
        "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _write_runtime_state(active)
    _emit("runtime_activated", active)
    return 0


def cmd_delete_runtime(payload: dict[str, Any]) -> int:
    backend = str(payload.get("backend") or "").strip().lower()
    supported = _supported_backend(backend)
    if not supported:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", f"Unsupported runtime backend: {backend or 'missing'}")
    backend, _spec = supported
    target = _target_runtime_from_payload(payload, backend)
    if not target:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} is not installed")
    _state, env_dir, _env_state_path_value, python_path = target
    if _is_bundled_runtime_env(env_dir) or _is_bundled_bootstrap_python(python_path):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BUNDLED_READ_ONLY", f"Bundled runtime {backend} cannot be deleted.")
    active = _read_runtime_state()
    active_python = Path(str(active.get("pythonPath"))) if active and active.get("pythonPath") else None
    if active and active_python and _same_path(active_python, python_path):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_DELETE_ACTIVE", f"Cannot delete the currently active runtime ({backend}). Switch to another environment first.")
    import shutil
    try:
        if env_dir.is_dir():
            shutil.rmtree(str(env_dir))
        if active_python and _same_path(active_python, python_path):
            try:
                ACTIVE_RUNTIME_FILE.unlink()
            except Exception:
                pass
        _emit("runtime_deleted", {"backend": backend})
        return 0
    except Exception as exc:
        from worker_protocol import emit_error
        return emit_error(
            "RUNTIME_PERMISSION_DENIED" if isinstance(exc, PermissionError) else "RUNTIME_DELETE_FAILED",
            str(exc),
        )


def _normal_runtime_path(path: Path) -> str:
    """Return a normal Win32 path before handing a runtime directory to ``venv``.

    Rust's ``canonicalize`` returns a ``\\\\?\\`` long-path prefix on Windows.  The prefix is
    valid for ordinary file I/O, but Python 3.12's venv/ensurepip bootstrap intermittently fails
    when its destination (and the child interpreter it launches) keeps that prefix, especially
    for repository paths containing non-ASCII characters.
    """
    value = os.fspath(path)
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[len("\\\\?\\UNC\\"):]
    if value.startswith("\\\\?\\"):
        return value[len("\\\\?\\"):]
    return value


def _create_runtime_venv(env_dir: Path) -> None:
    import venv

    venv.EnvBuilder(with_pip=True, clear=True, symlinks=(os.name != "nt")).create(_normal_runtime_path(env_dir))


def _runtime_python_works(python_path: Path) -> bool:
    try:
        return subprocess.run(
            [str(python_path), "-c", "import sys; print(sys.prefix)"],
            capture_output=True,
            text=True,
            timeout=20,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _runtime_pip_works(python_path: Path) -> bool:
    try:
        return subprocess.run(
            [str(python_path), "-m", "pip", "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _ensure_runtime_pip(
    python_path: Path,
    task_id: str,
    append_log: Any,
) -> None:
    """Repair an interrupted venv before the first pip operation.

    A killed install can leave Scripts/python.exe in place while ensurepip never ran. Treat that
    directory as recoverable instead of reusing it until every later pip command fails.
    """
    if _runtime_pip_works(python_path):
        return

    message = "pip is unavailable; bootstrapping it with ensurepip"
    append_log("bootstrap", message)
    _emit("runtime_install_log", {"stage": "bootstrap", "message": message}, task_id)
    result = subprocess.run(
        [str(python_path), "-m", "ensurepip", "--upgrade", "--default-pip"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    for line in result.stdout.splitlines():
        message = line.rstrip()
        append_log("bootstrap", message)
        _emit("runtime_install_log", {"stage": "bootstrap", "message": message}, task_id)
    if result.returncode != 0:
        raise RuntimeError(f"pip bootstrap failed with exit code {result.returncode}")

    if not _runtime_pip_works(python_path):
        raise RuntimeError("pip bootstrap completed but pip is still unavailable")


def _repair_runtime_venv_config(env_dir: Path) -> None:
    cfg = env_dir / "pyvenv.cfg"
    bootstrap = _bootstrap_python_path()
    if not cfg.is_file() or not bootstrap.is_file():
        return
    content = "\n".join([
        f"home = {bootstrap.parent}",
        "include-system-site-packages = false",
        f"executable = {bootstrap}",
        f"command = {bootstrap} -m venv {env_dir}",
        "",
    ])
    if cfg.read_text(encoding="utf-8", errors="replace") != content:
        _atomic_write_text(cfg, content)


def _make_posix_venv_relocatable(env_dir: Path) -> None:
    if os.name == "nt":
        return
    bin_dir = env_dir / "bin"
    bootstrap = _bootstrap_python_path().resolve()
    if not bin_dir.is_dir() or not bootstrap.is_file():
        return
    relative = os.path.relpath(bootstrap, bin_dir)
    names = {"python", "python3", f"python{sys.version_info.major}.{sys.version_info.minor}"}
    for name in names:
        path = bin_dir / name
        try:
            if path.is_symlink() and path.resolve() == bootstrap:
                continue
        except OSError:
            pass
        temporary = bin_dir / f".{name}.{os.getpid()}.pymss-tmp"
        try:
            temporary.unlink(missing_ok=True)
            temporary.symlink_to(relative)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def cmd_install_runtime(payload: dict[str, Any]) -> int:
    """Build and activate an environment for `backend`.

    Cancellation is not handled here: the desktop shell kills this process and its whole tree
    (see cancel_task in app_cmd.rs), which takes pip down with it. The interrupted venv is left
    on disk on purpose — _incomplete_env_backends() reports it so the space can be reclaimed."""
    task_id = str(payload.get("taskId") or f"runtime_install_{int(time.time() * 1000)}")
    backend = str(payload.get("backend") or "cpu").strip().lower()
    mirror = str(payload.get("mirror") or "auto").strip().lower()
    locale = str(payload.get("locale") or "").strip().lower()
    manifest = _manifest()
    _recover_reinstall_backups()
    supported = _supported_backend(backend, manifest)
    if not supported:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", f"Unsupported runtime backend: {backend}", task_id=task_id)
    backend, spec = supported
    if sys.platform not in spec.get("platforms", []):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_PLATFORM_UNSUPPORTED", f"Backend {backend} is not supported on {sys.platform}", task_id=task_id)
    index_url = None
    mirror, index_url = _resolve_pypi_mirror(mirror, locale)
    env_dir = _env_dir(backend)
    env_dir.mkdir(parents=True, exist_ok=True)
    env_python = _env_python_path(backend)
    install_log_path = _env_log_path(backend)
    reinstall_backup: Path | None = None
    if env_dir.is_dir() and env_python.is_file() and _env_state_path(backend).is_file():
        import shutil
        reinstall_backup = RUNTIME_ENVS_DIR / f".{backend}.reinstalling"
        if reinstall_backup.exists():
            shutil.rmtree(reinstall_backup)
        env_dir.rename(reinstall_backup)
    def append_log(stage: str, message: str) -> None:
        with install_log_path.open("a", encoding="utf-8", errors="replace") as file:
            file.write(f"[{stage}] {message}\n")

    def run_pip(args: list[str], stage: str, package_index: str | None = None) -> None:
        command = [str(env_python), "-m", "pip", "install", "--no-cache-dir"]
        if stage == "pymss":
            command.append("--upgrade")
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
        install_log_path.write_text(
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] install backend={backend} mirror={mirror} manifest={manifest['manifestVersion']}\n",
            encoding="utf-8",
        )
        rebuild_message = ""
        _repair_runtime_venv_config(env_dir)
        if not env_python.is_file():
            _create_runtime_venv(env_dir)
        elif not _runtime_python_works(env_python):
            rebuild_message = "existing environment interpreter is unusable; rebuilding"
            _emit("runtime_install_log", {"stage": "venv", "message": rebuild_message}, task_id)
            import shutil
            shutil.rmtree(env_dir, ignore_errors=True)
            env_dir.mkdir(parents=True, exist_ok=True)
            _create_runtime_venv(env_dir)
        elif not _runtime_pip_works(env_python):
            # A cancelled or older portable install can leave a runnable venv without pip. The
            # venv's ensurepip module may have been pruned already, so recreate it from the
            # bootstrap runtime instead of failing the first package install.
            rebuild_message = "existing environment has no pip; rebuilding the virtual environment"
            _emit("runtime_install_log", {
                "stage": "bootstrap",
                "message": rebuild_message,
            }, task_id)
            import shutil
            shutil.rmtree(env_dir, ignore_errors=True)
            env_dir.mkdir(parents=True, exist_ok=True)
            _create_runtime_venv(env_dir)
        if rebuild_message:
            append_log("bootstrap", rebuild_message)
        _make_posix_venv_relocatable(env_dir)
        _emit("runtime_install_started", {"backend": backend, "manifestVersion": manifest["manifestVersion"], "logPath": str(install_log_path)}, task_id)
        _ensure_runtime_pip(env_python, task_id, append_log)
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
        if not _runtime_probe_is_ready(backend, probed, manifest):
            missing = [
                name for name in [*manifest.get("common", {}), *_backend_extra_names(manifest, backend)]
                if (probed.get("packages") or {}).get(name) is not True
            ]
            raise RuntimeError(
                f"Runtime probe failed for {backend}: missing packages={missing}, "
                f"torchBackend={probed.get('torchBackend')}, "
                f"acceleratorAvailable={probed.get('acceleratorAvailable')}"
            )
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
            "packageVersions": probed.get("packageVersions"),
            "pymssVersion": probed.get("pymssVersion"),
            "pymssCoreVersion": probed.get("pymssCoreVersion"),
        }
        _atomic_write_json(_env_state_path(backend), state)
        active = {
            **state,
            "pythonPath": str(env_python),
            "logPath": str(install_log_path),
            "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_runtime_state(active)
        if reinstall_backup and reinstall_backup.exists():
            import shutil
            try:
                shutil.rmtree(reinstall_backup)
            except OSError as backup_error:
                append_log("warning", f"failed to remove reinstall backup: {backup_error}")
        _emit("runtime_install_finished", {"backend": backend, "state": active, "logPath": str(install_log_path)}, task_id)
        return 0
    except Exception as exc:
        from worker_protocol import emit_error
        if reinstall_backup and reinstall_backup.exists():
            import shutil
            if env_dir.exists():
                shutil.rmtree(env_dir, ignore_errors=True)
            reinstall_backup.rename(env_dir)
        append_log("error", str(exc))
        return emit_error(
            "RUNTIME_PERMISSION_DENIED" if isinstance(exc, PermissionError) else "RUNTIME_INSTALL_FAILED",
            str(exc),
            detail=f"详细安装日志：{install_log_path}",
            task_id=task_id,
            recoverable=True,
            extra={"backend": backend, "logPath": str(install_log_path)},
        )


def cmd_update_runtime_core(payload: dict[str, Any]) -> int:
    task_id = str(payload.get("taskId") or f"runtime_core_update_{int(time.time() * 1000)}")
    backend = str(payload.get("backend") or "").strip().lower()
    mirror = str(payload.get("mirror") or "auto").strip().lower()
    locale = str(payload.get("locale") or "").strip().lower()
    manifest = _manifest()
    supported = _supported_backend(backend)
    if not supported:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_BACKEND_UNSUPPORTED", f"Unsupported runtime backend: {backend or 'missing'}", task_id=task_id)
    backend, _spec = supported

    mirror, index_url = ("pypi", PYPI_MIRROR_URLS["pypi"]) if mirror == "auto" else _resolve_pypi_mirror(mirror, locale)
    try:
        target_pymss_version = _latest_pypi_version("pymss")
    except Exception as exc:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_FAILED", f"Failed to resolve latest pymss version from PyPI: {exc}", task_id=task_id, recoverable=True)
    try:
        target_pymss_core_version = _latest_pypi_version("pymss-core")
    except Exception as exc:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_FAILED", f"Failed to resolve latest pymss-core version from PyPI: {exc}", task_id=task_id, recoverable=True)
    target = _target_runtime_from_payload(payload, backend)
    if not target:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Backend {backend} is not installed", task_id=task_id)
    state, env_dir, env_state_path, python_path = target
    if not state:
        from worker_protocol import emit_error
        return emit_error(
            "RUNTIME_NOT_INSTALLED",
            f"Backend {backend} has no completed installation state",
            task_id=task_id,
            recoverable=True,
        )
    if _is_bundled_runtime_env(env_dir) or _is_bundled_bootstrap_python(python_path):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_UNSUPPORTED", "Bundled runtime environments cannot be updated in place; install a user-managed environment first.", task_id=task_id, recoverable=True)
    if not python_path.is_file():
        from worker_protocol import emit_error
        return emit_error("RUNTIME_NOT_INSTALLED", f"Active runtime Python not found: {python_path}", task_id=task_id)
    if _same_path(python_path, _bootstrap_python_path()):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_UNSUPPORTED", "The app bootstrap Python runtime cannot be updated in place", task_id=task_id)
    # Core update is only available for the currently active runtime
    active = _read_runtime_state()
    active_python = Path(str(active.get("pythonPath"))) if active and active.get("pythonPath") else None
    if not active_python or not _same_path(active_python, python_path):
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_INACTIVE", "Core update is only available for the currently active runtime. Please switch to this environment first.", task_id=task_id, recoverable=True)
    log_path = env_dir / "pymss-core-update.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] update pymss core mirror={mirror}\n", encoding="utf-8")
    _emit("runtime_core_update_started", {"backend": backend, "logPath": str(log_path)}, task_id)

    def append_log(stage: str, message: str) -> None:
        with log_path.open("a", encoding="utf-8", errors="replace") as file:
            file.write(f"[{stage}] {message}\n")

    # Keep dependency resolution enabled so new dependencies introduced by pymss are installed,
    # but constrain Torch to the build already installed in this backend.
    torch_version = str((state or {}).get("torchVersion") or "").strip()
    if not torch_version:
        try:
            torch_version = str(_probe_python_runtime(python_path).get("torchVersion") or "").strip()
        except Exception:
            torch_version = ""
    if not torch_version:
        from worker_protocol import emit_error
        return emit_error("RUNTIME_CORE_UPDATE_FAILED", "Unable to determine the installed Torch version; refusing to update the runtime core.", task_id=task_id, recoverable=True)
    constraints_path = env_dir / ".pymss-core-update-constraints.txt"
    _atomic_write_text(constraints_path, f"torch=={torch_version}\n")
    command = [str(python_path), "-m", "pip", "install", "--upgrade", "--no-cache-dir", "--only-binary=:all:", "--prefer-binary"]
    command.extend(["--constraint", str(constraints_path)])
    if index_url:
        command.extend(["--index-url", index_url])
    # Keep extras declared by the shipped manifest (currently ``[proxy]``) when
    # upgrading an environment created by an older manifest.  Installing only
    # the bare distribution would leave newly declared optional dependencies
    # absent even though the core package itself was updated successfully.
    pymss_requirement = _pin_manifest_requirement(
        manifest.get("common", {}).get("pymss"),
        target_pymss_version,
    )
    pymss_core_requirement = f"pymss-core=={target_pymss_core_version}"
    command.extend([pymss_requirement, pymss_core_requirement])
    try:
        _ensure_runtime_pip(python_path, task_id, append_log)
        _emit("runtime_core_update_stage", {"stage": "pymss", "command": f"pip install --upgrade {pymss_requirement} {pymss_core_requirement}"}, task_id)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=os.environ.copy())
        assert process.stdout is not None
        for line in process.stdout:
            message = line.rstrip()
            append_log("pymss", message)
            _emit("runtime_core_update_log", {"stage": "pymss", "message": message}, task_id)
        if process.wait() != 0:
            raise RuntimeError(f"pip failed with exit code {process.returncode}")
        probed = _probe_python_runtime(python_path, _backend_extra_names(_manifest(), backend))
        if probed.get("pymssVersion") != target_pymss_version:
            raise RuntimeError(f"pymss stayed at {probed.get('pymssVersion') or 'unknown'} after update; expected {target_pymss_version}")
        if probed.get("pymssCoreVersion") != target_pymss_core_version:
            raise RuntimeError(f"pymss-core stayed at {probed.get('pymssCoreVersion') or 'unknown'} after update; expected {target_pymss_core_version}")
        expected_torch_backend = "cpu" if backend == "mlx" else backend
        if probed.get("torchBackend") != expected_torch_backend:
            raise RuntimeError(
                f"Torch backend changed to {probed.get('torchBackend') or 'unknown'} during update; expected {expected_torch_backend}"
            )
        if probed.get("torchVersion") != torch_version:
            raise RuntimeError(
                f"Torch version changed to {probed.get('torchVersion') or 'unknown'} during update; expected {torch_version}"
            )
        updated = {
            **(state or {}),
            "backend": backend,
            "manifestVersion": manifest.get("manifestVersion"),
            "pythonPath": str(python_path),
            "logPath": str(log_path),
            "packages": probed.get("packages") or (state.get("packages") if state else None),
            "packageVersions": probed.get("packageVersions") or (state.get("packageVersions") if state else None),
            "pymssVersion": probed.get("pymssVersion") or (state.get("pymssVersion") if state else None),
            "pymssCoreVersion": probed.get("pymssCoreVersion") or (state.get("pymssCoreVersion") if state else None),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if env_state_path:
            env_state = dict(updated)
            env_state.pop("pythonPath", None)
            env_state.pop("logPath", None)
            env_state.pop("activatedAt", None)
            env_state.pop("source", None)
            _atomic_write_json(env_state_path, env_state)
        _write_runtime_state(updated)
        _emit("runtime_core_update_finished", {"backend": backend, "state": updated, "logPath": str(log_path)}, task_id)
        return 0
    except Exception as exc:
        from worker_protocol import emit_error
        append_log("error", str(exc))
        return emit_error(
            "RUNTIME_CORE_UPDATE_FAILED",
            str(exc),
            detail=f"详细更新日志：{log_path}",
            task_id=task_id,
            recoverable=True,
            extra={"backend": backend, "logPath": str(log_path)},
        )
    finally:
        try:
            constraints_path.unlink()
        except OSError:
            pass
