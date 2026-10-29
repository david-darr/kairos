"""Admin team surfaces. Owner comes only from authentication."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from core.middleware import require_admin
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
def listing(user: str = Depends(require_admin)):
    return {"departments": teams.list(user)}


@router.post("", status_code=201)
def create(body: Create, user: str = Depends(require_admin)):
    return teams.create(body.name, body.bot_ids, user)


@router.get("/{ident}")
def get(ident: str, user: str = Depends(require_admin)):
    return {**teams.get(ident, user), "members": teams.members(ident, user)}


@router.patch("/{ident}")
def edit(ident: str, body: Edit, user: str = Depends(require_admin)):
    team = teams.get(ident, user)
    return teams.rename(ident, body.name or team["name"], body.expected_revision, user, body.order)


@router.delete("/{ident}")
def delete(ident: str, user: str = Depends(require_admin)):
    return teams.delete(ident, user)


@router.get("/{ident}/instructions")
def instructions(ident: str, user: str = Depends(require_admin)):
    return teams.instructions(ident, user)


@router.put("/{ident}/instructions")
def put_instructions(ident: str, body: Instructions, user: str = Depends(require_admin)):
    return teams.put_instructions(ident, body.text, body.expected_hash, user)


@router.put("/{ident}/chief")
def chief(ident: str, body: Chief, user: str = Depends(require_admin)):
    return teams.set_chief(ident, body.bot_id, body.also_manages, user)


@router.get("/{ident}/memory")
def memory_list(ident: str, user: str = Depends(require_admin)):
    return memory.listing(ident, user)


@router.post("/{ident}/memory", status_code=201)
def memory_add(ident: str, body: MemoryFields, user: str = Depends(require_admin)):
    return memory.propose(ident, body.model_dump(), accept=True, user=user)


@router.patch("/{ident}/memory/{entry}")
def memory_edit(ident: str, entry: str, body: MemoryEdit, user: str = Depends(require_admin)):
    return memory.edit(ident, entry, body.model_dump(exclude_unset=True, exclude={"expected_revision"}),
                       body.expected_revision, user)


@router.delete("/{ident}/memory/{entry}")
def memory_delete(ident: str, entry: str, body: MemoryAction, user: str = Depends(require_admin)):
    return memory.action(ident, entry, "delete", body.expected_revision, user=user)


@router.post("/{ident}/memory/{entry}/{action}")
def memory_action(ident: str, entry: str, action: str, body: MemoryAction, user: str = Depends(require_admin)):
    return memory.action(ident, entry, action, body.expected_revision, user=user, restore_revision=body.restore_revision)


@router.post("/{ident}/bulk-preview")
def bulk_preview(ident: str, body: Bulk, user: str = Depends(require_admin)):
    from services import bot_team_changes
    return bot_team_changes.bulk_preview(ident, body.model_dump(exclude_unset=True, exclude={"expected_revisions"}), user)


@router.post("/{ident}/bulk-apply")
def bulk_apply(ident: str, body: Bulk, user: str = Depends(require_admin)):
    from services import bot_team_changes
    return bot_team_changes.bulk_apply(ident, body.model_dump(exclude_unset=True, exclude={"expected_revisions"}), body.expected_revisions, user)
