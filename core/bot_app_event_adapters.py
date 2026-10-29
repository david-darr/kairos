"""Bots Phase 3 U4: connected-app event adapters (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6 and 9.

An adapter turns one connected account's activity into safe event envelopes.
The catalogue lists ONLY what is implemented here, and each entry says honestly
whether it is checked on a timer ("poll") or arrives the moment it happens
("instant"). Nothing simulates instant support.

- mail      connected email accounts (IMAP): "A new email arrives", polled.
- calendar  the Kairos calendar: "An event is about to start", polled.
- kairos    Kairos's own activity (a task or goal finished, a card is ready,
            a bot sent a report), instant, through the lifecycle hooks.

`poll(sub)` is pure with respect to storage: it returns (events, new_cursor)
and never writes the cursor. The caller commits the cursor only after the
events are durably received, so a failed hand-off rolls the cursor back and
the next poll sees the same events again (deduplicated by event id).

Every envelope is outside content. Text inside it (an email subject, a calendar
title) is clipped here and fenced by core/bot_app_events.py before a model sees it.
"""
from __future__ import annotations

import hashlib
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

MAX_FIELD_CHARS = 500
MAX_SUMMARY_CHARS = 300
MAX_DATA_KEYS = 20
KEYS_KEPT = 300          # recent message keys remembered per mail subscription
MAIL_FETCH_LIMIT = 50
CALENDAR_LEAD_DEFAULT = 15
CALENDAR_LEAD_RANGE = (5, 60)


class AdapterError(Exception):
    """A poll that could not run. `code` is one of: revoked, unavailable, error."""

    def __init__(self, message: str, code: str = "error") -> None:
        super().__init__(message)
        self.code = code


def clip(value, limit: int = MAX_FIELD_CHARS):
    if isinstance(value, str):
        return " ".join(value.split())[:limit]
    if isinstance(value, dict):
        return {str(k)[:60]: clip(v, limit) for k, v in list(value.items())[:MAX_DATA_KEYS]}
    if isinstance(value, (list, tuple)):
        return [clip(v, limit) for v in list(value)[:MAX_DATA_KEYS]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return clip(str(value), limit)


def envelope(event_type: str, event_id: str, summary: str, data: dict, *, source: str, at: Optional[float] = None) -> dict:
    """The one safe shape every event takes, from any source. Always marked untrusted."""
    return {"id": str(event_id)[:200], "type": event_type[:100], "at": float(at if at is not None else time.time()),
            "source": clip(source, 80), "summary": clip(summary, MAX_SUMMARY_CHARS), "data": clip(data or {}),
            "untrusted": True}


def _visible(account: dict, owner: str) -> bool:
    from core.auth import auth_manager
    return account.get("owner") == owner or auth_manager.is_admin(owner)


class Adapter:
    id = ""
    label = ""
    delivery = "poll"            # poll | instant
    interval_seconds = 900
    events: list[dict] = []
    fields: list[dict] = []

    def availability(self, owner: str) -> dict:
        raise NotImplementedError

    def poll(self, sub: dict, now: Optional[float] = None) -> tuple[list[dict], dict]:
        return [], dict(sub.get("cursor") or {})

    def validate_config(self, owner: str, config: dict) -> dict:
        return {}

    def delivery_label(self) -> str:
        if self.delivery == "instant":
            return "Instant"
        minutes = max(1, self.interval_seconds // 60)
        return f"Checked about every {minutes} minutes"


class MailAdapter(Adapter):
    id = "mail"
    label = "Email"
    delivery = "poll"
    interval_seconds = 900
    events = [{"type": "mail.received", "label": "A new email arrives"}]
    fields = [{"key": "account_id", "label": "Email account", "kind": "account", "required": True}]

    @staticmethod
    def _accounts(owner: str) -> list[dict]:
        from services.email_service import email_service
        return [a for a in email_service.list_accounts() if _visible(a, owner)]

    def availability(self, owner: str) -> dict:
        accounts = self._accounts(owner)
        if not accounts:
            return {"available": False, "reason": "No email account is connected.",
                    "fix": {"label": "Connect email", "target": "email"}, "accounts": []}
        return {"available": True, "reason": "", "fix": None,
                "accounts": [{"id": a["id"], "label": a["email"]} for a in accounts]}

    def validate_config(self, owner: str, config: dict) -> dict:
        accounts = self._accounts(owner)
        wanted = str((config or {}).get("account_id") or "")
        if not accounts:
            raise AdapterError("Connect an email account first.", "unavailable")
        if not wanted:
            if len(accounts) == 1:
                wanted = accounts[0]["id"]
            else:
                raise AdapterError("Pick which email account to watch.", "unavailable")
        if wanted not in {a["id"] for a in accounts}:
            raise AdapterError("That email account is not one of yours.", "revoked")
        return {"account_id": wanted}

    @staticmethod
    def _key(message: dict) -> str:
        raw = "|".join(str(message.get(k) or "") for k in ("from", "subject", "date"))
        return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:20]

    def poll(self, sub: dict, now: Optional[float] = None) -> tuple[list[dict], dict]:
        owner = sub["owner_user"]
        account_id = (sub.get("config") or {}).get("account_id")
        if account_id not in {a["id"] for a in self._accounts(owner)}:
            # The account was removed or is no longer this person's: stop, say why, never read it.
            raise AdapterError("This email account is no longer connected.", "revoked")
        from services.email_service import email_service
        try:
            messages = email_service.list_messages(account_id, "INBOX", MAIL_FETCH_LIMIT)
        except Exception as error:
            raise AdapterError(f"Could not reach the mailbox: {type(error).__name__}", "error") from error
        cursor = dict(sub.get("cursor") or {})
        known = list(cursor.get("keys") or [])
        keyed = [(self._key(m), m) for m in messages]  # newest first
        if not cursor.get("primed"):
            # First look: remember what is already there so old mail never floods in.
            return [], {"primed": True, "keys": [k for k, _ in keyed][:KEYS_KEPT]}
        seen = set(known)
        fresh = [(k, m) for k, m in keyed if k not in seen]
        label = next((a["email"] for a in self._accounts(owner) if a["id"] == account_id), "email")
        out = []
        for key, message in reversed(fresh):  # oldest first
            out.append(envelope("mail.received", f"mail:{account_id}:{key}",
                                f"New email from {message.get('from') or 'someone'}: {message.get('subject') or '(no subject)'}",
                                {"from": message.get("from"), "subject": message.get("subject"), "date": message.get("date"),
                                 "account": label}, source=f"Email ({label})", at=now))
        return out, {"primed": True, "keys": ([k for k, _ in fresh] + known)[:KEYS_KEPT]}


class CalendarAdapter(Adapter):
    id = "calendar"
    label = "Calendar"
    delivery = "poll"
    interval_seconds = 300
    events = [{"type": "calendar.event_starting", "label": "A calendar event is about to start"}]
    fields = [{"key": "lead_minutes", "label": "Minutes before it starts", "kind": "number", "required": False,
               "min": CALENDAR_LEAD_RANGE[0], "max": CALENDAR_LEAD_RANGE[1], "default": CALENDAR_LEAD_DEFAULT}]

    def availability(self, owner: str) -> dict:
        return {"available": True, "reason": "", "fix": None, "accounts": []}

    def validate_config(self, owner: str, config: dict) -> dict:
        lead = (config or {}).get("lead_minutes", CALENDAR_LEAD_DEFAULT)
        if type(lead) is not int or not CALENDAR_LEAD_RANGE[0] <= lead <= CALENDAR_LEAD_RANGE[1]:
            raise AdapterError(f"Minutes before must be a whole number from {CALENDAR_LEAD_RANGE[0]} to {CALENDAR_LEAD_RANGE[1]}.",
                               "unavailable")
        return {"lead_minutes": lead}

    def poll(self, sub: dict, now: Optional[float] = None) -> tuple[list[dict], dict]:
        from core import calendar_recurrence as repeats
        from services.calendar_service import calendar_service
        moment = datetime.fromtimestamp(now if now is not None else time.time(), tz=timezone.utc)
        lead = int((sub.get("config") or {}).get("lead_minutes") or CALENDAR_LEAD_DEFAULT)
        upper = moment + timedelta(minutes=lead)
        try:
            found = calendar_service.list_range(moment.isoformat(), (upper + timedelta(seconds=1)).isoformat())
        except Exception as error:
            raise AdapterError(f"Could not read the calendar: {type(error).__name__}", "error") from error
        cursor = dict(sub.get("cursor") or {})
        announced = dict(cursor.get("announced") or {})
        out = []
        for event in found:
            if event.get("source") != "calendar" or event.get("all_day"):
                continue
            try:
                starts = repeats.stamp(event["start"], event.get("time_zone", "UTC"))
            except (ValueError, KeyError):
                continue
            if not moment <= starts <= upper:
                continue
            key = f"{event['id']}@{starts.astimezone(timezone.utc).isoformat()}"
            if key in announced:
                continue
            announced[key] = moment.timestamp()
            out.append(envelope("calendar.event_starting", f"calendar:{key}",
                                f"{event.get('title') or 'An event'} starts at {starts.strftime('%H:%M')}",
                                {"title": event.get("title"), "starts_at": starts.isoformat(), "location": event.get("location"),
                                 "minutes_away": max(0, int((starts - moment).total_seconds() // 60))},
                                source="Calendar", at=now))
        cutoff = moment.timestamp() - 24 * 3600
        announced = {k: v for k, v in announced.items() if v > cutoff}
        return out, {"announced": announced}


class KairosAdapter(Adapter):
    """Kairos's own lifecycle events. Instant: delivered by core/bot_app_events.on_lifecycle."""
    id = "kairos"
    label = "Kairos activity"
    delivery = "instant"
    events = [{"type": "task.finished", "label": "A task or goal run finished"},
              {"type": "card.review", "label": "A board card is ready for review"},
              {"type": "agent.inbox", "label": "A bot sent a report or a question"}]
    fields: list[dict] = []

    def availability(self, owner: str) -> dict:
        return {"available": True, "reason": "", "fix": None, "accounts": []}

    def poll(self, sub, now=None):
        return [], dict(sub.get("cursor") or {})


ADAPTERS: dict[str, Adapter] = {a.id: a for a in (MailAdapter(), CalendarAdapter(), KairosAdapter())}


def adapter_for_event(event_type: str) -> Optional[Adapter]:
    for adapter in ADAPTERS.values():
        if any(e["type"] == event_type for e in adapter.events):
            return adapter
    return None
