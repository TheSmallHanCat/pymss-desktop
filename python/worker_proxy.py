from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

ProxyMode = Literal["system", "none", "custom"]
SUPPORTED_SCHEMES = {"http", "https", "socks5", "socks5h"}


class ProxyConfigError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ProxyConfig:
    mode: ProxyMode
    url: str = ""
    bypass: tuple[str, ...] = ()

    @property
    def scheme(self) -> str:
        return urlsplit(self.url).scheme.lower()

    @property
    def remote_dns(self) -> bool:
        return self.scheme == "socks5h"


def _normalize_url(value: str) -> str:
    value = value.strip()
    if value and "://" not in value:
        value = f"http://{value}"
    if not value:
        return ""
    parts = urlsplit(value)
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path, parts.query, parts.fragment))


def _normalize_bypass(value: Any) -> tuple[str, ...]:
    if isinstance(value, (list, tuple)):
        values = value
    else:
        values = str(value or "").replace(";", ",").replace("\n", ",").split(",")
    result: list[str] = []
    for item in values:
        item = str(item).strip()
        if item and item not in result:
            result.append(item)
    return tuple(result)


def parse_proxy_config(value: Any) -> ProxyConfig:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ProxyConfigError("INVALID_PROXY_CONFIG", "Proxy configuration is not valid JSON") from exc
    if not isinstance(value, dict):
        value = {}
    mode = str(value.get("mode") or "system").strip().lower()
    if mode not in {"system", "none", "custom"}:
        raise ProxyConfigError("INVALID_PROXY_MODE", f"Unsupported proxy mode: {mode}")
    url = _normalize_url(str(value.get("url") or "")) if mode == "custom" else ""
    bypass = _normalize_bypass(value.get("bypass"))
    if mode == "custom":
        if not url:
            raise ProxyConfigError("INVALID_PROXY_URL", "Proxy URL is empty")
        parts = urlsplit(url)
        if parts.scheme not in SUPPORTED_SCHEMES:
            raise ProxyConfigError("UNSUPPORTED_PROXY_SCHEME", f"Unsupported proxy scheme: {parts.scheme}")
        if not parts.hostname:
            raise ProxyConfigError("INVALID_PROXY_URL", "Proxy host is missing")
        try:
            port = parts.port
        except ValueError as exc:
            raise ProxyConfigError("INVALID_PROXY_PORT", "Proxy port is invalid") from exc
        if port is None or not 1 <= port <= 65535:
            raise ProxyConfigError("INVALID_PROXY_PORT", "Proxy port must be between 1 and 65535")
        if parts.scheme.startswith("socks"):
            try:
                import socks  # type: ignore
            except ImportError as exc:
                raise ProxyConfigError("SOCKS_SUPPORT_UNAVAILABLE", "PySocks is required for SOCKS5 proxies") from exc
            del socks
    return ProxyConfig(mode=mode, url=url, bypass=bypass)  # type: ignore[arg-type]


def load_proxy_config() -> ProxyConfig:
    raw = os.environ.get("PYMSS_STUDIO_PROXY_CONFIG", "")
    if raw:
        return parse_proxy_config(raw)
    mode = os.environ.get("PYMSS_STUDIO_PROXY_MODE", "system")
    url = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
    bypass = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    return parse_proxy_config({"mode": mode, "url": url, "bypass": bypass})


def _set_bypass_env(config: ProxyConfig) -> None:
    value = ",".join(config.bypass)
    os.environ["NO_PROXY"] = value
    os.environ["no_proxy"] = value


def configure_process_proxy(config: ProxyConfig) -> None:
    """Configure urllib and third-party libraries once for this worker process."""
    if config.mode == "none":
        os.environ["NO_PROXY"] = "*"
        os.environ["no_proxy"] = "*"
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            os.environ.pop(name, None)
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        return
    if config.mode == "system":
        return
    _set_bypass_env(config)
    os.environ["HTTP_PROXY"] = config.url
    os.environ["HTTPS_PROXY"] = config.url
    os.environ["http_proxy"] = config.url
    os.environ["https_proxy"] = config.url
    if config.scheme in {"http", "https"}:
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({
            "http": config.url,
            "https": config.url,
        })))
        return
    if config.scheme in {"socks5", "socks5h"}:
        # urllib rejects a socks5:// value outright ("unknown url type"), so the variables that
        # carry it have to go before the socket layer can quietly do the work instead.
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            os.environ.pop(name, None)
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        _route_all_sockets_through_socks(config)


def _route_all_sockets_through_socks(config: ProxyConfig) -> None:
    """Send every outbound socket in this process through the SOCKS proxy.

    Environment variables are enough for an HTTP proxy, but urllib does not understand a
    socks5:// URL at all — it fails with "unknown url type: socks5". Downloading is handled by
    pymss, which calls urllib.request.urlopen directly, so there is no call site left to special
    case. Redirecting the socket layer is what makes the proxy apply to code this process does
    not own.

    Failure is deliberately silent: PySocks is an optional dependency, and a worker that cannot
    proxy should still report a connection error from the attempt rather than fail to start.
    """
    try:
        import socket

        import socks  # type: ignore
    except Exception:
        return
    parts = urlsplit(config.url)
    if not parts.hostname:
        return
    socks.set_default_proxy(
        socks.SOCKS5,
        parts.hostname,
        parts.port or 1080,
        # socks5h defers name resolution to the proxy, which is the point of choosing it.
        rdns=config.scheme == "socks5h",
        username=parts.username or None,
        password=parts.password or None,
    )
    socket.socket = _bypass_aware_socket_class(socks)
    socket.create_connection = _bypass_aware_create_connection(socket.create_connection)


# The host currently being connected to, by name. socket.create_connection resolves the name to
# an address before it ever builds a socket, so by the time connect() runs the name is gone --
# and a bypass list is written in names. This carries it across those two steps, per thread
# because downloads and the UI's own requests can be in flight at the same time.
_connect_target = threading.local()


def _host_is_bypassed(host: str) -> bool:
    """Whether NO_PROXY says this host should skip the proxy."""
    if not host:
        return False
    try:
        return bool(urllib.request.proxy_bypass_environment(str(host)))
    except Exception:
        return False


def _bypass_aware_create_connection(original: Any) -> Any:
    """Wrap socket.create_connection so the socket layer can see the hostname.

    Args:
        original (Any): The stock ``socket.create_connection``.

    Returns:
        Any: A drop-in replacement that records its target before delegating."""

    def create_connection(address, *args, **kwargs):
        previous = getattr(_connect_target, "host", None)
        _connect_target.host = address[0] if isinstance(address, (tuple, list)) and address else None
        try:
            return original(address, *args, **kwargs)
        finally:
            _connect_target.host = previous

    return create_connection


def _bypass_aware_socket_class(socks: Any) -> type:
    """Build a SOCKS socket class that still honours the bypass list.

    PySocks sends every connection to the proxy; a bypass list is not a concept it has. The
    variable that carries one, NO_PROXY, is read by urllib's HTTP layer, which a SOCKS
    connection never reaches — so without this the entries a user listed, typically localhost
    and their own network, would be tunnelled anyway.

    Args:
        socks (Any): The imported PySocks module.

    Returns:
        type: A ``socks.socksocket`` subclass that connects directly to bypassed hosts."""

    class BypassAwareSocksSocket(socks.socksocket):
        def connect(self, dest_pair, *args, **kwargs):
            # Prefer the name recorded by create_connection; fall back to whatever connect was
            # handed, which is already a name when PySocks is used directly.
            host = getattr(_connect_target, "host", None)
            if host is None and isinstance(dest_pair, (tuple, list)) and dest_pair:
                host = dest_pair[0]
            if _host_is_bypassed(host):
                # Reach past PySocks to the plain socket rather than clearing the proxy on this
                # instance: a socket that gets reused would otherwise stay un-proxied. Note that
                # _BaseSocket, not socket.socket, is the original class — the latter is this very
                # subclass by now.
                return socks._BaseSocket.connect(self, dest_pair)
            return super().connect(dest_pair, *args, **kwargs)

    return BypassAwareSocksSocket


def proxy_urlopen(url: str, timeout: int, config: ProxyConfig | None = None):
    config = config or load_proxy_config()
    if config.mode != "custom" or config.scheme not in {"socks5", "socks5h"}:
        return urllib.request.urlopen(url, timeout=timeout)
    import requests
    from requests.utils import should_bypass_proxies

    no_proxy = ",".join(config.bypass)
    bypass = should_bypass_proxies(url, no_proxy=no_proxy or None)
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(
            url,
            stream=True,
            timeout=timeout,
            proxies={} if bypass else {"http": config.url, "https": config.url},
        )
        response.raise_for_status()
        response.raw.decode_content = True
    except requests.RequestException as exc:
        session.close()
        # Keep the download retry/error pipeline transport-agnostic.
        raise urllib.error.URLError(str(exc)) from exc
    return _RequestsResponse(response, session)


class _RequestsResponse:
    def __init__(self, response: Any, session: Any) -> None:
        self._response = response
        self._session = session
        self.headers = response.headers
        self.status = response.status_code

    def read(self, size: int = -1) -> bytes:
        return self._response.raw.read(size)

    def __enter__(self):
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self._response.close()
        self._session.close()


def aria2_proxy_args(config: ProxyConfig) -> list[str]:
    if config.mode == "none":
        return ["--all-proxy="]
    if config.mode == "system":
        return []
    parts = urlsplit(config.url)
    args: list[str] = []
    if parts.scheme in {"http", "https"}:
        netloc = parts.hostname or ""
        if parts.port:
            netloc = f"{netloc}:{parts.port}"
        args.append(f"--all-proxy={urlunsplit((parts.scheme, netloc, '', '', ''))}")
        if parts.username:
            args.append(f"--all-proxy-user={parts.username}")
        if parts.password:
            args.append(f"--all-proxy-pass={parts.password}")
    else:
        args.append(f"--socks5-proxy={parts.hostname}:{parts.port}")
        args.append(f"--socks5-remote-name-resolve={'true' if config.remote_dns else 'false'}")
        if parts.username:
            args.append(f"--socks5-proxy-user={parts.username}")
        if parts.password:
            args.append(f"--socks5-proxy-pass={parts.password}")
    if config.bypass:
        args.append(f"--no-proxy={','.join(config.bypass)}")
    return args


def redacted_proxy(config: ProxyConfig) -> str:
    if config.mode != "custom":
        return config.mode
    parts = urlsplit(config.url)
    host = parts.hostname or "?"
    return f"{parts.scheme}://{host}:{parts.port}"
