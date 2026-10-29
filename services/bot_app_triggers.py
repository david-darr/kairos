"""Bots Phase 3 U4: connected-app event subscriptions (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6, 8 (U4) and 9.

A subscription says "when this happens in a connected app, start this bot with
these instructions". It is the app-event twin of a webhook trigger: webhook
definitions stay in `triggers.json`; subscriptions live in
`bot_automation_events.sqlite3` (core/bot_event_receipts.py). The engine that
polls them and hands events to the run engine is core/bot_app_events.py.

Rules kept here:
- Every subscription belongs to an owner and a bot, and every read and write
  takes the owner. Another person's id is "not found".
- A subscription only offers events a connected, implemented adapter supports
  (core/bot_app_event_adapters.py). A missing account is refused with a reason.
- "Run straight away" (`auto_run`) is the person's choice, off by default. A bot
  can never turn it on (U5's backend never passes it).
- Configuration changes bump `revision`; poll bookkeeping never does.
- Deletion is soft: seven days to restore, at most 50 kept.
- Every state change is revision-checked so U5's Undo can refuse a stale one.

`automation_backend()` is what services/bot_automation_changes.py (U5) uses for
`create_trigger` with source "app"; it satisfies that module's Backend contract.
"""
from __future__ import annotations

import copy
import threading
import time
import uuid
from typing import Optional

from core import bot_event_receipts as receipts_module
from core.bot_app_event_adapters import ADAPTERS, AdapterError, adapter_for_event

try:  # U5's exceptions when that module is merged; local stand-ins until then
    from services.bot_automation_changes import Backend as _BackendBase, ChangeRefused, NotFound
except ImportError:  # pragma: no cover - exercised only before U5 lands
    class _BackendBase:  # type: ignore[no-redef]
        kind = ""

    class ChangeRefused(Exception):  # type: ignore[no-redef]
        def __init__(self, message: str, code: str = "refused", status: int = 409):
            super().__init__(message)
            self.code, self.status = code, status

    class NotFound(ChangeRefused):  # type: ignore[no-redef]
        def __init__(self, message: str = "Not found."):
            super().__init__(message, "not_found", 404)

MAX_PER_BOT = 10
MAX_NAME = 80
MAX_TEMPLATE = 4000
MAX_CONDITIONS = 10
RESTORE_WINDOW = receipts_module.RESTORE_WINDOW_SECONDS
CONFIG_KEYS = ("name", "enabled", "adapter", "events", "conditions", "config", "title_template", "prompt_template", "auto_run")
_lock = threading.RLock()


class AppTriggerError(ChangeRefused):
    """A refusal with a plain reason, for the API and for the model alike."""


def _store() -> receipts_module.ReceiptStore:
    return receipts_module.store()


def _fail(message: str, code: str = "invalid", status: int = 400):
    raise AppTriggerError(message, code, status)


# -- reading ---------------------------------------------------------------------------

def get_subscription(sub_id: str) -> Optional[dict]:
    sub = _store().get_subscription(sub_id)
    return sub if sub and not sub.get("deleted_at") else None


def _owned(owner: str, sub_id: str, *, deleted: bool = False) -> dict:
    sub = _store().get_subscription(sub_id)
    if sub is None or sub["owner_user"] != owner or bool(sub.get("deleted_at")) != deleted:
        raise AppTriggerError("No such trigger.", "not_found", 404)
    return sub


def list_subscriptions(owner: str, bot_id: Optional[str] = None) -> list[dict]:
    return _store().list_subscriptions(owner, bot_id=bot_id)


def revision_of(sub: dict) -> str:
    return str(sub.get("revision", 1))


def public(sub: dict) -> dict:
    """What the page and the API show: never the cursor, never an application id."""
    adapter = ADAPTERS.get(sub["adapter"])
    shown = {k: copy.deepcopy(v) for k, v in sub.items() if k not in ("cursor", "application_id")}
    shown["revision"] = sub.get("revision", 1)
    shown["delivery_label"] = adapter.delivery_label() if adapter else ""
    store = _store()
    shown["pending_runs"] = store.pending_count(sub["id"])
    shown["poisoned"] = sum(1 for r in store.list_receipts(sub["id"], 50) if r["status"] == "poison")
    return shown


def summaries(owner: str) -> list[dict]:
    """Rows for the unified Automations list (U2/U3 read these)."""
    return [{"id": s["id"], "kind": "app_event", "name": s["name"], "agent_id": s.get("agent_id"), "enabled": s["enabled"],
             "state": s.get("state") or "ok", "last_event_at": s.get("last_event_at"), "next_poll_at": s.get("next_poll_at"),
             "delivery": s.get("delivery"), "error": s.get("last_error") or "",
             "fix": ({"label": "Reconnect", "target": "email"} if s.get("state") == "needs_reconnect" and s.get("adapter") == "mail"
                     else None)} for s in list_subscriptions(owner)]


# -- validating --------------------------------------------------------------------------

def _clean_conditions(raw) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_CONDITIONS:
        _fail(f"conditions is a list of up to {MAX_CONDITIONS} filters.")
    out = []
    for c in raw:
        if not isinstance(c, dict) or not str(c.get("path") or "").strip() or len(str(c["path"])) > 200:
            _fail("Each filter needs a field to look at.")
        out.append({"path": str(c["path"]).strip(), "equals": str(c.get("equals", ""))[:200]})
    return out


def _clean_events(owner: str, events) -> tuple[str, list[str]]:
    if not isinstance(events, list) or not events:
        _fail("Pick at least one event to watch for.")
    types = []
    for e in events:
        adapter = adapter_for_event(str(e))
        if adapter is None:
            _fail(f"{str(e)[:60]!r} is not an event Kairos can watch for yet.")
        types.append((adapter.id, str(e)))
    ids = {a for a, _ in types}
    if len(ids) != 1:
        _fail("One trigger watches one app. Make a second trigger for the other.")
    adapter_id = ids.pop()
    return adapter_id, sorted({t for _, t in types})


def _check_bot(owner: str, bot_id: str) -> dict:
    from services.agent_service import agent_service
    bot = agent_service.get(bot_id)
    if bot is None:
        _fail("That bot no longer exists.", "not_found", 404)
    return bot


def _validate(owner: str, fields: dict, existing: Optional[dict] = None) -> dict:
    merged = {**(existing or {}), **fields}
    name = " ".join(str(merged.get("name") or "").split())
    if not name or len(name) > MAX_NAME:
        _fail(f"Give the trigger a name of 1 to {MAX_NAME} characters.")
    prompt = str(merged.get("prompt_template") or "").strip()
    if not prompt or len(prompt) > MAX_TEMPLATE:
        _fail(f"Say what the bot should do, in 1 to {MAX_TEMPLATE} characters.")
    adapter_id, events = _clean_events(owner, merged.get("events"))
    adapter = ADAPTERS[adapter_id]
    availability = adapter.availability(owner)
    if not availability["available"]:
        _fail(availability["reason"] or f"{adapter.label} is not connected.", "unavailable", 409)
    try:
        config = adapter.validate_config(owner, merged.get("config") or {})
    except AdapterError as error:
        _fail(str(error), "unavailable" if error.code != "revoked" else "invalid", 409 if error.code != "revoked" else 404)
    for flag in ("enabled", "auto_run"):
        if flag in merged and not isinstance(merged[flag], bool):
            _fail(f"{flag} is true or false.")
    return {"name": name, "adapter": adapter_id, "events": events, "config": config, "prompt_template": prompt,
            "title_template": str(merged.get("title_template") or "").strip()[:200],
            "conditions": _clean_conditions(merged.get("conditions") or []),
            "auto_run": bool(merged.get("auto_run", False)), "enabled": bool(merged.get("enabled", True))}


# -- writing -----------------------------------------------------------------------------

def create(owner: str, bot_id: str, fields: dict, *, application_id: Optional[str] = None) -> dict:
    with _lock:
        if application_id:
            for existing in _store().list_subscriptions(owner):
                if existing.get("application_id") == application_id:
                    return existing  # a retried or crash-recovered create applies once
        _check_bot(owner, bot_id)
        if len(list_subscriptions(owner, bot_id)) >= MAX_PER_BOT:
            _fail(f"A bot can have {MAX_PER_BOT} app triggers. Delete one first.", "limit", 409)
        clean = _validate(owner, fields)
        now = time.time()
        adapter = ADAPTERS[clean["adapter"]]
        sub = {"id": uuid.uuid4().hex[:12], "owner_user": owner, "agent_id": bot_id, **clean, "revision": 1,
               "delivery": adapter.delivery, "cursor": {}, "state": "ok", "last_error": "", "fail_streak": 0,
               "created_at": now, "updated_at": now, "deleted_at": None, "last_poll_at": None, "last_event_at": None,
               "next_poll_at": now + 5 if adapter.delivery == "poll" else None, "application_id": application_id}
        _store().put_subscription(sub)
        _kick()
        return sub


def update(owner: str, sub_id: str, patch: dict, expected_revision: Optional[str] = None,
           *, application_id: Optional[str] = None) -> dict:
    with _lock:
        sub = _owned(owner, sub_id)
        if expected_revision is not None and str(expected_revision) != revision_of(sub):
            _fail("That trigger changed in the meantime. Look at it again first.", "stale", 409)
        unknown = set(patch) - set(CONFIG_KEYS)
        if unknown:
            _fail(f"Cannot change {', '.join(sorted(unknown))}.")
        if set(patch) == {"enabled"} and patch["enabled"] is False:
            clean = {**sub, "enabled": False}  # pausing never needs the account to be reachable
        else:
            clean = _validate(owner, patch, sub)
        watched_changed = (clean["adapter"], clean["config"], clean["events"]) != (sub["adapter"], sub["config"], sub["events"])
        changed = {k: v for k, v in clean.items() if sub.get(k) != v}
        if not changed:
            return sub
        sub.update(changed)
        sub["revision"] = sub.get("revision", 1) + 1
        sub["updated_at"] = time.time()
        if watched_changed:
            sub["cursor"] = {}  # a different account or event starts fresh and never replays old mail
        if "enabled" in changed and clean["enabled"]:
            sub.update(state="ok", last_error="", fail_streak=0,
                       next_poll_at=time.time() + 5 if sub["delivery"] == "poll" else None)
        if application_id:
            sub["application_id"] = application_id
        _store().put_subscription(sub)
        _kick()
        return sub


def delete(owner: str, sub_id: str) -> dict:
    with _lock:
        sub = _owned(owner, sub_id)
        sub["deleted_at"] = time.time()
        sub["enabled"] = False
        _store().put_subscription(sub)
        _store().trim_deleted_subscriptions()
        return sub


def restore(owner: str, sub_id: str) -> dict:
    with _lock:
        sub = _owned(owner, sub_id, deleted=True)
        if time.time() - sub["deleted_at"] > RESTORE_WINDOW:
            _store().remove_subscription(sub_id)
            _fail("The seven days to restore this have passed.", "expired", 410)
        _check_bot(owner, sub["agent_id"])
        sub.update(deleted_at=None, enabled=False, revision=sub.get("revision", 1) + 1, cursor={}, state="ok",
                   last_error="", fail_streak=0, updated_at=time.time())
        _store().put_subscription(sub)
        return sub  # comes back paused: the person decides when it runs again


def deleted(owner: str) -> list[dict]:
    cutoff = time.time() - RESTORE_WINDOW
    return [{"id": s["id"], "name": s["name"], "agent_id": s.get("agent_id"), "deleted_at": s["deleted_at"],
             "restorable_until": s["deleted_at"] + RESTORE_WINDOW}
            for s in _store().list_subscriptions(owner, deleted=True) if s["deleted_at"] >= cutoff]


def on_bot_deleted(agent_id: str) -> int:
    """A deleted bot's subscriptions are removed and their queued work cancelled."""
    count = 0
    with _lock:
        for sub in _store().list_subscriptions(bot_id=agent_id):
            _store().remove_subscription(sub["id"])
            count += 1
    return count


# -- the poller's bookkeeping (never bumps the revision) ---------------------------------------

def due_subscriptions(now: float) -> list[dict]:
    from services.agent_service import agent_service
    due = []
    for sub in _store().list_subscriptions():
        if not sub["enabled"] or sub["delivery"] != "poll":
            continue
        if agent_service.get(sub.get("agent_id")) is None:
            sub.update(enabled=False, state="error", last_error="Its bot was removed.")
            _store().put_subscription(sub)
            continue
        if (sub.get("next_poll_at") or 0) <= now:
            due.append(sub)
    return due


def record_poll(sub_id: str, *, state: str, error: str, failed: bool, next_poll_at: float, now: float,
                cursor: Optional[dict] = None, got_events: bool = False, revision=None) -> None:
    with _lock:
        sub = _store().get_subscription(sub_id)
        if sub is None or sub.get("deleted_at"):
            return
        if cursor is not None and (revision is None or revision == sub.get("revision", 1)):
            sub["cursor"] = cursor  # a poll that raced a configuration change must not overwrite its fresh start
        sub.update(state=state, last_error=error[:300], last_poll_at=now, next_poll_at=next_poll_at,
                   fail_streak=(sub.get("fail_streak", 0) + 1) if failed else 0)
        if got_events:
            sub["last_event_at"] = now
        _store().put_subscription(sub)


def subscriptions_for_event(event_type: str) -> list[dict]:
    return [s for s in _store().list_subscriptions() if s["enabled"] and s["delivery"] == "instant"
            and event_type in s["events"]]


def note_event(sub_id: str) -> None:
    with _lock:
        sub = _store().get_subscription(sub_id)
        if sub and not sub.get("deleted_at"):
            sub["last_event_at"] = time.time()
            _store().put_subscription(sub)


def _kick() -> None:
    try:
        from core import bot_app_events
        bot_app_events.start()
    except Exception:
        pass


# -- test and sync ------------------------------------------------------------------------------

async def test(owner: str, sub_id: str) -> dict:
    """A safe test: shows what a matching event would look like, how it would be fenced and whether the
    account can be reached. Starts no run, writes no cursor and creates no receipt."""
    import asyncio
    from core import bot_app_events
    from core.bot_app_event_adapters import envelope
    sub = _owned(owner, sub_id)
    adapter = ADAPTERS[sub["adapter"]]
    kind = sub["events"][0]
    sample = envelope(kind, f"sample:{sub_id}", f"Sample: {adapter.events[0]['label']}", {"sample": True},
                      source=adapter.label)
    matched = bot_app_events._passes(sub, sample) is None
    reach = {"ok": True, "message": ""}
    if adapter.delivery == "poll":
        try:
            await asyncio.to_thread(adapter.poll, {**sub, "cursor": {"primed": True, "keys": []}})
        except AdapterError as error:
            reach = {"ok": False, "message": str(error)}
    return {"sample": sample, "passes_filters": matched,
            "preview": bot_app_events.render_events([sample], sub["name"]), "reachable": reach["ok"],
            "message": reach["message"], "delivery": adapter.delivery_label(),
            "note": "Nothing was started. This only checks the setup."}


async def sync(owner: str, sub_id: str) -> dict:
    """Reconcile now: retry waiting batches and poll once, outside the timer."""
    from core import bot_app_events
    sub = _owned(owner, sub_id)
    for receipt in _store().retryable(None, limit=20):
        if receipt["source_id"] == sub_id:
            await bot_app_events.hand_off(receipt["id"])
    result = {"state": sub.get("state"), "events": 0}
    if sub["enabled"] and sub["delivery"] == "poll":
        result = await bot_app_events.poll_one(_owned(owner, sub_id))
    return {**result, "trigger": public(_owned(owner, sub_id))}


# -- U5's backend ---------------------------------------------------------------------------------

class AppTriggerBackend(_BackendBase):
    """The Backend contract in services/bot_automation_changes.py, for connected-app triggers."""
    kind = "trigger"

    def get(self, owner, trigger_id):
        sub = _store().get_subscription(str(trigger_id))
        return sub if sub and sub["owner_user"] == owner and not sub.get("deleted_at") else None

    def list(self, owner, bot_id):
        return list_subscriptions(owner, bot_id)

    def snapshot(self, record):
        return {k: copy.deepcopy(record[k]) for k in CONFIG_KEYS if k in record}

    def revision(self, record):
        return revision_of(record)

    def create(self, owner, bot_id, spec, application_id):
        spec = {k: v for k, v in spec.items() if k != "auto_run"}  # a bot never turns on Run straight away
        return create(owner, bot_id, spec, application_id=application_id)

    def update(self, owner, trigger_id, patch, expected_revision, application_id):
        patch = {k: v for k, v in patch.items() if k != "auto_run"}
        return update(owner, trigger_id, patch, expected_revision, application_id=application_id)

    def delete(self, owner, trigger_id, expected_revision, application_id):
        sub = self.get(owner, trigger_id)
        if sub is None:
            raise NotFound("That trigger no longer exists.")
        if revision_of(sub) != str(expected_revision):
            raise AppTriggerError("That trigger changed in the meantime. Look at it again before deleting it.", "stale", 409)
        delete(owner, trigger_id)

    def replace(self, owner, trigger_id, snapshot, expected_revision, application_id):
        sub = self.get(owner, trigger_id)
        if sub is None:
            raise NotFound("That trigger no longer exists.")
        if revision_of(sub) != str(expected_revision):
            raise AppTriggerError("That trigger changed after this change, so it was left as it is.", "stale", 409)
        patch = {k: v for k, v in snapshot.items() if k in CONFIG_KEYS and k != "adapter"}
        patch["auto_run"] = bool(sub.get("auto_run"))  # undo never flips the person's own Run straight away choice
        return update(owner, trigger_id, patch, expected_revision, application_id=application_id)

    def restore(self, owner, snapshot, application_id):
        with _lock:
            existing = _store().get_subscription(snapshot["id"])
            if existing is not None and not existing.get("deleted_at"):
                raise AppTriggerError("Something already uses that trigger's place, so it was not restored.", "stale", 409)
            sub = copy.deepcopy(snapshot)
            sub.update(deleted_at=None, application_id=application_id, revision=(snapshot.get("revision", 1) + 1),
                       updated_at=time.time())
            _check_bot(owner, sub["agent_id"])
            _store().put_subscription(sub)
            _kick()
            return sub

    def find_application(self, owner, bot_id, application_id, spec):
        for sub in _store().list_subscriptions(owner, bot_id=bot_id):
            if sub.get("application_id") == application_id:
                return sub
        return None

    def matches(self, record, patch):
        snap = self.snapshot(record)
        return all(snap.get(k) == v for k, v in patch.items())

    def describe(self, record):
        labels = {e["type"]: e["label"] for a in ADAPTERS.values() for e in a.events}
        return "when " + " or ".join(labels.get(t, t).lower() for t in record.get("events", [])[:3])


def automation_backend() -> AppTriggerBackend:
    return AppTriggerBackend()
