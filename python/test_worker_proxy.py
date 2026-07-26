import os
import unittest

from worker_download import _test_url_for_source
from worker_proxy import ProxyConfigError, aria2_proxy_args, configure_process_proxy, parse_proxy_config, redacted_proxy


class ProxyConfigTests(unittest.TestCase):
    def test_http_proxy_with_credentials_is_redacted(self):
        config = parse_proxy_config({"mode": "custom", "url": "https://user:secret@example.com:8443"})
        self.assertEqual(redacted_proxy(config), "https://example.com:8443")
        self.assertIn("--all-proxy=https://example.com:8443", aria2_proxy_args(config))
        self.assertIn("--all-proxy-user=user", aria2_proxy_args(config))
        self.assertIn("--all-proxy-pass=secret", aria2_proxy_args(config))

    def test_socks5_and_socks5h_have_distinct_dns_modes(self):
        for scheme, remote_dns in (("socks5", "false"), ("socks5h", "true")):
            config = parse_proxy_config({"mode": "custom", "url": f"{scheme}://127.0.0.1:1080"})
            self.assertIn(f"--socks5-remote-name-resolve={remote_dns}", aria2_proxy_args(config))

    def test_bypass_accepts_common_separators(self):
        config = parse_proxy_config({"mode": "custom", "url": "127.0.0.1:7890", "bypass": "localhost; 127.0.0.1\n*.local"})
        self.assertEqual(config.bypass, ("localhost", "127.0.0.1", "*.local"))

    def test_invalid_proxy_url_has_stable_error_code(self):
        with self.assertRaises(ProxyConfigError) as raised:
            parse_proxy_config({"mode": "custom", "url": "ftp://127.0.0.1:21"})
        self.assertEqual(raised.exception.code, "UNSUPPORTED_PROXY_SCHEME")

    def test_connection_url_follows_download_source(self):
        self.assertIn("modelscope.cn", _test_url_for_source("modelscope"))
        self.assertIn("huggingface.co", _test_url_for_source("huggingface"))
        self.assertIn("hf-mirror.com", _test_url_for_source("hf-mirror"))


class SocksRoutingTests(unittest.TestCase):
    """Downloading is delegated to pymss, which calls urllib.request.urlopen directly. urllib
    rejects a socks5:// proxy value outright, so a SOCKS proxy has to reach it some other way."""

    def setUp(self):
        import socket
        self._socket = socket.socket
        self._env = {k: os.environ.get(k) for k in
                     ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy")}
        self.addCleanup(self._restore)

    def _restore(self):
        import socket
        socket.socket = self._socket
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_a_socks_proxy_replaces_the_socket_layer(self):
        import socket
        try:
            import socks
        except ImportError:
            self.skipTest("PySocks is not installed for this interpreter")
        configure_process_proxy(parse_proxy_config(
            {"mode": "custom", "url": "socks5://127.0.0.1:1080", "bypass": ""}))
        self.assertIs(socket.socket, socks.socksocket)

    def test_socks_clears_the_proxy_variables_urllib_would_choke_on(self):
        try:
            import socks  # noqa: F401
        except ImportError:
            self.skipTest("PySocks is not installed for this interpreter")
        os.environ["HTTP_PROXY"] = "http://stale:1"
        configure_process_proxy(parse_proxy_config(
            {"mode": "custom", "url": "socks5://127.0.0.1:1080", "bypass": ""}))
        # Leaving socks5:// in these makes urllib fail with "unknown url type" before the
        # socket layer ever gets a chance.
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            self.assertIsNone(os.environ.get(name), name)

    def test_an_http_proxy_still_travels_by_environment(self):
        configure_process_proxy(parse_proxy_config(
            {"mode": "custom", "url": "http://127.0.0.1:7890", "bypass": ""}))
        self.assertEqual(os.environ.get("HTTP_PROXY"), "http://127.0.0.1:7890")
        self.assertEqual(os.environ.get("https_proxy"), "http://127.0.0.1:7890")


if __name__ == "__main__":
    unittest.main()
