from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

from worker_infer import _link_batch_input, _normalize_output_layout, collect_outputs, sanitize_output_prefix
from worker_protocol import emit, emit_error


def _normalize_output_dir(value: Any) -> str:
    text = str(value or "").strip()
    return text or "results"


def _write_workflow_definition(payload: dict[str, Any], task_id: str) -> Path:
    workflow_path = payload.get("workflowPath")
    if isinstance(workflow_path, str) and workflow_path.strip():
        path = Path(workflow_path).expanduser()
        if path.is_file():
            return path

    definition = payload.get("workflow")
    if not isinstance(definition, dict):
        return Path("")

    temp_dir = Path(tempfile.gettempdir()) / "pymss-studio-workflows"
    temp_dir.mkdir(parents=True, exist_ok=True)
    path = temp_dir / f"{task_id}.json"
    path.write_text(json.dumps(definition, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _candidate_commands(workflow_path: Path, input_path: str, output_dir: str, payload: dict[str, Any], output_layout: str) -> list[list[str]]:
    output_format = str(payload.get("outputFormat") or "wav")
    audio_params = payload.get("audioParams") if isinstance(payload.get("audioParams"), dict) else {}
    run_args = [
        "workflow",
        "run",
        "-c",
        str(workflow_path),
        "-i",
        input_path,
        "-o",
        output_dir,
        "--output-layout",
        output_layout,
        "--download",
        "--source",
        str(payload.get("source") or "modelscope"),
        "--format",
        output_format,
        "--wav-bit-depth",
        str(audio_params.get("wav_bit_depth") or "FLOAT"),
        "--flac-bit-depth",
        str(audio_params.get("flac_bit_depth") or "PCM_16"),
        "--mp3-bit-rate",
        str(audio_params.get("mp3_bit_rate") or "320k"),
        "--m4a-bit-rate",
        str(audio_params.get("m4a_bit_rate") or "512k"),
        "--m4a-codec",
        str(audio_params.get("m4a_codec") or "aac"),
    ]
    model_dir = str(payload.get("modelDir") or "").strip()
    if model_dir:
        run_args.extend(["--model-dir", model_dir])
    endpoint = str(payload.get("endpoint") or "").strip()
    if endpoint:
        run_args.extend(["--endpoint", endpoint])
    device = str(payload.get("device") or "").strip()
    if device and device != "auto":
        run_args.extend(["--device", device])
    if payload.get("useTta"):
        run_args.append("--tta")
    if payload.get("debug"):
        run_args.append("--debug")
    return [
        [sys.executable, "-m", "pymss.cli", *run_args],
    ]


def _run_workflow_cli(command: list[str], task_id: str) -> tuple[int, str]:
    emit("task_log", {"level": "info", "message": " ".join(command)}, task_id=task_id)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        text = line.rstrip()
        if not text:
            continue
        lines.append(text)
        try:
            event = json.loads(text)
            if isinstance(event, dict) and isinstance(event.get("type"), str):
                emit(event["type"], event.get("payload") if isinstance(event.get("payload"), dict) else {}, task_id=task_id)
                continue
        except Exception:
            pass
        emit("task_log", {"level": "info", "message": text}, task_id=task_id)
    return process.wait(), "\n".join(lines[-40:])


def _workflow_task_output_dir(output_dir: str, alias: str, output_layout: str) -> Path:
    return Path(output_dir) / alias if output_layout == "folders" else Path(output_dir)


def _prepare_workflow_batch_tasks(raw_tasks: Any, root_task_id: str) -> tuple[list[dict[str, str]], str | None, str | None]:
    if not isinstance(raw_tasks, list) or not raw_tasks:
        return [], "WORKFLOW_INPUT_MISSING", "Missing workflow batch tasks"
    batch_tasks: list[dict[str, str]] = []
    used_aliases: set[str] = set()
    for index, item in enumerate(raw_tasks):
        if not isinstance(item, dict):
            return [], "WORKFLOW_INPUT_MISSING", f"Invalid workflow batch task at index {index}"
        task_id = str(item.get("taskId") or "").strip()
        input_path = str(item.get("input") or "").strip()
        if not task_id:
            return [], "WORKFLOW_INPUT_MISSING", f"Missing taskId for workflow batch task {index + 1}"
        if not input_path:
            return [], "WORKFLOW_INPUT_MISSING", f"Missing input path for workflow batch task {task_id}"
        source_path = Path(input_path)
        if not source_path.exists():
            return [], "INPUT_NOT_FOUND", f"Input not found: {input_path}"
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
    return batch_tasks, None, None


def _collect_flat_outputs_by_alias(output_dir: str, aliases: list[str], output_format: str) -> dict[str, list[dict[str, str]]]:
    outputs_by_alias = {alias: [] for alias in aliases}
    ordered_aliases = sorted(aliases, key=len, reverse=True)
    base = Path(output_dir)
    if not base.exists():
        return outputs_by_alias
    for path in base.rglob(f"*.{output_format.lower()}"):
        path_stem = path.stem
        matched_alias = next(
            (alias for alias in ordered_aliases if path_stem == alias or path_stem.startswith(f"{alias}_")),
            None,
        )
        if matched_alias is None:
            continue
        stem = path_stem[len(matched_alias):].lstrip("_") or path_stem
        outputs_by_alias[matched_alias].append({"stem": stem, "path": str(path)})
    return outputs_by_alias


def _emit_workflow_batch_error(raw_tasks: Any, fallback_task_id: str, code: str, message: str, detail: str = "") -> int:
    task_ids: list[str] = []
    if isinstance(raw_tasks, list):
        for item in raw_tasks:
            if not isinstance(item, dict):
                continue
            task_id = str(item.get("taskId") or "").strip()
            if task_id and task_id not in task_ids:
                task_ids.append(task_id)
    if not task_ids and fallback_task_id:
        task_ids.append(fallback_task_id)
    for task_id in task_ids:
        emit_error(code, message, detail, task_id=task_id)
    return 1


def cmd_infer_workflow_batch(payload: dict[str, Any]) -> int:
    raw_tasks = payload.get("tasks")
    first_task_id = ""
    if isinstance(raw_tasks, list) and raw_tasks and isinstance(raw_tasks[0], dict):
        first_task_id = str(raw_tasks[0].get("taskId") or "")
    root_task_id = str(payload.get("taskId") or first_task_id or "")
    output_dir = _normalize_output_dir(payload.get("output"))
    output_format = str(payload.get("outputFormat") or "wav")
    output_layout = _normalize_output_layout(payload.get("outputLayout"))
    if not root_task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")

    batch_tasks, error_code, error_message = _prepare_workflow_batch_tasks(raw_tasks, root_task_id)
    if error_code:
        return _emit_workflow_batch_error(
            raw_tasks,
            root_task_id,
            error_code,
            error_message or "Invalid workflow batch tasks",
        )

    workflow_path = _write_workflow_definition(payload, root_task_id)
    if not workflow_path.is_file():
        return _emit_workflow_batch_error(raw_tasks, root_task_id, "WORKFLOW_MISSING", "Workflow definition is required")

    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        for item in batch_tasks:
            task_output_dir = _workflow_task_output_dir(output_dir, item["alias"], output_layout)
            emit("task_started", {"workflow": payload.get("workflowName"), "input": item["input"], "output": str(task_output_dir)}, task_id=item["taskId"])
            emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=item["taskId"])

        failures: list[str] = []
        with tempfile.TemporaryDirectory(prefix="pymss-studio-workflow-batch-") as temp_dir:
            temp_path = Path(temp_dir)
            for item in batch_tasks:
                _link_batch_input(Path(item["input"]), temp_path / item["linkName"])
            for item in batch_tasks:
                emit("task_stage", {"stage": "separating", "message": "Waiting for workflow batch", "progress": 35}, task_id=item["taskId"])
            for command in _candidate_commands(workflow_path, str(temp_path), output_dir, payload, output_layout):
                try:
                    code, tail = _run_workflow_cli(command, root_task_id)
                except FileNotFoundError as exc:
                    failures.append(str(exc))
                    continue
                if code != 0:
                    failures.append(tail or f"command exited with {code}: {' '.join(command)}")
                    continue

                flat_outputs = _collect_flat_outputs_by_alias(output_dir, [item["alias"] for item in batch_tasks], output_format) if output_layout == "flat" else {}
                for item in batch_tasks:
                    task_output_dir = _workflow_task_output_dir(output_dir, item["alias"], output_layout)
                    emit("task_stage", {"stage": "writing_output", "message": "Collecting workflow outputs", "progress": 92}, task_id=item["taskId"])
                    outputs = flat_outputs.get(item["alias"], []) if output_layout == "flat" else collect_outputs(str(task_output_dir), [item["linkName"]], output_format)
                    files = [output["path"] for output in outputs]
                    if not files and task_output_dir.exists():
                        files = [str(path) for path in task_output_dir.rglob("*") if path.is_file()]
                    emit("task_done", {
                        "files": files,
                        "outputs": outputs,
                        "outputDir": str(task_output_dir.resolve()),
                        "outputFormat": output_format,
                    }, task_id=item["taskId"])
                return 0

        detail = "\n\n".join(failures)
        for item in batch_tasks:
            emit_error("WORKFLOW_RUN_FAILED", "Unable to run workflow with the installed pymss package.", detail, task_id=item["taskId"])
        return 1
    except Exception as exc:
        detail = traceback.format_exc()
        for item in batch_tasks:
            emit_error("WORKFLOW_RUN_FAILED", str(exc), detail, task_id=item["taskId"])
        return 1


def cmd_infer_workflow(payload: dict[str, Any]) -> int:
    if isinstance(payload.get("tasks"), list):
        return cmd_infer_workflow_batch(payload)

    task_id = str(payload.get("taskId") or "")
    input_path = str(payload.get("input") or "").strip()
    output_dir = _normalize_output_dir(payload.get("output"))
    output_format = str(payload.get("outputFormat") or "wav")
    output_layout = _normalize_output_layout(payload.get("outputLayout"))
    if not task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")
    if not input_path:
        return emit_error("WORKFLOW_INPUT_MISSING", "Workflow input is required", task_id=task_id)

    workflow_path = _write_workflow_definition(payload, task_id)
    if not workflow_path.is_file():
        return emit_error("WORKFLOW_MISSING", "Workflow definition is required", task_id=task_id)

    try:
        source_path = Path(input_path)
        output_prefix = sanitize_output_prefix(payload.get("outputPrefix"), input_path)
        task_output_dir = _workflow_task_output_dir(output_dir, output_prefix, output_layout)
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        emit("task_started", {"workflow": payload.get("workflowName"), "input": input_path, "output": str(task_output_dir)}, task_id=task_id)
        emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
        if not source_path.exists():
            return emit_error("INPUT_NOT_FOUND", f"Input not found: {input_path}", task_id=task_id)

        emit("task_stage", {"stage": "separating", "message": "Running workflow", "progress": 35}, task_id=task_id)
        failures: list[str] = []
        with tempfile.TemporaryDirectory(prefix="pymss-studio-workflow-") as temp_dir:
            linked_input = Path(temp_dir) / f"{output_prefix}{source_path.suffix}"
            _link_batch_input(source_path, linked_input)
            for command in _candidate_commands(workflow_path, str(linked_input), output_dir, payload, output_layout):
                try:
                    code, tail = _run_workflow_cli(command, task_id)
                except FileNotFoundError as exc:
                    failures.append(str(exc))
                    continue
                if code == 0:
                    emit("task_stage", {"stage": "writing_output", "message": "Collecting workflow outputs", "progress": 92}, task_id=task_id)
                    outputs = collect_outputs(str(task_output_dir), [linked_input.name], output_format)
                    files = [item["path"] for item in outputs]
                    if not files:
                        files = [str(path) for path in task_output_dir.rglob("*") if path.is_file()]
                    emit("task_done", {
                        "files": files,
                        "outputs": outputs,
                        "outputDir": str(task_output_dir.resolve()),
                        "outputFormat": output_format,
                    }, task_id=task_id)
                    return 0
                failures.append(tail or f"command exited with {code}: {' '.join(command)}")

        return emit_error(
            "WORKFLOW_RUN_FAILED",
            "Unable to run workflow with the installed pymss package.",
            "\n\n".join(failures),
            task_id=task_id,
        )
    except Exception as exc:
        return emit_error("WORKFLOW_RUN_FAILED", str(exc), traceback.format_exc(), task_id=task_id)
