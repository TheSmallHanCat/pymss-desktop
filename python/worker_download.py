from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from worker_models import model_to_dict
from worker_protocol import emit, emit_error

_ARIA2_PROGRESS_PATTERN = re.compile(
    r"\[#.*?\s+(?P<downloaded>[\d.]+\s*[KMGTPE]?i?B|[\d.]+\s*B)/"
    r"(?P<total>[\d.]+\s*[KMGTPE]?i?B|[\d.]+\s*B)"
    r"\((?P<percent>\d+)%\).*?DL:(?P<speed>[\d.]+\s*[KMGTPE]?i?B/s|[\d.]+\s*B/s)",
    re.IGNORECASE,
)


class DownloadValidationError(RuntimeError):
    pass


def _aria2c_env() -> dict[str, str] | None:
    env = os.environ.copy()
    changed = False
    openssl_conf = env.get("PYMSS_STUDIO_OPENSSL_CONF")
    openssl_modules = env.get("PYMSS_STUDIO_OPENSSL_MODULES")
    if openssl_conf:
        env["OPENSSL_CONF"] = openssl_conf
        changed = True
    if openssl_modules:
        env["OPENSSL_MODULES"] = openssl_modules
        changed = True
    return env if changed else None


def _aria2c_is_usable(path: str) -> bool:
    try:
        result = subprocess.run(
            [path, "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=_aria2c_env(),
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _resolve_aria2c_path() -> str | None:
    seen: set[str] = set()
    for search_dir in os.get_exec_path():
        candidate = shutil.which("aria2c", path=search_dir)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if _aria2c_is_usable(candidate):
            return candidate
    return None


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_human_bytes(value: str | None) -> int:
    if not value:
        return 0
    text = str(value).strip().replace(" ", "")
    match = re.fullmatch(r"(?P<number>\d+(?:\.\d+)?)(?P<unit>[KMGTPE]?i?B|B)(?:/s)?", text, re.IGNORECASE)
    if not match:
        return 0
    number = float(match.group("number"))
    unit = match.group("unit").upper()
    scale_map = {
        "B": 1,
        "KIB": 1024,
        "MIB": 1024**2,
        "GIB": 1024**3,
        "TIB": 1024**4,
        "PIB": 1024**5,
        "EIB": 1024**6,
        "KB": 1000,
        "MB": 1000**2,
        "GB": 1000**3,
        "TB": 1000**4,
        "PB": 1000**5,
        "EB": 1000**6,
    }
    return int(number * scale_map.get(unit, 1))


def _parse_aria2_progress_line(line: str) -> dict[str, int | float] | None:
    match = _ARIA2_PROGRESS_PATTERN.search(line or "")
    if not match:
        return None
    downloaded_bytes = _parse_human_bytes(match.group("downloaded"))
    total_bytes = _parse_human_bytes(match.group("total"))
    speed_bytes = _parse_human_bytes(match.group("speed"))
    percent = _safe_int(match.group("percent"))
    if total_bytes <= 0 and downloaded_bytes > 0 and percent > 0:
        total_bytes = int(downloaded_bytes / max(percent / 100.0, 0.01))
    return {
        "downloaded_bytes": downloaded_bytes,
        "total_bytes": total_bytes,
        "speed_bytes_per_second": float(speed_bytes),
        "percent": percent,
    }


def _emit_download_progress_payload(
    callback: Any,
    *,
    event: str,
    path: Path,
    file_index: int,
    total_files: int,
    completed_files: int,
    downloaded_bytes: int,
    total_bytes: int,
    speed_bytes_per_second: float = 0.0,
    percent: float | int | None = None,
) -> None:
    callback({
        "event": event,
        "path": str(path),
        "file_index": file_index,
        "total_files": total_files,
        "completed_files": completed_files,
        "downloaded_bytes": max(0, downloaded_bytes),
        "total_bytes": max(0, total_bytes),
        "speed_bytes_per_second": max(0.0, float(speed_bytes_per_second or 0.0)),
        "percent": None if percent is None else max(0.0, min(100.0, float(percent))),
    })


def _download_file_with_progress_urllib(
    *,
    url: str,
    dest: Path,
    expected_size: int | None,
    expected_sha256: str,
    timeout: int,
    file_index: int,
    total_files: int,
    completed_before: int,
    progress_callback: Any,
    cleanup_partial_download: Any,
    validate_downloaded_file: Any,
) -> Path:
    tmp = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            total_bytes = _safe_int(response.headers.get("content-length")) or (expected_size or 0)
            downloaded_bytes = 0
            _emit_download_progress_payload(
                progress_callback,
                event="file_start",
                path=dest,
                file_index=file_index,
                total_files=total_files,
                completed_files=completed_before,
                downloaded_bytes=0,
                total_bytes=total_bytes,
            )
            with open(tmp, "wb") as file_obj:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    file_obj.write(chunk)
                    downloaded_bytes += len(chunk)
                    _emit_download_progress_payload(
                        progress_callback,
                        event="file_progress",
                        path=dest,
                        file_index=file_index,
                        total_files=total_files,
                        completed_files=completed_before,
                        downloaded_bytes=downloaded_bytes,
                        total_bytes=total_bytes,
                    )
        validate_downloaded_file(tmp, dest, expected_size, expected_sha256)
        os.replace(tmp, dest)
        final_total = expected_size or downloaded_bytes or (dest.stat().st_size if dest.is_file() else 0)
        _emit_download_progress_payload(
            progress_callback,
            event="file_done",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before + 1,
            downloaded_bytes=final_total,
            total_bytes=final_total,
        )
        return dest
    except Exception:
        cleanup_partial_download(tmp)
        raise


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _cleanup_partial_download(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _validate_downloaded_file(
    path: Path,
    dest: Path,
    expected_size: int | None,
    expected_sha256: str,
) -> None:
    if expected_size is not None and path.stat().st_size != expected_size:
        raise DownloadValidationError(
            f"size mismatch for {dest.name}: expected {expected_size}, got {path.stat().st_size}"
        )
    if expected_sha256:
        actual = _sha256(path)
        if actual != expected_sha256:
            raise DownloadValidationError(
                f"sha256 mismatch for {dest.name}: expected {expected_sha256}, got {actual}"
            )


def _download_file_with_progress_aria2(
    *,
    aria2c_path: str,
    url: str,
    dest: Path,
    expected_size: int | None,
    expected_sha256: str,
    timeout: int,
    file_index: int,
    total_files: int,
    completed_before: int,
    progress_callback: Any,
    cleanup_partial_download: Any,
    validate_downloaded_file: Any,
) -> Path:
    tmp = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        aria2c_path,
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--continue=true",
        "--enable-color=false",
        "--console-log-level=notice",
        "--show-console-readout=true",
        "--summary-interval=1",
        "--max-connection-per-server=16",
        "--split=16",
        "--min-split-size=1M",
        "--max-tries=3",
        f"--connect-timeout={timeout}",
        f"--timeout={timeout}",
        "--dir",
        str(tmp.parent),
        "--out",
        tmp.name,
        url,
    ]
    process = None
    existing_partial_size = int(tmp.stat().st_size) if tmp.is_file() else 0
    last_downloaded = existing_partial_size
    last_total = max(expected_size or 0, existing_partial_size)
    last_speed = 0.0
    progress_lock = threading.Lock()
    stop_progress_poll = threading.Event()

    def emit_polled_progress(
        downloaded_bytes: int,
        total_bytes: int | None = None,
        speed_bytes: float | None = None,
    ) -> None:
        resolved_total = max(total_bytes or 0, expected_size or 0, downloaded_bytes)
        _emit_download_progress_payload(
            progress_callback,
            event="file_progress",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before,
            downloaded_bytes=downloaded_bytes,
            total_bytes=resolved_total,
            speed_bytes_per_second=speed_bytes if speed_bytes is not None else last_speed,
            percent=(downloaded_bytes / resolved_total * 100.0) if resolved_total > 0 else None,
        )

    def poll_partial_file_progress() -> None:
        nonlocal last_downloaded
        last_polled_size = -1
        while not stop_progress_poll.wait(0.4):
            try:
                if not tmp.is_file():
                    continue
                current_size = int(tmp.stat().st_size)
            except Exception:
                continue
            if current_size <= 0 or current_size == last_polled_size:
                continue
            last_polled_size = current_size
            with progress_lock:
                if current_size > last_downloaded:
                    last_downloaded = current_size
                current_total = max(last_total, expected_size or 0, current_size)
                current_speed = last_speed
            emit_polled_progress(last_downloaded, current_total, current_speed)

    poller = threading.Thread(target=poll_partial_file_progress, name=f"aria2-progress-{dest.name}", daemon=True)
    try:
        _emit_download_progress_payload(
            progress_callback,
            event="file_start",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before,
            downloaded_bytes=existing_partial_size,
            total_bytes=last_total,
            percent=(existing_partial_size / last_total * 100.0) if last_total > 0 else None,
        )
        poller.start()
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=_aria2c_env(),
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        if process.stdout is not None:
            for raw_line in process.stdout:
                parsed = _parse_aria2_progress_line(raw_line)
                if parsed is None:
                    continue
                with progress_lock:
                    last_downloaded = max(last_downloaded, _safe_int(parsed.get("downloaded_bytes")))
                    last_total = max(last_total, _safe_int(parsed.get("total_bytes")), expected_size or 0)
                    last_speed = float(parsed.get("speed_bytes_per_second") or last_speed or 0.0)
                    current_downloaded = last_downloaded
                    current_total = last_total
                    current_speed = last_speed
                emit_polled_progress(current_downloaded, current_total, current_speed)
        return_code = process.wait()
        stop_progress_poll.set()
        poller.join(timeout=1.0)
        if return_code != 0:
            raise RuntimeError(f"aria2c failed with exit code {return_code}")
        if not tmp.is_file():
            raise RuntimeError("aria2c did not create the expected output file")

        validate_downloaded_file(tmp, dest, expected_size, expected_sha256)
        os.replace(tmp, dest)
        final_total = expected_size or last_total or int(dest.stat().st_size)
        final_downloaded = final_total or last_downloaded
        _emit_download_progress_payload(
            progress_callback,
            event="file_done",
            path=dest,
            file_index=file_index,
            total_files=total_files,
            completed_files=completed_before + 1,
            downloaded_bytes=final_downloaded,
            total_bytes=final_total,
            speed_bytes_per_second=last_speed,
            percent=100.0,
        )
        return dest
    except Exception:
        stop_progress_poll.set()
        if poller.is_alive():
            poller.join(timeout=1.0)
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=2)
            except Exception:
                pass
        raise


def _download_model_with_observed_progress(
    *,
    entry: Any,
    model_dir: str | None,
    source: str,
    endpoint: str | None,
    force: bool,
    timeout: int,
    progress_callback: Any,
) -> dict[str, Any]:
    from pymss.model_download import (  # type: ignore
        DownloadError,
        _already_valid,
        _expected_size_and_hash,
        fetch_modelscope_file_index,
        files_for_model,
        remote_url,
    )

    aria2c_path = _resolve_aria2c_path()
    _, files = files_for_model(entry.name, model_dir)
    total_files = max(1, len(files))
    source_index = fetch_modelscope_file_index(timeout=timeout) if endpoint is None else None
    downloaded: list[str] = []
    skipped: list[str] = []
    completed_files = 0

    for file_index, (relpath, dest) in enumerate(files, start=1):
        expected_size, expected_sha256 = _expected_size_and_hash(relpath, source_index)
        if not force and _already_valid(dest, expected_size, expected_sha256):
            completed_files += 1
            size_bytes = expected_size or (int(dest.stat().st_size) if dest.is_file() else 0)
            _emit_download_progress_payload(
                progress_callback,
                event="file_skipped",
                path=dest,
                file_index=file_index,
                total_files=total_files,
                completed_files=completed_files,
                downloaded_bytes=size_bytes,
                total_bytes=size_bytes,
            )
            skipped.append(str(dest))
            continue

        url = remote_url(relpath, source=source, endpoint=endpoint)
        tmp = dest.with_name(dest.name + ".part")
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                if aria2c_path:
                    _download_file_with_progress_aria2(
                        aria2c_path=aria2c_path,
                        url=url,
                        dest=dest,
                        expected_size=expected_size,
                        expected_sha256=expected_sha256,
                        timeout=timeout,
                        file_index=file_index,
                        total_files=total_files,
                        completed_before=completed_files,
                        progress_callback=progress_callback,
                        cleanup_partial_download=_cleanup_partial_download,
                        validate_downloaded_file=_validate_downloaded_file,
                    )
                else:
                    _download_file_with_progress_urllib(
                        url=url,
                        dest=dest,
                        expected_size=expected_size,
                        expected_sha256=expected_sha256,
                        timeout=timeout,
                        file_index=file_index,
                        total_files=total_files,
                        completed_before=completed_files,
                        progress_callback=progress_callback,
                        cleanup_partial_download=_cleanup_partial_download,
                        validate_downloaded_file=_validate_downloaded_file,
                    )
                last_error = None
                break
            except (
                OSError,
                urllib.error.URLError,
                urllib.error.HTTPError,
                RuntimeError,
                DownloadError,
            ) as exc:
                last_error = exc
                if (not aria2c_path) or isinstance(exc, DownloadValidationError):
                    _cleanup_partial_download(tmp)
                if attempt < 2:
                    time.sleep(1.0 + attempt)
        if last_error is not None:
            raise DownloadError(f"failed to download {url}: {last_error}")
        completed_files += 1
        downloaded.append(str(dest))

    return {"entry": entry, "downloaded": downloaded, "skipped": skipped}


def cmd_download_model(payload: dict[str, Any]) -> int:
    model_name = payload.get("model")
    if not model_name:
        return emit_error("MODEL_NOT_FOUND", "Missing model name")

    task_id = payload.get("taskId") or f"download_{model_name}"
    model_dir = payload.get("modelDir") or None
    source = payload.get("source") or "modelscope"
    endpoint = payload.get("endpoint") or None
    force = bool(payload.get("force", False))
    timeout = _safe_int(payload.get("timeout"), 30)

    try:
        from pymss.model_registry import get_model_entry, model_root  # type: ignore
    except Exception as exc:
        return emit_error("PYMSS_IMPORT_FAILED", str(exc), traceback.format_exc(), task_id=task_id)

    try:
        entry = get_model_entry(model_name)
        local_state = model_to_dict(entry, model_dir, include_local_state=True)
        missing_before = local_state.get("missingPaths", [])
        total_files = max(1, len(missing_before))
        total_bytes = 0
        download_progress_state: dict[str, dict[str, Any]] = {}
        emit("download_started", {
            "model": entry.name,
            "source": source,
            "force": force,
            "totalFiles": total_files,
            "completedFiles": 0,
            "progress": 0,
        }, task_id=task_id)
        emit("download_stage", {"stage": "resolving_files", "progress": 5}, task_id=task_id)
        last_emitted_progress = -1
        last_emitted_completed = -1

        def emit_download_progress(progress_payload: dict[str, Any]) -> None:
            nonlocal total_files, total_bytes, last_emitted_progress, last_emitted_completed
            event_name = progress_payload.get("event")
            file_path = str(progress_payload.get("path") or "")
            total_files = max(total_files, int(progress_payload.get("total_files") or total_files or 1))
            file_total = int(progress_payload.get("total_bytes") or 0)
            file_downloaded = int(progress_payload.get("downloaded_bytes") or 0)
            completed_files = int(progress_payload.get("completed_files") or 0)
            speed = float(progress_payload.get("speed_bytes_per_second") or 0.0)
            file_percent_raw = progress_payload.get("percent")
            try:
                file_percent = float(file_percent_raw) if file_percent_raw is not None else None
            except (TypeError, ValueError):
                file_percent = None

            download_progress_state[file_path] = {
                "downloaded": file_downloaded,
                "total": file_total,
            }
            known_total = sum(int(item.get("total") or 0) for item in download_progress_state.values())
            downloaded_sum = sum(int(item.get("downloaded") or 0) for item in download_progress_state.values())
            total_bytes = max(total_bytes, known_total)

            if total_bytes > 0:
                progress = min(95, max(8, int(downloaded_sum / total_bytes * 95)))
            elif file_percent is not None:
                progress = min(
                    95,
                    max(
                        8,
                        int(((completed_files + max(0.0, min(100.0, file_percent)) / 100.0) / max(1, total_files)) * 95),
                    ),
                )
            else:
                progress = min(95, max(8, int((completed_files / max(1, total_files)) * 95)))

            if event_name == "file_skipped":
                emit("download_file", {
                    "status": "skipped",
                    "path": file_path,
                    "completedFiles": completed_files,
                    "totalFiles": total_files,
                    "downloadedBytes": file_total,
                    "totalBytes": file_total,
                    "aggregateDownloadedBytes": downloaded_sum,
                    "aggregateTotalBytes": total_bytes,
                    "speedBytesPerSecond": 0,
                    "progress": progress,
                }, task_id=task_id)
                return

            if event_name in {"file_start", "file_progress", "file_done"}:
                if event_name == "file_progress" and progress == last_emitted_progress and completed_files == last_emitted_completed:
                    return
                emit("download_progress", {
                    "path": file_path,
                    "fileIndex": int(progress_payload.get("file_index") or 0),
                    "completedFiles": completed_files,
                    "totalFiles": total_files,
                    "downloadedBytes": file_downloaded,
                    "totalBytes": file_total,
                    "aggregateDownloadedBytes": downloaded_sum,
                    "aggregateTotalBytes": total_bytes,
                    "speedBytesPerSecond": speed,
                    "progress": progress,
                }, task_id=task_id)
                last_emitted_progress = progress
                last_emitted_completed = completed_files
                if event_name == "file_done":
                    emit("download_file", {
                        "status": "downloaded",
                        "path": file_path,
                        "completedFiles": completed_files,
                        "totalFiles": total_files,
                        "downloadedBytes": file_total,
                        "totalBytes": file_total,
                        "aggregateDownloadedBytes": downloaded_sum,
                        "aggregateTotalBytes": total_bytes,
                        "speedBytesPerSecond": speed,
                        "progress": progress,
                    }, task_id=task_id)

        emit("download_stage", {
            "stage": "downloading_files",
            "progress": 15,
            "message": "Downloading model files",
        }, task_id=task_id)
        result = _download_model_with_observed_progress(
            entry=entry,
            model_dir=model_dir,
            source=source,
            endpoint=endpoint,
            force=force,
            timeout=timeout,
            progress_callback=emit_download_progress,
        )
        files = [(file_path, "skipped") for file_path in result.get("skipped", [])]
        files.extend((file_path, "downloaded") for file_path in result.get("downloaded", []))
        total_files = max(total_files, len(files) or 1)
        emit("download_done", {
            "model": entry.name,
            "downloaded": result.get("downloaded", []),
            "skipped": result.get("skipped", []),
            "modelDir": str(model_root(model_dir)),
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
            "progress": 100,
        }, task_id=task_id)
        return 0
    except KeyError as exc:
        return emit_error("MODEL_NOT_FOUND", str(exc), task_id=task_id)
    except Exception as exc:
        return emit_error("MODEL_DOWNLOAD_FAILED", str(exc), traceback.format_exc(), task_id=task_id)
