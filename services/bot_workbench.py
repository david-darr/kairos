"""Read-only workbench projections and person-controlled computer actions."""
import asyncio
import copy
import os
import threading
from fastapi import HTTPException
from pathlib import Path
from urllib.parse import unquote

from core.atomic_io import read_json, write_json_atomic
from typing import Optional

from core.constants import DATA_DIR

STATE_FILE: Optional[str] = None  # a test can point it at its own file


def state_file() -> str:
    from core import accounts
    return STATE_FILE or accounts.path("bot_workbench.json")
LOCK = threading.RLock()
PLACES = ("auto", "computer", "browser", "off")
PHASES = {
    "docker_missing": ("Docker is not ready", "settings"),
    "image_needed": ("Prepare the computer", "prepare"),
    "asleep": ("Computer is asleep", "start"),
    "starting": ("Starting the computer", "refresh"),
    "ready": ("Computer is ready", "take"),
    "busy": ("The bot is using the computer", "take"),
    "taken": ("You have the wheel", "release"),
    "browser_only": ("Working in the browser", "take"),
    "off": ("Computer use is off", "place"),
    "error": ("The computer could not start", "start"),
}


def read_state():
    with LOCK:
        return {"profiles": [], "computers": {"max_running": 2, "idle_minutes": 10}, "help": {},
                **read_json(state_file(), {})}


def save_state(state):
    path = state_file()
    write_json_atomic(path, state)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def computer_settings():
    return {"max_running": 2, "idle_minutes": 10, **read_state().get("computers", {})}


def set_computer_settings(max_running, idle_minutes):
    if type(max_running) is not int or not 1 <= max_running <= 8:
        raise ValueError("Running computers must be from 1 to 8")
    if type(idle_minutes) is not int or not 5 <= idle_minutes <= 1440:
        raise ValueError("Idle minutes must be from 5 to 1440")
    with LOCK:
        state = read_state()
        state["computers"] = {"max_running": max_running, "idle_minutes": idle_minutes}
        save_state(state)
        return state["computers"]


def thread_for(agent, thread_id):
    if not thread_id:
        return None
    from services.bot_threads import owned_session
    return owned_session(agent["id"], thread_id)


def effective_place(owner, thread_id=None):
    """Resolve only trusted owner/session metadata, never model arguments."""
    from services.agent_service import agent_service
    from core.session_manager import session_manager
    from core import runs
    kind, _, ident = owner.partition(":")
    session = session_manager.get_session(ident) if kind == "chat" else None
    agent = agent_service.get(ident if kind == "agent" else (session or {}).get("agent_id"))
    if agent:
        if not thread_id:
            run = runs.CURRENT.get()
            if run and run.agent_id == agent["id"]:
                thread_id = run.session_id
        session = thread_for(agent, thread_id) if thread_id else session
    bot = (agent or {}).get("place", "auto")
    pin = (session or {}).get("thread", {}).get("place")
    effective = pin if pin in PLACES else bot
    enabled = (agent or {}).get("browser_enabled", True)
    if not enabled:
        effective = "off"
    return {"bot": bot, "thread": pin, "effective": effective,
            "why": "Browser is off for this bot" if not enabled else
                   "Pinned for this conversation" if pin else "Follows the bot"}


async def docker_status():
    from core import sandbox, computer_image
    available, reason = await sandbox.available()
    return {"available": available, "reason": reason,
            "image_ready": await computer_image.image_ready() if available else False,
            "desktop_image_ready": await computer_image.image_ready(desktop=True) if available else False}


async def status(agent, thread_id=None, manager=None):
    from core import computer, settings
    from services import bot_help, bot_browser_profiles
    manager = manager or computer.manager
    owner = "agent:" + agent["id"]
    place = effective_place(owner, thread_id)
    docker = await docker_status()
    row = next((r for r in manager.running() if r["owner"] == owner), {})
    enabled = (settings.get_setting("computer_use") or {}).get("enabled", False)
    if place["effective"] == "off" or not enabled:
        phase = "off"
    elif owner in manager.starting:
        phase = "starting"
    elif owner in manager.errors:
        phase = "error"
    elif row.get("taken_over"):
        phase = "taken"
    elif row:
        from services import chat_live
        busy = bool(thread_id and chat_live.is_processing(thread_id))
        phase = "busy" if busy else "browser_only" if place["effective"] == "browser" else "ready"
    elif not docker["available"]:
        phase = "docker_missing"
    elif not docker["image_ready"] or (place["effective"] != "browser" and computer._desktop_enabled()
                                      and not docker["desktop_image_ready"]):
        phase = "image_needed"
    else:
        phase = "asleep"
    message, action = PHASES[phase]
    position = manager.wait_position(owner)
    if position:
        phase, message, action = "starting", f"Waiting for a free computer (position {position})", "refresh"
    elif phase == "error":
        message = manager.errors[owner]
    return {"phase": phase, "message": message, "action": action, "place": place, "docker": docker,
            "computer": {"running": bool(row), "desktop": row.get("desktop", False),
                         "taken_over": row.get("taken_over", False), "waiting_model": row.get("waiting_model", False),
                         "lease_id": row.get("lease_id"), "title": row.get("title", ""), "url": row.get("url", ""),
                         "last_action_at": row.get("last_action"),
                         "badges": ["Desktop" if row.get("desktop") else "Browser"] +
                                   (["In control"] if row.get("taken_over") else [])},
            "help": bot_help.current(agent["id"]),
            "browser": {"enabled": agent.get("browser_enabled", True), "profile": agent.get("browser_profile", "own"),
                        "sites": await asyncio.to_thread(bot_browser_profiles.sites, agent)}}


async def places(agent):
    from core import computer, settings
    docker = await docker_status()
    enabled = agent.get("browser_enabled", True) and (settings.get_setting("computer_use") or {}).get("enabled", False)
    result = []
    for value, label in zip(PLACES, ("Let it choose", "Computer", "Browser", "Off")):
        reason = ""
        if value in ("computer", "browser"):
            reason = "Browser is off" if not enabled else "Docker is not ready" if not docker["available"] else ""
        if value == "computer" and not reason and not computer._desktop_enabled():
            reason = "Desktop is off in Settings"
        result.append({"id": value, "label": label, "available": not reason, "reason": reason})
    return result


def files(agent, thread_id=None, owner_user=None):
    """Files are confined to this bot's sessions and their trusted workspace."""
    from core import chat_artifacts
    from core.session_manager import session_manager
    sessions = [thread_for(agent, thread_id)] if thread_id else [session_manager.get_session(h["id"])
                for h in session_manager.list_sessions(agent_id=agent["id"])]
    recent = {}
    folder = {"label": "Private folder", "private": True}
    for session in filter(None, sessions):
        if owner_user and session.get("owner_user") and session["owner_user"] != owner_user:
            continue
        shared = {unquote(u) for m in session.get("messages", []) if m.get("role") == "assistant"
                  for u in chat_artifacts.LINK.findall(m.get("content", ""))}
        for url in shared | set(session.get("artifact_urls", [])):
            try:
                path, _ = chat_artifacts.resolve(session["id"], url)
                stat = path.stat()
                recent[url] = {"name": path.name, "url": url, "bytes": stat.st_size, "at": stat.st_mtime,
                               "shared": unquote(url) in shared, "thread_id": session["id"]}
            except (OSError, ValueError, HTTPException):
                continue
        if session.get("workspace_dir"):
            root = Path(session["workspace_dir"]).resolve()
            folder = {"label": root.name, "private": False}
            # Bounded walk, with no symlinks or hidden files. No file is published by looking.
            count = 0
            for directory, dirs, names in os.walk(root, followlinks=False):
                dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(directory) / d).is_symlink()]
                for name in names:
                    count += 1
                    if count > 5000:
                        break
                    path = Path(directory) / name
                    if name.startswith('.') or path.is_symlink() or not path.resolve().is_relative_to(root):
                        continue
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    recent.setdefault(str(path), {"name": str(path.relative_to(root)), "url": None,
                        "bytes": stat.st_size, "at": stat.st_mtime, "shared": False, "thread_id": session["id"]})
                if count > 5000:
                    break
    return {"folder": folder, "recent": sorted(recent.values(), key=lambda f: f["at"], reverse=True)[:20]}


async def start(agent, thread_id=None):
    from core import computer, settings
    if not (settings.get_setting("computer_use") or {}).get("enabled"):
        raise ValueError("Turn on computer use in Settings")
    return await computer.manager._get("agent:" + agent["id"], thread_id=thread_id)


def control(agent_id, action, lease_id=None):
    from core import computer
    owner = "agent:" + agent_id
    c = computer.manager._computers.get(owner)
    if not c:
        raise KeyError(owner)
    if action == "take":
        computer.manager.takeover(owner)
    elif not lease_id or c.lease_id != lease_id or not c.taken_over:
        raise ValueError("Control changed. Refresh before handing back")
    else:
        computer.manager.hand_back(owner)
    return {"lease_id": c.lease_id}


async def inventory():
    from core import computer
    from services.agent_service import agent_service
    running = {r["owner"]: r for r in computer.manager.running()}
    return {"computers": [{"bot_id": a["id"], "name": a["name"], "running": "agent:" + a["id"] in running,
             "since": running.get("agent:" + a["id"], {}).get("started_at"),
             "last_action_at": running.get("agent:" + a["id"], {}).get("last_action"),
             "taken_over": running.get("agent:" + a["id"], {}).get("taken_over", False),
             "profile": a.get("browser_profile", "own")} for a in agent_service.list_agents()],
            "settings": computer_settings(), "docker": await docker_status()}
