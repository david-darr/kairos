"""First-job suggestions and durable setup requests for blank bots."""
import asyncio
import copy
import importlib
import re
import time
import unicodedata
import uuid

from fastapi import HTTPException
from core.session_manager import session_manager
from core.untrusted import wrap_untrusted
from services import bot_attention, bot_chief, bot_departments as teams

FIXED = ["Research a new topic", "Watch for useful updates", "Organize mail and calendar",
         "Plan errands and bookings", "Check data and reports"]
_cache = {}
_tasks = {}
_DENIED = re.compile(r"\b(api|sdk|mcp|llm|oauth|diagnos\w*|medic\w*|health\w*|therap\w*|treat\w*|prescri\w*)\b", re.I)


def _path():
    return teams.root() / "setup-requests.json"


def _read():
    data = teams.load(_path(), {"version": 1, "requests": {}})
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("requests"), dict):
        raise HTTPException(503, "Setup requests could not be read")
    return data


def eligible(bot_id, user):
    bot = bot_attention.require_bot(bot_id, user)
    if ((bot.get("origin") or {}).get("kind") != "blank" or teams.service().setup_receipts(bot_id) or
            not teams.service().chat_endpoint(bot)):
        return False
    row = _read()["requests"].get(bot_id)
    if row and row.get("state") == "sent":
        return False
    for header in session_manager.list_sessions(agent_id=bot_id):
        if (header.get("thread") or {}).get("main"):
            session = session_manager.get_session(header["id"])
            if any(not m.get("display_only") for m in session.get("messages", [])):
                return False
    return True


def valid_choices(value):
    if isinstance(value, dict):
        value = value.get("suggestions")
    if not isinstance(value, list):
        return []
    found = []
    for text in value[:8]:
        if not isinstance(text, str):
            continue
        text = " ".join(text.split())
        if (not 3 <= len(text.split()) <= 5 or len(text) > 50 or _DENIED.search(text) or
                any(c.isdigit() or c in "@:/\\<>" or unicodedata.category(c).startswith("C") for c in text)):
            continue
        # These English suggestions must keep a Latin script. Mixed-script
        # spoofing and punctuation-only choices are discarded.
        letters = [c for c in text if c.isalpha()]
        if not letters or any("LATIN" not in unicodedata.name(c, "") for c in letters):
            continue
        if text.casefold() not in {x.casefold() for x in found}:
            found.append(text)
    return found if len(found) >= 3 else []


async def _personalize(bot_id, generator):
    started = time.monotonic()
    try:
        result = await asyncio.wait_for(generator(bot_id), 6)
        chosen = valid_choices(result)
        if chosen and time.monotonic() - started < 20:
            _cache[bot_id] = {"choices": chosen, "at": time.monotonic(), "pending": False}
    except (asyncio.TimeoutError, ValueError, TypeError):
        pass
    finally:
        if bot_id in _cache:
            _cache[bot_id]["pending"] = False
        _tasks.pop(bot_id, None)


def suggestions(bot_id, user, *, generator=None):
    if not eligible(bot_id, user):
        return {"eligible": False, "choices": [], "pending": False}
    now = time.monotonic()
    cached = _cache.get(bot_id)
    if cached and now - cached["at"] > 20:
        _cache.pop(bot_id, None)
        cached = None
    if not cached:
        cached = _cache[bot_id] = {"choices": FIXED[:], "at": now, "pending": False}
        if generator is not None:
            try:
                task = asyncio.get_running_loop().create_task(_personalize(bot_id, generator))
                _tasks[bot_id] = task
                cached["pending"] = True
            except RuntimeError:
                pass
    choices = [{"key": chr(65 + index), "text": text} for index, text in enumerate(cached["choices"])]
    return {"eligible": True, "choices": choices, "pending": cached["pending"] and now - cached["at"] < 8,
            "grace_seconds": 8, "stale_seconds": 20}


def request(bot_id, user):
    bot_attention.require_bot(bot_id, user)
    row = _read()["requests"].get(bot_id)
    mine = copy.deepcopy(row) if row and row.get("owner_user") == user else None
    shown = mine or {"state": "none"}
    # The card shows only while setup is still open: never after it was sent or the person closed it.
    shown["eligible"] = (shown["state"] not in ("sent", "closed")) and eligible(bot_id, user)
    return shown


async def pick(bot_id, thread_id, text, user):
    bot_attention.require_bot(bot_id, user)
    session = bot_attention.require_thread(thread_id, user)
    if session.get("agent_id") != bot_id or not (session.get("thread") or {}).get("main"):
        raise HTTPException(404, "Main conversation not found")
    if text is not None and (not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000):
        raise HTTPException(400, "Use a short description of the job")
    with teams.LOCK:
        data = _read()
        existing = data["requests"].get(bot_id)
        if existing and existing.get("state") == "sent" and existing.get("text") == text and existing.get("thread_id") == thread_id:
            return copy.deepcopy(existing)
        if not eligible(bot_id, user):
            raise HTTPException(409, "This bot is already set up")
        row = {"id": (existing or {}).get("id") or uuid.uuid4().hex, "bot_id": bot_id, "thread_id": thread_id,
               "owner_user": user, "text": text, "state": "armed" if text is None else "sending", "created_at": time.time()}
        data["requests"][bot_id] = row
        teams.save(_path(), data)
    if text is not None:
        from services import bot_chat_service
        result = await bot_chat_service.send(user, thread_id, {"send_id": "setup:" + row["id"],
                     "text": "/setup " + text.strip(), "expected_leaf_id": (session.get("thread") or {}).get("active_leaf_id")})
        with teams.LOCK:
            data = _read()
            row.update(state="sent", result=result)
            data["requests"][bot_id] = row
            teams.save(_path(), data)
    return copy.deepcopy(row)


def close(bot_id, user):
    bot_attention.require_bot(bot_id, user)
    with teams.LOCK:
        data = _read()
        row = data["requests"].get(bot_id)
        if row and row.get("owner_user") != user:
            raise HTTPException(404, "Setup request not found")
        if row:
            row["state"] = "closed"
        teams.save(_path(), data)
    return {"ok": True}


def brief(agent, job=""):
    from services.chat_service import BOT_SETUP_INSTRUCTIONS
    text = BOT_SETUP_INSTRUCTIONS
    if job:
        text += "\nThe person chose this first job:\n" + wrap_untrusted("setup job", job[:1000])
    if bot_chief.managed(agent["id"]):
        text += "\nA Chief keeps its Chief duties during setup."
    return text
