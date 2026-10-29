"""The resource fields of a bot record (Bots redesign, Phase 2 unit U4, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.3 and 7 (U4).

services/bot_record.py owns the record and calls in here for the Phase 2 fields so every
unit's validation lives in one place:

  memory_enabled    notebook injection, recall and model memory writes (default on)
  helper_model      lets side jobs fall back to the configured helper (default on)
  connector_tools   null keeps the legacy tool selection; {} grants no app tools; otherwise
                    {app_id: {"tools": "*" | [tool names], "accounts": [account ids]?}}
  grants_version    0 = a migrated record read the legacy way, 1 = saved from the grants form

It also holds the protected resource-settings document's validator (helper endpoint, tidy
time, capture quiet interval, room capture, skill review) that the connections route
stores, and the one-time translation of server-name selectors to integration ids.
Nothing here widens a bot: every function either validates or narrows.
"""
import re
from typing import Optional

MAX_APPS = 64
MAX_TOOLS = 500
MAX_ACCOUNTS = 32
MAX_GRANTS_VERSION = 1000
APP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\Z")
TOOL_NAME = re.compile(r"[^\s\x00-\x1f]{1,200}\Z")

RESOURCE_FIELDS = ("memory_enabled", "helper_model", "connector_tools", "grants_version")
# What a person may set through create and PATCH. grants_version only ever rises.
RESOURCE_EDITABLE = RESOURCE_FIELDS
# Preferences a saved default may carry. Never connector_tools: defaults carry no grants.
RESOURCE_DEFAULT_FIELDS = ("memory_enabled", "helper_model")

TIDY_TIME = re.compile(r"([01]\d|2[0-3]):([0-5]\d)\Z")


def defaults() -> dict:
    """Each field with its default on a new or upgraded record."""
    return {"memory_enabled": True, "helper_model": True, "connector_tools": None, "grants_version": 0}


def _flag(value, label: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{label} is true or false")
    return value


def clean_connector_tools(value) -> Optional[dict]:
    """null, or {app_id: {"tools": "*" | [names], "accounts": [ids]?}}. A whole record, even an
    empty one, means only what it names is allowed (design 3.3)."""
    if value is None:
        return None
    if not isinstance(value, dict) or len(value) > MAX_APPS:
        raise ValueError(f"connector_tools maps up to {MAX_APPS} apps to the tools they may use")
    cleaned, total = {}, 0
    for app_id, grant in value.items():
        if not isinstance(app_id, str) or not APP_ID.fullmatch(app_id):
            raise ValueError("connector_tools app ids are 1 to 80 letters, digits or - _ . :")
        if not isinstance(grant, dict) or set(grant) - {"tools", "accounts"} or "tools" not in grant:
            raise ValueError("each app in connector_tools is {tools, accounts?}")
        tools = grant["tools"]
        if tools == "*":
            chosen = "*"
        elif isinstance(tools, list) and all(isinstance(t, str) and TOOL_NAME.fullmatch(t) for t in tools):
            chosen = list(dict.fromkeys(tools))
            total += len(chosen)
        else:
            raise ValueError("an app's tools are * or a list of tool names of 1 to 200 characters")
        entry = {"tools": chosen}
        if grant.get("accounts") is not None:
            accounts = grant["accounts"]
            if (not isinstance(accounts, list) or len(accounts) > MAX_ACCOUNTS
                    or any(not isinstance(a, str) or not 1 <= len(a) <= 200 for a in accounts)):
                raise ValueError(f"an app's accounts are a list of up to {MAX_ACCOUNTS} account ids")
            entry["accounts"] = list(dict.fromkeys(accounts))
        cleaned[app_id] = entry
    if total > MAX_TOOLS:
        raise ValueError(f"connector_tools names up to {MAX_TOOLS} tools in all; this is {total}")
    return cleaned


def clean_field(key: str, value, current: Optional[dict] = None):
    """Validate one resource field. ValueError for bad input."""
    if key in ("memory_enabled", "helper_model"):
        return _flag(value, key)
    if key == "connector_tools":
        return clean_connector_tools(value)
    if key == "grants_version":
        if type(value) is not int or not 0 <= value <= MAX_GRANTS_VERSION:
            raise ValueError(f"grants_version must be a whole number from 0 to {MAX_GRANTS_VERSION}")
        if value < int((current or {}).get("grants_version") or 0):
            raise ValueError("grants_version can only go up: a saved grants form is not read the legacy way again")
        return value
    raise ValueError(f"{key} cannot be changed")


# -- the protected resource-settings document -----------------------------------------------

SETTINGS_KEYS = ("helper_endpoint_id", "tidy_time", "capture_quiet_minutes", "room_capture", "skill_review")


def settings_defaults() -> dict:
    """Tidy at 03:00 and capture after five quiet minutes: Kairos's quiet-time baseline."""
    return {"helper_endpoint_id": None, "tidy_time": "03:00", "capture_quiet_minutes": 5,
            "room_capture": False, "skill_review": {"enabled": True, "steps": 10}}


def clean_resource_settings(value, current: Optional[dict] = None) -> dict:
    """A whole settings document from a partial change. Unknown keys are refused."""
    if not isinstance(value, dict):
        raise ValueError("resource settings is an object")
    extra = sorted(set(value) - set(SETTINGS_KEYS))
    if extra:
        raise ValueError(f"resource settings cannot carry {', '.join(extra)}")
    merged = {**settings_defaults(), **(current or {})}
    for key, item in value.items():
        if key == "helper_endpoint_id":
            if item is not None and (not isinstance(item, str) or not 1 <= len(item) <= 200):
                raise ValueError("helper_endpoint_id is a model connection id or null")
            merged[key] = item
        elif key == "tidy_time":
            if not isinstance(item, str) or not TIDY_TIME.fullmatch(item):
                raise ValueError("tidy_time is HH:MM, 24 hours")
            merged[key] = item
        elif key == "capture_quiet_minutes":
            if type(item) is not int or not 1 <= item <= 240:
                raise ValueError("capture_quiet_minutes is a whole number from 1 to 240")
            merged[key] = item
        elif key == "room_capture":
            merged[key] = _flag(item, key)
        elif key == "skill_review":
            if not isinstance(item, dict) or set(item) - {"enabled", "steps"}:
                raise ValueError("skill_review is {enabled, steps}")
            review = {**merged["skill_review"]}
            if "enabled" in item:
                review["enabled"] = _flag(item["enabled"], "skill_review enabled")
            if "steps" in item:
                if type(item["steps"]) is not int or not 3 <= item["steps"] <= 100:
                    raise ValueError("skill_review steps is a whole number from 3 to 100")
                review["steps"] = item["steps"]
            merged[key] = review
    return merged


# -- one-time translation of server-name selectors to integration ids -----------------------

_MCP_SELECTOR = re.compile(r"mcp:([^:\s]+):(\S+)\Z")


def _by_name(servers) -> dict:
    names: dict = {}
    for server in servers:
        names.setdefault(str(server.get("name") or ""), []).append(server["id"])
    return names


def translate_selector(selector: str, servers) -> str:
    """mcp:<server name>:<tool> becomes mcp:<integration id>:<tool> when the name picks exactly one
    server and is not already an id. Ambiguous or unknown names stay as written: an ambiguous allow
    grants nothing, and an ambiguous deny still blocks every candidate (services/bot_grants.py)."""
    match = _MCP_SELECTOR.match(selector)
    if not match:
        return selector
    server, tool = match.groups()
    if any(item["id"] == server for item in servers):
        return selector
    ids = _by_name(servers).get(server, [])
    return f"mcp:{ids[0]}:{tool}" if len(ids) == 1 else selector


def translate_record(record: dict, servers) -> bool:
    """Rewrite one record's tool_scope selectors and connector_scopes keys to integration ids, in
    place. True when anything changed. A second run changes nothing. An `off` scope is never
    dropped, and a key that cannot be placed stays so a later server of that name cannot slip by."""
    changed = False
    scope = record.get("tool_scope")
    if isinstance(scope, dict):
        for part in ("allow", "deny"):
            items = scope.get(part)
            if isinstance(items, list):
                rewritten = list(dict.fromkeys(translate_selector(s, servers) if isinstance(s, str) else s
                                               for s in items))
                if rewritten != items:
                    scope[part] = rewritten
                    changed = True
    apps = record.get("connector_scopes")
    if isinstance(apps, dict):
        names = _by_name(servers)
        known = {item["id"] for item in servers}
        rewritten = {}
        for key, level in apps.items():
            target = key
            if key not in known and len(names.get(key, [])) == 1:
                target = names[key][0]
            # When two keys land on one app the stricter level wins.
            if target in rewritten:
                order = ("off", "read", "write")
                level = min(level, rewritten[target], key=lambda v: order.index(v) if v in order else 0)
            rewritten[target] = level
        if rewritten != apps:
            record["connector_scopes"] = rewritten
            changed = True
    if isinstance(record.get("connector_tools"), dict) and int(record.get("grants_version") or 0) < 1:
        record["grants_version"] = 1
        changed = True
    return changed
