"""A bot's stdio MCP proxy for Claude (Bots Phase 2 unit U4, 2026-10-29).

Claude connects to MCP servers itself, so grants cannot be enforced by Kairos's bridge alone. For a
bot, core/brain.py gives Claude this one server instead of the real ones. It holds only a short-lived
loopback capability (JARVIS_TOOL_TOKEN, JARVIS_API_BASE), never an upstream credential:

  tools/list  ->  POST /api/tools/_mcp/list   (only what the bot's grants allow, held tools left out)
  tools/call  ->  POST /api/tools/_mcp/call   (the bridge: grants, endpoint check, permission, hooks)

Every call is judged again by the backend against the bot's current grants, so a cached list never
grants anything. The capability is renewed through /_mcp/renew before it expires.
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import mcp.types as types  # noqa: E402
from mcp.server.lowlevel import Server  # noqa: E402
from mcp.server.stdio import stdio_server  # noqa: E402

RENEW_BELOW_SECONDS = 600
TIMEOUT_SECONDS = 600.0


class Backend:
    """The loopback calls. `transport` lets a test stand in for the backend."""

    def __init__(self, base: str, token: str, transport=None):
        self.base, self.token = base.rstrip("/"), token
        self._client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport)

    async def post(self, path: str, body: dict | None = None) -> dict:
        response = await self._client.post(f"{self.base}/tools/{path}", json=body or {},
                                           headers={"X-JARVIS-Tool-Token": self.token})
        response.raise_for_status()
        data = response.json()
        if isinstance(data.get("expires_in"), int) and data["expires_in"] < RENEW_BELOW_SECONDS and path != "_mcp/renew":
            await self._renew()
        return data

    async def _renew(self) -> None:
        try:
            response = await self._client.post(f"{self.base}/tools/_mcp/renew", json={},
                                               headers={"X-JARVIS-Tool-Token": self.token})
            response.raise_for_status()
            self.token = response.json()["token"]
        except Exception:
            pass   # the next call says the access expired; nothing is guessed here

    async def close(self) -> None:
        await self._client.aclose()


def build(backend: Backend) -> Server:
    async def list_tools(ctx, params):
        try:
            data = await backend.post("_mcp/list")
        except Exception:
            return types.ListToolsResult(tools=[])   # no access: no tools, never a stale list
        return types.ListToolsResult(tools=[
            types.Tool(name=t["name"], description=t.get("description") or "",
                       input_schema=t.get("schema") or {"type": "object", "properties": {}})
            for t in data.get("tools", [])])

    async def call_tool(ctx, params):
        try:
            data = await backend.post("_mcp/call", {"name": params.name, "arguments": params.arguments or {}})
            text, error = str(data.get("result", "")), str(data.get("result", "")).startswith(("Not run:", "Not allowed:", "Tool not available"))
        except Exception as problem:
            text, error = f"Tool error: {type(problem).__name__}", True
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=error)

    return Server("kairos-apps", on_list_tools=list_tools, on_call_tool=call_tool)


async def main() -> None:
    base, token = os.environ.get("JARVIS_API_BASE"), os.environ.get("JARVIS_TOOL_TOKEN")
    if not base or not token:
        print("Kairos's app proxy runs only when Kairos starts it.", file=sys.stderr)
        sys.exit(1)
    backend = Backend(base, token)
    server = build(backend)
    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        await backend.close()


if __name__ == "__main__":
    asyncio.run(main())
