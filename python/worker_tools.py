from __future__ import annotations

import traceback
from typing import Any

from audio_tools.common import AudioToolError
from audio_tools.registry import get_audio_tool_handler
from worker_protocol import emit, emit_error


def cmd_audio_tools(payload: dict[str, Any]) -> int:
    operation = str(payload.get("operation") or "").strip().lower()
    request_id = str(payload.get("requestId") or "").strip() or None
    handler = get_audio_tool_handler(operation)
    if handler is None:
        return emit_error("AUDIO_TOOL_INVALID", "Unknown audio tool operation", request_id=request_id)
    try:
        result = handler(payload)
        emit("audio_tool_result", result, request_id=request_id)
        return 0
    except AudioToolError as error:
        return emit_error(
            error.code,
            str(error),
            traceback.format_exc(),
            request_id=request_id,
            recoverable=error.recoverable,
            extra={"operation": operation, **error.extra},
        )
    except Exception as error:
        return emit_error(
            "AUDIO_TOOL_FAILED",
            str(error),
            traceback.format_exc(),
            request_id=request_id,
            extra={"operation": operation},
        )
