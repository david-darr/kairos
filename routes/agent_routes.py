"""Agents: identities, memory, goals, work and the inbox (services/agent_service.py).

Admin only: agents always run in Auto (David, 2026-10-05), so whoever directs
them is approving everything they do, the same rule as a chat's Auto mode."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import model_endpoints
from core.middleware import require_admin
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
    color: Optional[str] = None
    avatar: Optional[dict] = None
    enabled: Optional[bool] = None
    daily_run_cap: Optional[int] = None
    deliver_to_channel: Optional[str] = None
    integration_ids: Optional[list[str]] = None
    keep_signed_in: Optional[bool] = None
    memory_upkeep: Optional[bool] = None
    peers: Optional[list[str]] = None


class MemoryBody(BaseModel):
    text: str


class SoulApplyBody(BaseModel):
    expected_file_text: Optional[str]
    expected_revision: int


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
    owned = _owned(agent["id"])
    running = next((t for t in owned if t["schedule_kind"] == "card" and t.get("status") == "running"), None) \
        or next((t for t in owned if t["schedule_kind"] != "card" and t.get("run_started_at")), None)
    needs_you = len(person_inbox(agent["id"])) + sum(
        1 for t in owned if t["schedule_kind"] == "card" and t.get("status") == "review")
    may_run, why_not = agent_service.can_run(agent["id"])
    status = ("off" if not agent["enabled"] else "working" if running else "needs_you" if needs_you
              else "capped" if not may_run else "idle")
    return {**agent, "blurb": agent.get("blurb", ""), "soul": agent.get("soul"),
            "revision": agent.get("revision", 0),
            "status": status, "status_detail": running["name"] if running else why_not,
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


@router.get("")
async def list_agents(user: str = Depends(require_admin)) -> list[dict]:
    return [_summary(a) for a in agent_service.list_agents()]


@router.post("")
async def create_agent(body: AgentBody, user: str = Depends(require_admin)) -> dict:
    _check_endpoint(body.endpoint_id)
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None and k != "enabled"}
        return _summary(agent_service.create(fields.pop("name", ""), **fields))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/inbox")
async def whole_inbox(user: str = Depends(require_admin)) -> dict:
    """Everything waiting on the person, across agents: open items, plus
    agents' results waiting for review (read from the cards, not copied)."""
    reviews = [t for t in task_service.list_tasks()
               if t.get("agent_id") and t["schedule_kind"] == "card" and t.get("status") == "review"]
    from services.agent_handoff import person_inbox
    items = person_inbox()
    return {"items": items, "reviews": reviews, "count": len(items) + len(reviews)}


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
    }


@router.patch("/{agent_id}")
async def update_agent(agent_id: str, body: AgentBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    fields = body.model_dump(exclude_unset=True)
    _check_endpoint(fields.get("endpoint_id"))
    try:
        agent = agent_service.update(agent_id, **fields)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
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
    session = session_manager.create_session(f"Chat with {agent['name']}")
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
                                        weekdays=body.weekdays)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{agent_id}/cards")
async def add_card(agent_id: str, body: CardBody, user: str = Depends(require_admin)) -> dict:
    _require(agent_id)
    try:
        return task_service.create_task(body.name, body.prompt, "card", status=body.status or "ready",
                                        agent_id=agent_id)
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
