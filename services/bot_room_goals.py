"""Goals in a room: "Work until done" with a coordinator (Phase 4, unit U2).

A person sends a message in Goal mode. One member, the coordinator (the one
@mentioned, else the room's lead, else the first member), works the goal in
steps. Each step is an ordinary room turn; the coordinator ends every reply
with the private control line the solo goals use, and can hand work to
teammates with `coordinate_bots`, then end its turn and be woken with the
results. The loop, its bounds (13 steps, the same step three times blocks it,
one retry for a failed step) and the control line are the solo ones in
services/bot_goal_runs.py; this file only supplies the room's step runner.

Rules this file keeps:
- One live goal per thread. A second goal there is refused (409).
- Progress goes out at most every 400 ms, secret-redacted, 500 characters.
- A goal that ends without an outcome is marked failed.
- A person's Stop ends the goal. It never survives the room being deleted.
"""
import logging

from services import bot_goal_runs as goals, bot_room_events as feed, bot_rooms as rooms
from core import bot_rooms_store as store, events

logger = logging.getLogger(__name__)


def _key(room_id: str, thread_id: str) -> str:
    return f"room:{room_id}:{thread_id}"


def _run(room_id: str, thread_id: str) -> dict | None:
    return goals._RUNS.get(_key(room_id, thread_id))


def live(room_id: str, thread_id: str) -> bool:
    run = _run(room_id, thread_id)
    return bool(run and run["status"] == "working")


def current(room_id: str, thread_id: str) -> dict | None:
    run = _run(room_id, thread_id)
    return goals.public(run) if run else None


def _turns():
    from services import bot_room_turns
    return bot_room_turns


class RoomRunner:
    """Runs each goal step as a room turn of the coordinator."""

    def __init__(self, room_id: str, thread_id: str, bot_id: str):
        self.room_id, self.thread_id, self.bot_id = room_id, thread_id, bot_id

    async def settle(self, run: dict) -> tuple[str, str | None]:
        turns = _turns()
        if run["cancelled"]:
            return "stopped", ""
        step = run["turn"]
        note = (f"This is a goal. Keep working on it until it is finished. The goal: {run['instruction'][:4000]}"
                if step == 1 else f"Goal, step {step}: {run['instruction']}")
        async with turns._lock((self.room_id, self.thread_id)):
            if run["cancelled"]:
                return "stopped", ""
            result = await turns.run_member_turn(self.room_id, self.thread_id, self.bot_id, hop=0, origin="goal",
                                                 attended=True, goal=True, extra_text=note)
        if result.get("turn_id"):
            run["current_turn_id"] = result["turn_id"]
            run["run_ids"].append(result["turn_id"])
        outcome = result["outcome"]
        if run["cancelled"] or outcome == "cancelled":
            return "stopped", result.get("raw")
        if outcome != "settled":
            return "failed", result.get("raw")
        return "done", result.get("raw") or ""

    async def next_step(self, run: dict, instruction: str):
        run["turn"] += 1
        run["instruction"] = instruction
        goals._frame(run)
        return True

    def cancel(self, run: dict) -> None:
        _turns().interrupt_member(self.room_id, self.bot_id, "stop")


def _emit(room_id: str, thread_id: str, owner: str):
    def send(view: dict) -> None:
        feed.publish("room.goal", room_id, {"thread_id": thread_id, "goal": view}, owner)
        try:
            store.update_thread(room_id, thread_id, goal=view)
        except store.Missing:
            pass
    return send


def _finished(room_id: str, thread_id: str, owner: str, scheduled: bool = False):
    def done(run: dict, status: str, line: str, digest: dict) -> None:
        try:
            rooms.add_row(room_id, thread_id, "system", line, kind="goal",
                          meta={"digest": digest, "status": status, "goal": run["goal"], "root_id": run["root_id"]})
        except Exception:
            logger.exception("could not record the end of goal %s", run["root_id"])
        events.emit("bot.room_goal_finished", f"Room goal {status}", level="warn" if status in ("failed", "blocked") else "info",
                    agent_id=run["bot_id"], room_id=room_id, owner=owner, root_id=run["root_id"], status=status,
                    steps=run["turn"], scheduled=scheduled, notify="done" if status == "completed" else
                    "question" if status == "needs-input" and scheduled else None)
    return done


def coordinator_for(room: dict, text: str, infos: list[dict]) -> dict | None:
    """The member who works the goal: the one @mentioned, else the lead, else the first member that is not held."""
    from services import bot_room_holds as holds
    open_infos = [i for i in infos if not i["held"]]
    found = holds.find_mentions(text, infos)
    for info in open_infos:
        if info["bot_id"] in found["ids"]:
            return info
    lead = (room["default_responder"] or {}).get("bot_id") if (room["default_responder"] or {}).get("kind") == "member" else None
    for info in open_infos:
        if info["bot_id"] == lead:
            return info
    return open_infos[0] if open_infos else None


async def start_from_round(room: dict, thread_id: str, text: str, infos: list[dict], owner: str) -> dict | None:
    """Called by the turn runner for a Goal-mode message. Returns the first progress view, or None."""
    coordinator = coordinator_for(room, text, infos)
    if coordinator is None:
        rooms.chip(room["id"], thread_id, "Everyone is on hold, so the goal could not start.")
        return None
    if live(room["id"], thread_id):
        rooms.chip(room["id"], thread_id, "This thread already has a goal running.")
        return None
    return start(room["id"], thread_id, coordinator["bot_id"], text, owner)


def start(room_id: str, thread_id: str, bot_id: str, text: str, owner: str, scheduled: bool = False) -> dict:
    if live(room_id, thread_id):
        from fastapi import HTTPException
        raise HTTPException(409, "This thread already has a goal running. Stop it first.")
    runner = RoomRunner(room_id, thread_id, bot_id)
    run = goals.begin_custom(owner, _key(room_id, thread_id), bot_id, text, runner,
                             emit=_emit(room_id, thread_id, owner), on_finish=_finished(room_id, thread_id, owner, scheduled),
                             tail_fn=lambda: _turns().live_text(room_id, thread_id))
    task = run.get("task")
    if task is not None:
        def ended(done, run=run):
            if run["status"] == "working":
                goals._finish(run, "failed", "The goal ended without an outcome.")
        task.add_done_callback(ended)
    return goals.public(run)


def stop(owner: str, room_id: str, thread_id: str) -> dict:
    run = _run(room_id, thread_id)
    if run is None:
        return {"outcome": "already-stopped"}
    return goals.stop(owner, _key(room_id, thread_id), run["root_id"])


def stop_room(room_id: str, owner: str) -> int:
    """Stop every live goal in the room."""
    count = 0
    for thread in store.threads(room_id):
        run = _run(room_id, thread["id"])
        if run and run["status"] == "working":
            run["cancelled"] = True
            run["runner"].cancel(run)
            count += 1
    return count


def forget_room(room_id: str) -> None:
    for key in [k for k in goals._RUNS if k.startswith(f"room:{room_id}:")]:
        goals._RUNS.pop(key, None)


# -- team goals: a routine whose target is a room (Phase 3 routines call these) ------------

def validate_routine_target(owner: str, target) -> dict:
    """A routine's `target: {kind: "room", room_id, mode: "goal"}` as stored, with the lead that works it.
    The lead is the room's default lead, else the first member. Raises HTTPException (422 or 404)."""
    from fastapi import HTTPException
    if not isinstance(target, dict) or target.get("kind") != "room" or target.get("mode", "goal") != "goal":
        raise HTTPException(422, "A room target is {kind: room, room_id, mode: goal}")
    room = rooms.get(str(target.get("room_id") or ""), owner)
    if room["archived_at"] or room["setup_state"] == "pending":
        raise HTTPException(409, "That room is not ready for a goal")
    members = [m["bot_id"] for m in store.members(room["id"])]
    if not members:
        raise HTTPException(409, "That room has no bots")
    responder = room["default_responder"] or {}
    lead = target.get("lead_bot_id") or (responder.get("bot_id") if responder.get("kind") == "member" else None) or members[0]
    if lead not in members:
        raise HTTPException(422, "The lead must be in the room")
    return {"kind": "room", "room_id": room["id"], "mode": "goal", "lead_bot_id": lead}


def link_routine(owner: str, routine_id: str, target) -> dict:
    """Record that this routine's goals run in a room, so its lead cannot be removed from the room
    and deleting the room disables it."""
    clean = validate_routine_target(owner, target)
    store.link_routine(routine_id, clean["room_id"], clean["lead_bot_id"])
    return clean


def unlink_routine(routine_id: str) -> None:
    store.unlink_routine(routine_id)


def lead_in_use(room_id: str, bot_id: str) -> bool:
    return any(link["lead_bot_id"] == bot_id for link in store.routines_of_room(room_id))


def routine_ids_for_room(room_id: str) -> list[str]:
    return [link["routine_id"] for link in store.routines_of_room(room_id)]


def start_routine(owner: str, routine_id: str, text: str, occurrence_id: str) -> dict:
    """One occurrence of a team-goal routine: a "Scheduled goal" line in the room's first thread, then the
    goal, worked by the routine's lead. The same occurrence never starts twice. {started, reason?, thread_id?}."""
    link = store.routine_link(routine_id)
    room = store.get_room(link["room_id"]) if link else None
    if room is None or room["archived_at"] or room["owner"] != owner:
        return {"started": False, "reason": "The room is gone."}
    lead = store.member(room["id"], link["lead_bot_id"])
    if lead is None:
        return {"started": False, "reason": "The lead is no longer in the room."}
    if lead["held_at"]:
        return {"started": False, "reason": "The lead is on hold."}
    thread = store.threads(room["id"])[0]
    if live(room["id"], thread["id"]):
        return {"started": False, "reason": "A goal is already running in that room."}
    row, created = rooms.add_row(room["id"], thread["id"], "system", f"Scheduled goal: {text.strip()[:300]}", kind="goal",
                                 send_id=f"routine-{routine_id}-{occurrence_id}", meta={"scheduled": True, "routine_id": routine_id})
    if not created:
        return {"started": False, "reason": "This occurrence already ran.", "thread_id": thread["id"]}
    start(room["id"], thread["id"], lead["bot_id"], text, owner, scheduled=True)
    return {"started": True, "thread_id": thread["id"], "message_id": row["id"]}
