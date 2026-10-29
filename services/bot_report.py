"""Problem reports (Bots Phase 6, F101): a redacted Markdown draft of what went wrong, kept on this machine only.

Nothing is ever sent anywhere. The person writes what went wrong, what they saw and the steps; the draft adds the
message it is about, the app version, the platform, the last 300 backend log lines and each bot's engine health
(bot names only, never their instructions). Every part passes core.logs.scrub_credentials and the package secret
patterns (services/bot_package.redact). One report per message: drafting the same message again returns the first
("already"). Drafts live in <data>/bot_reports/<id>.md and are removed after 30 days.
"""
import json
import os
import platform
import re
import threading
import time
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

ROOT = os.path.join(DATA_DIR, "bot_reports")
INDEX = os.path.join(ROOT, "index.json")
LIMITS = {"went_wrong": 2000, "you_saw": 3000, "steps": 2000}
MESSAGE_CHARS = 2000
LOG_LINES = 300
KEEP_SECONDS = 30 * 86400
ID = re.compile(r"^[a-f0-9]{32}$")
_LOCK = threading.Lock()


def _clean(text: str) -> str:
    from core.logs import scrub_credentials
    from services.bot_package import redact
    return redact(scrub_credentials(str(text or "")))


def _text(value, field: str, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > LIMITS[field] or (required and not value.strip()):
        raise HTTPException(400, "Say what went wrong, in up to 2,000 characters." if field == "went_wrong"
                            else f"Keep {field.replace('_', ' ')} to {LIMITS[field]:,} characters.")
    return value.strip()


def _version() -> str:
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "electron", "package.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return str(json.load(handle).get("version") or "unknown")
    except (OSError, ValueError):
        return "unknown"


def _logs() -> list[str]:
    from core import logs
    try:
        return logs._read_last_lines(os.path.join(DATA_DIR, "logs", logs.LOG_FILES["backend"]), LOG_LINES)
    except OSError:
        return []


def _health(user: str) -> list[str]:
    """One line per bot this person can see: its name and which engine it would use, never its instructions."""
    from services.agent_service import agent_service
    from services.bot_attention import owner_of
    lines = []
    for bot in agent_service.list_agents():
        if owner_of(bot) and owner_of(bot) != user:
            continue
        endpoint = agent_service.chat_endpoint(bot)  # the endpoint id it would use, or None
        engine = f"engine {endpoint}" if endpoint else "no engine chosen"
        state = "archived" if bot.get("hidden") else "off" if bot.get("enabled") is False else "on"
        lines.append(f"- {bot.get('name')}: {state}, {engine}")
    return lines


def _message(user: str, session_id: str, message_id: str) -> tuple[dict, str]:
    """The bot and the message the report is about, from a conversation the person owns."""
    from services.agent_service import agent_service
    from services.bot_attention import require_thread
    session = require_thread(session_id, user)
    message = next((m for m in session.get("messages", []) if (m.get("bot_message_id") or m.get("id")) == message_id), None)
    if message is None:
        raise HTTPException(404, "Message not found")
    return agent_service.get(session["agent_id"]) or {}, str(message.get("content") or "")[:MESSAGE_CHARS]


def _index() -> dict:
    value = read_json(INDEX, {})
    return value if isinstance(value, dict) else {}


def _prune(index: dict, now: float) -> None:
    for key, row in list(index.items()):
        if now - float(row.get("created_at") or 0) > KEEP_SECONDS:
            try:
                os.remove(os.path.join(ROOT, row["id"] + ".md"))
            except OSError:
                pass
            del index[key]


def _view(row: dict, already: bool) -> dict:
    path = os.path.join(ROOT, row["id"] + ".md")
    with open(path, encoding="utf-8") as handle:
        markdown = handle.read()
    return {"id": row["id"], "path": path, "folder": ROOT, "markdown": markdown, "created_at": row["created_at"], "already": already}


def draft(user: str, *, session_id: str, message_id: str, went_wrong: str, you_saw: str = "", steps: str = "",
          now: float | None = None) -> dict:
    went_wrong = _text(went_wrong, "went_wrong", required=True)
    you_saw, steps = _text(you_saw, "you_saw"), _text(steps, "steps")
    bot, message = _message(user, session_id, message_id)
    now = time.time() if now is None else now
    key = f"{user}\n{session_id}\n{message_id}"
    with _LOCK:
        os.makedirs(ROOT, exist_ok=True)
        index = _index()
        _prune(index, now)
        earlier = index.get(key)
        if earlier and os.path.exists(os.path.join(ROOT, earlier["id"] + ".md")):
            write_json_atomic(INDEX, index)
            return _view(earlier, already=True)
        ident = uuid.uuid4().hex
        when = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        logs = _logs()
        body = "\n".join([
            "# Kairos problem report", "",
            f"Drafted {when}. Kept on this computer only; nothing was sent. Secrets were removed, but read it before sharing.", "",
            "## What went wrong", "", _clean(went_wrong), "",
            "## What you saw", "", _clean(you_saw) or "Not given.", "",
            "## Steps", "", _clean(steps) or "Not given.", "",
            "## The message", "", f"From {_clean(bot.get('name') or 'a bot')}:", "", "```", _clean(message).replace("```", "'''"), "```", "",
            "## This computer", "", f"- Kairos {_version()}", f"- {platform.system()} {platform.release()} ({platform.machine()})",
            f"- Python {platform.python_version()}", "",
            "## Bots", "", *(_clean(line) for line in _health(user)), "",
            f"## Recent log ({len(logs)} lines)", "", "```", *(_clean(line.rstrip("\n")).replace("```", "'''") for line in logs), "```", "",
        ])
        with open(os.path.join(ROOT, ident + ".md"), "w", encoding="utf-8") as handle:
            handle.write(body)
        row = {"id": ident, "owner_user": user, "session_id": session_id, "message_id": message_id, "created_at": now}
        index[key] = row
        write_json_atomic(INDEX, index)
        return _view(row, already=False)


def get(user: str, ident: str) -> dict:
    if not ID.match(ident or ""):
        raise HTTPException(404, "Report not found")
    with _LOCK:
        row = next((r for r in _index().values() if r["id"] == ident and r.get("owner_user") == user), None)
        if not row or not os.path.exists(os.path.join(ROOT, ident + ".md")):
            raise HTTPException(404, "Report not found")
        return _view(row, already=True)
