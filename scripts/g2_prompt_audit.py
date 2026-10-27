"""A04 efficiency audit: the exact request each chat turn sends to an OpenAI-compatible endpoint, measured at the
single boundary every request crosses (openai_compatible._post_chat), with scripted replies. Prints size and
composition at turns 1, 10 and 50, checks that each turn extends the previous one (cache-friendly) and flags
duplicated content. Tokens are estimated as characters / 4 (no tokenizer is bundled), so compare ratios, not absolutes.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/g2_prompt_audit.py
"""
import asyncio
import copy
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch, AsyncMock

fixture = tempfile.TemporaryDirectory(prefix="kairos-g2-audit-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.session_manager import session_manager
from services import chat_service

ENDPOINT = {"id": "local", "kind": "local", "model": "local-model", "name": "Local"}
bodies, times = [], []


async def fake_post(client, base_url, api_key, body):
    bodies.append(copy.deepcopy(body))
    reply = replies.pop(0)
    return {"choices": [{"message": reply}]}

replies = []
USER = "Please look at the quarterly plan and tell me which of the three milestones is most at risk, and why, in a few sentences. Turn {n}."
ANSWER = "The second milestone is most at risk because it depends on the vendor contract, which has no date yet. " * 3
def tool_call():
    return {"role": "assistant", "content": None, "tool_calls": [{"id": "c", "type": "function", "function": {"name": "search_vault", "arguments": '{"query": "plan"}'}}]}
TOOL_RESULT = "RESULT " + ("The quarterly plan lists three milestones. " * 40)

def size(x): return len(json.dumps(x, ensure_ascii=False))

def compose(body):
    msgs = body["messages"]
    parts = {"system": 0, "user": 0, "assistant": 0, "tool_results": 0, "tool_calls": 0}
    for m in msgs:
        c = size(m.get("content") or "")
        if m["role"] == "system": parts["system"] += c
        elif m["role"] == "user": parts["user"] += c
        elif m["role"] == "tool": parts["tool_results"] += c
        else:
            parts["assistant"] += c; parts["tool_calls"] += size(m.get("tool_calls") or [])
    parts["tool_schemas"] = size(body.get("tools") or [])
    parts["tool_count"] = len(body.get("tools") or [])
    parts["messages"] = len(msgs)
    parts["total_chars"] = size(body)
    return parts

async def main():
    chat_service._brains.clear(); chat_service._busy.clear()
    sid = session_manager.create_session("audit")["id"]
    with patch.object(chat_service, "_resolve_endpoint", side_effect=lambda s: ENDPOINT), \
         patch("core.model_endpoints.resolve_runtime", return_value=("http://fake", "local-model", None, None)), \
         patch("core.external_brain.ExternalBrain._execute_tool", new=AsyncMock(return_value=TOOL_RESULT)), \
         patch("core.providers.openai_compatible._post_chat", new=fake_post):
        first_index = {}
        for n in range(1, 51):
            use_tool = n % 5 == 0
            replies.extend([tool_call(), {"role": "assistant", "content": ANSWER}] if use_tool else [{"role": "assistant", "content": ANSWER}])
            before = len(bodies); t = time.perf_counter()
            await chat_service.send_message(sid, USER.format(n=n))
            times.append((time.perf_counter() - t) * 1000)
            first_index[n] = before
    return first_index

first = asyncio.run(main())
print(f"requests sent: {len(bodies)} for 50 completed turns ({sum(1 for n in range(1,51) if n % 5 == 0)} with one tool round)")
for n in (1, 10, 50):
    body = bodies[first[n]]
    parts = compose(body)
    print(f"turn {n}: ~{parts['total_chars'] // 4} tokens | " + ", ".join(f"{k}={v}" for k, v in parts.items()))
# Prefix stability: each turn's first request must extend the previous turn's last request.
unstable = []
for n in range(2, 51):
    prev_last = bodies[first[n] - 1]["messages"]; cur = bodies[first[n]]["messages"]
    if cur[:len(prev_last)] != prev_last: unstable.append(n)
print("turns whose request does NOT extend the previous request (cache break):", unstable or "none")
# Duplicated content inside one request.
dups = []
for i, b in enumerate(bodies):
    seen = {}
    for m in b["messages"]:
        c = m.get("content")
        if isinstance(c, str) and len(c) > 200 and m["role"] != "tool":
            key = (m["role"], c)
            if key in seen and m["role"] == "system": dups.append(i)
            seen[key] = 1
    names = [t["function"]["name"] for t in b.get("tools") or []]
    if len(names) != len(set(names)):
        dups.append(("duplicate tool schema", i))
print("requests with duplicated system text or tool schemas:", dups or "none")
growth = [compose(bodies[first[n]])["total_chars"] for n in range(1, 51)]
print(f"request size growth: turn1={growth[0]} turn10={growth[9]} turn50={growth[49]} chars; fixed overhead (system + tool schemas) = {compose(bodies[0])['system'] + compose(bodies[0])['tool_schemas']} chars ({round(100*(compose(bodies[0])['system'] + compose(bodies[0])['tool_schemas'])/growth[49])}% of turn 50)")
total = sum(size(b) for b in bodies)
print(f"input sent across the 50-turn task: ~{total // 4} tokens (sum of every request); an ideal cache-hit run would pay for ~{(growth[49]) // 4} fresh tokens plus the 50 new turns")
tools_per_request = statistics.mean(len(b.get("tools") or []) for b in bodies)
print(f"tools sent per request: {tools_per_request:.0f}")
print(f"app time per turn with an instant provider (p50/p95 ms): {statistics.median(times):.0f} / {sorted(times)[int(len(times)*.95)-1]:.0f}")
print("compaction happened:", any(any('summary' in str(m.get('content',''))[:80].lower() for m in b['messages'] if m['role']=='system') for b in bodies))

if os.environ.get("G2_PROFILE"):
    import cProfile, pstats
    async def one():
        sid = session_manager.create_session("prof")["id"]
        with patch.object(chat_service, "_resolve_endpoint", side_effect=lambda s: ENDPOINT), \
             patch("core.model_endpoints.resolve_runtime", return_value=("http://fake", "local-model", None, None)), \
             patch("core.providers.openai_compatible._post_chat", new=fake_post):
            replies.append({"role": "assistant", "content": "ok"})
            await chat_service.send_message(sid, "hello")
    pr = cProfile.Profile(); pr.enable(); asyncio.run(one()); pr.disable()
    pstats.Stats(pr).sort_stats("cumulative").print_stats(14)
