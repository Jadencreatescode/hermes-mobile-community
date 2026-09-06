"""Platform-neutral connector adapters for connected harness agents."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from plugins.harness_agents.policy import fetch_agent_card, fetch_json

_CONNECTOR_OPERATIONS = (
    "probe",
    "start_or_resume",
    "send",
    "steer",
    "interrupt",
    "get_state",
    "get_messages",
    "list_models",
    "set_model",
    "close",
)


@runtime_checkable
class Connector(Protocol):
    def probe(self) -> dict[str, Any]: ...

    def start_or_resume(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def send(
        self, message: str, *, native_session_id: str = "", request_id: str | None = None
    ) -> dict[str, Any]: ...

    def steer(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def interrupt(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def get_state(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def get_messages(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def list_models(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def set_model(self, *args: Any, **kwargs: Any) -> dict[str, Any]: ...

    def close(self) -> dict[str, Any]: ...


def _sanitize_reply(text: str) -> str:
    """Remove credential-shaped text before returning to callers."""
    from plugins.harness_agents.manifest import redact_agent_text

    return redact_agent_text(text)


def _sanitize_result(value: Any) -> Any:
    """Recursively remove credentials from untrusted connector data."""
    if isinstance(value, str):
        return _sanitize_reply(value)
    if isinstance(value, list):
        return [_sanitize_result(item) for item in value]
    if isinstance(value, dict):
        secret_keys = {
            "token",
            "accesstoken",
            "apikey",
            "credential",
            "credentials",
            "secret",
            "password",
            "authorization",
            "cookie",
            "bearer",
        }

        def normalized_key(key: Any) -> str:
            return "".join(
                character for character in str(key).casefold() if character.isalnum()
            )

        sanitized: dict[Any, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if normalized_key(key) in secret_keys:
                continue
            safe_key = _sanitize_reply(key_text)
            if "[REDACTED]" in safe_key:
                continue
            sanitized[safe_key] = _sanitize_result(item)
        return sanitized
    return value


class A2AConnector:
    """Bound one verified agent record to A2A JSON-RPC 1.0 transport."""

    def __init__(
        self,
        *,
        name: str,
        url: str,
        timeout: int = 120,
        expected_harness: str = "",
        allowlist: set[str] | frozenset[str] | None = None,
    ) -> None:
        self.name = name.strip()
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.expected_harness = expected_harness
        self._allowlist = allowlist
        self._supported_operations: frozenset[str] = frozenset()
        self._verified_card: dict[str, Any] | None = None
        if not self.name or not self.url:
            raise ValueError("connector name and URL are required")
        if timeout < 1 or timeout > 1_320:
            raise ValueError("connector timeout is outside its bound")

    def __repr__(self) -> str:
        return f"A2AConnector(name={self.name!r}, url={self.url!r}, timeout={self.timeout!r})"

    def _rpc_url(self) -> str:
        """Resolve the JSON-RPC endpoint from the verified card."""
        if self._verified_card is not None:
            interfaces = self._verified_card.get("supportedInterfaces") or []
            for interface in interfaces:
                if (
                    isinstance(interface, dict)
                    and interface.get("protocolBinding") == "JSONRPC"
                    and interface.get("url")
                ):
                    return str(interface["url"])
            if isinstance(self._verified_card.get("url"), str):
                return self._verified_card["url"]
        return self.url

    def _unsupported(self, operation: str) -> dict[str, Any]:
        return {
            "supported": False,
            "operation": operation,
            "reason": "unsupported_by_a2a_connector",
        }

    def _invoke_operation(self, operation: str, **params: Any) -> dict[str, Any]:
        if self._verified_card is None:
            return self._unsupported(operation)
        if operation not in self._supported_operations:
            return self._unsupported(operation)
        request_id = params.pop("request_id", None) or f"{operation}-{id(self)}"
        rpc_url = self._rpc_url()
        response = fetch_json(
            rpc_url,
            allowlist=self._allowlist,
            method="POST",
            body={
                "jsonrpc": "2.0",
                "id": request_id,
                "method": f"hermes/{operation}",
                "params": params,
            },
        )
        if "error" in response:
            raise RuntimeError(f"connector {operation} failed")
        result = response.get("result")
        if not isinstance(result, dict):
            raise ValueError(f"connector {operation} returned an invalid result")
        return _sanitize_result(result)

    def start_or_resume(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("start_or_resume", **kwargs)

    def steer(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("steer", **kwargs)

    def interrupt(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("interrupt", **kwargs)

    def get_state(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("get_state", **kwargs)

    def get_messages(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("get_messages", **kwargs)

    def list_models(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("list_models", **kwargs)

    def set_model(self, *_args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._invoke_operation("set_model", **kwargs)

    def close(self) -> dict[str, Any]:
        return self._invoke_operation("close")

    def probe(self) -> dict[str, Any]:
        """Verify an A2A v1 JSON-RPC card and normalize its advertised skills."""
        card = fetch_agent_card(self.url, allowlist=self._allowlist)
        interfaces = card.get("supportedInterfaces") or []
        jsonrpc_v1 = any(
            isinstance(interface, dict)
            and str(interface.get("protocolBinding") or "").upper() == "JSONRPC"
            and str(interface.get("protocolVersion") or "").startswith("1.0")
            for interface in interfaces
        )
        if not jsonrpc_v1:
            raise ValueError("connector does not advertise A2A JSON-RPC version 1.0")
        for interface in interfaces:
            if not isinstance(interface, dict):
                continue
            endpoint = interface.get("url")
            if isinstance(endpoint, str):
                # Policy already enforced during fetch; origin match is a sanity check.
                parsed_endpoint = endpoint.rstrip("/")
                parsed_self = self.url.rstrip("/")
                if parsed_endpoint != parsed_self and not parsed_endpoint.startswith(
                    parsed_self + "/"
                ):
                    raise ValueError(
                        "connector task interface crossed its configured origin"
                    )
        self._verified_card = card

        native_agent_id = str(card.get("name") or "").strip()
        if not native_agent_id:
            raise ValueError("connector Agent Card has no name")

        self._supported_operations = frozenset({"probe", "send"})
        skills = []
        for skill in card.get("skills") or []:
            if not isinstance(skill, dict):
                continue
            value = str(skill.get("id") or skill.get("name") or "").strip()
            if value and value not in skills:
                skills.append(value)

        card_capabilities = card.get("capabilities") or {}
        return {
            "verified": True,
            "native_agent_id": native_agent_id,
            "name": native_agent_id,
            "description": str(card.get("description") or "").strip(),
            "protocol": "a2a-jsonrpc-1.0",
            "capabilities": ["chat.send"],
            "operations": sorted(self._supported_operations),
            "skills": skills,
            "features": {
                "streaming": bool(card_capabilities.get("streaming")),
                "push_notifications": bool(card_capabilities.get("pushNotifications")),
            },
        }

    def send(
        self, message: str, *, native_session_id: str = "", request_id: str | None = None
    ) -> dict[str, str]:
        """Send one turn and preserve the peer's native A2A context id."""
        text = message.strip()
        if not text:
            raise ValueError("message is required")
        connector_event_id = request_id or f"send-{id(self)}"
        rpc_url = self._rpc_url()
        response = fetch_json(
            rpc_url,
            allowlist=self._allowlist,
            method="POST",
            body={
                "jsonrpc": "2.0",
                "id": connector_event_id,
                "method": "SendMessage",
                "params": {
                    "message": {
                        "role": "user",
                        "parts": [{"type": "text", "text": text}],
                    },
                    "contextId": native_session_id.strip() or None,
                },
            },
        )
        if "error" in response:
            err = response["error"]
            raise RuntimeError(
                f"send failed: {err.get('message', err) if isinstance(err, dict) else err}"
            )
        result = response.get("result", {})
        reply = ""
        state = ""
        context_id = native_session_id.strip()
        if isinstance(result, dict):
            artifacts = result.get("artifacts") or []
            for artifact in artifacts:
                if isinstance(artifact, dict) and artifact.get("type") == "text":
                    reply = str(artifact.get("text") or "").strip()
                    break
            if not reply:
                status = result.get("status") or {}
                msg = status.get("message")
                if isinstance(msg, dict):
                    reply = str(msg.get("text") or "").strip()
                else:
                    reply = str(msg or "").strip()
            context_id = result.get("contextId") or context_id
            state = (result.get("status") or {}).get("state", "")
        reply = _sanitize_reply(reply)
        normalized_state = (
            state.replace("TASK_STATE_", "").replace("_", "-").lower()
            if state
            else "unknown"
        )
        return {
            "reply": reply,
            "native_session_id": context_id,
            "state": normalized_state,
            "connector_event_id": connector_event_id,
        }


def connector_factory(
    *, connector_type: str, harness: str = "", **kwargs: Any
) -> Connector:
    """Create a public-safe A2A connector."""
    if connector_type != "a2a":
        raise ValueError("unsupported connector type")
    return A2AConnector(**kwargs)
