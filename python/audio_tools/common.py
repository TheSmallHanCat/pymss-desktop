from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

SUPPORTED_AUDIO_SUFFIXES = {
    ".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus",
    ".wma", ".aiff", ".aif",
}


class AudioToolError(RuntimeError):
    """An audio-tool failure with worker-protocol metadata."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        recoverable: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.extra = extra or {}


def _require_file(value: Any, label: str) -> Path:
    path = Path(str(value or "").strip()).expanduser()
    if not str(path) or not path.is_file():
        raise ValueError(f"{label} does not exist or is not a file")
    return path.resolve()


def _require_directory(value: Any, label: str, *, create: bool = False) -> Path:
    raw_value = str(value or "").strip()
    if not raw_value:
        raise ValueError(f"{label} is required")
    path = Path(raw_value).expanduser()
    if create:
        path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory")
    return path.resolve()


def _ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("FFmpeg was not found in the application tools or PATH")
    return path


def _available_path(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Unable to allocate an output filename for {path.name}")


def _subprocess_detail(error: subprocess.CalledProcessError) -> str:
    detail = (error.stderr or error.stdout or "").strip()
    return detail[-2000:] if detail else f"FFmpeg exited with status {error.returncode}"


def _run_ffmpeg(arguments: list[str]) -> None:
    subprocess.run(
        [_ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "error", *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def ffprobe_path() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise RuntimeError("FFprobe was not found in the application tools or PATH")
    return path


def run_process(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
