from __future__ import annotations

import os
import re
import shutil
import tempfile
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

from worker_audio import _apply_stereo_pan, _equal_power_fade, _read_audio, _resample_audio
from worker_models import _derive_overlap_size_from_num_overlap
from worker_protocol import _as_bool, _as_float, _as_int, emit, emit_error

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


def sanitize_output_prefix(value: Any, input_path: str) -> str:
    raw = str(value or "").strip() or Path(input_path).stem
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:80] or "input"


def prefix_output_files(outputs: list[dict[str, str]], prefix: str) -> list[dict[str, str]]:
    renamed: list[dict[str, str]] = []
    for output in outputs:
        stem = output.get("stem") or ""
        path_value = output.get("path") or ""
        path = Path(path_value)
        if not stem or not path.exists():
            renamed.append(output)
            continue
        expected_name = f"{prefix}_{stem}{path.suffix}"
        target = path.with_name(expected_name)
        if path.name != expected_name:
            if target.exists():
                target.unlink()
            path.rename(target)
        renamed.append({"stem": stem, "path": str(target)})
    return renamed

def _emit_inference_error(exc: Exception, task_id: str) -> int:
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

def _close_separator(separator: Any) -> None:
    if separator is None:
        return
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

def _link_batch_input(source: Path, target: Path) -> None:
    try:
        target.symlink_to(source)
        return
    except Exception:
        pass
    try:
        os.link(source, target)
        return
    except Exception:
        pass
    shutil.copy2(source, target)

def _normalize_output_dir(value: Any) -> str:
    default_output_dir = os.environ.get("PYMSS_STUDIO_DEFAULT_OUTPUT_DIR")
    output_dir = value or default_output_dir or "results"
    output_path = Path(str(output_dir))
    if not output_path.is_absolute() and default_output_dir:
        return str(Path(default_output_dir).parent / output_path)
    return str(output_dir)

def _normalize_selected_stems(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    stems: list[str] = []
    seen: set[str] = set()
    for item in value:
        stem = str(item or "").strip()
        if not stem or stem.lower() in seen:
            continue
        stems.append(stem)
        seen.add(stem.lower())
    return stems

def _store_dirs_for_selected_stems(output_dir: str, selected_stems: list[str]) -> Any:
    if not selected_stems:
        return output_dir
    return {stem: output_dir for stem in selected_stems}

def _prepare_separator(
    *,
    payload: dict[str, Any],
    task_id: str,
    progress_callback: Any,
    logger: Any,
) -> Any:
    model_name = payload.get("model")
    if not model_name:
        raise ValueError("Missing model name")
    model_dir = payload.get("modelDir") or None
    download = bool(payload.get("download", True))
    source = payload.get("source") or "modelscope"
    endpoint = payload.get("endpoint") or None
    device = payload.get("device") or "auto"
    device_ids = payload.get("deviceIds") or [0]
    output_format = payload.get("outputFormat") or "wav"
    selected_stems = _normalize_selected_stems(payload.get("selectedStems"))
    use_tta = bool(payload.get("useTta", False))
    debug = bool(payload.get("debug", False))
    inference_params = normalize_inference_params(
        payload.get("inferenceParams"),
        payload.get("inferenceParamsVersion"),
    )
    audio_params = normalize_audio_params(payload.get("audioParams"))

    if download:
        emit("task_stage", {"stage": "downloading_model", "message": "Checking model files"}, task_id=task_id)
    else:
        emit("task_stage", {"stage": "ensuring_model", "message": "Checking model files"}, task_id=task_id)
    from pymss import MSSeparator  # type: ignore
    from pymss.model_registry import resolve_model  # type: ignore
    emit("task_stage", {"stage": "loading_model", "message": "Loading model"}, task_id=task_id)
    try:
        resolved = resolve_model(model_name, model_dir=model_dir, require_supported=True, require_exists=True)
    except Exception as resolve_exc:
        if not download:
            raise resolve_exc
        from pymss.model_download import download_model  # type: ignore
        emit("task_stage", {"stage": "downloading_model", "message": "Downloading model files"}, task_id=task_id)
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
    return MSSeparator(
        model_type=resolved_model_type,
        model_path=resolved_model_path,
        config_path=resolved.get('config_path'),
        device=device,
        device_ids=device_ids,
        output_format=output_format,
        use_tta=use_tta,
        store_dirs=_store_dirs_for_selected_stems(_normalize_output_dir(payload.get("output")), selected_stems),
        save_as_folder=bool(payload.get("saveAsFolder", False)),
        audio_params=audio_params,
        logger=logger,
        debug=debug,
        progress_callback=progress_callback,
        inference_params=runtime_inference_params,
    )


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


def cmd_infer_batch(payload: dict[str, Any]) -> int:
    raw_tasks = payload.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        return emit_error("INPUT_NOT_FOUND", "Missing batch tasks", task_id=payload.get("taskId") or None)

    root_task_id = str(payload.get("taskId") or raw_tasks[0].get("taskId") or f"sep_{int(datetime.now().timestamp())}")
    output_root = _normalize_output_dir(payload.get("output"))
    output_format = payload.get("outputFormat") or "wav"
    batch_tasks: list[dict[str, str]] = []
    used_aliases: set[str] = set()

    for index, item in enumerate(raw_tasks):
        if not isinstance(item, dict):
            return emit_error("INPUT_NOT_FOUND", f"Invalid batch task at index {index}", task_id=root_task_id)
        task_id = str(item.get("taskId") or "").strip()
        input_path = str(item.get("input") or "").strip()
        if not task_id:
            return emit_error("INPUT_NOT_FOUND", f"Missing taskId for batch task {index + 1}", task_id=root_task_id)
        if not input_path:
            return emit_error("INPUT_NOT_FOUND", f"Missing input path for batch task {task_id}", task_id=task_id)
        source_path = Path(input_path)
        if not source_path.exists():
            return emit_error("INPUT_NOT_FOUND", f"Input path does not exist: {input_path}", task_id=task_id)
        alias = sanitize_output_prefix(item.get("outputPrefix"), input_path)
        base_alias = alias
        suffix = 2
        while alias.lower() in used_aliases:
            alias = f"{base_alias}-{suffix}"
            suffix += 1
        used_aliases.add(alias.lower())
        batch_tasks.append({
            "taskId": task_id,
            "input": str(source_path),
            "alias": alias,
            "linkName": f"{alias}{source_path.suffix}",
        })

    logger = None
    log_handler = None
    separator = None
    last_reported_done: float | None = None
    last_reported_total: float | None = None
    last_progress_message = ""

    def emit_batch_progress(done: Any, total: Any, message: str | None = None) -> None:
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
        for item in batch_tasks:
            emit("task_progress", {
                "stage": "separating",
                "message": safe_message,
                "done": done_value,
                "total": total_value,
            }, task_id=item["taskId"])

    try:
        Path(output_root).mkdir(parents=True, exist_ok=True)
        for item in batch_tasks:
            task_output = str(Path(output_root) / item["alias"])
            emit("task_started", {"model": payload.get("model"), "input": item["input"], "output": task_output}, task_id=item["taskId"])
            emit("task_stage", {"stage": "validating_input", "message": "Validating input"}, task_id=item["taskId"])
        try:
            from pymss import get_separation_logger  # type: ignore
            logger = get_separation_logger()
            log_handler = JsonLogHandler(root_task_id)
            logger.addHandler(log_handler)
        except Exception:
            logger = None
        separator = _prepare_separator(
            payload={**payload, "output": output_root, "saveAsFolder": True},
            task_id=root_task_id,
            progress_callback=emit_batch_progress,
            logger=logger,
        )
        for item in batch_tasks:
            emit("task_stage", {"stage": "separating", "message": "Waiting for batch separation"}, task_id=item["taskId"])
        with tempfile.TemporaryDirectory(prefix="pymss-studio-batch-") as temp_dir:
            temp_path = Path(temp_dir)
            for item in batch_tasks:
                _link_batch_input(Path(item["input"]), temp_path / item["linkName"])
            success_files = separator.process_folder(str(temp_path))
        success_names = {Path(name).name for name in success_files}
        success_stems = {Path(name).stem for name in success_files}
        for item in batch_tasks:
            task_id = item["taskId"]
            alias = item["alias"]
            link_name = item["linkName"]
            task_output = str(Path(output_root) / alias)
            if link_name not in success_names and alias not in success_stems:
                emit_error("INFERENCE_FAILED", f"Batch separation did not produce outputs for {Path(item['input']).name}", task_id=task_id)
                continue
            emit("task_stage", {"stage": "writing_output", "message": "Collecting outputs"}, task_id=task_id)
            outputs = collect_outputs(task_output, [link_name], output_format)
            emit("task_done", {
                "files": [Path(item["input"]).name],
                "outputs": outputs,
                "outputDir": str(Path(task_output).resolve()),
                "outputFormat": output_format,
            }, task_id=task_id)
        return 0
    except Exception as exc:
        for item in batch_tasks:
            _emit_inference_error(exc, item["taskId"])
        return 1
    finally:
        if logger is not None and log_handler is not None:
            try:
                logger.removeHandler(log_handler)
            except Exception:
                pass
        _close_separator(separator)


def cmd_infer(payload: dict[str, Any]) -> int:
    if isinstance(payload.get("tasks"), list):
        return cmd_infer_batch(payload)

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
    output_prefix = sanitize_output_prefix(payload.get("outputPrefix"), input_path)
    selected_stems = _normalize_selected_stems(payload.get("selectedStems"))
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

        try:
            resolved = resolve_model(model_name, model_dir=model_dir, require_supported=True, require_exists=True)
        except Exception as resolve_exc:
            if not download:
                return emit_error("MODEL_NOT_FOUND", str(resolve_exc), traceback.format_exc(), task_id=task_id)

            from pymss.model_download import download_model  # type: ignore

            try:
                emit("task_stage", {"stage": "downloading_model", "message": "Downloading model files"}, task_id=task_id)
                download_model(model_name, model_dir=model_dir, source=source, endpoint=endpoint)
                resolved = resolve_model(model_name, model_dir=model_dir, require_supported=True, require_exists=True)
            except Exception as exc:
                return emit_error("MODEL_DOWNLOAD_FAILED", str(exc), traceback.format_exc(), task_id=task_id)

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
            store_dirs=_store_dirs_for_selected_stems(output_dir, selected_stems),
            audio_params=audio_params,
            logger=logger,
            debug=debug,
            progress_callback=emit_separation_progress,
            inference_params=runtime_inference_params,
        )
        emit("task_stage", {"stage": "separating", "message": "Separating"}, task_id=task_id)
        success_files = separator.process_folder(input_path)
        emit("task_stage", {"stage": "writing_output", "message": "Collecting outputs"}, task_id=task_id)
        outputs = prefix_output_files(collect_outputs(output_dir, success_files, output_format), output_prefix)
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
