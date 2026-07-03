from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

from worker_infer import collect_outputs
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


def _candidate_commands(workflow_path: Path, input_path: str, output_dir: str, payload: dict[str, Any]) -> list[list[str]]:
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


def cmd_infer_workflow(payload: dict[str, Any]) -> int:
    task_id = str(payload.get("taskId") or "")
    input_path = str(payload.get("input") or "").strip()
    output_dir = _normalize_output_dir(payload.get("output"))
    output_format = str(payload.get("outputFormat") or "wav")
    if not task_id:
        return emit_error("WORKFLOW_TASK_ID_MISSING", "Workflow task id is required")
    if not input_path:
        return emit_error("WORKFLOW_INPUT_MISSING", "Workflow input is required", task_id=task_id)

    workflow_path = _write_workflow_definition(payload, task_id)
    if not workflow_path.is_file():
        return emit_error("WORKFLOW_MISSING", "Workflow definition is required", task_id=task_id)

    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        emit("task_started", {"workflow": payload.get("workflowName"), "input": input_path, "output": output_dir}, task_id=task_id)
        emit("task_stage", {"stage": "validating_input", "message": "Validating workflow input", "progress": 12}, task_id=task_id)
        if not Path(input_path).exists():
            return emit_error("INPUT_NOT_FOUND", f"Input not found: {input_path}", task_id=task_id)

        emit("task_stage", {"stage": "separating", "message": "Running workflow", "progress": 35}, task_id=task_id)
        failures: list[str] = []
        for command in _candidate_commands(workflow_path, input_path, output_dir, payload):
            try:
                code, tail = _run_workflow_cli(command, task_id)
            except FileNotFoundError as exc:
                failures.append(str(exc))
                continue
            if code == 0:
                emit("task_stage", {"stage": "writing_output", "message": "Collecting workflow outputs", "progress": 92}, task_id=task_id)
                outputs = collect_outputs(output_dir, [Path(input_path).stem], output_format)
                files = [item["path"] for item in outputs]
                if not files:
                    files = [str(path) for path in Path(output_dir).rglob("*") if path.is_file()]
                emit("task_done", {"files": files, "outputs": outputs, "outputDir": output_dir, "outputFormat": output_format}, task_id=task_id)
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
