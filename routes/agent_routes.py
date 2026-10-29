"""Agents: identities, memory, goals, work and the inbox (services/agent_service.py).

Admin only: agents always run in Auto (David, 2026-10-05), so whoever directs
them is approving everything they do, the same rule as a chat's Auto mode."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, StrictBool

from core import model_endpoints
from core.middleware import require_admin
from services import bot_avatar_service, bot_record, bot_threads
from services.agent_service import agent_service
from services.task_service import task_service

router = APIRouter(prefix="/api/agents", tags=["agents"])


class AgentBody(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    blurb: Optional[str] = None
    soul: Optional[str] = None
    instructions: Optional[str] = None
    endpoint_id: Optional[str] = None
    model_override: Optional[str] = None
    model_effort: Optional[str] = None
    color: Optional[str] = None
    avatar: Optional[dict] = None
    enabled: Optional[bool] = None
    daily_run_cap: Optional[int] = None
    deliver_to_channel: Optional[str] = None
    integration_ids: Optional[list[str]] = None
    keep_signed_in: Optional[bool] = None
    memory_upkeep: Optional[bool] = None
    peers: Optional[list[str]] = None
    # The Bots-mode fields (services/bot_record.py), checked there.
    section: Optional[str] = None
    origin: Optional[dict] = None
    fallback: Optional[list[dict]] = None
    cache_keep_warm: Optional[str] = None
    place: Optional[str] = None
    tool_scope: Optional[dict] = None
    connector_scopes: Optional[dict] = None
    always_allow: Optional[list[str]] = None
    outbound: Optional[dict] = None
    approval_mode: Optional[str] = None
    thread_limit: Optional[int] = None
    hidden: Optional[bool] = None
    # Phase 1 identity and preference fields, checked in services/bot_record.py.
    reply_style: Optional[str] = None
    notifications: Optional[StrictBool] = None
    speak_replies: Optional[StrictBool] = None
    voice_id: Optional[str] = None
    call_mode: Optional[str] = None
    skill_selection: Optional[dict] = None
    avatar_image: Optional[dict] = None
    mascot_expression: Optional[str] = None
    memory_enabled: Optional[StrictBool] = None
    helper_model: Optional[StrictBool] = None
    connector_tools: Optional[dict] = None
    grants_version: Optional[int] = None
    # Conflict-sensitive clients send the profile revision they last read.
    expected_revision: Optional[int] = None


class ConfiguredBody(BaseModel):
    profile: dict
    model: Optional[dict] = None
    approval_mode: Optional[str] = None
    integration_ids: Optional[list[str]] = None
    keep_signed_in: Optional[bool] = None
    memory_upkeep: Optional[bool] = None
    memory_seed: Optional[list[dict]] = None
    routines: Optional[list[dict]] = None
    use_defaults: bool = False
    origin: Optional[dict] = None
    memory_enabled: Optional[StrictBool] = None
    helper_model: Optional[StrictBool] = None
    connector_tools: Optional[dict] = None
    grants_version: Optional[int] = None


class DuplicateBody(BaseModel):
    name: Optional[str] = None


class OrderBody(BaseModel):
    ids: list[str]


class DefaultsBody(BaseModel):
    defaults: dict


class PresetBody(BaseModel):
    from_agent_id: Optional[str] = None
    preset: Optional[dict] = None


class ThreadCreateBody(BaseModel):
    title: Optional[str] = None
    folder_id: Optional[str] = None
    approval_mode: Optional[str] = None


class ThreadPatchBody(BaseModel):
    title: Optional[str] = None
    folder_id: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    snooze: Optional[str | float] = None
    approval_mode: Optional[str] = None
    place: Optional[str] = None
    unread: Optional[bool] = None
    timezone: Optional[str] = None
    main: Optional[bool] = None
    link: Optional[str] = None


class ThreadDeleteBody(BaseModel):
    thread_ids: list[str] = Field(min_length=1, max_length=bot_threads.MAX_DELETE_BATCH)


class FolderBody(BaseModel):
    name: str
    emoji: Optional[str] = None


class FolderPatchBody(BaseModel):
    name: Optional[str] = None
    emoji: Optional[str] = None


class MemoryBody(BaseModel):
    text: str


class SoulApplyBody(BaseModel):
    expected_file_text: Optional[str]
    expected_revision: int


class RollbackBody(BaseModel):
    expected_revision: int
    expected_file_text: Optional[str]


class UndoProposalBody(BaseModel):
    expected_revision: int


class AvatarImageBody(BaseModel):
    """Apply a staged picture (or reset with asset_id null) against the avatar snapshot."""
    model_config = {"extra": "forbid"}
    asset_id: Optional[str] = None
    shape: str = "circle"
    zoom: float = Field(default=1, ge=1, le=3)
    focus_x: float = Field(default=0.5, ge=0, le=1)
    focus_y: float = Field(default=0.5, ge=0, le=1)
    expected_snapshot: Optional[str] = None


class AvatarGenerateBody(BaseModel):
    model_config = {"extra": "forbid"}
    direction: str = Field(max_length=bot_avatar_service.MAX_DIRECTION_CHARS)
    snapshot: Optional[str] = None


class AvatarProviderBody(BaseModel):
    model_config = {"extra": "forbid"}
    kind: str
    key: str = Field(max_length=400)
    base_url: Optional[str] = Field(default=None, max_length=300)
    model: Optional[str] = Field(default=None, max_length=120)


class GoalBody(BaseModel):
    name: str
    prompt: str
    schedule_kind: str  # "daily" or "interval"
    run_time: Optional[str] = None
    interval_seconds: Optional[int] = None
    report_when: Optional[str] = None
    time_zone: Optional[str] = None
    weekdays: Optional[list[int]] = None


class CardBody(BaseModel):
    name: str
    prompt: str
    status: Optional[str] = "ready"


class AnswerBody(BaseModel):
    choice: str  # reply | dismiss
    text: Optional[str] = None


def _check_endpoint(endpoint_id: Optional[str]) -> None:
    if endpoint_id and model_endpoints.get_endpoint(endpoint_id) is None:
        raise HTTPException(status_code=400, detail="endpoint_id must name a model added in Settings")


def _owned(agent_id: str) -> list[dict]:
    return [t for t in task_service.list_tasks() if t.get("agent_id") == agent_id]


def _summary(agent: dict) -> dict:
    """The agent plus what its card on the Agents list shows."""
    from services.agent_handoff import person_inbox
    from services.chat_live import agent_activity
    owned = _owned(agent["id"])
    running = next((t for t in owned if t["schedule_kind"] == "card" and t.get("status") == "running"), None) \
        or next((t for t in owned if t["schedule_kind"] != "card" and t.get("run_started_at")), None)
    needs_you = len(person_inbox(agent["id"])) + sum(
        1 for t in owned if t["schedule_kind"] == "card" and t.get("status") == "review")
    chat = agent_activity(agent["id"])
    needs_you += int(bool(chat and chat["waiting"]))
    activity = ({"kind": "task", "working": True, "waiting": bool(chat and chat["waiting"]),
                 "name": running["name"], "detail": str(running.get("prompt") or "")[:240]}
                if running else chat)
    may_run, why_not = agent_service.can_run(agent["id"])
    status = ("off" if not agent["enabled"] else "working" if activity else "needs_you" if needs_you
              else "capped" if not may_run else "idle")
    # `instructions` is the old name of the one standing-instruction field: it
    # reads as the soul, so the older Agents tab shows (and edits) what is used.
    return {**agent, "blurb": agent.get("blurb", ""), "soul": agent.get("soul"),
            "instructions": agent.get("soul") or "", "revision": agent.get("revision", 0),
            "status": status, "status_detail": activity["name"] if activity else why_not, "activity": activity,
            "needs_you": needs_you, "runs_today": agent_service.runs_today(agent["id"])}


def _teams(agent_id: str) -> list[dict]:
    """The teams (Swarm companies) this agent sits on; none when Swarm is
    unavailable."""
    from services import swarm_service
    team = swarm_service.current
    if team is None or team.store is None:
        return []
    try:
        return team.store.teams_for_agent(agent_id)
    except Exception:
        return []


def _triggers(agent_id: str) -> list[dict]:
    from services.trigger_service import trigger_service
    return trigger_service.for_agent(agent_id)


def _team_change(agent: dict, deleted: bool = False) -> None:
    from services import swarm_service
    if swarm_service.current is not None:
        try:
            swarm_service.current.agent_changed(agent, deleted=deleted)
        except Exception:
            # Each team cycle refreshes its links first, so this is caught up.
            import logging
            logging.getLogger(__name__).exception("agents: could not update this agent's teams")


def _require(agent_id: str) -> dict:
    agent = agent_service.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


def _refused(error: ValueError) -> HTTPException:
    """A state refusal (a cap, an unavailable choice, the last visible bot) is
    409; bad input is 400. Both carry the usual `detail`."""
    return HTTPException(status_code=409 if isinstance(error, bot_record.BotConflict) else 400, detail=str(error))


@router.get("")
async def list_agents(user: str = Depends(require_admin)) -> list[dict]:
    return [_summary(a) for a in agent_service.list_agents()]


@router.post("")
async def create_agent(body: AgentBody, user: str = Depends(require_admin)) -> dict:
    _check_endpoint(body.endpoint_id)
    try:
        fields = {k: v for k, v in body.model_dump().items()
                  if v is not None and k not in ("enabled", "expected_revision")}
        return _summary(agent_service.create(fields.pop("name", ""), **fields))
    except ValueError as e:
        raise _refused(e)


@router.get("/inbox")
async def whole_inbox(user: str = Depends(require_admin)) -> dict:
    """Everything waiting on the person, across agents: open items, plus
    agents' results waiting for review (read from the cards, not copied)."""
    reviews = [t for t in task_service.list_tasks()
               if t.get("agent_id") and t["schedule_kind"] == "card" and t.get("status") == "review"]
    from services.agent_handoff import person_inbox
    items = person_inbox()
    return {"items": items, "reviews": reviews, "count": len(items) + len(reviews)}


@router.post("/configured")
async def create_configured(body: ConfiguredBody, user: str = Depends(require_admin)) -> dict:
    """One call makes a bot, its starting notes and its routines, or nothing:
    a failure undoes what was made (cleanup_errors lists anything that could
    not be undone). A routine that cannot be switched on is a warning."""
    payload = body.model_dump(exclude_unset=True)
    # A picture chosen before the bot exists sits in the owner's draft scope.
    draft = (payload.get("profile") or {}).pop("avatar_image", None)
    try:
        result = bot_record.create_configured(payload, owner_user=user)
    except bot_record.ConfiguredFailure as failure:
        return JSONResponse(status_code=failure.status,
                            content={"detail": failure.detail, "cleanup_errors": failure.cleanup_errors})
    agent, warnings = result["agent"], list(result["warnings"])
    if draft:
        try:
            bot_record.clean_field("avatar_image", draft)
            bot_avatar_service.adopt_draft(user, draft["asset_id"], agent["id"])
            agent = agent_service.update(agent["id"], avatar_image=draft)
        except ValueError as error:
            warnings.append(f"The picture was not added: {error}")
    return {"agent": _summary(agent), "routines": result["routines"], "warnings": warnings}


@router.post("/order")
async def order_agents(body: OrderBody, user: str = Depends(require_admin)) -> dict:
    try:
        agent_service.reorder(body.ids)
    except KeyError:
        raise HTTPException(status_code=404, detail="agent not found")
    except ValueError as e:
        raise _refused(e)
    return {"ok": True}


@router.get("/defaults")
async def get_defaults(user: str = Depends(require_admin)) -> dict:
    return bot_record.defaults_view([a["name"] for a in agent_service.list_agents()])


@router.put("/defaults")
async def put_defaults(body: DefaultsBody, user: str = Depends(require_admin)) -> dict:
    try:
        bot_record.write_defaults(body.defaults)
    except ValueError as e:
        raise _refused(e)
    return bot_record.defaults_view([a["name"] for a in agent_service.list_agents()])


@router.get("/presets")
async def get_presets(user: str = Depends(require_admin)) -> list[dict]:
    return bot_record.list_presets()


@router.post("/presets")
async def add_preset(body: PresetBody, user: str = Depends(require_admin)) -> dict:
    if (body.from_agent_id is None) == (body.preset is None):
        raise HTTPException(status_code=400, detail="send either from_agent_id or preset")
    try:
        preset = bot_record.preset_from_agent(_require(body.from_agent_id)) if body.from_agent_id else body.preset
        return bot_record.add_preset(preset)
    except ValueError as e:
        raise _refused(e)


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str, user: str = Depends(require_admin)) -> dict:
    if not bot_record.delete_preset(preset_id):
        raise HTTPException(status_code=404, detail="preset not found")
    return {"ok": True}


class ConversationAction(BaseModel):
    action: str


@router.get('/conversations')
async def conversations(user: str = Depends(require_admin)) -> dict:
    from core.agent_conversations import agent_threads
    return agent_threads(user, agent_service.list_agents())


@router.post('/conversations/{kind}/{ident}')
async def organize_conversation(kind: str, ident: str, body: ConversationAction, user: str = Depends(require_admin)) -> dict:
    from core import agent_conversations
    count = 0
    session_id = None
    if kind == 'agent':
        _require(ident)
        thread = agent_conversations.agent_threads(user, [agent_service.get(ident)])['agents'][0]
        count, session_id = thread['message_count'], thread['session_id']
    elif kind == 'team':
        from services import swarm_service
        if swarm_service.current is None:
            raise HTTPException(404, 'Teams unavailable')
        try: swarm_service.current.store.get_system(ident, owner=user)
        except Exception as error: raise HTTPException(404, 'Team not found') from error
    else:
        raise HTTPException(400, 'Choose an agent or team conversation')
    try: return agent_conversations.change(user, kind + ':' + ident, body.action, count, session_id)
    except ValueError as error: raise HTTPException(400, str(error)) from error


# -- avatar pictures and the saved image connection (declared before /{agent_id}) -----------------

async def _read_image_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > bot_avatar_service.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That picture is larger than 10 MB.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > bot_avatar_service.MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="That picture is larger than 10 MB.")
    return bytes(data)


def _image_response(data: bytes, mime: str) -> Response:
    return Response(content=data, media_type=mime, headers={
        "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox"})


def _avatar_failure(error: ValueError) -> HTTPException:
    if isinstance(error, bot_avatar_service.AvatarUnavailable):
        return HTTPException(status_code=502, detail=str(error))
    conflict = isinstance(error, (bot_record.BotConflict, bot_avatar_service.AvatarConflict))
    return HTTPException(status_code=409 if conflict else 400, detail=str(error))


@router.get("/section-modules")
async def section_modules(user: str = Depends(require_admin)) -> dict:
    """Which later-phase panel sections are installed (static/js/botsSection*.js), so the panel loads
    only files that exist and shows its own basics for the rest."""
    from pathlib import Path
    folder = Path(__file__).resolve().parent.parent / "static" / "js"
    return {"modules": sorted(p.stem[len("botsSection"):] for p in folder.glob("botsSection*.js") if p.stem != "botsSection")}


@router.get("/avatar-provider")
async def get_avatar_provider(user: str = Depends(require_admin)) -> dict:
    return bot_avatar_service.provider_state()


@router.put("/avatar-provider")
async def put_avatar_provider(body: AvatarProviderBody, user: str = Depends(require_admin)) -> dict:
    try:
        return bot_avatar_service.save_provider(body.kind, body.key, body.base_url, body.model)
    except ValueError as error:
        raise _avatar_failure(error)


@router.delete("/avatar-provider")
async def delete_avatar_provider(user: str = Depends(require_admin)) -> dict:
    return bot_avatar_service.clear_provider()


@router.post("/avatar-drafts")
async def upload_avatar_draft(request: Request, user: str = Depends(require_admin)) -> dict:
    try:
        return bot_avatar_service.store(bot_avatar_service.draft_scope(user), await _read_image_body(request))
    except ValueError as error:
        raise _avatar_failure(error)


@router.post("/avatar-drafts/generate")
async def generate_avatar_draft(body: AvatarGenerateBody, user: str = Depends(require_admin)) -> dict:
    try:
        return await bot_avatar_service.generate(bot_avatar_service.draft_scope(user), body.direction)
    except ValueError as error:
        raise _avatar_failure(error)


@router.get("/avatar-drafts/{asset_id}")
async def read_avatar_draft(asset_id: str, user: str = Depends(require_admin)) -> Response:
    try:
        return _image_response(*bot_avatar_service.read(bot_avatar_service.draft_scope(user), asset_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="picture not found")


@router.get("/{agent_id}")
async def get_agent(agent_id: str, user: str = Depends(require_admin)) -> dict:
    from services.agent_handoff import person_inbox
    agent = _require(agent_id)
    owned = _owned(agent_id)
    owned_ids = {t["id"] for t in owned}
    return {
        "agent": _summary(agent),
        "soul_file": agent_service.read_soul(agent_id),
        "memory": agent_service.read_memory(agent_id),
        "memory_upkeep_journal": agent_service.memory_upkeep_journal(agent_id),
        "setup_receipts": agent_service.setup_receipts(agent_id),
        "goals": [t for t in owned if t["schedule_kind"] != "card"],
        "cards": [t for t in owned if t["schedule_kind"] == "card"],
        "inbox": person_inbox(agent_id),
        "answered": agent_service.inbox(agent_id, status=None)[:20],
        "runs": [r for r in task_service.list_runs() if r["task_id"] in owned_ids][:50],
        "teams": _teams(agent_id),
        "triggers": _triggers(agent_id),
        "avatar_snapshot": bot_avatar_service.snapshot_of(agent),
    }


@router.patch("/{agent_id}")
async def update_agent(agent_id: str, body: AgentBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    fields = body.model_dump(exclude_unset=True)
    expected = fields.pop("expected_revision", None)
    _check_endpoint(fields.get("endpoint_id"))
    try:
        agent = agent_service.update(agent_id, expected_revision=expected, **fields)
    except ValueError as e:
        raise _refused(e)
    if "name" in fields or "role" in fields:
        _team_change(agent)
    return _summary(agent)


@router.get("/{agent_id}/soul")
async def read_soul(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    return agent_service.read_soul(agent_id)


@router.post("/{agent_id}/soul/apply")
async def apply_soul_file(agent_id: str, body: SoulApplyBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return agent_service.apply_soul_file(agent_id, body.expected_file_text, body.expected_revision)
    except ValueError as e:
        raise HTTPException(status_code=409 if "stale" in str(e) else 400, detail=str(e))


@router.post("/{agent_id}/soul/discard-file")
async def discard_soul_file(agent_id: str, body: SoulApplyBody, user: str = Depends(require_admin)) -> dict:
    """Put the stored standing instructions back over a hand edit of SOUL.md."""
    _require(agent_id)
    try:
        return agent_service.discard_soul_file(agent_id, body.expected_file_text, body.expected_revision)
    except ValueError as error:
        raise _refused(error)


@router.get("/{agent_id}/history/{history_id}")
async def profile_history_row(agent_id: str, history_id: str, user: str = Depends(require_admin)) -> dict:
    """One row with its full before and after, for a diff."""
    _require(agent_id)
    row = next((r for r in agent_service.profile_history(agent_id, 500, True)["rows"] if r["id"] == history_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="no history row with that id")
    return row


@router.get("/{agent_id}/memory/topics")
async def memory_topics(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    return {"topics": [{"name": name, "description": description} for name, description in agent_service.topic_index(agent_id)]}


@router.get("/{agent_id}/history")
async def profile_history(agent_id: str, limit: int = 100, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return agent_service.profile_history(agent_id, limit)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.post("/{agent_id}/history/{history_id}/rollback")
async def rollback_profile(agent_id: str, history_id: str, body: RollbackBody,
                           user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        agent = agent_service.rollback_profile(agent_id, history_id, body.expected_revision, body.expected_file_text)
    except KeyError:
        raise HTTPException(status_code=404, detail="no history row with that id")
    except ValueError as error:
        raise _refused(error)
    return {"agent": _summary(agent), "soul_file": agent_service.read_soul(agent_id)}


@router.post("/{agent_id}/proposals/{receipt_id}/undo")
async def undo_proposal(agent_id: str, receipt_id: str, body: UndoProposalBody,
                        user: str = Depends(require_admin)) -> dict:
    """Undo a change the bot made to itself, only while nothing changed after it."""
    _require(agent_id)
    try:
        receipt = agent_service.undo_profile_proposal(agent_id, receipt_id, body.expected_revision)
    except KeyError:
        raise HTTPException(status_code=404, detail="no change with that receipt")
    except ValueError as error:
        raise _refused(error)
    return {"receipt": receipt, "agent": _summary(agent_service.get(agent_id))}


@router.get("/{agent_id}/avatar-image/{asset_id}")
async def read_avatar_image(agent_id: str, asset_id: str, user: str = Depends(require_admin)) -> Response:
    _require(agent_id)
    try:
        return _image_response(*bot_avatar_service.read(bot_avatar_service.bot_scope(agent_id), asset_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="picture not found")


@router.post("/{agent_id}/avatar-image")
async def upload_avatar_image(agent_id: str, request: Request, user: str = Depends(require_admin)) -> dict:
    """Stage a picture for this bot. It is not shown until applied with PUT."""
    agent = _require(agent_id)
    try:
        staged = bot_avatar_service.store(bot_avatar_service.bot_scope(agent_id), await _read_image_body(request))
    except ValueError as error:
        raise _avatar_failure(error)
    return {**staged, "snapshot": bot_avatar_service.snapshot_of(agent)}


@router.post("/{agent_id}/avatar-image/generate")
async def generate_avatar_image(agent_id: str, body: AvatarGenerateBody, user: str = Depends(require_admin)) -> dict:
    agent = _require(agent_id)
    started = bot_avatar_service.snapshot_of(agent)
    try:
        staged = await bot_avatar_service.generate(bot_avatar_service.bot_scope(agent_id), body.direction)
    except ValueError as error:
        raise _avatar_failure(error)
    return {**staged, "snapshot": body.snapshot or started}


@router.put("/{agent_id}/avatar-image")
async def apply_avatar_image(agent_id: str, body: AvatarImageBody, user: str = Depends(require_admin)) -> dict:
    """Apply a staged picture and its framing, or reset to the bot's Kip (asset_id null)."""
    agent = _require(agent_id)
    if body.expected_snapshot and body.expected_snapshot != bot_avatar_service.snapshot_of(agent):
        raise HTTPException(status_code=409, detail="The look changed while this picture was being made. "
                                                   "Choose it again to use it.")
    try:
        if body.asset_id is None:
            updated = agent_service.update(agent_id, avatar_image=None, mascot_expression=None)
        else:
            updated = agent_service.update(agent_id, avatar_image=bot_avatar_service.framing(body.model_dump()))
    except ValueError as error:
        raise _refused(error)
    return _summary(updated)


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, user: str = Depends(require_admin)) -> dict:
    if _require(agent_id).get("builtin"):
        raise HTTPException(status_code=409, detail="this built-in bot cannot be deleted; archive it instead")
    if any(t.get("status") == "running" for t in _owned(agent_id) if t["schedule_kind"] == "card"):
        raise HTTPException(status_code=409, detail="this agent is working on something; wait for it to finish")
    from core.session_manager import session_manager
    from core import computer
    await computer.stop(f"agent:{agent_id}")
    removed = task_service.delete_agent_work(agent_id)
    session_manager.release_agent_chats(agent_id)
    agent_service.delete(agent_id)
    # Its team seats stay, as ordinary teammates under the same name.
    _team_change({"id": agent_id}, deleted=True)
    return {"ok": True, "removed_work": removed}


@router.post("/{agent_id}/forget-logins")
async def forget_logins(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        agent_service.forget_logins(agent_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True}


@router.post("/{agent_id}/chat")
async def start_chat(agent_id: str, user: str = Depends(require_admin)) -> dict:
    """A chat with the agent: its model, and its identity and notes as they
    are now, frozen for this chat."""
    from core.session_manager import session_manager
    agent = _require(agent_id)
    endpoint_id = agent_service.chat_endpoint(agent)
    if endpoint_id is None:
        raise HTTPException(status_code=400, detail="add a Claude connection in Settings, or pick this agent's model")
    session = session_manager.create_session(f"Chat with {agent['name']}", owner_user=user)
    session_manager.set_model_endpoint(session["id"], endpoint_id)
    # Agents always run in Auto, chats with them included.
    return agent_service.make_agent_chat(session["id"], agent)


@router.put("/{agent_id}/memory")
async def write_memory(agent_id: str, body: MemoryBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return {"memory": agent_service.write_memory(agent_id, body.text)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{agent_id}/memory/upkeep")
async def memory_upkeep_journal(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    return {"entries": agent_service.memory_upkeep_journal(agent_id)}


@router.post("/{agent_id}/memory/upkeep/{upkeep_id}/undo")
async def undo_memory_upkeep(agent_id: str, upkeep_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return agent_service.undo_memory_upkeep(agent_id, upkeep_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/{agent_id}/setup/{receipt_id}/undo")
async def undo_setup(agent_id: str, receipt_id: str, user: str = Depends(require_admin)) -> dict:
    """Undo one /setup change from the bot's profile (Agents 2.0, 2026-10-14)."""
    _require(agent_id)
    try:
        return agent_service.undo_setup(agent_id, receipt_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="no setup change with that receipt")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/{agent_id}/goals")
async def add_goal(agent_id: str, body: GoalBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    if body.schedule_kind not in ("daily", "interval"):
        raise HTTPException(status_code=400, detail="a goal runs daily or every so often")
    try:
        return task_service.create_task(body.name, body.prompt, body.schedule_kind, run_time=body.run_time,
                                        interval_seconds=body.interval_seconds, agent_id=agent_id,
                                        report_when=body.report_when, time_zone=body.time_zone,
                                        weekdays=body.weekdays, owner_user=user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{agent_id}/cards")
async def add_card(agent_id: str, body: CardBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return task_service.create_task(body.name, body.prompt, "card", status=body.status or "ready",
                                        agent_id=agent_id, owner_user=user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/inbox/{item_id}/answer")
async def answer(item_id: str, body: AnswerBody, user: str = Depends(require_admin)) -> dict:
    item = agent_service.get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="inbox item not found")
    if item["status"] != "open":
        raise HTTPException(status_code=409, detail="this has already been answered")
    try:
        return {"ok": True, "next": agent_service.answer_item(item_id, body.choice, body.text or "")}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{agent_id}/duplicate")
async def duplicate_agent(agent_id: str, body: Optional[DuplicateBody] = None,
                          user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return _summary(bot_record.duplicate(agent_id, body.name if body else None))
    except ValueError as e:
        raise _refused(e)


@router.get("/{agent_id}/overview")
async def agent_overview(agent_id: str, user: str = Depends(require_admin)) -> dict:
    return bot_record.overview(_require(agent_id))


@router.get("/{agent_id}/system-prompt")
async def agent_system_prompt(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    return agent_service.system_prompt(agent_id)


# -- threads: a bot's conversations are its sessions (services/bot_threads.py) ---

@router.get("/{agent_id}/threads")
async def list_threads(agent_id: str, include_archived: int = 0, user: str = Depends(require_admin)) -> dict:
    return bot_threads.list_threads(_require(agent_id), bool(include_archived))


@router.post("/{agent_id}/threads")
async def create_thread(agent_id: str, body: Optional[ThreadCreateBody] = None,
                        user: str = Depends(require_admin)) -> dict:
    body = body or ThreadCreateBody()
    try:
        return bot_threads.create_thread(_require(agent_id), user, body.title, body.folder_id, body.approval_mode)
    except ValueError as e:
        raise _refused(e)


@router.post("/{agent_id}/threads/delete")
async def delete_threads(agent_id: str, body: ThreadDeleteBody, user: str = Depends(require_admin)) -> dict:
    return await bot_threads.delete_threads(_require(agent_id), body.thread_ids)


@router.post("/{agent_id}/threads/follow-model")
async def threads_follow_model(agent_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return await bot_threads.follow_model(_require(agent_id))
    except ValueError as e:
        raise _refused(e)


@router.patch("/{agent_id}/threads/{session_id}")
async def patch_thread(agent_id: str, session_id: str, body: ThreadPatchBody,
                       user: str = Depends(require_admin)) -> dict:
    agent = _require(agent_id)
    try:
        return bot_threads.update_thread(agent, session_id, body.model_dump(exclude_unset=True))
    except KeyError:
        raise HTTPException(status_code=404, detail="thread not found")
    except ValueError as e:
        raise _refused(e)


@router.post("/{agent_id}/folders")
async def add_folder(agent_id: str, body: FolderBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return bot_threads.add_folder(agent_id, body.name, body.emoji)
    except ValueError as e:
        raise _refused(e)


@router.put("/{agent_id}/folders/order")
async def order_folders(agent_id: str, body: OrderBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return {"folders": bot_threads.order_folders(agent_id, body.ids)}
    except ValueError as e:
        raise _refused(e)


@router.patch("/{agent_id}/folders/{folder_id}")
async def patch_folder(agent_id: str, folder_id: str, body: FolderPatchBody,
                       user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return bot_threads.update_folder(agent_id, folder_id, body.model_dump(exclude_unset=True))
    except KeyError:
        raise HTTPException(status_code=404, detail="folder not found")
    except ValueError as e:
        raise _refused(e)


@router.delete("/{agent_id}/folders/{folder_id}")
async def delete_folder(agent_id: str, folder_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return bot_threads.delete_folder(agent_id, folder_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="folder not found")
