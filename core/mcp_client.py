"""JARVIS's own MCP client, for models that have none (Hermes track 2026-09-23).

Claude Code connects to MCP servers itself (core/brain.py hands it the
registered ones). OpenAI-compatible models - local and API - had no way to
use them at all; this gives them the same servers, through the official `mcp`
package's client.

Ordinary listings and calls open short connections. REA uses PersistentClient:
its event-loop thread owns a connection across chat turns so evidence IDs stay
valid until disconnect. Servers use the same runtime configs Claude gets
(core/integrations.list_mcp_servers_runtime): http with an optional bearer key,
or a stdio command.

Every listing is also a health check (roadmap phase 6, 2026-10-06): its
result is kept on the integration (core/integrations.record_check), and a
tool held for review there - new or changed since it was pinned - is left
out of what a chat is offered.
"""
import logging
import re
import asyncio
import concurrent.futures
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)

LIST_TIMEOUT_SECONDS = 20
CALL_TIMEOUT_SECONDS = 120
# The editor's test (Phase 2 unit U5): a local command gets 8 seconds, a remote server 30, and at most 100 tools are read.
STDIO_PROBE_SECONDS = 8
REMOTE_PROBE_SECONDS = 30
MAX_PROBE_TOOLS = 100
_NAME_OK = re.compile(r"[^a-zA-Z0-9_-]")


def _target(config: dict):
    from mcp.client.stdio import StdioServerParameters
    if config.get("type") == "stdio":
        from core import accounts
        accounts.require_machine_access("A local MCP command")
        return StdioServerParameters(command=config["command"], args=list(config.get("args") or []),
                                     env=config.get("env") or None)
    headers = config.get("headers") or {}
    if config.get("type") == "sse":
        from mcp.client.sse import sse_client
        return sse_client(config["url"], headers=headers or None)
    if not headers:
        return config["url"]
    import httpx2
    from mcp.client.streamable_http import streamable_http_client
    return streamable_http_client(config["url"], http_client=httpx2.AsyncClient(headers=headers, timeout=CALL_TIMEOUT_SECONDS))


def _client(config: dict, timeout: float):
    from mcp.client import Client
    return Client(_target(config), read_timeout_seconds=timeout)


def _read_only(tool) -> Optional[bool]:
    """The server's own read-only claim for a tool, or None when it made none."""
    hint = getattr(getattr(tool, "annotations", None), "read_only_hint", None)
    return hint if isinstance(hint, bool) else None


async def list_tools(config: dict, timeout: float = LIST_TIMEOUT_SECONDS) -> list[dict]:
    """The server's tools: {"name", "description", "schema", "read_only"}."""
    async with _client(config, timeout) as client:
        result = await client.list_tools()
    return [{"name": t.name, "description": t.description or "",
             "schema": t.input_schema or {"type": "object", "properties": {}}, "read_only": _read_only(t)}
            for t in result.tools]


async def call_tool(config: dict, tool: str, arguments: dict, timeout: float = CALL_TIMEOUT_SECONDS) -> str:
    """Call one tool and return what the model reads: its text content, with
    anything else named rather than dropped silently."""
    async with _client(config, timeout) as client:
        result = await client.call_tool(tool, arguments or {})
    return _tool_text(result)


async def call_and_hold(server: str, config: dict, tool: str, arguments: dict, scope: tuple) -> str:
    """One call as a bot's turn makes it (Phase 2 unit U5): the server's own call timeout (1 to 60 minutes,
    default 10), configured secret values removed from anything it says, and a result longer than the server's
    text budget cut short with the whole held for `query_tool_result`. `scope` is (owner, bot id, thread id),
    always the turn's trusted scope, never read from the model."""
    from core import bot_tool_results, integrations
    from core.bot_held_secrets import held
    options = integrations.mcp_options(server)
    item = integrations.get_integration(options["id"]) if options["id"] else None
    try:
        text = await asyncio.wait_for(call_tool(config, tool, arguments, options["call_timeout_seconds"]), options["call_timeout_seconds"])
    except asyncio.TimeoutError:
        return f"Tool error: {server} did not answer within {options['call_timeout_seconds'] // 60} minutes."
    text = held.scrub(integrations.redact(item, text))
    owner, bot_id, thread_id = scope
    return bot_tool_results.trim(bot_tool_results.store(), owner, bot_id, thread_id, text, options["result_budget"], f"{server}.{tool}")


def _flat(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for sub in error.exceptions for leaf in _flat(sub)]
    return [error]


def _probe_failure(error: BaseException) -> dict:
    """Why a probe failed: keys (refused with a bad or missing key), auth (sign-in needed), timeout or unreachable."""
    leaves = _flat(error)
    text = " ".join(f"{type(e).__name__} {e}" for e in leaves).lower()
    status = next((getattr(getattr(e, "response", None), "status_code", None) for e in leaves
                   if getattr(getattr(e, "response", None), "status_code", None)), None)
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)) or any(isinstance(e, (asyncio.TimeoutError, TimeoutError)) for e in leaves)             or "timed out" in text or "timeout" in text:
        return {"state": "failed", "reason": "timeout"}
    if status == 401 or "401" in text or "unauthorized" in text or "authorization required" in text:
        return {"state": "auth_required", "reason": "auth"}
    if status == 403 or "403" in text or "forbidden" in text or "invalid api key" in text or "api key" in text:
        return {"state": "failed", "reason": "keys"}
    return {"state": "failed", "reason": "unreachable"}


async def probe(config: dict, keep_tools: bool = False) -> dict:
    """Test a server's configuration without saving or pinning anything.

    Returns {"state": "connected"|"auth_required"|"failed", "tools": n, "tool_names": [...up to 100],
    "reason": "keys"|"unreachable"|"timeout"|"auth"|None}. A local command is given 8 seconds and a remote
    server 30. Nothing is run beyond listing the server's tools."""
    limit = STDIO_PROBE_SECONDS if config.get("type") == "stdio" else REMOTE_PROBE_SECONDS
    try:
        tools = await asyncio.wait_for(list_tools(config, limit), limit)
    except BaseException as error:  # noqa: BLE001 - classification, then a plain answer
        if isinstance(error, (KeyboardInterrupt, SystemExit)) or (isinstance(error, asyncio.CancelledError) and not _flat(error)):
            raise
        return {**_probe_failure(error), "tools": 0, "tool_names": []}
    found = {"state": "connected", "tools": len(tools), "tool_names": [t["name"] for t in tools[:MAX_PROBE_TOOLS]], "reason": None,
             "truncated": len(tools) > MAX_PROBE_TOOLS}
    if keep_tools:
        found["_tools"] = tools  # for the caller that records a check; never part of an API answer
    return found


def _tool_text(result) -> str:
    parts = []
    for block in result.content or []:
        text = getattr(block, "text", None)
        parts.append(text if text is not None else f"[{getattr(block, 'type', 'non-text')} content not shown]")
    text = "\n".join(parts) or "(the tool returned nothing)"
    return f"Tool error from the server: {text}" if getattr(result, "is_error", False) else text


class PersistentClient:
    """Keep one MCP process and its evidence in a dedicated event-loop thread.

    A chat's turns run in separate request tasks, so an async context held in
    connect() cannot safely cross those tasks. REA needs one process across
    calls because retained Evidence IDs exist only in that process.
    """

    def __init__(self, config: dict):
        self.config = config
        self._ready: concurrent.futures.Future = concurrent.futures.Future()
        self._loop = None
        self._client = None
        self._stop = None
        self._close_requested = False
        self._thread = threading.Thread(target=self._thread_main, name="rea-mcp", daemon=True)

    def _thread_main(self):
        async def serve():
            async with _client(self.config, CALL_TIMEOUT_SECONDS) as client:
                self._client = client
                self._loop = asyncio.get_running_loop()
                self._stop = asyncio.Event()
                self._ready.set_result(True)
                if self._close_requested:
                    self._stop.set()
                await self._stop.wait()
        try:
            asyncio.run(serve())
        except BaseException as exc:
            if not self._ready.done():
                self._ready.set_exception(exc)
            else:
                logger.warning("persistent REA MCP connection closed: %s", exc)

    async def start(self) -> None:
        self._thread.start()
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(self._ready)), timeout=60)

    async def _submit(self, coroutine, timeout: float):
        if not self._thread.is_alive() or self._loop is None:
            coroutine.close()
            raise RuntimeError("REA MCP connection closed")
        result = asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        return await asyncio.wait_for(asyncio.wrap_future(result), timeout=timeout)

    async def list_tools(self) -> list[dict]:
        async def get():
            return await self._client.list_tools()
        result = await self._submit(get(), LIST_TIMEOUT_SECONDS)
        return [{"name": tool.name, "description": tool.description or "",
                 "schema": tool.input_schema or {"type": "object", "properties": {}}}
                for tool in result.tools]

    async def call_tool(self, tool: str, arguments: dict) -> str:
        async def call():
            return await self._client.call_tool(tool, arguments or {})
        return _tool_text(await self._submit(call(), CALL_TIMEOUT_SECONDS))

    async def call_result(self, tool: str, arguments: dict):
        """Keep typed content for integrations that return viewport images."""
        return await self._submit(self._client.call_tool(tool, arguments or {}), CALL_TIMEOUT_SECONDS)

    async def close(self) -> None:
        self._close_requested = True
        if self._loop is not None and self._stop is not None and self._thread.is_alive():
            self._loop.call_soon_threadsafe(self._stop.set)
            await asyncio.to_thread(self._thread.join, 10)


def function_name(server: str, tool: str, taken: set[str]) -> str:
    """mcp__<server>__<tool>, as Claude names them, made safe for OpenAI's
    function-name rules (letters, digits, _ and -, at most 64) and unique."""
    base = _NAME_OK.sub("_", f"mcp__{server}__{tool}")[:64]
    name, n = base, 2
    while name in taken:
        suffix = f"_{n}"
        name, n = base[:64 - len(suffix)] + suffix, n + 1
    return name


def _scrub(config: dict, text: str) -> str:
    """`text` without the secret values this runtime config carries (headers, variables): errors and logs only."""
    values = [v for v in [*(config.get("headers") or {}).values(), *(config.get("env") or {}).values()] if isinstance(v, str) and len(v) >= 4]
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "[hidden]")
    bearer = (config.get("headers") or {}).get("Authorization", "")
    if bearer.startswith("Bearer ") and len(bearer) > 11:
        text = text.replace(bearer[7:], "[hidden]")
    return text


def _record(**kwargs) -> None:
    """Keep a check's result; never allowed to stop the chat that made it."""
    from core import integrations
    try:
        integrations.record_check(**kwargs)
    except Exception:
        logger.exception("could not record an MCP check")


async def discover(servers: dict[str, dict]) -> dict[str, dict[str, Any]]:
    """Every tool of every reachable server, keyed by the function name the
    model will use, except those held for review. A server that cannot be
    reached is skipped and its status says so; it never stops the chat."""
    from core import integrations
    found: dict[str, dict[str, Any]] = {}
    for server, config in servers.items():
        try:
            tools = await list_tools(config)
        except Exception as e:  # an unreachable server must not end the turn
            logger.warning("MCP server %r unavailable: %s", server, _scrub(config, str(e)))
            _record(name=server, error=_scrub(config, f"{type(e).__name__}: {e}"))
            continue
        _record(name=server, tools=tools)
        held = integrations.held_tools().get(server, set())
        for tool in tools:
            if tool["name"] in held:
                continue
            name = function_name(server, tool["name"], set(found))
            found[name] = {"server": server, "config": config, **tool}
    return found


async def check(item_id: str) -> Optional[dict]:
    """Check one MCP server now (Tool Store's Check, adding a server, the
    task loop): its status, pins and held tools, as the masked record. None
    for an unknown server."""
    from core import integrations, mcp_oauth
    item = integrations.get_integration(item_id)
    if item is None or item.get("kind") != "mcp_server":
        return None
    if not item.get("enabled", True):
        return integrations.get_integration_masked(item_id)
    await mcp_oauth.refresh_due([item_id])
    if item.get("mcp_type") == "stdio":
        from core import accounts
        if not accounts.has_machine_access():
            return integrations.record_check(item_id, error=accounts.MACHINE_ACCESS_MESSAGE)
    config = integrations.list_mcp_servers_runtime([item_id]).get(item["name"])
    if config is None:  # an OAuth server not signed in is left out until it is
        return integrations.record_check(item_id, signed_out=True)
    limit = STDIO_PROBE_SECONDS * 2 if config.get("type") == "stdio" else REMOTE_PROBE_SECONDS
    try:
        tools = await asyncio.wait_for(list_tools(config), limit)
    except Exception as e:
        logger.warning("MCP server %r check failed: %s", item["name"], integrations.redact(item, str(e)))
        return integrations.record_check(item_id, error=integrations.redact(item, f"{type(e).__name__}: {e}"))
    return integrations.record_check(item_id, tools=tools)


async def check_all() -> int:
    """Check every MCP server; how many. The task loop's regular pass, which
    is how a change reaches Claude chats: Claude Code lists a server's tools
    itself and never tells JARVIS what it found."""
    from core import integrations
    ids = [i["id"] for i in integrations.list_integrations() if i["kind"] == "mcp_server"]
    for item_id in ids:
        try:
            await check(item_id)
        except Exception:
            logger.exception("MCP check of %s failed", item_id)
    return len(ids)
