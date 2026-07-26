import unittest

from worker_download import _test_url_for_source
from worker_bootstrap import _module_available
from worker_proxy import ProxyConfigError, aria2_proxy_args, parse_proxy_config, redacted_proxy


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

    def test_bootstrap_module_mapping_uses_import_names(self):
        self.assertTrue(_module_available("pymss_core"))


if __name__ == "__main__":
    unittest.main()
