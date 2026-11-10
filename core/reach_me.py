"""Reach me (Kairos 2.3.0 plan, item 3): one setting per account for where and how its bots reach the person.

What lives here is the account's own choice and state, nothing that sends:
- the order bots try to **message** you (in the app, Telegram, Discord DM, WhatsApp, iMessage, Signal, SMS),
- the order bots try to **call** you (a real phone call, an in-app ring, a Discord voice channel, a Telegram voice
  message as the call stand-in on Telegram),
- quiet hours (messages wait until they end; calls are refused),
- a per-bot override (its own order, or never),
- the one STOP across every channel: a reply of STOP (or a common variant) anywhere pauses every proactive message and
  call from this account's bots until it is turned back on here, or the person replies START.

Everything is per account, in the account's own folder (reach_me.json). Sending is services/reach_me.py.
"""
import re
import threading
import time
from datetime import datetime, timedelta
from typing import Optional

from core import accounts
from core.atomic_io import read_json, write_json_atomic

FILE = "reach_me.json"
_LOCK = threading.RLock()

MESSAGE_CHANNELS = ("app", "telegram", "discord", "whatsapp", "imessage", "signal", "sms")
CALL_CHANNELS = ("phone", "app", "discord", "telegram")
MESSAGE_LABELS = {"app": "In the Kairos app", "telegram": "Telegram", "discord": "Discord DM", "whatsapp": "WhatsApp",
                  "imessage": "iMessage (BlueBubbles)", "signal": "Signal", "sms": "SMS text"}
CALL_LABELS = {"phone": "Phone call", "app": "Ring in the Kairos app", "discord": "Discord voice channel",
               "telegram": "Telegram voice message"}
DEFAULT_CALL = ["phone", "app", "discord", "telegram"]
KEEP_LOG = 50
KEEP_STOPS = 20

# Whole-message replies only, any case, trailing punctuation ignored. Chat apps get the plain words; texts also get the
# carrier opt-out words, which in a chat could easily mean something else ("cancel" a task, say).
STOP_WORDS = {"stop", "stop all", "stopall", "unsubscribe", "stop kairos", "stop messages", "stop calling"}
SMS_STOP_WORDS = STOP_WORDS | {"cancel", "end", "quit", "optout", "opt out", "revoke"}
START_WORDS = {"start", "unstop", "resume", "start kairos"}


class Paused(Exception):
    """The person paused every proactive message and call (a STOP, or the switch in Reach me)."""


def _file(account: Optional[str] = None, create: bool = True) -> str:
    import os
    return os.path.join(accounts.account_dir(account, create=create), FILE)


def _legacy_call_order(account: Optional[str]) -> list:
    """Before Reach me, one ring preference chose app, Discord or phone (Settings > Channels > Discord)."""
    from core import settings as settings_store
    try:
        with accounts.as_account(account or accounts.effective_account()):
            preference = settings_store.get_setting("ring_preference") or "app"
    except Exception:
        preference = "app"
    if preference == "discord":
        return ["discord", "phone", "app", "telegram"]
    if preference == "phone":
        return ["phone", "app", "discord", "telegram"]
    return list(DEFAULT_CALL)


def _clean_order(value, allowed: tuple, what: str) -> list:
    if not isinstance(value, list):
        raise ValueError(f"The {what} order must be a list.")
    order = []
    for item in value:
        if item not in allowed:
            raise ValueError(f"Unknown way to {what}: {item!r}.")
        if item not in order:
            order.append(item)
    return order


_TIME = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")


def _clean_time(value, what: str) -> str:
    text = str(value or "").strip()
    if not _TIME.fullmatch(text):
        raise ValueError(f"Quiet hours {what} must be a time like 22:00.")
    return text


def load(account: Optional[str] = None) -> dict:
    """The account's Reach me, with defaults for anything not chosen yet."""
    stored = read_json(_file(account, create=False), {})
    stored = stored if isinstance(stored, dict) else {}
    quiet = stored.get("quiet") if isinstance(stored.get("quiet"), dict) else {}
    return {
        "message": list(stored["message"]) if isinstance(stored.get("message"), list) else list(MESSAGE_CHANNELS),
        "call": list(stored["call"]) if isinstance(stored.get("call"), list) else _legacy_call_order(account),
        "quiet": {"enabled": bool(quiet.get("enabled")), "start": quiet.get("start") or "22:00", "end": quiet.get("end") or "07:00"},
        "bots": dict(stored.get("bots") or {}) if isinstance(stored.get("bots"), dict) else {},
        "paused": stored.get("paused") if isinstance(stored.get("paused"), dict) else None,
        "stops": list(stored.get("stops") or [])[-KEEP_STOPS:],
        "log": list(stored.get("log") or [])[-KEEP_LOG:],
        "saved": bool(stored),
    }


def _write(account: Optional[str], data: dict) -> None:
    keep = {k: data[k] for k in ("message", "call", "quiet", "bots", "paused", "stops", "log")}
    write_json_atomic(_file(account), keep)


def save(patch: dict, account: Optional[str] = None) -> dict:
    """Change the orders, quiet hours or per-bot overrides. The pause is changed only by pause() and resume()."""
    account = account or accounts.effective_account()
    with _LOCK:
        data = load(account)
        if "message" in patch:
            data["message"] = _clean_order(patch["message"], MESSAGE_CHANNELS, "message you")
        if "call" in patch:
            data["call"] = _clean_order(patch["call"], CALL_CHANNELS, "call you")
        if "quiet" in patch:
            quiet = patch["quiet"] if isinstance(patch["quiet"], dict) else {}
            data["quiet"] = {"enabled": bool(quiet.get("enabled")),
                             "start": _clean_time(quiet.get("start", data["quiet"]["start"]), "start"),
                             "end": _clean_time(quiet.get("end", data["quiet"]["end"]), "end")}
            if data["quiet"]["enabled"] and data["quiet"]["start"] == data["quiet"]["end"]:
                raise ValueError("Quiet hours need a different start and end.")
        if "bots" in patch:
            bots = patch["bots"] if isinstance(patch["bots"], dict) else {}
            cleaned = {}
            for bot_id, override in bots.items():
                if not isinstance(bot_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", bot_id) or not isinstance(override, dict):
                    raise ValueError("A bot override needs the bot's id and its choices.")
                entry = {}
                for kind, allowed in (("message", MESSAGE_CHANNELS), ("call", CALL_CHANNELS)):
                    value = override.get(kind)
                    if value is not None:      # None: the account's order; []: never
                        entry[kind] = _clean_order(value, allowed, "message you" if kind == "message" else "call you")
                if entry:
                    cleaned[bot_id] = entry
            data["bots"] = cleaned
        _write(account, data)
        return load(account)


def order_for(bot_id: str, kind: str, account: Optional[str] = None) -> list:
    """The order one bot uses: its own override, else the account's."""
    data = load(account)
    override = (data["bots"].get(bot_id) or {}).get(kind)
    return list(override) if override is not None else list(data[kind])


# -- the one STOP -------------------------------------------------------------------------------------------

def paused(account: Optional[str] = None) -> Optional[dict]:
    return load(account)["paused"]


def refuse_if_paused(account: Optional[str] = None, error=Paused) -> None:
    """Raise `error` (the caller's own refusal type) when the person paused bots' messages and calls."""
    state = paused(account)
    if state:
        raise error("The person paused all messages and calls from their bots (they replied STOP or turned it off). "
                    "Nothing was sent. They can turn it back on in Settings > Reach me, or reply START.")


def _record(account: str, action: str, channel: str, by: str) -> dict:
    with _LOCK:
        data = load(account)
        entry = {"at": time.time(), "action": action, "channel": channel, "by": by}
        data["paused"] = {"at": entry["at"], "channel": channel, "by": by} if action == "stop" else None
        data["stops"] = (data["stops"] + [entry])[-KEEP_STOPS:]
        _write(account, data)
        return entry


def pause(channel: str, by: str = "reply", account: Optional[str] = None) -> dict:
    return _record(account or accounts.effective_account(), "stop", channel, by)


def resume(channel: str, by: str = "reply", account: Optional[str] = None) -> dict:
    return _record(account or accounts.effective_account(), "start", channel, by)


def command_of(text, sms: bool = False) -> Optional[str]:
    """'stop', 'start' or None for one incoming message."""
    words = " ".join(str(text or "").lower().replace("’", "'").split()).strip(" .!?,;:'\"")
    if not words or len(words) > 20:
        return None
    if words in (SMS_STOP_WORDS if sms else STOP_WORDS):
        return "stop"
    if words in START_WORDS:
        return "start"
    return None


STOPPED_REPLY = ("Done. Kairos bots will not message or call you anywhere until you turn it back on in "
                 "Settings > Reach me, or reply START.")
STARTED_REPLY = "Done. Kairos bots can message and call you again, the way Settings > Reach me says."


def handle_reply(text, channel: str, sms: bool = False, account: Optional[str] = None) -> Optional[str]:
    """A STOP or START from the person on any channel: record it and say what changed. None for any other message,
    which then goes on as usual. Runs as the account the channel belongs to."""
    command = command_of(text, sms=sms)
    if command == "stop":
        pause(channel, "reply", account)
        return STOPPED_REPLY
    if command == "start":
        resume(channel, "reply", account)
        return STARTED_REPLY
    return None


# -- quiet hours ----------------------------------------------------------------------------------------------

def owner_of(account: str) -> str:
    from core.auth import SINGLE_USER, auth_manager
    try:
        return auth_manager.username_for_account(account) or SINGLE_USER
    except Exception:
        return SINGLE_USER


def quiet_until(account: Optional[str] = None, now: Optional[float] = None) -> Optional[float]:
    """When quiet hours end, as a unix time, if it is quiet hours now in the person's own time zone; else None."""
    from core import bot_outbound
    account = account or accounts.effective_account()
    quiet = load(account)["quiet"]
    if not quiet["enabled"]:
        return None
    zone = bot_outbound._zone(bot_outbound.owner_zone(owner_of(account)))
    now = time.time() if now is None else now
    moment = datetime.fromtimestamp(now, zone)
    start_h, start_m = map(int, quiet["start"].split(":"))
    end_h, end_m = map(int, quiet["end"].split(":"))
    minutes = moment.hour * 60 + moment.minute
    start, end = start_h * 60 + start_m, end_h * 60 + end_m
    inside = start <= minutes < end if start < end else (minutes >= start or minutes < end)
    if not inside:
        return None
    day = moment.date() if minutes < end else moment.date() + timedelta(days=1)
    ends = datetime(day.year, day.month, day.day, end_h, end_m, tzinfo=zone)
    return ends.timestamp()


def clock(at: float, account: Optional[str] = None) -> str:
    """A time in the person's own zone, as 07:00."""
    from core import bot_outbound
    account = account or accounts.effective_account()
    return datetime.fromtimestamp(at, bot_outbound._zone(bot_outbound.owner_zone(owner_of(account)))).strftime("%H:%M")


# -- what happened ------------------------------------------------------------------------------------------

def log(entry: dict, account: Optional[str] = None) -> None:
    """One message or call a bot sent through Reach me: where it went and why others were skipped. Never its text."""
    account = account or accounts.effective_account()
    with _LOCK:
        data = load(account)
        data["log"] = (data["log"] + [{"at": time.time(), **entry}])[-KEEP_LOG:]
        _write(account, data)
