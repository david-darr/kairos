"""Bot skills: private skills, the shared library and learned-skill requests (Phase 2, unit U3).

Mounted beneath /api/bots by the Phase 2 aggregate router. Admin only. Library routes are declared
before the bot-id routes so a fixed word is never read as a bot id. Bodies are bounded and refuse
unknown fields; mutations carry the revision or hash the person reviewed.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_admin
from services import (bot_skill_import, bot_skill_learning, bot_skill_library, bot_skill_review, bot_skill_sharing,
                      bot_skills)
from services.agent_service import agent_service
from services.bot_skills import SkillError

router = APIRouter(prefix="/api/bots", tags=["bot-skills"], dependencies=[Depends(require_admin)])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ImportBody(Body):
    source: Optional[str] = Field(None, max_length=2048)
    content: Optional[str] = Field(None, max_length=300_000)
    filename: Optional[str] = Field(None, max_length=200)


class SkillPatch(Body):
    expected_revision: str = Field(max_length=100)
    enabled: Optional[bool] = None
    reviewed_sha256: Optional[str] = Field(None, max_length=64)


class TemplateBody(Body):
    name: str = Field(max_length=64)
    description: str = Field(max_length=1024)
    instructions: str = Field(max_length=16000)
    expected_revision: str = Field("absent", max_length=100)


class LibraryPatch(Body):
    expected_revision: str = Field(max_length=100)
    enabled: Optional[bool] = None
    reviewed_sha256: Optional[str] = Field(None, max_length=64)
    tags: Optional[list[str]] = Field(None, max_length=8)
    every_bot: Optional[bool] = None


class AssignBody(Body):
    skills: list[str] = Field(max_length=100)
    expected_revision: int


class StageBody(Body):
    name: str = Field(max_length=64)
    skill_md: str = Field(max_length=bot_skill_learning.MAX_STAGED * 2)
    references: dict[str, str] = Field(default_factory=dict, max_length=8)
    gist: str = Field("", max_length=500)


class ActionBody(Body):
    reviewed_sha256: Optional[str] = Field(None, max_length=64)
    expected_base_revision: Optional[str] = Field(None, max_length=100)
    audience: str = Field("library", max_length=64)
    note: str = Field("", max_length=300)
    expected_revision: str = Field("absent", max_length=100)


class SettingsBody(Body):
    review_enabled: Optional[bool] = None
    review_steps: Optional[int] = None
    sharing: Optional[str] = Field(None, max_length=8)


def fail(error):
    return HTTPException(status_code=getattr(error, "status", 400), detail=str(error))


def bot(bot_id):
    try:
        bot_skills.ident(bot_id)
    except SkillError as error:
        raise fail(error)
    if agent_service.get(bot_id) is None:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot_id


def guarded(call):
    try:
        return call()
    except SkillError as error:
        raise fail(error)


# -- the shared library --------------------------------------------------------------------------

@router.get("/skills-library")
async def list_library(query: str = "", tag: str = ""):
    return guarded(lambda: {"skills": bot_skill_library.list_all(query[:200], tag[:40]),
                            "assignments": bot_skill_library.assignments(), "pending_shares": bot_skill_sharing.pending_shares()})


@router.post("/skills-library")
async def add_to_library(body: ImportBody):
    if body.source:
        return guarded(lambda: bot_skill_import.import_source_to_library(body.source))
    return guarded(lambda: bot_skill_import.import_text_to_library(body.content, body.filename))


@router.post("/skills-library/migrate-global")
async def migrate_global():
    return guarded(bot_skill_library.migrate_global)


@router.get("/skills-library/{skill_name}")
async def library_skill(skill_name: str):
    return guarded(lambda: {**bot_skill_library.get(skill_name), "revisions": bot_skill_library.revisions(skill_name)})


@router.patch("/skills-library/{skill_name}")
async def patch_library_skill(skill_name: str, body: LibraryPatch):
    def change():
        revision = body.expected_revision
        if body.enabled is not None:
            revision = bot_skill_library.set_enabled(skill_name, body.enabled, expected_revision=revision,
                                                     reviewed_sha256=body.reviewed_sha256)["storage_revision"]
        if body.tags is not None or body.every_bot is not None:
            bot_skill_library.update(skill_name, expected_revision=revision, tags=body.tags, every_bot=body.every_bot)
        return bot_skill_library.get(skill_name)
    return guarded(change)


@router.delete("/skills-library/{skill_name}")
async def retire_library_skill(skill_name: str, expected_revision: str):
    return guarded(lambda: bot_skill_library.retire(skill_name, expected_revision=expected_revision))


@router.post("/shares/{request_id}/{action}")
async def answer_share(request_id: str, action: str):
    if action not in {"approve", "deny"}:
        raise HTTPException(status_code=404, detail="Unknown action.")
    return guarded(lambda: bot_skill_sharing.decide(request_id, action == "approve"))


# -- one bot's skills ----------------------------------------------------------------------------

def row(value):
    result = {k: v for k, v in value.items() if k not in bot_skill_library.TEXT_FIELDS}
    result["reference_names"] = sorted(value["references"])
    return result


@router.get("/{bot_id}/skills")
async def list_skills(bot_id: str):
    bot(bot_id)

    def build():
        private = bot_skills.list_private(bot_id)
        shadowed = {s["name"] for s in private}
        library = [row(s) for s in bot_skill_library.assigned(bot_id) if s["name"] not in shadowed]
        return {"skills": [row(s) for s in private], "library": library,
                "requests": bot_skill_learning.list_cards(bot_id), "notes": bot_skill_sharing.notes_for(bot_id),
                "settings": {**bot_skill_review.settings(bot_id), "sharing": bot_skill_sharing.mode(bot_id)}}
    return guarded(build)


@router.post("/{bot_id}/skills")
async def import_skill(bot_id: str, body: ImportBody):
    bot(bot_id)
    if body.source:
        return guarded(lambda: bot_skill_import.import_source(bot_id, body.source))
    return guarded(lambda: bot_skill_import.import_text(bot_id, body.content, body.filename))


@router.get("/{bot_id}/skills/{skill_name}")
async def inspect_skill(bot_id: str, skill_name: str):
    bot(bot_id)
    return guarded(lambda: bot_skills.inspect(bot_id, skill_name))


@router.patch("/{bot_id}/skills/{skill_name}")
async def patch_skill(bot_id: str, skill_name: str, body: SkillPatch):
    bot(bot_id)
    if body.enabled is None:
        raise HTTPException(status_code=400, detail="Nothing to change.")
    return guarded(lambda: bot_skills.set_enabled(bot_id, skill_name, body.enabled, expected_revision=body.expected_revision,
                                                  reviewed_sha256=body.reviewed_sha256))


@router.delete("/{bot_id}/skills/{skill_name}")
async def retire_skill(bot_id: str, skill_name: str, expected_revision: str):
    bot(bot_id)
    return guarded(lambda: bot_skills.retire(bot_id, skill_name, expected_revision=expected_revision))


@router.post("/{bot_id}/skill-template")
async def written_command(bot_id: str, body: TemplateBody):
    bot(bot_id)
    return guarded(lambda: bot_skills.written_command(bot_id, body.name, body.description, body.instructions,
                                                      expected_revision=body.expected_revision))


@router.put("/{bot_id}/skills-library")
async def assign_library(bot_id: str, body: AssignBody):
    bot(bot_id)
    return guarded(lambda: bot_skill_library.assign(bot_id, body.skills, expected_revision=body.expected_revision))


@router.patch("/{bot_id}/skill-settings")
async def skill_settings(bot_id: str, body: SettingsBody):
    bot(bot_id)

    def change():
        if body.review_enabled is not None or body.review_steps is not None:
            bot_skill_review.set_settings(bot_id, enabled=body.review_enabled, steps=body.review_steps)
        if body.sharing is not None:
            bot_skill_sharing.set_mode(bot_id, body.sharing)
        return {**bot_skill_review.settings(bot_id), "sharing": bot_skill_sharing.mode(bot_id)}
    return guarded(change)


# -- learned-skill requests ----------------------------------------------------------------------

@router.get("/{bot_id}/skill-requests")
async def list_requests(bot_id: str, closed: bool = False):
    bot(bot_id)
    return guarded(lambda: {"requests": bot_skill_learning.list_cards(bot_id, include_closed=closed)})


@router.post("/{bot_id}/skill-requests")
async def stage_request(bot_id: str, body: StageBody):
    """Save as skill: a person-written bundle staged for the same review as a bot's proposal."""
    bot(bot_id)
    return guarded(lambda: bot_skill_learning.stage(bot_id, body.name, body.skill_md, references=body.references,
                                                    gist=body.gist, source="saved by you", actor="person"))


@router.post("/{bot_id}/skill-requests/{request_id}/{action}")
async def act_on_request(bot_id: str, request_id: str, action: str, body: ActionBody = ActionBody()):
    bot(bot_id)

    def act():
        if action == "apply":
            if not body.reviewed_sha256:
                raise SkillError("Send the hash of the text you reviewed.")
            return {"receipt": bot_skill_learning.apply(bot_id, request_id, reviewed_sha256=body.reviewed_sha256,
                                                        expected_base_revision=body.expected_base_revision),
                    "request": bot_skill_learning.get_card(bot_id, request_id)}
        if action == "undo":
            return {"receipt": bot_skill_learning.undo(bot_id, request_id), "request": bot_skill_learning.get_card(bot_id, request_id)}
        if action == "deny":
            return {"request": bot_skill_learning.deny(bot_id, request_id)}
        if action == "retry":
            return {"request": bot_skill_learning.retry(bot_id, request_id)}
        if action == "share":
            card = bot_skill_learning.get_card(bot_id, request_id)
            if card["status"] != "applied":
                raise SkillError("Apply the skill before sharing it.", 409)
            return bot_skill_sharing.share(bot_id, card["name"], audience=body.audience, actor="person", note=body.note,
                                           expected_revision=body.expected_revision)
        raise HTTPException(status_code=404, detail="Unknown action.")
    return guarded(act)
