"""The routines lane: admission, runs, recovery and results (Bots redesign,
Phase 3 unit U2, 2026-10-29).

Spec: phase-3-design.md section 5.4. One machine scheduler stays
(core/task_scheduler.py); this is its Bots lane, with its own 10-second due
check. It never awaits a routine: it decides, then hands the start to a
bounded background worker. Every start still goes through
`task_scheduler.start_run()` (the per-task lock), `task_scope.bind()` (the
trusted owner) and `agent_service.run()` (admission), so nothing here can
skip those.

Per occurrence, in order:
 1. Overlap. A routine already running either skips the occurrence (counted)
    or, with "queue", leaves it due so exactly one successor waits. A run that
    is waiting for the person gives way: it is cancelled and its execution
    permissions expire before the next one starts.
 2. Admission: a bot that is off or out of runs records one missed receipt.
 3. A busy bot (a conversation turn is live) defers and is rechecked every 30
    seconds; after 30 minutes it is reported, after 60 it gives up.
 4. A usage limit that frees up within 12 hours parks the routine until the
    reset plus 60 seconds.
 5. Checks (core/bot_routine_checks.py) run before the model: nothing new
    means a finished run, "NOTHING NEW", and no model call.
 6. The run: a hidden unattended conversation (`opened_by: "routine"`), the
    composed prompt, a timeout that does not count time spent waiting for the
    person, then one result posted to the destination.

Failures are classed. A transient failure retries once after 15 seconds (60
for a rate limit). Sign-in, credit and setup problems need the owner: they
fail at once and the owner is told once per bot and cause until a run
completes. A person's cancel is never retried. A run cut off by a restart is
requeued once.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextvars import ContextVar
from datetime import datetime
from typing import Callable, Optional

from core import bot_routine_checks as checks_module
from core import bot_schedules, events, task_scope
from core.untrusted import wrap_untrusted
from services import bot_routines
from services.agent_service import AdmissionDenied, agent_service, is_silent
from services.task_service import LATE_SECONDS, task_service

logger = logging.getLogger(__name__)

TICK_SECONDS = 10
BUSY_RECHECK_SECONDS = 30
BUSY_NOTICE_SECONDS = 30 * 60
BUSY_GIVE_UP_SECONDS = 60 * 60
RETRY_DELAY_SECONDS = 15
RATE_LIMIT_DELAY_SECONDS = 60
USAGE_PARK_WINDOW_SECONDS = 12 * 3600
WATCH_POLL_SECONDS = 5
CONTINUITY_CHARS = 2000
QUIET_REPLY = "NOTHING NEW"
LAUNCH_ID = uuid.uuid4().hex[:12]
POST_BOUND = 4000

_now: Callable[[], float] = time.time
_inflight: set = set()
_active: dict[str, dict] = {}
_end_hooks: list[Callable] = []
_started_up = False
_current: ContextVar = ContextVar("routine_run", default=None)


class RunTimeout(Exception):
    """The run's own time limit, not counting time spent waiting for the person."""


# -- what a run is told about itself --------------------------------------------------------

def current_run() -> Optional[dict]:
    """The trusted context of the routine run this code is inside, or None:
    {routine_id, run_id, bot_id, owner, access, unattended: True, trigger}.
    The approval and tool layers read this to confine a run to read-and-draft
    and to treat it as unattended; it never comes from model arguments."""
    context = _current.get()
    return dict(context) if context and context.get("active") else None


def register_run_end(fn: Callable) -> None:
    """Call `fn(task_id, run_id, reason)` whenever a run ends, is cancelled or
    is superseded, so execution permissions for it can expire."""
    _end_hooks.append(fn)


def _notify_end(task_id: str, run_id: Optional[str], reason: str) -> None:
    for fn in list(_end_hooks):
        try:
            fn(task_id, run_id, reason)
        except Exception:
            logger.exception("run-end hook failed")


# -- waiting for the person (excluded from the timeout) --------------------------------------

def mark_waiting(task_id: str, reason: str = "") -> None:
    """The live run is waiting for the person (an approval, a question)."""
    state = _active.get(task_id)
    if state is not None and state["waiting_since"] is None:
        state["waiting_since"] = _now()
        task_service.update_active_run(task_id, waiting=True, attention=None, check_note=reason or None)


def clear_waiting(task_id: str) -> None:
    state = _active.get(task_id)
    if state is not None and state["waiting_since"] is not None:
        state["waited"] += _now() - state["waiting_since"]
        state["waiting_since"] = None
        task_service.update_active_run(task_id, waiting=False, wait_seconds=round(state["waited"], 1))


def active_seconds(state: dict) -> float:
    """Run time so far, not counting time spent waiting for the person."""
    waited = state["waited"] + (_now() - state["waiting_since"] if state["waiting_since"] is not None else 0)
    return max(0.0, _now() - state["started"] - waited)


def is_waiting(task_id: str) -> bool:
    state = _active.get(task_id)
    return bool(state and state["waiting_since"] is not None)


def cancel(task_id: str, run_id: Optional[str] = None, reason: str = "user") -> bool:
    """Stop exactly this run. A person's cancel is final: never retried."""
    from core import task_scheduler
    task = task_service.get_task(task_id)
    if task is None or (run_id and task.get("active_run_id") != run_id):
        return False
    if reason == "superseded":
        task["stop_note"] = "Superseded by the next scheduled run."
    _notify_end(task_id, task.get("active_run_id"), reason)
    return task_scheduler.stop_run(task_id)


# -- failure classes ---------------------------------------------------------------------------

_OWNER_WORDS = (("signed_out", ("sign in", "signed out", "not logged in", "log in", "login", "unauthorized", "401",
                                "authentication", "credential")),
                ("credits", ("credit", "billing", "insufficient", "payment")),
                ("usage_limit", ("usage limit", "limit reached", "quota", "exceeded your")),
                ("setup", ("add a claude connection", "has been removed", "no model", "not set up", "pick another")))
_RATE_WORDS = ("rate limit", "429", "too many requests", "overloaded")
_TRANSIENT_WORDS = ("timed out", "timeout", "temporar", "connection", "network", "502", "503", "504", "reset by peer",
                    "unavailable", "eof")


def classify_failure(error) -> tuple[str, str]:
    """(class, cause): class is retry, owner or final."""
    if isinstance(error, RunTimeout):
        return "final", "timeout"
    text = (str(error) or type(error).__name__).lower()
    if any(w in text for w in _RATE_WORDS):
        return "retry", "rate_limit"
    for cause, words in _OWNER_WORDS:
        if any(w in text for w in words):
            return "owner", cause
    if any(w in text for w in _TRANSIENT_WORDS):
        return "retry", "transient"
    return "final", "failed"


# -- status bookkeeping --------------------------------------------------------------------------

def _status(task: dict) -> dict:
    routine = bot_routines._materialize(task)
    return routine.setdefault("status", {})


def _count_skip(task: dict, kind: str) -> None:
    skipped = _status(task).setdefault("skipped", {})
    skipped[kind] = int(skipped.get(kind) or 0) + 1


def _note_outcome(task: dict, ok: bool, now: float) -> None:
    status = _status(task)
    week = datetime.fromtimestamp(now).strftime("%G-W%V")
    weekly = status.get("weekly") or {}
    if weekly.get("week") != week:
        weekly = {"week": week, "runs": 0, "failed": 0}
    weekly["runs"] += 1
    weekly["failed"] += 0 if ok else 1
    status["weekly"] = weekly
    status["failure_streak"] = 0 if ok else int(status.get("failure_streak") or 0) + 1
    if ok:
        status.pop("owner_notified", None)


# -- dispatch --------------------------------------------------------------------------------------

def _bot_busy(agent_id: str) -> bool:
    try:
        from services import chat_live
        return chat_live.agent_activity(agent_id) is not None
    except Exception:
        return False


def _model_runs_today(task_id: str, now: float) -> int:
    midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    return sum(1 for r in task_service.list_runs(task_id)
               if r.get("model_ran") and (r.get("admitted_at") or r.get("started_at") or r.get("ran_at") or 0) >= midnight)


def _spawn(task: dict, source: str) -> None:
    """Hand a start to a bounded background worker."""
    from core import task_scheduler
    key = f"{task['id']}:{source}"
    if key in _inflight:
        return
    _inflight.add(key)

    async def go():
        try:
            await task_scheduler.start_run(task, source, wait=source != "schedule")
        except AdmissionDenied as exc:
            _count_skip(task, "admission")
            task_service._save_tasks()
            logger.info("routine %s not run: %s", task["id"], exc)
        except Exception:
            logger.exception("routine %s could not start", task["id"])
        finally:
            _inflight.discard(key)

    asyncio.get_running_loop().create_task(go())


def _dispatch_scheduled(task: dict, now: float) -> None:
    from core import task_scheduler
    status = _status(task)
    config = bot_routines.config_of(task)
    tid, agent_id = task["id"], task["agent_id"]
    running = task_scheduler.run_in_progress(tid)
    if f"{tid}:schedule" in _inflight and not running:
        return  # its worker is still starting
    # 1. overlap
    if running:
        if is_waiting(tid):
            cancel(tid, reason="superseded")
            return
        if config["overlap"] == "queue":
            if not status.get("queued"):
                status["queued"] = True
                task_service._save_tasks()
            return
        task_service._advance(task)
        _count_skip(task, "overlap")
        task_service._save_tasks()
        return
    status.pop("queued", None)
    # 4. usage limit
    wake = status.get("wake_at")
    if wake and now < wake:
        return
    if wake:
        status.pop("wake_at", None)
    endpoint = task_scheduler.task_endpoint_id(task)
    if endpoint:
        from services import bot_limit_resets
        until = bot_limit_resets.blocked_until(endpoint, now)
        if until is not None and until - now <= USAGE_PARK_WINDOW_SECONDS:
            status["wake_at"] = until + bot_schedules.LIMIT_RESET_DELAY_SECONDS
            task_service._save_tasks()
            return
    # 2. admission
    allowed, reason = agent_service.can_run(agent_id)
    if not allowed:
        task_service.skip_occurrence(tid, reason)
        _count_skip(task, "admission")
        task_service._save_tasks()
        return
    # 3. a busy bot: rechecked every 30 seconds, not on every tick
    if status.get("deferred_since") and now < status.get("recheck_at", 0):
        return
    if _bot_busy(agent_id):
        status["recheck_at"] = now + BUSY_RECHECK_SECONDS
        since = status.setdefault("deferred_since", now)
        if now - since >= BUSY_GIVE_UP_SECONDS:
            for key in ("deferred_since", "deferred_notified", "recheck_at"):
                status.pop(key, None)
            task_service.skip_occurrence(tid, "the bot stayed busy for an hour")
            _count_skip(task, "busy")
        elif now - since >= BUSY_NOTICE_SECONDS and not status.get("deferred_notified"):
            status["deferred_notified"] = True
            events.emit("routine.deferred", f"{task['name']} is waiting for the bot to finish what it is doing.",
                        level="warning", task_id=tid)
        task_service._save_tasks()
        return
    for key in ("deferred_since", "deferred_notified", "recheck_at"):
        status.pop(key, None)
    # 5. checks wait out the boot hold; the daily model-run cap
    if config["checks"]:
        if checks_module.boot_hold_left(now) > 0:
            status["held_until"] = now + checks_module.boot_hold_left(now)
            return
        status.pop("held_until", None)
        if _model_runs_today(tid, now) >= checks_module.MAX_MODEL_RUNS_PER_DAY:
            task_service.skip_occurrence(tid, f"it reached {checks_module.MAX_MODEL_RUNS_PER_DAY} runs for today")
            _count_skip(task, "run_limit")
            task_service._save_tasks()
            return
    _spawn(task, "schedule")


def _dispatch_retry(task: dict, now: float) -> None:
    status = _status(task)
    retry = status.get("retry")
    if not retry or now < retry["at"] or f"{task['id']}:retry" in _inflight:
        return
    from core import task_scheduler
    if task_scheduler.run_in_progress(task["id"]):
        return
    if _bot_busy(task["agent_id"]):
        if now - retry.get("first_at", retry["at"]) >= BUSY_GIVE_UP_SECONDS:
            status.pop("retry", None)
            task_service._save_tasks()
        return
    _spawn(task, "retry")


def _dispatch_events(task: dict, now: float) -> None:
    from core import task_scheduler
    status = _status(task)
    pending = [p for p in status.get("pending") or [] if not p.get("started")]
    if not pending or task_scheduler.run_in_progress(task["id"]) or f"{task['id']}:event" in _inflight:
        return
    if _bot_busy(task["agent_id"]):
        return
    pending[0]["started"] = True
    status["current_batch"] = pending[0]
    task_service._save_tasks()
    _spawn(task, "event")


def _refresh_reset_times(task: dict) -> None:
    """A limit-reset routine's next time follows the account's reset time."""
    schedule = bot_routines.config_of(task)["schedule"]
    if not schedule or schedule["kind"] != "limit_reset" or not task.get("enabled"):
        return
    wanted = task_service.routine_next(task, after=_now())
    # A time that has already passed is a due run: only a future or empty time moves.
    if wanted != task.get("next_run_at") and (task.get("next_run_at") is None or _future(task.get("next_run_at"))):
        task["next_run_at"] = wanted
        task_service._save_tasks()


def _future(stamp) -> bool:
    try:
        return datetime.fromisoformat(stamp).timestamp() > _now()
    except (TypeError, ValueError):
        return False


async def tick(now: Optional[float] = None) -> None:
    """One pass of the Bots lane. Never waits on a run."""
    global _started_up
    now = _now() if now is None else now
    if not _started_up:
        _started_up = True
        _startup_runs()
    for task in list(task_service.list_tasks()):
        routine = task.get("routine")
        if not routine or not task.get("agent_id") or task.get("schedule_kind") == "card":
            continue
        try:
            if routine.get("kind") == "event":
                _dispatch_events(task, now)
                continue
            _refresh_reset_times(task)
            _dispatch_retry(task, now)
            if task_service.is_due(task["id"]):
                _dispatch_scheduled(task, now)
        except Exception:
            logger.exception("routine %s: the lane could not handle it", task.get("id"))


def _startup_runs() -> None:
    for task in list(task_service.list_tasks()):
        if not bot_routines.is_routine(task) or not task.get("enabled") or not task.get("routine"):
            continue
        config = bot_routines.config_of(task)
        status = _status(task)
        if config["run_on_startup"] and status.get("last_startup_launch") != LAUNCH_ID:
            status["last_startup_launch"] = LAUNCH_ID
            task_service._save_tasks()
            try:
                _spawn(task, "startup")
            except RuntimeError:
                pass


def recover(lost_tasks: list) -> int:
    """After a restart: a routine run that was cut off is requeued once.
    (A person's cancel is recorded as stopped, not lost, so it never lands
    here.) Returns how many were requeued."""
    count = 0
    now = _now()
    for task in lost_tasks:
        if not bot_routines.is_routine(task) or not task.get("routine"):
            continue
        last = next(iter(task_service.list_runs(task["id"])), None) or {}
        if (last.get("retry_count") or 0) >= 1 or last.get("trigger_type") == "event":
            continue
        _status(task)["retry"] = {"at": now, "first_at": now, "count": 1, "cause": "restart"}
        count += 1
    if count:
        task_service._save_tasks()
    return count


def start_up_state() -> None:
    """Fresh process: the boot hold and the startup-run launch stamp reset."""
    global _started_up
    _started_up = False
    checks_module.reset_boot()


# -- composing the run -------------------------------------------------------------------------------

def _previous_report(task_id: str) -> str:
    for run in task_service.list_runs(task_id):
        if run.get("outcome") == "succeeded" and run.get("model_ran") and run.get("output") \
                and run.get("report_state") != "quiet":
            return str(run["output"])[:CONTINUITY_CHARS]
    return ""


def compose_prompt(task: dict, config: dict, *, source: str, retry: Optional[dict] = None,
                   findings: Optional[dict] = None, batch: Optional[dict] = None) -> tuple[str, bool]:
    """(prompt, tainted). The owner's instructions stay a separate trusted
    block; everything from outside (a previous report, check findings,
    events) is fenced and marks the turn."""
    parts = [f'[Scheduled routine "{task["name"]}" - do this now:]']
    if retry:
        parts.append(f"[This is an automatic retry after a problem ({retry.get('cause') or 'unknown'}). "
                     "Do not repeat work that already finished.]")
    parts.append(config["prompt"])
    tainted = False
    if config["continuity"]:
        previous = _previous_report(task["id"])
        if previous:
            parts.append(wrap_untrusted("the previous report from this routine", previous))
            tainted = True
    if findings:
        parts.append(wrap_untrusted("what the checks found", "\n".join(f"{k}: {v}" for k, v in findings.items())))
        tainted = True
    if batch:
        text = json.dumps(batch["events"], ensure_ascii=False, default=str)[:48000]
        parts.append(wrap_untrusted("app event data", text))
        tainted = True
    if config["attachments"]:
        from core import attachments
        names = [(attachments.staged_file_info(a) or ("", a))[1] for a in config["attachments"]]
        parts.append("[Attached files: " + ", ".join(names) + "]")
    if config["access"] == "read-and-draft":
        parts.append("[Access: read and draft only. You may read and you may save drafts. You may not send, post, "
                     "change or delete anything outside drafts.]")
    parts.append(f"[If nothing is new, reply with exactly {QUIET_REPLY}. If you need the person to decide something, "
                 "make your last line start with Needs input:]")
    return "\n\n".join(parts), tainted


def _is_quiet(reply: str) -> bool:
    stripped = (reply or "").strip()
    if not stripped:
        return False
    last = [line for line in stripped.splitlines() if line.strip()][-1].strip().strip("*_`. ").upper()
    return last == QUIET_REPLY or is_silent(reply)


def _needs_input(reply: str) -> bool:
    lines = [line for line in (reply or "").strip().splitlines() if line.strip()]
    return bool(lines) and lines[-1].strip().lower().startswith("needs input:")


def _hidden_session(task: dict, config: dict, run_id: Optional[str]) -> Optional[str]:
    """The unattended conversation this run happens in: not the bot's main
    thread, marked as opened by a routine."""
    from core.session_manager import session_manager
    agent = agent_service.get(task["agent_id"])
    if agent is None:
        return None
    owner = task_scope.owner_for(task)
    session = session_manager.create_session(f'{task["name"]} · {datetime.fromtimestamp(_now()).strftime("%b %d")}',
                                             owner_user=owner)
    endpoint = agent_service.chat_endpoint(agent)
    if endpoint:
        session_manager.set_model_endpoint(session["id"], endpoint)
    agent_service.make_agent_chat(session["id"], agent, attended=False)
    session_manager.set_thread(session["id"], opened_by="routine", routine_run_id=run_id, title_source="machine")
    return session["id"]


def _drop_session(session_id: Optional[str]) -> None:
    if not session_id:
        return
    try:
        from core.session_manager import session_manager
        session_manager.delete_session(session_id)
    except Exception:
        logger.exception("could not remove a quiet routine's hidden conversation")


# -- results ---------------------------------------------------------------------------------------------

def _destination(config: dict) -> Optional[str]:
    return config.get("results_thread_id") or config.get("source_thread_id")


def _post(task: dict, config: dict, run_id: Optional[str], text: str, state: str, trigger: str) -> Optional[str]:
    """Post once to the destination with automation attribution. Returns the
    destination thread id, or None when the result went to the inbox."""
    attribution = {"routine_id": task["id"], "routine_name": task["name"], "run_id": run_id, "trigger": trigger,
                   "state": state}
    thread = _destination(config)
    if thread:
        from core.session_manager import session_manager
        if session_manager.get_session(thread) is not None:
            session_manager.append_message(thread, "assistant", text[:POST_BOUND], extra={"automation": attribution})
            return thread
    agent = agent_service.get(task["agent_id"])
    if agent is not None and state != "recovered":
        item = agent_service.add_item(agent["id"], "report", task["name"], text[:POST_BOUND])
        agent_service.notify(item)
    return None


async def _deliver_result(task: dict, config: dict, run_id: Optional[str], reply: str, state: str, trigger: str) -> dict:
    """Where the result goes: a registered sink (the brief), else the
    destination thread or the inbox. Returns fields for the run record."""
    status = _status(task)
    if status.get("last_posted_run") == run_id and run_id:
        return {}
    status["last_posted_run"] = run_id
    if config["deliver"] != "normal":
        payload = {"routine_id": task["id"], "routine_name": task["name"], "bot_id": task["agent_id"], "run_id": run_id,
                   "text": reply, "state": state, "trigger": trigger, "owner": task_scope.owner_for(task)}
        if await checks_module.deliver(config["deliver"], payload):
            return {"report_state": "sink", "destination": config["deliver"]}
    destination = _post(task, config, run_id, reply, state, trigger)
    return {"report_state": "posted", "destination": destination}


# -- the run itself ----------------------------------------------------------------------------------------

async def _guarded(work: asyncio.Future, task_id: str, timeout_minutes: Optional[int]):
    """Await the model work. The timeout counts active time only."""
    state = _active[task_id]
    try:
        while not work.done():
            await asyncio.wait({work}, timeout=WATCH_POLL_SECONDS)
            if timeout_minutes and not work.done() and active_seconds(state) >= timeout_minutes * 60:
                work.cancel()
                await asyncio.gather(work, return_exceptions=True)
                raise RunTimeout(f"The routine ran past its {timeout_minutes}-minute limit.")
        return work.result()
    except asyncio.CancelledError:
        work.cancel()
        await asyncio.gather(work, return_exceptions=True)
        raise


async def execute(task: dict, source: str) -> None:
    """Run one routine occurrence. Called by task_scheduler once the run is
    admitted, bound to its owner and holding the task's lock; the run record
    already exists."""
    from core import task_scheduler
    task = task_service.get_task(task["id"]) or task
    config = bot_routines.config_of(task)
    status = _status(task)
    tid = task["id"]
    batch = status.pop("current_batch", None) if source == "event" else None
    retry = status.pop("retry", None) if source == "retry" else None
    trigger = {"schedule": "schedule", "manual": "manual", "startup": "startup", "retry": "retry",
               "event": "event"}.get(source, source)
    live = task_service.get_task(tid) or task
    due = live.get("run_for")
    if trigger == "schedule" and due:
        try:
            if _now() - datetime.fromisoformat(due).timestamp() > LATE_SECONDS:
                trigger = "catch-up"
        except ValueError:
            pass
    run_id = live.get("active_run_id")
    fields = {"trigger_type": trigger, "routine_id": tid, "seen": False, "model_ran": False}
    if retry:
        fields.update(retry_cause=retry.get("cause"), retry_count=retry.get("count", 1))
    if batch:
        fields["event_ref"] = (batch.get("receipts") or [None])[0]
        if batch.get("results_thread_id"):
            config["results_thread_id"] = batch["results_thread_id"]
    task_service.update_active_run(tid, **fields)
    task_service._save_tasks()
    started = _now()
    context = {"routine_id": tid, "run_id": run_id, "bot_id": task["agent_id"], "owner": task_scope.owner_for(task),
               "access": config["access"], "unattended": True, "trigger": trigger, "active": True}
    token = _current.set(context)
    _active[tid] = {"started": started, "waited": 0.0, "waiting_since": None}
    session_id = None
    try:
        findings = None
        if config["checks"] and source in ("schedule", "retry", "startup"):
            round_ = await checks_module.run_checks(tid, task["agent_id"], context["owner"], config["checks"],
                                                    status.get("check_state") or {})
            status["check_state"] = round_.state
            status["check_trouble"] = round_.trouble
            task_service._save_tasks()
            if not round_.changed:
                note = ("Checks are backing off after a problem." if round_.errors or round_.skipped_backoff and
                        not round_.ran else None)
                task_service.update_active_run(tid, check_note=note, report_state="quiet", summary=QUIET_REPLY)
                _note_outcome(task, True, _now())
                task_service.record_run(tid, output=QUIET_REPLY)
                events.emit("task.run", f"{task['name']}: nothing new", task_id=tid)
                return
            findings = round_.summaries
        agent = agent_service.get(task["agent_id"])
        if agent is None:
            raise ValueError("its bot was deleted")
        session_id = _hidden_session(task, config, run_id)
        task_service.update_active_run(tid, execution_thread_id=session_id, model_ran=True)
        prompt, tainted = compose_prompt(task, config, source=source, retry=retry, findings=findings, batch=batch)
        brain = task_scheduler._task_brain(task)
        reply = ""
        try:
            await brain.connect()
            if tainted and hasattr(brain, "pending_reference_taint"):
                brain.pending_reference_taint = "routine outside content"
            if session_id:
                from core.session_manager import session_manager
                session_manager.append_message(session_id, "user", prompt)
            full = agent_service.run_prompt(agent, prompt, goal={**task, "report_when": config["report_when"]})
            from core import file_checkpoints
            async with file_checkpoints.around_turn(f"task:{tid}"):
                work = asyncio.ensure_future(task_scheduler.complete(brain, full, task, "goal"))
                reply = await _guarded(work, tid, config["timeout_minutes"])
        finally:
            await brain.disconnect()
        await _finish_ok(task, config, run_id, reply, session_id, trigger, source)
        session_id = None
    except Exception as error:
        await _finish_failed(task, config, run_id, error, source, retry)
    finally:
        _active.pop(tid, None)
        _current.reset(token)
        context["active"] = False
        _notify_end(tid, run_id, "finished")
        if batch is not None:
            for receipt in batch.get("receipts") or []:
                try:
                    from core import bot_app_events
                    bot_app_events.settle(receipt)
                except Exception:
                    pass  # absent until unit U4 lands; its sweep also settles
            status2 = _status(task_service.get_task(tid) or task)
            status2["pending"] = [p for p in status2.get("pending") or [] if p is not batch and p.get("receipts") != batch.get("receipts")]
            task_service._save_tasks()


async def _finish_ok(task: dict, config: dict, run_id: Optional[str], reply: str, session_id: Optional[str],
                     trigger: str, source: str) -> None:
    tid = task["id"]
    status = _status(task)
    recovered = int(status.get("failure_streak") or 0) > 0
    quiet = _is_quiet(reply)
    needs_input = _needs_input(reply)
    if session_id:
        from core.session_manager import session_manager
        session_manager.append_message(session_id, "assistant", reply)
    fields: dict = {"summary": " ".join((reply or "").split())[:280] or None}
    if quiet:
        fields["report_state"] = "quiet"
        if session_id and not recovered:
            _drop_session(session_id)
            fields["execution_thread_id"] = None
    elif needs_input:
        fields["attention"] = "needs_you"
        fields.update(await _deliver_result(task, config, run_id, reply, "needs_you", trigger))
        events.emit("routine.needs_input", f"{task['name']} needs your input.", level="warning", task_id=tid)
    else:
        fields.update(await _deliver_result(task, config, run_id, reply, "report", trigger))
    if recovered and quiet:
        when = datetime.fromtimestamp(_now()).strftime("%H:%M")
        _post(task, config, run_id, f"Recovered: {task['name']} finished OK at {when}.", "recovered", trigger)
    task_service.update_active_run(tid, **fields)
    _note_outcome(task, True, _now())
    from core import task_scheduler
    delivery_id = task_scheduler._deliver(task, reply) if not quiet else None
    task_service.record_run(tid, output=reply, delivery_id=delivery_id)
    events.emit("task.run", f'Ran "{task["name"]}"', task_id=tid)


async def _finish_failed(task: dict, config: dict, run_id: Optional[str], error: Exception, source: str,
                         retry: Optional[dict]) -> None:
    tid = task["id"]
    status = _status(task)
    klass, cause = classify_failure(error)
    message = (str(error) or type(error).__name__)[:bot_routines.ERROR_BOUND]
    now = _now()
    fields: dict = {"retry_cause": cause}
    if klass == "owner":
        reset = None
        if cause == "usage_limit":
            from core import task_scheduler
            from services import bot_limit_resets
            endpoint = task_scheduler.task_endpoint_id(task)
            reset = bot_limit_resets.blocked_until(endpoint, now) if endpoint else None
        if reset is not None and reset - now <= USAGE_PARK_WINDOW_SECONDS:
            status["retry"] = {"at": reset + bot_schedules.LIMIT_RESET_DELAY_SECONDS, "first_at": now, "count": 0,
                               "cause": "usage_limit"}
            message = "Paused until your usage limit resets, then it runs again."
        else:
            fields["attention"] = "needs_you"
            notified = status.setdefault("owner_notified", {})
            if not notified.get(cause):
                notified[cause] = now
                events.emit("routine.needs_you", f"{task['name']} could not run: {message}", level="warning", task_id=tid)
    elif klass == "retry" and not (retry and retry.get("count", 0) >= 1) and source != "retry":
        delay = RATE_LIMIT_DELAY_SECONDS if cause == "rate_limit" else RETRY_DELAY_SECONDS
        status["retry"] = {"at": now + delay, "first_at": now, "count": 1, "cause": cause}
    else:
        fields["attention"] = "failed"
    task_service.update_active_run(tid, **fields)
    _note_outcome(task, False, now)
    final = fields.get("attention") is not None
    if final:
        await _deliver_result(task, config, run_id, f'{task["name"]} could not finish: {message}', "failed",
                              "retry" if source == "retry" else source)
    task_service.record_run(tid, output="", error=message)
    events.emit("task.failed", f'{task["name"]} failed: {message}', level="error", task_id=tid)
    logger.warning("routine '%s' (%s) failed (%s): %s", task["name"], tid, cause, message)
