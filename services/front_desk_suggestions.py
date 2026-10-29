"""Bounded Up next offers. Only a person's Start turns an offer into work."""
import time
import uuid

from services import front_desk_tasks as tasks

HIDE_SECONDS = 14 * 86400


def list_suggestions(user=None):
    if user is not None:
        tasks.require_owner(user)
    return [s for s in tasks.read_rows("suggestions") if s.get("status") == "open"]


def add(title, detail, source, origin, run_id=None, *, ask=None, make_kind=None, channel_tag=None, send_id=None):
    if not isinstance(title, str) or not title.strip() or len(title) > 120:
        raise ValueError("A suggestion needs a title of up to 120 characters")
    if not isinstance(detail, str) or len(detail) > 400:
        raise ValueError("A suggestion detail is up to 400 characters")
    if origin not in ("check_in", "asked"):
        raise ValueError("Unknown suggestion origin")
    if source is not None and (not isinstance(source, dict) or set(source) - {"app", "ref", "link"}
                               or source.get("app") not in ("mail", "calendar")
                               or not isinstance(source.get("ref", ""), str) or len(source.get("ref", "")) > 200
                               or len(str(source.get("link", ""))) > 2000):
        raise ValueError("Unknown suggestion source")
    if ask is not None and (not isinstance(ask, str) or not 1 <= len(ask.strip()) <= 4000):
        raise ValueError("Write a task of up to 4000 characters")
    if make_kind is not None and make_kind not in tasks.MAKE_KINDS:
        raise ValueError("Unknown make kind")
    now = time.time()
    title = " ".join(title.split())
    with tasks.LOCK:
        rows = tasks.read_rows("suggestions")
        if send_id:
            previous = next((s for s in rows if s.get("send_id") == send_id), None)
            if previous:
                if (previous.get("ask"), previous.get("make_kind")) != (ask, make_kind):
                    from core.bot_chat_store import Conflict
                    raise Conflict("This send ID was already used for another suggestion")
                return previous.copy()
        if any(s["title"].casefold() == title.casefold() and
               (s["status"] == "open" or s["status"] == "hidden" and s.get("hidden_until", 0) > now) for s in rows):
            return None
        if run_id and sum(s.get("run_id") == run_id for s in rows) >= 5:
            return None
        row = {"id": uuid.uuid4().hex[:20], "title": title, "detail": detail, "source": source,
               "origin": origin, "status": "open", "task_id": None, "created_at": now,
               "hidden_until": None, "run_id": run_id}
        if ask is not None:
            row.update(ask=ask, make_kind=make_kind, channel_tag=channel_tag, send_id=send_id)
        rows.append(row)
        tasks.write_rows("suggestions", rows)
        return row.copy()


def _get(rows, suggestion_id):
    row = next((s for s in rows if s["id"] == suggestion_id), None)
    if not row:
        raise KeyError(suggestion_id)
    return row


def start(suggestion_id, *, user=None):
    with tasks.LOCK:
        if user is not None:
            tasks.require_owner(user)
        rows = tasks.read_rows("suggestions")
        row = _get(rows, suggestion_id)
        if row["status"] == "hidden":
            raise ValueError("This suggestion is hidden")
        task = tasks.start(row.get("ask") or row["title"] + ("\n\n" + row["detail"] if row["detail"] else ""),
                           origin="suggestion", source=row.get("source"), send_id="suggestion:" + suggestion_id,
                           kind="make" if row.get("make_kind") else "task", make_kind=row.get("make_kind"),
                           channel_tag=row.get("channel_tag"))
        row.update(status="started", task_id=task["id"])
        tasks.write_rows("suggestions", rows)
        return task


def hide(suggestion_id, *, user=None):
    with tasks.LOCK:
        if user is not None:
            tasks.require_owner(user)
        rows = tasks.read_rows("suggestions")
        row = _get(rows, suggestion_id)
        if row["status"] == "started":
            return row.copy()
        if row["status"] != "hidden":
            row.update(status="hidden", hidden_until=time.time() + HIDE_SECONDS)
            tasks.write_rows("suggestions", rows)
        return row.copy()
