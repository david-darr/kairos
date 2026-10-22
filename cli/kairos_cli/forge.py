"""Forge from a terminal (spec section 4.4, decision 3).

`kairos forge "task"` and /forge register the current folder as a Forge
project (idempotent; the backend's vet_project refuses Kairos's own code and
data folders) and start a Forge session there. By default it edits the
folder in place, like Claude Code and Codex, with checkpoints for undo;
--worktree asks for Forge's own isolated worktree instead.

Every Forge route is admin-only, which the local user is.
"""
from __future__ import annotations

import os
from pathlib import Path

from .connection import Connection, KairosError
from .sanitize import one_line


async def find_project(conn: Connection, folder: str) -> dict | None:
    wanted = os.path.normcase(str(Path(folder).resolve()))
    for project in await conn.get("/api/forge/projects"):
        if os.path.normcase(str(Path(project["path"]).resolve())) == wanted:
            return project
    return None


async def register(conn: Connection, folder: str | None = None) -> dict:
    folder = str(Path(folder or os.getcwd()).resolve())
    return await conn.post("/api/forge/projects", {"path": folder})


async def start(conn: Connection, task: str, folder: str | None = None, worktree: bool = False,
                model_endpoint_id: str | None = None, mode: str = "build") -> dict:
    project = await register(conn, folder)
    body = {"project_id": project["id"], "task": task, "mode": mode,
            "isolation": "new_worktree" if worktree else "in_place"}
    if model_endpoint_id:
        body["model_endpoint_id"] = model_endpoint_id
    return await conn.post("/api/forge/sessions", body)


async def changes(conn: Connection, session_id: str) -> dict:
    return await conn.get(f"/api/forge/sessions/{session_id}/changes")


async def checkpoints(conn: Connection, session_id: str) -> list[dict]:
    return await conn.get(f"/api/forge/sessions/{session_id}/checkpoints")


async def undo_last(conn: Connection, session_id: str) -> dict:
    """Undo the newest turn that changed files, through its checkpoint."""
    events = await checkpoints(conn, session_id)
    candidates = [e for e in events if any(r.get("changes") for r in e.get("roots") or [])]
    if not candidates:
        raise KairosError("Nothing to undo: no turn in this Forge session has changed files yet.")
    newest = max(candidates, key=lambda e: e.get("created") or 0)
    result = await conn.post(f"/api/forge/sessions/{session_id}/checkpoints/{newest['id']}/undo", {"confirmed": True})
    return {"event": newest, "result": result}


async def revert_file(conn: Connection, session_id: str, path: str) -> dict:
    return await conn.post(f"/api/forge/sessions/{session_id}/revert-file", {"path": path, "confirmed": True})


def describe(session: dict) -> str:
    forge = session.get("forge") or {}
    where = "in place" if forge.get("isolation") == "in_place" else f"worktree {one_line(forge.get('worktree'), 80)}"
    return f"Forge · {forge.get('mode', 'build')} · {where} · branch {one_line(forge.get('branch'), 60)}"


def files_here(folder: str, limit: int = 4000) -> list[str]:
    """Relative paths under a folder for @ completion, skipping the usual
    heavy or private folders."""
    skip = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".cli-venv", ".mypy_cache"}
    out: list[str] = []
    root = Path(folder)
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith("."))
        for name in sorted(files):
            out.append(str((Path(current) / name).relative_to(root)).replace("\\", "/"))
            if len(out) >= limit:
                return out
    return out
