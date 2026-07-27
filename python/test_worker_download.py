from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from worker_download import (
    _align_aria2_with_proxy,
    _make_pymss_progress_adapter,
    _pymss_reports_progress,
    _watch_download_progress,
    prepare_pymss_download,
)
from worker_proxy import parse_proxy_config


class Aria2ProxyAlignmentTest(unittest.TestCase):
    """aria2 runs as a child process, so it sees none of the proxy setup done in-process."""

    def _align(self, proxy, *, aria2="C:/bin/aria2c.exe", system_proxies=None, env=None):
        module = SimpleNamespace(ARIA2C_PATH=aria2)
        with mock.patch("worker_download.load_proxy_config", return_value=proxy), \
             mock.patch("worker_download.urllib.request.getproxies", return_value=system_proxies or {}), \
             mock.patch.dict(os.environ, env or {}, clear=True), \
             mock.patch("worker_download.emit"):
            _align_aria2_with_proxy(module, "task")
            # patch.dict restores os.environ on exit, so snapshot it while still inside.
            return module, dict(os.environ)

    def test_socks_proxy_takes_aria2_out_of_the_picture(self):
        # PySocks only patches sockets in this process; aria2 would connect directly.
        proxy = parse_proxy_config({"mode": "custom", "url": "socks5://127.0.0.1:1080", "bypass": ""})
        module, _env = self._align(proxy)

        self.assertIsNone(module.ARIA2C_PATH)

    def test_system_http_proxy_is_handed_to_aria2(self):
        # urllib finds this in the OS settings; aria2 only ever reads the environment.
        proxy = parse_proxy_config({"mode": "system", "url": "", "bypass": ""})
        module, env = self._align(proxy, system_proxies={"http": "http://127.0.0.1:7890"})

        self.assertEqual(module.ARIA2C_PATH, "C:/bin/aria2c.exe")
        # Windows folds environment variable names to upper case, POSIX does not, and aria2
        # accepts either -- so assert on the name without caring which case survived.
        exported = {name.lower(): value for name, value in env.items()}
        self.assertEqual(exported.get("http_proxy"), "http://127.0.0.1:7890")
        self.assertEqual(exported.get("https_proxy"), "http://127.0.0.1:7890")

    def test_system_socks_proxy_falls_back_to_urllib(self):
        proxy = parse_proxy_config({"mode": "system", "url": "", "bypass": ""})
        module, _env = self._align(proxy, system_proxies={"http": "socks5://127.0.0.1:1080"})

        self.assertIsNone(module.ARIA2C_PATH)

    def test_no_system_proxy_leaves_the_fast_downloader_alone(self):
        # The common case: nothing configured, so aria2 stays available.
        proxy = parse_proxy_config({"mode": "system", "url": "", "bypass": ""})
        module, env = self._align(proxy, system_proxies={})

        self.assertEqual(module.ARIA2C_PATH, "C:/bin/aria2c.exe")
        self.assertEqual(env, {})

    def test_custom_http_proxy_is_left_to_the_environment_already_exported(self):
        proxy = parse_proxy_config({"mode": "custom", "url": "http://127.0.0.1:8080", "bypass": ""})
        module, _env = self._align(proxy)

        self.assertEqual(module.ARIA2C_PATH, "C:/bin/aria2c.exe")

    def test_does_nothing_when_aria2_is_not_installed(self):
        proxy = parse_proxy_config({"mode": "custom", "url": "socks5://127.0.0.1:1080", "bypass": ""})
        module, env = self._align(proxy, aria2=None)

        self.assertIsNone(module.ARIA2C_PATH)
        self.assertEqual(env, {})


class PymssCapabilityTest(unittest.TestCase):
    """Which progress source is usable depends on the pymss actually installed."""

    def test_detects_a_pymss_that_accepts_the_callback(self):
        def new_style(model_name, model_dir=None, progress_callback=None):
            pass

        self.assertTrue(_pymss_reports_progress(new_style))

    def test_detects_a_pymss_that_predates_the_callback(self):
        def old_style(model_name, model_dir=None):
            pass

        self.assertFalse(_pymss_reports_progress(old_style))

    def test_treats_an_unintrospectable_callable_as_unsupported(self):
        # Some builtins have no retrievable signature; guessing yes would raise TypeError at the
        # call site and fail the download outright.
        self.assertFalse(_pymss_reports_progress(print))

    def test_old_pymss_with_aria2_falls_back_before_stdout_is_corrupted(self):
        def old_style(model_name, model_dir=None):
            pass

        module = SimpleNamespace(ARIA2C_PATH="C:/bin/aria2c.exe")
        proxy = parse_proxy_config({"mode": "system", "url": "", "bypass": ""})
        with mock.patch("worker_download.load_proxy_config", return_value=proxy), \
             mock.patch("worker_download.urllib.request.getproxies", return_value={}), \
             mock.patch("worker_download.emit"):
            prepare_pymss_download(module, "task", old_style)

        self.assertIsNone(module.ARIA2C_PATH)

    def test_new_pymss_keeps_aria2_when_proxy_allows_it(self):
        def new_style(model_name, model_dir=None, progress_callback=None):
            pass

        module = SimpleNamespace(ARIA2C_PATH="C:/bin/aria2c.exe")
        proxy = parse_proxy_config({"mode": "system", "url": "", "bypass": ""})
        with mock.patch("worker_download.load_proxy_config", return_value=proxy), \
             mock.patch("worker_download.urllib.request.getproxies", return_value={}), \
             mock.patch("worker_download.emit"):
            prepare_pymss_download(module, "task", new_style)

        self.assertEqual(module.ARIA2C_PATH, "C:/bin/aria2c.exe")


class ProgressAdapterTest(unittest.TestCase):
    """pymss reports one file at a time; the UI shows one bar for the whole model."""

    def _collect(self, **kwargs):
        seen: list[dict] = []
        adapter = _make_pymss_progress_adapter(emit_progress=lambda **kw: seen.append(kw), **kwargs)
        return adapter, seen

    def test_accumulates_across_files_when_the_byte_count_restarts(self):
        adapter, seen = self._collect(skipped_bytes=0, skipped_files=0, total_bytes=300)
        # 0..100 is the first file; the drop back to 0 is the only signal that a second began.
        for done in (0, 50, 100, 0, 60, 200):
            adapter(done, 0, "")

        self.assertEqual([kw["downloaded_bytes"] for kw in seen], [0, 50, 100, 100, 160, 300])
        self.assertEqual([kw["completed_files"] for kw in seen], [0, 0, 0, 1, 1, 1])

    def test_files_that_were_already_valid_seed_the_total(self):
        # pymss never calls back for a file it skips, so those bytes have to be counted up front.
        adapter, seen = self._collect(skipped_bytes=500, skipped_files=2, total_bytes=600)
        adapter(50, 0, "")

        self.assertEqual(seen[0]["downloaded_bytes"], 550)
        self.assertEqual(seen[0]["completed_files"], 2)


class PartialFileWatcherTest(unittest.TestCase):
    """The fallback for a pymss that cannot report progress itself."""

    def _watch_once(self, *, count_partial_bytes: bool) -> dict:
        tmp = Path(tempfile.mkdtemp())
        dest = tmp / "model.pth"
        # aria2 preallocates, so a barely-started download already sits at its full size.
        (tmp / "model.pth.part").write_bytes(b"x" * 120)

        seen: list[dict] = []
        stop = threading.Event()

        def emit_progress(**kwargs):
            seen.append(kwargs)
            stop.set()  # one pass is all the assertions need

        _watch_download_progress(
            files=[("vr/model.pth", dest)],
            expected_sizes={str(dest): 120},
            already_done=set(),
            stop=stop,
            emit_progress=emit_progress,
            count_partial_bytes=count_partial_bytes,
        )
        return seen[0]

    def test_counts_partial_bytes_when_the_downloader_grows_the_file(self):
        result = self._watch_once(count_partial_bytes=True)

        self.assertEqual(result["downloaded_bytes"], 120)

    def test_ignores_partial_bytes_that_would_report_a_finished_download(self):
        result = self._watch_once(count_partial_bytes=False)

        self.assertEqual(result["downloaded_bytes"], 0)
        self.assertEqual(result["completed_files"], 0)


if __name__ == "__main__":
    unittest.main()
