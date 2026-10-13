"""Tasks: scheduled/automated jobs — distinct from Notes' todos (see Kairos
Plan's Phase 3 scoping: "not to be confused with Notes' todos"). Formalizes
what bridge_sync.py's poll cycle + proactive nudges already do today into a
real scheduler.

Three schedule kinds:
- "once": fires a single time at run_at (ISO datetime string), then disables itself.
- "interval": fires every interval_seconds, anchored to its scheduled time.
- "daily": fires at run_time ("HH:MM"), in time_zone or the machine's zone,
  on weekdays (Monday = 0 through Sunday = 6), or every day when omitted.

"daily" exists because "interval" cannot express it (David's ask 2026-09-04,
"once everyday at 6:00 am"). A 24h interval measures elapsed time; daily
keeps a wall-clock time even when daylight saving changes its UTC offset.

Chained tasks, webhook triggers, and per-task personas (all real Odysseus
features) are deliberately out of this pass — this is the execution-loop
foundation those build on top of.

Cards (the work board, Hermes track 2026-09-23, after Hermes's kanban): a
fourth kind, "card", with no schedule. A card is a one-off piece of work that
moves Backlog -> Ready -> Running -> Review -> Done (or Blocked). The task
loop's dispatcher (core/task_scheduler.py) claims one Ready card at a time on
a lease, runs it, and puts the result in Review for a person to approve or
send back with a note. A card can wait on other cards (depends_on): it is not
claimed until they are all Done, and their results are handed to it - which
is how chained work happens. Any task or card can name the model it runs on
(endpoint_id); without one it runs on Claude, as tasks always have.

Agents (services/agent_service.py, 2026-10-04): a task or card with
`agent_id` is that agent's work - a card is a job it was given, a scheduled
task is one of its standing goals. It runs on the agent's model with the
agent's identity and memory; this module only stores and schedules it.

Durable work (roadmap phase 4, 2026-10-06; spec: the vault note "Durable
Work - Phase 4 (Build Spec)"):
- A scheduled run claims its occurrence before it starts: the next time is
  moved on and the start is stamped in the same write. A run cut off by a
  crash is recorded as lost at the next start and never run again by itself;
  before this the same occurrence ran again on every start.
- Only the schedule moves the schedule. A Run now, a trigger's run or an
  answered question leaves the next time alone.
- A scheduled run that starts more than LATE_SECONDS after its time says so
  (Kairos was off, or busy).
- A run can be stopped; it is recorded as stopped, and a stopped card goes
  to Blocked rather than being retried.
- A run's channel message is a row in the outbox (core/outbox.py); the run
  record keeps its id, and the history reads its state from there.
"""
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
import os

TASKS_FILE = os.path.join(DATA_DIR, "tasks.json")


def _hook(event: str, data: dict) -> None:
    """The person's lifecycle hooks (services/hook_service.py); notify-only."""
    from services.hook_service import hook_service
    hook_service.emit(event, data)
TASK_RUNS_FILE = os.path.join(DATA_DIR, "task_runs.json")

# Kept per task, so a task that runs every few minutes cannot push another
# task's or card's history out (one shared cap of 200 did, 2026-10-02).
MAX_RUNS_PER_TASK = 50

CARD_STATUSES = ("backlog", "ready", "running", "review", "done", "blocked")
# One run plus two retries, then Blocked.
CARD_MAX_ATTEMPTS = 3
# How long a claim holds. A run still going past it is taken as dead (the app
# closed mid-run, say) and the card goes back to Ready, or Blocked when out of
# attempts, so it can never sit in Running forever.
CARD_LEASE_SECONDS = 30 * 60
# A scheduled run starting this long after its time is marked late.
LATE_SECONDS = 5 * 60
# Twelve hours tolerates overnight downtime and the existing late catch-up
# behaviour, but yesterday's checks should be receipts, not stale model work
# (Agents 2.0 phase 2-i, 2026-10-13).
MISSED_GRACE_SECONDS = 12 * 60 * 60
STOPPED_NOTE = "Stopped by you."
CARD_RESULT_INSTRUCTION = (
    "[This is a card on Kairos's work board. Your reply is the result the user will review, so reply with the "
    "finished work itself, not a note about where you put it. Use tools only when the work itself needs them.]"
)


class TaskService:
    def __init__(self) -> None:
        self._tasks: dict = read_json(TASKS_FILE, {})
        self._runs: list = read_json(TASK_RUNS_FILE, [])

    def _save_tasks(self) -> None:
        write_json_atomic(TASKS_FILE, self._tasks)

    def _save_runs(self) -> None:
        counts: dict = {}
        kept = []
        for run in reversed(self._runs):
            seen = counts.get(run["task_id"], 0)
            if seen < MAX_RUNS_PER_TASK:
                kept.append(run)
                counts[run["task_id"]] = seen + 1
        self._runs = kept[::-1]
        write_json_atomic(TASK_RUNS_FILE, self._runs)

    def list_tasks(self) -> list[dict]:
        return sorted(self._tasks.values(), key=lambda t: t["created_at"], reverse=True)

    def get_task(self, task_id: str) -> Optional[dict]:
        return self._tasks.get(task_id)

    @staticmethod
    def visible_to(task: dict, user: Optional[str], is_admin: bool = False) -> bool:
        # Existing tasks are shared. Honor ownership on scoped/imported tasks.
        owner = task.get("owner") or task.get("user_id") or task.get("created_by")
        return bool(is_admin or (not task.get("admin_only") and (not owner or owner == user)))

    def create_task(
        self,
        name: str,
        prompt: str,
        schedule_kind: str,
        run_at: Optional[str] = None,
        interval_seconds: Optional[int] = None,
        builtin_action: Optional[str] = None,
        deliver_to_channel: Optional[str] = None,
        run_time: Optional[str] = None,
        depends_on: Optional[list[str]] = None,
        status: Optional[str] = None,
        endpoint_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        report_when: Optional[str] = None,
        trigger: Optional[dict] = None,
        reply_to: Optional[str] = None,
        context: str = "",
        enabled: bool = True,
        time_zone: Optional[str] = None,
        weekdays: Optional[list[int]] = None,
    ) -> dict:
        if schedule_kind not in ("once", "interval", "daily", "card"):
            raise ValueError("schedule_kind must be 'once', 'interval', 'daily' or 'card'")
        if schedule_kind != "card" and (depends_on or status):
            raise ValueError("depends_on and status are for cards (schedule_kind 'card')")
        if schedule_kind == "card":
            if status not in (None, "backlog", "ready"):
                raise ValueError("a new card starts in 'backlog' or 'ready'")
            self._check_dependencies(None, depends_on or [])
        if schedule_kind == "once" and not run_at:
            raise ValueError("run_at is required for a one-shot task")
        if schedule_kind == "interval" and (not isinstance(interval_seconds, int) or interval_seconds <= 0):
            raise ValueError("interval_seconds must be a positive integer for a recurring task")
        _schedule_zone(time_zone)
        weekdays = _schedule_weekdays(weekdays)
        if weekdays is not None and schedule_kind != "daily":
            raise ValueError("weekdays is for daily schedules")
        if time_zone is not None and schedule_kind == "card":
            raise ValueError("time_zone is for scheduled tasks")
        if schedule_kind == "daily":
            if not run_time:
                raise ValueError("run_time (HH:MM) is required for a daily task")
            _parse_hhmm(run_time)  # raises ValueError on anything malformed
        if agent_id:
            from services.agent_service import agent_service
            if agent_service.get(agent_id) is None:
                raise ValueError(f"agent_id must name an existing agent; {agent_id!r} is not one")
        if report_when not in (None, "always", "notable"):
            raise ValueError("report_when is 'always' or 'notable'")

        task_id = uuid.uuid4().hex[:12]
        now = time.time()
        if schedule_kind == "card":
            next_run_at = None  # cards are dispatched, not scheduled
        elif schedule_kind == "once":
            next_run_at = run_at
        elif schedule_kind == "daily":
            next_run_at = _next_daily(run_time, time_zone, weekdays)
        else:
            next_run_at = _iso_in(interval_seconds)
        task = {
            "id": task_id,
            "name": name,
            "prompt": prompt,
            "schedule_kind": schedule_kind,
            "run_at": run_at,
            "interval_seconds": interval_seconds,
            # "HH:MM" in time_zone (or machine-local), for daily schedules.
            "run_time": run_time,
            "enabled": enabled,
            "next_run_at": next_run_at,
            "last_run_at": None,
            "created_at": now,
            # Set when this task is a premade "built-in" (David's ask
            # 2026-08-31, see core/builtin_tasks.py) — the scheduler runs
            # the registered action/prompt-builder instead of the static
            # `prompt` field above, which is just a human-readable label here.
            "builtin_action": builtin_action,
            # Settings > Channels delivery target (David's ask 2026-08-31) —
            # None means "Tasks tab only," matching existing behavior exactly.
            "deliver_to_channel": deliver_to_channel,
            # The model endpoint this runs on (core/model_endpoints.py); None
            # keeps the original behaviour, Claude through the CLI.
            "endpoint_id": endpoint_id,
            # The agent this is work for (services/agent_service.py); None for
            # ordinary tasks. A goal reports only when notable unless 'always'.
            "agent_id": agent_id,
            "report_when": report_when or ("notable" if agent_id and schedule_kind != "card" else None),
            # The webhook trigger that made this card ({id, name};
            # services/trigger_service.py), so the board can say where it came from.
            "trigger": trigger,
            "reply_to": reply_to,
            "context": context,
        }
        # Omitted fields stay omitted: old files need no migration or write
        # on load, and a machine-local schedule still follows the machine
        # (Agents 2.0 phase 2-i, 2026-10-13).
        if time_zone is not None:
            task["time_zone"] = time_zone
        if weekdays is not None:
            task["weekdays"] = weekdays
        if schedule_kind == "card":
            task.update({"status": status or "backlog", "depends_on": list(depends_on or []), "attempts": 0,
                         "claimed_until": None, "comments": []})
        self._tasks[task_id] = task
        self._save_tasks()
        return task

    def update_task(self, task_id: str, **fields) -> dict:
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(f"no such task: {task_id}")
        if "depends_on" in fields:
            if task["schedule_kind"] != "card":
                raise ValueError("depends_on is for cards")
            self._check_dependencies(task_id, fields["depends_on"] or [])
        if fields.get("report_when") not in (None, "always", "notable"):
            raise ValueError("report_when is 'always' or 'notable'")
        schedule_changed = "time_zone" in fields or "weekdays" in fields
        candidate = {**task, **fields}
        if schedule_changed:
            _schedule_zone(candidate.get("time_zone"))
            candidate["weekdays"] = _schedule_weekdays(candidate.get("weekdays"))
            if task["schedule_kind"] == "card" or (candidate["weekdays"] is not None and task["schedule_kind"] != "daily"):
                raise ValueError("timezone and weekday changes require a schedule; weekdays requires daily")
        if fields.get("enabled") is True and not task.get("enabled"):
            kind = task["schedule_kind"]
            if kind == "once":
                stamp = task.get("next_run_at")
                if not stamp or datetime.fromisoformat(stamp).timestamp() <= time.time():
                    raise ValueError("This one-time schedule has ended. Use Run now or schedule a new task.")
            elif kind == "daily":
                task["next_run_at"] = _next_daily(task["run_time"], candidate.get("time_zone"), candidate.get("weekdays"))
            elif kind == "interval":
                task["next_run_at"] = _iso_in(task["interval_seconds"])
        for key in ("name", "prompt", "enabled", "deliver_to_channel", "endpoint_id", "depends_on", "report_when"):
            if key in fields:
                task[key] = list(fields[key] or []) if key == "depends_on" else fields[key]
        if schedule_changed:
            for key in ("time_zone", "weekdays"):
                if key in fields:
                    if candidate.get(key) is None:
                        task.pop(key, None)
                    else:
                        task[key] = candidate[key]
            if task["schedule_kind"] == "daily":
                task["next_run_at"] = _next_daily(task["run_time"], task.get("time_zone"), task.get("weekdays"))
        self._save_tasks()
        return task

    # -- cards ----------------------------------------------------------------

    def _check_dependencies(self, card_id: Optional[str], depends_on: list[str]) -> None:
        for dep in depends_on:
            other = self._tasks.get(dep)
            if other is None or other["schedule_kind"] != "card":
                raise ValueError(f"depends_on must name existing cards; {dep!r} is not one")
            if dep == card_id:
                raise ValueError("a card cannot depend on itself")
        if card_id is None:
            return
        # Would this make a loop? Walk what the new dependencies wait on.
        seen, stack = set(), list(depends_on)
        while stack:
            current = stack.pop()
            if current == card_id:
                raise ValueError("that would make cards wait on each other in a loop")
            if current not in seen:
                seen.add(current)
                stack.extend(self._tasks.get(current, {}).get("depends_on") or [])

    def _comment(self, card: dict, kind: str, text: str, by: str) -> None:
        card["comments"].append({"at": time.time(), "kind": kind, "text": text, "by": by})

    def waiting_on(self, card: dict) -> list[str]:
        """Dependencies not yet Done."""
        return [d for d in card.get("depends_on") or [] if (self._tasks.get(d) or {}).get("status") != "done"]

    def set_card_status(self, card_id: str, status: str, note: Optional[str] = None, by: str = "user") -> dict:
        """A person (or an agent) moving a card. Running is the dispatcher's
        alone, so a running card cannot be moved and nothing can be moved to
        it. Review -> Ready with a note is "request changes": the note goes
        to the next run. Blocked -> Ready is a retry and restores the attempts."""
        card = self._tasks.get(card_id)
        if card is None or card["schedule_kind"] != "card":
            raise KeyError(f"no such card: {card_id}")
        if status not in CARD_STATUSES or status == "running":
            raise ValueError(f"a card can be moved to backlog, ready, review, done or blocked, not {status!r}")
        if card["status"] == "running":
            raise ValueError("this card is running; wait for it to finish")
        if note:
            kind = "feedback" if card["status"] == "review" and status == "ready" else "note"
            self._comment(card, kind, note, by)
            if kind == "feedback" and card.get("agent_id"):
                # A correction is something the agent should carry from now on,
                # not only on this card's re-run.
                from services.agent_service import agent_service
                if agent_service.get(card["agent_id"]):
                    try:
                        agent_service.remember(card["agent_id"], "Corrections", f"On \"{card['name']}\": {note}")
                    except ValueError as exc:
                        # Feedback still reaches this run, but the person must
                        # see why it will not carry forward (2026-10-13).
                        self._comment(card, "note", f"Correction could not be saved to agent memory: {exc}. "
                                      "Your feedback is kept on this card for its next run.", "jarvis")
        if status == "ready" and card["status"] == "blocked":
            card["attempts"] = 0
        card["status"] = status
        self._save_tasks()
        self._sync_handoff(card)
        return card

    def claim_next_card(self, now: Optional[float] = None, card_id: Optional[str] = None,
                        eligible=None) -> Optional[dict]:
        """The oldest Ready card whose dependencies are all Done, marked
        Running with a lease. One at a time keeps spend predictable.
        card_id claims that card only ("Run now"), from Backlog too.
        eligible(card) can hold a card back (an agent turned off or out of
        runs for today) without moving it."""
        now = time.time() if now is None else now
        card = self.next_card(card_id=card_id, eligible=eligible)
        if card is None:
            return None
        card["status"] = "running"
        card["attempts"] += 1
        card["claimed_until"] = now + CARD_LEASE_SECONDS
        card["run_started_at"] = now
        self._save_tasks()
        self._sync_handoff(card)
        return card

    def next_card(self, card_id: Optional[str] = None, eligible=None) -> Optional[dict]:
        """Find work without claiming it: admission must hold a slot before
        a card spends an attempt (Agents 2.0, 2026-10-13)."""
        allowed = ("ready", "backlog") if card_id else ("ready",)
        ready = [c for c in self._tasks.values()
                 if c["schedule_kind"] == "card" and c["status"] in allowed and not self.waiting_on(c)
                 and (card_id is None or c["id"] == card_id) and (eligible is None or eligible(c))]
        if not ready:
            return None
        return min(ready, key=lambda c: c["created_at"])

    def finish_card(self, card_id: str, output: str) -> dict:
        card = self._tasks[card_id]
        self._comment(card, "result", output, "jarvis")
        card["status"] = "review"
        card["claimed_until"] = None
        self._append_run(card, output, None, "succeeded")
        self._save_tasks()
        self._sync_handoff(card)
        _hook("card.review", {"source": "agent" if card.get("agent_id") else "task", "card": card["name"],
                              "card_id": card_id, "agent_id": card.get("agent_id"), "output": output,
                              "trigger": (card.get("trigger") or {}).get("name")})
        return card

    def fail_card(self, card_id: str, error: str, lost: bool = False) -> dict:
        card = self._tasks[card_id]
        self._comment(card, "error", error, "jarvis")
        card["status"] = "blocked" if card["attempts"] >= CARD_MAX_ATTEMPTS else "ready"
        card["claimed_until"] = None
        self._append_run(card, "", error, "lost" if lost else "failed")
        self._save_tasks()
        self._sync_handoff(card)
        return card

    @staticmethod
    def _sync_handoff(card: dict) -> None:
        if card.get("reply_to"):
            from services.agent_handoff import sync_card
            sync_card(card)

    def reclaim_stale_cards(self, now: Optional[float] = None, running=()) -> list[dict]:
        """Running cards whose lease ran out: the run is taken as lost.
        `running` names the cards this process is still running, which are
        never lost however long they take: the task loop now keeps polling
        while a card runs (2026-10-06), and would otherwise start a long
        card a second time beside itself."""
        now = time.time() if now is None else now
        stale = [c for c in self._tasks.values() if c["schedule_kind"] == "card" and c["status"] == "running"
                 and (c.get("claimed_until") or 0) < now and c["id"] not in running]
        return [self.fail_card(c["id"], "The run did not finish (Kairos may have closed while it ran).", lost=True)
                for c in stale]

    def card_prompt(self, card: dict) -> str:
        """What the model is asked: the card itself, the results of the
        cards it waited on, and, on a re-run, its last result with the
        feedback on it."""
        parts = [card["prompt"]]
        if card.get("context"):
            parts.append(card["context"])
        for dep in card.get("depends_on") or []:
            result = self._latest(self._tasks.get(dep) or {}, "result")
            if result:
                parts.append(f"[Result of the card this one depends on, \"{self._tasks[dep]['name']}\":]\n{result['text']}")
        feedback = self._latest(card, "feedback")
        previous = self._latest(card, "result")
        if feedback and previous and previous["at"] < feedback["at"]:
            parts.append(f"[Your previous result:]\n{previous['text']}\n\n[Feedback on it, to address now:]\n{feedback['text']}")
        # Without this, a model with tools filed the work elsewhere (a note)
        # and returned "the note has been created" as the card's result
        # (seen live on qwen2.5-coder, 2026-09-23).
        parts.append(CARD_RESULT_INSTRUCTION)
        return "\n\n".join(parts)

    @staticmethod
    def _latest(card: dict, kind: str) -> Optional[dict]:
        return next((c for c in reversed(card.get("comments") or []) if c["kind"] == kind), None)

    def _append_run(self, task: dict, output: str, error: Optional[str], outcome: str,
                    delivered: Optional[bool] = None, delivery_id: Optional[str] = None,
                    missed_reason: Optional[str] = None, save: bool = True) -> None:
        """One run record. outcome is "succeeded", "failed", "lost" (a run
        that never reported back, including a missed scheduled check) or
        "stopped". The start time is the one a claim or
        mark_started() left on the task; the caller saves the task."""
        now = time.time()
        started = task.pop("run_started_at", None)
        due_at = task.pop("run_for", None)
        source = task.pop("run_source", None)
        run_id = task.pop("run_id", None)
        late = None
        if due_at and (started is not None or missed_reason):
            try:
                behind = (started if started is not None else now) - datetime.fromisoformat(due_at).timestamp()
                late = round(behind) if behind > LATE_SECONDS else None
            except ValueError:
                pass  # an unreadable stored time: lateness unknown, not guessed
        self._runs.append({
            "id": uuid.uuid4().hex[:12],
            "task_id": task["id"],
            "task_name": task["name"],
            "started_at": started,
            "ran_at": now,  # when it finished; the name predates started_at
            "duration_seconds": round(now - started, 1) if started else None,
            "outcome": outcome,
            "output": output,
            "error": error,
            # None = no delivery channel configured for this task; True/False =
            # a channel was configured and the send did/didn't succeed (David's
            # ask 2026-09-02 — a failed Discord delivery was previously silent
            # everywhere but the server log).
            "delivered": delivered,
            # The run's message in the outbox (core/outbox.py); list_runs
            # reads its state from there. Records from before 2026-10-06
            # have only `delivered`.
            "delivery_id": delivery_id,
            # The model run that did it (core/runs.py), for its timeline.
            "run_id": run_id,
            # What started it (schedule, manual, trigger, answer), the time
            # it was scheduled for, and how many seconds late it began when
            # that was more than LATE_SECONDS.
            "source": source,
            "scheduled_for": due_at,
            "late_seconds": late,
            # The model as named when it ran, so the history still reads
            # right after the task moves to another model or it is removed.
            "endpoint_id": task.get("endpoint_id"),
            "model": _model_label(task.get("endpoint_id")),
            "attempt": task.get("attempts") if task["schedule_kind"] == "card" else None,
        })
        if missed_reason:
            self._runs[-1]["missed_reason"] = missed_reason
        task["last_run_at"] = now
        if save:
            self._save_runs()

    def claim_occurrence(self, task_id: str) -> Optional[dict]:
        """A scheduled run begins: its next time moves on and the start is
        stamped, in one write, before any work happens. A crash from here on
        loses this occurrence rather than running it twice. None when the
        task is gone, no longer due, or recorded as missed beyond grace."""
        task = self._tasks.get(task_id)
        if task is None or not self.is_due(task_id):
            return None
        if self.skip_overdue_occurrence(task_id):
            return None
        task.update(run_started_at=time.time(), run_for=task["next_run_at"], run_source="schedule")
        skipped = self._advance(task)
        self._save_tasks()
        self._record_missed(task, skipped, "the app was not running or the scheduler was busy")
        return task

    def note_run(self, task_id: Optional[str], run_id: str) -> None:
        """The model run doing this task's current run (core/runs.py), kept
        on its run record so the history can open the run's timeline. Not
        saved by itself: the record that carries it saves the task."""
        task = self._tasks.get(task_id) if task_id else None
        if task is not None:
            task["run_id"] = run_id

    def mark_started(self, task_id: str, source: str = "manual") -> None:
        """A run outside the schedule begins (Run now, a trigger, an answer).
        Persisted, so a run cut off by the app closing is still found and
        recorded on the next start; the schedule is left alone."""
        task = self._tasks.get(task_id)
        if task is not None:
            task.update(run_started_at=time.time(), run_for=None, run_source=source)
            self._save_tasks()

    def is_due(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        return bool(task and task["schedule_kind"] != "card" and task["enabled"] and task["next_run_at"]
                    and datetime.fromisoformat(task["next_run_at"]).timestamp() <= time.time())

    def recover_interrupted_runs(self) -> list[dict]:
        """At startup nothing is running yet, so a scheduled task still marked
        as started was cut off: record it as lost, once. It is not run again:
        its occurrence was claimed before it started. A stamp left by a build
        from before claims (no run_source) moves its schedule on here
        instead, or the same occurrence would run again. Cards are left to
        their lease (reclaim_stale_cards), which already covers this."""
        lost = [t for t in self._tasks.values() if t["schedule_kind"] != "card" and t.get("run_started_at")]
        for task in lost:
            if "run_source" not in task and self.is_due(task["id"]):
                skipped = self._advance(task)
                self._record_missed(task, skipped, "the app was not running or the scheduler was busy")
            self._append_run(task, "", "The run did not finish (Kairos closed while it ran).", "lost")
        if lost:
            self._save_tasks()
        return lost

    def record_stopped(self, task_id: str) -> Optional[dict]:
        """A run a person stopped. A card goes to Blocked, not back to Ready:
        stopping it means "not this", so it is never retried by itself."""
        task = self._tasks.get(task_id)
        if task is None:
            return None
        if task["schedule_kind"] == "card":
            if task.get("status") != "running":
                return task
            self._comment(task, "error", STOPPED_NOTE, "user")
            task["status"] = "blocked"
            task["claimed_until"] = None
        elif not task.get("run_started_at"):
            return task
        self._append_run(task, "", STOPPED_NOTE, "stopped")
        self._save_tasks()
        if task["schedule_kind"] == "card":
            self._sync_handoff(task)
        return task

    def skip_overdue_occurrence(self, task_id: str) -> bool:
        """Reject stale work before admission, so missed checks spend no slot."""
        task = self._tasks.get(task_id)
        if not self.is_due(task_id):
            return False
        if time.time() - datetime.fromisoformat(task["next_run_at"]).timestamp() <= MISSED_GRACE_SECONDS:
            return False
        self.skip_occurrence(task_id, "the app was not running or could not start this check within twelve hours")
        return True

    def skip_occurrence(self, task_id: str, reason: Optional[str] = None) -> None:
        """Leave a missed receipt and move on once, never build a backlog."""
        task = self._tasks.get(task_id)
        if task is None or not self.is_due(task_id):
            return
        if reason is None and task.get("agent_id"):
            from services.agent_service import agent_service
            allowed, refusal = agent_service.can_run(task["agent_id"])
            reason = refusal if not allowed else None
        reason = reason or "the scheduled check could not run"
        due_at = task["next_run_at"]
        skipped = self._advance(task)
        self._save_tasks()
        self._record_missed(task, [due_at, *skipped], reason)

    def _record_missed(self, task: dict, occurrences: list[str], reason: str) -> None:
        # A manual run may still own the task's start stamps. A receipt did
        # no work: keep those stamps and last_run_at for the actual run,
        # while using the ordinary history and its existing lost outcome
        # (Agents 2.0 phase 2-i, 2026-10-13).
        if not occurrences:
            return
        # One receipt per gap, not per occurrence. An agent left off over a
        # weekend misses dozens of hourly slots, and a receipt each would
        # push every real run out of a history capped at MAX_RUNS_PER_TASK:
        # the checks that did not happen would erase the record of the ones
        # that did. Both references coalesce here for the same reason
        # (Agents 2.0 phase 2-i, 2026-10-13).
        missed = len(occurrences)
        note = (f"Missed scheduled run: {reason}." if missed == 1 else
                f"Missed {missed} scheduled runs from {occurrences[0][:16].replace('T', ' ')} "
                f"to {occurrences[-1][:16].replace('T', ' ')}: {reason}.")
        receipt = {**task, "run_started_at": None, "run_for": occurrences[-1],
                   "run_source": "schedule", "run_id": None}
        self._append_run(receipt, "", note, "lost", missed_reason=reason, save=False)
        # The occurrences themselves stay on the one receipt, bounded, so
        # nothing is lost by folding them together: which slots were skipped
        # still answers "did it respect my weekday rule while I was away?".
        self._runs[-1]["missed_occurrences"] = missed
        self._runs[-1]["missed_at"] = occurrences[-MAX_RUNS_PER_TASK:]
        self._save_runs()

    @staticmethod
    def _advance(task: dict) -> list[str]:
        """The schedule's next time: a one-shot is done, a daily one is
        next eligible day's, an interval stays on its original cadence."""
        skipped = []
        now = time.time()
        if task["schedule_kind"] == "once":
            task["enabled"] = False
            task["next_run_at"] = None
        elif task["schedule_kind"] == "daily":
            cursor = datetime.fromisoformat(task["next_run_at"])
            kept = deque(maxlen=MAX_RUNS_PER_TASK)
            while True:
                stamp = _next_daily(task["run_time"], task.get("time_zone"), task.get("weekdays"), cursor)
                cursor = datetime.fromisoformat(stamp)
                if cursor.timestamp() > now:
                    task["next_run_at"] = stamp
                    break
                kept.append(stamp)
            skipped = list(kept)
        elif task["schedule_kind"] == "interval":
            # Advance from the scheduled instant, never the start/finish.
            # Arithmetic jumps over downtime in one step instead of queuing
            # paid catch-up runs (Agents 2.0 phase 2-i, 2026-10-13).
            previous = datetime.fromisoformat(task["next_run_at"]).timestamp()
            interval = task["interval_seconds"]
            steps = max(1, int((now - previous) // interval) + 1)
            task["next_run_at"] = datetime.fromtimestamp(previous + steps * interval, timezone.utc).isoformat()
            # Receipts are history, not queued work. Keep the existing history
            # cap even after years offline, without constructing a huge list
            # (Agents 2.0 phase 2-i, 2026-10-13).
            skipped = [datetime.fromtimestamp(previous + step * interval, timezone.utc).isoformat()
                       for step in range(max(1, steps - MAX_RUNS_PER_TASK), steps)]
        return skipped

    def delete_agent_work(self, agent_id: str) -> int:
        """An agent deleted: its goals and unfinished cards go; finished run
        history stays, under the name it had."""
        doomed = [t["id"] for t in self._tasks.values() if t.get("agent_id") == agent_id
                  and not (t["schedule_kind"] == "card" and t.get("status") in ("done", "running"))]
        for task_id in doomed:
            del self._tasks[task_id]
            for other in self._tasks.values():
                if task_id in (other.get("depends_on") or []):
                    other["depends_on"] = [d for d in other["depends_on"] if d != task_id]
        if doomed:
            self._save_tasks()
        return len(doomed)

    def set_daily_schedule(self, task_id: str, run_time: str) -> dict:
        """Convert an existing task to a daily wall-clock schedule.

        Separate from update_task() on purpose: that one only takes the fields
        the Tasks UI can edit, and changing a schedule has to recompute
        next_run_at or the task would keep firing on its old cadence.
        """
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(f"no such task: {task_id}")
        _parse_hhmm(run_time)
        task["schedule_kind"] = "daily"
        task["run_time"] = run_time
        task["interval_seconds"] = None
        task["next_run_at"] = _next_daily(run_time, task.get("time_zone"), task.get("weekdays"))
        self._save_tasks()
        return task

    def delete_task(self, task_id: str) -> None:
        if task_id in self._tasks:
            del self._tasks[task_id]
            # The Tasks tab says a deleted task's history goes with it.
            if any(r["task_id"] == task_id for r in self._runs):
                self._runs = [r for r in self._runs if r["task_id"] != task_id]
                self._save_runs()
            # A card that waited on this one no longer does.
            for other in self._tasks.values():
                if task_id in (other.get("depends_on") or []):
                    other["depends_on"] = [d for d in other["depends_on"] if d != task_id]
            self._save_tasks()

    def due_tasks(self) -> list[dict]:
        return [t for t in self._tasks.values() if self.is_due(t["id"])]

    def record_run(self, task_id: str, output: str, error: Optional[str] = None, delivered: Optional[bool] = None,
                   delivery_id: Optional[str] = None) -> None:
        """A run finished. The schedule already moved on when a scheduled
        run claimed its occurrence; nothing here moves it."""
        task = self._tasks.get(task_id)
        if task is None:
            return
        self._append_run(task, output, error, "failed" if error else "succeeded", delivered, delivery_id)
        _hook("task.finished", {"source": "agent" if task.get("agent_id") else "task", "task": task["name"],
                                "task_id": task_id, "agent_id": task.get("agent_id"), "output": output, "error": error})
        self._save_tasks()

    def list_runs(self, task_id: Optional[str] = None) -> list[dict]:
        """Newest first. Records from before 2026-10-02 have no start time or
        outcome: the outcome is read from the error and the duration stays
        unknown rather than guessed. A run with a message in the outbox
        carries its delivery's state, and `delivered` from it: True once it
        landed, False when it failed or its fate is unknown, None while it is
        still being tried."""
        runs = self._runs if task_id is None else [r for r in self._runs if r["task_id"] == task_id]
        shown = []
        for r in sorted(runs, key=lambda r: r["ran_at"], reverse=True):
            run = {"started_at": None, "duration_seconds": None, "model": None, "attempt": None, "late_seconds": None,
                   **r, "outcome": r.get("outcome") or ("failed" if r.get("error") else "succeeded")}
            if r.get("delivery_id"):
                from core import outbox
                delivery = outbox.public(outbox.get(r["delivery_id"]))
                run["delivery"] = delivery
                run["delivered"] = None if delivery is None or delivery["status"] in ("pending", "sending") \
                    else delivery["status"] == "delivered"
            shown.append(run)
        return shown


def _model_label(endpoint_id: Optional[str]) -> str:
    if not endpoint_id:
        return "Claude"
    from core import model_endpoints
    endpoint = model_endpoints.get_endpoint(endpoint_id)
    return endpoint["name"] if endpoint else "a removed model"


def _iso_in(seconds: int) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _parse_hhmm(run_time: str) -> tuple[int, int]:
    """"HH:MM" -> (hour, minute), rejecting anything that isn't a real time."""
    try:
        hh, mm = str(run_time).strip().split(":")
        hour, minute = int(hh), int(mm)
    except (ValueError, AttributeError):
        raise ValueError(f"run_time must look like 'HH:MM', got {run_time!r}")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"run_time out of range: {run_time!r}")
    return hour, minute


def _schedule_zone(name: Optional[str]):
    if name is None:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise ValueError(f"time_zone must be an IANA name, got {name!r}") from exc


def _schedule_weekdays(days) -> Optional[list[int]]:
    if days is None:
        return None
    if not isinstance(days, (list, tuple, set)) or not days or any(type(d) is not int or not 0 <= d <= 6 for d in days):
        raise ValueError("weekdays must be a nonempty set of integers, Monday=0 through Sunday=6")
    return sorted(set(days))


def _daily_instant(wall: datetime, zone) -> datetime:
    candidates = [wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc) for fold in (0, 1)]
    local = [(stamp, stamp.astimezone(zone).replace(tzinfo=None)) for stamp in candidates]
    valid = [stamp for stamp, roundtrip in local if roundtrip == wall]
    # Fall back: use the first occurrence only, so a daily check never fires
    # twice. Spring forward: shift forward by the gap (02:30 -> 03:30), so
    # that day's check still happens. Round trips detect nonexistent times;
    # attaching ZoneInfo alone does not (Agents 2.0 phase 2-i, 2026-10-13).
    return min(valid) if valid else min(stamp for stamp, roundtrip in local if roundtrip > wall)


def _next_daily(run_time: str, time_zone: Optional[str] = None,
                weekdays: Optional[list[int]] = None, now: Optional[datetime] = None) -> str:
    """Next eligible wall-clock occurrence, stored as a UTC ISO string."""
    hour, minute = _parse_hhmm(run_time)
    zone = _schedule_zone(time_zone)
    days = _schedule_weekdays(weekdays)
    now = now or datetime.fromtimestamp(time.time(), timezone.utc)
    now_utc = now.astimezone(timezone.utc)
    day = now_utc.astimezone(zone).date()
    while True:
        if days is None or day.weekday() in days:
            wall = datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute)
            # For omitted zones, convert each date using the OS's local rules;
            # astimezone().tzinfo alone would freeze today's DST offset.
            target = _daily_instant(wall, zone)
            if target > now_utc:
                return target.isoformat()
        day += timedelta(days=1)


task_service = TaskService()
