from __future__ import annotations

import json
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKER_VERSION = "0.1.0"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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
    extra: dict[str, Any] | None = None,
) -> int:
    payload: dict[str, Any] = {
        "code": code,
        "message": message,
        "detail": detail,
        "recoverable": recoverable,
    }
    if extra:
        payload.update(extra)
    emit("error", payload, task_id=task_id)
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
