"""Resolve sharing audiences from trusted records on this single-person app."""
from fastapi import HTTPException
from services import bot_departments as teams


def audience(kind, ref=None, *, owner=None):
    if kind == "team":
        return [b["id"] for b in teams.members(ref, owner) if not b.get("hidden")]
    if kind == "everyone":
        if owner is None:
            raise HTTPException(403, "A trusted owner is required")
        return [b["id"] for b in teams.service().list_agents()
                if teams.owner(b) == owner and not b.get("hidden")]
    if kind == "room":
        from services import bot_rooms
        rows = bot_rooms.members(ref)
        ids = [r if isinstance(r, str) else r.get("bot_id") for r in rows]
        bots = [teams.service().get(i) for i in ids]
        if owner is None or any(not b or teams.owner(b) != owner for b in bots):
            raise HTTPException(404, "Room not found")
        return [b["id"] for b in bots if not b.get("hidden")]
    raise HTTPException(400, "Unknown sharing audience")
