from __future__ import annotations

import argparse
import asyncio
import io
import re
from http.cookies import SimpleCookie
from pathlib import Path
from typing import AsyncIterator

from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, WSMsgType, web
from multidict import CIMultiDict
from yarl import URL

_HOP_BY_HOP = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
_NODE_ID = re.compile(r"^[a-z0-9-]+$")
_BACKEND_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
MAX_REQUEST_BYTES = 64 * 1024 * 1024

STATIC_ROOT = web.AppKey("static_root", Path)
UPSTREAM = web.AppKey("upstream", URL)
NODES = web.AppKey("nodes", dict[str, URL])
READ_ONLY_NODES = web.AppKey("read_only_nodes", frozenset[str])
CLIENT = web.AppKey("client", ClientSession)


def _node_cookie_prefix(node_id: str) -> str:
    return f"hermes_{node_id}__"


def _forward_headers(
    headers,
    *,
    node_id: str | None = None,
    websocket: bool = False,
    upstream: URL | None = None,
) -> CIMultiDict[str]:
    forwarded: CIMultiDict[str] = CIMultiDict()
    for name, value in headers.items():
        lower = name.lower()
        if lower in _HOP_BY_HOP or lower.startswith("sec-websocket-") or (node_id and lower == "cookie"):
            continue
        if websocket and lower == "origin" and upstream is not None:
            forwarded.add("Origin", str(upstream.origin()))
        else:
            forwarded.add(name, value)

    if node_id:
        incoming = SimpleCookie()
        incoming.load(headers.get("Cookie", ""))
        prefix = _node_cookie_prefix(node_id)
        scoped = [f"{name[len(prefix):]}={morsel.coded_value}" for name, morsel in incoming.items() if name.startswith(prefix)]
        if scoped:
            forwarded["Cookie"] = "; ".join(scoped)

    return forwarded


def _scoped_set_cookie(raw: str, node_id: str) -> list[str]:
    parsed = SimpleCookie()
    parsed.load(raw)
    prefix = _node_cookie_prefix(node_id)
    result: list[str] = []
    for name, morsel in parsed.items():
        parts = [f"{prefix}{name}={morsel.coded_value}", f"Path=/nodes/{node_id}"]
        for source, label in (("expires", "Expires"), ("max-age", "Max-Age"), ("samesite", "SameSite")):
            if morsel[source]:
                parts.append(f"{label}={morsel[source]}")
        if morsel["secure"]:
            parts.append("Secure")
        if morsel["httponly"]:
            parts.append("HttpOnly")
        result.append("; ".join(parts))
    return result


def _response_headers(headers, *, node_id: str | None = None) -> CIMultiDict[str]:
    copied: CIMultiDict[str] = CIMultiDict()
    for name, value in headers.items():
        lower = name.lower()
        if lower in _HOP_BY_HOP or lower == "set-cookie":
            continue
        if node_id and lower == "location" and value.startswith("/"):
            value = f"/nodes/{node_id}{value}"
        copied.add(name, value)

    set_cookies = headers.getall("Set-Cookie", [])
    for raw in set_cookies:
        if node_id:
            for scoped in _scoped_set_cookie(raw, node_id):
                copied.add("Set-Cookie", scoped)
        else:
            copied.add("Set-Cookie", raw)
    return copied


def _origin(value: str) -> URL:
    url = URL(value)
    if url.scheme not in {"http", "https"} or not url.host:
        raise ValueError("Relay upstreams must be fixed http or https origins")
    return url.origin()


def create_relay_app(
    *,
    static_root: Path,
    upstream: str,
    backend_id: str = "local",
    backend_label: str = "Local Hermes",
    nodes: dict[str, str] | None = None,
    read_only_nodes: set[str] | None = None,
) -> web.Application:
    root = static_root.resolve(strict=True)
    index = root / "index.html"
    if not index.is_file():
        raise ValueError(f"Desktop renderer index is missing: {index}")

    upstream_origin = _origin(upstream)
    if not _BACKEND_ID.fullmatch(backend_id):
        raise ValueError(f"Invalid backend id: {backend_id}")
    if not backend_label or backend_label != backend_label.strip() or len(backend_label) > 80:
        raise ValueError("Backend label must contain 1-80 trimmed characters")
    node_origins: dict[str, URL] = {}
    for node_id, value in (nodes or {}).items():
        if not _NODE_ID.fullmatch(node_id):
            raise ValueError(f"Invalid fixed node id: {node_id}")
        node_origins[node_id] = _origin(value)

    app = web.Application(client_max_size=MAX_REQUEST_BYTES)
    app[STATIC_ROOT] = root
    app[UPSTREAM] = upstream_origin
    app[NODES] = node_origins
    unknown_read_only = set(read_only_nodes or ()) - node_origins.keys()
    if unknown_read_only:
        raise ValueError(f"Read-only nodes are not registered: {sorted(unknown_read_only)}")
    app[READ_ONLY_NODES] = frozenset(read_only_nodes or ())

    async def client_session_context(application: web.Application) -> AsyncIterator[None]:
        timeout = ClientTimeout(total=120, connect=15)
        async with ClientSession(timeout=timeout, cookie_jar=DummyCookieJar()) as session:
            application[CLIENT] = session
            yield

    app.cleanup_ctx.append(client_session_context)

    def target(request: web.Request, origin: URL, backend_path: str | None = None) -> URL:
        url = origin.with_path(backend_path or request.path)
        return url.with_query(request.query_string) if request.query_string else url

    def node_target(request: web.Request) -> tuple[str, URL, str]:
        node_id = request.match_info["node"]
        origin = request.app[NODES].get(node_id)
        if origin is None:
            raise web.HTTPNotFound(text="Unknown Hermes node")
        backend_path = "/" + request.match_info.get("path", "").lstrip("/")
        return node_id, origin, backend_path

    async def proxy_http_to(request: web.Request, origin: URL, *, node_id: str | None = None, backend_path: str | None = None):
        session = request.app[CLIENT]
        body = await request.read() if request.can_read_body else b""
        async with session.request(
            request.method,
            target(request, origin, backend_path),
            headers=_forward_headers(request.headers, node_id=node_id),
            data=io.BytesIO(body) if body else None,
            allow_redirects=False,
        ) as response:
            payload = await response.read()
            return web.Response(
                body=payload,
                status=response.status,
                reason=response.reason,
                headers=_response_headers(response.headers, node_id=node_id),
            )

    async def proxy_http(request: web.Request) -> web.Response:
        return await proxy_http_to(request, request.app[UPSTREAM])

    async def proxy_node_http(request: web.Request) -> web.Response:
        node_id, origin, backend_path = node_target(request)
        if node_id in request.app[READ_ONLY_NODES] and not (
            request.method == "GET" and backend_path == "/api/status"
        ):
            raise web.HTTPForbidden(text="This Hermes node is read only")
        return await proxy_http_to(request, origin, node_id=node_id, backend_path=backend_path)

    async def proxy_websocket_to(
        request: web.Request,
        origin: URL,
        *,
        node_id: str | None = None,
        backend_path: str | None = None,
    ) -> web.WebSocketResponse:
        session = request.app[CLIENT]
        upstream_ws = await session.ws_connect(
            target(request, origin, backend_path),
            headers=_forward_headers(request.headers, node_id=node_id, websocket=True, upstream=origin),
            autoping=True,
            heartbeat=30,
        )
        downstream = web.WebSocketResponse(autoping=True, heartbeat=30)
        await downstream.prepare(request)

        async def client_to_upstream() -> None:
            async for message in downstream:
                if message.type == WSMsgType.TEXT:
                    await upstream_ws.send_str(message.data)
                elif message.type == WSMsgType.BINARY:
                    await upstream_ws.send_bytes(message.data)
                elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR}:
                    break

        async def upstream_to_client() -> None:
            async for message in upstream_ws:
                if message.type == WSMsgType.TEXT:
                    await downstream.send_str(message.data)
                elif message.type == WSMsgType.BINARY:
                    await downstream.send_bytes(message.data)
                elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR}:
                    break

        tasks = [asyncio.create_task(client_to_upstream()), asyncio.create_task(upstream_to_client())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*done, *pending, return_exceptions=True)
        await upstream_ws.close()
        await downstream.close()
        return downstream

    async def proxy_websocket(request: web.Request) -> web.WebSocketResponse:
        return await proxy_websocket_to(request, request.app[UPSTREAM])

    async def proxy_node_websocket(request: web.Request) -> web.WebSocketResponse:
        node_id = request.match_info["node"]
        origin = request.app[NODES].get(node_id)
        if origin is None:
            raise web.HTTPNotFound(text="Unknown Hermes node")
        if node_id in request.app[READ_ONLY_NODES]:
            raise web.HTTPForbidden(text="This Hermes node is read only")
        return await proxy_websocket_to(request, origin, node_id=node_id, backend_path="/api/ws")

    async def serve_renderer(request: web.Request) -> web.StreamResponse:
        relative = request.match_info.get("path", "")
        candidate = (root / relative).resolve()
        if candidate.is_relative_to(root) and candidate.is_file():
            return web.FileResponse(candidate)
        return web.FileResponse(index, headers={"Cache-Control": "no-store"})

    async def runtime_descriptor(request: web.Request) -> web.Response:
        return web.json_response(
            {"version": 1, "backend": {"id": backend_id, "label": backend_label}},
            headers={"Cache-Control": "no-store"},
        )

    app.router.add_get("/.well-known/hermes-mobile-runtime.json", runtime_descriptor)
    app.router.add_get("/nodes/{node}/api/ws", proxy_node_websocket)
    app.router.add_route("*", "/nodes/{node}/{path:.*}", proxy_node_http)
    app.router.add_get("/api/ws", proxy_websocket)
    app.router.add_route("*", "/api/{path:.*}", proxy_http)
    app.router.add_route("*", "/auth/{path:.*}", proxy_http)
    app.router.add_route("*", "/login", proxy_http)
    app.router.add_get("/{path:.*}", serve_renderer)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Disposable Hermes mobile relay")
    parser.add_argument("--static-root", type=Path, required=True)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--backend-id", default="local")
    parser.add_argument("--backend-label", default="Local Hermes")
    parser.add_argument("--node", action="append", default=[], metavar="ID=URL")
    parser.add_argument("--read-only-node", action="append", default=[], metavar="ID")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4175)
    args = parser.parse_args()
    nodes: dict[str, str] = {}
    for item in args.node:
        if "=" not in item:
            parser.error("--node must use ID=URL")
        node_id, value = item.split("=", 1)
        nodes[node_id] = value
    web.run_app(
        create_relay_app(
            static_root=args.static_root,
            upstream=args.upstream,
            backend_id=args.backend_id,
            backend_label=args.backend_label,
            nodes=nodes,
            read_only_nodes=set(args.read_only_node),
        ),
        host=args.host,
        port=args.port,
        access_log=None,
    )


if __name__ == "__main__":
    main()
