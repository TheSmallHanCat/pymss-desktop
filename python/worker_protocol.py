from __future__ import annotations

import json
import importlib.util
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKER_VERSION = "0.1.0"
TERMINAL_LOG_PREFIX = "__PYMSS_STUDIO_TERMINAL_LOG__"
MAX_LOG_LINE_CHARS = 8 * 1024
MAX_LOG_BYTES = 5 * 1024 * 1024
MAX_PERSISTENT_LOG_BYTES = 10 * 1024 * 1024
SENSITIVE_KEY_RE = re.compile(r"(password|passwd|token|secret|authorization|api[_-]?key|proxy[-_]?pass)", re.IGNORECASE)
URL_CREDENTIALS_RE = re.compile(r"([a-z][a-z0-9+.-]*://)[^\s/@]+@", re.IGNORECASE)
SENSITIVE_VALUE_RE = re.compile(
    r"(?i)\b(password|passwd|token|secret|api[_-]?key|proxy[-_]?pass)(\s*[=:]\s*)([^\s,;&]+)"
)
AUTHORIZATION_VALUE_RE = re.compile(r"(?i)\bauthorization(\s*[=:]\s*)([^,;&]+)")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def debug_log(event: str, **fields: Any) -> None:
    if os.environ.get("PYMSS_STUDIO_DEBUG_LOG") != "1":
        return
    path = os.environ.get("PYMSS_STUDIO_SESSION_LOG")
    persistent_path = os.environ.get("PYMSS_STUDIO_PERSISTENT_LOG")
    if not path and not persistent_path:
        return
    try:
        parts = [now_iso(), "PY", event]
        for key, value in fields.items():
            if value in (None, ""):
                continue
            if SENSITIVE_KEY_RE.search(key):
                text = "<redacted>"
            else:
                text = _redact_sensitive_text(str(value).replace("\r", " ").replace("\n", " "))
            if any(ch.isspace() for ch in text) or "=" in text:
                text = json.dumps(text, ensure_ascii=False)
            parts.append(f"{key}={text}")
        line = " ".join(parts)
        if len(line) > MAX_LOG_LINE_CHARS:
            line = line[:MAX_LOG_LINE_CHARS] + " ...[truncated]"
        _write_debug_line(path, line, MAX_LOG_BYTES)
        _write_debug_line(persistent_path, line, MAX_PERSISTENT_LOG_BYTES)
        if os.environ.get("PYMSS_STUDIO_TERMINAL_LOG") == "1":
            print(TERMINAL_LOG_PREFIX + line, file=sys.stderr, flush=True)
    except Exception:
        pass


def _redact_sensitive_text(value: str) -> str:
    value = URL_CREDENTIALS_RE.sub(r"\1", value)
    value = AUTHORIZATION_VALUE_RE.sub(lambda match: f"authorization{match.group(1)}<redacted>", value)
    return SENSITIVE_VALUE_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}<redacted>", value)


def _write_debug_line(path: str | None, line: str, max_bytes: int) -> None:
    if not path:
        return
    log_path = Path(path)
    if log_path.exists() and log_path.stat().st_size >= max_bytes:
        return
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8", errors="replace") as file:
        file.write(line + "\n")


def emit(event_type: str, payload: dict[str, Any] | None = None, *, request_id: str | None = None, task_id: str | None = None) -> None:
    payload = payload or {}
    print(json.dumps({
        "type": event_type,
        "requestId": request_id,
        "taskId": task_id,
        "timestamp": now_iso(),
        "payload": payload,
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
