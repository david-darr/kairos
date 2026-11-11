"""Team surfaces. Owner comes only from authentication."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from core.middleware import require_user
from services import bot_departments as teams
from services import bot_team_memory as memory

router = APIRouter(prefix="/api/bot-departments", tags=["bot-teams"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Create(Body):
    name: str = Field(min_length=1, max_length=60)
    bot_ids: list[str] = Field(default_factory=list, max_length=100)


class Edit(Body):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    order: int | None = Field(default=None, ge=0, le=10000)
    expected_revision: int = Field(ge=1)


class Instructions(Body):
    text: str = Field(max_length=24000)
    expected_hash: str = Field(min_length=64, max_length=64)


class Chief(Body):
    bot_id: str | None = Field(default=None, max_length=100)
    also_manages: list[str] = Field(default_factory=list, max_length=100)


class MemoryFields(Body):
    kind: str = Field(max_length=20)
    name: str = Field(min_length=1, max_length=120)
    detail: str = Field(min_length=1, max_length=600)
    aliases: list[str] = Field(default_factory=list, max_length=8)
    key: str = Field(default="", max_length=240)
    pinned: bool = False
    source_quote: str = Field(default="", max_length=2000)


class MemoryEdit(Body):
    expected_revision: str = Field(min_length=64, max_length=64)
    kind: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    detail: str | None = Field(default=None, min_length=1, max_length=600)
    aliases: list[str] | None = Field(default=None, max_length=8)
    key: str | None = Field(default=None, max_length=240)
    pinned: bool | None = None


class MemoryAction(Body):
    expected_revision: str = Field(min_length=64, max_length=64)
    restore_revision: str | None = Field(default=None, min_length=64, max_length=64)


class Bulk(Body):
    approval_mode: str | None = Field(default=None, max_length=20)
    endpoint_id: str | None = Field(default=None, max_length=200)
    model_override: str | None = Field(default=None, max_length=200)
    model_effort: str | None = Field(default=None, max_length=40)
    expected_revisions: dict[str, int] = Field(default_factory=dict, max_length=100)


@router.get("")
def listing(user: str = Depends(require_user)):
    return {"departments": teams.list(user)}


@router.post("", status_code=201)
def create(body: Create, user: str = Depends(require_user)):
    return teams.create(body.name, body.bot_ids, user)


@router.get("/{ident}")
def get(ident: str, user: str = Depends(require_user)):
    return {**teams.get(ident, user), "members": teams.members(ident, user)}


@router.patch("/{ident}")
def edit(ident: str, body: Edit, user: str = Depends(require_user)):
    team = teams.get(ident, user)
    return teams.rename(ident, body.name or team["name"], body.expected_revision, user, body.order)


@router.delete("/{ident}")
def delete(ident: str, user: str = Depends(require_user)):
    return teams.delete(ident, user)


class ModelPick(Body):
    endpoint_id: str = Field(min_length=1, max_length=200)
    model_override: str | None = Field(default=None, max_length=200)
    model_effort: str | None = Field(default=None, max_length=40)


class ApplyModels(Body):
    models: dict[str, ModelPick] = Field(max_length=100)


@router.get("/{ident}/models")
def model_suggestion(ident: str, user: str = Depends(require_user)):
    """Suggest models: the team's tier map turned into models from this account's connections. A proposal only;
    nothing changes until the person applies it."""
    from services import bot_model_tiers
    return {"team": teams.get(ident, user)["name"], **bot_model_tiers.suggest(teams.members(ident, user), _tiers(ident, user))}


@router.post("/{ident}/models")
def apply_models(ident: str, body: ApplyModels, user: str = Depends(require_user)):
    """Apply the models the person picked, member by member. Each pick must be a connection this account has."""
    from fastapi import HTTPException
    from services import bot_model_tiers
    from services.agent_service import agent_service
    members = {b["id"]: b for b in teams.members(ident, user)}
    if set(body.models) - set(members):
        raise HTTPException(400, "Pick models for this team's bots only")
    checked = {}
    try:
        for bot_id, pick in body.models.items():
            checked[bot_id] = bot_model_tiers.check_choice(pick.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    changed = []
    for bot_id, model in checked.items():
        agent_service.update(bot_id, endpoint_id=model["endpoint_id"], model_override=model["model_override"],
                             model_effort=model["model_effort"])
        changed.append(bot_id)
    return {"changed": changed, **bot_model_tiers.suggest(teams.members(ident, user), _tiers(ident, user))}


def _tiers(ident, user):
    """Each member's tier: the one its template gave it, else for a Content Studio bot the role's tier."""
    team = teams.get(ident, user)
    tiers = dict(team.get("model_tiers") or {})
    try:
        from services.content_studio import studio, team as studio_team
        from services.studio_team_package import TIERS_BY_ROLE
        for bot in teams.members(ident, user):
            role = studio_team.role_of(studio, bot["id"])
            if bot["id"] not in tiers and role in TIERS_BY_ROLE:
                tiers[bot["id"]] = TIERS_BY_ROLE[role]
    except Exception:
        pass
    return tiers


class Flags(Body):
    paused: bool | None = None
    hands_off: bool | None = None


@router.put("/{ident}/flags")
def set_flags(ident: str, body: Flags, user: str = Depends(require_user)):
    """Pause team and hands-off posting, by the person's click. For the Content Studio team the same switches drive
    Studio's posting (services/content_studio/handsoff.py), so both places always agree."""
    team = teams.get(ident, user)
    try:
        from services.content_studio import handsoff, studio, team as studio_team
        producer = studio_team.producer_id(studio)
        found = teams.team_of(producer) if producer else None
        if found and found["id"] == team["id"]:
            if body.paused is not None:
                handsoff.set_paused(studio, body.paused, user)
            if body.hands_off is not None:
                handsoff.set_hands_off(studio, body.hands_off, user)
            return teams.get(ident, user)
    except ImportError:
        pass
    return teams.set_flags(ident, user, paused=body.paused, hands_off=body.hands_off)


@router.get("/{ident}/instructions")
def instructions(ident: str, user: str = Depends(require_user)):
    return teams.instructions(ident, user)


@router.put("/{ident}/instructions")
def put_instructions(ident: str, body: Instructions, user: str = Depends(require_user)):
    return teams.put_instructions(ident, body.text, body.expected_hash, user)


@router.put("/{ident}/chief")
def chief(ident: str, body: Chief, user: str = Depends(require_user)):
    return teams.set_chief(ident, body.bot_id, body.also_manages, user)


@router.get("/{ident}/memory")
def memory_list(ident: str, user: str = Depends(require_user)):
    return memory.listing(ident, user)


@router.post("/{ident}/memory", status_code=201)
def memory_add(ident: str, body: MemoryFields, user: str = Depends(require_user)):
    return memory.propose(ident, body.model_dump(), accept=True, user=user)


@router.patch("/{ident}/memory/{entry}")
def memory_edit(ident: str, entry: str, body: MemoryEdit, user: str = Depends(require_user)):
    return memory.edit(ident, entry, body.model_dump(exclude_unset=True, exclude={"expected_revision"}),
                       body.expected_revision, user)


@router.delete("/{ident}/memory/{entry}")
def memory_delete(ident: str, entry: str, body: MemoryAction, user: str = Depends(require_user)):
    return memory.action(ident, entry, "delete", body.expected_revision, user=user)


@router.post("/{ident}/memory/{entry}/{action}")
def memory_action(ident: str, entry: str, action: str, body: MemoryAction, user: str = Depends(require_user)):
    return memory.action(ident, entry, action, body.expected_revision, user=user, restore_revision=body.restore_revision)


@router.post("/{ident}/bulk-preview")
def bulk_preview(ident: str, body: Bulk, user: str = Depends(require_user)):
    from services import bot_team_changes
    return bot_team_changes.bulk_preview(ident, body.model_dump(exclude_unset=True, exclude={"expected_revisions"}), user)


@router.post("/{ident}/bulk-apply")
def bulk_apply(ident: str, body: Bulk, user: str = Depends(require_user)):
    from services import bot_team_changes
    return bot_team_changes.bulk_apply(ident, body.model_dump(exclude_unset=True, exclude={"expected_revisions"}), body.expected_revisions, user)
