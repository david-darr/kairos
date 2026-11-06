"""Sharing a bot's reviewed skill into the library.

Mode per bot: off, ask or auto. A person pressing Share always acts; a model or the background
reviewer is refused when the mode is off, waits for approval when it is ask, and publishes when
it is auto. Only the library audience works today. Naming a department or room needs the trusted
audience resolver that arrives with rooms: until one is installed with `set_audience_resolver`,
every other audience is refused. The skill text a bot shares is the reviewed revision, never newer bytes.
"""
import time
import uuid
from pathlib import Path

from core import accounts
from services import bot_skill_library, bot_skills
from services.bot_skills import ABSENT, LOCK, SkillError, checked, ident, name, read_json, state_path, write_json

MODES = ("off", "ask", "auto")
_resolver = None


def set_audience_resolver(resolver):
    """Install the trusted resolver: `resolver(bot_id, audience) -> list of bot ids no wider than the author's audience`."""
    global _resolver
    _resolver = resolver


def resolve_audience(bot_id, audience):
    if audience == "library":
        return []
    if _resolver is None:
        raise SkillError("Sharing with a department or room is not available yet. Share to the library instead.", 403)
    members = _resolver(bot_id, audience)
    if not isinstance(members, list) or any(not isinstance(m, str) for m in members):
        raise SkillError("That audience could not be confirmed.", 403)
    return [ident(m) for m in members if m != bot_id]


def mode(scope):
    return read_json(state_path(bot_skills._bot_id(scope), "sharing.json"), {}).get("mode", "ask")


def set_mode(scope, value):
    if value not in MODES:
        raise SkillError("Sharing is off, ask or auto.")
    write_json(state_path(bot_skills._bot_id(scope), "sharing.json"), {"mode": value})
    return value


def _pending_path():
    return checked(Path(accounts.path(bot_skill_library.ROOT, "pending.json")))


def _notes_path():
    return checked(Path(accounts.path(bot_skill_library.ROOT, "share-notes.json")))


def pending_shares(bot_id=None):
    rows = read_json(_pending_path(), {"shares": []})["shares"]
    return [r for r in rows if r["status"] == "pending" and (bot_id is None or r["bot_id"] == bot_id)]


def share(scope, skill_name, *, audience="library", actor="person", note="", expected_revision=ABSENT):
    """Publish the bot's reviewed skill. Returns {"status": "published" | "pending", ...}."""
    bot_id = bot_skills._bot_id(scope)
    if actor not in {"person", "model", "reviewer"}:
        raise SkillError("Unknown actor.")
    members = resolve_audience(bot_id, audience)
    name(skill_name)
    value = next((s for s in bot_skills.list_private(bot_id) if s["name"] == skill_name), None)
    if value is None or not value["effective_enabled"]:
        raise SkillError("Only a reviewed, switched-on skill can be shared.", 409)
    chosen = mode(bot_id)
    if actor != "person":
        if chosen == "off":
            raise SkillError("Sharing is off for this bot.", 403)
        if chosen == "ask":
            return _queue(bot_id, skill_name, value, audience, note, expected_revision)
    return _publish(bot_id, value, members, note, expected_revision)


def _queue(bot_id, skill_name, value, audience, note, expected_revision):
    with LOCK:
        data = read_json(_pending_path(), {"shares": []})
        for row in data["shares"]:
            if row["status"] == "pending" and row["bot_id"] == bot_id and row["name"] == skill_name and row["sha256"] == value["sha256"]:
                return {"status": "pending", "request": row["id"]}
        row = {"id": uuid.uuid4().hex, "bot_id": bot_id, "name": skill_name, "sha256": value["sha256"], "audience": audience,
               "note": str(note)[:300], "expected_revision": expected_revision, "status": "pending", "created_at": time.time()}
        data["shares"].append(row)
        del data["shares"][:-200]
        write_json(_pending_path(), data)
    return {"status": "pending", "request": row["id"]}


def _publish(bot_id, value, members, note, expected_revision):
    skill_name = value["name"]
    with LOCK:
        try:
            existing = bot_skill_library.get(skill_name)
        except SkillError:
            existing = None
        if existing and existing["sha256"] == value["sha256"]:
            library = existing
        else:
            library = bot_skill_library.publish(skill_name, value["skill_md"], references=value["references"], tags=value["tags"],
                                                source=f"shared:{bot_id}", origin="shared", expected_revision=expected_revision,
                                                reviewed=True, shared_by=bot_id)
        added = bot_skill_library.assign_to(_without_own(members, skill_name), skill_name) if members else []
        if added:
            _note(skill_name, added, note)
    return {"status": "published", "library_revision": library["storage_revision"], "assigned": added}


def _without_own(members, skill_name):
    """Skip bots that already have a private skill of the same name."""
    return [m for m in members if not any(s["name"] == skill_name for s in bot_skills.list_private(m))]


def _note(skill_name, bot_ids, text):
    data = read_json(_notes_path(), {"notes": []})
    data["notes"].append({"id": uuid.uuid4().hex, "skill": skill_name, "bots": sorted(bot_ids), "seen": [],
                          "text": (str(text) or f"A new team skill is available: {skill_name}.")[:300], "created_at": time.time()})
    del data["notes"][:-200]
    write_json(_notes_path(), data)


def notes_for(bot_id):
    """One-time notes about new shared skills. They are information only and never change a prompt."""
    return [n for n in read_json(_notes_path(), {"notes": []})["notes"] if bot_id in n["bots"] and bot_id not in n["seen"]]


def mark_seen(bot_id, note_id):
    with LOCK:
        data = read_json(_notes_path(), {"notes": []})
        for note in data["notes"]:
            if note["id"] == note_id and bot_id in note["bots"] and bot_id not in note["seen"]:
                note["seen"].append(bot_id)
        write_json(_notes_path(), data)


def decide(request_id, approve):
    """A person answers an ask-mode share."""
    with LOCK:
        data = read_json(_pending_path(), {"shares": []})
        row = next((r for r in data["shares"] if r["id"] == ident(request_id)), None)
        if row is None:
            raise SkillError("Share request not found.", 404)
        if row["status"] != "pending":
            raise SkillError("This share request is already answered.", 409)
        row["status"] = "approved" if approve else "denied"
        write_json(_pending_path(), data)
    if not approve:
        return {"status": "denied"}
    value = next((s for s in bot_skills.list_private(row["bot_id"]) if s["name"] == row["name"]), None)
    if value is None or not value["effective_enabled"] or value["sha256"] != row["sha256"]:
        raise SkillError("The skill changed after this was requested. Share it again.", 409)
    return _publish(row["bot_id"], value, resolve_audience(row["bot_id"], row["audience"]), row["note"], row["expected_revision"])
