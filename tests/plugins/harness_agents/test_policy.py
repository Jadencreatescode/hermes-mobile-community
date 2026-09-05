"""Tests for harness_agents policy: SSRF guards, allowlist, URL validation."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from plugins.harness_agents import policy


class TestPolicyValidateUrl:
    def test_allows_https(self) -> None:
        scheme, host, port = policy.validate_url("https://example.com")
        assert scheme == "https"
        assert host == "example.com"
        assert port == 443

    def test_allows_https_with_port(self) -> None:
        scheme, host, port = policy.validate_url("https://example.com:8443")
        assert port == 8443

    def test_rejects_http_when_https_required(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            policy.validate_url("http://example.com")

    def test_allows_http_when_https_not_required(self) -> None:
        scheme, host, port = policy.validate_url(
            "http://example.com", require_https=False
        )
        assert scheme == "http"
        assert port == 80

    def test_rejects_ftp_scheme(self) -> None:
        with pytest.raises(ValueError, match="scheme"):
            policy.validate_url("ftp://example.com", require_https=False)

    def test_rejects_url_with_credentials(self) -> None:
        with pytest.raises(ValueError, match="credentials"):
            policy.validate_url("https://user:pass@example.com")

    def test_rejects_control_characters(self) -> None:
        with pytest.raises(ValueError, match="control characters"):
            policy.validate_url("https://example.com\x00evil")

    def test_rejects_too_long_url(self) -> None:
        with pytest.raises(ValueError, match="too long"):
            policy.validate_url("https://example.com/" + "x" * 3000)

    def test_rejects_empty_url(self) -> None:
        with pytest.raises(ValueError, match="invalid"):
            policy.validate_url("")

    def test_rejects_missing_scheme(self) -> None:
        with pytest.raises(ValueError, match="scheme and host"):
            policy.validate_url("//example.com")

    def test_rejects_missing_host(self) -> None:
        with pytest.raises(ValueError, match="scheme and host"):
            policy.validate_url("https://")

    def test_rejects_invalid_port(self) -> None:
        with pytest.raises(ValueError, match="port is invalid"):
            policy.validate_url("https://example.com:abc")

    def test_blocks_ipv4_loopback(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://127.0.0.1")

    def test_blocks_ipv4_private_10(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://10.0.0.1")

    def test_blocks_ipv4_private_172(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://172.16.0.1")

    def test_blocks_ipv4_private_192(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://192.168.1.1")

    def test_blocks_ipv4_link_local(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://169.254.1.1")

    def test_blocks_ipv4_zeronet(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://0.0.0.0")

    def test_blocks_ipv6_loopback(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://[::1]")

    def test_blocks_ipv6_private(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://[fc00::1]")

    def test_blocks_ipv6_link_local(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://[fe80::1]")

    def test_rejects_metadata_host_exact(self) -> None:
        with pytest.raises(ValueError, match="metadata service"):
            policy.validate_url("https://metadata.google.internal")

    def test_rejects_metadata_host_prefix(self) -> None:
        with pytest.raises(ValueError, match="metadata service"):
            policy.validate_url("https://metadata.example.com")

    def test_rejects_metadata_host_suffix(self) -> None:
        with pytest.raises(ValueError, match="metadata service"):
            policy.validate_url("https://example.metadata")

    def test_allowlist_default_deny(self) -> None:
        with pytest.raises(ValueError, match="allowlist"):
            policy.validate_url(
                "https://example.com", allowlist=frozenset({"other.com"})
            )

    def test_allowlist_explicit_allow(self) -> None:
        scheme, host, port = policy.validate_url(
            "https://example.com", allowlist=frozenset({"example.com"})
        )
        assert host == "example.com"

    def test_allowlist_case_insensitive(self) -> None:
        scheme, host, port = policy.validate_url(
            "https://EXAMPLE.COM", allowlist=frozenset({"example.com"})
        )
        assert host == "example.com"


class TestPolicyResolveCapabilities:
    def test_admin_returns_all(self) -> None:
        caps = policy.resolve_capabilities("admin")
        assert caps == policy.ALL_CAPABILITIES

    def test_viewer_returns_limited(self) -> None:
        caps = policy.resolve_capabilities("viewer")
        assert caps == frozenset({"agent.view", "chat.read"})

    def test_operator_returns_moderate(self) -> None:
        caps = policy.resolve_capabilities("operator")
        assert "agent.view" in caps
        assert "chat.send" in caps
        assert "agent.delete" not in caps

    def test_grants_add_capability(self) -> None:
        caps = policy.resolve_capabilities("viewer", grants=frozenset({"chat.send"}))
        assert "chat.send" in caps
        assert "agent.view" in caps

    def test_denies_remove_capability(self) -> None:
        caps = policy.resolve_capabilities(
            "operator", denies=frozenset({"run.interrupt"})
        )
        assert "run.interrupt" not in caps
        assert "chat.send" in caps

    def test_unknown_role_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown role"):
            policy.resolve_capabilities("superuser")

    def test_invalid_grant_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown capability"):
            policy.resolve_capabilities("viewer", grants=frozenset({"evil.hack"}))

    def test_invalid_deny_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown capability"):
            policy.resolve_capabilities("viewer", denies=frozenset({"evil.hack"}))

    def test_non_string_grant_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown capability"):
            policy.resolve_capabilities("viewer", grants=frozenset({123}))


class TestPolicyFetchJson:
    def test_rejects_http(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            policy.fetch_json("http://example.com/test")

    def test_rejects_private_destination(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.fetch_json("https://192.168.1.1/test")

    def test_rejects_redirect(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            from urllib.error import HTTPError

            mock_open.side_effect = HTTPError(
                "https://example.com", 302, "Found", {}, None
            )
            with pytest.raises(ValueError, match="redirects are not allowed"):
                policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))

    def test_rejects_oversized_response(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            mock_response = mock_open.return_value.__enter__.return_value
            mock_response.geturl.return_value = "https://example.com"
            mock_response.read.return_value = b"x" * (policy._MAX_RESPONSE_BYTES + 1)
            with pytest.raises(ValueError, match="maximum allowed size"):
                policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))

    def test_rejects_malformed_json(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            mock_response = mock_open.return_value.__enter__.return_value
            mock_response.geturl.return_value = "https://example.com"
            mock_response.read.return_value = b"not json"
            with pytest.raises(ValueError, match="not valid JSON"):
                policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))

    def test_returns_empty_for_empty_body(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            mock_response = mock_open.return_value.__enter__.return_value
            mock_response.geturl.return_value = "https://example.com"
            mock_response.read.return_value = b""
            result = policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))
            assert result == {}

    def test_returns_parsed_json(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            mock_response = mock_open.return_value.__enter__.return_value
            mock_response.geturl.return_value = "https://example.com"
            mock_response.read.return_value = json.dumps({"key": "value"}).encode()
            result = policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))
            assert result == {"key": "value"}

    def test_rejects_final_url_change(self) -> None:
        with patch("urllib.request.OpenerDirector.open") as mock_open:
            mock_response = mock_open.return_value.__enter__.return_value
            mock_response.geturl.return_value = "https://evil.com"
            mock_response.read.return_value = b"{}"
            with pytest.raises(ValueError, match="allowlist"):
                policy.fetch_json("https://example.com", allowlist=frozenset({"example.com"}))


class TestPolicyFetchAgentCard:
    def test_discovers_well_known(self) -> None:
        with patch.object(policy, "fetch_json", return_value={"name": "Agent"}) as mock_fetch:
            card = policy.fetch_agent_card("https://example.com", allowlist=frozenset({"example.com"}))
            assert card == {"name": "Agent"}
            assert any(".well-known" in call[0][0] for call in mock_fetch.call_args_list)

    def test_raises_when_not_found(self) -> None:
        with patch.object(policy, "fetch_json", side_effect=ValueError("not found")):
            with pytest.raises(ValueError, match="could not be discovered"):
                policy.fetch_agent_card("https://example.com", allowlist=frozenset({"example.com"}))
