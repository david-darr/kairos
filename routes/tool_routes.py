"""Codex's way to JARVIS's tools (roadmap phase 2, 2026-10-05):
mcp_servers/hive_mind_cli.py posts each call here, and it runs through the
same registry, permission checks, lifecycle hooks and audit as every other
model's (core/tool_registry.py dispatch).

The only credential is the turn's own token (core/tool_access.py), sent as
X-JARVIS-Tool-Token, and only from this computer. Who is calling - chat,
admin or not, agent - comes from that token, never from the request.
"""
from fastapi import APIRouter, Body, HTTPException, Request
import uuid

from core import bot_tool_catalog, mcp_bridge, tool_access, tool_registry, tool_search
from services import bot_grants

router = APIRouter(prefix="/api/tools", tags=["tools"])


def _context(request: Request) -> tool_registry.ToolContext:
    if not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "Tools are reachable only from this computer")
    grant = tool_access.resolve(request.headers.get("X-JARVIS-Tool-Token", ""))
    if grant is None:
        raise HTTPException(403, "This tool access has expired; it lasts one turn")
    return tool_registry.ToolContext(session_id=grant.session_id, is_admin=grant.is_admin,
                                     turn_taint=grant.turn_taint, agent_id=grant.agent_id, model=grant.model, read_only=grant.read_only,
                                     assignment_run_id=grant.assignment_run_id, source_card_id=grant.source_card_id,
                                     owner_user=grant.owner_user)


async def _mcp_tool(name, arguments, request, ctx):
    # 2026-10-15: discovery is lazy and lives only as long as this turn's token.
    token = request.headers.get("X-JARVIS-Tool-Token", "")
    grant = tool_access.resolve(token)
    if grant is None:
        raise HTTPException(403, "This tool access has expired; it lasts one turn")
    async with grant.mcp_lock:
        if "tools" not in grant.mcp_catalog:
            catalog, _ = await mcp_bridge.discover(grant.integration_ids)  # unfiltered; see below
            if tool_access.resolve(token) is not grant:
                raise HTTPException(403, "This tool access has expired; it lasts one turn")
            grant.mcp_catalog["tools"] = catalog
        # Filtered on every read, not when the catalog was cached: a revoked grant takes effect at once.
        catalog = bot_grants.filter_mcp_catalog(ctx, grant.mcp_catalog["tools"])
    if name == tool_search.SEARCH:
        result = tool_search.search(catalog, arguments.get("query", ""), arguments.get("limit", 5))
        if result.startswith("["):
            grant.turn_taint.mark("MCP tool catalog")
        return result
    selected = arguments.get("name", "")
    if name == tool_search.DESCRIBE:
        result = tool_search.describe(catalog, selected)
        if isinstance(selected, str) and selected in catalog:
            grant.turn_taint.mark("MCP tool catalog")
        return result
    if isinstance(selected, str) and (selected == "REA" or selected.startswith("mcp__REA__")):
        return "Not run: REA is not available in Codex chats."
    if not isinstance(selected, str) or selected not in catalog:
        return "Tool not available in this chat. Search again for an enabled tool."
    args = arguments.get("arguments")
    if not isinstance(args, dict):
        return f"Tool arguments must be an object. Call {tool_search.DESCRIBE} to see its schema."
    if ctx.read_only or tool_registry.session_read_only(ctx.session_id):
        return 'Not run: Forge Plan mode is read-only.'
    from services.hook_service import hook_service

    async def run():
        if tool_access.resolve(token) is not grant:
            return "Not run: this tool access has expired; it lasts one turn."
        return await mcp_bridge.call_tool(selected, args, catalog[selected], grant.integration_ids, ctx,
                                          authorized=lambda: tool_access.resolve(token) is grant)

    return await hook_service.around_tool(selected, args, run, **ctx.hook_context())


PROXY_TOKEN_SECONDS = 1800


async def _proxy_catalog(request: Request, ctx) -> tuple:
    """(grant, {proxy name: (function name, spec)}) for the bot behind this capability."""
    token = request.headers.get("X-JARVIS-Tool-Token", "")
    grant = tool_access.resolve(token)
    if grant is None or not grant.agent_id:
        raise HTTPException(403, "This tool access has expired; it lasts one turn")
    async with grant.mcp_lock:
        if "tools" not in grant.mcp_catalog:
            catalog, _ = await mcp_bridge.discover(grant.integration_ids)
            if tool_access.resolve(token) is not grant:
                raise HTTPException(403, "This tool access has expired; it lasts one turn")
            grant.mcp_catalog["tools"] = catalog
    allowed = bot_grants.filter_mcp_catalog(ctx, grant.mcp_catalog["tools"])
    names, table = set(), {}
    for function, spec in allowed.items():
        proxy = bot_tool_catalog.proxy_name(spec["server"], spec["name"], names)
        names.add(proxy)
        table[proxy] = (function, spec)
    return grant, table


def _expires_in(grant) -> int:
    return max(0, int(grant.expires_at - __import__("time").time()))


@router.post("/_mcp/list")
async def proxy_list(request: Request) -> dict:
    """The Claude proxy's tool list: only what this bot's grants allow, under short proxy names."""
    ctx = _context(request)
    grant, table = await _proxy_catalog(request, ctx)
    if any(spec["server"] == "REA" for _, spec in table.values()):
        table = {k: v for k, v in table.items() if v[1]["server"] != "REA"}
    if table:
        grant.turn_taint.mark("MCP tool catalog")
    return {"tools": [{"name": proxy, "description": spec["description"][:1000], "schema": spec["schema"]}
                      for proxy, (_, spec) in sorted(table.items())], "expires_in": _expires_in(grant)}


@router.post("/_mcp/call")
async def proxy_call(request: Request, body: dict = Body(default={})) -> dict:
    """A Claude proxy call, through the same bridge, grants, permission broker, hooks and audit."""
    ctx = _context(request)
    grant, table = await _proxy_catalog(request, ctx)
    name, args = body.get("name"), body.get("arguments")
    if not isinstance(name, str) or name not in table or not isinstance(args, dict):
        return {"result": "Tool not available for this bot.", "expires_in": _expires_in(grant)}
    function, spec = table[name]
    if spec["server"] == "REA":
        return {"result": "Not run: REA is not available here.", "expires_in": _expires_in(grant)}
    token = request.headers.get("X-JARVIS-Tool-Token", "")
    from services.hook_service import hook_service

    async def run():
        if tool_access.resolve(token) is not grant:
            return "Not run: this tool access has expired; it lasts one turn."
        return await mcp_bridge.call_tool(function, args, spec, grant.integration_ids, ctx,
                                          authorized=lambda: tool_access.resolve(token) is grant)

    result = await hook_service.around_tool(function, args, run, **ctx.hook_context())
    return {"result": result, "expires_in": _expires_in(grant)}


@router.post("/_mcp/renew")
async def proxy_renew(request: Request) -> dict:
    """A fresh capability for the same bot, so a long chat keeps working. The old one is not extended."""
    ctx = _context(request)
    old = tool_access.resolve(request.headers.get("X-JARVIS-Tool-Token", ""))
    if old is None or not old.agent_id:
        raise HTTPException(403, "This tool access has expired; it lasts one turn")
    token = tool_access.issue_proxy(old.session_id, old.is_admin, old.agent_id, old.model, old.integration_ids,
                                    PROXY_TOKEN_SECONDS)
    return {"token": token, "expires_in": PROXY_TOKEN_SECONDS}


@router.post("/{name}")
async def call_tool(name: str, request: Request, body: dict = Body(default={})) -> dict:
    ctx = _context(request)
    arguments = body.get("arguments") if isinstance(body, dict) else None
    bridge_name = tool_search.LEGACY.get(name, name)
    if bridge_name in (tool_search.SEARCH, tool_search.DESCRIBE, tool_search.CALL):
        return {"result": await _mcp_tool(bridge_name, arguments if isinstance(arguments, dict) else {}, request, ctx)}
    result = await tool_registry.dispatch(name, arguments if isinstance(arguments, dict) else {},
                                          ctx, tool_registry.CODEX)
    if isinstance(result, tool_registry.ToolResult):
        text = result.text
        grant = tool_access.resolve(request.headers.get("X-JARVIS-Tool-Token", ""))
        folder = tool_access.safe_screenshot_dir(grant) if grant else None
        if result.images and folder:
            folder.mkdir(parents=True, exist_ok=True)
            for image in result.images:
                path = folder / f"{uuid.uuid4().hex}.png"
                path.write_bytes(image)
                text += f"\nScreenshot saved: {path.resolve()}. Look at it with view_image."
        return {"result": text}
    return {"result": result}
