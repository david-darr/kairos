"""Teams and rooms in bot packages (Bots Phase 6 hooks, 2026-10-31).

`bot_package.register_section` callbacks for the two shared things a package of bots can bring along:

- `departments`: every team an exported bot belongs to, with its name, members, chief and team
  instructions. Team memory stays out, the same way a bot's live notebook does.
- `rooms`: every open room an exported bot sits in, with its name, context, description, room
  instructions, default responder and turn limit. Only the exported bots come along as members.
  Messages and the working folder (a path on this machine) stay out.

Bots are named by their package keys (`bot-1`, `bot-2`, ... in export order), never by ids, and an
import maps them to the bots it just made. Import checks the section data itself, because the package
validator passes sections through; a taken name gets a free one; every import returns an undo.
"""
from __future__ import annotations

import re

from services import bot_package

MAX_TEAMS = 20
MAX_ROOMS = 20
KEY = re.compile(r"^bot-[1-9][0-9]{0,2}$")


def _keys(bot_ids):
    return {bot_id: f"bot-{number + 1}" for number, bot_id in enumerate(bot_ids)}


def _owner(mapping):
    """Who owns what an import makes: the owner of the bots it just made."""
    from services import bot_attention, bot_departments
    from services.agent_service import agent_service
    for bot_id in mapping.values():
        bot = agent_service.get(bot_id)
        if bot is not None:
            return bot_departments.owner(bot) or bot_attention.legacy_owner()
    return bot_attention.legacy_owner()


def _text(value, limit, label, required=False):
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit or (required and not value.strip()):
        raise ValueError(f"{label} must be text up to {limit} bytes")
    return value


def _members(value, mapping, label):
    if not isinstance(value, list) or len(value) > 100 or len(set(value)) != len(value) \
            or any(not isinstance(key, str) or not KEY.fullmatch(key) for key in value):
        raise ValueError(f"{label} members must be package bot keys")
    return [mapping[key] for key in value if key in mapping]


def _free(name, taken, limit):
    used = {n.casefold() for n in taken}
    candidate, number = name, 2
    while candidate.casefold() in used:
        suffix = f" {number}"
        candidate = name[:limit - len(suffix)] + suffix
        number += 1
    return candidate


# -- teams ---------------------------------------------------------------------

def export_departments(bot_ids):
    from services import bot_departments
    from services.agent_service import agent_service
    keys, out = _keys(bot_ids), []
    for team in bot_departments.list():
        members = [b["id"] for b in bot_departments.members(team["id"]) if b["id"] in keys]
        if not members:
            continue
        out.append({"name": team["name"], "members": [keys[i] for i in members],
                    "chief": keys.get(team.get("chief_bot_id")), "instructions": bot_departments.instructions(team["id"])["text"]})
    return {"teams": out[:MAX_TEAMS]}


def import_departments(data, mapping):
    from services import bot_departments
    if not isinstance(data, dict) or not isinstance(data.get("teams"), list) or len(data["teams"]) > MAX_TEAMS:
        raise ValueError(f"A package carries at most {MAX_TEAMS} teams")
    owner = _owner(mapping)
    plan = []
    for row in data["teams"]:
        if not isinstance(row, dict):
            raise ValueError("Invalid team")
        name = bot_departments.clean_name(_text(row.get("name"), 120, "Team name", True))
        members = _members(row.get("members", []), mapping, "Team")
        chief = row.get("chief")
        if chief is not None and (not isinstance(chief, str) or not KEY.fullmatch(chief)):
            raise ValueError("A team's chief must be a package bot key")
        plan.append((name, members, mapping.get(chief), _text(row.get("instructions", ""), 24000, "Team instructions")))
    made = []

    def undo():
        for ident in reversed(made):
            bot_departments.delete(ident, owner)

    try:
        for name, members, chief, text in plan:
            if not members:
                continue  # none of its bots were chosen for this import
            name = _free(name, [t["name"] for t in bot_departments.list(owner)], 60)
            team = bot_departments.create(name, members, owner)
            made.append(team["id"])
            if text:
                bot_departments.put_instructions(team["id"], text, bot_departments.instructions(team["id"], owner)["hash"], owner)
            if chief:
                try:
                    bot_departments.set_chief(team["id"], chief, (), owner)
                except Exception:
                    pass  # a chief needs a model with tools; the team still works without one
    except Exception:
        undo()
        raise
    return undo


# -- rooms -----------------------------------------------------------------------

def export_rooms(bot_ids):
    from core import bot_rooms_store as store
    keys, out = _keys(bot_ids), []
    for room in store.list_rooms(None, False):
        members = [m["bot_id"] for m in store.members(room["id"]) if m["bot_id"] in keys]
        if not members:
            continue
        responder = room.get("default_responder") or {}
        if responder.get("kind") == "member":
            responder = {"kind": "member", "bot": keys[responder["bot_id"]]} if responder.get("bot_id") in keys else {"kind": "auto"}
        out.append({"name": room["name"], "context": room.get("context") or "", "description": room.get("description") or "",
                    "bulletin": room.get("bulletin") or "", "default_responder": {"kind": responder.get("kind", "auto"), **({"bot": responder["bot"]} if "bot" in responder else {})},
                    "turn_timeout_minutes": room.get("turn_timeout_minutes") or 5, "members": [keys[i] for i in members]})
    return {"rooms": out[:MAX_ROOMS]}


def import_rooms(data, mapping):
    from services import bot_rooms
    if not isinstance(data, dict) or not isinstance(data.get("rooms"), list) or len(data["rooms"]) > MAX_ROOMS:
        raise ValueError(f"A package carries at most {MAX_ROOMS} rooms")
    owner = _owner(mapping)
    plan = []
    for row in data["rooms"]:
        if not isinstance(row, dict):
            raise ValueError("Invalid room")
        members = _members(row.get("members", []), mapping, "Room")
        responder = row.get("default_responder") or {"kind": "auto"}
        if not isinstance(responder, dict) or responder.get("kind") not in bot_rooms.RESPONDER_KINDS:
            raise ValueError("Invalid room responder")
        if responder["kind"] == "member":
            bot_id = mapping.get(responder.get("bot")) if isinstance(responder.get("bot"), str) else None
            responder = {"kind": "member", "bot_id": bot_id} if bot_id in members else None
        else:
            responder = {"kind": responder["kind"]}
        timeout = row.get("turn_timeout_minutes", 5)
        if type(timeout) is not int:
            raise ValueError("A room's turn limit is a whole number of minutes")
        plan.append({"name": _text(row.get("name"), 400, "Room name", True), "members": members, "responder": responder,
                     "context": _text(row.get("context", ""), 400, "Room context"),
                     "description": _text(row.get("description", ""), 800, "Room description"),
                     "bulletin": _text(row.get("bulletin", ""), 48000, "Room instructions"), "timeout": timeout})
    made = []

    def undo():
        for ident in reversed(made):
            bot_rooms.delete(owner, ident)

    try:
        for room in plan:
            if not room["members"]:
                continue
            name = _free(room["name"], [r["name"] for r in bot_rooms.list_rooms(owner, include_archived=True)], 100)
            created = bot_rooms.create(owner, name, bot_ids=room["members"], context=room["context"], description=room["description"],
                                       default_responder=room["responder"], turn_timeout_minutes=room["timeout"],
                                       bulletin=room["bulletin"], setup_done=True)
            made.append(created["id"])
    except Exception:
        undo()
        raise
    return undo


bot_package.register_section("departments", export_departments, import_departments)
bot_package.register_section("rooms", export_rooms, import_rooms)
