"""The Bots sidebar's one poll (static/js/botsRail.js).

The sidebar used to re-fetch the whole bot list (132 KB at 100 bots), the automations list (102 KB, 541 KB with
a month of run history), the team map (65 KB), the conversations list and the needs-you rows every 10 seconds,
whether or not anything had changed: 2.5 MB a minute with one window open (100-bot scale test, 2026-11-10).

GET /api/bot-pulse?agents=V&conversations=V&team=V&automations=V answers with each list's version (a hash of
what the list's own route returns), how many items need the person, and only the lists whose version differs
from the one the window already holds. `only=agents` (a comma list) reads just those lists and leaves the
needs-you count out: the Bots home grid polls the bot list this way. A window that holds nothing (its first read, or after a change it made
itself) passes no versions and gets every list. Each list is the exact body of its route
(/api/agents, /api/agents/conversations, /api/bot-team/map, /api/bot-automations), so the window treats both
the same; a list that fails here is left out with a null version, and the window keeps what it has.
"""
import asyncio
import hashlib
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.encoders import jsonable_encoder

from core.middleware import require_user

logger = logging.getLogger(__name__)
router = APIRouter(tags=["bots"])
PARTS = ("agents", "conversations", "team", "automations")


def version_of(body) -> str:
    """A stable short hash of a JSON body."""
    blob = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:20]


async def _read(part: str, user: str):
    from routes import agent_routes, bot_routine_routes, bot_team_routes
    if part == "agents":
        return await agent_routes.list_agents(user)
    if part == "conversations":
        return await agent_routes.conversations(user)
    if part == "team":
        return await asyncio.to_thread(bot_team_routes.team_map, user)
    return await bot_routine_routes.automations(user)


@router.get("/api/bot-pulse")
async def pulse(agents: Optional[str] = Query(None, max_length=64),
                conversations: Optional[str] = Query(None, max_length=64),
                team: Optional[str] = Query(None, max_length=64), automations: Optional[str] = Query(None, max_length=64),
                only: Optional[str] = Query(None, max_length=100), user: str = Depends(require_user)) -> dict:
    held = {"agents": agents, "conversations": conversations, "team": team, "automations": automations}
    wanted = [p for p in PARTS if p in (only or "").split(",")] if only else list(PARTS)
    reply: dict = {"versions": {}}
    for part in wanted:
        try:
            body = jsonable_encoder(await _read(part, user))
        except Exception:
            logger.exception("bot pulse: %s could not be read", part)
            reply["versions"][part] = None
            continue
        current = version_of(body)
        reply["versions"][part] = current
        if held[part] != current:
            reply[part] = body
    if only:
        return reply
    try:
        from services import bot_attention
        reply["needs_you"] = len((await asyncio.to_thread(bot_attention.needs_you, user))["rows"])
    except Exception:
        logger.exception("bot pulse: the needs-you count could not be read")
        reply["needs_you"] = None
    return reply
