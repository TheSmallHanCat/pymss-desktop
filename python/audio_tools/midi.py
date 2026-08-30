from __future__ import annotations

import math
from typing import Any

from worker_protocol import emit, isolate_protocol_stdout
from .common import _require_directory, _require_file


def _vocal_to_midi(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = _require_file(payload.get("inputPath"), "Input vocal audio")
    model_path = _require_file(payload.get("modelPath"), "GAME model weights")
    output_dir = _require_directory(payload.get("outputDir"), "Output directory", create=True)
    raw_bpm = payload["bpm"] if "bpm" in payload else 120
    try:
        bpm = float(raw_bpm)
    except (TypeError, ValueError) as error:
        raise ValueError("BPM must be between 30 and 300") from error
    if not math.isfinite(bpm) or bpm < 30 or bpm > 300:
        raise ValueError("BPM must be between 30 and 300")
    language = str(payload.get("language") or "").strip().lower() or None

    emit("audio_tool_progress", {
        "operation": "midi",
        "phase": "preparing",
        "completed": 0,
        "total": 0,
        "current": input_path.name,
    })

    def report_progress(phase: str, completed: int, total: int) -> None:
        emit("audio_tool_progress", {
            "operation": "midi",
            "phase": phase,
            "completed": completed,
            "total": total,
            "current": input_path.name,
        })

    # The worker reserves stdout for JSON envelopes. Redirect incidental output
    # from Torch and vendored model code to stderr so it cannot corrupt the protocol.
    with isolate_protocol_stdout():
        from game.infer import infer  # type: ignore

        inference_result = infer(
            model_path=model_path,
            audio_path=input_path,
            output_dir=output_dir,
            tempo=bpm,
            language=language,
            progress_callback=report_progress,
        )
        output_path = inference_result.output_path.resolve()
    return {
        "operation": "midi",
        "outputDir": str(output_dir),
        "outputPath": str(output_path),
        "bpm": bpm,
        "language": inference_result.language or "auto",
        "noteCount": inference_result.note_count,
        "inputDuration": inference_result.input_duration,
        "firstNoteAt": inference_result.first_note_at,
        "lastNoteAt": inference_result.last_note_at,
        "warnings": list(inference_result.warnings),
    }
