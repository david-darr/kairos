"""Part 2 g6 / A13 benchmark: what a model turn carries for tools and skills,
with and without deferred discovery, and what skill and catalog scans cost.
Prints numbers; asserts nothing (targets live in groups/g6-report.md).
Tokens are estimated as chars / 4 (no tokenizer, no model call: MANUAL for real counts).

Run: python -B -X utf8 scripts/bench_g6_discovery.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-g6-disc-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import system_prompt, tool_registry, tool_search  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from services import skills_service  # noqa: E402


def tok(text) -> int:
    text = text if isinstance(text, str) else json.dumps(text)
    return len(text) // 4


def row(label, text):
    size = len(text if isinstance(text, str) else json.dumps(text))
    print(f"{label:64s} {size:8d} chars  ~{size // 4:6d} tokens")


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def timed(fn, n=15):
    out = []
    for _ in range(n):
        s = time.perf_counter()
        fn()
        out.append((time.perf_counter() - s) * 1000)
    return f"p50={pct(out, 50):.1f}ms p95={pct(out, 95):.1f}ms"


def mcp_catalog(n):
    schema = {"type": "object", "properties": {"title": {"type": "string", "description": "Issue title shown in the list"},
                                                "body": {"type": "string", "description": "Markdown body of the issue, up to 65k characters"},
                                                "labels": {"type": "array", "items": {"type": "string"}, "description": "Labels to apply"},
                                                "assignee": {"type": "string", "description": "Login of the person to assign"}},
              "required": ["title"]}
    return {f"mcp__svc{i // 10}__tool_{i}": {"server": f"svc{i // 10}", "name": f"tool_{i}",
                                             "description": f"Create, update or list item {i} in service {i // 10}. Returns the id and URL of the result.",
                                             "schema": schema} for i in range(n)}


async def main():
    print("== tool schemas a turn carries (Kairos's own tools)")
    for name, kw in (("admin", {"is_admin": True}), ("non-admin", {}), ("agent run", {"agent": True, "is_admin": True})):
        full = tool_registry.openai_tools(small_window=False, **kw)
        small = tool_registry.openai_tools(small_window=True, **kw) + tool_search.bridge_schemas()
        row(f"OpenAI-format, {name}: ALL {len(full)} tools", full)
        row(f"OpenAI-format, {name}: small window core + bridge ({len(small)})", small)
    claude = [(s.name, s.description, s.schema) for s in tool_registry.specs(tool_registry.CLAUDE, True)]
    row(f"Claude hive-mind MCP list (admin), {len(claude)} tools, listed once by Claude Code's own deferral", claude)
    row("Codex command list in its system prompt (admin)", system_prompt._codex_commands(True, False))
    row("bridge schemas alone (3 tools, byte-stable, cached)", tool_search.bridge_schemas())

    print("\n== system prompts")
    row("for_external (admin)", system_prompt.for_external(True))
    row("for_external (non-admin)", system_prompt.for_external(False))
    row("DEFERRED_TOOLS_ADDENDUM", system_prompt.DEFERRED_TOOLS_ADDENDUM)

    print("\n== a model turn's fixed overhead, external brain, before the user's words")
    for window, label in ((200000, "large window"), (8192, "small window")):
        brain = ExternalBrain("http://fake", "m", None, window=window, is_admin=True)
        row(f"{label}: system message", brain._messages[0]["content"])
        row(f"{label}: tools array", brain.tools)
        print(f"{label + ': total fixed':64s} {len(brain._messages[0]['content']) + len(json.dumps(brain.tools)):8d} chars  ~{(len(brain._messages[0]['content']) + len(json.dumps(brain.tools))) // 4:6d} tokens")

    print("\n== MCP tools: sent directly vs through the bridge")
    for n in (10, 50, 150, 400):
        catalog = mcp_catalog(n)
        direct = [{"type": "function", "function": {"name": k, "description": v["description"], "parameters": v["schema"]}} for k, v in catalog.items()]
        found = tool_search.search(catalog, "create item service 3", 5)
        described = tool_search.describe(catalog, next(iter(catalog)))
        row(f"{n} MCP tools sent every turn if not deferred", direct)
        print(f"{'  bridge: constant 3 schemas + one search(5) + one describe':64s} {len(json.dumps(tool_search.bridge_schemas())):8d} + {len(found)} + {len(described)} chars (only on turns that look)")
        t = timed(lambda: tool_search.search(catalog, "create item service 3", 5), 30)
        print(f"  search over {n} tools: {t}")

    print("\n== skills: what reaches the model")
    for count in (10, 100, 300):
        os.makedirs(skills_service.SKILLS_DIR, exist_ok=True)
        existing = len(skills_service.list_skills())
        for i in range(existing, count):
            skills_service.create_skill(f"bench-skill-{i}", f"Procedure number {i} for bench topic {i % 7}", "## When to Use\nWhen the bench asks.\n\n" + ("Step. " * 400))
        from core import memory_tools
        listing = "\n".join(f"- {s['slug']}: {s['description']}" for s in memory_tools.list_skills())
        row(f"{count} skills: list_skills tool output (every description, no cap)", listing)
        found = memory_tools.search_skills("bench topic 3")
        row(f"{count} skills: search_skills output (max 5)", "\n".join(f"- {s['slug']}: {s['description']}" for s in found))
        print(f"  system prompt unchanged by skill count: {len(system_prompt.for_external(True))} chars")
        print(f"  list_skills latency, {count} skills: {timed(memory_tools.list_skills, 8)}")
        print(f"  search_skills latency, {count} skills: {timed(lambda: memory_tools.search_skills('bench topic 3'), 8)}")
        print(f"  skills_service.list_skills (Tool Store load) latency: {timed(skills_service.list_skills, 8)}")
        print(f"  read_skill full body: {len(memory_tools.read_skill('bench-skill-0'))} chars (whole, by design)")


if __name__ == "__main__":
    asyncio.run(main())
