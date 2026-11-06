"""Bot grants: the ceiling on what a bot may reach, and the verdict on each call
(Bots redesign, Phase 2 unit U4, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.3, 4.5 and 7 (U4).

Effective reach is the intersection of: installation availability, global policy, trusted
execution rights, the bot's own selection (integration_ids, tool_scope), app scope
(connector_scopes), and the current tool selection (connector_tools). Deny always wins. Full
approval is not a layer here: it is evaluated after this ceiling and cannot lift it
(core/permissions.py calls ceiling_denial() before any Auto or Full allowance).

Two readings of a record:
  legacy    connector_tools is null. Apps absent from connector_scopes are unrestricted, as they
            were; an explicit scope entry is enforced now (`off` blocks, `read` allows reads).
  explicit  connector_tools is an object (saving the Access form writes one). Only apps it names,
            with an explicit read or write scope, and only the tools it names, are allowed.

Callers pass a trusted scope (the bot id, owner and admin flag come from the session, the run or
the tool token, never from model arguments). A missing, malformed or stale scope fails closed.
Refusals never list other bots' grants or neighbouring tools.

Exports: effective(scope), catalogue(scope), verdict(scope, tool, args), revision(scope).
"""
import hashlib
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from core import bot_tool_catalog as catalog
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

STATE_FILE: Optional[str] = None  # a test can point it at its own file


def state_file() -> str:
    from core import accounts
    return STATE_FILE or accounts.path("bot-grants-state.json")

RECEIPT_SECONDS = 600
_LOCK = threading.RLock()
_receipts: dict = {}
_cat_memo: dict = {}
CATALOGUE_SECONDS = 1.0
UNENFORCEABLE_NATIVE = frozenset({"codex", "antigravity"})


def _cat(owner, is_admin) -> dict:
    """The catalogue, kept for a second so a tool list is judged against one snapshot. Grants
    themselves are read live on every call; only availability is memoised."""
    key = (owner, bool(is_admin))
    held = _cat_memo.get(key)
    if held and held[0] > time.monotonic():
        return held[1]
    value = catalog.catalogue(owner, is_admin)
    _cat_memo[key] = (time.monotonic() + CATALOGUE_SECONDS, value)
    return value


def reset_cache() -> None:
    _cat_memo.clear()


class ScopeError(ValueError):
    """The trusted scope is missing, malformed or names no bot."""


@dataclass(frozen=True)
class Scope:
    bot_id: str
    owner: Optional[str] = None
    is_admin: bool = False
    session_id: Optional[str] = None
    provider: Optional[str] = None


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    reason: str = ""
    code: str = "ok"
    revision: int = 0
    app: Optional[str] = None
    effect: Optional[str] = None
    receipt: Optional[str] = None


def scope_from(value) -> Scope:
    """A Scope from a Scope, a dict, a ToolContext or a bare bot id. ScopeError otherwise."""
    if isinstance(value, Scope):
        scope = value
    elif isinstance(value, str):
        scope = Scope(value)
    elif isinstance(value, dict):
        bot = value.get("agent_id") or value.get("bot_id")
        scope = Scope(bot, value.get("owner_user") or value.get("owner"), bool(value.get("is_admin")),
                      value.get("session_id"), value.get("provider"))
    elif hasattr(value, "agent_id"):
        scope = Scope(value.agent_id, getattr(value, "owner_user", None), bool(getattr(value, "is_admin", False)),
                      getattr(value, "session_id", None), getattr(value, "surface", None) or None)
    else:
        raise ScopeError("no trusted scope")
    if not isinstance(scope.bot_id, str) or not scope.bot_id:
        raise ScopeError("no bot in the trusted scope")
    return scope


def applies(value) -> bool:
    """Does a caller belong to a bot? Ordinary Kairos chats have no agent id and no grants."""
    if isinstance(value, dict):
        return bool(value.get("agent_id") or value.get("bot_id"))
    if isinstance(value, str):
        return bool(value)
    return bool(getattr(value, "agent_id", None) or getattr(value, "bot_id", None))


def _bot(bot_id: str) -> Optional[dict]:
    from services.agent_service import agent_service
    return agent_service.get(bot_id)


def explicit(record: dict) -> bool:
    return isinstance(record.get("connector_tools"), dict)


def _selectors(record: dict, part: str, prefix: str) -> list:
    scope = record.get("tool_scope") if isinstance(record.get("tool_scope"), dict) else {}
    return [s for s in scope.get(part) or [] if isinstance(s, str) and s.startswith(prefix)]


# -- revision --------------------------------------------------------------------------------

def _fingerprint(record: dict) -> str:
    from core import settings
    blob = json.dumps([record.get("tool_scope"), record.get("connector_scopes"), record.get("integration_ids"),
                       record.get("connector_tools"), settings.get_setting("disabled_tools") or [],
                       _cat(None, True)["revision"]], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def revision(scope) -> int:
    """Monotonic per bot: it rises whenever the bot's grants, the global policy or what is installed
    changes, however the change was made."""
    scope = scope_from(scope)
    record = _bot(scope.bot_id)
    if record is None:
        raise ScopeError("no such bot")
    digest = _fingerprint(record)
    with _LOCK:
        state = read_json(state_file(), {})
        state = state if isinstance(state, dict) else {}
        entry = state.get(scope.bot_id) or {"rev": 0, "hash": None}
        if entry["hash"] != digest:
            entry = {"rev": int(entry["rev"]) + 1, "hash": digest}
            state[scope.bot_id] = entry
            write_json_atomic(state_file(), state)
    return int(entry["rev"])


def remove_bot(bot_id: str) -> None:
    with _LOCK:
        state = read_json(state_file(), {})
        if isinstance(state, dict) and state.pop(bot_id, None) is not None:
            write_json_atomic(state_file(), state)
        for key in [k for k in _receipts if k[0] == bot_id]:
            _receipts.pop(key, None)


# -- identifying a call --------------------------------------------------------------------

def identify(tool: str, mcp: Optional[tuple] = None) -> dict:
    """What a call is. `mcp` is (integration id, tool name) when the caller already knows it."""
    if mcp is not None:
        return {"kind": "mcp", "name": mcp[1], "server_id": mcp[0], "app": mcp[0]}
    if not isinstance(tool, str) or not tool:
        return {"kind": "unknown", "name": str(tool)}
    if tool.startswith(catalog.PROXY_PREFIX):
        return {"kind": "proxy", "name": tool}
    if tool.startswith("mcp__") and not tool.startswith(catalog.HIVE_PREFIX):
        return {"kind": "direct_mcp", "name": tool}
    name = catalog.canonical(tool)
    return {"kind": "native", "name": name, "app": catalog.NATIVE_APPS.get(name)}


def _scope_level(record: dict, server_id: Optional[str], app: Optional[str]):
    """The app's scope entry as (level, matched), matching an id, or a name when unambiguous.
    `off` matches every candidate, so a renamed or duplicated server cannot slip past it."""
    scopes = record.get("connector_scopes") if isinstance(record.get("connector_scopes"), dict) else {}
    if app in scopes:
        return scopes[app]
    if server_id:
        row = catalog.server(server_id)
        if row:
            peers = catalog.servers_named(row["name"])
            level = scopes.get(row["name"])
            if level == "off" or (level is not None and len(peers) == 1):
                return level
    return None


def _refuse(code: str, reason: str, rev: int, app=None, effect=None) -> Verdict:
    return Verdict(False, "Not allowed: " + reason, code, rev, app, effect)


def _evaluate(scope: Scope, record: dict, ident: dict, args, rev: int) -> Verdict:
    kind, name = ident["kind"], ident["name"]
    args = args if isinstance(args, dict) else {}
    if kind in ("unknown", "direct_mcp"):
        return _refuse("unknown", f"{name} is not one of the tools this bot has been given.", rev)
    if kind == "proxy":
        return Verdict(True, "", "proxy", rev)   # the bridge judges each app tool by its server and name
    mode_explicit = explicit(record)
    server_id = ident.get("server_id")
    app = ident.get("app")
    cat = _cat(scope.owner, scope.is_admin)
    if kind == "native":
        entry = cat["native"].get(name)
        if entry is None:
            # A built-in tool of the provider that Kairos does not list (Claude's own extras): only
            # the bot's own selectors can restrict it, and it is never an app tool.
            entry = {"available": True, "reason": None, "app": None}
        if not entry["available"]:
            return _refuse("unavailable", f"{name} is not available here. {entry['reason']}", rev, app)
        effect = catalog.native_effect(name, args)
        deny = [s for s in _selectors(record, "deny", "native:") if catalog.selector_matches(s, "native", None, name)]
        if deny:
            return _refuse("denied", f"this bot's tool selection excludes {name}. Check the bot's Access settings.", rev, app, effect)
        allow = _selectors(record, "allow", "native:")
        if allow and name not in catalog.BASELINE and not any(
                catalog.selector_matches(s, "native", None, name) for s in allow):
            return _refuse("not_selected", f"this bot's tool selection does not include {name}. Check the bot's Access settings.", rev, app, effect)
    else:
        row = catalog.server(server_id)
        if row is None:
            return _refuse("unavailable", "that app is not connected.", rev, app)
        reason = catalog.server_unavailable(row, scope.owner, scope.is_admin)
        if reason:
            return _refuse("unavailable", f"{row['name']} cannot be used. {reason}", rev, app)
        ids = record.get("integration_ids")
        if (ids is None and row["rea"]) or (ids is not None and server_id not in ids):
            return _refuse("not_selected", f"{row['name']} is not one of this bot's apps. Check the bot's Access settings.", rev, app)
        if name in catalog.held_names(server_id):
            return _refuse("held", f"{name} is waiting for your review in Tool Store.", rev, app)
        effect, source = catalog.mcp_effect(server_id, name)
        deny = [s for s in _selectors(record, "deny", "mcp:") if catalog.selector_matches(s, "mcp", server_id, name)]
        # A deny written with a server name that cannot be placed still blocks every server of that name.
        deny += [s for s in _selectors(record, "deny", "mcp:")
                 if _named(s, row, name)]
        if deny:
            return _refuse("denied", f"this bot's tool selection excludes {name}. Check the bot's Access settings.", rev, app, effect)
        allow = _selectors(record, "allow", "mcp:")
        if allow and not any(catalog.selector_matches(s, "mcp", server_id, name) for s in allow):
            return _refuse("not_selected", f"this bot's tool selection does not include {name}. Check the bot's Access settings.", rev, app, effect)
    level = _scope_level(record, server_id, app) if app else None
    if app:
        if level == "off":
            return _refuse("app_off", f"{ident.get('app_name') or app} is turned off for this bot.", rev, app, effect)
        if mode_explicit and level not in ("read", "write"):
            return _refuse("no_scope", f"{app} has no scope for this bot. Choose read or write in Access.", rev, app, effect)
        if level == "read" and effect != catalog.READ:
            why = "it is not known to be read-only" if effect == catalog.UNKNOWN else "this app is read-only for this bot"
            return _refuse("read_only", f"{name} is blocked because {why}.", rev, app, effect)
    if mode_explicit and (app or kind == "mcp"):
        grants = record["connector_tools"].get(app)
        if grants is None:
            return _refuse("not_selected", f"this bot has not been given {app}.", rev, app, effect)
        tools = grants["tools"]
        if tools != "*" and name not in tools:
            return _refuse("not_selected", f"this bot has not been given {name}.", rev, app, effect)
        accounts = grants.get("accounts")
        if accounts and kind == "native":
            chosen = args.get("account") or args.get("from_account")
            if not isinstance(chosen, str) or chosen not in accounts:
                return _refuse("account", "name one of the accounts this bot may use.", rev, app, effect)
    return Verdict(True, "", "ok", rev, app, effect)


def _named(selector: str, row: dict, name: str) -> bool:
    import re
    match = re.fullmatch(r"mcp:([^:\s]+):(\S+)", selector)
    return bool(match and match.group(1) == row["name"] and match.group(2) in ("*", name)
                and match.group(1) != row["id"])


def verdict(scope, tool: str, args=None, *, mcp: Optional[tuple] = None, call_id: Optional[str] = None) -> Verdict:
    """May this bot make this call now? Fails closed on a missing or stale scope."""
    try:
        scope = scope_from(scope)
        record = _bot(scope.bot_id)
        if record is None:
            raise ScopeError("no such bot")
        rev = revision(scope)
    except ScopeError:
        return Verdict(False, "Not allowed: this call has no valid bot behind it.", "scope", 0)
    except Exception:
        return Verdict(False, "Not allowed: this bot's access could not be checked.", "scope", 0)
    ident = identify(tool, mcp)
    try:
        result = _evaluate(scope, record, ident, args, rev)
    except Exception:
        return Verdict(False, "Not allowed: this bot's access could not be checked.", "error", rev)
    if result.allowed and call_id:
        key = (scope.bot_id, str(call_id), _args_hash(args))
        receipt = uuid.uuid4().hex
        with _LOCK:
            _receipts[key] = (rev, time.time() + RECEIPT_SECONDS, receipt)
            for stale in [k for k, v in _receipts.items() if v[1] < time.time()]:
                _receipts.pop(stale, None)
        result = Verdict(True, "", result.code, rev, result.app, result.effect, receipt)
    return result


def _args_hash(args) -> str:
    return hashlib.sha256(json.dumps(args if isinstance(args, dict) else {}, sort_keys=True, default=str)
                          .encode("utf-8")).hexdigest()


def recheck(scope, tool: str, args=None, *, mcp: Optional[tuple] = None, call_id: Optional[str] = None) -> Verdict:
    """After an approval wait, and right before dispatch. A receipt for this exact call and the same
    grant revision stands in for a fresh judgement; any change in grants voids it."""
    try:
        sc = scope_from(scope)
        key = (sc.bot_id, str(call_id), _args_hash(args))
        held = _receipts.get(key) if call_id else None
        if held and held[1] >= time.time() and held[0] == revision(sc):
            return Verdict(True, "", "receipt", held[0], receipt=held[2])
    except Exception:
        pass
    return verdict(scope, tool, args, mcp=mcp, call_id=call_id)


# -- call-site helpers (kept apart so enforcement is easy to find and extend) -------------------

def native_refusal(ctx, name: str, args) -> Optional[str]:
    """The refusal text for a registry tool call by a bot, or None. Ordinary chats pass."""
    if not applies(ctx):
        return None
    result = verdict(ctx, name, args)
    return None if result.allowed else result.reason


def mcp_ident(spec: dict) -> Optional[tuple]:
    """(integration id, tool name) for a discovered MCP tool, or None when the server cannot be placed."""
    rows = catalog.servers_named(spec.get("server", ""))
    return (rows[0]["id"], spec["name"]) if len(rows) == 1 else None


def mcp_refusal(ctx, spec: dict, name: str, args) -> Optional[str]:
    """The refusal text for an MCP bridge call, or None. `spec` is the discovered tool."""
    if not applies(ctx):
        return None
    rows = catalog.servers_named(spec.get("server", ""))
    if len(rows) != 1:
        return "Not allowed: that app could not be matched to one connected server."
    result = verdict(ctx, name, args, mcp=(rows[0]["id"], spec["name"]))
    return None if result.allowed else result.reason


def ceiling_denial(agent_id: Optional[str], tool: str, args, owner=None, is_admin=False,
                   mcp: Optional[tuple] = None) -> Optional[str]:
    """For core/permissions.py: the reason the ceiling forbids this, or None. Evaluated before Auto or Full."""
    if not agent_id:
        return None
    scope = Scope(agent_id, owner, is_admin)
    result = verdict(scope, tool, args, mcp=mcp)
    return None if result.allowed else result.reason


def filter_mcp_catalog(ctx, found: dict) -> dict:
    """The discovered MCP tools a bot may be shown. Advertisement and call use the same verdict."""
    if not applies(ctx):
        return found
    kept = {}
    for name, spec in found.items():
        rows = catalog.servers_named(spec.get("server", ""))
        if len(rows) == 1 and verdict(ctx, name, {}, mcp=(rows[0]["id"], spec["name"])).allowed:
            kept[name] = spec
    return kept


def native_hidden(scope, names, surface: Optional[str] = None) -> set:
    """Of these native tool names, the ones this bot may not use (to leave out of a tool list)."""
    try:
        scope = scope_from(scope)
    except ScopeError:
        return set(names)
    return {n for n in names if not verdict(scope, n, {}).allowed
            and verdict(scope, n, {}).code in ("denied", "not_selected", "unavailable", "unknown")}


def claude_disallowed(scope) -> list:
    """Names for Claude's disallowed_tools: every native tool the ceiling excludes, under the names
    Claude uses. The hook is the catch-all for anything not listed."""
    try:
        scope = scope_from(scope)
    except ScopeError:
        return []
    record = _bot(scope.bot_id) or {}
    names = []
    for name in catalog.native_entries():
        if name in catalog.BASELINE:
            continue
        v = verdict(scope, name, {"action": "list"})
        if v.allowed or v.code in ("read_only", "account", "no_scope"):
            continue
        entry = catalog.native_entries()[name]
        names.append(name if entry["source"] == "claude" else catalog.HIVE_PREFIX + name)
    return sorted(set(names))


def provider_refusal(scope, provider: str) -> Optional[str]:
    """Why a provider cannot take this bot's turn, or None. A restriction on a tool the provider owns
    outright (Codex's shell and files) cannot be enforced, so the turn is refused, not half-honoured."""
    if provider not in UNENFORCEABLE_NATIVE:
        return None   # Claude's hooks and an API model's own tool list see every call
    try:
        scope = scope_from(scope)
    except ScopeError:
        return None
    record = _bot(scope.bot_id)
    if record is None:
        return None
    blocked = []
    for name in sorted(catalog.PROVIDER_NATIVE.get(provider, ())):
        deny = any(catalog.selector_matches(s, "native", None, name) for s in _selectors(record, "deny", "native:"))
        allow = _selectors(record, "allow", "native:")
        narrowed = bool(allow) and name not in catalog.BASELINE and not any(
            catalog.selector_matches(s, "native", None, name) for s in allow)
        if deny or narrowed:
            blocked.append(name)
    if not blocked:
        return None
    label = catalog.PROVIDER_LABEL.get(provider, "This model")
    return (f"This bot is set not to use {', '.join(blocked)}, and {label} cannot hold that limit on its own tools. "
            "Pick a Claude or API model for this bot, or lift the limit in Access.")


# -- the Access view ---------------------------------------------------------------------------

def catalogue(scope) -> dict:
    scope = scope_from(scope)
    return catalog.catalogue(scope.owner, scope.is_admin)


def effective(scope) -> dict:
    """What the bot may reach right now, tool by tool, with the reason for each switch."""
    scope = scope_from(scope)
    record = _bot(scope.bot_id)
    if record is None:
        raise ScopeError("no such bot")
    cat = _cat(scope.owner, scope.is_admin)
    rev = revision(scope)
    mode = "explicit" if explicit(record) else "legacy"

    def state(tool, args=None, mcp=None):
        v = verdict(scope, tool, args or {}, mcp=mcp)
        return {"state": "on" if v.allowed else "off", "reason": "" if v.allowed else v.reason.removeprefix("Not allowed: "),
                "code": v.code}

    native = []
    for name, entry in sorted(cat["native"].items()):
        native.append({"name": name, "description": entry["description"], "effect": entry["effect"],
                       "app": entry["app"], "available": entry["available"], "unavailable": entry["reason"],
                       **state(name, {"action": "list"} if entry["app"] else {})})
    apps = []
    for app in cat["apps"]:
        tools = []
        for tool in app["tools"]:
            mcp = (app["id"], tool["name"]) if app["kind"] == "mcp" else None
            tools.append({**tool, **state(tool["name"], {"action": "list"} if app["kind"] == "native" else {}, mcp)})
        level = _scope_level(record, app["id"] if app["kind"] == "mcp" else None, app["id"])
        grant = (record.get("connector_tools") or {}).get(app["id"]) if mode == "explicit" else None
        apps.append({"id": app["id"], "name": app["name"], "kind": app["kind"], "available": app["available"],
                     "unavailable": app["reason"], "scope": level, "grant": grant, "accounts": app["accounts"],
                     "tools": tools})
    ids = record.get("integration_ids")
    notes = ["This is the most the bot can do. Its approval level (Full by default) cannot add to it."]
    notes.append("Every app is allowed unless you limit it." if mode == "legacy" else
                 "Only the apps and tools you chose below are allowed.")
    scope_rec = record.get("tool_scope") or {}
    if scope_rec.get("deny"):
        notes.append(f"{len(scope_rec['deny'])} tool choice(s) are blocked, and a block always wins.")
    if ids is not None:
        notes.append("It uses only the tool servers you picked.")
    return {"bot_id": scope.bot_id, "revision": rev, "mode": mode, "catalogue_revision": cat["revision"],
            "grants": {"tool_scope": record.get("tool_scope"), "connector_scopes": record.get("connector_scopes"),
                       "integration_ids": ids, "connector_tools": record.get("connector_tools"),
                       "grants_version": record.get("grants_version", 0)},
            "native": native, "apps": apps, "explanation": notes}


class Stale(ValueError):
    """The grants changed since the caller read them."""


class Unavailable(ValueError):
    """A grant named something that cannot be switched on."""


def save(scope, changes: dict, expected_revision: int) -> dict:
    """Save a grants form: whole-form validation, a revision check, then one profile update. Saving
    ends the legacy reading for the bot (connector_tools becomes an object)."""
    from services import bot_record
    from services.agent_service import agent_service
    scope = scope_from(scope)
    allowed = {"tool_scope", "connector_scopes", "integration_ids", "connector_tools"}
    unknown = sorted(set(changes) - allowed)
    if unknown:
        raise ValueError(f"{', '.join(unknown)} cannot be changed here")
    with _LOCK:
        record = _bot(scope.bot_id)
        if record is None:
            raise KeyError(scope.bot_id)
        if revision(scope) != expected_revision:
            raise Stale("The access settings changed. Reload them before saving.")
        merged = {k: changes.get(k, record.get(k)) for k in allowed}
        cleaned = {k: bot_record.clean_field(k, v, record) for k, v in merged.items()
                   if k not in ("integration_ids",) and not (k == "connector_tools" and v is None)}
        cleaned.setdefault("connector_tools", None)
        ids = merged["integration_ids"]
        if ids is not None:
            if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
                raise ValueError("integration_ids is null or a list of tool server ids")
        cat = catalog.catalogue(scope.owner, scope.is_admin)
        apps = {a["id"]: a for a in cat["apps"]}
        for app_id, grant in (cleaned["connector_tools"] or {}).items():
            app = apps.get(app_id)
            if app is None or not app["available"]:
                raise Unavailable(f"{app_id} is not available, so it cannot be switched on.")
            if cleaned["connector_scopes"].get(app_id) not in ("read", "write"):
                raise ValueError(f"choose read or write for {app['name']} before giving it tools")
            if grant["tools"] != "*":
                have = {t["name"] for t in app["tools"] if t["available"]}
                missing = [t for t in grant["tools"] if t not in have]
                if missing:
                    raise Unavailable(f"{missing[0]} is not available, so it cannot be switched on.")
        if ids is not None:
            known = {s["id"] for s in cat["servers"]}
            if any(i not in known for i in ids):
                raise Unavailable("one of those tool servers is not connected.")
        fields = {**cleaned, "integration_ids": ids}
        if cleaned["connector_tools"] is not None:
            fields["grants_version"] = max(1, int(record.get("grants_version") or 0))
        agent_service.update(scope.bot_id, actor="user", **fields)
        return effective(scope)
