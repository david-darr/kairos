"""Background skill review: after enough tool steps on a thread, a tool-less reviewer proposes skills.

U2's side-job runner supplies `runner(prompt) -> text`; the reviewer has no tools. It may propose
at most three changes. They are staged as cards; they are applied on their own only when the
bot's effective approval is Full, and then through the same scan, base-revision and review-hash
checks as a person's apply. A failed run retries after fifteen minutes and stops after three.
Counters keep at most 500 threads per bot.
"""
import json
import os
import re
import time

from services import bot_skill_learning, bot_skills
from services.bot_skills import LOCK, SkillError, ident, read_json, state_path, write_json

DEFAULT_STEPS, MIN_STEPS, MAX_STEPS = 10, 3, 100
MAX_THREADS, MAX_PROPOSALS, RETRY_SECONDS, MAX_FAILURES, TRANSCRIPT_CHARS = 500, 3, 15 * 60, 3, 24000


def settings(scope):
    bot_id = bot_skills._bot_id(scope)
    saved = read_json(state_path(bot_id, "review.json"), {})
    return {"enabled": saved.get("enabled", True), "steps": saved.get("steps", DEFAULT_STEPS)}


def set_settings(scope, *, enabled=None, steps=None):
    bot_id = bot_skills._bot_id(scope)
    with LOCK:
        value = settings(bot_id)
        if enabled is not None:
            if not isinstance(enabled, bool):
                raise SkillError("Background review is on or off.")
            value["enabled"] = enabled
        if steps is not None:
            if isinstance(steps, bool) or not isinstance(steps, int) or not MIN_STEPS <= steps <= MAX_STEPS:
                raise SkillError(f"Choose between {MIN_STEPS} and {MAX_STEPS} tool steps.")
            value["steps"] = steps
        write_json(state_path(bot_id, "review.json"), value)
    return value


def _state(bot_id):
    return read_json(state_path(bot_id, "review-state.json"), {"threads": {}})


def _save(bot_id, value):
    threads = value["threads"]
    if len(threads) > MAX_THREADS:
        for key in sorted(threads, key=lambda k: threads[k]["touched"])[:len(threads) - MAX_THREADS]:
            del threads[key]
    write_json(state_path(bot_id, "review-state.json"), value)


def observe_tool_step(scope, thread_id, steps=1, *, now=None):
    """Count finished tool steps. Returns {count, due}. `due` turns true once the threshold is reached."""
    bot_id = bot_skills._bot_id(scope)
    ident(thread_id)
    now = time.time() if now is None else now
    with LOCK:
        config = settings(bot_id)
        state = _state(bot_id)
        row = state["threads"].setdefault(thread_id, {"count": 0, "failures": 0, "next_at": 0, "gave_up": False, "touched": now})
        row["touched"] = now
        if config["enabled"] and not row["gave_up"]:
            row["count"] += max(0, int(steps))
        _save(bot_id, state)
        return {"count": row["count"], "due": config["enabled"] and not row["gave_up"] and row["count"] >= config["steps"]
                and now >= row["next_at"]}


# The memory tick asks every bot this every 15 seconds. Reading the two files through the link checks costs
# about 35 file-system calls a bot (300 ms a pass at 100 bots, on the event loop; 100-bot scale test, 2026-11-10),
# so the answer's inputs are kept until either file changes: two plain stats a bot instead.
_due_inputs: dict = {}


def _stamp(folder):
    out = []
    for filename in ("review.json", "review-state.json"):
        try:
            info = os.stat(os.path.join(folder, filename))
            out.append((info.st_mtime_ns, info.st_size, info.st_ino))
        except OSError:
            out.append(None)
    return tuple(out)


def due_threads(scope, *, now=None):
    bot_id = bot_skills._bot_id(scope)
    now = time.time() if now is None else now
    from core import accounts
    folder = os.path.join(accounts.path("bot-skill-state"), bot_id)  # the folder state_path() checks and reads
    stamp = _stamp(folder)
    saved = _due_inputs.get(bot_id)
    if saved is None or saved[0] != folder or saved[1] != stamp:
        config = settings(bot_id)
        saved = _due_inputs[bot_id] = (folder, stamp, config, _state(bot_id)["threads"] if config["enabled"] else {})
    config, threads = saved[2], saved[3]
    if not config["enabled"]:
        return []
    return [tid for tid, row in threads.items()
            if not row["gave_up"] and row["count"] >= config["steps"] and now >= row["next_at"]]


def effective_full(bot_id, thread_approval=None):
    """True only when the bot and the thread are both at Full."""
    from services.agent_service import agent_service
    bot = agent_service.get(bot_id) or {}
    return bot.get("approval_mode", "full") == "full" and thread_approval in (None, "full")


def review_prompt(transcript, existing):
    names = ", ".join(sorted(s["name"] for s in existing)) or "none"
    return ("Review this finished work and decide whether it holds a reusable procedure worth saving as a skill, "
            "or an existing skill that should be improved. You have no tools. Propose at most three changes.\n"
            f"Skills that already exist: {names}.\n"
            'Answer with JSON only: {"proposals": [{"name": "lowercase-hyphen-name", "gist": "one line", '
            '"skill_md": "full SKILL.md text", "references": {"references/topic.md": "text"}}]}. '
            'Answer {"proposals": []} when nothing is worth saving. Never include passwords, keys or personal data.\n\n'
            "Work to review:\n" + transcript[-TRANSCRIPT_CHARS:])


def parse_proposals(text):
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        raise ValueError("The reviewer returned no JSON.")
    rows = json.loads(match.group(0)).get("proposals")
    if not isinstance(rows, list):
        raise ValueError("The reviewer returned no proposal list.")
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("name"), str) and isinstance(r.get("skill_md"), str)][:MAX_PROPOSALS]


def run_review(scope, thread_id, *, runner, transcript, thread_approval=None, now=None):
    """Run one review. Returns {"staged": [cards], "applied": [receipts], "state": ...}."""
    bot_id = bot_skills._bot_id(scope)
    ident(thread_id)
    now = time.time() if now is None else now
    with LOCK:
        state = _state(bot_id)
        row = state["threads"].get(thread_id)
        if row is None or row["gave_up"] or now < row["next_at"]:
            return {"staged": [], "applied": [], "state": "skipped"}
    try:
        proposals = parse_proposals(runner(review_prompt(transcript, bot_skills.resolve(bot_id))))
    except Exception:  # a failed side job is retried later, never raised into the chat
        with LOCK:
            state = _state(bot_id)
            row = state["threads"][thread_id]
            row["failures"] += 1
            row["next_at"] = now + RETRY_SECONDS
            row["gave_up"] = row["failures"] >= MAX_FAILURES
            _save(bot_id, state)
            return {"staged": [], "applied": [], "state": "gave_up" if row["gave_up"] else "retry"}
    staged, applied, full = [], [], effective_full(bot_id, thread_approval)
    for proposal in proposals:
        try:
            card = bot_skill_learning.stage(bot_id, proposal["name"], proposal["skill_md"], references=proposal.get("references") or {},
                                            source="background review", gist=proposal.get("gist", ""), thread_id=thread_id,
                                            actor="reviewer")
        except SkillError:
            continue  # a proposal the scan or limits refuse is dropped
        staged.append(card)
        if full:
            try:
                applied.append(bot_skill_learning.apply(bot_id, card["id"], reviewed_sha256=card["bundle_sha256"], auto=True))
            except SkillError:
                pass  # it stays as a held card for the person
    with LOCK:
        state = _state(bot_id)
        state["threads"][thread_id].update(count=0, failures=0, next_at=0, touched=now)
        _save(bot_id, state)
    return {"staged": staged, "applied": applied, "state": "done"}
