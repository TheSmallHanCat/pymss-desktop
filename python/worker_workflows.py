"""
Workflow inference worker — thin shell over pymss.graph (in-process).

Replaces the legacy v2-graph runtime + pymss CLI fallback. The frontend now
sends a native comfy-mss JSON workflow (litegraph serialize output) or a pymss
YAML workflow dict. We hand it straight to pymss.graph and forward progress as
worker events.

Contract (payload fields, sent by stores/task.ts via start_workflow_inference):
  taskId, workflowName, workflow (dict: comfy-mss JSON or pymss YAML),
  input (str path, single-file mode), inputs (list[str], batch mode),
  output, outputFormat, outputLayout, modelDir, source, downloadMethod,
  device, deviceIds, useTta, debug, audioParams.
"""
from __future__ import annotations

import json
import tempfile
import traceback
from pathlib import Path
from typing import Any

from worker_protocol import emit, emit_error


def _normalize_output_dir(value: Any) -> str:
    text = str(value or "").strip()
    return text or "results"


def _normalize_output_layout(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in ("folders", "flat") else "folders"


def _write_workflow_file(payload: dict[str, Any], task_id: str) -> tuple[Path, str]:
    """Write the workflow dict to a temp file and return (path, format).

    format is 'comfy' for a ComfyUI graph dict or 'yaml' for a pymss linear
    workflow dict (detected by the presence of a top-level 'steps' list).
    """
    definition = payload.get("workflow")
    if not isinstance(definition, dict):
        return Path(""), "comfy"

    fmt = "yaml" if "steps" in definition and "nodes" not in definition else "comfy"
    ext = "yaml" if fmt == "yaml" else "json"
    temp_dir = Path(tempfile.gettempdir()) / "pymss-studio-workflows"
    temp_dir.mkdir(parents=True, exist_ok=True)
    path = temp_dir / f"{task_id}.{ext}"
    if fmt == "yaml":
        # The YAML compiler consumes a parsed mapping; write the dict as JSON so
        # pymss.workflow.load_workflow_data can read it back losslessly.
        path.write_text(json.dumps(definition, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        path.write_text(json.dumps(definition, ensure_ascii=False, indent=2), encoding="utf-8")
    return path, fmt


def _resolve_device(payload: dict[str, Any]) -> str | None:
    device = str(payload.get("device") or "").strip().lower()
    return device or None


def _emit_progress(task_id: str) -> Any:
    """Build a progress_callback(i, total, message) that emits task events."""
    last_stage = {"sep": None}

    def cb(index: int, total: int, message: str | None) -> None:
        if total <= 0:
            total = 1
        # Map node index (1-based feel) onto the 35..92 progress band used by
        # the UI's STAGE_META, leaving room for validate(12) and write(92).
        progress = 35 + int((index / max(1, total)) * 55)
        stage = "separating"
        emit("task_progress", {
            "stage": stage,
            "done": index,
            "total": total,
            "message": message or "Running workflow",
            "progress": min(92, progress),
        }, task_id=task_id)

    return cb


def _workflow_task_output_dir(output_dir: str, input_path: str, output_layout: str) -> Path:
    return Path(output_dir) / Path(input_path).stem if output_layout == "folders" else Path(output_dir)


def _run_pymss(payload: dict[str, Any], task_id: str, input_path: str | None,
               input_paths: list[str] | None, output_dir: str, output_layout: str) -> dict[str, Any]:
    import pymss.graph as graph

    workflow_path, fmt = _write_workflow_file(payload, task_id)
    if not workflow_path.is_file():
        raise RuntimeError("Workflow definition is required")

    if fmt == "yaml":
        import pymss.workflow as pwf
        data = json.loads(workflow_path.read_text(encoding="utf-8"))
        wf = pwf.load_workflow_data(data)
        dag = graph.compile_workflow_to_dag(wf)
    else:
        dag = graph.load_comfy_file(workflow_path)

    task_output_dir = _workflow_task_output_dir(output_dir, input_path or (input_paths[0] if input_paths else ""), output_layout)
    task_output_dir.mkdir(parents=True, exist_ok=True)

    saved = graph.run_dag(
        dag,
        output_dir=task_output_dir,
        input_path=input_path,
        input_paths=input_paths,
        progress_callback=_emit_progress(task_id),
        device=_resolve_device(payload),
        model_dir=payload.get("modelDir") or None,
        download=bool(payload.get("downloadMethod") and payload.get("downloadMethod") != "never"),
        source=str(payload.get("source") or "modelscope"),
        output_format=str(payload.get("outputFormat") or "wav").lower() or None,
        audio_params=payload.get("audioParams") if isinstance(payload.get("audioParams"), dict) else None,
        debug=bool(payload.get("debug")),
        strict=True,
    )
    output_format = str(payload.get("outputFormat") or "wav").lower()
    return {
        "files": saved,
        "outputs": [{"path": p, "name": Path(p).name} for p in saved],
        "outputDir": str(task_output_dir.resolve()),
        "outputFormat": output_format,
    }


def cmd_infer_workflow(payload: dict[str, Any]) -> int:
    # Batch mode: a list of per-input tasks shares one workflow.
    raw_tasks = payload.get("tasks")
    if isinstance(raw_tasks, list) and raw_tasks:
        return _cmd_infer_workflow_batch(payload, raw_tasks)

    task_id = str(payload.get("taskId") or "")
    input_path = str(payload.get("input") or "").strip()
    output_dir = _normalize_output_dir(payload.get("output"))
    output_layout = _normalize_output_layout(payload.get("outputLayout"))
    if not task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")
    if not input_path:
        return emit_error("WORKFLOW_INPUT_MISSING", "Workflow input is required", task_id=task_id)

    try:
        source_path = Path(input_path)
        emit("task_started", {
            "workflow": payload.get("workflowName"),
            "input": input_path,
            "output": str(_workflow_task_output_dir(output_dir, input_path, output_layout)),
        }, task_id=task_id)
        emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
        if not source_path.exists():
            return emit_error("INPUT_NOT_FOUND", f"Input not found: {input_path}", task_id=task_id)

        emit("task_stage", {"stage": "separating", "message": "Running workflow", "progress": 35}, task_id=task_id)
        result = _run_pymss(payload, task_id, input_path=input_path, input_paths=None,
                            output_dir=output_dir, output_layout=output_layout)
        emit("task_stage", {"stage": "writing_output", "message": "Collecting workflow outputs", "progress": 92}, task_id=task_id)
        emit("task_done", result, task_id=task_id)
        return 0
    except Exception as exc:
        return emit_error("WORKFLOW_RUN_FAILED", str(exc), traceback.format_exc(), task_id=task_id)


def _cmd_infer_workflow_batch(payload: dict[str, Any], raw_tasks: list[Any]) -> int:
    first_task_id = ""
    if raw_tasks and isinstance(raw_tasks[0], dict):
        first_task_id = str(raw_tasks[0].get("taskId") or "")
    root_task_id = str(payload.get("taskId") or first_task_id or "")
    output_dir = _normalize_output_dir(payload.get("output"))
    output_layout = _normalize_output_layout(payload.get("outputLayout"))
    output_format = str(payload.get("outputFormat") or "wav")
    if not root_task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")

    failed = False
    try:
        for item in raw_tasks:
            if not isinstance(item, dict):
                continue
            task_id = str(item.get("taskId") or "")
            input_path = str(item.get("input") or "").strip()
            if not task_id or not input_path:
                failed = True
                emit_error("WORKFLOW_INPUT_MISSING", "Batch task missing taskId/input", task_id=task_id or root_task_id)
                continue
            emit("task_started", {
                "workflow": payload.get("workflowName"),
                "input": input_path,
                "output": str(_workflow_task_output_dir(output_dir, input_path, output_layout)),
            }, task_id=task_id)
            emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
            try:
                result = _run_pymss({**payload, "taskId": task_id}, task_id,
                                    input_path=None, input_paths=[input_path],
                                    output_dir=output_dir, output_layout=output_layout)
                emit("task_stage", {"stage": "writing_output", "message": "Collecting workflow outputs", "progress": 92}, task_id=task_id)
                emit("task_done", result, task_id=task_id)
            except Exception as exc:
                failed = True
                emit_error("WORKFLOW_RUN_FAILED", str(exc), traceback.format_exc(), task_id=task_id)
        return 1 if failed else 0
    except Exception as exc:
        detail = traceback.format_exc()
        for item in raw_tasks:
            if isinstance(item, dict):
                emit_error("WORKFLOW_RUN_FAILED", str(exc), detail, task_id=str(item.get("taskId") or ""))
        return 1
