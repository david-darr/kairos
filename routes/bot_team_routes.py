"""Cross-team read model and team actions, kept separate from the U1 aggregator."""
import importlib

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from core.middleware import require_user
from services import bot_departments as teams
from services import bot_incidents

router = APIRouter(tags=["bot-teams"])
bot_incidents.start()


def optional(name):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as error:
        if error.name != name:
            raise
        return None


@router.get("/api/bot-team/map")
def team_map(user: str = Depends(require_user)):
    departments = teams.list(user)
    bots = []
    for bot in teams.service().list_agents():
        if bot.get("hidden") or (teams.owner(bot) != user):
            continue
        team = teams.team_of(bot["id"])
        bots.append({k: bot.get(k) for k in ("id", "name", "role", "section", "avatar", "endpoint_id",
                                            "model_override", "model_effort") } | {
            "department_id": team["id"] if team else None,
            "chief": bool(team and team.get("chief_bot_id") == bot["id"]),
            "status": "working" if teams.busy(bot) else "available" if bot.get("enabled", True) else "unavailable"})
    visible = {b["id"] for b in bots}
    assignments = optional("core.bot_assignments")
    edges = assignments.live_edges() if assignments else []
    # Never project an edge whose endpoints belong to another person.
    names = {b["id"]: b.get("name") for b in bots}
    # One edge shape for the map: core.bot_assignments.live_edges names the ends source and target.
    edges = [{**e, "source_bot_id": e["source"], "target_bot_id": e["target"], "source_name": names[e["source"]],
              "target_name": names[e["target"]]}
             for e in edges if e.get("target") in visible and e.get("source") in visible][:12]
    rooms_module = optional("services.bot_rooms")
    rooms = rooms_module.list_rooms(user) if rooms_module else []
    return {"departments": departments, "members": bots, "bots": bots, "rooms": rooms, "handoffs": edges}


@router.get("/api/bot-team/incidents")
def incidents(bot_id: str | None = None, user: str = Depends(require_user)):
    if bot_id:
        from services.bot_attention import require_bot
        require_bot(bot_id, user)
    return {"incidents": bot_incidents.listing(user, bot_id)}


@router.post("/api/bot-team/incidents/{ident}/retry")
async def retry(ident: str, user: str = Depends(require_user)):
    return await bot_incidents.retry_thread(ident, user=user)


@router.get("/api/bot-team/changes")
def changes(user: str = Depends(require_user)):
    from services import bot_team_changes
    return {"changes": bot_team_changes.listing(user)}


@router.post("/api/bot-team/changes/{ident}/{action}")
def change_action(ident: str, action: str, user: str = Depends(require_user)):
    from fastapi import HTTPException
    from services import bot_team_changes
    handler = {"apply": bot_team_changes.apply, "cancel": bot_team_changes.cancel, "undo": bot_team_changes.undo}.get(action)
    if not handler:
        raise HTTPException(404, "Team change action not found")
    return handler(ident, user)


class SetupPick(BaseModel):
    model_config = ConfigDict(extra="forbid")
    thread_id: str = Field(min_length=1, max_length=100)
    text: str | None = Field(default=None, min_length=1, max_length=1000)


@router.get("/api/bot-setup/{bot_id}/suggestions")
async def setup_suggestions(bot_id: str, user: str = Depends(require_user)):
    from services import bot_setup
    return bot_setup.suggestions(bot_id, user)


@router.get("/api/bot-setup/{bot_id}/request")
def setup_request(bot_id: str, user: str = Depends(require_user)):
    from services import bot_setup
    return bot_setup.request(bot_id, user)


@router.post("/api/bot-setup/{bot_id}/request")
async def setup_pick(bot_id: str, body: SetupPick, user: str = Depends(require_user)):
    from services import bot_setup
    return await bot_setup.pick(bot_id, body.thread_id, body.text, user)


@router.delete("/api/bot-setup/{bot_id}/request")
def setup_close(bot_id: str, user: str = Depends(require_user)):
    from services import bot_setup
    return bot_setup.close(bot_id, user)
