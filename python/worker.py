from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKER_VERSION = "0.1.0"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def bootstrap_pymss_path() -> None:
    def resolve_sys_path(candidate: Path) -> Path | None:
        if (candidate / "pymss" / "__init__.py").is_file():
            return candidate
        if (candidate / "__init__.py").is_file() and (candidate / "separator.py").is_file():
            return candidate.parent
        return None

    worker_path = Path(__file__).resolve()
    worker_dir = worker_path.parent
    candidates: list[Path] = []

    env_pymss = os.environ.get("PYMSS_STUDIO_PYMSS_PATH")
    if env_pymss:
        candidates.append(Path(env_pymss))

    # Portable / staged layout:
    #   <root>/python/worker.py
    #   <root>/pymss/...
    candidates.append(worker_dir.parent / "pymss")

    # Development layout:
    #   <workspace>/pymss-desktop/python/worker.py
    #   <workspace>/pymss/...
    candidates.append(worker_dir.parent.parent / "pymss")

    # Tauri bundled resources sometimes place the worker deeper in resources.
    candidates.append(worker_dir.parent / "resources" / "pymss")
    candidates.append(worker_dir.parent.parent / "resources" / "pymss")

    for candidate in candidates:
        resolved = resolve_sys_path(candidate)
        if resolved is not None:
            sys.path.insert(0, str(resolved))
            return


bootstrap_pymss_path()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def emit(event_type: str, payload: dict[str, Any] | None = None, *, request_id: str | None = None, task_id: str | None = None) -> None:
    print(json.dumps({
        "type": event_type,
        "requestId": request_id,
        "taskId": task_id,
        "timestamp": now_iso(),
        "payload": payload or {},
    }, ensure_ascii=False), flush=True)


def emit_error(
    code: str,
    message: str,
    detail: str | None = None,
    *,
    task_id: str | None = None,
    recoverable: bool = False,
) -> int:
    emit("error", {
        "code": code,
        "message": message,
        "detail": detail,
        "recoverable": recoverable,
    }, task_id=task_id)
    return 1


def import_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def load_payload(payload_arg: str | None) -> dict[str, Any]:
    if not payload_arg:
        return {}
    path = Path(payload_arg)
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return json.loads(payload_arg)


def _as_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return None


def _derive_overlap_size_from_num_overlap(chunk_size: Any, num_overlap: Any) -> int | None:
    chunk_value = _as_int(chunk_size)
    overlap_count = _as_int(num_overlap)
    if chunk_value is None or overlap_count is None:
        return None
    if chunk_value <= 0 or overlap_count <= 0:
        return None
    if overlap_count == 1:
        return 0
    step = int(chunk_value // overlap_count)
    overlap_size = int(chunk_value - step)
    if overlap_size < 0 or overlap_size >= chunk_value:
        return None
    return overlap_size


def resolve_default_inference_params(entry: Any, model_path: Path, config_path: Path | None) -> dict[str, Any]:
    model_type = str(getattr(entry, "model_type", "") or "").strip().lower()
    defaults: dict[str, Any] = {}

    if not config_path or not config_path.is_file():
        return defaults

    try:
        from pymss.config import load_config, to_plain  # type: ignore

        config = to_plain(load_config(str(config_path)))
    except Exception:
        return defaults

    inference = config.get("inference") if isinstance(config, dict) else None
    audio = config.get("audio") if isinstance(config, dict) else None
    inference = inference if isinstance(inference, dict) else {}
    audio = audio if isinstance(audio, dict) else {}

    if model_type == "vr":
        batch_size = _as_int(inference.get("batch_size"))
        window_size = _as_int(inference.get("window_size"))
        aggression = _as_int(inference.get("aggression"))
        enable_post_process = _as_bool(inference.get("enable_post_process"))
        post_process_threshold = _as_float(inference.get("post_process_threshold"))
        high_end_process = _as_bool(inference.get("high_end_process"))

        if batch_size is not None:
            defaults["batch_size"] = batch_size
        if window_size is not None:
            defaults["window_size"] = window_size
        if aggression is not None:
            defaults["aggression"] = aggression
        if enable_post_process is not None:
            defaults["enable_post_process"] = enable_post_process
        if post_process_threshold is not None:
            defaults["post_process_threshold"] = post_process_threshold
        if high_end_process is not None:
            defaults["high_end_process"] = high_end_process
        return defaults

    batch_size = _as_int(inference.get("batch_size"))
    overlap_size = _as_int(inference.get("overlap_size"))
    num_overlap = _as_int(inference.get("num_overlap"))
    chunk_size = _as_int(audio.get("chunk_size"))
    if chunk_size is None:
        chunk_size = _as_int(inference.get("chunk_size"))
    normalize = _as_bool(inference.get("normalize"))

    if batch_size is not None:
        defaults["batch_size"] = batch_size
    if overlap_size is not None:
        defaults["overlap_size"] = overlap_size
    if model_type != "apollo" and num_overlap is not None:
        defaults["num_overlap"] = num_overlap
    if chunk_size is not None:
        defaults["chunk_size"] = chunk_size
    if normalize is not None:
        defaults["normalize"] = normalize
    return defaults


def model_to_dict(entry: Any, model_dir: str | None = None, include_local_state: bool = True) -> dict[str, Any]:
    from pymss.model_registry import auxiliary_paths_for, config_path_for, model_path_for  # type: ignore

    model_path = model_path_for(entry, model_dir)
    config_path = config_path_for(entry, model_dir)
    auxiliary_paths = auxiliary_paths_for(entry, model_dir)
    required_paths = [model_path]
    if config_path is not None:
        required_paths.append(config_path)
    required_paths.extend(auxiliary_paths)
    missing_paths = [str(path) for path in required_paths if not path.is_file()]
    downloaded = include_local_state and not missing_paths
    return {
        "name": entry.name,
        "aliases": list(entry.aliases),
        "modelType": entry.model_type,
        "architecture": entry.architecture,
        "supported": bool(entry.supported),
        "unsupportedReason": entry.unsupported_reason,
        "category": entry.category_path or entry.primary_category,
        "categoryCn": " / ".join(filter(None, [entry.primary_category_cn, entry.secondary_category_cn])),
        "primaryCategory": entry.primary_category,
        "primaryCategoryCn": entry.primary_category_cn,
        "secondaryCategory": entry.secondary_category,
        "secondaryCategoryCn": entry.secondary_category_cn,
        "targetStem": entry.target_stem,
        "configInstruments": entry.config_instruments,
        "configTargetInstrument": entry.config_target_instrument,
        "classificationConfidence": entry.classification_confidence,
        "classificationBasis": entry.classification_basis,
        "sizeBytes": entry.size_bytes,
        "sha256": entry.sha256,
        "downloaded": downloaded,
        "missingPaths": missing_paths if include_local_state else [],
        "modelPath": str(model_path),
        "configPath": str(config_path) if config_path else None,
        "auxiliaryPaths": [str(path) for path in auxiliary_paths],
        "defaultInferenceParams": resolve_default_inference_params(entry, model_path, config_path),
    }


def cmd_health() -> int:
    emit("health", {"ok": True, "workerVersion": WORKER_VERSION})
    return 0


def cmd_env_info() -> int:
    payload: dict[str, Any] = {
        "pythonVersion": sys.version.split()[0],
        "platform": platform.platform(),
        "workerVersion": WORKER_VERSION,
        "pymssAvailable": False,
        "pymssPath": None,
        "torchAvailable": False,
        "torchVersion": None,
        "cudaAvailable": False,
        "cudaDeviceCount": 0,
        "cudaDevices": [],
        "mpsAvailable": False,
        "mlxAvailable": import_available("mlx"),
        "avAvailable": import_available("av"),
        "librosaAvailable": import_available("librosa"),
    }

    try:
        import pymss  # type: ignore
        payload["pymssAvailable"] = True
        payload["pymssPath"] = str(Path(pymss.__file__).resolve()) if getattr(pymss, "__file__", None) else None
    except Exception as exc:
        payload["pymssError"] = str(exc)

    try:
        import torch  # type: ignore
        payload["torchAvailable"] = True
        payload["torchVersion"] = getattr(torch, "__version__", None)
        payload["cudaAvailable"] = bool(torch.cuda.is_available())
        payload["cudaDeviceCount"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        cuda_devices: list[dict[str, Any]] = []
        if torch.cuda.is_available():
            for index in range(int(torch.cuda.device_count())):
                item: dict[str, Any] = {"id": index, "name": torch.cuda.get_device_name(index)}
                try:
                    props = torch.cuda.get_device_properties(index)
                    item["totalMemoryBytes"] = int(getattr(props, "total_memory", 0) or 0)
                    item["major"] = int(getattr(props, "major", 0) or 0)
                    item["minor"] = int(getattr(props, "minor", 0) or 0)
                except Exception:
                    pass
                cuda_devices.append(item)
        payload["cudaDevices"] = cuda_devices
        mps = getattr(torch.backends, "mps", None)
        payload["mpsAvailable"] = bool(mps and mps.is_available())
    except Exception as exc:
        payload["torchError"] = str(exc)

    emit("env_info", payload)
    return 0


def cmd_list_models(payload: dict[str, Any]) -> int:
    try:
        from pymss.model_registry import list_models, model_root  # type: ignore
    except Exception as exc:
        return emit_error("PYMSS_IMPORT_FAILED", str(exc), traceback.format_exc())

    category = payload.get("category") or None
    supported_only = bool(payload.get("supportedOnly", True))
    include_local_state = bool(payload.get("includeLocalState", True))
    model_dir = payload.get("modelDir") or None

    entries = list_models(category=category, supported=True if supported_only else None)
    models = [model_to_dict(entry, model_dir, include_local_state) for entry in entries]
    category_pairs = sorted({
        (m["category"], m.get("categoryCn") or m["category"])
        for m in models
        if m.get("category")
    }, key=lambda item: item[1] or item[0])
    emit("models", {
        "models": models,
        "categories": [item[0] for item in category_pairs],
        "categoriesCn": [item[1] for item in category_pairs],
        "count": len(models),
        "modelDir": str(model_root(model_dir)),
    })
    return 0


def cmd_model_info(payload: dict[str, Any]) -> int:
    model_name = payload.get("model")
    if not model_name:
        return emit_error("MODEL_NOT_FOUND", "Missing model name")
    try:
        from pymss.model_registry import get_model_entry  # type: ignore
        entry = get_model_entry(model_name)
    except KeyError as exc:
        return emit_error("MODEL_NOT_FOUND", str(exc))
    except Exception as exc:
        return emit_error("PYMSS_IMPORT_FAILED", str(exc), traceback.format_exc())

    model_dir = payload.get("modelDir") or None
    emit("model_info", model_to_dict(entry, model_dir, include_local_state=True))
    return 0


def cmd_delete_model(payload: dict[str, Any]) -> int:
    task_id = payload.get("taskId") or None
    model_name = payload.get("model")
    if not model_name:
        emit("model_delete_failed", {
            "model": "",
            "deleted": [],
            "errors": ["Missing model name"],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": "Missing model name",
        }, task_id=task_id)
        return 1

    model_dir = payload.get("modelDir") or None

    try:
        from pymss.model_registry import (  # type: ignore
            auxiliary_paths_for,
            config_path_for,
            get_model_entry,
            model_path_for,
        )
    except Exception as exc:
        emit("model_delete_failed", {
            "model": model_name,
            "deleted": [],
            "errors": [str(exc)],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": str(exc),
        }, task_id=task_id)
        return 1

    try:
        entry = get_model_entry(model_name)
    except KeyError as exc:
        emit("model_delete_failed", {
            "model": model_name,
            "deleted": [],
            "errors": [str(exc)],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": str(exc),
        }, task_id=task_id)
        return 1

    model_path = model_path_for(entry, model_dir)
    config_path = config_path_for(entry, model_dir)
    auxiliary_paths = auxiliary_paths_for(entry, model_dir)

    all_paths = [model_path]
    if config_path is not None:
        all_paths.append(config_path)
    all_paths.extend(auxiliary_paths)

    if task_id is None:
        deleted: list[str] = []
        errors: list[str] = []
        for path in all_paths:
            if not path.is_file():
                continue
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                errors.append(f"{path}: {exc}")
        emit("model_deleted", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        })
        return 0

    existing_paths = [path for path in all_paths if path.is_file()]
    total_files = len(existing_paths)
    deleted: list[str] = []
    errors: list[str] = []

    emit("model_delete_started", {
        "model": entry.name,
        "totalFiles": total_files,
        "completedFiles": 0,
        "progress": 0,
        "message": "Deleting model files",
    }, task_id=task_id)

    try:
        for index, path in enumerate(existing_paths, start=1):
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                detail = f"{path}: {exc}"
                errors.append(detail)
                emit("model_delete_failed", {
                    "model": entry.name,
                    "deleted": deleted,
                    "errors": errors,
                    "path": str(path),
                    "completedFiles": len(deleted),
                    "totalFiles": total_files,
                    "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
                    "message": str(exc),
                    "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
                }, task_id=task_id)
                return 1

            emit("model_delete_progress", {
                "model": entry.name,
                "path": str(path),
                "completedFiles": index,
                "totalFiles": total_files,
                "progress": int((index / total_files) * 100) if total_files > 0 else 100,
                "message": "Deleting model files",
            }, task_id=task_id)

        emit("model_delete_done", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "completedFiles": total_files,
            "totalFiles": total_files,
            "progress": 100,
            "message": "Deleting model files",
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        }, task_id=task_id)
        return 0
    except Exception as exc:
        errors.append(str(exc))
        emit("model_delete_failed", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "completedFiles": len(deleted),
            "totalFiles": total_files,
            "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
            "message": str(exc),
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        }, task_id=task_id)
        return 1


def _path_size(path: Path) -> int:
    try:
        if path.is_file():
            return int(path.stat().st_size)
        if path.is_dir():
            return sum(_path_size(child) for child in path.rglob("*") if child.is_file())
    except Exception:
        return 0
    return 0


def _normalized_path_key(path: Path) -> str:
    return os.path.normcase(str(path.absolute()))


def _scan_root_file_sizes(root: Path) -> dict[str, tuple[Path, int]]:
    scanned: dict[str, tuple[Path, int]] = {}
    if not root.exists():
        return scanned
    for dirpath, _, filenames in os.walk(root):
        base = Path(dirpath)
        for filename in filenames:
            file_path = base / filename
            try:
                size = int(file_path.stat().st_size)
            except Exception:
                continue
            scanned[_normalized_path_key(file_path)] = (file_path, size)
    return scanned


def _required_model_paths(entry: Any, model_dir: str | None) -> list[Path]:
    from pymss.model_registry import auxiliary_paths_for, config_path_for, model_path_for  # type: ignore

    paths = [model_path_for(entry, model_dir)]
    config = config_path_for(entry, model_dir)
    if config is not None:
        paths.append(config)
    paths.extend(auxiliary_paths_for(entry, model_dir))
    return paths


def _storage_summary_payload(model_dir: str | None = None) -> dict[str, Any]:
    from pymss.model_registry import list_models, model_root  # type: ignore

    root = model_root(model_dir)
    scanned_files = _scan_root_file_sizes(root)
    known_file_keys: set[str] = set()
    models: list[dict[str, Any]] = []
    total_bytes = 0
    downloaded_count = 0

    for entry in list_models(supported=None):
        required_paths = _required_model_paths(entry, model_dir)
        files = []
        model_size = 0
        downloaded = True
        for path in required_paths:
            normalized_key = _normalized_path_key(path)
            known_file_keys.add(normalized_key)
            scanned = scanned_files.get(normalized_key)
            if scanned is not None:
                exists = True
                size = scanned[1]
            elif path.is_file():
                exists = True
                size = _path_size(path)
            else:
                exists = False
                size = 0
            if not exists:
                downloaded = False
            model_size += size
            files.append({"path": str(path), "sizeBytes": size, "exists": exists})
        if downloaded:
            downloaded_count += 1
        if model_size > 0:
            total_bytes += model_size
        models.append({
            "name": entry.name,
            "downloaded": downloaded,
            "sizeBytes": model_size,
            "expectedSizeBytes": entry.size_bytes,
            "files": files,
        })

    residual_files: list[dict[str, Any]] = []
    residual_bytes = 0
    for normalized_key, (file_path, size) in scanned_files.items():
        if normalized_key in known_file_keys:
            continue
        residual_files.append({"path": str(file_path), "sizeBytes": size})
        residual_bytes += size

    residual_files.sort(key=lambda item: item["sizeBytes"], reverse=True)
    models.sort(key=lambda item: item["sizeBytes"], reverse=True)
    return {
        "modelDir": str(root),
        "totalBytes": total_bytes,
        "downloadedCount": downloaded_count,
        "models": models,
        "residualFiles": residual_files,
        "residualBytes": residual_bytes,
    }


def cmd_model_storage_summary(payload: dict[str, Any]) -> int:
    model_dir = payload.get("modelDir") or None
    try:
        emit("model_storage_summary", _storage_summary_payload(model_dir))
        return 0
    except Exception as exc:
        return emit_error("MODEL_STORAGE_SUMMARY_FAILED", str(exc), traceback.format_exc())


def cmd_cleanup_model_residual_files(payload: dict[str, Any]) -> int:
    model_dir = payload.get("modelDir") or None
    task_id = payload.get("taskId") or None
    try:
        summary = _storage_summary_payload(model_dir)
        if task_id is None:
            deleted: list[str] = []
            errors: list[str] = []
            for item in summary.get("residualFiles", []):
                path = Path(item.get("path", ""))
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    deleted.append(str(path))
                except Exception as exc:
                    errors.append(f"{path}: {exc}")
            emit("model_residual_cleaned", {
                "deleted": deleted,
                "errors": errors,
                "modelStorageSummary": _storage_summary_payload(model_dir),
            })
            return 0
        residual_items = [item for item in summary.get("residualFiles", []) if Path(item.get("path", "")).is_file()]
        total_files = len(residual_items)
        deleted: list[str] = []
        errors: list[str] = []

        emit("model_residual_cleanup_started", {
            "totalFiles": total_files,
            "completedFiles": 0,
            "progress": 0,
            "message": "Cleaning residual files",
        }, task_id=task_id)

        for index, item in enumerate(residual_items, start=1):
            path = Path(item.get("path", ""))
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                detail = f"{path}: {exc}"
                errors.append(detail)
                emit("model_residual_cleanup_failed", {
                    "deleted": deleted,
                    "errors": errors,
                    "path": str(path),
                    "completedFiles": len(deleted),
                    "totalFiles": total_files,
                    "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
                    "message": str(exc),
                    "modelStorageSummary": _storage_summary_payload(model_dir),
                }, task_id=task_id)
                return 1
            emit("model_residual_cleanup_progress", {
                "path": str(path),
                "completedFiles": index,
                "totalFiles": total_files,
                "progress": int((index / total_files) * 100) if total_files > 0 else 100,
                "message": "Cleaning residual files",
            }, task_id=task_id)
        next_summary = _storage_summary_payload(model_dir)
        emit("model_residual_cleanup_done", {
            "deleted": deleted,
            "errors": errors,
            "completedFiles": total_files,
            "totalFiles": total_files,
            "progress": 100,
            "message": "Cleaning residual files",
            "modelStorageSummary": next_summary,
        }, task_id=task_id)
        return 0
    except Exception as exc:
        emit("model_residual_cleanup_failed", {
            "deleted": [],
            "errors": [str(exc)],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": str(exc),
        }, task_id=task_id)
        return 1


_ARIA2_PROGRESS_PATTERN = re.compile(
    r"\[#.*?\s+(?P<downloaded>[\d.]+\s*[KMGTPE]?i?B|[\d.]+\s*B)/(?P<total>[\d.]+\s*[KMGTPE]?i?B|[\d.]+\s*B)\((?P<percent>\d+)%\).*?DL:(?P<speed>[\d.]+\s*[KMGTPE]?i?B/s|[\d.]+\s*B/s)",
    re.IGNORECASE,
)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_human_bytes(value: str | None) -> int:
    if not value:
        return 0
    text = str(value).strip().replace(" ", "")
    match = re.fullmatch(r"(?P<number>\d+(?:\.\d+)?)(?P<unit>[KMGTPE]?i?B|B)(?:/s)?", text, re.IGNORECASE)
    if not match:
        return 0
    number = float(match.group("number"))
    unit = match.group("unit").upper()
    scale_map = {
        "B": 1,
        "KIB": 1024,
        "MIB": 1024**2,
        "GIB": 1024**3,
        "TIB": 1024**4,
        "PIB": 1024**5,
        "EIB": 1024**6,
        "KB": 1000,
        "MB": 1000**2,
        "GB": 1000**3,
        "TB": 1000**4,
        "PB": 1000**5,
        "EB": 1000**6,
    }
    return int(number * scale_map.get(unit, 1))


def _parse_aria2_progress_line(line: str) -> dict[str, int | float] | None:
    match = _ARIA2_PROGRESS_PATTERN.search(line or "")
    if not match:
        return None
    downloaded_bytes = _parse_human_bytes(match.group("downloaded"))
    total_bytes = _parse_human_bytes(match.group("total"))
    speed_bytes = _parse_human_bytes(match.group("speed"))
    percent = _safe_int(match.group("percent"))
    if total_bytes <= 0 and downloaded_bytes > 0 and percent > 0:
        total_bytes = int(downloaded_bytes / max(percent / 100.0, 0.01))
    return {
        "downloaded_bytes": downloaded_bytes,
        "total_bytes": total_bytes,
        "speed_bytes_per_second": float(speed_bytes),
        "percent": percent,
    }


def _emit_download_progress_payload(
    callback: Any,
    *,
    event: str,
    path: Path,
    file_index: int,
    total_files: int,
    completed_files: int,
    downloaded_bytes: int,
    total_bytes: int,
    speed_bytes_per_second: float = 0.0,
) -> None:
    callback({
        "event": event,
        "path": str(path),
        "file_index": file_index,
        "total_files": total_files,
        "completed_files": completed_files,
        "downloaded_bytes": max(0, downloaded_bytes),
        "total_bytes": max(0, total_bytes),
        "speed_bytes_per_second": max(0.0, float(speed_bytes_per_second or 0.0)),
    })


def _download_file_with_progress_urllib(
    *,
    url: str,
    dest: Path,
    expected_size: int | None,
    expected_sha256: str,
    timeout: int,
    file_index: int,
    total_files: int,
    completed_before: int,
    progress_callback: Any,
    cleanup_partial_download: Any,
    validate_downloaded_file: Any,
) -> Path:
    tmp = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            total_bytes = _safe_int(response.headers.get("content-length")) or (expected_size or 0)
            downloaded_bytes = 0
            _emit_download_progress_payload(
                progress_callback,
                event="file_start",
                path=dest,
                file_index=file_index,
                total_files=total_files,
                completed_files=completed_before,
                downloaded_bytes=0,
                total_bytes=total_bytes,
            )
            with open(tmp, "wb") as file_obj:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    file_obj.write(chunk)
                    downloaded_bytes += len(chunk)
                    _emit_download_progress_payload(
                        progress_callback,
                        event="file_progress",
                        path=dest,
                        file_index=file_index,
                        total_files=total_files,
                        completed_files=completed_before,
                        downloaded_bytes=downloaded_bytes,
                        total_bytes=total_bytes,
                    )
        validate_downloaded_file(tmp, dest, expected_size, expected_sha256)
        os.replace(tmp, dest)
        final_total = expected_size or downloaded_bytes or (dest.stat().st_size if dest.is_file() else 0)
        _emit_download_progress_payload(
            progress_callback,
            event="file_done",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before + 1,
            downloaded_bytes=final_total,
            total_bytes=final_total,
        )
        return dest
    except Exception:
        cleanup_partial_download(tmp)
        raise


def _download_file_with_progress_aria2(
    *,
    aria2c_path: str,
    url: str,
    dest: Path,
    expected_size: int | None,
    expected_sha256: str,
    timeout: int,
    file_index: int,
    total_files: int,
    completed_before: int,
    progress_callback: Any,
    cleanup_partial_download: Any,
    validate_downloaded_file: Any,
) -> Path:
    tmp = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        aria2c_path,
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--continue=true",
        "--console-log-level=notice",
        "--show-console-readout=true",
        "--summary-interval=1",
        "--max-connection-per-server=16",
        "--split=16",
        "--min-split-size=1M",
        "--max-tries=3",
        f"--connect-timeout={timeout}",
        f"--timeout={timeout}",
        "--dir",
        str(tmp.parent),
        "--out",
        tmp.name,
        url,
    ]
    process = None
    last_downloaded = 0
    last_total = expected_size or 0
    last_speed = 0.0
    try:
        _emit_download_progress_payload(
            progress_callback,
            event="file_start",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before,
            downloaded_bytes=0,
            total_bytes=last_total,
        )
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        if process.stdout is not None:
            for raw_line in process.stdout:
                parsed = _parse_aria2_progress_line(raw_line)
                if parsed is None:
                    continue
                last_downloaded = max(last_downloaded, _safe_int(parsed.get("downloaded_bytes")))
                last_total = max(last_total, _safe_int(parsed.get("total_bytes")))
                last_speed = float(parsed.get("speed_bytes_per_second") or last_speed or 0.0)
                _emit_download_progress_payload(
                    progress_callback,
                    event="file_progress",
                    path=dest,
                    file_index=file_index,
                    total_files=total_files,
                    completed_files=completed_before,
                    downloaded_bytes=last_downloaded,
                    total_bytes=last_total,
                    speed_bytes_per_second=last_speed,
                )
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"aria2c failed with exit code {return_code}")
        if not tmp.is_file():
            raise RuntimeError("aria2c did not create the expected output file")

        validate_downloaded_file(tmp, dest, expected_size, expected_sha256)
        os.replace(tmp, dest)
        final_total = expected_size or last_total or int(dest.stat().st_size)
        final_downloaded = final_total or last_downloaded
        _emit_download_progress_payload(
            progress_callback,
            event="file_done",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before + 1,
            downloaded_bytes=final_downloaded,
            total_bytes=final_total,
            speed_bytes_per_second=last_speed,
        )
        return dest
    except Exception:
        cleanup_partial_download(tmp)
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=2)
            except Exception:
                pass
        raise


def _download_model_with_observed_progress(
    *,
    entry: Any,
    model_dir: str | None,
    source: str,
    endpoint: str | None,
    force: bool,
    timeout: int,
    progress_callback: Any,
) -> dict[str, Any]:
    from pymss.model_download import (  # type: ignore
        ARIA2C_PATH,
        DownloadError,
        DownloadValidationError,
        _already_valid,
        _cleanup_partial_download,
        _expected_size_and_hash,
        _validate_downloaded_file,
        fetch_modelscope_file_index,
        files_for_model,
        remote_url,
    )

    _, files = files_for_model(entry.name, model_dir)
    total_files = max(1, len(files))
    source_index = fetch_modelscope_file_index(timeout=timeout) if endpoint is None else None
    downloaded: list[str] = []
    skipped: list[str] = []
    completed_files = 0

    for file_index, (relpath, dest) in enumerate(files, start=1):
        expected_size, expected_sha256 = _expected_size_and_hash(relpath, source_index)
        if not force and _already_valid(dest, expected_size, expected_sha256):
            completed_files += 1
            size_bytes = expected_size or (int(dest.stat().st_size) if dest.is_file() else 0)
            _emit_download_progress_payload(
                progress_callback,
                event="file_skipped",
                path=dest,
                file_index=file_index,
                total_files=total_files,
                completed_files=completed_files,
                downloaded_bytes=size_bytes,
                total_bytes=size_bytes,
            )
            skipped.append(str(dest))
            continue

        url = remote_url(relpath, source=source, endpoint=endpoint)
        tmp = dest.with_name(dest.name + ".part")
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                if ARIA2C_PATH:
                    _download_file_with_progress_aria2(
                        aria2c_path=ARIA2C_PATH,
                        url=url,
                        dest=dest,
                        expected_size=expected_size,
                        expected_sha256=expected_sha256,
                        timeout=timeout,
                        file_index=file_index,
                        total_files=total_files,
                        completed_before=completed_files,
                        progress_callback=progress_callback,
                        cleanup_partial_download=_cleanup_partial_download,
                        validate_downloaded_file=_validate_downloaded_file,
                    )
                else:
                    _download_file_with_progress_urllib(
                        url=url,
                        dest=dest,
                        expected_size=expected_size,
                        expected_sha256=expected_sha256,
                        timeout=timeout,
                        file_index=file_index,
                        total_files=total_files,
                        completed_before=completed_files,
                        progress_callback=progress_callback,
                        cleanup_partial_download=_cleanup_partial_download,
                        validate_downloaded_file=_validate_downloaded_file,
                    )
                last_error = None
                break
            except (
                OSError,
                urllib.error.URLError,
                urllib.error.HTTPError,
                RuntimeError,
                DownloadError,
            ) as exc:
                last_error = exc
                if (not ARIA2C_PATH) or isinstance(exc, DownloadValidationError):
                    _cleanup_partial_download(tmp)
                if attempt < 2:
                    time.sleep(1.0 + attempt)
        if last_error is not None:
            raise DownloadError(f"failed to download {url}: {last_error}")
        completed_files += 1
        downloaded.append(str(dest))

    return {"entry": entry, "downloaded": downloaded, "skipped": skipped}


def cmd_download_model(payload: dict[str, Any]) -> int:
    model_name = payload.get("model")
    if not model_name:
        return emit_error("MODEL_NOT_FOUND", "Missing model name")

    task_id = payload.get("taskId") or f"download_{model_name}"
    model_dir = payload.get("modelDir") or None
    source = payload.get("source") or "modelscope"
    endpoint = payload.get("endpoint") or None
    force = bool(payload.get("force", False))
    timeout = _safe_int(payload.get("timeout"), 30)

    try:
        from pymss.model_registry import get_model_entry, model_root  # type: ignore
    except Exception as exc:
        return emit_error("PYMSS_IMPORT_FAILED", str(exc), traceback.format_exc(), task_id=task_id)

    try:
        entry = get_model_entry(model_name)
        local_state = model_to_dict(entry, model_dir, include_local_state=True)
        missing_before = local_state.get("missingPaths", [])
        total_files = max(1, len(missing_before))
        total_bytes = 0
        download_progress_state: dict[str, dict[str, Any]] = {}
        emit("download_started", {
            "model": entry.name,
            "source": source,
            "force": force,
            "totalFiles": total_files,
            "completedFiles": 0,
            "progress": 0,
        }, task_id=task_id)
        emit("download_stage", {"stage": "resolving_files", "progress": 5}, task_id=task_id)

        def emit_download_progress(progress_payload: dict[str, Any]) -> None:
            nonlocal total_files, total_bytes
            event_name = progress_payload.get("event")
            file_path = str(progress_payload.get("path") or "")
            total_files = max(total_files, int(progress_payload.get("total_files") or total_files or 1))
            file_total = int(progress_payload.get("total_bytes") or 0)
            file_downloaded = int(progress_payload.get("downloaded_bytes") or 0)
            completed_files = int(progress_payload.get("completed_files") or 0)
            speed = float(progress_payload.get("speed_bytes_per_second") or 0.0)

            previous = download_progress_state.get(file_path) or {"downloaded": 0, "total": 0}
            download_progress_state[file_path] = {
                "downloaded": file_downloaded,
                "total": file_total,
            }
            known_total = sum(int(item.get("total") or 0) for item in download_progress_state.values())
            downloaded_sum = sum(int(item.get("downloaded") or 0) for item in download_progress_state.values())
            total_bytes = max(total_bytes, known_total)

            if total_bytes > 0:
                progress = min(95, max(8, int(downloaded_sum / total_bytes * 95)))
            else:
                progress = min(95, max(8, int((completed_files / max(1, total_files)) * 95)))

            if event_name == "file_skipped":
                emit("download_file", {
                    "status": "skipped",
                    "path": file_path,
                    "completedFiles": completed_files,
                    "totalFiles": total_files,
                    "downloadedBytes": file_total,
                    "totalBytes": file_total,
                    "aggregateDownloadedBytes": downloaded_sum,
                    "aggregateTotalBytes": total_bytes,
                    "speedBytesPerSecond": 0,
                    "progress": progress,
                }, task_id=task_id)
                return

            if event_name in {"file_start", "file_progress", "file_done"}:
                emit("download_progress", {
                    "path": file_path,
                    "fileIndex": int(progress_payload.get("file_index") or 0),
                    "completedFiles": completed_files,
                    "totalFiles": total_files,
                    "downloadedBytes": file_downloaded,
                    "totalBytes": file_total,
                    "aggregateDownloadedBytes": downloaded_sum,
                    "aggregateTotalBytes": total_bytes,
                    "speedBytesPerSecond": speed,
                    "progress": progress,
                }, task_id=task_id)
                if event_name == "file_done":
                    emit("download_file", {
                        "status": "downloaded",
                        "path": file_path,
                        "completedFiles": completed_files,
                        "totalFiles": total_files,
                        "downloadedBytes": file_total,
                        "totalBytes": file_total,
                        "aggregateDownloadedBytes": downloaded_sum,
                        "aggregateTotalBytes": total_bytes,
                        "speedBytesPerSecond": speed,
                        "progress": progress,
                    }, task_id=task_id)

        emit("download_stage", {
            "stage": "downloading_files",
            "progress": 15,
            "message": "Downloading model files",
        }, task_id=task_id)
        result = _download_model_with_observed_progress(
            entry=entry,
            model_dir=model_dir,
            source=source,
            endpoint=endpoint,
            force=force,
            timeout=timeout,
            progress_callback=emit_download_progress,
        )
        files = [(file_path, "skipped") for file_path in result.get("skipped", [])]
        files.extend((file_path, "downloaded") for file_path in result.get("downloaded", []))
        total_files = max(total_files, len(files) or 1)
        emit("download_done", {
            "model": entry.name,
            "downloaded": result.get("downloaded", []),
            "skipped": result.get("skipped", []),
            "modelDir": str(model_root(model_dir)),
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
            "progress": 100,
        }, task_id=task_id)
        return 0
    except KeyError as exc:
        return emit_error("MODEL_NOT_FOUND", str(exc), task_id=task_id)
    except Exception as exc:
        return emit_error("MODEL_DOWNLOAD_FAILED", str(exc), traceback.format_exc(), task_id=task_id)


class JsonLogHandler:
    def __init__(self, task_id: str):
        import logging
        self.task_id = task_id
        self.level = logging.INFO

    def setLevel(self, level: int) -> None:
        self.level = level

    def handle(self, record: Any) -> bool:
        if record.levelno < self.level:
            return False
        emit("task_log", {"level": record.levelname.lower(), "message": record.getMessage()}, task_id=self.task_id)
        return True


def collect_outputs(output_dir: str, success_files: list[str], output_format: str) -> list[dict[str, str]]:
    base = Path(output_dir)
    outputs: list[dict[str, str]] = []
    if not base.exists():
        return outputs
    success_stems = {Path(name).stem for name in success_files}
    for path in base.rglob(f"*.{output_format.lower()}"):
        if success_stems and not any(path.stem.startswith(stem + "_") or path.stem == stem for stem in success_stems):
            continue
        stem = path.stem.split("_")[-1] if "_" in path.stem else path.stem
        outputs.append({"stem": stem, "path": str(path)})
    return outputs


def normalize_inference_params(payload_params: Any, version: Any = None) -> dict[str, Any]:
    if not isinstance(payload_params, dict):
        return {}

    params = dict(payload_params)
    try:
        version_value = int(version) if version is not None else None
    except (TypeError, ValueError):
        version_value = None

    if version_value is not None and version_value >= 2:
        if params.get("standardize") in {"", "default"}:
            params.pop("standardize", None)
        if params.get("normalize") in {"", "default"}:
            params.pop("normalize", None)
        return params

    # Legacy desktop tasks used `normalize` for input standardization and did not
    # send the new output-normalize flag separately. If `standardize` is absent,
    # treat the historical `normalize` field as the old input standardization
    # switch and default the new output normalize to False.
    if "standardize" not in params and "normalize" in params:
        legacy_standardize = params.pop("normalize")
        params["standardize"] = legacy_standardize
        params["normalize"] = False
        return params

    if "standardize" in params and "normalize" not in params:
        params["normalize"] = False
    elif "standardize" not in params and "normalize" not in params:
        params["standardize"] = True
        params["normalize"] = False
    return params


def _sanitize_runtime_inference_params(params: dict[str, Any]) -> dict[str, Any]:
    next_params = dict(params or {})

    def _drop_non_positive_int(key: str) -> None:
        if key not in next_params:
            return
        value = _as_int(next_params.get(key))
        if value is None or value <= 0:
            next_params.pop(key, None)
            return
        next_params[key] = value

    for numeric_key in ("batch_size", "overlap_size", "num_overlap", "chunk_size", "window_size"):
        _drop_non_positive_int(numeric_key)

    if "aggression" in next_params:
        aggression_value = _as_int(next_params.get("aggression"))
        if aggression_value is None or aggression_value < 0:
            next_params.pop("aggression", None)
        else:
            next_params["aggression"] = aggression_value

    if "post_process_threshold" in next_params:
        threshold_value = _as_float(next_params.get("post_process_threshold"))
        if threshold_value is None or threshold_value < 0:
            next_params.pop("post_process_threshold", None)
        else:
            next_params["post_process_threshold"] = threshold_value

    for bool_key in ("enable_post_process", "high_end_process", "standardize", "normalize"):
        if bool_key not in next_params:
            continue
        bool_value = _as_bool(next_params.get(bool_key))
        if bool_value is None:
            next_params.pop(bool_key, None)
        else:
            next_params[bool_key] = bool_value

    return next_params



def _enrich_inference_params_for_model(
    *,
    model_type: str | None,
    config_path: str | None,
    inference_params: dict[str, Any],
) -> dict[str, Any]:
    params = _sanitize_runtime_inference_params(inference_params)
    normalized_model_type = str(model_type or '').strip().lower()
    if normalized_model_type == 'vr':
        params.pop('num_overlap', None)
        return params
    if normalized_model_type == 'apollo':
        params.pop('num_overlap', None)
        return params
    if not config_path or not Path(config_path).is_file():
        params.pop('num_overlap', None)
        return params

    try:
        from pymss.config import load_config, to_plain  # type: ignore

        config = to_plain(load_config(str(config_path)))
    except Exception:
        params.pop('num_overlap', None)
        return params

    inference = config.get('inference') if isinstance(config, dict) else None
    audio = config.get('audio') if isinstance(config, dict) else None
    inference = inference if isinstance(inference, dict) else {}
    audio = audio if isinstance(audio, dict) else {}

    explicit_overlap_size = _as_int(params.get('overlap_size'))
    explicit_num_overlap = _as_int(params.get('num_overlap'))
    config_overlap_size = _as_int(inference.get('overlap_size'))
    config_num_overlap = _as_int(inference.get('num_overlap'))
    chunk_size = _as_int(params.get('chunk_size'))
    if chunk_size is None:
        chunk_size = _as_int(audio.get('chunk_size'))
    if chunk_size is None:
        chunk_size = _as_int(inference.get('chunk_size'))

    if explicit_overlap_size is None:
        derived_overlap_size: int | None = None
        if explicit_num_overlap is not None:
            derived_overlap_size = _derive_overlap_size_from_num_overlap(chunk_size, explicit_num_overlap)
        elif config_overlap_size is None and config_num_overlap is not None:
            derived_overlap_size = _derive_overlap_size_from_num_overlap(chunk_size, config_num_overlap)
        if derived_overlap_size is not None:
            params['overlap_size'] = derived_overlap_size

    params.pop('num_overlap', None)
    return params



def normalize_audio_params(payload_audio_params: Any) -> dict[str, Any]:
    defaults = {
        "wav_bit_depth": "FLOAT",
        "flac_bit_depth": "PCM_24",
        "mp3_bit_rate": "320k",
        "m4a_bit_rate": "512k",
        "m4a_codec": "aac",
        "m4a_aac_at_quality": 2,
    }
    if not isinstance(payload_audio_params, dict):
        return defaults
    normalized = {
        **defaults,
        **payload_audio_params,
    }
    normalized["m4a_codec"] = "aac" if str(normalized.get("m4a_codec") or "").strip().lower() == "aac" else "aac"
    return normalized


def _audio_metadata(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    try:
        import av  # type: ignore
        with av.open(str(path)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise RuntimeError("No audio stream found")
            duration = 0.0
            if stream.duration is not None and stream.time_base is not None:
                duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                duration = float(container.duration / av.time_base)
            sample_rate = int(getattr(stream.codec_context, "sample_rate", 0) or 0)
            channels = int(getattr(stream.codec_context, "channels", 0) or 0)
            return {
                "path": str(path),
                "name": path.name,
                "duration": max(0.0, duration),
                "sampleRate": sample_rate,
                "channels": channels,
            }
    except Exception:
        try:
            import soundfile as sf  # type: ignore
            with sf.SoundFile(str(path)) as audio_file:
                frames = int(audio_file.frames)
                sample_rate = int(audio_file.samplerate)
                duration = frames / sample_rate if sample_rate else 0.0
                return {
                    "path": str(path),
                    "name": path.name,
                    "duration": max(0.0, duration),
                    "sampleRate": sample_rate,
                    "channels": int(audio_file.channels),
                }
        except Exception:
            raise


def _load_audio_mono(path: Path, sample_rate: int = 8000) -> tuple[Any, int]:
    import librosa  # type: ignore

    audio, sr = librosa.load(str(path), sr=sample_rate, mono=True)
    return audio, int(sr)


def _waveform_peaks_soundfile(path: Path, resolution: int) -> tuple[list[float], dict[str, Any]]:
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    with sf.SoundFile(str(path)) as audio_file:
        frames = int(audio_file.frames)
        sample_rate = int(audio_file.samplerate)
        channels = int(audio_file.channels)
        duration = frames / sample_rate if sample_rate else 0.0
        bucket = max(1, math.ceil(max(1, frames) / max(1, resolution)))
        peaks: list[float] = []
        while True:
            block = audio_file.read(bucket, dtype="float32", always_2d=True)
            if block.size == 0:
                break
            peak = float(np.max(np.abs(block))) if block.size else 0.0
            peaks.append(round(peak, 5))
    return peaks, {
        "path": str(path),
        "name": path.name,
        "duration": max(0.0, duration),
        "sampleRate": sample_rate,
        "channels": channels,
    }


def _resample_audio(audio: Any, source_rate: int, target_rate: int) -> Any:
    if source_rate == target_rate:
        return audio
    import librosa  # type: ignore

    return librosa.resample(audio, orig_sr=source_rate, target_sr=target_rate)


def _read_audio(path: Path, target_rate: int | None = None) -> tuple[Any, int]:
    import librosa  # type: ignore

    audio, sr = librosa.load(str(path), sr=target_rate, mono=False)
    import numpy as np  # type: ignore

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio.reshape(1, -1)
    return audio, int(sr)


def _equal_power_fade(length: int, fade_in: bool) -> Any:
    import numpy as np  # type: ignore

    if length <= 0:
        return np.ones((0,), dtype=np.float32)
    curve = np.linspace(0.0, 1.0, num=length, endpoint=True, dtype=np.float32)
    curve = np.sin(curve * math.pi / 2.0)
    return curve if fade_in else curve[::-1]


def _apply_stereo_pan(audio: Any, pan: float) -> Any:
    import numpy as np  # type: ignore

    normalized = max(-1.0, min(1.0, float(pan or 0.0)))
    if abs(normalized) <= 1e-6:
        return audio

    if audio.ndim == 1:
        audio = audio.reshape(1, -1)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)

    left_gain = 1.0 if normalized <= 0 else 1.0 - normalized
    right_gain = 1.0 if normalized >= 0 else 1.0 + normalized

    output = audio.copy()
    output[0] *= left_gain
    output[1] *= right_gain
    return output


def cmd_audio_metadata(payload: dict[str, Any]) -> int:
    path = payload.get("path")
    if not path:
        return emit_error("AUDIO_METADATA_FAILED", "Missing audio path")
    try:
        emit("audio_metadata", _audio_metadata(Path(path)))
        return 0
    except Exception as exc:
        return emit_error("AUDIO_METADATA_FAILED", str(exc), traceback.format_exc())


def cmd_waveform_peaks(payload: dict[str, Any]) -> int:
    path_value = payload.get("path")
    if not path_value:
        return emit_error("WAVEFORM_PEAKS_FAILED", "Missing audio path")
    path = Path(path_value)
    resolution = int(payload.get("resolution") or 1400)
    resolution = max(80, min(12000, resolution))
    cache_dir = Path(payload.get("cacheDir") or path.parent / ".pymss-peaks")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha1(str(path.resolve()).encode("utf-8", errors="replace")).hexdigest()[:16]
    cache_name = f"{path.stem}_{cache_key}_{resolution}.json"
    peaks_path = cache_dir / cache_name
    try:
        if peaks_path.is_file() and peaks_path.stat().st_mtime >= path.stat().st_mtime:
            data = json.loads(peaks_path.read_text(encoding="utf-8"))
            emit("waveform_peaks", data)
            return 0

        import numpy as np  # type: ignore

        try:
            peaks, metadata = _waveform_peaks_soundfile(path, resolution)
            sr = int(metadata.get("sampleRate") or 0)
        except Exception:
            audio, sr = _load_audio_mono(path)
            total = int(audio.shape[-1])

            def build_peaks(target_resolution: int) -> list[float]:
                if total <= 0 or target_resolution <= 0:
                    return []
                bucket = max(1, math.ceil(total / target_resolution))
                padded = int(math.ceil(total / bucket) * bucket)
                work = audio
                if padded > total:
                    work = np.pad(audio, (0, padded - total))
                shaped = work.reshape(-1, bucket)
                maxima = np.max(np.abs(shaped), axis=1)
                return [round(float(value), 5) for value in maxima]

            peaks = build_peaks(resolution)
            metadata = _audio_metadata(path)

        data = {
            "path": str(path),
            "peaksPath": str(peaks_path),
            "peaks": peaks,
            "resolution": resolution,
            "duration": metadata.get("duration", 0),
            "sampleRate": metadata.get("sampleRate") or sr,
            "channels": metadata.get("channels", 0),
        }
        peaks_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        emit("waveform_peaks", data)
        return 0
    except Exception as exc:
        return emit_error("WAVEFORM_PEAKS_FAILED", str(exc), traceback.format_exc())


def cmd_export_editor_mix(payload: dict[str, Any]) -> int:
    project = payload.get("project") or {}
    export_dir = Path(payload.get("exportDir") or ".")
    output_format = str(payload.get("format") or "wav").lower()
    audio_params = payload.get("audioParams") or {}
    if output_format not in {"wav", "flac", "mp3", "m4a"}:
        output_format = "wav"
    if not project.get("tracks"):
        return emit_error("EDITOR_EXPORT_FAILED", "Project has no tracks")
    try:
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore

        export_dir.mkdir(parents=True, exist_ok=True)

        sources: dict[str, dict[str, Any]] = {}
        for collection_name in ("assets", "sources"):
            for item in project.get(collection_name, []) or []:
                source_id = item.get("id")
                if source_id:
                    sources[str(source_id)] = item

        tracks = project.get("tracks", []) or []
        active_tracks = [
            track for track in tracks
            if not track.get("muted") and (track.get("sourceId") or track.get("clips"))
        ]
        has_solo = any(bool(track.get("solo")) for track in active_tracks)
        rendered_clips: list[tuple[int, Any, int]] = []
        audio_cache: dict[str, tuple[Any, int]] = {}
        target_rate: int | None = None
        total_samples = 0

        def source_for_clip(track: dict[str, Any], clip: dict[str, Any]) -> dict[str, Any] | None:
            source_id = clip.get("assetId") or track.get("sourceId")
            if not source_id:
                return None
            return sources.get(str(source_id))

        def track_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
            clips = track.get("clips")
            if isinstance(clips, list) and clips:
                return [clip for clip in clips if isinstance(clip, dict)]

            source_id = track.get("sourceId")
            source = sources.get(str(source_id)) if source_id else None
            source_duration = float(source.get("duration", 0) or 0) if source else 0.0
            return [{
                "id": f"clip_{track.get('id', 'track')}",
                "assetId": source_id,
                "start": 0,
                "offset": 0,
                "duration": source_duration,
                "volume": 1,
                "fadeIn": track.get("fadeIn", 0),
                "fadeOut": track.get("fadeOut", 0),
                "muted": False,
            }]

        def read_source_audio(source: dict[str, Any]) -> tuple[Any, int] | None:
            nonlocal target_rate
            source_id = str(source.get("id") or source.get("path") or "")
            if source_id in audio_cache:
                return audio_cache[source_id]

            path = Path(source.get("path") or "")
            if not path.is_file():
                return None

            audio, sr = _read_audio(path, target_rate)
            if target_rate is None:
                target_rate = sr
            elif sr != target_rate:
                channels = [_resample_audio(channel, sr, target_rate) for channel in audio]
                audio = np.stack(channels, axis=0).astype(np.float32)
                sr = target_rate
            audio_cache[source_id] = (audio, int(sr))
            return audio_cache[source_id]

        for track in active_tracks:
            if has_solo and not track.get("solo"):
                continue

            track_volume = float(track.get("volume", 1.0) or 0)
            track_pan = float(track.get("pan", 0.0) or 0.0)
            if track_volume <= 0:
                continue

            for clip in track_clips(track):
                if clip.get("muted"):
                    continue

                source = source_for_clip(track, clip)
                if not source:
                    continue

                loaded = read_source_audio(source)
                if loaded is None:
                    continue
                audio, sr = loaded

                start = max(0, int(float(clip.get("start", 0) or 0) * sr))
                offset = max(0, int(float(clip.get("offset", 0) or 0) * sr))
                if offset >= audio.shape[-1]:
                    continue

                clip_duration = float(clip.get("duration", 0) or 0)
                duration_samples = int(clip_duration * sr) if clip_duration > 0 else audio.shape[-1] - offset
                duration_samples = max(0, min(duration_samples, audio.shape[-1] - offset))
                if duration_samples <= 0:
                    continue

                segment = audio[:, offset:offset + duration_samples].copy()
                volume = track_volume * float(clip.get("volume", 1.0) or 0)
                if volume <= 0:
                    continue
                segment *= volume
                segment = _apply_stereo_pan(segment, track_pan)

                fade_in_value = clip.get("fadeIn", track.get("fadeIn", 0))
                fade_out_value = clip.get("fadeOut", track.get("fadeOut", 0))
                fade_in_samples = min(duration_samples, int(float(fade_in_value or 0) * sr))
                fade_out_samples = min(duration_samples, int(float(fade_out_value or 0) * sr))
                if fade_in_samples > 0:
                    segment[:, :fade_in_samples] *= _equal_power_fade(fade_in_samples, True)
                if fade_out_samples > 0:
                    segment[:, -fade_out_samples:] *= _equal_power_fade(fade_out_samples, False)

                rendered_clips.append((start, segment, sr))
                total_samples = max(total_samples, start + segment.shape[-1])

        if not rendered_clips or not target_rate or total_samples <= 0:
            return emit_error("EDITOR_EXPORT_FAILED", "No audible clips to export")

        channels = max(segment.shape[0] for _, segment, _ in rendered_clips)
        mix = np.zeros((channels, total_samples), dtype=np.float32)
        for start, segment, _ in rendered_clips:
            if segment.shape[0] == 1 and channels > 1:
                segment = np.repeat(segment, channels, axis=0)
            elif segment.shape[0] < channels:
                pad = np.zeros((channels - segment.shape[0], segment.shape[-1]), dtype=np.float32)
                segment = np.concatenate([segment, pad], axis=0)
            mix[:, start:start + segment.shape[-1]] += segment[:channels]

        master_volume = float(project.get("masterVolume", 1.0) or 0)
        if master_volume != 1.0:
            mix *= master_volume
        master_pan = float(project.get("masterPan", 0.0) or 0.0)
        mix = _apply_stereo_pan(mix, master_pan)

        peak = float(np.max(np.abs(mix))) if mix.size else 0.0
        if peak > 1.0:
            mix = mix / peak * 0.98

        project_name = str(project.get("name") or project.get("id") or "editor_mix")
        safe_name = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in project_name).strip("_") or "editor_mix"
        output_path = export_dir / f"{safe_name}_mix.{output_format}"
        subtype = None
        if output_format == "wav":
            requested = str(audio_params.get("wav_bit_depth") or audio_params.get("wavBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24", "FLOAT"} else "PCM_24"
        elif output_format == "flac":
            requested = str(audio_params.get("flac_bit_depth") or audio_params.get("flacBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24"} else "PCM_24"
        elif output_format in {"mp3", "m4a"}:
            output_path = output_path.with_suffix(".wav")
            output_format = "wav"
            requested = str(audio_params.get("wav_bit_depth") or audio_params.get("wavBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24", "FLOAT"} else "PCM_24"

        write_kwargs: dict[str, Any] = {}
        if subtype:
            write_kwargs["subtype"] = subtype
        sf.write(str(output_path), mix.T, target_rate, **write_kwargs)
        emit("editor_mix_exported", {
            "path": str(output_path),
            "duration": total_samples / target_rate,
            "sampleRate": target_rate,
            "channels": channels,
            "format": output_path.suffix.lstrip("."),
        })
        return 0
    except Exception as exc:
        return emit_error("EDITOR_EXPORT_FAILED", str(exc), traceback.format_exc())


def cmd_infer(payload: dict[str, Any]) -> int:
    task_id = payload.get("taskId") or f"sep_{int(datetime.now().timestamp())}"
    model_name = payload.get("model")
    input_path = payload.get("input")
    default_output_dir = os.environ.get("PYMSS_STUDIO_DEFAULT_OUTPUT_DIR")
    output_dir = payload.get("output") or default_output_dir or "results"
    output_path = Path(output_dir)
    if not output_path.is_absolute() and default_output_dir:
        output_dir = str(Path(default_output_dir).parent / output_path)
    if not model_name:
        return emit_error("MODEL_NOT_FOUND", "Missing model name", task_id=task_id)
    if not input_path:
        return emit_error("INPUT_NOT_FOUND", "Missing input path", task_id=task_id)
    if not Path(input_path).exists():
        return emit_error("INPUT_NOT_FOUND", f"Input path does not exist: {input_path}", task_id=task_id)

    model_dir = payload.get("modelDir") or None
    download = bool(payload.get("download", True))
    source = payload.get("source") or "modelscope"
    endpoint = payload.get("endpoint") or None
    device = payload.get("device") or "auto"
    device_ids = payload.get("deviceIds") or [0]
    output_format = payload.get("outputFormat") or "wav"
    use_tta = bool(payload.get("useTta", False))
    debug = bool(payload.get("debug", False))
    inference_params = normalize_inference_params(
        payload.get("inferenceParams"),
        payload.get("inferenceParamsVersion"),
    )
    audio_params = normalize_audio_params(payload.get("audioParams"))

    last_reported_done: float | None = None
    last_reported_total: float | None = None
    last_progress_message = ""

    def emit_separation_progress(done: Any, total: Any, message: str | None = None) -> None:
        nonlocal last_reported_done, last_reported_total, last_progress_message
        try:
            total_value = float(total)
            done_value = float(done)
        except (TypeError, ValueError):
            return
        safe_message = message or "Separating"
        if (
            done_value == last_reported_done
            and total_value == last_reported_total
            and safe_message == last_progress_message
        ):
            return
        last_reported_done = done_value
        last_reported_total = total_value
        last_progress_message = safe_message
        emit("task_progress", {
            "stage": "separating",
            "message": safe_message,
            "done": done_value,
            "total": total_value,
        }, task_id=task_id)

    separator = None
    logger = None
    log_handler = None
    try:
        emit("task_started", {"model": model_name, "input": input_path, "output": output_dir}, task_id=task_id)
        emit("task_stage", {"stage": "validating_input", "message": "Validating input"}, task_id=task_id)
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        if download:
            emit("task_stage", {"stage": "downloading_model", "message": "Checking model files"}, task_id=task_id)
        else:
            emit("task_stage", {"stage": "ensuring_model", "message": "Checking model files"}, task_id=task_id)

        from pymss import MSSeparator  # type: ignore
        from pymss.model_registry import resolve_model  # type: ignore
        emit("task_stage", {"stage": "loading_model", "message": "Loading model"}, task_id=task_id)
        try:
            from pymss import get_separation_logger  # type: ignore
            logger = get_separation_logger()
            log_handler = JsonLogHandler(task_id)
            logger.addHandler(log_handler)
        except Exception:
            logger = None

        if download:
            from pymss.model_download import download_model  # type: ignore

            download_model(model_name, model_dir=model_dir, source=source, endpoint=endpoint)

        resolved = resolve_model(model_name, model_dir=model_dir, require_supported=True, require_exists=True)
        if not isinstance(resolved, dict):
            raise RuntimeError(f"resolve_model returned unexpected result for {model_name!r}: {type(resolved).__name__}")
        resolved_model_type = resolved.get('model_type')
        resolved_model_path = resolved.get('model_path')
        if not resolved_model_type or not resolved_model_path:
            missing = [key for key in ('model_type', 'model_path') if not resolved.get(key)]
            raise RuntimeError(f"resolve_model result for {model_name!r} is missing required field(s): {', '.join(missing)}")
        runtime_inference_params = _enrich_inference_params_for_model(
            model_type=resolved_model_type,
            config_path=resolved.get('config_path'),
            inference_params=inference_params,
        )

        separator = MSSeparator(
            model_type=resolved_model_type,
            model_path=resolved_model_path,
            config_path=resolved.get('config_path'),
            device=device,
            device_ids=device_ids,
            output_format=output_format,
            use_tta=use_tta,
            store_dirs=output_dir,
            audio_params=audio_params,
            logger=logger,
            debug=debug,
            progress_callback=emit_separation_progress,
            inference_params=runtime_inference_params,
        )
        emit("task_stage", {"stage": "separating", "message": "Separating"}, task_id=task_id)
        success_files = separator.process_folder(input_path)
        emit("task_stage", {"stage": "writing_output", "message": "Collecting outputs"}, task_id=task_id)
        outputs = collect_outputs(output_dir, success_files, output_format)
        emit("task_done", {"files": success_files, "outputs": outputs, "outputDir": str(Path(output_dir).resolve()), "outputFormat": output_format}, task_id=task_id)
        return 0
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if "no audio stream found" in lowered:
            return emit_error(
                "INPUT_AUDIO_STREAM_MISSING",
                message,
                traceback.format_exc(),
                task_id=task_id,
            )
        if "invalid data found" in lowered or "could not open input" in lowered:
            return emit_error(
                "INPUT_MEDIA_UNSUPPORTED",
                message,
                traceback.format_exc(),
                task_id=task_id,
            )
        return emit_error("INFERENCE_FAILED", message, traceback.format_exc(), task_id=task_id)
    finally:
        if logger is not None and log_handler is not None:
            try:
                logger.removeHandler(log_handler)
            except Exception:
                pass
        if separator is not None:
            close = getattr(separator, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            else:
                try:
                    separator.del_cache()
                except Exception:
                    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="pymss-studio-worker")
    parser.add_argument("command", nargs="?", default="health")
    parser.add_argument("--payload", help="JSON string or path to a JSON payload file")
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        payload = load_payload(args.payload)
        if args.command == "health":
            return cmd_health()
        if args.command == "env_info":
            return cmd_env_info()
        if args.command == "list_models":
            return cmd_list_models(payload)
        if args.command == "model_info":
            return cmd_model_info(payload)
        if args.command == "delete_model":
            return cmd_delete_model(payload)
        if args.command == "model_storage_summary":
            return cmd_model_storage_summary(payload)
        if args.command == "cleanup_model_residual_files":
            return cmd_cleanup_model_residual_files(payload)
        if args.command == "download_model":
            return cmd_download_model(payload)
        if args.command == "audio_metadata":
            return cmd_audio_metadata(payload)
        if args.command == "waveform_peaks":
            return cmd_waveform_peaks(payload)
        if args.command == "export_editor_mix":
            return cmd_export_editor_mix(payload)
        if args.command == "infer":
            return cmd_infer(payload)
        return emit_error("UNKNOWN_COMMAND", f"Unknown command: {args.command}")
    except Exception as exc:
        return emit_error("UNKNOWN_ERROR", str(exc), traceback.format_exc())


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
