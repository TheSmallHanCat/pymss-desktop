"""
Workflow inference worker — thin shell over pymss.graph (in-process).

Replaces the legacy v2-graph runtime + pymss CLI fallback. The frontend now
sends a native comfy-mss JSON workflow (litegraph serialize output) or a pymss
YAML workflow dict. We hand it straight to pymss.graph and forward progress as
worker events.

Contract (payload fields, sent by stores/task.ts via start_workflow_inference):
  taskId, workflowName, workflow (dict: comfy-mss JSON or pymss YAML),
  input (str path, single-file mode), inputs ({name: path}, named runtime
  inputs for comfy load nodes),
  tasks (batch mode: [{taskId, input | inputs, output}], ...),
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


def _normalize_inputs(value: Any) -> dict[str, str]:
    """Payload `inputs`: mapping of runtime slot name -> file path (str).

    Comfy graphs with named load nodes send this instead of the legacy single
    `input` path. pymss 2.1.2 requires named inputs — no positional fallback.
    """
    if not isinstance(value, dict):
        return {}
    return {str(k).strip(): str(v).strip() for k, v in value.items() if str(k).strip() and str(v).strip()}


def _prepare_legacy_global_input(
    payload: dict[str, Any],
    input_path: str | None,
    inputs: dict[str, str] | None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Keep the pre-input-slot workflow contract working for global files.

    Older studio versions always supplied the selected file as ``input`` and
    stored ``input.wav`` (or an empty value) in load-node widgets.  Newer
    pymss runtimes require a named ``inputs`` mapping for those placeholders.
    Build that mapping at the worker boundary so existing workflows and the
    global input picker continue to use the selected file without rewriting
    their persisted definitions.
    """
    merged_inputs = dict(inputs or {})
    if not input_path:
        return payload, merged_inputs
    definition = payload.get("workflow")
    if not isinstance(definition, dict) or not isinstance(definition.get("nodes"), list):
        return payload, merged_inputs

    # Do not mutate the payload retained by the caller; only the transient
    # workflow file written for this task may be adjusted.
    transient = json.loads(json.dumps(definition))
    for node in transient.get("nodes", []):
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("type") or "").strip()
        widgets = node.get("widgets_values")
        if not isinstance(widgets, list):
            widgets = []
        if node_type in {"pymss_load_audio", "LoadAudio"}:
            # LiteGraph serializes an untouched optional widget as ``null``;
            # normalize it the same way pymss' node executor does instead of
            # turning it into the literal slot name "None".
            input_name = str((widgets[1] if len(widgets) > 1 else "") or "").strip()
            if input_name:
                # The global picker is authoritative after the input-slot UI
                # rollback, including for graphs saved with input_name.
                merged_inputs[input_name] = input_path
            else:
                widget_name = str((widgets[0] if widgets else "") or "").strip()
                if widget_name:
                    merged_inputs[widget_name] = input_path
                # pymss resolves an existing audio-widget path before looking
                # at the legacy inputs mapping. Replace it in the transient
                # graph as well, otherwise a graph saved with an embedded path
                # would silently ignore the file selected on the inference page.
                while len(widgets) <= 0:
                    widgets.append("")
                widgets[0] = input_path
            node["widgets_values"] = widgets
        elif node_type == "pymss_load_audio_batch":
            input_name = str((widgets[3] if len(widgets) > 3 else "") or "").strip()
            if input_name:
                merged_inputs[input_name] = input_path
            else:
                # Legacy batch nodes had only folder/recursive/sort widgets.
                # Give them a transient slot so the shared picker remains the
                # authoritative source instead of silently scanning a stale
                # folder (or an empty folder) from the saved graph.
                input_name = "__pymss_studio_global_input__"
                while len(widgets) <= 3:
                    widgets.append("")
                widgets[3] = input_name
                merged_inputs[input_name] = input_path
            node["widgets_values"] = widgets

    return {**payload, "workflow": transient}, merged_inputs


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


def _workflow_output_stem(path: str, input_path: str | None = None) -> str:
    """Return the shared display stem used by single-separation results.

    ``pymss.graph.run_dag`` returns saved file paths, and older graph
    versions did not include a ``stem`` field in the task payload.  Depending
    on the graph/save-node configuration, the filename may include the input
    basename (for example ``song_vocals.wav``).  Strip that stable prefix so
    advanced-workflow outputs use the same labels as regular separation.
    """
    raw_path = str(path or "").strip()
    file_name = raw_path.replace("\\", "/").rsplit("/", 1)[-1]
    stem = Path(file_name).stem.strip()
    input_file_name = str(input_path or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    input_stem = Path(input_file_name).stem.strip()
    prefix = f"{input_stem}_"
    if input_stem and stem.casefold().startswith(prefix.casefold()):
        stem = stem[len(prefix):].strip()
    return stem or file_name or "output"


def _run_pymss(payload: dict[str, Any], task_id: str, input_path: str | None,
               inputs: dict[str, str] | None, output_dir: str, output_layout: str) -> dict[str, Any]:
    import pymss.graph as graph

    runtime_payload, runtime_inputs = _prepare_legacy_global_input(payload, input_path, inputs)
    workflow_path, fmt = _write_workflow_file(runtime_payload, task_id)
    if not workflow_path.is_file():
        raise RuntimeError("Workflow definition is required")

    if fmt == "yaml":
        import pymss.workflow as pwf
        data = json.loads(workflow_path.read_text(encoding="utf-8"))
        wf = pwf.load_workflow_data(data)
        dag = graph.compile_workflow_to_dag(wf)
    else:
        dag = graph.load_comfy_file(workflow_path)

    # Output-folder naming follows the primary input: the explicit single
    # input, else the first value of the named inputs mapping.
    primary = input_path or (list(runtime_inputs.values())[0] if runtime_inputs else "")
    task_output_dir = _workflow_task_output_dir(output_dir, primary, output_layout)
    task_output_dir.mkdir(parents=True, exist_ok=True)

    saved = graph.run_dag(
        dag,
        output_dir=task_output_dir,
        input_path=input_path,
        inputs=runtime_inputs or None,
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
    saved_paths = [str(path).strip() for path in saved if path is not None and str(path).strip()]
    return {
        "files": saved_paths,
        "outputs": [
            {
                "stem": _workflow_output_stem(path, primary),
                "path": path,
                "name": Path(path.replace("\\", "/")).name,
            }
            for path in saved_paths
        ],
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
    inputs = _normalize_inputs(payload.get("inputs"))
    output_dir = _normalize_output_dir(payload.get("output"))
    output_layout = _normalize_output_layout(payload.get("outputLayout"))
    if not task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")
    # No input required: a self-contained graph (load widgets carry real
    # paths) runs without runtime inputs. pymss raises a precise DAGError
    # otherwise, which we forward below.

    try:
        source_path = Path(input_path) if input_path else (Path(next(iter(inputs.values()))) if inputs else None)
        emit("task_started", {
            "workflow": payload.get("workflowName"),
            "input": str(source_path) if source_path else "(graph inputs)",
            "output": str(_workflow_task_output_dir(output_dir, str(source_path) if source_path else "workflow", output_layout)),
        }, task_id=task_id)
        emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
        if source_path and not source_path.exists():
            return emit_error("INPUT_NOT_FOUND", f"Input not found: {source_path}", task_id=task_id)

        emit("task_stage", {"stage": "separating", "message": "Running workflow", "progress": 35}, task_id=task_id)
        result = _run_pymss(payload, task_id, input_path=input_path or None, inputs=inputs or None,
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
            item_inputs = _normalize_inputs(item.get("inputs"))
            if not task_id:
                failed = True
                emit_error("WORKFLOW_TASK_ID_MISSING", "Batch task missing taskId", task_id=root_task_id)
                continue
            # input/inputs optional when the graph carries its own paths; pymss
            # raises a precise DAGError if a load node ends up unresolved.
            source_name = input_path or (next(iter(item_inputs.values())) if item_inputs else "")
            emit("task_started", {
                "workflow": payload.get("workflowName"),
                "input": source_name,
                "output": str(_workflow_task_output_dir(output_dir, source_name or "workflow", output_layout)),
            }, task_id=task_id)
            emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
            try:
                result = _run_pymss({**payload, "taskId": task_id}, task_id,
                                    input_path=input_path or None,
                                    inputs=item_inputs or None,
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
