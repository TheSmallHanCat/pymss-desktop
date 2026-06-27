from __future__ import annotations

import json
import importlib.util
import os
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

def bootstrap_pymss_path() -> None:
    def resolve_sys_path(candidate: Path) -> Path | None:
        if (candidate / "pymss" / "__init__.py").is_file():
            return candidate
        if (candidate / "__init__.py").is_file() and (candidate / "separator.py").is_file():
            return candidate.parent
        return None

    worker_path = Path(__file__).resolve()
    worker_dir = worker_path.parent
    candidates: list[Path] = []

    env_pymss = os.environ.get("PYMSS_STUDIO_PYMSS_PATH")
    if env_pymss:
        candidates.append(Path(env_pymss))

    # Portable / staged layout:
    #   <root>/python/worker.py
    #   <root>/pymss/...
    candidates.append(worker_dir.parent / "pymss")

    # Development layout:
    #   <workspace>/pymss-desktop/python/worker.py
    #   <workspace>/pymss/...
    candidates.append(worker_dir.parent.parent / "pymss")

    # Tauri bundled resources sometimes place the worker deeper in resources.
    candidates.append(worker_dir.parent / "resources" / "pymss")
    candidates.append(worker_dir.parent.parent / "resources" / "pymss")

    for candidate in candidates:
        resolved = resolve_sys_path(candidate)
        if resolved is not None:
            sys.path.insert(0, str(resolved))
            return


bootstrap_pymss_path()


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
) -> int:
    emit("error", {
        "code": code,
        "message": message,
        "detail": detail,
        "recoverable": recoverable,
    }, task_id=task_id)
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
