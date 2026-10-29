"""Solo goals: "Work until done" for one bot in one conversation (Bots Phase 1).

A goal is a chain of ordinary turns. Each step goes through the same admission
door, live feed, permission prompts and cancellation as a typed message
(services/bot_chat_service.py); this module only decides, after each reply,
whether to send another step. The bot ends every reply with a private control
line (the envelope below). The person never sees it: it is held back while the
reply streams and removed from the saved text afterwards.

Bounds: 13 steps; the same assignment three times is blocked; one failed step
is retried once; a missing or unreadable control line stops the goal with a
plain explanation the person can act on. Stop names the goal's root and its
current turn. A room goal (services/bot_room_goals.py) drives the same loop with its own
runner: `begin_custom` takes a runner whose `settle` runs one coordinator turn and returns
(status, raw reply), `next_step` queues the next instruction and `cancel` stops it. The bounds,
the control line and `public` are shared, so a goal looks the same wherever it runs.
"""
import asyncio
import json
import logging
import re
import time
import uuid

from fastapi import HTTPException

from core import bot_chat_store as store, events, logs
from core.session_manager import session_manager
from services import chat_live

logger = logging.getLogger(__name__)

OPEN, CLOSE = "<kairos-goal>", "</kairos-goal>"
MAX_STEPS = 13
REPEAT_LIMIT = 3
FRAME_GAP = 0.4  # progress frames at most this often
ADMISSION_WAIT = 60.0
STATUSES = ("continue", "completed", "needs-input", "blocked")
FINAL_LABELS = {"completed": "Done", "needs-input": "Needs your answer", "blocked": "Blocked",
                "stopped": "Stopped", "failed": "Failed", "limit-reached": "Step limit reached"}
NOTE = (
    "\n\n[Work until done mode. Keep working on this until it is finished. End every reply with one control "
    'line: <kairos-goal>{"status": "continue", "instruction": "what to do in the next step", "detail": '
    '"one short sentence on progress"}</kairos-goal>. The status is one of: continue (more steps are needed), '
    "completed (the goal is met), needs-input (you must ask the person something first), blocked (you cannot "
    "go on). The person never sees this line, so also say plainly in your reply what you did.]"
)
_ENVELOPE = re.compile(re.escape(OPEN) + r"(.*?)" + re.escape(CLOSE), re.DOTALL)

_RUNS: dict[str, dict] = {}  # session id -> the newest goal there (kept after it ends)
_TASKS: set = set()


class EnvelopeFilter:
    """Keeps the control line out of live text, even when its tags arrive split
    across stream chunks. Anything that could still turn into the opening tag
    is held until the next chunk shows what it is."""

    def __init__(self):
        self.held = ""
        self.inside = False

    def feed(self, chunk: str) -> str:
        text, out = self.held + chunk, ""
        self.held = ""
        while text:
            if self.inside:
                end = text.find(CLOSE)
                if end >= 0:
                    text, self.inside = text[end + len(CLOSE):], False
                    continue
                keep = _tail_prefix(text, CLOSE)
                self.held = text[len(text) - keep:] if keep else ""
                break
            start = text.find(OPEN)
            if start >= 0:
                out += text[:start]
                text, self.inside = text[start + len(OPEN):], True
                continue
            keep = _tail_prefix(text, OPEN)
            out += text[:len(text) - keep]
            self.held = text[len(text) - keep:] if keep else ""
            break
        return out

    def flush(self) -> str:
        """Whatever is still held when the reply ends. An unfinished control line is dropped."""
        held, self.held = ("" if self.inside else self.held), ""
        return held


def _tail_prefix(text: str, tag: str) -> int:
    """Length of the longest tail of `text` that begins `tag` (but is not all of it)."""
    for size in range(min(len(tag) - 1, len(text)), 0, -1):
        if tag.startswith(text[-size:]):
            return size
    return 0


def parse(text: str) -> tuple[str, dict | None]:
    """(visible text, the control line) of a finished reply. The last complete
    line wins; None when it is missing or not valid."""
    matches = list(_ENVELOPE.finditer(text or ""))
    visible = _ENVELOPE.sub("", text or "")
    cut = visible.find(OPEN)  # an opening tag that never closed
    if cut >= 0:
        visible = visible[:cut]
    if not matches:
        return visible.strip(), None
    try:
        data = json.loads(matches[-1].group(1))
    except ValueError:
        return visible.strip(), None
    if not isinstance(data, dict) or data.get("status") not in STATUSES:
        return visible.strip(), None
    instruction, detail = data.get("instruction"), data.get("detail")
    return visible.strip(), {"status": data["status"],
                             "instruction": instruction.strip()[:4000] if isinstance(instruction, str) else "",
                             "detail": detail.strip()[:500] if isinstance(detail, str) else ""}


# -- public view ------------------------------------------------------------------

def public(run: dict) -> dict:
    if run.get("tail_fn"):
        tail = logs.scrub_credentials(run["tail_fn"]()[-400:]) if run["status"] == "working" else ""
    else:
        turn = chat_live.current_turn(run["session_id"]) if run["status"] == "working" else None
        tail = logs.scrub_credentials(turn["text"][-400:]) if turn and turn["turn_id"] == run["current_turn_id"] else ""
    return {"root_id": run["root_id"], "status": run["status"], "label": FINAL_LABELS.get(run["status"], "Working"),
            "goal": run["goal"], "turn": run["turn"], "max_turns": MAX_STEPS,
            "detail": logs.scrub_credentials(run["detail"])[:500], "tail": tail,
            "started_at": run["started_at"], "updated_at": run["updated_at"],
            "turn_id": run["current_turn_id"] if run["status"] == "working" else None}


def current(session_id: str) -> dict | None:
    run = _RUNS.get(session_id)
    return public(run) if run else None


def _frame(run: dict, force: bool = False) -> None:
    now = time.monotonic()
    if not force and now - run.get("_frame_at", 0) < FRAME_GAP:
        return
    run["_frame_at"] = now
    if run.get("emit"):
        run["emit"](public(run))
        return
    chat_live.broadcast_owner({"type": "bot_goal", "sessionId": run["session_id"], "goal": public(run)})


# -- running ----------------------------------------------------------------------

def begin(owner: str, sid: str, bot_id: str, payload: dict, generation: str, message_id: str | None = None) -> dict:
    """A goal's first turn has started: follow it until the goal ends."""
    now = time.time()
    run = {"root_id": uuid.uuid4().hex, "session_id": sid, "owner": owner, "bot_id": bot_id,
           "goal": " ".join(payload["text"].split())[:180], "status": "working", "turn": 1, "detail": "",
           "started_at": now, "updated_at": now, "current_turn_id": generation, "cancelled": False,
           "retried": False, "seen": {}, "run_ids": [], "message_id": message_id, "outcome": None, "instruction": payload["text"]}
    _RUNS[sid] = run
    _frame(run, force=True)
    try:
        task = asyncio.get_running_loop().create_task(_drive(run))
    except RuntimeError:
        return run  # no loop (a unit test calling begin directly)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return run


def begin_custom(owner: str, key: str, bot_id: str, goal_text: str, runner, *, emit=None, on_finish=None,
                 tail_fn=None, instruction: str | None = None) -> dict:
    """A goal run by someone other than a bot's own thread (a room). `key` names it in _RUNS;
    `runner` has settle(run), next_step(run, instruction), cancel(run) and optionally strip(run, visible)."""
    now = time.time()
    run = {"root_id": uuid.uuid4().hex, "session_id": key, "owner": owner, "bot_id": bot_id,
           "goal": " ".join(goal_text.split())[:180], "status": "working", "turn": 1, "detail": "",
           "started_at": now, "updated_at": now, "current_turn_id": None, "cancelled": False,
           "retried": False, "seen": {}, "run_ids": [], "message_id": None, "outcome": None,
           "instruction": instruction or goal_text, "runner": runner, "emit": emit, "on_finish": on_finish,
           "tail_fn": tail_fn}
    _RUNS[key] = run
    _frame(run, force=True)
    try:
        task = asyncio.get_running_loop().create_task(_drive(run))
    except RuntimeError:
        return run
    run["task"] = task
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return run


def note_interrupt(sid: str, turn_id: str) -> None:
    run = _RUNS.get(sid)
    if run and run["status"] == "working" and run["current_turn_id"] == turn_id:
        run["cancelled"] = True


def stop(owner: str, sid: str, root_id: str) -> dict:
    """Stop a goal by its root. Names both the goal and its current turn, so a
    stale request for an earlier goal cannot stop a newer one."""
    run = _RUNS.get(sid)
    if not run or run["root_id"] != root_id or run["status"] != "working" or run["owner"] != owner:
        return {"outcome": "already-stopped", "root_id": root_id}
    run["cancelled"] = True
    if run.get("runner"):
        run["runner"].cancel(run)
    else:
        chat_live.stop_turn(sid, run["current_turn_id"], "person")
    return {"outcome": "stopping", "root_id": root_id}


def turn_ended(sid: str, turn: dict) -> None:
    """Hook from the runtime when any turn of the session ends. The driver
    waits on the turn itself; this only records its provider run."""
    run = _RUNS.get(sid)
    if run and run["status"] == "working" and run["current_turn_id"] == turn["turnId"]:
        run["outcome"] = {"turn_id": turn["turnId"], "status": turn["status"]}
        if turn.get("runId"):
            run["run_ids"].append(turn["runId"])


def _finish(run: dict, status: str, detail: str) -> None:
    if run["status"] != "working":
        return
    run.update(status=status, detail=detail, updated_at=time.time())
    seconds = round(run["updated_at"] - run["started_at"])
    digest = {"root_id": run["root_id"], "status": status, "steps": run["turn"], "seconds": seconds,
              "run_ids": list(run["run_ids"])}
    line = f"{FINAL_LABELS[status]}: {run['turn']} step{'s' if run['turn'] != 1 else ''}, {seconds} seconds."
    if run.get("on_finish"):
        try:
            run["on_finish"](run, status, line, digest)
        except Exception:
            logger.exception("goal %s finish hook failed", run["root_id"])
    else:
        try:
            session_manager.append_message(
                run["session_id"], "assistant", line,
                extra={"display_only": True, "kind": "goal_digest", "digest": digest, "goal_root": run["root_id"]})
        except KeyError:
            pass  # the conversation was deleted while the goal ran
    events.emit("bot.goal_finished", f"Goal {status}", level="warn" if status in ("failed", "blocked") else "info",
                agent_id=run["bot_id"], session_id=run["session_id"], owner=run["owner"],
                root_id=run["root_id"], status=status, steps=run["turn"])
    _frame(run, force=True)


def _normal(text: str) -> str:
    return " ".join((text or "").lower().split())


class SoloRunner:
    """A goal in one bot's own thread: each step is a normal message through the admission door."""

    async def settle(self, run: dict) -> tuple[str, str | None]:
        sid, turn_id = run["session_id"], run["current_turn_id"]
        await chat_live.wait_settled(sid, turn_id, timeout=6 * 3600)
        outcome = run.get("outcome")
        status = outcome["status"] if outcome and outcome["turn_id"] == turn_id else "done"
        reply = _reply(run)
        run["_reply_index"] = reply["index"] if reply else None
        return status, (reply["content"] if reply else "")

    def strip(self, run: dict, visible: str) -> None:
        if run.get("_reply_index") is None:
            return
        try:
            session_manager.edit_message_content(run["session_id"], run["_reply_index"], visible)
        except (KeyError, IndexError):
            pass

    async def next_step(self, run: dict, instruction: str):
        return await _next_step(run, instruction)

    def cancel(self, run: dict) -> None:
        chat_live.stop_turn(run["session_id"], run["current_turn_id"], "person")


_SOLO = SoloRunner()


async def _drive(run: dict) -> None:
    runner = run.get("runner") or _SOLO
    try:
        while True:
            status, content = await runner.settle(run)
            if run["cancelled"] or status == "stopped":
                return _finish(run, "stopped", "You stopped this.")
            if status == "failed":
                if run["retried"]:
                    return _finish(run, "failed", "A step failed twice, so the goal stopped.")
                run["retried"] = True
                step = await runner.next_step(run, run["instruction"])
                if step is None:
                    return
                continue
            visible, envelope = parse(content or "")
            if content is not None and visible != (content or "").strip() and hasattr(runner, "strip"):
                runner.strip(run, visible)
            if envelope is None:
                return _finish(run, "blocked", "The reply did not end with a readable control line, so the goal "
                                                "stopped. Send a message to carry on.")
            run["detail"] = envelope["detail"]
            run["updated_at"] = time.time()
            if envelope["status"] != "continue":
                return _finish(run, envelope["status"], envelope["detail"])
            instruction = envelope["instruction"] or "Continue with the next step."
            key = _normal(instruction)
            run["seen"][key] = run["seen"].get(key, 0) + 1
            if run["seen"][key] >= REPEAT_LIMIT:
                return _finish(run, "blocked", "The same step came up three times, so the goal stopped.")
            if run["turn"] >= MAX_STEPS:
                return _finish(run, "limit-reached", f"The goal used all {MAX_STEPS} steps.")
            run["retried"] = False
            run["instruction"] = instruction
            step = await runner.next_step(run, instruction)
            if step is None:
                return
    except asyncio.CancelledError:
        _finish(run, "stopped", "The app was closed.")
        raise
    except Exception:
        logger.exception("goal %s failed", run["root_id"])
        _finish(run, "failed", "The goal stopped because of an error.")


def _reply(run: dict) -> dict | None:
    if not run.get("message_id"):
        from core import bot_message_tree as tree
        session = session_manager.get_session(run["session_id"])
        if session is None:
            return None
        for message in reversed(tree.ancestry(session)):
            if message.get("role") == "user" and not message.get("display_only"):
                run["message_id"] = message["bot_message_id"]
                break
    found = store.reply_to(run["session_id"], run["message_id"]) if run.get("message_id") else None
    return {"index": found[0], "content": found[1].get("content") or ""} if found else None


async def _next_step(run: dict, instruction: str) -> dict | None:
    """Send the next step through the normal admission door, waiting while the
    thread is busy. None when the goal was stopped, or could not be admitted."""
    from services import bot_chat_service
    from services.agent_service import agent_service
    sid, number = run["session_id"], run["turn"] + 1
    bot = agent_service.get(run["bot_id"])
    deadline = time.monotonic() + ADMISSION_WAIT
    while bot is not None:
        if run["cancelled"]:
            _finish(run, "stopped", "You stopped this.")
            return None
        leaf = (session_manager.get_session(sid) or {}).get("thread", {}).get("active_leaf_id")
        payload = {"send_id": f"goal-{run['root_id']}-{number}", "text": instruction, "expected_leaf_id": leaf,
                   "attachment_ids": [], "reply_to_id": None, "citations": [], "references": [],
                   "mode": "goal-step", "goal_step": number, "goal_root": run["root_id"]}
        try:
            result = bot_chat_service._admit(run["owner"], sid, bot, payload, "", direct_only=True)
        except HTTPException as error:
            if error.status_code != 409 or time.monotonic() > deadline:
                _finish(run, "blocked", "The bot stayed busy, so the goal stopped.")
                return None
        except store.Conflict:
            if time.monotonic() > deadline:
                _finish(run, "blocked", "The conversation kept changing, so the goal stopped.")
                return None
        else:
            run.update(turn=number, current_turn_id=result["turn_id"], message_id=result["message_id"])
            _frame(run)
            return result
        await asyncio.sleep(0.25)
    _finish(run, "failed", "The bot no longer exists.")
    return None
