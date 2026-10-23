"""Chats from a terminal: which one, which model, and the calls a turn needs.

Shared by the interactive REPL and headless -p. Everything here is an
existing route (spec section 3); the CLI is a client, not a second engine.
"""
from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

from .connection import Connection, KairosError
from .sanitize import one_line


def same_folder(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


async def list_sessions(conn: Connection) -> list[dict]:
    return await conn.get("/api/sessions")


async def latest_here(conn: Connection, folder: str | None = None) -> dict | None:
    """kairos -c: the newest chat started from this folder."""
    folder = folder or os.getcwd()
    rows = [s for s in await list_sessions(conn) if same_folder(s.get("launch_dir"), folder)]
    rows.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
    return rows[0] if rows else None


async def find_session(conn: Connection, needle: str) -> dict | None:
    """kairos -r <id or title>: an exact id, else the newest title match."""
    rows = await list_sessions(conn)
    for row in rows:
        if row["id"] == needle:
            return row
    lowered = needle.casefold()
    matches = [r for r in rows if lowered in (r.get("title") or "").casefold()]
    matches.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
    return matches[0] if matches else None


async def new_session(conn: Connection, title: str = "New Chat", folder: str | None = None) -> dict:
    return await conn.post("/api/sessions", {"title": title, "launch_dir": str(Path(folder or os.getcwd()).resolve())})


async def open_session(conn: Connection, session_id: str) -> dict:
    return await conn.get(f"/api/sessions/{session_id}")


async def model_choices(conn: Connection) -> list[dict]:
    return await conn.get("/api/models/choices")


def match_model(choices: list[dict], wanted: str) -> dict | None:
    lowered = wanted.casefold().strip()
    for key in ("id", "name", "model"):
        for choice in choices:
            if str(choice.get(key) or "").casefold() == lowered:
                return choice
    partial = [c for c in choices if lowered in f"{c.get('name', '')} {c.get('model', '')}".casefold()]
    return partial[0] if len(partial) == 1 else None


async def set_model(conn: Connection, session_id: str, choice: dict) -> None:
    await conn.post(f"/api/sessions/{session_id}/model", {"model_endpoint_id": choice["id"]})


def model_label(session: dict, choices: list[dict]) -> str:
    endpoint = next((c for c in choices if c["id"] == session.get("model_endpoint_id")), None)
    if not endpoint:
        return "no model"
    return one_line(session.get("model_override") or endpoint.get("model") or endpoint.get("name"), 40)


async def start_turn(conn: Connection, session_id: str, text: str, references: list[dict] | None = None) -> str:
    started = await conn.post("/api/chat/live", {"session_id": session_id, "message": text,
                                                 "references": references or [], "request_id": uuid.uuid4().hex})
    return started["turn_id"]


async def stop_turn(conn: Connection, session_id: str) -> bool:
    result = await conn.post("/api/chat/live/stop", {"session_id": session_id})
    return bool(result and result.get("stopping"))


async def answer_permission(conn: Connection, request_id: str, choice_id: str) -> str:
    """'answered', or 'gone' when the app (or the timeout) got there first."""
    try:
        await conn.post(f"/api/permissions/{request_id}/answer", {"choice": choice_id})
        return "answered"
    except KairosError as error:
        if "no longer waiting" in str(error) or "not found" in str(error):
            return "gone"
        raise


def reject_choice(request: dict) -> dict | None:
    return next((c for c in request.get("choices") or [] if c.get("behavior") == "deny"), None)


def age(timestamp: float | None) -> str:
    if not timestamp:
        return ""
    seconds = max(0, time.time() - timestamp)
    for size, unit in ((86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return f"{int(seconds // size)}{unit} ago"
    return "just now"


async def answer_question(conn: Connection, request_id: str, answers=None, skip=False) -> str:
    try:
        await conn.post(f"/api/permissions/{request_id}/respond", {"skip": True} if skip else {"answers": answers})
        return "skipped" if skip else "answered"
    except KairosError as error:
        if "no longer waiting" in str(error) or "not found" in str(error):
            return "gone"
        raise
