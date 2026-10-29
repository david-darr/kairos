"""Approval policy for bots (Bots redesign, Phase 3 unit U1, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 4.1, 5.1 and 5.2.

A bot works at one of five approval levels, stored on the bot and optionally overridden per
conversation (`thread.approval_mode`, null follows the bot):

  ask    reads proceed; changes and running things ask
  edits  file edits in the bot's own folders proceed; running things and outside changes ask
  auto   a bounded reviewer may allow safe operations; anything it doubts asks
  full   authorized actions proceed without asking (the default; bots send on their own)
  custom Codex's reviewed policy: exact grants, everything else asks

This module only DECIDES. core/permissions.py calls authorize_operation() inside decide(), after the
grant ceiling (services/bot_grants.py), so an approval level can only narrow what the ceiling allows.
Nothing here runs a tool, asks a person or answers a card.

Order at each action boundary (design 5.1): resolve the bot, thread and run from trusted state;
confine a read-and-draft run; classify the operation; apply explicit-review exceptions and the
outbound allowance; apply exact grants and the selected level; otherwise ask.

Also kept here, because they are the same security record: the policy revision, the verified level of
each bot and thread (a level written behind this module's back is not honoured), exact command
rules, the desktop elevation handshake, and the redacted decision history.
"""
from __future__ import annotations

import contextvars
import csv
import io
import json
import logging
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

from core import bot_outbound
from core import bot_tool_catalog as catalog
from core.atomic_io import write_json_atomic
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

MODES = ("ask", "edits", "auto", "full", "custom")
DEFAULT_MODE = "full"
RANK = {"ask": 0, "custom": 0.5, "edits": 1, "auto": 2, "full": 3}
LABELS = {"ask": "Ask", "edits": "Edits", "auto": "Auto", "full": "Full", "custom": "Custom"}
MODE_BLURB = {
    "ask": "Reads go ahead. Changes and running things ask you first.",
    "edits": "Edits to its own folders go ahead. Running things and outside changes ask.",
    "auto": "A careful reviewer allows safe steps. Anything it doubts asks you.",
    "full": "Goes ahead without asking, including sending on its own.",
    "custom": "Codex only. Exact commands you have approved go ahead. Everything else asks.",
}
SCOPES = ("bot", "thread", "all_threads")

STATE_FILE = os.path.join(DATA_DIR, "bot_approval_state.json")
DECISIONS_DIR = os.path.join(DATA_DIR, "bot_decisions")
STATE_VERSION = 1
DECISION_RETENTION_DAYS = 180
ELEVATION_SECONDS = 300
MAX_COMMAND_RULES = 200
MAX_COMMAND_CHARS = 16 * 1024
INFLIGHT_SECONDS = 120
UNATTENDED_WAIT_SECONDS = 3600

# Operation kinds (the canonical metadata Phase 2's authorize_call also speaks).
READ, DRAFT, EDIT, EXECUTE, OUTBOUND, DESTRUCTIVE, OPAQUE = (
    "read", "draft", "edit", "execute", "outbound", "destructive", "opaque")
KINDS = (READ, DRAFT, EDIT, EXECUTE, OUTBOUND, DESTRUCTIVE, OPAQUE)

_LOCK = threading.RLock()


class PolicyError(Exception):
    """Base class; `status` is the HTTP status a route should use."""
    status = 400


class NotFound(PolicyError):
    status = 404


class ElevationNeeded(PolicyError):
    status = 409


class StaleRevision(PolicyError):
    status = 409


class StateCorrupt(PolicyError):
    status = 409


# -- the trusted turn ------------------------------------------------------------------------

_TURN: contextvars.ContextVar = contextvars.ContextVar("bot_turn", default=None)


@contextmanager
def bind_turn(trusted_context: dict):
    """Bind the trusted context of one bot turn: {bot_id, owner, session_id, provider, unattended,
    run_id, access}. The Phase 1 turn host calls this at admission; it never comes from model
    arguments. Execution permissions given inside it expire when the turn ends."""
    scope = {**(trusted_context or {}), "active": True}
    token = _TURN.set(scope)
    try:
        yield scope
    finally:
        scope["active"] = False
        _TURN.reset(token)


def current_turn() -> Optional[dict]:
    scope = _TURN.get()
    return dict(scope) if scope and scope.get("active") else None


def run_context(bot_id: Optional[str] = None) -> Optional[dict]:
    """The unattended routine run this code is inside (core/bot_routine_runner.py), or None."""
    try:
        from core import bot_routine_runner
        run = bot_routine_runner.current_run()
    except Exception:
        return None
    if run and (bot_id is None or run.get("bot_id") in (None, bot_id)):
        return run
    return None


def cards():
    """The durable card service (services/bot_cards.py), or None while it is not installed."""
    try:
        from services import bot_cards
        return bot_cards.store()
    except Exception:
        return None


# -- state: revisions, verified levels, command rules, elevations --------------------------------

_state_cache: dict = {"path": None, "mtime": None, "data": None, "corrupt": False}
_started: set = set()


def _empty_state() -> dict:
    return {"version": STATE_VERSION, "revisions": {}, "committed": {}, "grants": [], "commands": {},
            "elevations": {}, "migrated": []}


def _read_state() -> tuple[dict, bool]:
    """(state, corrupt). A file that exists but will not parse disables remembered grants and
    refuses writes: it is never silently replaced with an empty one."""
    path = STATE_FILE
    try:
        stamp = os.stat(path).st_mtime_ns
    except OSError:
        stamp = None
    if _state_cache["path"] == path and _state_cache["mtime"] == stamp and _state_cache["data"] is not None:
        return _state_cache["data"], _state_cache["corrupt"]
    data, corrupt = _empty_state(), False
    if stamp is not None:
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                loaded = json.load(handle)
            if not isinstance(loaded, dict) or not isinstance(loaded.get("version"), int):
                raise ValueError("not a state file")
            data = {**_empty_state(), **loaded}
            for key, kind in (("revisions", dict), ("committed", dict), ("grants", list), ("commands", dict),
                              ("elevations", dict), ("migrated", list)):
                if not isinstance(data[key], kind):
                    raise ValueError(f"{key} is damaged")
        except (OSError, ValueError):
            data, corrupt = _empty_state(), True
            logger.error("bot approval state is unreadable; remembered grants are off and writes are refused")
    _state_cache.update(path=path, mtime=stamp, data=data, corrupt=corrupt)
    return data, corrupt


def state_corrupt() -> bool:
    return _read_state()[1]


def _write_state(data: dict) -> None:
    write_json_atomic(STATE_FILE, data)
    try:
        stamp = os.stat(STATE_FILE).st_mtime_ns
    except OSError:
        stamp = None
    _state_cache.update(path=STATE_FILE, mtime=stamp, data=data, corrupt=False)


@contextmanager
def _mutate():
    """Read, change and write the state under one lock. Refused when the file is corrupt."""
    with _LOCK:
        data, corrupt = _read_state()
        if corrupt:
            raise StateCorrupt("Approval settings could not be read, so changes are paused. "
                               "Restore or remove bot_approval_state.json and try again.")
        data = json.loads(json.dumps(data))
        _revoke_incomplete_locked(data)
        yield data
        _write_state(data)


def _revoke_incomplete_locked(data: dict) -> None:
    """A handshake that never finished is not a grant: dropped at startup and when it expires."""
    now = time.time()
    first = STATE_FILE not in _started
    _started.add(STATE_FILE)
    for rid, item in list(data["elevations"].items()):
        if item.get("phase") == "committed":
            if now - item.get("committed_at", now) > 3600:
                data["elevations"].pop(rid, None)
        elif first or item.get("expires_at", 0) < now:
            data["elevations"].pop(rid, None)


def revoke_incomplete_elevations() -> int:
    """Startup: every handshake that is not committed is revoked."""
    data, corrupt = _read_state()
    if corrupt:
        return 0
    waiting = [k for k, v in data["elevations"].items() if v.get("phase") != "committed"]
    try:
        with _mutate() as fresh:
            for key in waiting:
                fresh["elevations"].pop(key, None)
    except StateCorrupt:
        return 0
    return len(waiting)


def revision(bot_id: str) -> int:
    return int(_read_state()[0]["revisions"].get(bot_id, 0))


def _key(bot_id: str, thread_id: Optional[str]) -> str:
    return f"{bot_id}:{thread_id}" if thread_id else bot_id


def forget_bot(bot_id: str) -> None:
    """A bot was deleted: its rules, revisions and verified levels go with it."""
    try:
        with _mutate() as data:
            data["revisions"].pop(bot_id, None)
            data["commands"].pop(bot_id, None)
            for key in [k for k in data["committed"] if k == bot_id or k.startswith(bot_id + ":")]:
                data["committed"].pop(key, None)
            data["grants"] = [g for g in data["grants"] if g.get("bot_id") != bot_id]
    except StateCorrupt:
        pass


# -- levels ------------------------------------------------------------------------------------

def rank(mode: Optional[str]) -> float:
    return RANK.get(mode if mode in RANK else "ask", 0)


def is_elevation(current: Optional[str], new: str) -> bool:
    """Does moving from `current` (None follows the default, Full) to `new` raise what the bot may do
    without asking? Custom is always a deliberate step."""
    current = current if current in RANK else (DEFAULT_MODE if current is None else "ask")
    if new == current:
        return False
    if new == "custom":
        return True
    return rank(new) > rank(current)


@contextmanager
def elevating(bot_id: str, thread_id: Optional[str], mode: str):
    """Marks a write as the committed step of a desktop handshake, so the record validator lets it
    raise the level. Only this module's commit step opens it."""
    token = _ELEVATING.set((bot_id, thread_id, mode))
    try:
        yield
    finally:
        _ELEVATING.reset(token)


_ELEVATING: contextvars.ContextVar = contextvars.ContextVar("bot_elevating", default=None)


def elevation_open(bot_id: Optional[str], thread_id: Optional[str], mode: str) -> bool:
    held = _ELEVATING.get()
    return bool(held and held == (bot_id, thread_id, mode))


def check_bot_change(current: Optional[dict], value: str) -> None:
    """For bots' record validator: refuse raising the level with a plain write. `current` is the bot's
    record (None while it is being created, where only Full, the default, and narrower levels are
    taken)."""
    if value not in MODES:
        raise PolicyError(f"approval_mode must be one of: {', '.join(MODES)}")
    bot_id = (current or {}).get("id")
    stored = (current or {}).get("approval_mode")
    if current is None:
        if value == "custom":
            raise ElevationNeeded("Custom needs your confirmation in the desktop app. Create the bot first, "
                                  "then choose Custom for it.")
        return
    if is_elevation(stored, value) and not elevation_open(bot_id, None, value):
        raise ElevationNeeded(f"Raising approval to {LABELS[value]} needs your confirmation in the desktop app.")


@dataclass
class Policy:
    bot_id: str
    thread_id: Optional[str]
    mode: str
    stored: Optional[str]
    source: str
    revision: int
    reason: str = ""
    inherited: bool = True
    supported: bool = True
    provider: Optional[str] = None
    bot_mode: str = DEFAULT_MODE
    thread_mode: Optional[str] = None

    def public(self) -> dict:
        return {"bot_id": self.bot_id, "thread_id": self.thread_id, "mode": self.mode, "stored": self.stored,
                "source": self.source, "inherited": self.inherited, "revision": self.revision,
                "reason": self.reason or None, "supported": self.supported, "provider": self.provider,
                "bot_mode": self.bot_mode, "thread_mode": self.thread_mode}


def _agent(bot_id: Optional[str]) -> Optional[dict]:
    if not bot_id:
        return None
    from services.agent_service import agent_service
    return agent_service.get(bot_id)


def _session(session_id: Optional[str]) -> Optional[dict]:
    if not session_id:
        return None
    from core.session_manager import session_manager
    return session_manager.get_session(session_id)


def thread_mode_of(session: Optional[dict]) -> Optional[str]:
    thread = (session or {}).get("thread")
    value = thread.get("approval_mode") if isinstance(thread, dict) else None
    return value if isinstance(value, str) else None


def provider_for(bot_id: Optional[str], session: Optional[dict] = None) -> Optional[str]:
    """claude, openai, codex or antigravity: the provider this bot's turn runs on, or None."""
    try:
        from core import model_endpoints
        agent = _agent(bot_id)
        endpoint_id = (session or {}).get("model_endpoint_id")
        if not endpoint_id and agent:
            from services.agent_service import agent_service
            endpoint_id = agent_service.chat_endpoint(agent)
        kind = (model_endpoints.get_endpoint(endpoint_id) or {}).get("kind") if endpoint_id else None
    except Exception:
        return None
    return {"claude_cli": "claude", "codex_cli": "codex", "antigravity_cli": "antigravity",
            "api": "openai", "local": "openai"}.get(kind)


def codex_transport_ready() -> bool:
    try:
        from core import bot_codex_transport
        return bool(bot_codex_transport.available())
    except Exception:
        return False


def provider_support(provider: Optional[str], mode: str) -> tuple[bool, str]:
    """Can this provider hold this level? A provider whose own tools cannot ask first is limited to Full
    (design 5.1). Never silently run a stricter level as Full."""
    if provider is None:
        return True, ""
    if provider in ("claude", "openai"):
        if mode == "custom":
            return False, "Custom is for Codex. This bot's AI runs at Ask, Edits, Auto or Full."
        return True, ""
    if provider == "codex":
        if mode == "full" or codex_transport_ready():
            return True, ""
        return False, ("Codex cannot ask before it runs commands or edits files yet, so it can only run at Full. "
                       "Pick another connected AI for this bot to use a stricter level.")
    if provider == "antigravity":
        if mode == "full":
            return True, ""
        return False, ("Antigravity cannot ask before it runs commands or edits files, so it can only run at Full. "
                       "Pick another connected AI for this bot to use a stricter level.")
    return True, ""


def effective_policy(bot_id: str, thread_id: Optional[str] = None, provider: Optional[str] = None) -> Policy:
    """The level in force for this bot and conversation right now, read live.

    Unknown stored values mean Ask. A missing value on an older record means Full. A level that was
    written without this module's handshake is not honoured: the verified one applies. A thread may
    narrow its bot freely but may only widen it through a committed handshake."""
    agent = _agent(bot_id)
    rev = revision(bot_id)
    if agent is None:
        return Policy(bot_id, thread_id, "ask", None, "missing", rev, "This bot no longer exists.", provider=provider)
    session = _session(thread_id) if thread_id else None
    if session is not None and session.get("agent_id") != bot_id:
        session = None
    committed = _read_state()[0]["committed"]
    reason = ""
    raw_bot = agent.get("approval_mode")
    stored_bot = raw_bot if isinstance(raw_bot, str) else None
    if raw_bot is None:
        bot_mode, bot_source = DEFAULT_MODE, "default"
    elif raw_bot in MODES:
        bot_mode, bot_source = raw_bot, "bot"
    else:
        bot_mode, bot_source, reason = "ask", "bot", "This bot's saved approval level is not recognized, so it asks."
    verified = committed.get(bot_id)
    if verified in MODES and bot_mode in MODES and rank(bot_mode) > rank(verified) and bot_mode != verified:
        bot_mode, reason = verified, "Approval was raised without your confirmation, so the confirmed level applies."
    mode, source, stored, thread_mode = bot_mode, bot_source, stored_bot, None
    override = thread_mode_of(session)
    if override is not None:
        if override not in MODES:
            mode, source, stored, thread_mode = "ask", "thread", override, override
            reason = reason or "This conversation's saved approval level is not recognized, so it asks."
        elif rank(override) <= rank(bot_mode) and override != "custom" or committed.get(_key(bot_id, thread_id)) == override:
            mode, source, stored, thread_mode = override, "thread", override, override
        elif override == bot_mode:
            mode, source, stored, thread_mode = override, "thread", override, override
        else:
            mode, source, stored, thread_mode = bot_mode, bot_source, override, override
            reason = reason or (f"This conversation was set to {LABELS[override]} without your confirmation, "
                                f"so it follows the bot's {LABELS[bot_mode]}.")
    supported = True
    if provider:
        supported, why = provider_support(provider, mode)
        if not supported and mode == "custom" and provider in ("claude", "openai"):
            mode, reason = "ask", why
        elif not supported:
            reason = reason or why
    return Policy(bot_id, thread_id, mode, stored, source, rev, reason, inherited=thread_mode is None,
                  supported=supported, provider=provider, bot_mode=bot_mode, thread_mode=thread_mode)


def provider_refusal(bot_id: Optional[str], session_id: Optional[str], provider: Optional[str]) -> Optional[str]:
    """Why a bot's turn cannot start on this provider at its approval level, or None. A provider whose
    own shell and file tools cannot be asked first is refused before anything runs, never run as Full."""
    if not bot_id or provider not in ("codex", "antigravity"):
        return None
    policy = effective_policy(bot_id, session_id, provider)
    label = catalog.PROVIDER_LABEL.get(provider, "This AI")
    if not policy.supported:
        return (f"This bot is set to {LABELS.get(policy.mode, policy.mode)}, and {label} cannot ask before it runs "
                "commands or edits files. Pick another connected AI for this bot, or set its approval to Full.")
    run = run_context(bot_id)
    if run and run.get("access") == "read-and-draft":
        return (f"This routine can only read and draft, and {label} cannot be held to that. "
                "Pick another connected AI for the bot.")
    return None


# -- classifying what a call is ----------------------------------------------------------------

@dataclass(frozen=True)
class Operation:
    kind: str
    scope: str = ""          # file, internal, external, shell, computer
    tool: str = ""
    label: str = ""
    command: Optional[str] = None
    path: Optional[str] = None
    cwd: Optional[str] = None
    destructive: bool = False


SEND_TOKENS = frozenset("send reply forward post publish invite share pay transfer tweet broadcast notify "
                        "announce dm sms".split())
DESTRUCTIVE_TOKENS = frozenset("delete remove drop destroy purge wipe erase revoke trash kill uninstall reset clear "
                               "truncate".split())
DRAFT_TOKENS = frozenset({"draft", "drafts"})
FILE_EDIT_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit", "write_repo_file", "write_custom_tab_source",
                             "write_file", "edit_file"})
SHELL_TOOLS = catalog.SHELL
_DESTRUCTIVE_COMMAND = re.compile(
    r"(\brm\s+(-\S*[rf]\S*|--recursive|--force)\b|\brmdir\b|\bdel\s|\berase\s|Remove-Item|\bformat\s+[a-z]:|"
    r"git\s+push\s+.*(--force|\s-f\b)|git\s+reset\s+--hard|git\s+clean\s+-\S*f|\bdrop\s+(table|database)\b|"
    r"\bmkfs\b|\bshutdown\b|Stop-Computer|Restart-Computer|\bdd\s+if=|>\s*/dev/sd)", re.I)


def _is_destructive_command(command: str) -> bool:
    return bool(_DESTRUCTIVE_COMMAND.search(command or ""))


def _arg_path(arguments: dict) -> Optional[str]:
    for key in ("file_path", "path", "filename", "notebook_path"):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def classify(tool: str, arguments=None, mcp: Optional[tuple] = None) -> Operation:
    """What a call is: read, draft, edit, execute, outbound, destructive or opaque, with the scope an
    edit reaches (file, internal, external). Action-specific inside broad tools."""
    args = arguments if isinstance(arguments, dict) else {}
    name = catalog.canonical(tool) if isinstance(tool, str) else str(tool)
    label = name
    command = args.get("command") or args.get("cmd")
    command = command if isinstance(command, str) else None
    cwd = args.get("cwd") if isinstance(args.get("cwd"), str) else None
    path = _arg_path(args)
    words = catalog.tokens(name)
    action = args.get("action")
    if isinstance(action, str) and name not in SHELL_TOOLS:
        words = words + catalog.tokens(action)

    def build(kind, scope="", **extra):
        return Operation(kind, scope, name, label, command, path, cwd, **extra)

    if mcp is not None:
        effect, _source = catalog.mcp_effect(mcp[0], mcp[1])
        label = mcp[1]
        words = catalog.tokens(mcp[1])
        return _by_words(build, words, effect, "external")
    if name in SHELL_TOOLS:
        return build(EXECUTE, "shell", destructive=_is_destructive_command(command or ""))
    if name in FILE_EDIT_TOOLS:
        return build(EDIT, "file")
    if name.startswith(catalog.PROXY_PREFIX):
        words = catalog.tokens(name[len(catalog.PROXY_PREFIX):])
        return _by_words(build, words, catalog.classify_name(name[len(catalog.PROXY_PREFIX):]), "external")
    if name == "computer_delete":
        return build(DESTRUCTIVE, "computer")
    if name.startswith("computer"):
        return build(READ if name == "computer" and action in ("screenshot", "read", "list") else EXECUTE, "computer")
    if name.startswith("mcp__"):
        return build(OPAQUE, "external")
    try:
        from core import tool_registry
        spec = tool_registry._REGISTRY.get(name)
    except Exception:
        spec = None
    if spec is not None:
        if spec.effect == "exec":
            return build(EXECUTE, "shell" if "shell" in name or "code" in name else "computer",
                         destructive=_is_destructive_command(command or ""))
        effect = catalog.native_effect(name, args)
        if spec.effect == "read" and effect == catalog.READ:
            return build(READ)
        scope = "file" if path else ("external" if spec.effect == "external" else "internal")
        return _by_words(build, words, effect, scope)
    effect = catalog.native_effect(name, args)
    if effect == catalog.READ:
        return build(READ)
    guess = catalog.classify_name(name)
    if guess == catalog.READ and not any(w in SEND_TOKENS | DESTRUCTIVE_TOKENS for w in words):
        return build(READ)
    if re.fullmatch(r"google_[a-z]+_[a-z_]+", name) or guess != catalog.UNKNOWN or effect == catalog.WRITE:
        return _by_words(build, words, catalog.WRITE, "external")
    return build(OPAQUE, "external")


def _by_words(build, words: list, effect: str, scope: str) -> Operation:
    if effect == catalog.READ:
        return build(READ)
    if any(w in SEND_TOKENS for w in words):
        return build(OUTBOUND, "external")
    if any(w in DRAFT_TOKENS for w in words):
        return build(DRAFT, "external")
    if any(w in DESTRUCTIVE_TOKENS for w in words):
        return build(DESTRUCTIVE, scope)
    if effect == catalog.UNKNOWN:
        return build(OPAQUE, scope)
    return build(EDIT, scope)


# -- credentials never become rules ------------------------------------------------------------

_CREDENTIAL = re.compile(
    r"(?i)(passw(or)?d\s*[=:]|--?passw|--?token|--?secret|--?api[-_]?key|api[-_]?key\s*[=:]|secret\s*[=:]|"
    r"token\s*[=:]|authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|://[^/\s:@]+:[^/\s@]+@|"
    r"\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b)")


def has_credential(text: str) -> bool:
    return bool(_CREDENTIAL.search(text or ""))


_VALUES = (
    re.compile(r"(?i)((?:passw(?:or)?d|token|secret|api[-_]?key)\s*[=:]\s*)\S+"),
    re.compile(r"(?i)(--?(?:passw\w*|token|secret|api[-_]?key)[= ]\s*)\S+"),
    re.compile(r"(?i)(authorization\s*:\s*)(?:bearer\s+|basic\s+)?\S+"),
    re.compile(r"(?i)(://[^/\s:@]+:)[^/\s@]+(@)"),
)


def redact(value, limit: int = 300) -> str:
    """Text safe to keep in the history: secret-looking values replaced, clipped."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    text = " ".join(text.split())
    for pattern in _VALUES:
        text = pattern.sub(lambda m: m.group(1) + "[hidden]" + (m.group(2) if m.lastindex and m.lastindex > 1 else ""), text)
    text = _CREDENTIAL.sub("[hidden]", text)
    return text if len(text) <= limit else text[:limit - 1] + "…"


# -- exact command rules -----------------------------------------------------------------------

def _norm_cwd(cwd: Optional[str]) -> Optional[str]:
    return os.path.normcase(os.path.abspath(cwd)) if isinstance(cwd, str) and cwd and os.path.isabs(cwd) else None


def list_command_rules(bot_id: str) -> list[dict]:
    data, corrupt = _read_state()
    return [] if corrupt else [dict(r) for r in data["commands"].get(bot_id, [])]


def add_command_rule(bot_id: str, command: str, cwd: str, provider: Optional[str], *, by: str,
                     request_id: Optional[str] = None) -> dict:
    """Remember one exact command, in one folder, on one provider. Never a prefix, never a credential."""
    if not isinstance(command, str) or not command.strip():
        raise PolicyError("A command rule needs the exact command.")
    if len(command) > MAX_COMMAND_CHARS:
        raise PolicyError("That command is too long to remember (16 KB at most).")
    if has_credential(command):
        raise PolicyError("That command carries a password or token, so it cannot be remembered.")
    folder = _norm_cwd(cwd)
    if folder is None:
        raise PolicyError("A command rule needs the full path of the folder it runs in.")
    if not isinstance(provider, (str, type(None))) or (provider and len(provider) > 80):
        raise PolicyError("That AI name is not valid.")
    if _agent(bot_id) is None:
        raise NotFound("No such bot.")
    with _mutate() as data:
        rules = data["commands"].setdefault(bot_id, [])
        for rule in rules:
            if rule["command"] == command and rule["cwd"] == folder and rule.get("provider") == provider:
                return dict(rule)
        if len(rules) >= MAX_COMMAND_RULES:
            raise PolicyError("This bot already has 200 remembered commands. Remove some first.")
        rule = {"id": uuid.uuid4().hex[:16], "command": command, "cwd": folder, "provider": provider,
                "created_at": time.time(), "by": by, "request_id": request_id}
        rules.append(rule)
        data["revisions"][bot_id] = int(data["revisions"].get(bot_id, 0)) + 1
        return dict(rule)


def delete_command_rule(bot_id: str, rule_id: str) -> bool:
    with _mutate() as data:
        rules = data["commands"].get(bot_id, [])
        kept = [r for r in rules if r["id"] != rule_id]
        if len(kept) == len(rules):
            return False
        data["commands"][bot_id] = kept
        data["revisions"][bot_id] = int(data["revisions"].get(bot_id, 0)) + 1
        return True


def match_command(bot_id: str, command: Optional[str], cwd: Optional[str], provider: Optional[str]) -> Optional[dict]:
    folder = _norm_cwd(cwd)
    if not command or folder is None:
        return None
    for rule in list_command_rules(bot_id):
        if rule["command"] == command and rule["cwd"] == folder and rule.get("provider") == provider:
            return rule
    return None


# -- roots a bot may edit under Edits ----------------------------------------------------------

def granted_roots(bot_id: str, session: Optional[dict]) -> list[str]:
    roots = []
    try:
        from services.agent_service import AGENTS_DIR
        roots.append(os.path.join(AGENTS_DIR, bot_id))
    except Exception:
        pass
    try:
        from core import image_gen
        roots.append(image_gen.GENERATED_FILES_DIR)
    except Exception:
        pass
    workspace = (session or {}).get("workspace_dir")
    if isinstance(workspace, str) and workspace:
        roots.append(workspace)
    return [os.path.normcase(os.path.abspath(r)) for r in roots]


def default_cwd(session: Optional[dict]) -> Optional[str]:
    workspace = (session or {}).get("workspace_dir")
    if isinstance(workspace, str) and workspace:
        return workspace
    try:
        from core.workspace import resolve_vault_dir
        return resolve_vault_dir()
    except Exception:
        return None


def _inside(path: str, roots: list[str]) -> bool:
    resolved = os.path.normcase(os.path.realpath(path))
    for root in roots:
        real = os.path.normcase(os.path.realpath(root))
        if resolved == real or resolved.startswith(real.rstrip("\\/") + os.sep):
            return True
    return False


# -- the Auto reviewer -------------------------------------------------------------------------

_SAFE_PREFIXES = (
    ("git", "status"), ("git", "diff"), ("git", "log"), ("git", "show"), ("git", "branch"), ("git", "rev-parse"),
    ("pytest",), ("python", "-m", "pytest"), ("python", "-m", "unittest"), ("py", "-m", "pytest"),
    ("npm", "test"), ("npm", "run", "test"), ("cargo", "test"), ("go", "test"), ("node", "--check"),
)
_SAFE_SINGLE = frozenset({"ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "echo", "which", "where",
                          "whoami", "date", "tree"})
_SHELL_META = re.compile(r"[;&|<>`$()\n\r{}]|\\\s*$")

Reviewer = Callable[["Operation", dict], tuple]
_reviewer: Optional[Reviewer] = None


def set_reviewer(fn: Optional[Reviewer]) -> None:
    """Install a stronger reviewer (for example one backed by a model). It gets (operation, context) and
    returns ("allow" | "ask", reason). Refusal, doubt, an error or no reviewer all mean ask."""
    global _reviewer
    _reviewer = fn


def default_review(op: Operation, context: dict) -> tuple:
    """A bounded, local reviewer: it allows only what is plainly safe and says ask for the rest."""
    if op.kind == EDIT and op.scope == "internal":
        return "allow", "A change inside Kairos's own data."
    if op.kind == EDIT and op.scope == "file":
        if op.path and _inside(op.path if os.path.isabs(op.path) else os.path.join(context.get("cwd") or "", op.path),
                               context.get("roots") or []):
            return "allow", "An edit inside the bot's own folders."
        return "ask", "That file is outside the bot's own folders."
    if op.kind == EXECUTE and op.scope == "shell" and op.command:
        if op.destructive or _SHELL_META.search(op.command):
            return "ask", "That command is chained or could delete things."
        parts = op.command.strip().split()
        lowered = tuple(p.lower() for p in parts)
        if lowered and lowered[0] in _SAFE_SINGLE and len(parts) <= 6:
            return "allow", "A command that only looks."
        for prefix in _SAFE_PREFIXES:
            if lowered[:len(prefix)] == prefix:
                return "allow", "A command that only looks or runs tests."
    return "ask", "Not clearly safe."


def review(op: Operation, context: dict) -> tuple:
    try:
        verdict = (_reviewer or default_review)(op, context)
        if isinstance(verdict, tuple) and verdict and verdict[0] == "allow":
            return "allow", str(verdict[1]) if len(verdict) > 1 else ""
        return "ask", str(verdict[1]) if isinstance(verdict, tuple) and len(verdict) > 1 else "The reviewer was unsure."
    except Exception:
        logger.exception("approval reviewer failed; asking instead")
        return "ask", "The reviewer was unavailable."


# -- the decision ------------------------------------------------------------------------------

@dataclass
class Outcome:
    action: str                       # allow | ask | deny
    reason: str = ""
    op: Optional[Operation] = None
    mode: str = DEFAULT_MODE
    source: str = ""
    invocation_id: Optional[str] = None
    reservation: Optional[dict] = None
    rule: Optional[dict] = None
    owner: Optional[str] = None
    thread_id: Optional[str] = None
    bot_id: Optional[str] = None
    unattended: bool = False
    run: Optional[dict] = None
    provider: Optional[str] = None
    cwd: Optional[str] = None
    policy_revision: int = 0


_inflight: dict = {}
_hooks_installed = False


def _owner_for(bot_id: str, session: Optional[dict], run: Optional[dict]) -> str:
    from core.auth import SINGLE_USER
    if run and run.get("owner"):
        return run["owner"]
    if session and session.get("owner_user"):
        return session["owner_user"]
    try:
        from core import task_scope
        owner = task_scope.current_owner(bot_id)
        if owner:
            return owner
    except Exception:
        pass
    return SINGLE_USER


def _session_from_surface(surface: str) -> Optional[str]:
    return surface.removeprefix("chat:") if isinstance(surface, str) and surface.startswith("chat:") else None


def install_run_hooks() -> bool:
    """When a routine run ends, is cancelled or superseded, its execution permissions expire."""
    global _hooks_installed
    if _hooks_installed:
        return True
    try:
        from core import bot_routine_runner
        bot_routine_runner.register_run_end(lambda task_id, run_id, reason: expire_run(run_id, reason))
        _hooks_installed = True
    except Exception:
        return False
    return True


def expire_run(run_id: Optional[str], reason: str = "ended") -> int:
    """Deny and close everything a finished run was waiting on."""
    if not run_id:
        return 0
    from core import permissions
    return permissions.cancel_pending(lambda meta: meta.get("run_id") == run_id,
                                      f"The run {reason}, so the action did not run.")


def authorize_operation(*, bot_id: str, tool: str, arguments=None, mcp: Optional[tuple] = None, surface: str = "",
                        session_id: Optional[str] = None, provider: Optional[str] = None,
                        force_prompt: bool = False, explicit_review: bool = False,
                        invocation_id: Optional[str] = None, outer: bool = False,
                        cwd: Optional[str] = None, is_admin: bool = True) -> Outcome:
    """The approval level's answer for one call. The grant ceiling has already been applied by the
    caller (core/permissions.py). Never executes anything and never asks anyone."""
    install_run_hooks()
    ensure_migrated()
    args = arguments if isinstance(arguments, dict) else {}
    session_id = session_id or _session_from_surface(surface)
    session = _session(session_id)
    if session is not None and session.get("agent_id") != bot_id:
        session = None
    turn = current_turn() or {}
    provider = provider or turn.get("provider") or provider_for(bot_id, session)
    run = run_context(bot_id)
    owner = _owner_for(bot_id, session, run)
    policy = effective_policy(bot_id, session_id if session else None, provider)
    op = classify(tool, args, mcp)
    if op.kind == EXECUTE and op.scope == "shell" and not op.cwd:
        op = Operation(op.kind, op.scope, op.tool, op.label, op.command, op.path, cwd or default_cwd(session),
                       op.destructive)
    result = Outcome("ask", op=op, mode=policy.mode, owner=owner, thread_id=session_id if session else None,
                     bot_id=bot_id, unattended=bool(run), run=run, provider=provider, cwd=op.cwd,
                     policy_revision=policy.revision, invocation_id=invocation_id)

    def done(action: str, reason: str, source: str, **extra) -> Outcome:
        result.action, result.reason, result.source = action, reason, source
        for key, value in extra.items():
            setattr(result, key, value)
        return result

    if policy.source == "missing":
        return done("deny", policy.reason, "missing")
    # 2. A read-and-draft run reads and drafts, whatever its level; Full does not lift that.
    if run and run.get("access") == "read-and-draft" and op.kind not in (READ, DRAFT):
        verb = {OUTBOUND: "send", EDIT: "change things", EXECUTE: "run things", DESTRUCTIVE: "delete things"}.get(
            op.kind, "do that")
        return done("deny", f"This routine can only read and draft. It cannot {verb}.", "read-and-draft")
    if op.kind == READ:
        return done("allow", "Reading needs no approval.", "read")
    # An outer approval of this very call already covers a handler's own check inside it.
    mark = _inflight.get((bot_id, session_id)) if not outer else None
    if mark and not explicit_review and not force_prompt:
        if mark["expires"] < time.time():
            _inflight.pop((bot_id, session_id), None)
        elif mark["kind"] == op.kind:
            _inflight.pop((bot_id, session_id), None)
            return done("allow", "Covered by the approval of the call it belongs to.", "outer", invocation_id=mark.get("id"))

    def remember(outcome: Outcome) -> Outcome:
        if outer and outcome.action == "allow":
            mark_inflight(outcome)
        return outcome

    # 4. Explicit-review tools ask at every level, Full included.
    if explicit_review:
        return done("ask", "This kind of action always needs your review.", "explicit-review")
    mode = policy.mode
    # Sends: Full bypasses the allowance; below Full they draw on it or ask.
    if op.kind == OUTBOUND and mode != "full":
        outbound = (_agent(bot_id) or {}).get("outbound") or {}
        cap = int(outbound.get("daily_cap") or 25)
        if outbound.get("policy") == "allow":
            ident = invocation_id or _fallback_invocation(session_id, tool, args)
            try:
                taken = bot_outbound.reserve(owner, bot_id, ident, cap, tool=op.tool)
            except Exception:
                logger.exception("outbound reservation failed; asking instead")
                taken = {"ok": False, "error": True}
            if taken.get("ok"):
                return remember(done("allow", f"Within today's allowance of {cap} sends.", "allowance",
                                     invocation_id=ident, reservation=taken))
            return done("ask", f"Today's allowance of {cap} sends is used up, so this needs your OK."
                        if not taken.get("error") else "The send allowance could not be checked, so this needs your OK.",
                        "allowance-exhausted")
        return done("ask", "Sending needs your OK at this approval level.", "outbound-ask")
    if mode == "full":
        return remember(done("allow", "Allowed at Full.", "full"))
    # 5. Exact command grants.
    if op.kind == EXECUTE and op.scope == "shell":
        rule = match_command(bot_id, op.command, op.cwd, provider)
        if rule:
            return remember(done("allow", "You approved this exact command here before.", "command-rule", rule=rule))
    if op.kind == DRAFT and mode in ("edits", "auto"):
        return remember(done("allow", "A draft sends nothing.", "draft"))
    if mode == "ask" or mode == "custom":
        return done("ask", "This level asks before it changes anything." if mode == "ask"
                    else "Custom asks unless you approved this exact step.", mode)
    if mode == "edits":
        if op.kind == EDIT and op.scope == "internal":
            return remember(done("allow", "A change inside Kairos's own data.", "edits"))
        if op.kind == EDIT and op.scope == "file":
            roots = granted_roots(bot_id, session)
            base = op.cwd or default_cwd(session) or ""
            path = op.path if op.path and os.path.isabs(op.path) else os.path.join(base, op.path or "")
            if op.path and _inside(path, roots):
                return remember(done("allow", "An edit inside the bot's own folders.", "edits"))
            return done("ask", "That file is outside the folders this bot may edit on its own.", "edits-outside")
        return done("ask", "Running things and outside changes ask at Edits.", "edits")
    if mode == "auto":
        if run:
            return done("ask", "Nobody is here for Auto's reviewer, so a routine asks.", "auto-unattended")
        if op.kind in (OUTBOUND, DESTRUCTIVE, OPAQUE):
            return done("ask", "Sends, deletions and unknown actions always ask.", "auto-ineligible")
        verdict, why = review(op, {"cwd": op.cwd or default_cwd(session), "roots": granted_roots(bot_id, session),
                                   "bot_id": bot_id, "owner": owner})
        if verdict == "allow":
            return remember(done("allow", f"Auto allowed it. {why}".strip(), "reviewer"))
        return done("ask", f"Auto was not sure, so it asks. {why}".strip(), "reviewer")
    return done("ask", "This approval level asks.", "default")


def mark_inflight(outcome: Outcome) -> None:
    """An outer approval of a registry call stands for the one check its own handler makes inside it:
    the same kind of action, for this bot and conversation, once, for a couple of minutes."""
    if outcome.bot_id and outcome.op is not None:
        _inflight[(outcome.bot_id, outcome.thread_id)] = {
            "kind": outcome.op.kind, "expires": time.time() + INFLIGHT_SECONDS, "id": outcome.invocation_id}


def _fallback_invocation(session_id: Optional[str], tool: str, args: dict) -> str:
    import hashlib
    blob = json.dumps([session_id, tool, args], sort_keys=True, default=str)
    return "auto-" + hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24] + "-" + uuid.uuid4().hex[:6]


def live_denial(bot_id: str, session_id: Optional[str], outcome: Outcome) -> Optional[str]:
    """After a person answered Allow: is the action still permitted right now? A deleted bot, a run that
    has ended, or a read-and-draft limit all void the answer."""
    if _agent(bot_id) is None:
        return "This bot no longer exists, so the action did not run."
    run = outcome.run
    if run:
        now = run_context(bot_id)
        if now is None or now.get("run_id") != run.get("run_id"):
            return "The run ended, so the action did not run."
        if now.get("access") == "read-and-draft" and outcome.op and outcome.op.kind not in (READ, DRAFT):
            return "This routine can only read and draft."
    return None


def finish(owner: Optional[str], bot_id: str, invocation_id: Optional[str], result_text) -> None:
    """A call that took an allowance unit has finished: settle the unit from what it returned."""
    if not invocation_id:
        return
    try:
        bot_outbound.finalize(owner, bot_id, invocation_id, bot_outbound.outcome_for(result_text))
    except Exception:
        logger.exception("could not settle the outbound reservation")


def clear_inflight(bot_id: str) -> None:
    for key in [k for k in _inflight if k[0] == bot_id]:
        _inflight.pop(key, None)


# -- decision history --------------------------------------------------------------------------

def _month_file(stamp: float) -> str:
    return os.path.join(DECISIONS_DIR, datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m") + ".ndjson")


def record_decision(*, bot_id: str, thread_id: Optional[str], tool: str, op: Optional[Operation], mode: str,
                    outcome: str, source: str, actor: str, owner: Optional[str], unattended: bool,
                    invocation_id: Optional[str] = None, scope: Optional[str] = None,
                    target: Optional[str] = None, reason: str = "") -> None:
    """One redacted line in the decision history. Never fails the call."""
    try:
        now = time.time()
        entry = {"at": now, "bot_id": bot_id, "thread_id": thread_id, "owner": owner, "tool": redact(tool, 120),
                 "kind": op.kind if op else None, "mode": mode, "outcome": outcome, "source": source,
                 "actor": actor, "unattended": bool(unattended), "invocation_id": invocation_id,
                 "scope": scope, "target": redact(target or (op.command if op and op.command else op.path if op else "") or "", 200),
                 "reason": redact(reason, 200)}
        os.makedirs(DECISIONS_DIR, exist_ok=True)
        with _LOCK:
            with open(_month_file(now), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            _prune_decisions(now)
    except Exception:
        logger.exception("could not record a bot decision")


_last_prune = 0.0


def _prune_decisions(now: float) -> None:
    global _last_prune
    if now - _last_prune < 3600:
        return
    _last_prune = now
    cutoff = now - DECISION_RETENTION_DAYS * 86400
    for name in os.listdir(DECISIONS_DIR):
        if not name.endswith(".ndjson"):
            continue
        try:
            month = datetime.strptime(name[:-7], "%Y-%m").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        # A month file goes only when its whole month is past retention.
        end = month.replace(year=month.year + (month.month == 12), month=month.month % 12 + 1)
        if end.timestamp() < cutoff:
            try:
                os.remove(os.path.join(DECISIONS_DIR, name))
            except OSError:
                pass
        else:
            _trim_month(os.path.join(DECISIONS_DIR, name), cutoff)


def _trim_month(path: str, cutoff: float) -> None:
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
        kept = []
        for line in lines:
            try:
                if json.loads(line).get("at", 0) >= cutoff:
                    kept.append(line)
            except ValueError:
                continue
        if len(kept) != len(lines):
            with open(path, "w", encoding="utf-8") as handle:
                handle.writelines(kept)
    except OSError:
        pass


def decisions(owner: Optional[str], *, bot_id: Optional[str] = None, thread_id: Optional[str] = None,
              since: Optional[float] = None, limit: int = 200) -> list[dict]:
    """Newest first, bounded, for this owner only."""
    limit = max(1, min(int(limit), 1000))
    rows: list[dict] = []
    if not os.path.isdir(DECISIONS_DIR):
        return rows
    for name in sorted(os.listdir(DECISIONS_DIR), reverse=True):
        if not name.endswith(".ndjson"):
            continue
        try:
            with open(os.path.join(DECISIONS_DIR, name), encoding="utf-8") as handle:
                lines = handle.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if owner is not None and entry.get("owner") != owner:
                continue
            if bot_id and entry.get("bot_id") != bot_id:
                continue
            if thread_id and entry.get("thread_id") != thread_id:
                continue
            if since is not None and entry.get("at", 0) < since:
                continue
            rows.append(entry)
            if len(rows) >= limit:
                return rows
    return rows


CSV_FIELDS = ("at", "bot_id", "thread_id", "tool", "kind", "mode", "outcome", "source", "actor", "unattended",
              "scope", "target", "reason")


def _csv_cell(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def decisions_csv(rows: list[dict]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(CSV_FIELDS)
    for row in rows:
        writer.writerow([_csv_cell(datetime.fromtimestamp(row["at"], timezone.utc).isoformat()
                                   if key == "at" else row.get(key)) for key in CSV_FIELDS])
    return out.getvalue()


# -- changing the level ------------------------------------------------------------------------

def _threads_of(bot_id: str) -> list[str]:
    from core.session_manager import session_manager
    return [h["id"] for h in session_manager.list_sessions(agent_id=bot_id)]


def _owned_thread(bot_id: str, thread_id: str, user: Optional[str]) -> dict:
    session = _session(thread_id)
    if session is None or session.get("agent_id") != bot_id:
        raise NotFound("No such conversation for this bot.")
    owner = session.get("owner_user")
    from core.auth import SINGLE_USER, auth_manager
    if owner and user and owner != user and not auth_manager.is_admin(user):
        raise NotFound("No such conversation for this bot.")
    if owner is None and user not in (None, SINGLE_USER) and not auth_manager.is_admin(user):
        raise NotFound("No such conversation for this bot.")
    return session


def view(bot_id: str, thread_id: Optional[str] = None, user: Optional[str] = None) -> dict:
    """What the Permissions section shows: stored and effective level, inheritance, why each level is or
    is not available on this bot's AI, and the revision a change must quote."""
    agent = _agent(bot_id)
    if agent is None:
        raise NotFound("No such bot.")
    ensure_migrated()
    if thread_id:
        _owned_thread(bot_id, thread_id, user)
    session = _session(thread_id) if thread_id else None
    provider = provider_for(bot_id, session)
    policy = effective_policy(bot_id, thread_id, provider)
    levels = []
    for mode in MODES:
        ok, why = provider_support(provider, mode)
        levels.append({"mode": mode, "label": LABELS[mode], "blurb": MODE_BLURB[mode], "available": ok,
                       "reason": why or None})
    return {**policy.public(), "levels": levels, "provider": provider, "stored_bot": agent.get("approval_mode"),
            "commands": len(list_command_rules(bot_id)), "state_corrupt": state_corrupt()}


def _set_thread_mode(thread_id: str, mode: Optional[str]) -> None:
    from core.session_manager import session_manager
    session_manager.set_thread(thread_id, approval_mode=mode)


def _set_bot_mode(bot_id: str, mode: str) -> None:
    from services.agent_service import agent_service
    agent_service.update(bot_id, approval_mode=mode, actor="user")


def enforce_downgrade(bot_id: str, thread_ids: list, reason: str = "Approval was lowered, so the action did not run.") -> dict:
    """The level went down: stop affected turns, close execution cards and pending requests, drop
    in-flight approvals. Persisted first by the caller."""
    from core import permissions
    stopped = []
    cleared = 0
    clear_inflight(bot_id)
    surfaces = {f"chat:{t}" for t in thread_ids} | {f"agent:{bot_id}"}
    cleared += permissions.cancel_pending(lambda meta: meta.get("surface") in surfaces, reason)
    store = cards()
    for thread_id in thread_ids:
        _bump_generation(thread_id)
        if store is not None:
            try:
                store.set_generation(thread_id, _generation[thread_id])
                store.close_thread(thread_id, reason=reason)
            except Exception:
                logger.exception("could not close cards for %s", thread_id)
        try:
            from services import chat_live
            if chat_live.stop(thread_id, reason="person"):
                stopped.append(thread_id)
        except Exception:
            logger.exception("could not stop the turn for %s", thread_id)
    try:
        with _mutate() as data:
            for rid in [k for k, v in data["elevations"].items() if v.get("bot_id") == bot_id and v.get("phase") != "committed"]:
                data["elevations"].pop(rid, None)
    except StateCorrupt:
        pass
    return {"stopped": stopped, "cancelled_requests": cleared}


_generation: dict = {}


def _bump_generation(thread_id: str) -> int:
    _generation[thread_id] = _generation.get(thread_id, 0) + 1
    return _generation[thread_id]


def generation(thread_id: Optional[str]) -> int:
    return _generation.get(thread_id or "", 0)


def change_mode(bot_id: str, mode: Optional[str], *, scope: str = "bot", thread_id: Optional[str] = None,
                expected_revision: Optional[int] = None, user: Optional[str] = None) -> dict:
    """An ordinary change: lowering the level, or setting one that is not higher than today's. Raising
    it goes through the desktop handshake instead (prepare_elevation). Persists first, then enforces."""
    if scope not in SCOPES:
        raise PolicyError("scope is bot, thread or all_threads")
    if mode is not None and mode not in MODES:
        raise PolicyError(f"mode must be one of: {', '.join(MODES)}")
    if mode is None and scope != "thread":
        raise PolicyError("Only a conversation can follow its bot.")
    if _agent(bot_id) is None:
        raise NotFound("No such bot.")
    if scope == "thread":
        if not thread_id:
            raise PolicyError("Choose the conversation.")
        _owned_thread(bot_id, thread_id, user)
    if expected_revision is not None and expected_revision != revision(bot_id):
        raise StaleRevision("Approval changed somewhere else. Reload and try again.")
    before = effective_policy(bot_id, thread_id if scope == "thread" else None)
    threads = _threads_of(bot_id)
    affected = [thread_id] if scope == "thread" else threads
    levels_before = {t: effective_policy(bot_id, t).mode for t in affected}
    current = before.mode if scope == "thread" else before.bot_mode
    if mode is not None and is_elevation(current, mode):
        raise ElevationNeeded(f"Raising approval to {LABELS[mode]} needs your confirmation in the desktop app.")
    if scope == "thread":
        _set_thread_mode(thread_id, mode)
    else:
        _set_bot_mode(bot_id, mode)
        if scope == "all_threads":
            for each in threads:
                _set_thread_mode(each, None)
    with _mutate() as data:
        data["revisions"][bot_id] = int(data["revisions"].get(bot_id, 0)) + 1
        if scope == "thread":
            if mode is None:
                data["committed"].pop(_key(bot_id, thread_id), None)
            else:
                data["committed"][_key(bot_id, thread_id)] = mode
        else:
            data["committed"][bot_id] = mode
            if scope == "all_threads":
                for key in [k for k in data["committed"] if k.startswith(bot_id + ":")]:
                    data["committed"].pop(key, None)
    narrowed = [t for t in affected if rank(effective_policy(bot_id, t).mode) < rank(levels_before[t])]
    enforcement = enforce_downgrade(bot_id, narrowed) if narrowed else {"stopped": [], "cancelled_requests": 0}
    after = effective_policy(bot_id, thread_id if scope == "thread" else None)
    record_decision(bot_id=bot_id, thread_id=thread_id if scope == "thread" else None, tool="approval_level", op=None,
                    mode=after.mode, outcome="changed", source=scope, actor=user or "owner", owner=user,
                    unattended=False, reason=f"{before.mode} to {after.mode}")
    return {**view(bot_id, thread_id if scope == "thread" else None, user), "enforcement": enforcement}


# -- the desktop elevation handshake -----------------------------------------------------------

PHASES = ("prepared", "confirmed", "activated", "committed")


def prepare_elevation(bot_id: str, mode: str, *, scope: str = "bot", thread_id: Optional[str] = None,
                      expected_revision: Optional[int] = None, user: Optional[str] = None) -> dict:
    """Step one, from the page: record that this person asked to raise this bot or conversation to this
    level. Nothing changes yet; only the desktop shell can take the next steps."""
    if mode not in ("edits", "auto", "full", "custom"):
        raise PolicyError("Only a higher level needs confirming.")
    if scope not in ("bot", "thread"):
        raise PolicyError("Raise the bot or one conversation.")
    agent = _agent(bot_id)
    if agent is None:
        raise NotFound("No such bot.")
    if scope == "thread":
        if not thread_id:
            raise PolicyError("Choose the conversation.")
        _owned_thread(bot_id, thread_id, user)
    else:
        thread_id = None
    if expected_revision is not None and expected_revision != revision(bot_id):
        raise StaleRevision("Approval changed somewhere else. Reload and try again.")
    before = effective_policy(bot_id, thread_id)
    if not is_elevation(before.mode if scope == "thread" else before.bot_mode, mode):
        raise PolicyError(f"This is not higher than {LABELS[before.mode]}. Use the ordinary change.")
    provider = provider_for(bot_id, _session(thread_id) if thread_id else None)
    ok, why = provider_support(provider, mode)
    if not ok:
        raise PolicyError(why)
    request_id = uuid.uuid4().hex
    with _mutate() as data:
        for rid in [k for k, v in data["elevations"].items()
                    if v.get("bot_id") == bot_id and v.get("phase") != "committed"]:
            data["elevations"].pop(rid, None)
        now = time.time()
        data["elevations"][request_id] = {"bot_id": bot_id, "thread_id": thread_id, "mode": mode, "scope": scope,
                                          "revision": revision(bot_id), "phase": "prepared", "user": user,
                                          "created_at": now, "expires_at": now + ELEVATION_SECONDS}
    return {"request_id": request_id, "bot_id": bot_id, "thread_id": thread_id, "mode": mode, "scope": scope,
            "revision": revision(bot_id), "expires_in": ELEVATION_SECONDS, "bot_name": agent.get("name")}


def _advance(data: dict, request_id: str, source: str, target: str, bot_id, thread_id, mode, rev) -> dict:
    item = data["elevations"].get(request_id)
    if item is None:
        raise PolicyError("That request is not waiting for confirmation.")
    if item.get("expires_at", 0) < time.time():
        data["elevations"].pop(request_id, None)
        raise PolicyError("That request expired. Start again.")
    if (item["bot_id"], item.get("thread_id"), item["mode"], item["revision"]) != (bot_id, thread_id, mode, rev):
        raise PolicyError("That confirmation does not match the request.")
    if item["phase"] != source:
        raise PolicyError(f"That step is out of order: the request is {item['phase']}.")
    item["phase"] = target
    return item


def confirm_elevation(request_id: str, bot_id: str, thread_id: Optional[str], mode: str, rev: int) -> dict:
    with _mutate() as data:
        _advance(data, request_id, "prepared", "confirmed", bot_id, thread_id, mode, rev)
    return {"request_id": request_id, "phase": "confirmed"}


def activate_elevation(request_id: str, bot_id: str, thread_id: Optional[str], mode: str, rev: int) -> dict:
    if _agent(bot_id) is None:
        raise NotFound("No such bot.")
    if revision(bot_id) != rev:
        revoke_elevation(request_id)
        raise StaleRevision("Approval changed somewhere else, so the confirmation was dropped.")
    with _mutate() as data:
        _advance(data, request_id, "confirmed", "activated", bot_id, thread_id, mode, rev)
    return {"request_id": request_id, "phase": "activated"}


def commit_elevation(request_id: str, bot_id: str, thread_id: Optional[str], mode: str, rev: int) -> dict:
    """The last step: write the higher level, record the grant and verify it. A failed write leaves the
    request revoked, never half applied."""
    with _mutate() as data:
        item = _advance(data, request_id, "activated", "committed", bot_id, thread_id, mode, rev)
        item["committed_at"] = time.time()
    try:
        with elevating(bot_id, thread_id, mode):
            if thread_id:
                _set_thread_mode(thread_id, mode)
            else:
                _set_bot_mode(bot_id, mode)
        with _mutate() as data:
            data["revisions"][bot_id] = int(data["revisions"].get(bot_id, 0)) + 1
            data["committed"][_key(bot_id, thread_id)] = mode
            data["grants"].append({"id": request_id, "bot_id": bot_id, "thread_id": thread_id, "mode": mode,
                                   "at": time.time(), "source": "desktop"})
            data["grants"] = data["grants"][-500:]
    except Exception:
        revoke_elevation(request_id)
        raise
    record_decision(bot_id=bot_id, thread_id=thread_id, tool="approval_level", op=None, mode=mode,
                    outcome="raised", source="desktop", actor="owner", owner=(item.get("user")), unattended=False,
                    reason=f"raised to {mode}")
    return {**view(bot_id, thread_id), "request_id": request_id, "phase": "committed"}


def revoke_elevation(request_id: str) -> bool:
    try:
        with _mutate() as data:
            return data["elevations"].pop(request_id, None) is not None
    except StateCorrupt:
        return False


def elevation_phase(request_id: str) -> Optional[str]:
    return (_read_state()[0]["elevations"].get(request_id) or {}).get("phase")


_migrated_for: set = set()


def ensure_migrated() -> None:
    """Run the one-time migration the first time a policy is read in this process."""
    if STATE_FILE in _migrated_for:
        return
    _migrated_for.add(STATE_FILE)
    try:
        stamp_migration_grants()
    except Exception:
        logger.exception("approval migration failed")


def stamp_migration_grants() -> int:
    """One time: every bot that is at Full (stored or by default) gets a migration grant, so nothing
    reads as an unconfirmed elevation. Idempotent."""
    try:
        from services.agent_service import agent_service
        bots = agent_service.list_agents()
    except Exception:
        return 0
    added = 0
    try:
        with _mutate() as data:
            for bot in bots:
                bot_id = bot.get("id")
                if not bot_id or bot_id in data["migrated"]:
                    continue
                data["migrated"].append(bot_id)
                mode = bot.get("approval_mode")
                if mode in (None, "full"):
                    data["committed"].setdefault(bot_id, "full")
                    data["grants"].append({"id": uuid.uuid4().hex, "bot_id": bot_id, "thread_id": None,
                                           "mode": "full", "at": time.time(), "source": "migration"})
                    added += 1
    except StateCorrupt:
        return 0
    return added
