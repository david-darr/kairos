"""Kairos-gated REA calls for Codex CLI's built-in hive-mind MCP bridge."""
import asyncio
import json

from core import integrations, mcp_client
from core.rea_integration import is_rea
from core.session_manager import session_manager

_sessions: dict[str, tuple[str, dict, mcp_client.PersistentClient, dict[str, dict]]] = {}
_locks: dict[str, asyncio.Lock] = {}


def _selected(session_id: str | None) -> tuple[str, dict] | None:
    session = session_manager.get_session(session_id) if session_id else None
    ids = (session or {}).get("enabled_integration_ids")
    if not isinstance(ids, list):
        return None
    for item_id in ids:
        item = integrations.get_integration(item_id)
        if item and item.get("enabled", True) and is_rea(item):
            config = integrations.list_mcp_servers_runtime([item_id]).get("REA")
            if config:
                return item_id, config
    return None


async def _connected(session_id: str | None):
    selected = _selected(session_id)
    if not selected:
        await close(session_id)
        return None
    item_id, config = selected
    lock = _locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        current = _sessions.get(session_id)
        if current and current[:2] != (item_id, config):
            await current[2].close()
            _sessions.pop(session_id, None)
            current = None
        if current:
            return current
        client = mcp_client.PersistentClient(config)
        try:
            await client.start()
            tools = await client.list_tools()
            integrations.record_check(item_id=item_id, tools=tools)
        except Exception:
            await client.close()
            raise
        current = (item_id, config, client, {tool["name"]: tool for tool in tools})
        _sessions[session_id] = current
        return current


def _approved(item_id: str, tools: dict[str, dict]) -> dict[str, dict]:
    item = integrations.get_integration(item_id) or {}
    pins = item.get("pinned_tools") or {}
    held = item.get("held_tools") or {}
    return {name: tool for name, tool in tools.items()
            if name not in held and pins.get(name) == integrations.tool_fingerprint(tool)}


async def search(session_id: str | None, query: str, limit: int = 8) -> str:
    current = await _connected(session_id)
    if not current:
        return "REA is not selected for this chat. Add it in Tool Store and turn it on here."
    item_id, _, _, tools = current
    words = query.lower().split()
    matches = [tool for tool in _approved(item_id, tools).values()
               if all(word in (tool["name"] + " " + tool["description"]).lower() for word in words)]
    return json.dumps([{"name": tool["name"], "description": tool["description"][:240]}
                       for tool in matches[:max(1, min(limit, 20))]], ensure_ascii=False)


async def describe(session_id: str | None, name: str) -> str:
    current = await _connected(session_id)
    if not current:
        return "REA is not selected for this chat."
    tool = _approved(current[0], current[3]).get(name)
    return (json.dumps(tool, ensure_ascii=False) if tool else
            "REA tool unavailable or awaiting review. Search again in Tool Store.")


async def call(session_id: str | None, name: str, arguments: dict, surface: str, is_admin: bool) -> str:
    current = await _connected(session_id)
    if not current:
        return "Not run: REA is not selected for this chat."
    tool = _approved(current[0], current[3]).get(name)
    if not tool:
        return "Not run: REA tool unavailable or awaiting review."
    from core import permissions
    decision = await permissions.decide(surface=surface, tool=f"mcp__REA__{name}", arguments=arguments,
                                        title=f"REA: {name}", description=tool["description"][:300],
                                        is_admin=is_admin)
    if decision.behavior != "allow":
        return f"Not run: {decision.reason}"
    if _selected(session_id) != current[:2] or _sessions.get(session_id) is not current:
        return "Not run: REA changed while this call awaited approval."
    return await current[2].call_tool(name, arguments)


async def close(session_id: str | None) -> None:
    if not session_id:
        return
    lock = _locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        current = _sessions.pop(session_id, None)
        if current:
            await current[2].close()
    _locks.pop(session_id, None)
