"""Chief authority follows team membership, never peer reach."""
import threading

from fastapi import HTTPException
from services import bot_departments as teams

_fallback = None
_lock = threading.RLock()
_turns = {}
LIMITS = {"create_bot": 4, "create_room": 4, "open_thread": 5}


def register_fallback(fn):
    global _fallback
    if fn is not None and not callable(fn):
        raise TypeError("fallback must be callable")
    _fallback = fn


def chief_for(bot_id, *, fallback=True):
    team = teams.team_of(bot_id)
    chief_id = team.get("chief_bot_id") if team else None
    if chief_id and chief_id != bot_id:
        return chief_id
    if fallback and _fallback:
        candidate = _fallback(bot_id)
        candidate = candidate.get("id") if isinstance(candidate, dict) else candidate
        bot, chief = teams.service().get(bot_id), teams.service().get(candidate)
        if chief and bot and candidate != bot_id and teams.owner(chief) == teams.owner(bot):
            return candidate
    return None


def managed(chief_id):
    return [d for d in teams.list() if d.get("chief_bot_id") == chief_id]


def authorize(chief_id, action, target):
    chief = teams.service().get(chief_id)
    owned = managed(chief_id)
    if not chief or not owned:
        raise HTTPException(403, "Only a team chief can do that")
    ids = {d["id"] for d in owned}
    ids.update(i for d in owned for i in d.get("also_manages", []))
    if isinstance(target, dict):
        target = target.get("bot_id") or target.get("department_id") or target.get("id")
    bot = teams.service().get(target)
    team = teams.team_of(target) if bot else None
    target_id = team["id"] if team else target
    if target_id not in ids or (bot and teams.owner(bot) != teams.owner(chief)):
        raise HTTPException(403, "That is outside the chief's teams")
    # Re-read also-managed teams to ensure stale/deleted/foreign IDs grant nothing.
    teams.get(target_id, teams.owner(chief))
    return True


def reserve(chief_id, turn_id, action, count=1):
    if action not in LIMITS or not turn_id or type(count) is not int or count < 1:
        raise HTTPException(400, "A trusted turn is required")
    with _lock:
        key = (chief_id, turn_id)
        current = _turns.setdefault(key, {})
        if current.get(action, 0) + count > LIMITS[action]:
            raise HTTPException(409, "The chief reached this turn's limit")
        current[action] = current.get(action, 0) + count
        while len(_turns) > 2048:
            del _turns[next(iter(_turns))]


def effective_level(bot_id, session_id=None):
    bot = teams.service().get(bot_id) or {}
    mode = bot.get("approval_mode", "ask")
    if session_id:
        from core.session_manager import session_manager
        session = session_manager.get_session(session_id) or {}
        if session.get("agent_id") != bot_id:
            raise HTTPException(404, "Conversation not found")
        mode = (session.get("thread") or {}).get("approval_mode") or mode
    return mode if mode in ("ask", "edits", "auto", "full", "custom") else "ask"


def prompt(bot_id):
    owned = managed(bot_id)
    if not owned:
        return ""
    bots = [b for b in teams.service().list_agents() if not b.get("hidden")]
    scoped = []
    for b in bots:
        try:
            authorize(bot_id, "roster", b["id"])
            scoped.append({"id": b["id"], "name": b["name"], "team": b.get("section", "")})
        except HTTPException:
            pass
    import json
    from core.untrusted import wrap_untrusted
    return ("You are this team's Chief of Staff. Delegate clear work, then end your turn. "
            "Handle incidents by explaining what the person needs to fix or retrying safe work. "
            "Use proposals for team changes. Escalations ask you to inform the person; never answer an approval gate.\n" +
            wrap_untrusted("team roster", json.dumps(scoped[:40], ensure_ascii=False)))
