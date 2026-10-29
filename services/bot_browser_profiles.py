"""Confined browser partitions. Cookie values never leave this module."""
import re
import shutil
import sqlite3
import time
import uuid
from pathlib import Path

from services import bot_workbench as state


def _path(ident):
    from core import computer
    root = computer.PROFILES.resolve()
    if not re.fullmatch(r"[0-9a-f]{10}|shared-[0-9a-f]{12}", ident):
        raise ValueError("Invalid browser profile")
    target = (root / ident).resolve()
    if Path(computer.DATA_DIR).resolve() not in root.parents or target.parent != root:
        raise ValueError("Profile path is outside Kairos data")
    return target


def resolve(agent):
    """None means tmpfs. Own preserves the original opt-in path exactly."""
    choice = agent.get("browser_profile", "own")
    if choice == "guest" or choice == "own" and not agent.get("keep_signed_in"):
        return None
    if choice == "own":
        return _path(agent["id"])
    if choice.startswith("shared:") and any(p["id"] == choice[7:] for p in state.read_state()["profiles"]):
        return _path("shared-" + choice[7:])
    raise ValueError("This browser profile is no longer available")


def used_by(profile_id):
    from services.agent_service import agent_service
    from core import computer
    return [{"id": a["id"], "name": a["name"], "running": computer.manager.is_running("agent:" + a["id"])}
            for a in agent_service.list_agents() if a.get("browser_profile") == "shared:" + profile_id]


def list_profiles():
    return [{**p, "used_by": used_by(p["id"])} for p in state.read_state()["profiles"]]


def _name(name):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise ValueError("Profile name must be from 1 to 60 characters")
    return name.strip()


def create(name):
    with state.LOCK:
        data = state.read_state()
        if len(data["profiles"]) >= 20:
            raise ValueError("You can keep up to 20 profiles")
        profile = {"id": uuid.uuid4().hex[:12], "name": _name(name), "created_at": time.time()}
        data["profiles"].append(profile)
        state.save_state(data)
        return profile


def rename(profile_id, name):
    with state.LOCK:
        data = state.read_state()
        profile = next((p for p in data["profiles"] if p["id"] == profile_id), None)
        if not profile:
            raise KeyError(profile_id)
        profile["name"] = _name(name)
        state.save_state(data)
        return profile


def delete(profile_id):
    from core import computer
    from services.agent_service import agent_service
    with state.LOCK:
        data = state.read_state()
        if not any(p["id"] == profile_id for p in data["profiles"]):
            raise KeyError(profile_id)
        users = used_by(profile_id)
        if any(u["running"] or "agent:" + u["id"] in computer.manager.starting for u in users):
            raise ValueError("Sleep every computer using this profile first")
        target = _path("shared-" + profile_id)
        if target.exists():
            shutil.rmtree(target)
        for user in users:
            agent_service.update(user["id"], browser_profile="own")
        data["profiles"] = [p for p in data["profiles"] if p["id"] != profile_id]
        state.save_state(data)


def _cookies(agent):
    profile = resolve(agent)
    if profile is None:
        return None
    # Playwright launches Chromium with /profile as user-data-dir. Chromium
    # versions use Default/Cookies or Default/Network/Cookies.
    for suffix in ("Default/Network/Cookies", "Default/Cookies"):
        target = profile / suffix
        if target.is_file():
            if not target.resolve().is_relative_to(profile) or any(p.is_symlink() for p in (target, target.parent, target.parent.parent)):
                raise ValueError("Cookie path is outside the browser profile")
            return target
    return None


def sites(agent):
    try:
        target = _cookies(agent)
        if target is None:
            return []
        with sqlite3.connect(target.as_uri() + "?mode=ro", uri=True, timeout=0.2) as db:
            hosts = db.execute("SELECT DISTINCT host_key FROM cookies LIMIT 1000").fetchall()
        return sorted({h[0].lstrip('.').lower() for h in hosts if isinstance(h[0], str)
                       and re.fullmatch(r"\.?[a-zA-Z0-9.-]{1,253}", h[0])})
    except (OSError, sqlite3.Error, ValueError):
        return []


async def sign_out(agent, host):
    from core import computer
    from services.agent_service import agent_service
    host = host.lower().lstrip('.')
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
        raise ValueError("Choose a signed-in site")
    # Shared partitions can be mounted by several computers. Stop all writers
    # before touching SQLite, including a computer currently being started.
    choice = agent.get("browser_profile", "own")
    users = [a for a in agent_service.list_agents() if choice.startswith("shared:")
             and a.get("browser_profile") == choice] if choice.startswith("shared:") else [agent]
    if any("agent:" + a["id"] in computer.manager.starting for a in users):
        raise ValueError("Wait for the computer to start, then try again")
    async with computer.manager._lock:
        for user in users:
            await computer.manager._stop("agent:" + user["id"])
        target = _cookies(agent)
        if target is not None:
            with sqlite3.connect(target, timeout=1) as db:
                db.execute("DELETE FROM cookies WHERE lower(ltrim(host_key, '.')) = ?", (host,))
