"""Seed a fresh data folder for scripts/bot-reports-checks.cjs: a three-bot Content Studio team with a few days of
runs (steps, topics, a pick, a failed run), approval decisions and a Claude connection. Real stores, no model.

    JARVIS_DATA_DIR=<temp> python scripts/fixtures/bot_reports_seed.py
Prints the ids it made as JSON.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from core import bot_policy, model_endpoints, runs  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import bot_attention, bot_departments  # noqa: E402
from services.agent_service import agent_service  # noqa: E402


def run(bot, thread, steps, outcome="finished", detail="", tokens=8400, ago=3600):
    context = runs.RunContext("chat", session_id=thread, agent_id=bot, started_at=time.time() - ago, model="claude-sonnet-5-5")
    tally = runs.Tally()
    for n, (name, args, ok, out) in enumerate(steps):
        tally.add(runs.tool_started(f"t{n}", name, args))
        tally.add(runs.tool_finished(f"t{n}", ok, out))
    tally.add(runs.event(runs.EventKind.USAGE, usage=runs.Usage(prompt_tokens=tokens - 900, output_tokens=900, total_tokens=tokens)))
    runs.record(context, tally, outcome, detail=detail)


def decide(bot, thread, tool, outcome, source, scope=None):
    bot_policy.record_decision(bot_id=bot, thread_id=thread, tool=tool, op=None, mode="ask", outcome=outcome, source=source,
                               actor="owner" if source == "asked" else "policy", owner=bot_attention.legacy_owner(),
                               unattended=False, scope=scope)


def main():
    user = bot_attention.legacy_owner()
    claude = model_endpoints.create_endpoint("Claude", kind="claude_cli")
    names = [("Producer", "Leads the Content Studio team"), ("Researcher", "Finds trending topics, with sources"),
             ("Evaluator", "Scores topic candidates and picks what gets made")]
    bots = {n: agent_service.create(n, role=r, approval_mode="ask", endpoint_id=claude["id"], model_override="claude-sonnet-5-5")["id"]
            for n, r in names}
    team = bot_departments.create("Content Studio", list(bots.values()), user)
    bot_departments.set_meta(team["id"], user, model_tiers={bots["Producer"]: "strong", bots["Researcher"]: "standard",
                                                            bots["Evaluator"]: "standard"},
                             internal_tools=sorted(bot_policy.CONTENT_STUDIO_INTERNAL_TOOLS))
    threads = {}
    for name, bot in bots.items():
        thread = session_manager.create_session(f"{name} work")["id"]
        session_manager.set_agent(thread, bot, "")
        threads[name] = thread
    r, p, e = bots["Researcher"], bots["Producer"], bots["Evaluator"]
    run(r, threads["Researcher"], [
        ("WebSearch", {"query": "rising science topics"}, True, "results"),
        ("WebSearch", {"query": "ocean facts trend"}, True, "results"),
        ("WebFetch", {"url": "https://example.com/a"}, True, "page"),
        ("content_studio_add_topic", {"niche_id": 1, "title": "Moon dust is sharper than glass", "source": "https://example.com/a"}, True, "{}"),
        ("content_studio_add_topic", {"niche_id": 1, "title": "Lights at the bottom of the sea", "source": "https://example.com/b"}, True, "{}"),
        ("content_studio_add_topic", {"niche_id": 1, "title": "Why octopuses taste with arms", "source": "https://example.com/c"}, True, "{}"),
        ("coordinate_bots", {"bot_ids": [e], "message": "Pick one"}, True, "Assigned to Evaluator")], ago=5400)
    run(r, threads["Researcher"], [("WebSearch", {"query": "x"}, True, "r")], outcome="failed",
        detail="RateLimitError: 429 Too Many Requests", tokens=1200, ago=2 * 86400)
    run(e, threads["Evaluator"], [("content_studio_pipeline", {}, True, "{}"),
                                  ("content_studio_pick_topic", {"channel_id": 1, "topic_id": 1, "title": "Moon dust is sharper than glass", "reason": "Rising"}, True, "{}")], ago=4000)
    run(p, threads["Producer"], [("content_studio_watch", {"notify": True}, True, "{}"),
                                 ("coordinate_bots", {"bot_ids": [r], "message": "Find topics"}, True, "Assigned to Researcher"),
                                 ("content_studio_prepare_post", {"post_id": 1}, True, "{}")], ago=6000)
    for _ in range(3):
        decide(r, threads["Researcher"], "content_studio_add_topic", "allow", "team")
    decide(p, threads["Producer"], "coordinate_bots", "allow", "team")
    decide(p, threads["Producer"], "content_studio_prepare_post", "allow", "asked", scope="once")
    decide(e, threads["Evaluator"], "content_studio_pick_topic", "allow", "team")
    print(json.dumps({"team": team["id"], "bots": bots, "threads": threads}))


if __name__ == "__main__":
    main()
