"""A bot's conversation list (Bots redesign, Phase 0 unit U1, 2026-10-28).

Threads are sessions (decision D8 stays): a session whose `agent_id` is the
bot. What a thread adds lives in the session document under `thread`, merged
with defaults on read, so an old session needs no write and the store needs
no new column. A bot's folders live on the bot record. Spec:
Kairos Projects/Agents Redesign/phase-0-design.md, sections 2.2 and 2.4.
"""
import threading
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Optional

from services import bot_record

THREAD_DEFAULTS = {
    "main": False, "folder_id": None, "pinned": False, "archived_at": None, "snoozed_until": None,
    "approval_mode": None, "place": None, "unread": False, "last_read_index": None,
    "pinned_message_index": None, "opened_by": "person", "routine_run_id": None, "title_source": "machine",
    "active_leaf_id": None, "last_read_message_id": None, "pinned_message_id": None,
    "branch_revision": 0, "queue_revision": 0, "queue_paused": False, "link": None,
}
OPENED_BY = ("person", "bot", "routine", "room", "handoff")
TITLE_SOURCES = ("machine", "person", "llm")
THREAD_APPROVAL_MODES = ("ask", "edits", "auto", "full", "custom")
SNOOZES = ("activity", "tonight", "tomorrow", "stop")
MAX_TITLE = 200
MAX_DELETE_BATCH = 200
_LOCK = threading.RLock()


def thread_view(session: Optional[dict]) -> dict:
    """The session's thread record with every default filled in. Takes a
    session document or a listing header (both carry `thread`)."""
    stored = (session or {}).get("thread")
    view = dict(THREAD_DEFAULTS)
    if isinstance(stored, dict):
        view.update({key: value for key, value in stored.items() if key in THREAD_DEFAULTS})
    return view


def follows_bot_model(session: dict, agent: dict) -> bool:
    """A thread follows its bot's model when it runs on the bot's connection
    and its own version and effort are either unset (inherited at the turn,
    services/chat_service.py) or equal to the bot's."""
    from services.agent_service import agent_service
    if session.get("model_endpoint_id") != agent_service.chat_endpoint(agent):
        return False
    override, effort = session.get("model_override"), session.get("model_effort")
    return (override is None or override == agent.get("model_override")) and \
           (effort is None or effort == agent.get("model_effort"))


def _preview(session: dict) -> str:
    from core.bot_message_tree import ancestry
    for message in reversed(ancestry(session)):
        if message.get("role") in ("user", "assistant") and message.get("content"):
            return " ".join(str(message["content"]).split())[:240]
    return ""


def _row(session: dict, agent: dict) -> dict:
    from services import chat_live
    return {"id": session["id"], "title": session.get("title") or "", "created_at": session.get("created_at"),
            "updated_at": session.get("updated_at"),
            "message_count": len([m for m in session.get("messages") or [] if m.get("role") in ("user", "assistant")]),
            "model_endpoint_id": session.get("model_endpoint_id"), "model_override": session.get("model_override"),
            "model_effort": session.get("model_effort"), "follows_bot_model": follows_bot_model(session, agent),
            "thread": thread_view(session),
            "status": "working" if chat_live.is_processing(session["id"]) else "idle",
            "preview": _preview(session)}


def owned_session(agent_id: str, session_id: str) -> dict:
    """The thread's session, or KeyError (a 404) when it is not this bot's."""
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id)
    if session is None or session.get("agent_id") != agent_id:
        raise KeyError(session_id)
    return session


# -- the main thread ------------------------------------------------------------

def claim_main_if_none(session_id: str, agent_id: str) -> Optional[dict]:
    """Flag this chat as the bot's main thread unless it already has one.
    Returns the updated session, or None when nothing changed."""
    from core.session_manager import session_manager
    with _LOCK:
        if any((h.get("thread") or {}).get("main") for h in session_manager.list_sessions(agent_id=agent_id)
               if h["id"] != session_id):
            return None
        return session_manager.set_thread(session_id, main=True)


def ensure_main_threads(agent_id: Optional[str] = None) -> dict:
    """Give every bot (or one) exactly one main thread: the oldest
    conversation with the person that is not archived. A bot with several
    flags keeps its oldest; a bot with no chats gets its main on first chat.
    Idempotent. Returns {bot id: main thread id or None}."""
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    result = {}
    with _LOCK:
        for agent in ([agent_service.get(agent_id)] if agent_id else agent_service.list_agents()):
            if agent is None:
                continue
            headers = sorted((h for h in session_manager.list_sessions(agent_id=agent["id"])
                              if thread_view(h)["opened_by"] != "room"),  # a room seat is never a conversation of its own
                             key=lambda h: (h.get("created_at") or 0, h["id"]))
            flagged = [h for h in headers if (h.get("thread") or {}).get("main")]
            main = flagged[0]["id"] if flagged else None
            for extra in flagged[1:]:
                session_manager.set_thread(extra["id"], main=False)
            if main is None:
                for header in headers:
                    if thread_view(header)["archived_at"]:
                        continue
                    session = session_manager.get_session(header["id"]) or {}
                    if session.get("agent_unattended"):
                        continue  # a thread the bot works in alone is not the person's conversation
                    session_manager.set_thread(header["id"], main=True)
                    main = header["id"]
                    break
            result[agent["id"]] = main
    return result


# -- listing and creating -------------------------------------------------------

def list_threads(agent: dict, include_archived: bool = False) -> dict:
    from core.session_manager import session_manager
    main_id = ensure_main_threads(agent["id"]).get(agent["id"])
    rows = []
    for header in session_manager.list_sessions(agent_id=agent["id"]):
        if thread_view(header)["opened_by"] == "room":
            continue  # a room seat belongs to the room, not to the bot's thread list
        if thread_view(header)["archived_at"] and not include_archived:
            continue
        session = session_manager.get_session(header["id"])
        if session is not None:
            rows.append(_row(session, agent))
    return {"main_id": main_id, "threads": rows}


def _clean_title(value) -> str:
    title = " ".join(value.split()) if isinstance(value, str) else ""
    if not 1 <= len(title) <= MAX_TITLE:
        raise ValueError(f"a title is 1 to {MAX_TITLE} characters")
    return title


def _folder(agent: dict, folder_id) -> Optional[str]:
    if folder_id in (None, ""):
        return None
    if not any(f["id"] == folder_id for f in agent.get("folders") or []):
        raise ValueError("that folder does not exist")
    return folder_id


def create_thread(agent: dict, user: str, title: Optional[str] = None, folder_id: Optional[str] = None,
                  approval_mode: Optional[str] = None) -> dict:
    """A new chat with the bot: its model, its identity and notes frozen in,
    and the main thread if it has none yet."""
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    endpoint_id = agent_service.chat_endpoint(agent)
    if endpoint_id is None:
        raise ValueError("add a Claude connection in Settings, or pick this bot's model")
    titled = _clean_title(title) if title else None
    folder = _folder(agent, folder_id)
    mode = bot_record.check_approval(approval_mode, "thread approval_mode", THREAD_APPROVAL_MODES) \
        if approval_mode is not None else None
    session = session_manager.create_session(titled or "New Chat", owner_user=user)
    session_manager.set_model_endpoint(session["id"], endpoint_id)
    agent_service.make_agent_chat(session["id"], agent)
    session = session_manager.set_thread(session["id"], folder_id=folder, approval_mode=mode, opened_by="person",
                                         title_source="person" if titled else "machine")
    return {**session, "thread": thread_view(session)}


# -- changing one thread --------------------------------------------------------

def snooze_until(value, now: Optional[float] = None, timezone: Optional[str] = None) -> Optional[float]:
    """"activity" -> 0 (until new activity), "stop" -> None, "tonight" ->
    18:00 in the person's timezone, "tomorrow" -> 09:00
    tomorrow, a number -> that unix time."""
    now = time.time() if now is None else now
    if value == "activity":
        return 0
    if value == "stop":
        return None
    if value in ("tonight", "tomorrow"):
        try:
            zone = ZoneInfo(timezone) if timezone else None
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone")
        moment = datetime.fromtimestamp(now, zone)
        if value == "tonight":
            target = moment.replace(hour=18, minute=0, second=0, microsecond=0)
            if target.timestamp() <= now:
                target += timedelta(days=1)
        else:
            target = (moment + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
        return target.timestamp()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return float(value)
    raise ValueError("snooze is activity, tonight, tomorrow, stop or a unix time")


def update_thread(agent: dict, session_id: str, fields: dict) -> dict:
    """Apply a PATCH (only the keys present) and return the thread's list row."""
    from core.session_manager import session_manager
    session = owned_session(agent["id"], session_id)
    changes = {}
    rename = None
    for key, value in fields.items():
        if key == "title":
            rename = _clean_title(value)
            changes["title_source"] = "person"
        elif key == "folder_id":
            changes["folder_id"] = _folder(agent, value)
        elif key in ("pinned", "unread"):
            if not isinstance(value, bool):
                raise ValueError(f"{key} is true or false")
            changes[key] = value
        elif key == "archived":
            if not isinstance(value, bool):
                raise ValueError("archived is true or false")
            if value and thread_view(session)["main"]:
                raise bot_record.BotConflict("this is the main conversation; make another one the main first")
            changes["archived_at"] = time.time() if value else None
        elif key == "snooze":
            changes["snoozed_until"] = snooze_until(value, timezone=fields.get("timezone"))
        elif key == "timezone":
            if not isinstance(value, str) or len(value) > 100:
                raise ValueError("Choose a valid IANA timezone")
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("Choose a valid IANA timezone")
        elif key == "main":
            if value is not True:
                raise ValueError("Promote another conversation to change the main conversation")
            with _LOCK:
                for header in session_manager.list_sessions(agent_id=agent["id"]):
                    session_manager.set_thread(header["id"], main=header["id"] == session_id)
            changes.update(main=True, archived_at=None)
        elif key == "link":
            from urllib.parse import urlsplit
            if value is not None and (not isinstance(value, str) or len(value) > 2000 or
                                      any(ord(c) < 32 for c in value) or
                                      urlsplit(value).scheme != "https" or not urlsplit(value).hostname or
                                      urlsplit(value).username or urlsplit(value).password):
                raise ValueError("Use an https link without credentials")
            changes["link"] = value
        elif key == "approval_mode":
            changes["approval_mode"] = None if value is None else bot_record.check_approval(
                value, "thread approval_mode", THREAD_APPROVAL_MODES)
        elif key == "place":
            if value is not None and value not in bot_record.PLACES:
                raise ValueError(f"place must be one of: {', '.join(bot_record.PLACES)}")
            changes["place"] = value
        else:
            raise ValueError(f"{key} cannot be changed")
    if rename is not None:
        session_manager.rename_session(session_id, rename)
    if "approval_mode" in changes:
        from core import bot_policy
        bot_policy.change_mode(agent["id"], changes.pop("approval_mode"), scope="thread", thread_id=session_id,
                               user=session.get("owner_user"))
    if changes:
        session_manager.set_thread(session_id, **changes)
    return _row(session_manager.get_session(session_id), agent)


async def delete_threads(agent: dict, thread_ids: list) -> dict:
    """Delete some of the bot's threads. Busy ones (a turn running or an
    operation under way) stay; unknown ones are reported; the bot is never
    left with no thread, so if everything it has was asked for, one stays
    (its main, else the newest) and is listed under `kept`."""
    from core import computer, notch_folders
    from core.session_manager import session_manager
    from fastapi import HTTPException
    from services import chat_live, chat_service
    ids = list(dict.fromkeys(thread_ids))
    headers = {h["id"]: h for h in session_manager.list_sessions(agent_id=agent["id"])}
    missing = [i for i in ids if i not in headers]
    present = [i for i in ids if i in headers]
    busy = [i for i in present if chat_live.is_processing(i)]
    doomed = [i for i in present if i not in busy]
    kept = []
    if doomed and not (set(headers) - set(doomed)):
        keep = next((i for i in doomed if thread_view(headers[i])["main"]), None) or \
            max(doomed, key=lambda i: headers[i].get("updated_at") or 0)
        doomed.remove(keep)
        kept.append(keep)
    deleted = []
    for session_id in doomed:
        try:
            chat_service.claim_session(session_id)
        except HTTPException:
            busy.append(session_id)
            continue
        try:
            await computer.stop(f"chat:{session_id}")
            await chat_service.close_session_brain(session_id)
            session_manager.delete_session(session_id)
            notch_folders.forget_session(session_id)
            deleted.append(session_id)
        finally:
            chat_service.release_session(session_id)
    if deleted:
        ensure_main_threads(agent["id"])
    return {"deleted": deleted, "busy": busy, "missing": missing, "kept": kept}


async def follow_model(agent: dict) -> dict:
    """Put every thread back on the bot's own model ("switch them too").
    Threads with a turn running are left and reported."""
    from fastapi import HTTPException
    from core.session_manager import session_manager
    from services import chat_live, chat_service
    from services.agent_service import agent_service
    endpoint_id = agent_service.chat_endpoint(agent)
    if endpoint_id is None:
        raise ValueError("add a Claude connection in Settings, or pick this bot's model")
    updated, busy = [], []
    for header in session_manager.list_sessions(agent_id=agent["id"]):
        session = session_manager.get_session(header["id"])
        if session is None or follows_bot_model(session, agent):
            continue
        if chat_live.is_processing(header["id"]):
            busy.append(header["id"])
            continue
        try:
            chat_service.claim_session(header["id"])
        except HTTPException:
            busy.append(header["id"])
            continue
        try:
            await chat_service.close_session_brain(header["id"])
            session_manager.set_model_endpoint(header["id"], endpoint_id, None, None)
            updated.append(header["id"])
        finally:
            chat_service.release_session(header["id"])
    return {"updated": updated, "busy": busy}


# -- folders (kept on the bot) --------------------------------------------------

def _clean_folder_name(value) -> str:
    name = " ".join(value.split()) if isinstance(value, str) else ""
    if not 1 <= len(name) <= 80:
        raise ValueError("a folder's name is 1 to 80 characters")
    return name


def _clean_emoji(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value.strip()) > 8:
        raise ValueError("a folder's emoji is up to 8 characters")
    return value.strip()


def _folders(agent: dict) -> list:
    return sorted(agent.get("folders") or [], key=lambda f: f.get("order", 0))


def add_folder(agent_id: str, name, emoji=None) -> dict:
    from services.agent_service import agent_service
    name, emoji = _clean_folder_name(name), _clean_emoji(emoji)
    made = {}

    def change(agent):
        folders = agent.setdefault("folders", [])
        if len(folders) >= bot_record.MAX_FOLDERS:
            raise bot_record.BotConflict(f"a bot can have up to {bot_record.MAX_FOLDERS} folders")
        made.update({"id": uuid.uuid4().hex[:10], "name": name, "emoji": emoji,
                     "order": max((f.get("order", 0) for f in folders), default=-1) + 1})
        folders.append(dict(made))

    agent_service.mutate_bot(agent_id, change)
    return made


def update_folder(agent_id: str, folder_id: str, fields: dict) -> dict:
    from services.agent_service import agent_service
    cleaned = {}
    if "name" in fields:
        cleaned["name"] = _clean_folder_name(fields["name"])
    if "emoji" in fields:
        cleaned["emoji"] = _clean_emoji(fields["emoji"])
    found = {}

    def change(agent):
        folder = next((f for f in agent.get("folders") or [] if f["id"] == folder_id), None)
        if folder is None:
            raise KeyError(folder_id)
        folder.update(cleaned)
        found.update(folder)

    agent_service.mutate_bot(agent_id, change)
    return found


def delete_folder(agent_id: str, folder_id: str) -> dict:
    """Remove the folder; its threads go back to the bot's main list."""
    from core.session_manager import session_manager
    from services.agent_service import agent_service

    def change(agent):
        folders = agent.get("folders") or []
        if not any(f["id"] == folder_id for f in folders):
            raise KeyError(folder_id)
        agent["folders"] = [f for f in folders if f["id"] != folder_id]

    agent_service.mutate_bot(agent_id, change)
    cleared = 0
    for header in session_manager.list_sessions(agent_id=agent_id):
        if thread_view(header)["folder_id"] == folder_id:
            session_manager.set_thread(header["id"], folder_id=None)
            cleared += 1
    return {"ok": True, "cleared": cleared}


def order_folders(agent_id: str, ids: list) -> list:
    """The listed folders first, in that order, then any others as they stand."""
    from services.agent_service import agent_service

    def change(agent):
        folders = {f["id"]: f for f in agent.get("folders") or []}
        if len(ids) != len(set(ids)) or any(i not in folders for i in ids):
            raise ValueError("list each of this bot's folders at most once")
        rest = [f["id"] for f in sorted(folders.values(), key=lambda f: f.get("order", 0)) if f["id"] not in ids]
        for position, folder_id in enumerate([*ids, *rest]):
            folders[folder_id]["order"] = position

    return _folders(agent_service.mutate_bot(agent_id, change))
