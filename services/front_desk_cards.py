"""Server-owned front-desk message rows, keyed for retry-safe delivery."""
import copy
import json
import threading
import uuid
from urllib.parse import urlsplit

_LOCK = threading.RLock()
KINDS = {"brief", "prep", "reminder", "task_link", "suggestion", "route", "forge", "make", "chips",
         "checkin", "welcome", "reach", "watching"}
STATUSES = {"open", "started", "hidden", "done", "dismissed", "working", "failed", "sent", "discarded"}


def safe_url(value):
    try:
        url = urlsplit(value) if isinstance(value, str) else None
        return bool(url and url.scheme == "https" and url.hostname and not url.username and not url.password
                    and not any(ord(c) < 33 for c in value) and "\\" not in value)
    except ValueError:
        return False


def clean_data(kind, data):
    if kind not in KINDS or not isinstance(data, dict):
        raise ValueError("Unknown front desk card")
    value = copy.deepcopy(data)
    if len(json.dumps(value, allow_nan=False).encode("utf-8")) > 64000:
        raise ValueError("The card is too large")
    required = {"task_link": ("task_id",), "route": ("bot_id", "bot_name", "card_id"),
                "forge": ("project_id", "project_name", "task"), "make": ("task_id", "kind"),
                "suggestion": ("suggestion_id", "title", "detail", "source_label"),
                "checkin": ("at", "summary"), "watching": ("routine_id",), "brief": ("date_label", "greeting", "sections"),
                "prep": ("title", "when_label", "lines"), "reminder": ("title", "when_label", "lines")}
    if any(key not in value for key in required.get(kind, ())):
        raise ValueError("The card is missing a field")
    if kind == "chips":
        options = value.get("options")
        if not isinstance(options, list) or not 1 <= len(options) <= 4 or any(
                not isinstance(o, str) or not o.strip() or len(o) > 120 for o in options):
            raise ValueError("Choose one to four short replies")
    if kind in ("prep", "reminder"):
        if not isinstance(value["lines"], list):
            raise ValueError("Card lines must be a list")
        value["lines"] = [str(line)[:1200] for line in value["lines"][:60]]
        if not safe_url(value.get("join_url")):
            value.pop("join_url", None)
    if kind == "brief":
        sections = value["sections"]
        order = ["needs", "day", "mail", "routines", "ideas"]
        if not isinstance(sections, list) or any(not isinstance(s, dict) or s.get("id") not in order for s in sections):
            raise ValueError("Unknown brief section")
        if len({s["id"] for s in sections}) != len(sections):
            raise ValueError("Duplicate brief section")
        sections.sort(key=lambda s: order.index(s["id"]))
        for section in sections:
            rows = section.get("rows", [])
            if not isinstance(rows, list):
                raise ValueError("Brief rows must be a list")
            section["more"] = max(0, int(section.get("more", 0))) + max(0, len(rows) - 6)
            section["rows"] = rows[:6]
            for row in section["rows"]:
                row["actions"] = [a for a in row.get("actions", []) if a.get("kind") in
                                  ("open_url", "open_thread", "dismiss", "draft", "start") and
                                  (a["kind"] != "open_url" or safe_url(a.get("arg")))]
    return value


def _session(session_id):
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    session = session_manager.get_session(session_id)
    agent = agent_service.get((session or {}).get("agent_id"))
    if not session or not agent or agent.get("builtin") != "front_desk":
        raise KeyError("Front desk conversation not found")
    return session


def _find(session, key):
    return next(((i, m) for i, m in enumerate(session.get("messages", []))
                 if m.get("type") == "fd_card" and m.get("fd_key") == key and m.get("fd_server") is True), None)


def post_card(session_id, kind, data, *, key=None, status="open", notify=False):
    from core.session_manager import session_manager
    from core import session_manager_store as store
    value = clean_data(kind, data)
    if status not in STATUSES:
        raise ValueError("Unknown card status")
    key = key or f"fd:{uuid.uuid4().hex}"
    if not isinstance(key, str) or not 1 <= len(key) <= 240:
        raise ValueError("Invalid card key")
    with _LOCK, store.transaction():
        session = _session(session_id)
        existing = _find(session, key)
        if existing:
            if existing[1]["fd_kind"] != kind:
                raise ValueError("A card key cannot change kind")
            message = existing[1]
        else:
            index = session_manager.append_message(session_id, "assistant", "", extra={
                "type": "fd_card", "fd_kind": kind, "fd_key": key, "fd_status": status,
                "fd_data": value, "fd_server": True, "display_only": True})
            message = store.get_message(session_id, index)
    if not existing:
        _publish(session_id, message, "posted")
    if notify:
        _notify(session, key, value)
    return message


def _publish(session_id, message, event):
    from services import chat_live
    chat_live.broadcast_owner({"type": "bot.fd_card", "sessionId": session_id, "event": event,
                               "message": copy.deepcopy(message)})


def _notify(session, key, data):
    from services import bot_attention
    from services.agent_service import agent_service
    from core import mobile_activity
    from core.auth import auth_manager
    owner = bot_attention.owner_of(session) or bot_attention.legacy_owner()
    if not owner:
        return
    title = bot_attention.clean(data.get("title") or "Your brief", 200)
    row = bot_attention.store.publish(owner, f"fd:{session['id']}:{key}", {
        "kind": "brief", "agent_id": session["agent_id"], "title": title,
        "body": bot_attention.clean(data.get("greeting") or data.get("summary") or title, 240),
        "target": bot_attention.target_for(session["agent_id"], owner, {"session_id": session["id"]}),
        "inbox_id": None, "backlog": False})
    agent = agent_service.get(session["agent_id"]) or {}
    if row and agent.get("notifications") is not False:
        mobile_activity.enqueue_bot("bot_results", session["agent_id"], auth_manager.is_admin)


def update_card(session_id, key, fields):
    """Python server API only. There is deliberately no model tool or message PATCH route."""
    from core import session_manager_store as store
    if not isinstance(fields, dict) or set(fields) - {"fd_data", "fd_status"}:
        raise ValueError("Only card data and status can be changed")
    with _LOCK, store.transaction():
        found = _find(_session(session_id), key)
        if not found:
            raise KeyError(key)
        index, message = found
        changes = copy.deepcopy(fields)
        if "fd_data" in changes:
            changes["fd_data"] = clean_data(message["fd_kind"], changes["fd_data"])
        if "fd_status" in changes and changes["fd_status"] not in STATUSES:
            raise ValueError("Unknown card status")
        store.update_message_fields(session_id, index, changes)
        updated = store.get_message(session_id, index)
    _publish(session_id, updated, "updated")
    return updated
