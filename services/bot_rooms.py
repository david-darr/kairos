"""Rooms: a few bots and a person talking in one place (Phase 4, unit U2).

This is the room's record and its rules: create, change, delete, members,
threads, the transcript, who may speak, and how work from other parts of the
app lands in a room. Taking a turn is services/bot_room_turns.py.

Rules this file keeps:
- A room needs at least one member, and members are visible bots.
- Member changes, deletion and deleting a thread are refused while the room is
  working or a teammate is waiting on a card, so nothing is cut off mid-turn.
- Each member speaks through a private "seat" session (an ordinary bot session
  opened by `room`, unattended). It keeps the bot's brain, tools, model and
  memory prompt. The transcript the person reads lives in the rooms store, so
  a seat never shows up in the bot's thread list or as its main thread.
- `can_speak` is the one verdict for "may this bot write in this room": it is
  a member, the room is open and its setup is done.
- Owner identity comes from the caller (the signed-in person), never a field.
"""
import logging
import os
import re
import time

from fastapi import HTTPException

from core import bot_rooms_store as store
from services import bot_room_events as feed

logger = logging.getLogger(__name__)

MAX_MEMBERS = 20
NAME_MAX, CONTEXT_MAX, DESCRIPTION_MAX, BULLETIN_MAX = 100, 60, 120, 12000
TIMEOUT_RANGE = (1, 1440)
PAGE_DEFAULT, PAGE_MAX = 50, 200
BULK_DELETE_MAX = 500
RESPONDER_KINDS = ("everyone", "mentions", "member", "auto")
WEBHOOK_TEXT_MAX, WEBHOOK_IMAGES_MAX, WEBHOOK_IMAGE_BYTES = 20_000, 4, 10 * 1024 * 1024
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_connected = False


class Speak:
    """The answer to "may this bot write here". Truthy when yes."""

    def __init__(self, ok: bool, reason: str = ""):
        self.ok, self.reason = ok, reason

    def __bool__(self) -> bool:
        return self.ok

    def __repr__(self) -> str:
        return f"Speak(ok={self.ok}, reason={self.reason!r})"


# -- small helpers ---------------------------------------------------------------

def _agents():
    from services.agent_service import agent_service
    return agent_service


def _clean(value, limit: int, field: str, *, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise HTTPException(422, f"{field} must be text")
    value = _CONTROL.sub("", value).strip()
    if required and not value:
        raise HTTPException(422, f"{field} is needed")
    if len(value) > limit:
        raise HTTPException(422, f"{field} is at most {limit} characters")
    return value


def get(room_id: str, owner: str | None = None) -> dict:
    """The room, or a 404. Another person's room is also a 404."""
    room = store.get_room(room_id)
    if room is None or (owner is not None and room["owner"] != owner):
        raise HTTPException(404, "room not found")
    return room


def _visible_bot(bot_id) -> dict:
    bot = _agents().get(bot_id) if isinstance(bot_id, str) else None
    if bot is None:
        raise HTTPException(422, "One of the bots no longer exists")
    if bot.get("hidden"):
        raise HTTPException(422, f"{bot['name']} is hidden and cannot join a room")
    return bot


def _member_ids(ids, *, existing: list[str] | None = None) -> list[str]:
    if not isinstance(ids, list) or not ids:
        raise HTTPException(422, "A room needs at least one bot")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_MEMBERS:
        raise HTTPException(422, f"A room holds at most {MAX_MEMBERS} bots")
    for bot_id in ids:
        if existing and bot_id in existing:
            continue  # an existing member stays even if it was hidden since
        _visible_bot(bot_id)
    return ids


def decider_available() -> bool:
    """Whether the room can pick who answers by asking a model (a side job)."""
    try:
        from services import bot_side_jobs
        return callable(getattr(bot_side_jobs, "generate", None))
    except Exception:
        return False


def default_responder_for_new() -> dict:
    return {"kind": "auto"} if decider_available() else {"kind": "mentions"}


def validate_responder(value, member_ids: list[str]) -> dict:
    if not isinstance(value, dict) or value.get("kind") not in RESPONDER_KINDS:
        raise HTTPException(422, "Choose who answers by default: everyone, mentions, one bot or auto")
    kind = value["kind"]
    if kind == "member":
        if value.get("bot_id") not in member_ids:
            raise HTTPException(422, "The bot that answers by default must be in the room")
        return {"kind": "member", "bot_id": value["bot_id"]}
    if kind == "auto":
        fallback = value.get("fallback_bot_id")
        if fallback is not None and fallback not in member_ids:
            raise HTTPException(422, "The fallback bot must be in the room")
        return {"kind": "auto", **({"fallback_bot_id": fallback} if fallback else {})}
    return {"kind": kind}


def _timeout(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not TIMEOUT_RANGE[0] <= value <= TIMEOUT_RANGE[1]:
        raise HTTPException(422, f"The turn limit is {TIMEOUT_RANGE[0]} to {TIMEOUT_RANGE[1]} minutes")
    return value


def _cwd(value) -> str | None:
    """The room's working folder, vetted like a chat's workspace (core/workspace.py): an existing folder
    that is not sensitive. None clears it."""
    if value in (None, ""):
        return None
    from core import workspace
    path = workspace.vet_workspace(value) if isinstance(value, str) else None
    if path is None:
        raise HTTPException(422, "That is not a usable working folder")
    return path


def _turns():
    from services import bot_room_turns
    return bot_room_turns


def connect() -> None:
    """Wire this module into the rest of the app, once: assignment results land in a lane's room,
    and a deleted bot leaves its rooms. Missing pieces are skipped; they arrive from other units."""
    global _connected
    if _connected:
        return
    _connected = True
    try:
        from services import bot_assignments
        if callable(getattr(bot_assignments, "register_sink", None)):
            bot_assignments.register_sink("room", post_report)
    except Exception:
        logger.debug("assignment sink not available yet", exc_info=True)
    service = _agents()
    hook = getattr(service, "on_delete", None)
    if callable(hook):
        try:
            hook(bot_deleted)
        except Exception:
            logger.exception("could not register the bot delete hook")


# -- the room's public shape -----------------------------------------------------

def member_views(room_id: str) -> list[dict]:
    running = _turns().running_bots(room_id)
    waiting = _turns().waiting_bots(room_id)
    rows = []
    for item in store.members(room_id):
        bot = _agents().get(item["bot_id"])
        if bot is None:
            continue
        rows.append({"bot_id": item["bot_id"], "name": bot["name"], "held": bool(item["held_at"]),
                     "working": item["bot_id"] in running, "waiting": item["bot_id"] in waiting,
                     "seat_session_id": item["seat_session_id"], "last_seen_seq": item["last_seen_seq"]})
    return rows


def public(room: dict) -> dict:
    turns = _turns()
    return {"id": room["id"], "name": room["name"], "context": room["context"], "description": room["description"],
            "bulletin": room["bulletin"], "cwd": room["cwd"], "default_responder": room["default_responder"],
            "turn_timeout_minutes": room["turn_timeout_minutes"], "setup_state": room["setup_state"],
            "pinned_message_id": room["pinned_message_id"], "revision": room["revision"],
            "created_at": room["created_at"], "archived_at": room["archived_at"],
            "members": member_views(room["id"]), "working": turns.is_working(room["id"]),
            "unread": store.unread_count(room["id"]), "last_seq": store.last_seq(room["id"]),
            "threads": [{"id": t["id"], "title": t["title"], "goal": t["goal"]} for t in store.threads(room["id"])]}


def message_view(message: dict) -> dict:
    return {key: message[key] for key in ("id", "room_id", "thread_id", "seq", "role", "bot_id", "text", "kind",
                                          "reply_to_id", "send_id", "run_id", "turn_id", "meta", "created_at")}


def announce(room_id: str) -> None:
    room = store.get_room(room_id)
    if room is not None:
        feed.publish("room", room_id, {"room": public(room)}, room["owner"])


# -- create, change, delete ------------------------------------------------------

def create(owner: str, name, *, bot_ids, context="", description="", default_responder=None,
           turn_timeout_minutes: int = 5, cwd=None, bulletin="", setup_done: bool = False) -> dict:
    connect()
    ids = _member_ids(bot_ids)
    responder = validate_responder(default_responder, ids) if default_responder else default_responder_for_new()
    room = store.create_room(owner, _clean(name, NAME_MAX, "The name", required=True),
                             context=_clean(context, CONTEXT_MAX, "The context"),
                             description=_clean(description, DESCRIPTION_MAX, "The description"),
                             bulletin=_clean(bulletin, BULLETIN_MAX, "The instructions"), cwd=_cwd(cwd),
                             default_responder=responder, turn_timeout_minutes=_timeout(turn_timeout_minutes),
                             setup_state="done" if setup_done else "pending", member_ids=ids)
    announce(room["id"])
    return public(room)


def _blocked_by_work(room_id: str, what: str) -> None:
    turns = _turns()
    if turns.is_working(room_id) or turns.waiting_bots(room_id):
        raise HTTPException(409, f"This room is working or waiting on a card. Try {what} when it is idle.")


def update(owner: str, room_id: str, fields: dict, expected_revision: int | None = None) -> dict:
    room = get(room_id, owner)
    changes: dict = {}
    current = [m["bot_id"] for m in store.members(room_id)]
    new_members = None
    if "member_ids" in fields:
        new_members = _member_ids(fields["member_ids"], existing=current)
        if set(new_members) != set(current) or new_members != current:
            if set(new_members) != set(current):
                _blocked_by_work(room_id, "changing who is in it")
                for gone in set(current) - set(new_members):
                    if _lead_in_use(room_id, gone):
                        raise HTTPException(409, f"{(_agents().get(gone) or {}).get('name', 'That bot')} leads a team goal "
                                                 "here. Change the goal first.")
    if "name" in fields:
        changes["name"] = _clean(fields["name"], NAME_MAX, "The name", required=True)
    for key, limit, label in (("context", CONTEXT_MAX, "The context"), ("description", DESCRIPTION_MAX, "The description"),
                              ("bulletin", BULLETIN_MAX, "The instructions")):
        if key in fields:
            changes[key] = _clean(fields[key], limit, label)
    if "cwd" in fields:
        changes["cwd"] = _cwd(fields["cwd"])
    if "turn_timeout_minutes" in fields:
        changes["turn_timeout_minutes"] = _timeout(fields["turn_timeout_minutes"])
    if "pinned_message_id" in fields:
        pinned = fields["pinned_message_id"]
        if pinned is not None and store.get_message(room_id, pinned) is None:
            raise HTTPException(404, "message not found")
        changes["pinned_message_id"] = pinned
    final_members = new_members or current
    if "default_responder" in fields:
        changes["default_responder"] = validate_responder(fields["default_responder"], final_members)
    elif new_members is not None:
        stored = room["default_responder"] or {}
        try:
            validate_responder(stored, final_members)
        except HTTPException:
            changes["default_responder"] = {"kind": "mentions"}
    try:
        if changes:
            store.update_room(room_id, changes, expected_revision)
        elif expected_revision is not None and room["revision"] != expected_revision:
            raise store.Stale("The room changed. Reload and try again.")
        if new_members is not None and (set(new_members) != set(current) or new_members != current):
            seats = {m["bot_id"]: m["seat_session_id"] for m in store.members(room_id)}
            store.set_members(room_id, new_members)
            for bot_id in set(current) - set(new_members):
                _drop_seat(room_id, bot_id, seats.get(bot_id))
    except store.Stale as error:
        raise HTTPException(409, str(error))
    if "cwd" in changes:
        _sync_seat_folders(room_id, changes["cwd"])
    announce(room_id)
    return public(store.get_room(room_id))


def _sync_seat_folders(room_id: str, cwd: str | None) -> None:
    """A new working folder reaches the seats that already exist (a busy seat gets it at its next turn)."""
    from core.session_manager import session_manager
    from services import chat_service
    for item in store.members(room_id):
        seat = item["seat_session_id"]
        if seat and not chat_service.is_busy(seat) and session_manager.get_session(seat) is not None:
            try:
                session_manager.set_workspace(seat, cwd)
            except Exception:
                logger.exception("could not move the seat %s to the room's folder", seat)


def _lead_in_use(room_id: str, bot_id: str) -> bool:
    from services import bot_room_goals
    return bot_room_goals.lead_in_use(room_id, bot_id)


def _drop_seat(room_id: str, bot_id: str, seat: str | None = None) -> None:
    """Remove a seat session, unless it is in use (then it is left for the next cleanup)."""
    if not seat:
        return
    from core.session_manager import session_manager
    from services import chat_service
    if chat_service.is_busy(seat):
        return
    try:
        if session_manager.get_session(seat) is not None:
            session_manager.delete_session(seat)
    except Exception:
        logger.exception("could not remove the seat %s", seat)


def delete(owner: str, room_id: str) -> dict:
    get(room_id, owner)
    if _turns().is_working(room_id):
        raise HTTPException(409, "This room is working. Stop it first, or wait for it to finish.")
    seats = [m["seat_session_id"] for m in store.members(room_id) if m["seat_session_id"]]
    _disable_routines(room_id)
    store.delete_room(room_id)
    _turns().forget_room(room_id)
    from services import bot_room_goals
    bot_room_goals.forget_room(room_id)
    for seat in seats:
        _drop_seat(room_id, "", seat)
    feed.publish("room.deleted", room_id, {}, owner)
    return {"deleted": True, "id": room_id}


def _disable_routines(room_id: str) -> None:
    """A deleted room stops everything aimed at it: its webhook triggers and its team-goal routines."""
    try:
        from services.trigger_service import trigger_service
        for trigger in trigger_service.triggers():
            if trigger.get("room_id") == room_id and trigger.get("enabled"):
                trigger["enabled"] = False
                trigger_service._save()
    except Exception:
        logger.exception("could not disable the triggers of room %s", room_id)
    try:
        from services import bot_room_goals, bot_routines
        owner = (store.get_room(room_id) or {}).get("owner")
        for routine_id in bot_room_goals.routine_ids_for_room(room_id):
            try:
                bot_routines.patch(owner, True, routine_id, {"enabled": False})  # Phase 3's own switch, so Undo and history stay true
            except Exception:
                logger.exception("could not switch off routine %s", routine_id)
    except ImportError:
        pass  # routines arrive with Phase 3
    except Exception:
        logger.exception("could not disable the routines of room %s", room_id)


def bot_deleted(bot_id: str) -> None:
    """A bot was deleted: it leaves every room it was in; a room left empty is archived."""
    for room_id in store.rooms_of_bot(bot_id):
        item = store.member(room_id, bot_id)
        seat = item["seat_session_id"] if item else None
        remaining = [m["bot_id"] for m in store.members(room_id) if m["bot_id"] != bot_id]
        store.set_members(room_id, remaining)
        _drop_seat(room_id, bot_id, seat)
        room = store.get_room(room_id)
        if not remaining and room and not room["archived_at"]:
            store.update_room(room_id, {"archived_at": time.time()})
        elif room and (room["default_responder"] or {}).get("bot_id") == bot_id:
            store.update_room(room_id, {"default_responder": {"kind": "mentions"}})
        announce(room_id)


def list_rooms(owner: str, include_archived: bool = False) -> list[dict]:
    return [public(r) for r in store.list_rooms(owner, include_archived)]


def setup(owner: str, room_id: str, action: str, *, cwd="__keep__", bulletin=None, default_responder=None) -> dict:
    room = get(room_id, owner)
    if action not in ("complete", "skip"):
        raise HTTPException(422, "Setup is complete or skip")
    changes: dict = {"setup_state": "done" if action == "complete" else "skipped"}
    members = [m["bot_id"] for m in store.members(room_id)]
    if action == "complete":
        if cwd != "__keep__":
            changes["cwd"] = _cwd(cwd)
        if bulletin is not None:
            changes["bulletin"] = _clean(bulletin, BULLETIN_MAX, "The instructions")
        if default_responder is not None:
            changes["default_responder"] = validate_responder(default_responder, members)
    store.update_room(room_id, changes)
    announce(room_id)
    return public(store.get_room(room_id))


def mark_read(owner: str, room_id: str, seq: int | None = None) -> dict:
    get(room_id, owner)
    store.update_room(room_id, {"last_read_seq": store.last_seq(room_id) if seq is None else int(seq)})
    announce(room_id)
    return {"unread": store.unread_count(room_id)}


# -- who may speak ---------------------------------------------------------------

def can_speak(bot_id: str, room_id: str) -> Speak:
    """Member, room open, setup done. The one check `post_to_room` and lane delivery use."""
    room = store.get_room(room_id)
    if room is None or room["archived_at"]:
        return Speak(False, "That room is not open.")
    if store.member(room_id, bot_id) is None:
        return Speak(False, "You are not a member of that room.")
    if room["setup_state"] == "pending":
        return Speak(False, "That room has not finished setup yet.")
    return Speak(True)


def members(room_id: str) -> list[dict]:
    return member_views(room_id)


def disclosure(*_args, **_kwargs) -> str:
    """What a room adds to a bot's "recent work" summary: nothing. A room's text stays in the room."""
    return ""


# -- threads ----------------------------------------------------------------------

def thread_or_404(room_id: str, thread_id: str | None) -> dict:
    if thread_id is None:
        found = store.threads(room_id)
        return found[0]
    thread = store.get_thread(room_id, thread_id)
    if thread is None:
        raise HTTPException(404, "thread not found")
    return thread


def create_thread(owner: str, room_id: str, title="") -> dict:
    get(room_id, owner)
    thread = store.create_thread(room_id, _clean(title, 100, "The title"))
    announce(room_id)
    return thread


def rename_thread(owner: str, room_id: str, thread_id: str, title) -> dict:
    get(room_id, owner)
    thread_or_404(room_id, thread_id)
    thread = store.update_thread(room_id, thread_id, title=_clean(title, 100, "The title"))
    announce(room_id)
    return thread


def delete_threads(owner: str, room_id: str, thread_ids: list[str]) -> dict:
    get(room_id, owner)
    if not thread_ids or len(thread_ids) > BULK_DELETE_MAX:
        raise HTTPException(422, f"Choose 1 to {BULK_DELETE_MAX} threads")
    for thread_id in thread_ids:
        if _turns().thread_busy(room_id, thread_id):
            raise HTTPException(409, "A thread you chose is working. Stop it first.")
    removed = store.delete_threads(room_id, thread_ids)
    announce(room_id)
    return {"deleted": removed}


# -- the transcript ---------------------------------------------------------------

def add_row(room_id: str, thread_id: str, role: str, text: str, *, kind: str = "text", bot_id: str | None = None,
            send_id: str | None = None, reply_to_id: str | None = None, run_id: str | None = None,
            turn_id: str | None = None, meta: dict | None = None) -> tuple[dict, bool]:
    """Store one row and tell every open screen."""
    message, created = store.add_message(room_id, thread_id, role, text, bot_id=bot_id, kind=kind, send_id=send_id,
                                         reply_to_id=reply_to_id, run_id=run_id, turn_id=turn_id, meta=meta)
    if created:
        room = store.get_room(room_id)
        feed.publish("room.message", room_id, {"message": message_view(message)}, room["owner"] if room else None)
    return message, created


def chip(room_id: str, thread_id: str, text: str, **meta) -> dict:
    """A small system line: a held notice, a wait, a stop."""
    return add_row(room_id, thread_id, "system", text, kind="chip", meta=meta)[0]


def messages(owner: str, room_id: str, *, thread_id: str | None = None, limit: int = PAGE_DEFAULT,
             before: int | None = None, around: str | None = None) -> dict:
    get(room_id, owner)
    thread = thread_or_404(room_id, thread_id)
    limit = max(1, min(int(limit or PAGE_DEFAULT), PAGE_MAX))
    if around:
        anchor = store.get_message(room_id, around)
        if anchor is None or anchor["thread_id"] != thread["id"]:
            raise HTTPException(404, "message not found")
        half = limit // 2
        older = store.messages(room_id, thread["id"], limit=half, before=anchor["seq"])
        newer = store.messages(room_id, thread["id"], limit=limit - half, after=anchor["seq"] - 1)
        rows = older + newer
    else:
        rows = store.messages(room_id, thread["id"], limit=limit, before=before)
    first = rows[0]["seq"] if rows else None
    older_exists = bool(first and store.messages(room_id, thread["id"], limit=1, before=first))
    return {"thread_id": thread["id"], "messages": [message_view(m) for m in rows], "has_more": older_exists,
            "last_seq": store.last_seq(room_id)}


# -- work from elsewhere lands here ------------------------------------------------

def post_report(assignment: dict) -> bool:
    """A lane's result, posted back into the room it was asked from as a card from the bot that did it.
    False when the room cannot take it (the caller keeps the result where it was)."""
    requester = assignment.get("requester") or {}
    room_id, bot_id = requester.get("room_id"), assignment.get("assignee_bot_id")
    if not room_id or not bot_id:
        return False
    if not can_speak(bot_id, room_id):
        return False
    room = store.get_room(room_id)
    thread = store.get_thread(room_id, requester.get("thread_id") or "") or thread_or_404(room_id, None)
    bot = _agents().get(bot_id) or {"name": "A bot"}
    status, outcome = assignment.get("status"), assignment.get("outcome")
    title = (assignment.get("title") or "Work")[:80]
    result = (assignment.get("result") or "").strip()
    lead = f"{bot['name']} finished: {title}" if outcome in (None, "done") and status == "completed" else \
        f"{bot['name']} could not finish: {title}" + (f" ({outcome})" if outcome else "")
    add_row(room_id, thread["id"], "bot", (lead + ("\n\n" + result[:4000] if result else "")), kind="card", bot_id=bot_id,
            meta={"assignment_id": assignment.get("id"), "title": title, "status": status, "outcome": outcome,
                  "evidence": assignment.get("evidence")})
    feed.publish("room", room_id, {"room": public(room)}, room["owner"])
    return True


def _image_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def post_webhook(room_id: str, bot_id: str, text: str = "", images: list[bytes] | None = None,
                 voice_note: bool = False) -> dict:
    """One bot-authored row from a webhook. Order of refusals: 400 or 413 (the payload), 404 (room),
    403 (the bot is not a member). Staged image files are removed on any failure."""
    images = images or []
    if not isinstance(text, str) or (not text.strip() and not images):
        raise HTTPException(400, "Send text or an image")
    if len(text) > WEBHOOK_TEXT_MAX:
        raise HTTPException(413, f"The text is at most {WEBHOOK_TEXT_MAX} characters")
    if len(images) > WEBHOOK_IMAGES_MAX:
        raise HTTPException(413, f"At most {WEBHOOK_IMAGES_MAX} images")
    kinds = []
    for data in images:
        if len(data) > WEBHOOK_IMAGE_BYTES:
            raise HTTPException(413, "An image is too large")
        kind = _image_type(data)
        if kind is None:
            raise HTTPException(400, "Images must be PNG, JPEG, WebP or GIF")
        kinds.append(kind)
    room = store.get_room(room_id)
    if room is None or room["archived_at"]:
        raise HTTPException(404, "room not found")
    if store.member(room_id, bot_id) is None:
        raise HTTPException(403, "That bot is not in this room")
    if room["setup_state"] == "pending":
        raise HTTPException(409, "This room has not finished setup yet")
    if voice_note:
        raise HTTPException(409, "Voice notes are not available yet")
    from core import accounts
    folder = accounts.path("bot-room-files", room_id)
    staged: list[str] = []
    try:
        thread = thread_or_404(room_id, None)
        message, _ = add_row(room_id, thread["id"], "bot", text.strip(), kind="webhook_post", bot_id=bot_id,
                             meta={"images": []})
        files = []
        if images:
            os.makedirs(folder, exist_ok=True)
        for number, (data, kind) in enumerate(zip(images, kinds), 1):
            name = f"{message['id']}-{number}.{kind}"
            path = os.path.join(folder, name)
            with open(path, "wb") as handle:
                handle.write(data)
            staged.append(path)
            files.append({"name": name, "type": kind, "size": len(data)})
        if files:
            store.update_message(room_id, message["id"], meta={"images": files})
    except BaseException:
        for path in staged:
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    announce(room_id)
    return message_view(store.get_message(room_id, message["id"]))


# -- seats -------------------------------------------------------------------------

def ensure_seat(room_id: str, bot_id: str) -> str:
    """The member's private session in this room, made on first use."""
    from core.session_manager import session_manager
    item = store.member(room_id, bot_id)
    if item is None:
        raise HTTPException(404, "that bot is not in this room")
    room = store.get_room(room_id)
    seat = item["seat_session_id"]
    if seat and session_manager.get_session(seat) is not None:
        return seat
    bot = _agents().get(bot_id)
    if bot is None:
        raise HTTPException(404, "bot not found")
    session = session_manager.create_session(f"{room['name']} (room)", owner_user=room["owner"])
    endpoint_id = _agents().chat_endpoint(bot)
    if endpoint_id:
        session_manager.set_model_endpoint(session["id"], endpoint_id)
    _agents().make_agent_chat(session["id"], bot, attended=False)
    session_manager.set_thread(session["id"], opened_by="room")
    if room["cwd"]:
        try:
            session_manager.set_workspace(session["id"], room["cwd"])
        except Exception:
            logger.exception("could not give the seat the room's folder")
    state = {k: v for k, v in (item["state"] or {}).items() if k not in ("last_outcome", "last_thread_id", "last_at", "config_rev")}
    store.update_member(room_id, bot_id, seat_session_id=session["id"], last_seen_seq=0, state=state)
    return session["id"]


# -- start up ----------------------------------------------------------------------

async def startup() -> dict:
    """After a restart: running turns are marked interrupted (never replayed), then queued messages go on,
    in every account's rooms (Multi-Account group 4)."""
    from core import accounts
    interrupted = resumed = 0
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            connect()
            _turns().note_interrupted()  # a line in each room where a turn was cut off, before the turns are marked
            interrupted += store.interrupt_running() or 0
            resumed += _turns().resume_pending() or 0
    return {"interrupted": interrupted, "resumed": resumed}
