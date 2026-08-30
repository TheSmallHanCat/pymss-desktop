"""Manage optional worker dependencies for the runtime active at task start.

Each active backend gets a writable sidecar under the application data directory. Pip first
resolves against the active environment, then installs only the missing distributions into the
sidecar so platform-specific packages such as PyTorch are neither replaced nor duplicated. A
package already supplied directly by the selected runtime is uninstalled through that runtime's
interpreter rather than through the bootstrap environment.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any

from worker_protocol import emit, emit_error


OPTIONAL_PACKAGES: dict[str, dict[str, str]] = {
    "funasr": {
        "requirement": "funasr==1.3.26",
        "verifyCode": "import funasr, torchaudio",
    },
}


@dataclass(frozen=True)
class RuntimeContext:
    """Immutable view of the runtime selected when a package operation starts."""

    executable: Path
    backend: str
    identity: str
    packages_dir: Path


def _runtime_envs_dir() -> Path:
    configured = str(os.environ.get("PYMSS_STUDIO_RUNTIME_ENVS_DIR") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    executable = Path(sys.executable).resolve()
    env_dir = executable.parent.parent if executable.parent.name.lower() in {"scripts", "bin"} else executable.parent
    return env_dir.parent


def _runtime_identity(*, backend: str | None = None, executable: Path | None = None) -> str:
    backend = _active_runtime_backend() if backend is None else backend
    executable = (executable or Path(sys.executable)).resolve()
    if not backend:
        digest = hashlib.sha256(os.path.normcase(str(executable)).encode("utf-8")).hexdigest()[:12]
        backend = f"runtime-{digest}"
    safe_backend = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in backend)
    return f"{safe_backend}-py{sys.version_info.major}{sys.version_info.minor}"


def _active_runtime_backend() -> str:
    active_file = str(os.environ.get("PYMSS_STUDIO_ACTIVE_RUNTIME_FILE") or "").strip()
    backend = ""
    if active_file:
        try:
            state = json.loads(Path(active_file).read_text(encoding="utf-8"))
            backend = str(state.get("backend") or "").strip().lower()
        except Exception:
            backend = ""
    return backend


def _runtime_context() -> RuntimeContext:
    executable = Path(sys.executable).resolve()
    backend = _active_runtime_backend()
    identity = _runtime_identity(backend=backend, executable=executable)
    return RuntimeContext(
        executable=executable,
        backend=backend,
        identity=identity,
        packages_dir=_runtime_envs_dir() / "optional-packages" / identity,
    )


def _package_dir(name: str, runtime: RuntimeContext | None = None) -> Path:
    return (runtime or _runtime_context()).packages_dir / name


def _package_spec(name: Any) -> tuple[str, dict[str, str]]:
    normalized = str(name or "").strip().lower()
    spec = OPTIONAL_PACKAGES.get(normalized)
    if not spec:
        raise ValueError(f"Unsupported optional runtime package: {normalized or 'missing'}")
    return normalized, spec


def activate_optional_packages(runtime: RuntimeContext | None = None) -> None:
    runtime = runtime or _runtime_context()
    for name in OPTIONAL_PACKAGES:
        directory = _package_dir(name, runtime)
        if directory.is_dir():
            value = str(directory)
            if value not in sys.path:
                sys.path.insert(0, value)
    importlib.invalidate_caches()


def _sidecar_version(name: str, directory: Path) -> str | None:
    if not directory.is_dir():
        return None
    try:
        for distribution in metadata.distributions(path=[str(directory)]):
            distribution_name = str(distribution.metadata.get("Name") or "").strip().lower()
            if distribution_name == name:
                return str(distribution.version)
    except Exception:
        return None
    return None


def _environment_version(name: str, runtime: RuntimeContext | None = None) -> str | None:
    runtime = runtime or _runtime_context()
    script = (
        "from importlib import metadata\n"
        f"try:\n print(metadata.version({name!r}))\n"
        "except metadata.PackageNotFoundError:\n print('')\n"
    )
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    try:
        output = subprocess.check_output(
            [str(runtime.executable), "-c", script],
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
        )
    except Exception:
        return None
    return output.strip() or None


def _required_version(requirement: str) -> str | None:
    name, separator, version = requirement.partition("==")
    return version.strip() if separator and name.strip() and version.strip() else None


def optional_package_status(name: Any, runtime: RuntimeContext | None = None) -> dict[str, Any]:
    """Return a lightweight availability snapshot for the selected runtime.

    Managed components are assembled in a staging directory, deeply imported there, and only
    then activated. Consequently, matching installed metadata is sufficient for the common
    status path; importing FunASR here would load Torch on every page activation and make a
    simple availability check take tens of seconds.
    """

    runtime = runtime or _runtime_context()
    normalized, spec = _package_spec(name)
    directory = _package_dir(normalized, runtime)
    managed_version = _sidecar_version(normalized, directory)
    environment_version = None if managed_version else _environment_version(normalized, runtime)
    version = managed_version or environment_version
    source = "managed" if managed_version else "environment" if environment_version else None
    expected_version = _required_version(spec["requirement"])
    issue = None
    if version and expected_version and version != expected_version:
        issue = "version_mismatch"
    return {
        "package": normalized,
        "requirement": spec["requirement"],
        "installed": bool(version) and issue is None,
        "present": bool(version),
        "version": version,
        "source": source,
        "issue": issue,
        "runtimeIdentity": runtime.identity,
    }


def _emit_stage(name: str, action: str, message: str, task_id: str | None = None) -> None:
    emit("optional_package_stage", {"package": name, "action": action, "message": message}, task_id=task_id)


def _run_process(
    command: list[str],
    name: str,
    action: str,
    environment: dict[str, str] | None = None,
    task_id: str | None = None,
) -> None:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment or os.environ.copy(),
    )
    assert process.stdout is not None
    recent: list[str] = []
    for line in process.stdout:
        message = line.rstrip()
        if not message:
            continue
        recent.append(message)
        recent = recent[-8:]
        emit("optional_package_log", {"package": name, "action": action, "message": message}, task_id=task_id)
    if process.wait() != 0:
        detail = recent[-1] if recent else f"pip exited with code {process.returncode}"
        raise RuntimeError(detail)


def _resolve_install_requirements(
    requirement: str,
    index_url: str,
    report_path: Path,
    name: str,
    task_id: str | None = None,
    runtime: RuntimeContext | None = None,
) -> list[str]:
    runtime = runtime or _runtime_context()
    _run_process(
        [
            str(runtime.executable),
            "-m",
            "pip",
            "install",
            "--dry-run",
            "--disable-pip-version-check",
            "--prefer-binary",
            "--report",
            str(report_path),
            "--index-url",
            index_url,
            requirement,
        ],
        name,
        "install",
        task_id=task_id,
    )
    report = json.loads(report_path.read_text(encoding="utf-8"))
    resolved: list[str] = []
    for item in report.get("install") or []:
        package_metadata = item.get("metadata") or {}
        package_name = str(package_metadata.get("name") or "").strip()
        version = str(package_metadata.get("version") or "").strip()
        if not package_name or not version:
            raise RuntimeError("pip returned an incomplete optional package resolution report")
        if not all(character.isalnum() or character in {"-", "_", "."} for character in package_name):
            raise RuntimeError(f"pip returned an invalid package name: {package_name}")
        resolved.append(f"{package_name}=={version}")
    required_name = requirement.partition("==")[0].strip().lower().replace("_", "-")
    resolved_names = {
        value.partition("==")[0].strip().lower().replace("_", "-")
        for value in resolved
    }
    if required_name not in resolved_names:
        # A broken copy may still satisfy pip's metadata check in the active environment. Install
        # the requested distribution into the sidecar so it shadows that unusable copy.
        resolved.append(requirement)
    return resolved


def _torchaudio_requirement(runtime: RuntimeContext | None = None) -> tuple[str, str | None] | None:
    runtime = runtime or _runtime_context()
    torch_version = _environment_version("torch", runtime)
    if not torch_version:
        raise RuntimeError("The active runtime does not include PyTorch")
    version = torch_version.split("+", 1)[0]
    torchaudio_version = _environment_version("torchaudio", runtime)
    if torchaudio_version and torchaudio_version.split("+", 1)[0] == version:
        return None
    from worker_bootstrap import _manifest
    backend = runtime.backend
    torch_spec = ((_manifest().get("backends") or {}).get(backend) or {}).get("torch") or {}
    if backend == "rocm":
        for requirement in torch_spec.get("requirements") or []:
            if "/torchaudio-" in str(requirement).lower():
                return str(requirement), None
        raise RuntimeError("The active ROCm runtime does not define a compatible torchaudio wheel")
    return f"torchaudio=={version}", str(torch_spec.get("indexUrl") or "").strip() or None


def _install_torchaudio(
    staging: Path,
    name: str,
    task_id: str | None,
    runtime: RuntimeContext | None = None,
) -> None:
    runtime = runtime or _runtime_context()
    requirement = _torchaudio_requirement(runtime)
    if requirement is None:
        return
    package, index_url = requirement
    command = [
        str(runtime.executable), "-m", "pip", "install", "--disable-pip-version-check",
        "--prefer-binary", "--no-deps", "--target", str(staging),
    ]
    if index_url:
        command.extend(["--index-url", index_url])
    command.append(package)
    _emit_stage(name, "install", f"Installing the compatible audio runtime: {package}", task_id)
    _run_process(command, name, "install", task_id=task_id)


def _install_package(
    name: str,
    spec: dict[str, str],
    mirror: str,
    locale: str,
    task_id: str | None = None,
    runtime: RuntimeContext | None = None,
) -> None:
    from worker_bootstrap import PYPI_MIRROR_URLS, _resolve_pypi_mirror

    runtime = runtime or _runtime_context()

    selected_mirror, index_url = _resolve_pypi_mirror(mirror, locale)
    official = PYPI_MIRROR_URLS["pypi"]
    indexes = [index_url or official]
    if selected_mirror != "pypi" and official not in indexes:
        indexes.append(official)

    target = _package_dir(name, runtime)
    staging = target.with_name(f".{name}.installing")
    report_path = target.with_name(f".{name}.pip-report.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    try:
        for attempt, index in enumerate(indexes):
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)
            report_path.unlink(missing_ok=True)
            if attempt:
                _emit_stage(name, "install", "Selected package source is unavailable; retrying with PyPI", task_id)
            try:
                resolved = _resolve_install_requirements(
                    spec["requirement"],
                    index,
                    report_path,
                    name,
                    task_id,
                    runtime,
                )
                command = [
                    str(runtime.executable), "-m", "pip", "install", "--disable-pip-version-check",
                    "--prefer-binary", "--no-deps",
                    "--target", str(staging), "--index-url", index, *resolved,
                ]
                _run_process(command, name, "install", task_id=task_id)
                last_error = None
                break
            except Exception as error:
                last_error = error
        if last_error:
            raise last_error
        _install_torchaudio(staging, name, task_id, runtime)
        _emit_stage(name, "install", "Verifying the FunASR runtime component", task_id)
        _run_process(
            [
                str(runtime.executable),
                "-c",
                f"import sys; sys.path.insert(0, sys.argv[1]); {spec['verifyCode']}",
                str(staging),
            ],
            name,
            "install",
            task_id=task_id,
        )
        shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
        activate_optional_packages(runtime)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        report_path.unlink(missing_ok=True)


def _uninstall_package(
    name: str,
    task_id: str | None = None,
    runtime: RuntimeContext | None = None,
) -> None:
    runtime = runtime or _runtime_context()
    target = _package_dir(name, runtime)
    if target.is_dir():
        shutil.rmtree(target)
    if _environment_version(name, runtime):
        _run_process(
            [str(runtime.executable), "-m", "pip", "uninstall", "--yes", name],
            name,
            "uninstall",
            task_id=task_id,
        )
    importlib.invalidate_caches()


def cmd_optional_package_status(payload: dict[str, Any]) -> int:
    try:
        status = optional_package_status(payload.get("package"), _runtime_context())
    except Exception as error:
        return emit_error("OPTIONAL_PACKAGE_INVALID", str(error), recoverable=True)
    emit("optional_package_status", status)
    return 0


def cmd_manage_optional_package(payload: dict[str, Any]) -> int:
    action = str(payload.get("action") or "").strip().lower()
    task_id = str(payload.get("taskId") or "").strip() or None
    try:
        runtime = _runtime_context()
        name, spec = _package_spec(payload.get("package"))
        if action not in {"install", "uninstall"}:
            raise ValueError(f"Unsupported optional package action: {action or 'missing'}")
        current = optional_package_status(name, runtime)
        if action == "install" and not current["installed"]:
            _emit_stage(name, action, f"Installing {spec['requirement']}", task_id)
            _install_package(
                name,
                spec,
                str(payload.get("mirror") or "auto").strip().lower(),
                str(payload.get("locale") or "").strip().lower(),
                task_id,
                runtime,
            )
        elif action == "uninstall" and current["present"]:
            _emit_stage(name, action, f"Uninstalling {name}", task_id)
            _uninstall_package(name, task_id, runtime)
        status = optional_package_status(name, runtime)
        if action == "install" and not status["installed"]:
            raise RuntimeError(f"{name} is still unavailable after installation")
        if action == "uninstall" and status["present"]:
            raise RuntimeError(f"{name} is still installed after uninstallation")
        emit("optional_package_status", status, task_id=task_id)
        return 0
    except Exception as error:
        return emit_error(
            "OPTIONAL_PACKAGE_MANAGE_FAILED",
            str(error),
            task_id=task_id,
            recoverable=True,
        )
