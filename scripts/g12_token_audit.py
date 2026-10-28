"""A20 per-turn token breakdown (Part 2, g12): the exact request each turn sends to an OpenAI-compatible endpoint,
captured at core.providers.openai_compatible._post_chat, with scripted replies and a scripted summariser. No model,
no network. Tokens are ESTIMATED as characters/4 (no tokenizer bundled): compare ratios, not absolutes. The scripted
usage block reports the same estimate so the app's own meter/auto-compaction path runs for real.
Workloads: simple chat, tool-heavy chat (one 3,000-char tool result per turn), 100 turns each, window 16,384 tokens
(a small window: core tools only), auto-compaction on and off.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/g12_token_audit.py [--json out.json]
"""
import asyncio, copy, json, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch, AsyncMock

fixture = tempfile.TemporaryDirectory(prefix="kairos-g12-audit-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.session_manager import session_manager
from core import settings as settings_store, memory_tools
from services import chat_service

WINDOW = 16384
ENDPOINT = {"id": "local", "kind": "local", "model": "local-model", "name": "Local", "num_ctx": WINDOW}
USER = "Please review milestone {n} of the quarterly plan and say in a few sentences whether it is on track and what the next step is."
ANSWER = "Milestone {n} is on track. It depends on the vendor contract, which still has no date, so the next step is to ask procurement for one this week. " * 2
TOOL_RESULT = "Vendor sheet row. " * 170  # about 3,060 chars
PLANT_TEXT = "By the way the launch codename is zephyr-lantern."
# Fixed-size scripted summary (about 1,300 chars) that deliberately omits the planted fact, so recovery is exercised.
SUMMARY = "SUMMARY of earlier conversation: the user is reviewing quarterly milestones one at a time; each was on track pending the vendor contract date; procurement asked each time. " * 8


def size(x):
    return len(json.dumps(x, ensure_ascii=False))


class Run:
    def __init__(self):
        self.bodies, self.summ, self.replies = [], [], []


def compose(body):
    p = dict(system=0, user=0, assistant=0, tool_results=0, tool_calls=0)
    for m in body["messages"]:
        c = size(m.get("content") or "")
        if m["role"] == "system":
            p["system"] += c
        elif m["role"] == "user":
            p["user"] += c
        elif m["role"] == "tool":
            p["tool_results"] += c
        else:
            p["assistant"] += c
            p["tool_calls"] += size(m.get("tool_calls") or [])
    p["history_summary"] = sum(size(m["content"]) for m in body["messages"] if m["role"] == "assistant"
                               and isinstance(m.get("content"), str) and "compacted to save context" in m["content"])
    p["assistant"] -= p["history_summary"]
    p["tool_schemas"] = size(body.get("tools") or [])
    p["tools"] = len(body.get("tools") or [])
    p["total"] = size(body)
    p["messages"] = len(body["messages"])
    return p


async def run_workload(tool_heavy, auto, turns=100):
    r = Run()
    settings_store.update_settings(auto_compact=auto)
    chat_service._brains.clear()
    chat_service._busy.clear()
    sid = session_manager.create_session("audit")["id"]

    async def fake_post(client, base_url, api_key, body):
        b = copy.deepcopy(body)
        last = b["messages"][-1].get("content") or ""
        if isinstance(last, str) and "Write a structured summary that preserves" in last:
            r.summ.append(size(b))
            return {"choices": [{"message": {"role": "assistant", "content": SUMMARY}}]}
        r.bodies.append(b)
        reply = r.replies.pop(0)
        return {"choices": [{"message": reply}], "usage": {"prompt_tokens": size(b) // 4, "completion_tokens": size(reply) // 4}}

    def tool_call():
        return {"role": "assistant", "content": None, "tool_calls": [{"id": "c", "type": "function",
                "function": {"name": "search_vault", "arguments": '{"query": "plan"}'}}]}

    first_req, comp_at = {}, {}
    with patch.object(chat_service, "_resolve_endpoint", side_effect=lambda s: ENDPOINT), \
         patch("core.model_endpoints.resolve_runtime", return_value=("http://fake", "local-model", None, WINDOW)), \
         patch("core.external_brain.ExternalBrain._execute_tool", new=AsyncMock(return_value=TOOL_RESULT)), \
         patch("core.providers.openai_compatible._post_chat", new=fake_post):
        for n in range(1, turns + 1):
            r.replies.extend(([tool_call()] if tool_heavy else []) + [{"role": "assistant", "content": ANSWER.format(n=n)}])
            first_req[n] = len(r.bodies)
            ncomp = len(r.summ)
            await chat_service.send_message(sid, USER.format(n=n) + (" " + PLANT_TEXT if n == 3 else ""))
            comp_at[n] = len(r.summ) - ncomp
    return r, first_req, comp_at, sid


def report(name, tool_heavy, auto, out):
    r, first, comp, sid = asyncio.run(run_workload(tool_heavy, auto))
    row = {"workload": name, "auto_compact": auto, "turns": 100, "requests": len(r.bodies), "compactions": len(r.summ),
           "compaction_turns": [n for n, c in comp.items() if c], "summariser_tokens_est": sum(r.summ) // 4,
           "input_total_tokens_est": sum(size(b) for b in r.bodies) // 4, "turn": {}}
    for n in (1, 10, 50, 100):
        c = compose(r.bodies[first[n]])
        row["turn"][n] = {"tokens_est": c["total"] // 4, **c}
    row["compaction_before_after"] = [
        {"turn": n, "before_tokens_est": size(r.bodies[first[n] - 1]) // 4, "after_tokens_est": size(r.bodies[first[n]]) // 4}
        for n in row["compaction_turns"]]
    row["peak_request_tokens_est"] = max(size(b) for b in r.bodies) // 4
    row["window_tokens"] = WINDOW
    row["requests_over_window"] = sum(1 for b in r.bodies if size(b) // 4 > WINDOW)
    last = r.bodies[-1]["messages"]
    row["summary_copies_in_last_request"] = sum(1 for m in last if "SUMMARY of earlier conversation" in str(m.get("content")))
    row["fact_in_last_request"] = "zephyr-lantern" in json.dumps(last)
    row["fact_via_archive_search"] = bool(memory_tools.search_this_chat_archive(sid, "launch codename zephyr"))
    out.append(row)
    return row


if __name__ == "__main__":
    out = []
    for name, th in (("simple chat", False), ("tool-heavy chat", True)):
        for auto in (False, True):
            row = report(name, th, auto, out)
            t = row["turn"]
            print(f"\n== {name}, auto-compact {'on' if auto else 'off'} ==")
            print(f"requests {row['requests']}, compactions {row['compactions']} at turns {row['compaction_turns']}, summariser input ~{row['summariser_tokens_est']} tok total")
            print(f"input sent across 100 turns ~{row['input_total_tokens_est']} tok; peak request ~{row['peak_request_tokens_est']} tok vs window {WINDOW}; requests over window: {row['requests_over_window']}")
            for n in (1, 10, 50, 100):
                c = t[n]
                print(f"  turn {n:>3}: ~{c['tokens_est']:>6} tok | system {c['system']//4}, tool_schemas {c['tool_schemas']//4} ({c['tools']} tools), history_summary {c['history_summary']//4}, user {c['user']//4}, assistant {c['assistant']//4}, tool_calls {c['tool_calls']//4}, tool_results {c['tool_results']//4} (est. tokens)")
            for x in row["compaction_before_after"][:4]:
                print("  compaction", x)
            print(f"  summary copies in last request: {row['summary_copies_in_last_request']}; planted fact in last request: {row['fact_in_last_request']}; recoverable via archive search: {row['fact_via_archive_search']}")
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(out, indent=1), encoding="utf8")
