"""Part 2 g6 / A13 benchmark: MCP start and call overhead against the real stdio
echo fixture (scripts/mcp_echo_fixture.py). Loopback only, no network.

Run: python -B -X utf8 scripts/bench_g6_mcp.py
"""
import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-g6-mcp-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import mcp_client  # noqa: E402

FIXTURE = str(Path(__file__).resolve().parent / "mcp_echo_fixture.py")
CONFIG = {"type": "stdio", "command": sys.executable, "args": [FIXTURE], "env": {}}


def line(name, values):
    values = sorted(values)
    p = lambda q: values[min(len(values) - 1, int(round(q / 100 * (len(values) - 1))))] * 1000  # noqa: E731
    print(f"{name:62s} n={len(values):2d} p50={p(50):8.0f}ms p95={p(95):8.0f}ms")


async def timed(coro_fn, n):
    out = []
    for _ in range(n):
        s = time.perf_counter()
        await coro_fn()
        out.append(time.perf_counter() - s)
    return out


async def main():
    line("list_tools (spawns the server, lists, exits)", await timed(lambda: mcp_client.list_tools(CONFIG), 6))
    line("call_tool one-shot (spawns the server again for each call)", await timed(lambda: mcp_client.call_tool(CONFIG, "echo", {"text": "hi"}), 6))
    line("discover() of 1 server (what every chat connect pays)", await timed(lambda: mcp_client.discover({"echo": CONFIG}), 4))
    line("discover() of 4 servers (serial)", await timed(lambda: mcp_client.discover({f"s{i}": CONFIG for i in range(4)}), 2))
    client = mcp_client.PersistentClient(CONFIG)
    try:
        await client.start()
        line("PersistentClient warm call (REA path only)", await timed(lambda: client.call_tool("echo", {"text": "hi"}), 15))
    finally:
        await client.close()


asyncio.run(main())
