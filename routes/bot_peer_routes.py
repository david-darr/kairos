"""Peer reach and the assignment tree. Static paths precede bot IDs."""
import contextlib
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from core import bot_assignments
from core.session_manager import session_manager
from services import bot_peers, bot_record
from services.agent_service import agent_service

router = APIRouter(tags=["bot-peers"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReachBody(Body):
    mode: Literal["all", "listed", "none"]
    peers: list[str] = Field(default_factory=list, max_length=100)
    acknowledge_scope: bool = False
    expected_revision: int = Field(ge=0)
    approve_peer_comms: bool | None = None


class LoopBody(Body):
    enabled: bool
    steer_at: int = Field(ge=2, le=1000)
    stop_at: int | None = Field(default=None, ge=2, le=1000)


class CancelBody(Body):
    expected_run_id: str | None = Field(default=None, max_length=80)


@contextlib.contextmanager
def guard():
    try:
        yield
    except bot_record.BotConflict as error:
        raise HTTPException(409, str(error))
    except bot_peers.StateUnavailable as error:
        raise HTTPException(503, str(error))
    except KeyError:
        raise HTTPException(404, "not found")
    except (ValueError, PermissionError) as error:
        raise HTTPException(400, str(error))


def owned_bot(bot_id, user):
    bot = agent_service.get(bot_id)
    if not bot or bot.get("owner_user") not in (None, user):
        raise KeyError(bot_id)
    return bot


def owned_assignment(aid, user):
    node = bot_assignments.get(aid)
    if not node:
        raise KeyError(aid)
    sid = node["requester"].get("session_id")
    session = session_manager.get_session(sid) if sid else None
    if not session or session.get("owner_user") not in (None, user):
        raise KeyError(aid)
    return node


@router.get("/api/bot-peers/loop-guard")
def get_loop(user: str = Depends(require_user)):
    with guard():
        return bot_peers.state()["loop_guard"]


@router.put("/api/bot-peers/loop-guard")
def put_loop(body: LoopBody, user: str = Depends(require_user)):
    with guard():
        return bot_peers.save_loop(body.model_dump())


@router.get("/api/bot-peers/{bot_id}/reach")
def get_reach(bot_id: str, user: str = Depends(require_user)):
    with guard():
        return bot_peers.view(owned_bot(bot_id, user))


@router.put("/api/bot-peers/{bot_id}/reach")
def put_reach(bot_id: str, body: ReachBody, user: str = Depends(require_user)):
    with guard():
        owned_bot(bot_id, user)
        return bot_peers.set_reach(bot_id, **body.model_dump())


@router.get("/api/bot-peers/{bot_id}/roster")
def get_roster(bot_id: str, user: str = Depends(require_user)):
    with guard():
        return {"peers": bot_peers.roster(owned_bot(bot_id, user))}


@router.get("/api/bot-assignments")
def list_assignments(bot_id: str | None = None, root_id: str | None = None, status: str | None = Query(default=None, max_length=30),
                     user: str = Depends(require_user)):
    with guard():
        if bot_id:
            owned_bot(bot_id, user)
        rows = []
        for node in bot_assignments.tree(root_id, bot_id=bot_id, status=status):
            try:
                owned_assignment(node["id"], user)
            except KeyError:
                continue
            rows.append(node)
        return {"assignments": rows}


@router.get("/api/bot-assignments/{aid}")
def get_assignment(aid: str, user: str = Depends(require_user)):
    with guard():
        return owned_assignment(aid, user)


@router.post("/api/bot-assignments/{aid}/cancel")
def cancel_assignment(aid: str, body: CancelBody, user: str = Depends(require_user)):
    with guard():
        node = owned_assignment(aid, user)
        from services.task_service import task_service
        live_run = (task_service.get_task(node.get("card_id")) or {}).get("run_id")
        if live_run != body.expected_run_id:
            raise HTTPException(409, "The assignment run changed. Reload it before stopping.")
        return bot_assignments.cancel(aid)


@router.post("/api/bot-assignments/{aid}/retry")
def retry_assignment(aid: str, user: str = Depends(require_user)):
    with guard():
        node = owned_assignment(aid, user)
        if node["status"] not in bot_assignments.TERMINAL:
            raise HTTPException(409, "Wait for this assignment to finish.")
        from services.agent_handoff import assign
        req = node["requester"]
        result = assign(req.get("bot_id"), node["assignee_bot_id"], node["brief"], req.get("session_id"),
                        uuid.uuid4().hex, mode=node["mode"], reply=node["reply"], title=node["title"],
                        reason=node["reason"], done_when=node["done_when"], rework=True, approved=True)
        if result.startswith("Assignment refused:"):
            raise HTTPException(409, result)
        return {"result": result}
