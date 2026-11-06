"""Per-turn tool tokens for Codex (roadmap phase 2, 2026-10-05; spec: the
vault note "Tool Registry - Phase 2 (Build Spec)").

Codex reaches JARVIS's tools by running mcp_servers/hive_mind_cli.py, which
posts to POST /api/tools/{name} (routes/tool_routes.py). Each Codex turn gets
its own token here, bound to that turn's chat: the session, whether the chat
is an admin's, the agent it belongs to, the model. The route trusts nothing
the model sends about who it is - only the token - and the token dies with
the turn (core/codex_brain.py revokes it in a finally) or after an hour.

This replaced two older credentials: the process-wide internal token, which
every Codex process held whoever was chatting, and a separate Google-only
chat token.
"""
import asyncio
import dataclasses
import secrets
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from core.constants import DATA_DIR
from core.turn_taint import TurnTaint

TOKEN_LIFETIME_SECONDS = 3600
SCREEN_ROOT = None  # override (tests); else the current account's computer/screens folder


def screen_root() -> Path:
    from core import accounts
    return Path(SCREEN_ROOT or accounts.path("computer", "screens"))


SCREEN_MAX_AGE_SECONDS = 86400


@dataclass(frozen=True)
class Grant:
    session_id: Optional[str]
    is_admin: bool
    agent_id: Optional[str]
    model: Optional[str]
    expires_at: float
    # One per turn, so reading untrusted content earlier in the turn makes
    # later sensitive tools ask, as in the other brains (core/turn_taint.py).
    turn_taint: TurnTaint
    screenshot_dir: str | None = None
    assignment_run_id: str | None = None
    source_card_id: str | None = None
    # 2026-10-15: one scoped MCP catalog per turn, discarded with its grant.
    integration_ids: tuple[str, ...] | None = None
    read_only: bool = False
    owner_user: str | None = None
    # The account whose data the turn's tool calls read and write (core/accounts.py): the one the turn ran
    # in when it was issued. core/middleware.py sets it for each call carrying this token.
    account: str | None = None
    mcp_catalog: dict = field(default_factory=dict, compare=False)
    mcp_lock: asyncio.Lock = field(default_factory=asyncio.Lock, compare=False)


_grants: dict[str, Grant] = {}


def issue(session_id: Optional[str], is_admin: bool, agent_id: Optional[str] = None,
          model: Optional[str] = None, integration_ids=None, read_only: bool = False) -> str:
    from core import runs, task_scope
    from services.agent_service import agent_service
    context = runs.current_for(session_id)
    active = agent_service._current.get() or {}
    now = time.time()
    for stale in [t for t, g in _grants.items() if g.expires_at < now]:
        revoke(stale)
    token = secrets.token_urlsafe(32)
    folder = str(screen_root() / secrets.token_hex(8))
    _grants[token] = Grant(session_id, bool(is_admin), agent_id, model, now + TOKEN_LIFETIME_SECONDS,
                           TurnTaint(), folder, context.run_id if context else None, active.get("card_id"),
                           tuple(integration_ids) if integration_ids is not None else None, read_only,
                           owner_user=task_scope.current_owner(agent_id), account=_turn_account())
    return token


def _turn_account():
    from core import accounts
    try:
        return accounts.effective_account()
    except accounts.NoAccount:
        return None


def issue_proxy(session_id, is_admin: bool, agent_id: str, model, integration_ids, lifetime: float = 1800) -> str:
    """A short-lived loopback capability for a bot's Claude MCP proxy (mcp_servers/bot_mcp_proxy.py).
    It carries no upstream credential: every call is judged afresh against the bot's current grants."""
    token = issue(session_id, is_admin, agent_id, model, integration_ids)
    grant = _grants[token]
    _grants[token] = dataclasses.replace(grant, expires_at=time.time() + lifetime)
    return token


def resolve(token: str) -> Optional[Grant]:
    grant = _grants.get(token or "")
    if grant is None or grant.expires_at < time.time():
        revoke(token)
        return None
    return grant


def revoke(token: str) -> None:
    grant = _grants.pop(token or "", None)
    if grant:
        grant.mcp_catalog.clear()
    if grant and grant.screenshot_dir:
        folder = safe_screenshot_dir(grant)
        if folder is None:
            return
        shutil.rmtree(folder, ignore_errors=True)


def safe_screenshot_dir(grant: Grant) -> Path | None:
    """Resolve a turn folder inside Kairos data before writing or deleting."""
    if not grant.screenshot_dir:
        return None
    folder = Path(grant.screenshot_dir)
    if not re.fullmatch(r"[0-9a-f]{16}", folder.name):
        return None
    from core import accounts
    if grant.account and not SCREEN_ROOT:  # the grant's own account, whoever is asking
        with accounts.as_account(grant.account):
            root = screen_root().resolve()
    else:
        root = screen_root().resolve()
    if Path(DATA_DIR).resolve() not in root.parents or folder.parent.resolve() != root:
        return None
    resolved = folder.resolve()
    return folder if root in resolved.parents else None


def sweep_screens() -> None:
    """Remove old turn images left behind by a crashed app."""
    root = screen_root()
    if not root.exists():
        return
    cutoff = time.time() - SCREEN_MAX_AGE_SECONDS
    for folder in root.iterdir():
        if not folder.is_dir() or not re.fullmatch(r"[0-9a-f]{16}", folder.name):
            continue
        if folder.stat().st_mtime >= cutoff:
            continue
        grant = Grant(None, False, None, None, 0, TurnTaint(), str(folder))
        if safe_screenshot_dir(grant) == folder:
            shutil.rmtree(folder, ignore_errors=True)
