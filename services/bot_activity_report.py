"""A bot's report, and its team's (David, 2026-11-11: "an easier way to see individual Bot's reports").

Read only. Built from what Kairos already records: the runs and their steps (core/runs.py, the session store's
`runs` and `run_events`), the approval decisions (core/bot_policy.py, bot_decisions/*.ndjson), the cards a run
ran (services/task_service.py) and the cost each run was priced at (core/run_cost.py). Nothing here calls a model.

What a report shows, in plain words, for a window of days:
- recent runs with their start, end and result, each with a link into its conversation;
- what each run did as plain steps (tool calls summarized and counted, never raw arguments);
- what it produced: for the Content Studio team topics, picks, scripts, renders and posts; for any bot the
  conversations it replied in, the files it wrote and the cards it worked;
- approvals: what it asked, what was allowed or denied and why, and what its team rules let through;
- errors, each with the fix;
- tokens and spend.
A team report rolls its members up, with each member's line and the team's totals.

Tool arguments never appear: produced items carry only a title or a file name read from the step, clipped.
"""
from __future__ import annotations

import json
import re
import time
from typing import Optional

DEFAULT_DAYS = 7
MAX_DAYS = 90
RUN_LIMIT = 25

# Plain names for the steps a person sees most. Anything else becomes its own name in words.
FRIENDLY = {
    "content_studio_add_topic": ("Added a topic", "topics"), "content_studio_pick_topic": ("Picked a topic", "picks"),
    "content_studio_save_script": ("Saved a script", "scripts"), "content_studio_save_shot_plan": ("Saved a shot plan", None),
    "content_studio_record_render": ("Recorded a render", "renders"), "content_studio_submit_post": ("Queued a post for your OK", "queued"),
    "content_studio_prepare_post": ("Prepared a post", "prepared"), "content_studio_mark_posted": ("Recorded a live post", "posts"),
    "content_studio_publish_youtube": ("Posted to YouTube", "posts"), "content_studio_publish_instagram": ("Posted to Instagram", "posts"),
    "content_studio_watch": ("Ran the watch", None), "content_studio_pipeline": ("Read the pipeline", None),
    "content_studio_send_report": ("Sent the weekly report", None), "content_studio_record_metrics": ("Stored numbers", None),
    "content_studio_run_review": ("Ran the weekly review", None), "content_studio_check_post": ("Ran the policy checks", None),
    "content_studio_save_format": ("Saved a format card", "formats"), "content_studio_propose_port": ("Proposed a port", None),
    "content_studio_decide_port": ("Decided a port", None), "content_studio_propose_niche": ("Proposed a niche", None),
    "content_studio_submit_plan": ("Sent a long video's plan to you", None),
    "WebSearch": ("Searched the web", None), "WebFetch": ("Read a web page", None), "browse": ("Browsed a page", None),
    "Read": ("Read a file", None), "Write": ("Wrote a file", "files"), "Edit": ("Edited a file", "files"),
    "MultiEdit": ("Edited a file", "files"), "Bash": ("Ran a command", None), "PowerShell": ("Ran a command", None),
    "coordinate_bots": ("Handed work to a teammate", "handoffs"), "agent_assign": ("Handed work to a teammate", "handoffs"),
    "agent_ask": ("Asked you a question", None), "agent_remember": ("Saved a note to its memory", None),
    "video_create": ("Built a video", None), "video_render": ("Rendered a video", None), "video_narrate": ("Narrated a video", None),
}
PRODUCED_LABELS = {"topics": "Topics", "picks": "Picks", "scripts": "Scripts", "renders": "Renders", "queued": "Posts queued for you",
                   "prepared": "Posts prepared", "posts": "Posts", "formats": "Format cards", "files": "Files",
                   "handoffs": "Hand-offs", "replies": "Conversations it replied in", "cards": "Cards it worked"}
OUTCOME = {"finished": "Finished", "failed": "Failed", "stopped": "Stopped"}
FIX = {"auth": "Sign in to its model again in Settings > Models.",
       "rate_limit": "The model's limit was reached. Wait for it to reset, or pick another model in its Model settings.",
       "overload": "The model's service was busy. Run it again in a few minutes.",
       "overflow": "The conversation got too long for the model. Start a new conversation, or pick a model with a larger window.",
       "network": "Kairos could not reach the model. Check the connection, then run it again.",
       "other": "Open the run to see what happened, then run it again."}
DECISION_SOURCES = {"asked", "asked-batch", "timeout", "nobody-to-ask", "team", "asks-person", "saved-rule", "self-only",
                    "person-requested", "allowance", "allowance-exhausted", "read-and-draft", "explicit-review"}
_TITLE = re.compile(r'"(?:title|name|topic|url|file_path|path)"\s*:\s*"([^"]{1,160})')


def friendly(name: Optional[str]) -> str:
    if not name:
        return "A step"
    name = name.removeprefix("mcp__hive_mind__")
    if name in FRIENDLY:
        return FRIENDLY[name][0]
    words = name.removeprefix("content_studio_").replace("__", " ").replace("_", " ").strip()
    return (words[:1].upper() + words[1:]) if words else "A step"


def _bucket(name: Optional[str]) -> Optional[str]:
    return FRIENDLY.get((name or "").removeprefix("mcp__hive_mind__"), (None, None))[1]


def _clip(text, limit=160) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _item(detail: str) -> str:
    """A title or file name from a step's recorded input, clipped; never the rest of the arguments."""
    found = _TITLE.search(detail or "")
    if not found:
        return ""
    value = found.group(1)
    if "/" in value or "\\" in value:
        value = re.split(r"[\\/]", value)[-1]
    from core import bot_policy
    return _clip(bot_policy.redact(value, 160), 120)


def steps_of(run_id: str) -> dict:
    """One run's plain steps (tool calls counted in order), what it produced, and its failed steps."""
    from core import session_manager_store as store
    events = store.run_events(run_id)
    started = {}
    plain: list[dict] = []
    produced: dict[str, list] = {}
    failed = []
    for event in events:
        if event["kind"] == "tool_started":
            started.setdefault(event.get("name"), []).append(event.get("detail") or "")
            continue
        if event["kind"] != "tool_finished":
            continue
        name = event.get("name")
        label = friendly(name)
        detail = (started.get(name) or [""]).pop(0) if started.get(name) else ""
        ok = event.get("ok") is not False and not str(event.get("detail") or "").startswith("Not run")
        if plain and plain[-1]["label"] == label:
            plain[-1]["count"] += 1
            plain[-1]["failed"] += 0 if ok else 1
        else:
            plain.append({"label": label, "count": 1, "failed": 0 if ok else 1})
        if not ok:
            failed.append({"step": label, "detail": _clip(event.get("detail"), 240)})
            continue
        bucket = _bucket(name)
        if bucket:
            produced.setdefault(bucket, []).append(_item(detail))
    lines = [f"{row['label']}" + (f" ({row['count']} times)" if row["count"] > 1 else "")
             + (f", {row['failed']} not done" if row["failed"] else "") for row in plain]
    return {"steps": lines, "produced": produced, "failed_steps": failed,
            "truncated": any(e["kind"] == "truncated" for e in events)}


def _link(run: dict) -> Optional[dict]:
    """Where the run can be read: its conversation, or for a delegated card, the teammate's work thread."""
    session_id = run.get("session_id")
    if not session_id and run.get("task_id"):
        from services.task_service import task_service
        task = task_service.get_task(run["task_id"]) or {}
        session_id = task.get("work_session_id") or (task.get("requester") or {}).get("session_id") or task.get("reply_to")
    if not session_id:
        return {"tab": "botsShell", "agentId": run.get("agent_id"), "runId": run["id"]}
    return {"tab": "botsShell", "agentId": run.get("agent_id"), "sessionId": session_id, "runId": run["id"]}


def _what(run: dict) -> str:
    from services.task_service import task_service
    if run.get("task_id"):
        task = task_service.get_task(run["task_id"])
        if task:
            return ("Card: " if task.get("schedule_kind") == "card" else "Routine: ") + _clip(task.get("name"), 80)
    if run.get("purpose"):
        return _clip(run["purpose"].replace("_", " ").capitalize(), 80)
    return "Conversation turn" if run.get("session_id") else "Background run"


def action_name(name: Optional[str]) -> str:
    """What was asked for, in words ("Prepare post"), not as if it happened."""
    words = (name or "a step").removeprefix("mcp__hive_mind__").removeprefix("content_studio_").replace("__", " ").replace("_", " ").strip()
    return words[:1].upper() + words[1:]


def _decision_line(row: dict, names: dict) -> str:
    tool = action_name(row.get("tool"))
    source, outcome = row.get("source"), row.get("outcome")
    if source == "team":
        return f"{tool}: went ahead as the team's own work."
    if source == "asks-person":
        return f"{tool}: went ahead, asking you is always allowed."
    if source == "nobody-to-ask":
        return f"{tool}: did not run. Nobody was there to ask."
    if source == "timeout" or outcome == "expired":
        return f"{tool}: did not run. Nobody answered in time."
    if source in ("asked", "asked-batch"):
        scope = {"forever": " for good", "session": " for this chat", "team": " for the team"}.get(row.get("scope") or "", " once")
        return f"{tool}: you allowed it{scope}." if outcome == "allow" else f"{tool}: you denied it."
    if source == "saved-rule":
        return f"{tool}: allowed by a rule you saved." if outcome == "allow" else f"{tool}: refused by a rule you saved."
    reason = _clip(row.get("reason"), 160)
    return f"{tool}: {'went ahead' if outcome == 'allow' else 'did not run'}. {reason}".strip()


def _decisions(user: str, bot_id: str, since: float) -> list[dict]:
    from core import bot_policy
    from core.auth import SINGLE_USER
    rows = bot_policy.decisions(None, bot_id=bot_id, since=since, limit=1000)
    # Rows from before the owner fix carry "local"; this account's folder is the person's own.
    return [r for r in rows if r.get("owner") in (user, SINGLE_USER, None)]


def approvals_of(user: str, bot_id: str, since: float) -> dict:
    rows = [r for r in _decisions(user, bot_id, since) if r.get("source") in DECISION_SOURCES]
    asked = [r for r in rows if r.get("source") in ("asked", "asked-batch", "timeout")]
    summary = {"asked": len(asked), "allowed": sum(1 for r in asked if r.get("outcome") == "allow"),
               "denied": sum(1 for r in asked if r.get("outcome") == "deny"),
               "expired": sum(1 for r in asked if r.get("outcome") == "expired" or r.get("source") == "timeout"),
               "team": sum(1 for r in rows if r.get("source") == "team"),
               "could_not_ask": sum(1 for r in rows if r.get("source") == "nobody-to-ask")}
    recent = [{"at": r.get("at"), "text": _decision_line(r, {}), "outcome": r.get("outcome"), "source": r.get("source"),
               "thread_id": r.get("thread_id")} for r in rows if r.get("source") != "team"][:20]
    return {"summary": summary, "recent": recent}


def _runs(bot_id: str, since: float, limit: int) -> list[dict]:
    from core import session_manager_store as store
    return [r for r in store.find_runs(agent_id=bot_id, limit=max(limit * 4, 50)) if (r.get("started_at") or 0) >= since][:limit]


def bot_report(user: str, bot_id: str, *, days: int = DEFAULT_DAYS, limit: int = RUN_LIMIT, detail: bool = True) -> dict:
    from core import run_cost
    from services import bot_attention, bot_departments
    from services.task_service import task_service
    bot = bot_attention.require_bot(bot_id, user)
    days = max(1, min(int(days or DEFAULT_DAYS), MAX_DAYS))
    now = time.time()
    since = now - days * 86400
    runs = _runs(bot_id, since, limit)
    produced: dict[str, list] = {}
    rows, errors = [], []
    for run in runs:
        facts = steps_of(run["id"]) if detail else {"steps": [], "produced": {}, "failed_steps": [], "truncated": False}
        for bucket, items in facts["produced"].items():
            produced.setdefault(bucket, []).extend(items)
        if run.get("session_id") and run.get("outcome") == "finished" and (run.get("surface") == "chat"):
            produced.setdefault("replies", []).append("")
        task = task_service.get_task(run["task_id"]) if run.get("task_id") else None
        if task and task.get("schedule_kind") == "card":
            produced.setdefault("cards", []).append(_clip(task.get("name"), 80))
        if run.get("outcome") == "failed":
            kind = run.get("error_class") or "other"
            errors.append({"at": run.get("started_at"), "what": _clip(run.get("detail") or "The run failed.", 240),
                           "fix": FIX.get(kind, FIX["other"]), "link": _link(run)})
        rows.append({"id": run["id"], "what": _what(run), "started_at": run.get("started_at"), "ended_at": run.get("ended_at"),
                     "outcome": run.get("outcome"), "result": OUTCOME.get(run.get("outcome"), run.get("outcome") or ""),
                     "tokens": run.get("total_tokens"), "cost_usd": run.get("cost_usd"), "model": run.get("model"),
                     "tool_calls": run.get("tool_calls") or 0, "steps": facts["steps"], "failed_steps": facts["failed_steps"],
                     "truncated": facts["truncated"], "link": _link(run)})
    approvals = approvals_of(user, bot_id, since)
    if approvals["summary"]["could_not_ask"]:
        errors.append({"at": None, "what": f"{approvals['summary']['could_not_ask']} step(s) did not run because nobody "
                                           "was there to ask.",
                       "fix": "Kairos now asks you in your Inbox for a teammate's work. For a bot you talk to, keep its "
                              "conversation open, or raise its approval in Permissions.", "link": None})
    cost = run_cost.summarize(runs)
    team = bot_departments.team_of(bot_id)
    return {"bot": {"id": bot["id"], "name": bot.get("name"), "role": bot.get("role") or "", "color": bot.get("color"),
                    "approval_mode": bot.get("approval_mode"), "team": (team or {}).get("name"), "team_id": (team or {}).get("id")},
            "days": days, "since": since, "generated_at": now,
            "totals": {"runs": len(runs), "finished": sum(1 for r in runs if r.get("outcome") == "finished"),
                       "failed": sum(1 for r in runs if r.get("outcome") == "failed"),
                       "tokens": sum(r.get("total_tokens") or 0 for r in runs), "cost_usd": cost["total_usd"],
                       "cost_complete": cost["complete"]},
            "produced": _produced(produced), "approvals": approvals, "errors": errors[:20], "runs": rows}


def _produced(buckets: dict) -> list[dict]:
    out = []
    for key in ("topics", "picks", "scripts", "renders", "queued", "prepared", "posts", "formats", "handoffs", "files",
                "cards", "replies"):
        items = buckets.get(key) or []
        if not items:
            continue
        named = [i for i in items if i]
        seen, unique = set(), []
        for name in named:
            if name not in seen:
                seen.add(name)
                unique.append(name)
        out.append({"key": key, "label": PRODUCED_LABELS[key], "count": len(items), "items": unique[:8]})
    return out


def team_report(user: str, team_id: str, *, days: int = DEFAULT_DAYS) -> dict:
    from services import bot_departments
    team = bot_departments.get(team_id, user)
    members = bot_departments.members(team_id, user)
    tiers = team.get("model_tiers") or {}
    rows, totals, produced = [], {"runs": 0, "finished": 0, "failed": 0, "tokens": 0, "cost_usd": None, "asked": 0,
                                  "team": 0, "could_not_ask": 0}, {}
    for bot in members:
        report = bot_report(user, bot["id"], days=days, limit=RUN_LIMIT)
        last = report["runs"][0] if report["runs"] else None
        line = {"bot_id": bot["id"], "name": bot.get("name"), "role": bot.get("role") or "", "color": bot.get("color"),
                "tier": tiers.get(bot["id"]), "runs": report["totals"]["runs"], "failed": report["totals"]["failed"],
                "tokens": report["totals"]["tokens"], "cost_usd": report["totals"]["cost_usd"],
                "asked": report["approvals"]["summary"]["asked"], "team_allowed": report["approvals"]["summary"]["team"],
                "could_not_ask": report["approvals"]["summary"]["could_not_ask"],
                "last": {"what": last["what"], "result": last["result"], "ended_at": last["ended_at"], "link": last["link"]} if last else None,
                "produced": report["produced"]}
        rows.append(line)
        for key in ("runs", "finished", "failed", "tokens"):
            totals[key] += report["totals"][key] or 0
        if report["totals"]["cost_usd"] is not None:
            totals["cost_usd"] = round((totals["cost_usd"] or 0) + report["totals"]["cost_usd"], 6)
        totals["asked"] += line["asked"]
        totals["team"] += line["team_allowed"]
        totals["could_not_ask"] += line["could_not_ask"]
        for item in report["produced"]:
            entry = produced.setdefault(item["key"], {"key": item["key"], "label": item["label"], "count": 0, "items": []})
            entry["count"] += item["count"]
            entry["items"] = (entry["items"] + [i for i in item["items"] if i not in entry["items"]])[:8]
    return {"team": {"id": team["id"], "name": team["name"], "internal_tools": len(team.get("internal_tools") or [])},
            "days": max(1, min(int(days or DEFAULT_DAYS), MAX_DAYS)), "generated_at": time.time(),
            "totals": totals, "members": rows, "produced": list(produced.values())}


def content_team_id(user: str) -> Optional[str]:
    """The team the Content Studio bots belong to, for Studio > Content's link (None when there is none)."""
    try:
        from services import bot_departments
        from services.content_studio import studio, team as studio_team
        for bot_id in studio_team.roles(studio):
            found = bot_departments.team_of(bot_id)
            if found and found.get("owner_user") == user:
                return found["id"]
    except Exception:
        return None
    return None


def to_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)
