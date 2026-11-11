"""The Content setup (onboarding) in Studio > Content: the facts its checklist is drawn from, and its two team actions.

David (2026-11-11), setting up Studio > Content for real, met a YouTube row that said "Check" and had to ask what to do
next. The setup is a checklist on the All channels dashboard: each step's real state, with the action inline, until
every required step is done (he can hide it and open it again from the rail). The screen works out the step states
(static/js/studioContentModel.js `setupSteps`) from what it already loads plus this: the team the template made (its
bots, their approval level, their routines and the monthly spend cap), whether the setup was hidden, and the last
"run one cycle now".

Locked rules kept: nothing here approves or posts (every post waits for the person's OK unless they turned on hands-off
posting themselves, handsoff.py; the setup says which), bots never create accounts
(nothing here makes a channel), routines start paused (only the person's click turns them on, `start_routines`), and the
only Google call is the person's own Check again (youtube.check), never this file.
"""
import os
import time

from core import accounts
from core.atomic_io import read_json, write_json_atomic

from . import team
from .store import StudioError

RUN_NAME = "Content setup: one cycle now"   # the Producer's one-off routine that "Run one cycle now" reuses
FAR = "2100-01-01T00:00:00+00:00"           # its schedule: never due on its own; it only runs on the person's click


def _path():
    return os.path.join(accounts.account_dir(create=False), "content_studio", "setup.json")


def _load():
    state = read_json(_path(), {})
    return state if isinstance(state, dict) else {}


def set_dismissed(dismissed):
    state = _load()
    state["dismissed"] = bool(dismissed)
    os.makedirs(os.path.dirname(_path()), exist_ok=True)
    write_json_atomic(_path(), state)
    return state


def _is_admin(user):
    try:
        from core.auth import auth_manager
        return bool(auth_manager.is_admin(user))
    except Exception:  # noqa: BLE001 - no auth module in a bare test: the owner check still applies
        return False


def _mode(bot_id):
    try:
        from core import bot_policy
        return bot_policy.effective_policy(bot_id).mode
    except Exception:  # noqa: BLE001 - shown as unknown, never guessed
        return None


def _routines(user, bot_ids):
    """The team bots' routines (the template's daily cycle, weekly review and metrics snapshot) and the one-off cycle."""
    try:
        from services import bot_routines
        rows = bot_routines.list_routines(user, _is_admin(user))
    except Exception:  # noqa: BLE001 - the step then says it could not read them
        return None, None
    mine = [r for r in rows if r.get("bot_id") in bot_ids]
    once = next((r for r in mine if r["name"] == RUN_NAME), None)
    keep = lambda r: {"id": r["id"], "name": r["name"], "bot_id": r["bot_id"], "enabled": r["enabled"],
                      "sentence": r.get("sentence") or "", "next_run_at": r.get("next_run_at"),
                      "last_run": {k: (r.get("last_run") or {}).get(k) for k in ("status", "started_at", "finished_at")}
                      if r.get("last_run") else None, "running": bool(r.get("running"))}
    return [keep(r) for r in mine if r["name"] != RUN_NAME], (keep(once) if once else None)


def _budget():
    try:
        from services.bot_spend import budget
        value = budget()
        return {"monthly_usd": value.get("monthly_usd"), "spent_usd": value.get("spent_usd")}
    except Exception:  # noqa: BLE001
        return None


def state(store, user):
    """What the checklist needs beyond what Studio > Content already loads."""
    roles = team.roles(store)
    bots = []
    try:
        from services.agent_service import agent_service
    except Exception:  # noqa: BLE001
        agent_service = None
    for bot_id, role in roles.items():
        agent = agent_service.get(bot_id) if agent_service else None
        if agent is None:
            continue
        bots.append({"id": bot_id, "name": agent.get("name") or role, "role": role, "mode": _mode(bot_id)})
    routines, cycle = _routines(user, set(roles)) if bots else ([], None)
    try:   # hands-off posting (handsoff.py): the setup's copy says who approves posts
        from . import handsoff
        posting = handsoff.state(store)
        hands_off = {"on": posting["on"], "paused": posting["paused"]}
    except Exception:  # noqa: BLE001 - unknown: the copy then says every post waits for the person
        hands_off = {"on": False, "paused": False}
    return {"dismissed": bool(_load().get("dismissed")), "hands_off": hands_off,
            "team": {"imported": bool(bots), "bots": bots, "routines": routines, "cycle": cycle,
                     "producer": team.producer_id(store) if bots else None, "budget": _budget()}}


def _cycle_prompt(channel):
    return (f"Run today's Content Studio cycle for one channel only: {channel['platform']} {channel['handle']} "
            f"(channel {channel['id']}). Ask the Researcher for sourced candidates, ask the Evaluator for a pick with a reason "
            "(content_studio_pick_topic), ask the Script Writer for the script (content_studio_save_script), ask the Editor to "
            "render and draft the post (content_studio_record_render), then queue the post in the approval queue with "
            "content_studio_submit_post and tell me it is waiting (with hands-off posting on, approve it yourself with "
            "content_studio_approve_post instead; Kairos posts it). Do not publish anything yourself. Run "
            "content_studio_watch and check spend against the cap.")


async def run_cycle(store, user, channel_id):
    """Run one cycle now for one channel: the Producer's one-off routine (made the first time, paused, never due on its
    own) gets this channel's instructions and runs once. It goes through the bots' routines and tools like the daily
    cycle, so every post still lands in Approvals and waits for the person."""
    from services import bot_routines
    from services.bot_routines import RoutineError
    channel = store.get_channel(channel_id)
    if channel["status"] != "live" or channel["paused"]:
        raise StudioError("That channel is archived or paused.", 409)
    producer = team.producer_id(store)
    if producer is None:
        raise StudioError("Import the Content Studio team first (Templates).", 409)
    admin = _is_admin(user)
    try:
        found = next((r for r in bot_routines.list_routines(user, admin, producer) if r["name"] == RUN_NAME), None)
        if found is None:
            found = bot_routines.create_for_owner(user, producer, {"name": RUN_NAME, "instructions": _cycle_prompt(channel),
                                                                   "schedule": {"kind": "once", "at": FAR}, "enabled": False,
                                                                   "report": "always"})
        else:
            bot_routines.patch(user, admin, found["id"], {"instructions": _cycle_prompt(channel)})
        out = await bot_routines.run_now(user, admin, found["id"])
    except RoutineError as exc:
        raise StudioError(str(exc), getattr(exc, "status", 400)) from exc
    return {"started": bool(out.get("started")), "routine_id": found["id"], "channel": channel["handle"],
            "at": time.time()}


def start_routines(store, user, enabled=True):
    """The person's click: turns the team's routines on (or off). Nothing else ever does; they start paused."""
    from services import bot_routines
    from services.bot_routines import RoutineError
    roles = team.roles(store)
    if not roles:
        raise StudioError("Import the Content Studio team first (Templates).", 409)
    admin = _is_admin(user)
    changed = []
    for row in bot_routines.list_routines(user, admin):
        if row.get("bot_id") in roles and row["name"] != RUN_NAME and bool(row["enabled"]) != bool(enabled):
            try:
                bot_routines.patch(user, admin, row["id"], {"enabled": bool(enabled)})
            except RoutineError as exc:
                raise StudioError(f"{row['name']}: {exc}", getattr(exc, "status", 400)) from exc
            changed.append(row["name"])
    return {"changed": changed, "enabled": bool(enabled)}
