"""Read-only Make projection over front-desk threads, designs and published files.

No second content store. Imports of Phase 5 siblings stay at the adapter doors
below so this projection also works while those units are being merged.
"""
from __future__ import annotations

import hashlib
import math
import re
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from core.atomic_io import read_json
from core.constants import DATA_DIR

KINDS = ("design", "slides", "website", "files")


def _number(value) -> float:
    try:
        value = float(value or 0)
        return value if math.isfinite(value) else 0
    except (TypeError, ValueError):
        return 0


def _bot_id():
    try:
        from services.front_desk import bot_id
    except ModuleNotFoundError as error:
        if error.name != "services.front_desk":
            raise
        return (read_json(str(Path(DATA_DIR, "front_desk", "state.json")), {}) or {}).get("bot_id")
    return bot_id()


def _tasks() -> list[dict]:
    rows = read_json(str(Path(DATA_DIR, "front_desk", "tasks.json")), []) or []
    if isinstance(rows, dict):
        rows = rows.get("tasks", [])
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _task_state(task: dict, session: dict) -> str:
    try:
        from services.front_desk_tasks import derive_state
    except ModuleNotFoundError as error:
        if error.name != "services.front_desk_tasks":
            raise
        from services import chat_live
        if chat_live.is_processing(session["id"]):
            return "working"
        return "working" if time.time() - _number(task.get("created_at")) < 60 else "ready_for_review"
    return derive_state(task)


def design_kind(design: dict) -> str:
    boards = design.get("boards") or {}
    rows = sorted(boards.values(), key=lambda b: _number(b.get("order")))
    # Formats live on boards in the existing Design store. Legacy slide frames
    # remain discoverable; a mixed-format canvas is a Design.
    formats = {b.get("format") or ("slides" if b.get("frame") == "slide" else "app") for b in rows}
    return "slides" if formats == {"slides"} else "website" if formats == {"website"} else "design"


def _artifact(url):
    if not isinstance(url, str) or len(url) > 1024:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme or parts.netloc or parts.query or parts.fragment:
        return None
    path = unquote(parts.path)
    match = re.fullmatch(r"/(generated-files|generated-images)/([^/\\:\x00]+)", path)
    if not match or match[2] in (".", ".."):
        return None
    return path, re.sub(r"^[a-f0-9]{12}_", "", match[2])


def pair_making(tasks: list[dict], items: list[dict]) -> list[dict]:
    """One output satisfies at most one task, and only in its own thread.

    Use creation time rather than update time: revising an old design must not
    swallow a new making placeholder. Run before kind filtering.
    """
    used = set()
    pending = []
    for task in sorted(tasks, key=lambda t: (_number(t.get("created_at")), str(t.get("id", "")))):
        match = next((item for item in items if item["id"] not in used
                      and task.get("thread_id") in item.get("_threads", [])
                      and _number(item.get("_created")) >= _number(task.get("created_at"))
                      and item["kind"] == task.get("make_kind")), None)
        if match:
            used.add(match["id"])
        elif task.get("state") in ("working", "needs_input"):
            pending.append(task)
    return sorted(pending, key=lambda t: _number(t.get("created_at")), reverse=True)


def list_make(*, user: str, kind: str | None = None) -> dict:
    if kind not in (None, "", "all", *KINDS):
        raise ValueError("Choose Design, Slides, Web page or Files.")
    if not user:
        return {"items": [], "making": []}
    bot = _bot_id()
    if not bot:
        return {"items": [], "making": []}
    from core.session_manager import session_manager
    from core import design_store

    sessions = {}
    for header in session_manager.list_sessions(agent_id=bot):
        session = session_manager.get_session(header["id"])
        if (session and session.get("agent_id") == bot
                and session.get("owner_user") in (None, user)):
            sessions[session["id"]] = session
    items = []
    for design in design_store.list_designs():
        threads = sorted(set(design.get("chat_ids") or []) & sessions.keys())
        if not threads or not (design.get("owner") is None or design_store.visible_to(design, user, False)):
            continue
        did = str(design["id"])
        first = design_store.ordered_boards(design)
        thumb = f"/api/designs/{quote(did, safe='')}/boards/{quote(first[0][0], safe='')}/thumb" if first else None
        items.append({"id": f"design:{did}", "kind": design_kind(design), "title": str(design.get("title") or "Untitled design")[:120],
                      "updated_at": _number(design.get("updated")), "thumb_url": thumb,
                      "open": {"tab": "design", "id": did, "session_id": threads[0]},
                      "_threads": threads, "_created": _number(design.get("created"))})

    tasks = [t for t in _tasks() if t.get("thread_id") in sessions]
    task_threads = {t["thread_id"] for t in tasks}
    files = {}
    for sid in sorted(task_threads):
        session = sessions[sid]
        # The shipped SessionManager calls these artifact_urls. Accept the
        # future artifacts spelling without inspecting arbitrary messages.
        published = list(session.get("artifact_urls") or []) + list(session.get("artifacts") or [])
        for entry in published:
            info = _artifact(entry.get("url") if isinstance(entry, dict) else entry)
            if not info:
                continue
            url, name = info
            stamp = _number(entry.get("created_at")) if isinstance(entry, dict) else 0
            if not stamp:
                # A published URL has no timestamp in the shipped store. The
                # first assistant reference is a better bound than a later edit.
                stamp = next((_number(m.get("ts")) for m in session.get("messages", [])
                              if m.get("role") == "assistant" and url in str(m.get("content") or "")),
                             _number(session.get("updated_at")))
            if url in files:
                files[url]["_threads"].append(sid)
                continue
            files[url] = {"id": f"file:{hashlib.sha256(url.encode()).hexdigest()[:24]}", "kind": "files", "title": name[:120],
                          "updated_at": stamp, "thumb_url": None,
                          "open": {"tab": "artifact", "id": url, "session_id": sid}, "_threads": [sid], "_created": stamp}
    items.extend(files.values())
    items.sort(key=lambda i: (-i["updated_at"], i["id"]))
    making_tasks = []
    for task in tasks:
        if task.get("make_kind") not in KINDS:
            continue
        making_tasks.append({"id": task.get("id"), "title": str(task.get("title") or "Making something for you")[:120],
                             "thread_id": task["thread_id"], "make_kind": task["make_kind"],
                             "created_at": _number(task.get("created_at")), "state": _task_state(task, sessions[task["thread_id"]])})
    making = pair_making(making_tasks, items)
    return {"items": [{k: v for k, v in item.items() if not k.startswith("_")} for item in items
                      if kind in (None, "", "all", item["kind"])],
            "making": [task for task in making if kind in (None, "", "all", task["make_kind"])]}
