from __future__ import annotations

import inspect
import os
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from worker_models import model_to_dict
from worker_protocol import emit, emit_error
from worker_proxy import (
    ProxyConfigError,
    load_proxy_config,
    parse_proxy_config,
    proxy_urlopen,
    redacted_proxy,
)


def _emit_download_log(task_id: str | None, level: str, message: str, **extra: Any) -> None:
    payload: dict[str, Any] = {"level": level, "message": message}
    payload.update(extra)
    emit("download_log", payload, task_id=task_id)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _align_aria2_with_proxy(pymss_download: Any, task_id: str | None) -> None:
    """Make the aria2 downloader obey the same proxy as the rest of the worker.

    aria2 is a separate process that reads only the ``*_proxy`` environment variables. It has no
    SOCKS support, and it does not consult the OS proxy settings that urllib discovers on
    Windows and macOS. Left alone it connects directly — which behind a mandatory proxy is a
    failure, and behind an optional one is worse: traffic the user believed was tunnelled goes
    out in the clear. Where aria2 cannot be made to comply, urllib takes over instead.

    Args:
        pymss_download (Any): The imported ``pymss.model_download`` module.
        task_id (str | None): Task id used for progress logs.

    Returns:
        None: This callable completes for its side effects."""
    if not pymss_download.ARIA2C_PATH:
        return

    config = load_proxy_config()
    if config.scheme in {"socks5", "socks5h"}:
        # PySocks swaps the socket class inside this process only; a child process is unaffected.
        pymss_download.ARIA2C_PATH = None
        _emit_download_log(task_id, "info", "SOCKS proxy configured; downloading via urllib, which aria2c cannot do")
        return
    if config.mode != "system":
        # "custom" already exported the variables aria2 reads, and "none" deliberately cleared them.
        return

    discovered = urllib.request.getproxies()
    proxy_url = discovered.get("https") or discovered.get("http")
    if not proxy_url:
        return
    parts = urlsplit(proxy_url)
    if parts.scheme not in {"http", "https"}:
        pymss_download.ARIA2C_PATH = None
        _emit_download_log(task_id, "info", "System proxy is not HTTP; downloading via urllib, which aria2c cannot do")
        return
    for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        os.environ.setdefault(name, proxy_url)
    # Credentials in a proxy URL must not reach the log.
    _emit_download_log(task_id, "info", f"Using the system proxy for aria2c: {parts.hostname}:{parts.port or ''}")


def _pymss_reports_progress(download_model: Any) -> bool:
    """Whether the installed pymss can report download progress to its caller.

    The callback landed in pymss after this app shipped, so the version actually installed in a
    runtime environment may predate it. Passing an argument it does not accept would raise
    TypeError and fail the download outright, which is a much worse outcome than a coarse bar.
    """
    try:
        return "progress_callback" in inspect.signature(download_model).parameters
    except (TypeError, ValueError):
        return False


def _watch_download_progress(
    *,
    files: list[tuple[str, Path]],
    expected_sizes: dict[str, int],
    already_done: set[str],
    stop: threading.Event,
    emit_progress: Any,
    count_partial_bytes: bool,
) -> None:
    """Report progress by watching the files pymss is writing.

    Used when the installed pymss cannot report progress itself. What it does guarantee is where
    the bytes land — `files_for_model` names every destination, and a partial download sits
    beside it as `<dest>.part`. Sampling those sizes gives a percentage without reaching into how
    the transfer is done.

    `count_partial_bytes` says whether the partial file's size means anything yet. It only does
    when the downloader grows the file as bytes arrive, which urllib does and aria2 does not:
    aria2 preallocates, so the file reaches its full size in the first second and a bar built on
    it would jump to 100% and sit there for the rest of the download. Counting whole files is
    coarse, but it never claims to be finished when it is not.
    """
    poll_interval = 0.4
    # Rate over a short trailing window: an average over the whole transfer barely moves once a
    # large file is underway, which is useless for telling a slow connection from a stalled one.
    window_started_at = time.monotonic()
    window_start_bytes = -1
    # Held across iterations: the window only closes every few polls, and a rate recomputed from
    # scratch each time would report zero on every poll in between.
    speed = 0.0

    while not stop.is_set():
        downloaded_by_file: dict[str, int] = {}
        completed = 0
        for _relpath, dest in files:
            key = str(dest)
            if key in already_done:
                size = expected_sizes.get(key, 0) or (dest.stat().st_size if dest.is_file() else 0)
                downloaded_by_file[key] = size
                completed += 1
                continue
            if dest.is_file():
                downloaded_by_file[key] = dest.stat().st_size
                completed += 1
                continue
            if not count_partial_bytes:
                downloaded_by_file[key] = 0
                continue
            partial = dest.with_name(dest.name + ".part")
            try:
                downloaded_by_file[key] = partial.stat().st_size if partial.is_file() else 0
            except OSError:
                downloaded_by_file[key] = 0

        downloaded_sum = sum(downloaded_by_file.values())
        total_sum = sum(expected_sizes.get(str(dest), 0) for _relpath, dest in files)

        now = time.monotonic()
        elapsed = now - window_started_at
        if window_start_bytes < 0:
            window_start_bytes = downloaded_sum
        elif elapsed >= 0.8:
            speed = max(0.0, (downloaded_sum - window_start_bytes) / elapsed)
            window_started_at = now
            window_start_bytes = downloaded_sum

        emit_progress(
            downloaded_bytes=downloaded_sum,
            total_bytes=total_sum,
            completed_files=completed,
            speed_bytes_per_second=speed,
        )
        stop.wait(poll_interval)


def _make_pymss_progress_adapter(
    *,
    skipped_bytes: int,
    skipped_files: int,
    total_bytes: int,
    emit_progress: Any,
) -> Any:
    """Turn pymss's per-file callback into one figure for the whole model.

    pymss reports bytes for the file it is currently working on and does not say which file that
    is. It does work through them one at a time, so a count that drops is the signal that one
    finished and the next began — enough to keep a running total without matching names. Files
    that were already valid never produce a callback at all, so their bytes seed the total.
    """
    finished_bytes = skipped_bytes
    finished_files = skipped_files
    current_done = 0
    # Rate over a short trailing window: an average over the whole transfer barely moves once a
    # large file is underway, which is useless for telling a slow connection from a stalled one.
    window_started_at = time.monotonic()
    window_start_bytes = skipped_bytes
    speed = 0.0

    def on_progress(done: int, _total: int, _message: str) -> None:
        nonlocal finished_bytes, finished_files, current_done
        nonlocal window_started_at, window_start_bytes, speed

        if done < current_done:
            finished_bytes += current_done
            finished_files += 1
        current_done = done
        downloaded = finished_bytes + current_done

        now = time.monotonic()
        elapsed = now - window_started_at
        if elapsed >= 0.8:
            speed = max(0.0, (downloaded - window_start_bytes) / elapsed)
            window_started_at = now
            window_start_bytes = downloaded

        emit_progress(
            downloaded_bytes=downloaded,
            total_bytes=total_bytes,
            completed_files=finished_files,
            speed_bytes_per_second=speed,
        )

    return on_progress


def cmd_download_model(payload: dict[str, Any]) -> int:
    """Download a model.

    The transfer itself belongs to pymss: which files a model needs, where they come from, which
    downloader to use, retries, resume and validation are all its decisions. This command
    schedules that work and reports on it — it does not move any bytes itself.
    """
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
        from pymss import model_download as pymss_model_download  # type: ignore
        from pymss.model_download import (  # type: ignore
            _already_valid,
            _expected_size_and_hash,
            download_model,
            fetch_modelscope_file_index,
            files_for_model,
        )
        from pymss.model_registry import model_root  # type: ignore
    except Exception as exc:
        return emit_error("PYMSS_IMPORT_FAILED", str(exc), traceback.format_exc(), task_id=task_id)

    stop_watching = threading.Event()
    watcher: threading.Thread | None = None
    try:
        _align_aria2_with_proxy(pymss_model_download, task_id)

        entry, files = files_for_model(model_name, model_dir)
        total_files = max(1, len(files))
        emit("download_started", {
            "model": entry.name,
            "source": source,
            "force": force,
            "totalFiles": total_files,
            "completedFiles": 0,
            "progress": 0,
        }, task_id=task_id)
        emit("download_stage", {"stage": "resolving_files", "progress": 5}, task_id=task_id)

        # The file index carries the published sizes, which is what turns a byte count into a
        # percentage. Its absence is not fatal — progress then falls back to counting files.
        index = None
        try:
            index = fetch_modelscope_file_index(timeout=timeout) if endpoint is None else None
        except Exception as exc:
            _emit_download_log(task_id, "warning", f"File index unavailable, progress will be approximate: {exc}")

        expected_sizes: dict[str, int] = {}
        already_done: set[str] = set()
        for relpath, dest in files:
            expected_size, expected_sha256 = _expected_size_and_hash(relpath, index)
            expected_sizes[str(dest)] = int(expected_size or 0)
            if not force and _already_valid(dest, expected_size, expected_sha256):
                already_done.add(str(dest))
            _emit_download_log(
                task_id,
                "info",
                f"[{len(expected_sizes)}/{total_files}] {relpath}"
                + (f", {expected_size / 1048576:.1f} MB" if expected_size else ""),
            )

        last_emitted_progress = -1
        last_emitted_files = -1

        def emit_progress(
            *,
            downloaded_bytes: int,
            total_bytes: int,
            completed_files: int,
            speed_bytes_per_second: float,
        ) -> None:
            nonlocal last_emitted_progress, last_emitted_files
            if total_bytes > 0:
                progress = min(95, max(8, int(downloaded_bytes / total_bytes * 95)))
            else:
                progress = min(95, max(8, int((completed_files / total_files) * 95)))
            # Byte counts move constantly, and pymss's callback can fire several times a second
            # on a fast link. Only re-emit when the bar would actually change or a file finishes,
            # so the UI is not woken for updates it would render identically.
            if progress == last_emitted_progress and completed_files == last_emitted_files:
                return
            last_emitted_progress = progress
            last_emitted_files = completed_files
            emit("download_progress", {
                "model": entry.name,
                "completedFiles": completed_files,
                "totalFiles": total_files,
                "aggregateDownloadedBytes": downloaded_bytes,
                "aggregateTotalBytes": total_bytes,
                "speedBytesPerSecond": speed_bytes_per_second,
                "progress": progress,
            }, task_id=task_id)

        emit("download_stage", {
            "stage": "downloading_files",
            "progress": 8,
            "message": "Downloading model files",
        }, task_id=task_id)

        # Where the progress numbers come from depends on what the installed pymss can tell us.
        # Asking it directly is exact; watching the files it writes is a fallback, and how much
        # that fallback can say depends on which downloader pymss picks.
        download_kwargs: dict[str, Any] = {
            "model_dir": model_dir,
            "source": source,
            "endpoint": endpoint,
            "force": force,
            "timeout": timeout,
        }
        if _pymss_reports_progress(download_model):
            download_kwargs["progress_callback"] = _make_pymss_progress_adapter(
                skipped_bytes=sum(expected_sizes.get(key, 0) for key in already_done),
                skipped_files=len(already_done),
                total_bytes=sum(expected_sizes.values()),
                emit_progress=emit_progress,
            )
        else:
            uses_aria2 = bool(getattr(pymss_model_download, "ARIA2C_PATH", None))
            if uses_aria2:
                # This combination cannot work. A pymss without progress reporting is also a
                # pymss that runs aria2c without capturing it, so aria2's per-second summary
                # lands on this worker's stdout — the JSON event channel — and the first such
                # line makes the host abort the task. Say so here, before it happens, so the
                # log carries the cause rather than a parse error.
                _emit_download_log(
                    task_id,
                    "error",
                    "Installed pymss is too old: it does not capture aria2c's output, which "
                    "corrupts this worker's event stream and will abort the download. "
                    "Upgrade pymss, or remove aria2c from PATH to fall back to urllib.",
                )
            watcher = threading.Thread(
                target=_watch_download_progress,
                kwargs={
                    "files": files,
                    "expected_sizes": expected_sizes,
                    "already_done": already_done,
                    "stop": stop_watching,
                    "emit_progress": emit_progress,
                    "count_partial_bytes": not uses_aria2,
                },
                daemon=True,
            )
            watcher.start()

        result = download_model(model_name, **download_kwargs)
    except KeyError as exc:
        # An unknown model name is the caller's mistake, not a transfer failure, and the UI tells
        # the two apart by this code.
        return emit_error("MODEL_NOT_FOUND", str(exc), task_id=task_id)
    except Exception as exc:
        return emit_error("MODEL_DOWNLOAD_FAILED", str(exc), traceback.format_exc(), task_id=task_id)
    finally:
        stop_watching.set()
        if watcher is not None:
            watcher.join(timeout=2)

    # A file is only known to be finished once the next one starts, so the last file of the set
    # is still counted as in flight when the call returns. Settle the count before the UI reads
    # it for the last time.
    settled_bytes = sum(expected_sizes.values())
    emit_progress(
        downloaded_bytes=settled_bytes,
        total_bytes=settled_bytes,
        completed_files=total_files,
        speed_bytes_per_second=0.0,
    )

    downloaded = [str(item) for item in (result.get("downloaded") or [])]
    skipped = [str(item) for item in (result.get("skipped") or [])]
    emit("download_stage", {
        "stage": "verifying",
        "progress": 97,
        "message": "Verifying downloaded files",
    }, task_id=task_id)
    emit("download_done", {
        "model": entry.name,
        "downloaded": downloaded,
        "skipped": skipped,
        "modelDir": str(model_root(model_dir)),
        "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        "progress": 100,
    }, task_id=task_id)
    return 0
def _test_url_for_source(source: str) -> str:
    urls = {
        "modelscope": "https://www.modelscope.cn/api/v1/models/baicai1145/pymss/repo/files?Revision=master&Recursive=true",
        "huggingface": "https://huggingface.co/api/models/baicai1145/pymss",
        "hf-mirror": "https://hf-mirror.com/api/models/baicai1145/pymss",
    }
    return urls.get(source, urls["modelscope"])


def cmd_test_connection(payload: dict[str, Any]) -> int:
    mode = str(payload.get("mode") or "system").strip()
    raw_url = str(payload.get("url") or "")
    bypass = payload.get("bypass") or ""
    source = str(payload.get("source") or "modelscope").strip()
    timeout = _safe_int(payload.get("timeout"), 15) or 15
    try:
        config = parse_proxy_config({"mode": mode, "url": raw_url, "bypass": bypass})
    except ProxyConfigError as exc:
        emit("test_connection_result", {
            "ok": False,
            "code": exc.code,
            "error": str(exc),
            "elapsedMs": 0,
            "mode": mode,
            "proxy": raw_url,
        })
        return 0
    try:
        # The test payload is authoritative even if the debounced settings sync
        # has not reached Rust yet.
        from worker_proxy import configure_process_proxy
        configure_process_proxy(config)
    except ProxyConfigError as exc:
        emit("test_connection_result", {
            "ok": False,
            "code": exc.code,
            "error": str(exc),
            "elapsedMs": 0,
            "mode": mode,
            "proxy": raw_url,
        })
        return 0
    test_url = _test_url_for_source(source)
    started = time.time()
    try:
        with proxy_urlopen(test_url, timeout, config) as response:
            import json as _json
            status_code = getattr(response, "status", 200)
            raw = response.read().decode("utf-8", errors="replace")
            elapsed = time.time() - started
            ip_addr = ""
            try:
                ip_addr = response.fp.raw._sock.getpeername()[0] if hasattr(response, "fp") else ""
            except Exception:
                pass
            data = {}
            try:
                data = _json.loads(raw) if raw else {}
            except Exception:
                pass
            files_count = len(data.get("Data", {}).get("Files", [])) if isinstance(data, dict) else 0
            emit("test_connection_result", {
                "ok": True,
                "status": int(status_code),
                "ip": ip_addr,
                "filesCount": files_count,
                "elapsedMs": int(elapsed * 1000),
                "mode": mode,
                "proxy": redacted_proxy(config),
            })
            return 0
    except Exception as exc:
        elapsed = time.time() - started
        emit("test_connection_result", {
            "ok": False,
            "error": str(exc),
            "elapsedMs": int(elapsed * 1000),
            "mode": mode,
            "proxy": redacted_proxy(config),
        })
        return 0
