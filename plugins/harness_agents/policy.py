"""Public-safe policy for connected harness agents.

Destination allowlist default-deny, SSRF guards, bounded timeouts/size,
no redirects, HTTPS only.
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import urllib.error
import urllib.request
from types import MappingProxyType
from typing import AbstractSet, Any, Final, Mapping
from urllib.parse import urlsplit, urlunsplit

ALL_CAPABILITIES: Final[frozenset[str]] = frozenset(
    {
        "agent.view",
        "chat.read",
        "chat.send",
        "run.assign",
        "run.steer",
        "run.interrupt",
        "model.change",
        "instructions.change",
        "schedule.manage",
        "knowledge.share",
        "message.external",
        "computer.control",
        "spend.approve",
        "publish.external",
        "team.manage",
        "agent.create",
        "agent.delete",
    }
)

ROLE_PRESETS: Final[Mapping[str, frozenset[str]]] = MappingProxyType(
    {
        "admin": ALL_CAPABILITIES,
        "operator": frozenset(
            {
                "agent.view",
                "chat.read",
                "chat.send",
                "run.assign",
                "run.steer",
                "run.interrupt",
            }
        ),
        "viewer": frozenset({"agent.view", "chat.read"}),
    }
)

# --------------------------------------------------------------------------
# SSRF / destination policy
# --------------------------------------------------------------------------

_CONNECT_TIMEOUT_S = 10
_READ_TIMEOUT_S = 30
_MAX_RESPONSE_BYTES = 1_000_000

_BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(net)
    for net in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "0.0.0.0/8",
        "100.64.0.0/10",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "255.255.255.255/32",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
        "::/128",
        "2001:db8::/32",
    )
)

_METADATA_HOSTS = frozenset(
    {
        "metadata",
        "metadata.google.internal",
        "169.254.169.254",
        "100.100.100.200",
    }
)

_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})


def _is_blocked_address(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if the address belongs to a blocked private/link-local range."""
    if addr.is_loopback or addr.is_link_local or addr.is_multicast:
        return True
    if addr.is_private or addr.is_reserved or addr.is_unspecified:
        return True
    for network in _BLOCKED_NETWORKS:
        if addr.version == network.version and addr in network:
            return True
    return False


def _is_metadata_host(hostname: str) -> bool:
    host = hostname.casefold().rstrip(".").split(":", 1)[0]
    if host in _METADATA_HOSTS:
        return True
    if host.startswith("metadata.") or host.endswith(".metadata"):
        return True
    return False


def resolve_capabilities(
    role: str,
    *,
    grants: AbstractSet[str] = frozenset(),
    denies: AbstractSet[str] = frozenset(),
) -> frozenset[str]:
    """Resolve a role preset with validated explicit grants and denies."""
    if role not in ROLE_PRESETS:
        raise ValueError(f"unknown role: {role}")

    for values in (grants, denies):
        if any(
            not isinstance(capability, str) or capability not in ALL_CAPABILITIES
            for capability in values
        ):
            raise ValueError("unknown capability in policy override")

    if role == "admin":
        return ALL_CAPABILITIES

    return frozenset((ROLE_PRESETS[role] | grants) - denies)


def validate_url(
    url: str,
    *,
    allowlist: AbstractSet[str] | None = None,
    require_https: bool = True,
) -> tuple[str, str, int]:
    """Validate a URL against public-safe destination policy.

    Returns (scheme, host, port).  Raises ValueError on policy violation.
    """
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise ValueError("URL is invalid or too long")
    if any(ord(ch) < 32 for ch in url):
        raise ValueError("URL contains control characters")

    parsed = urlsplit(url.strip())
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("URL must have a scheme and host")

    scheme = parsed.scheme.casefold()
    if require_https and scheme != "https":
        raise ValueError("URL must use HTTPS")
    if scheme not in {"http", "https"}:
        raise ValueError("URL scheme is not allowed")

    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain credentials")

    host = str(parsed.hostname).casefold().rstrip(".")
    if _is_metadata_host(host):
        raise ValueError("URL points to a metadata service")

    if allowlist is not None:
        allowed_hosts = {h.casefold().rstrip(".") for h in allowlist}
        if host not in allowed_hosts:
            raise ValueError("URL host is not in the allowlist")

    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("URL port is invalid") from exc

    # Resolve and block private/link-local addresses
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            results = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise ValueError("URL destination could not be resolved") from exc
        addresses = {
            ipaddress.ip_address(str(result[4][0]).split("%", 1)[0])
            for result in results
        }
        if not addresses:
            raise ValueError("URL destination resolved to no addresses")
        if any(_is_blocked_address(address) for address in addresses):
            raise ValueError("URL destination resolves to a blocked address")
    else:
        if _is_blocked_address(literal):
            raise ValueError("URL destination is a blocked address")

    return scheme, host, port


def _build_opener() -> urllib.request.OpenerDirector:
    """Build an urllib opener that rejects redirects."""
    handlers = [
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(),
    ]
    return urllib.request.build_opener(*handlers)


def _no_redirect_handler(opener: urllib.request.OpenerDirector) -> None:
    """urllib does not follow redirects by default for custom openers,
    but we also intercept HTTPError for redirect codes and treat them
    as policy violations.
    """


class _NoRedirectProcessor(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.get_full_url(), code, msg, headers, fp)

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


def fetch_json(
    url: str,
    *,
    allowlist: AbstractSet[str] | None = None,
    headers: dict[str, str] | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch a JSON response with SSRF guards and bounded size.

    Raises ValueError for policy violations or malformed responses.
    """
    validate_url(url, allowlist=allowlist, require_https=True)

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if data is not None:
        req_headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(
        url,
        data=data,
        headers=req_headers,
        method=method,
    )

    opener = urllib.request.build_opener(_NoRedirectProcessor)
    try:
        with opener.open(
            req, timeout=_CONNECT_TIMEOUT_S
        ) as resp:
            # Headers arrived within the connect bound. Widen the socket
            # timeout to the read bound for the bounded body read below.
            # The attribute chain is CPython internals; if it is ever
            # unavailable the connect timeout still bounds the read, so a
            # failure here degrades safely and must not abort the fetch.
            try:
                resp.fp.raw._sock.settimeout(_READ_TIMEOUT_S)
            except (AttributeError, OSError, TypeError):
                pass
            # Re-validate the final URL if it differed from the request
            final_url = resp.geturl()
            if final_url != url:
                validate_url(final_url, allowlist=allowlist, require_https=True)

            # Bounded read
            content = resp.read(_MAX_RESPONSE_BYTES + 1)
            if len(content) > _MAX_RESPONSE_BYTES:
                raise ValueError("response exceeds the maximum allowed size")
            if not content:
                return {}
            return json.loads(content.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in _REDIRECT_CODES:
            raise ValueError("redirects are not allowed") from exc
        raise ValueError(f"HTTP error {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"request failed: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError("response is not valid JSON") from exc


def fetch_agent_card(
    base_url: str,
    *,
    allowlist: AbstractSet[str] | None = None,
) -> dict[str, Any]:
    """Fetch an A2A Agent Card from well-known discovery URLs."""
    for path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
        url = base_url.rstrip("/") + path
        try:
            return fetch_json(url, allowlist=allowlist)
        except ValueError:
            continue
    raise ValueError("agent card could not be discovered")
