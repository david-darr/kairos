"""Cheap checks before any model run, and where a routine's result goes (Bots
redesign, Phase 3 unit U2, 2026-10-29).

Spec: phase-3-design.md sections 4.2 and 5.4. Phase 5's "Keep an eye on my
day" watch routine is built on exactly this:

    interval every 15 minutes, checks ["calendar", "mail", "runs"],
    access "read-and-draft", deliver "brief", overlap "skip"

A routine may list `checks`. On each occurrence the engine runs them first,
as plain code, and only starts a model run when one of them found something
new. When none did, the run completes as NOTHING NEW with no model call and
no cost. Phase 5 supplies the real checks and the brief sink; this module
supplies the interface and the pacing, so every pacing rule lives in one place.

Registering (done once, at startup, by whoever owns the check):

    register_check("mail", fn)     fn(context) -> CheckResult | dict | bool
    register_sink("brief", fn)     fn(delivery) -> None

Both may be plain or async functions. `context` is a CheckContext. A check
must only read; the engine never gives it a way to write, and a check that
raises counts as failed, never as "found something".

Pacing, per routine and per check kind:
- Two-minute boot hold: nothing is checked in the first two minutes after the
  app starts, so a restart does not fire every routine at once.
- At most 24 model runs a day per routine (local date).
- A failing check backs off from 15 minutes, doubling to 4 hours, with jitter,
  and a success clears it. A check that is backing off is not asked again
  until its time, and the routine shows it as check trouble.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

CHECK_KINDS = ("calendar", "mail", "runs")
BOOT_HOLD_SECONDS = 120
MAX_MODEL_RUNS_PER_DAY = 24
BACKOFF_FIRST_SECONDS = 15 * 60
BACKOFF_MAX_SECONDS = 4 * 3600
MAX_SUMMARY = 2000
CHECK_TIMEOUT_SECONDS = 60

_BOOT = time.time()
_checks: dict[str, Callable] = {}
_sinks: dict[str, Callable] = {}


@dataclass
class CheckContext:
    """What a check is told. Read-only facts about the routine and the owner."""
    kind: str
    routine_id: str
    bot_id: str
    owner: Optional[str]
    now: float
    last_ok_at: Optional[float] = None


@dataclass
class CheckResult:
    """`changed` is True only when something new needs the bot. `summary` is
    text derived from outside data; the engine fences it before any model sees
    it. `signed_out` marks a failure the person has to fix."""
    changed: bool = False
    summary: str = ""
    error: Optional[str] = None
    signed_out: bool = False
    data: dict = field(default_factory=dict)


def register_check(kind: str, fn: Callable) -> None:
    if kind not in CHECK_KINDS:
        raise ValueError(f"a check is one of: {', '.join(CHECK_KINDS)}")
    _checks[kind] = fn


def register_sink(name: str, fn: Callable) -> None:
    if not isinstance(name, str) or not name:
        raise ValueError("a sink needs a name")
    _sinks[name] = fn


def unregister(kind: Optional[str] = None, sink: Optional[str] = None) -> None:
    """For tests and for a feature switching itself off."""
    if kind:
        _checks.pop(kind, None)
    if sink:
        _sinks.pop(sink, None)


def has_sink(name: str) -> bool:
    return name in _sinks


def registered_checks() -> list[str]:
    return sorted(_checks)


def reset_boot(now: Optional[float] = None) -> None:
    """Restart the boot hold clock (tests, and the runner's start)."""
    global _BOOT
    _BOOT = time.time() if now is None else now


def boot_hold_left(now: Optional[float] = None) -> float:
    now = time.time() if now is None else now
    return max(0.0, BOOT_HOLD_SECONDS - (now - _BOOT))


# -- pacing ------------------------------------------------------------------------------

def backoff_seconds(failures: int, rng: Optional[random.Random] = None) -> float:
    """15 minutes after the first failure, doubling to 4 hours, plus up to 20%
    jitter that never pushes it past 4 hours."""
    base = min(BACKOFF_MAX_SECONDS, BACKOFF_FIRST_SECONDS * (2 ** max(0, failures - 1)))
    jitter = (rng or random).uniform(0, 0.2) * base
    return min(BACKOFF_MAX_SECONDS, base + jitter)


def _coerce(value: Any) -> CheckResult:
    if isinstance(value, CheckResult):
        return value
    if isinstance(value, bool):
        return CheckResult(changed=value)
    if isinstance(value, dict):
        return CheckResult(changed=bool(value.get("changed")), summary=str(value.get("summary") or ""),
                           error=value.get("error"), signed_out=bool(value.get("signed_out")),
                           data=dict(value.get("data") or {}))
    return CheckResult(error="the check returned something unreadable")


async def _call(fn: Callable, context: CheckContext) -> CheckResult:
    try:
        result = fn(context)
        if inspect.isawaitable(result):
            result = await asyncio.wait_for(result, CHECK_TIMEOUT_SECONDS)
        return _coerce(result)
    except asyncio.TimeoutError:
        return CheckResult(error="the check took too long")
    except Exception as exc:  # a check failing is a result, not a crash of the engine
        logger.warning("routine check %s failed: %s", context.kind, type(exc).__name__)
        return CheckResult(error=str(exc)[:200] or type(exc).__name__)


@dataclass
class CheckRound:
    """The outcome of every check of one occurrence."""
    held: bool = False                     # inside the boot hold: try again soon
    changed: bool = False                  # something new: a model run is warranted
    ran: list = field(default_factory=list)
    skipped_backoff: list = field(default_factory=list)
    errors: dict = field(default_factory=dict)
    summaries: dict = field(default_factory=dict)
    state: dict = field(default_factory=dict)   # per-kind pacing state to store back

    @property
    def nothing_ran(self) -> bool:
        return not self.ran

    @property
    def trouble(self) -> list:
        return sorted(k for k, v in self.state.items() if v.get("failures"))


async def run_checks(routine_id: str, bot_id: str, owner: Optional[str], kinds: list, state: dict,
                     now: Optional[float] = None, rng: Optional[random.Random] = None) -> CheckRound:
    """Run a routine's checks, with the pacing rules. `state` is the routine's
    stored per-kind pacing state ({failures, backoff_until, last_ok_at,
    last_error}); the updated state is in the result for the caller to save."""
    now = time.time() if now is None else now
    round_ = CheckRound(state={k: dict(v) for k, v in (state or {}).items()})
    if boot_hold_left(now) > 0:
        round_.held = True
        return round_
    for kind in kinds:
        entry = round_.state.setdefault(kind, {"failures": 0, "backoff_until": None, "last_ok_at": None,
                                              "last_error": None})
        if (entry.get("backoff_until") or 0) > now:
            round_.skipped_backoff.append(kind)
            continue
        fn = _checks.get(kind)
        if fn is None:
            result = CheckResult(error="this check is not available yet")
        else:
            result = await _call(fn, CheckContext(kind, routine_id, bot_id, owner, now, entry.get("last_ok_at")))
        round_.ran.append(kind)
        if result.error:
            entry["failures"] = int(entry.get("failures") or 0) + 1
            entry["backoff_until"] = now + backoff_seconds(entry["failures"], rng)
            entry["last_error"] = "signed_out" if result.signed_out else result.error[:200]
            round_.errors[kind] = entry["last_error"]
            continue
        entry.update(failures=0, backoff_until=None, last_ok_at=now, last_error=None)
        if result.changed:
            round_.changed = True
            round_.summaries[kind] = result.summary[:MAX_SUMMARY]
    return round_


# -- result sinks --------------------------------------------------------------------------

async def deliver(sink: str, delivery: dict) -> bool:
    """Hand a finished run to a registered sink. False when there is no such
    sink or it failed, so the engine falls back to the normal destination."""
    fn = _sinks.get(sink)
    if fn is None:
        return False
    try:
        result = fn(delivery)
        if inspect.isawaitable(result):
            await result
        return True
    except Exception:
        logger.exception("routine result sink %s failed", sink)
        return False
