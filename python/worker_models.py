from __future__ import annotations

import os
import platform
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any

from worker_protocol import WORKER_VERSION, _as_bool, _as_float, _as_int, emit, emit_error, import_available

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
