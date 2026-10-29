"""Shared MCP discovery and permission-checked calls (2026-10-15)."""
from core import integrations, mcp_client, mcp_oauth, permissions, tool_registry
from services import bot_grants


async def discover(integration_ids, ctx=None):
    """Return ordinary tools and REA's config for ExternalBrain's held client. With a bot's `ctx`
    only the tools its grants allow are returned (the same verdict the call is judged by)."""
    found, rea = await _discover(integration_ids)
    return bot_grants.filter_mcp_catalog(ctx, found) if ctx is not None else found, rea


async def _discover(integration_ids):
    await mcp_oauth.refresh_due(integration_ids)
    servers = dict(integrations.list_mcp_servers_runtime(integration_ids))
    if not servers:
        return {}, None
    rea_config = servers.pop("REA", None)
    return await mcp_client.discover(servers), rea_config


def same_endpoint(discovered: dict, current: dict | None) -> bool:
    """Token refresh is fine; a replaced server with the same name is not."""
    return current is not None and all(
        discovered.get(key) == current.get(key) for key in ("type", "url", "command", "args")
    )


async def call_tool(name, args, spec, integration_ids, ctx, *, rea_client=None, allow_rea=False, authorized=None):
    if spec["server"] == "REA" and not allow_rea:
        return "Not run: REA is not available in Codex chats."
    if ctx.read_only or tool_registry.session_read_only(ctx.session_id):
        return 'Not run: Forge Plan mode is read-only.'
    current = integrations.list_mcp_servers_runtime(integration_ids).get(spec["server"])
    if not same_endpoint(spec["config"], current):
        return "Not run: this integration is no longer enabled for the chat."
    # A bot's grants are a ceiling: judged before the person is asked, and again after the wait.
    refusal = bot_grants.mcp_refusal(ctx, spec, name, args)
    if refusal:
        return refusal
    decision = await permissions.decide(
        surface=ctx.permission_surface,
        tool=name, arguments=args if isinstance(args, dict) else {},
        title=f"{spec['server']}: {spec['name']}", description=spec["description"][:300],
        is_admin=ctx.is_admin, agent_id=ctx.agent_id, mcp=bot_grants.mcp_ident(spec) if ctx.agent_id else None,
    )
    if decision.behavior != "allow":
        return f"Not run: {decision.reason}"
    # 2026-10-15: refresh and re-check after the person's permission decision.
    await mcp_oauth.refresh_due(integration_ids)
    config = integrations.list_mcp_servers_runtime(integration_ids).get(spec["server"])
    if not same_endpoint(spec["config"], config):
        return "Not run: this integration is no longer enabled for the chat."
    if authorized is not None and not authorized():
        return "Not run: this tool access has expired; it lasts one turn."
    refusal = bot_grants.mcp_refusal(ctx, spec, name, args)
    if refusal:
        return refusal
    try:
        if spec["server"] == "REA":
            if rea_client is None:
                return "Tool error: REA's investigation session has closed. Reconnect this chat."
            result = await rea_client.call_tool(spec["name"], args)
        else:
            result = await mcp_client.call_tool(config, spec["name"], args)
        ctx.turn_taint.mark(f"MCP result: {name}")
        return result
    except Exception as e:
        return f"Tool error: {e}"
