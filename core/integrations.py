"""Integrations — Settings > Integrations (David's ask 2026-08-31, matching
Odysseus's "Add Integration" panel — a real screenshot, not guessed).

Odysseus's dropdown offers 8 types: API Service, CalDAV Calendar, Claude
Agent, Codex Agent, Contacts (CardDAV), Contacts Import, Email (IMAP/SMTP),
MCP Tool Server. Built:

- api_service: a generic name/base-URL/API-key record.
- mcp_server: real — widens the agent's actual tool access (core/brain.py).
- caldav_calendar: real, one-way read sync via core/dav_client.py, merges
  into services/calendar_service.py tagged by sync_id (David's follow-up ask
  2026-08-31, after initially scoping this out for lack of any WebDAV
  client — built one, see dav_client.py for the real scope/limits).
- carddav_contacts: real, one-way read sync, stored in
  core/contacts_store.py and viewable from the Integrations panel itself
  (no dedicated Contacts tab exists yet).
- email: NOT a separate stored kind — Email already has its own tab/service
  (services/email_service.py) with full account CRUD; the Integrations
  panel's "Email (IMAP/SMTP)" entry just opens that tab rather than
  duplicating account storage.

Still not offered: Claude Agent (Claude is a hardcoded Claude Agent SDK
path, not an API-key config like the other providers) and Codex Agent
(not integrated anywhere) — no foundation, not built as fake UI.

MCP servers, roadmap phase 6 (2026-10-06; spec: the vault note "Skills and
Integrations - Phase 6 (Build Spec)"):
- Health: each check of a server (Tool Store's Check, adding it, a chat
  connecting, the task loop every CHECK_EVERY_SECONDS) is kept as its
  `status`: working with its tool count, down with the error, or signed out.
- Pinning: the first good check records each tool's fingerprint (its name,
  description and input schema). A tool that later appears, or whose
  description or schema changes, is held: no model is offered it until a
  person accepts it in Tool Store. MCP tool descriptions are read by the
  model, so a rewritten one is a way to slip instructions in; this stops a
  server changing its tools underneath you.
- A clean environment: a stdio server starts through
  mcp_servers/clean_launch.py, which passes it only safe system variables
  and its own key, on every model kind. Claude Code used to start it with
  the whole environment the backend had.
"""
import hashlib
import json
import os
import re
import sys
import time
import uuid
from typing import Any, Optional

from core.atomic_io import read_json, write_json_atomic
from core import accounts
from core.secret_storage import decrypt, encrypt

INTEGRATIONS_FILE = None  # tests may point this at their own file; else the current account's integrations.json
CLEAN_LAUNCHER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mcp_servers", "clean_launch.py")
CHECK_EVERY_SECONDS = 30 * 60

KINDS = {"api_service", "mcp_server", "caldav_calendar", "carddav_contacts", "ical_feed"}
MCP_TYPES = {"stdio", "http"}
PASS_ENV = "KAIROS_MCP_PASS_ENV"
MAX_MCP_SERVERS = 20
DEFAULT_CALL_MINUTES = 10
DEFAULT_RESULT_BUDGET = 8_000


def integrations_file() -> str:
    return INTEGRATIONS_FILE or accounts.path("integrations.json")


def _load() -> dict:
    return read_json(integrations_file(), {})


def _masked(item: dict) -> dict:
    out = {"id": item["id"], "kind": item["kind"], "name": item["name"]}
    out["enabled"] = item.get("enabled", True)
    if item["kind"] == "api_service":
        out["base_url"] = item.get("base_url", "")
        out["has_api_key"] = bool(item.get("api_key_encrypted"))
    elif item["kind"] == "mcp_server":
        out["mcp_type"] = item.get("mcp_type")
        from core.rea_integration import is_rea
        out["rea_managed"] = is_rea(item)
        if item.get("mcp_type") == "stdio":
            out["command"] = item.get("command", "")
            out["args"] = item.get("args", [])
        else:
            out["url"] = item.get("url", "")
            out["http_kind"] = item.get("http_kind") or "http"
        out["has_api_key"] = bool(item.get("api_key_encrypted"))
        # Saved header and environment values are write-only: only their names ever leave this module.
        out["header_names"] = sorted(item.get("headers_encrypted") or {})
        out["env_names"] = sorted(item.get("env_encrypted") or {})
        out["call_timeout_minutes"] = item.get("call_timeout_minutes", DEFAULT_CALL_MINUTES)
        out["result_budget"] = item.get("result_budget", DEFAULT_RESULT_BUDGET)
        out["origin"] = item.get("origin") or "added"
        client = item.get("oauth_client") or {}
        out["oauth_client"] = ({"client_id": client.get("client_id", ""), "scopes": client.get("scopes", ""),
                                "has_secret": bool(client.get("client_secret_encrypted"))} if client else None)
        out["auth"] = item.get("auth") or ("key" if item.get("api_key_encrypted") else "none")
        out["signed_in"] = bool((item.get("oauth") or {}).get("tokens"))
        status = item.get("status")
        if out["auth"] == "oauth":
            # A sign-in, sign-out or dead refresh changes the tokens without a check,
            # so the health follows the tokens as they are now, not the last check.
            if not out["signed_in"]:
                status = {"state": "signed_out", "tools": None, "checked_at": (status or {}).get("checked_at"), "error": None}
            elif (status or {}).get("state") == "signed_out":
                status = None
        out["status"] = status
        out["pinned"] = "pinned_tools" in item
        out["held_tools"] = [{"name": name, **{k: held[k] for k in ("kind", "description")}}
                             for name, held in sorted((item.get("held_tools") or {}).items())]
    elif item["kind"] in ("caldav_calendar", "carddav_contacts", "ical_feed"):
        out["url"] = item.get("url", "")
        out["username"] = item.get("username", "")
        out["last_synced_count"] = item.get("last_synced_count")
    return out


def list_integrations() -> list[dict]:
    return [_masked(i) for i in _load().values()]


CATALOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_catalog.json")


def mcp_catalog() -> list[dict]:
    """Known MCP servers (core/mcp_catalog.json, adapted from Hermes Agent's
    catalog), each marked with whether it is already added here. Those that
    need no sign-in can be added in one step; OAuth ones are added and then
    signed in to (core/mcp_oauth.py). Either way it is an ordinary MCP Tool
    Server integration."""
    import json
    with open(CATALOG_FILE, encoding="utf-8") as f:
        servers = json.load(f)["servers"]
    # REA is a local command rather than a hosted HTTP endpoint. Keep it
    # separate from the Hermes-sourced JSON catalog and its regeneration rule.
    from core.rea_integration import REA_PACKAGE, existing
    servers.append({"id": "rea", "name": "REA", "description":
                    "Inspect applications, websites, JavaScript, binaries and runtime behavior with evidence.",
                    "transport": "stdio", "auth": "none", "package": REA_PACKAGE,
                    "docs": "https://github.com/morluto/rea"})
    added = {(i.get("url") or "").rstrip("/") for i in _load().values() if i.get("kind") == "mcp_server"}
    return [{**s, "added": bool(existing()) if s["id"] == "rea" else
             (s.get("url") or "").rstrip("/") in added} for s in servers]


def list_mcp_servers_runtime(only_ids: Optional[list[str]] = None) -> dict[str, dict]:
    """Live mcp_servers dict for ClaudeAgentOptions, keys are integration
    names, secrets decrypted — runtime use only, never returned from an API.

    `only_ids` restricts to specific integrations (David's ask 2026-08-31,
    Claude-style per-conversation connector toggle — see
    core/session_manager.py's enabled_integration_ids). None keeps ordinary
    registered servers available; REA is opt-in per chat or agent."""
    servers = {}
    from core.rea_integration import is_rea
    for item in _load().values():
        if item["kind"] != "mcp_server" or not item.get("enabled", True):
            continue
        if only_ids is None and is_rea(item):
            continue  # REA needs an explicit choice in this chat or agent.
        if item.get("mcp_type") == "stdio" and not accounts.has_machine_access():
            continue  # a local command is this computer's to run; a record made earlier does not start without the grant
        if only_ids is not None and item["id"] not in only_ids:
            continue
        api_key = decrypt(item["api_key_encrypted"]) if item.get("api_key_encrypted") else None
        if item.get("mcp_type") == "stdio":
            # Through the clean launcher (the module docstring), whoever starts it.
            cfg: dict[str, Any] = {"type": "stdio", "command": sys.executable,
                                   "args": ["-I", CLEAN_LAUNCHER, "--", item["command"], *(item.get("args") or [])]}
            if api_key:
                cfg["env"] = {"MCP_API_KEY": api_key}
            if item.get("env_encrypted"):
                user_env = {n: decrypt(v) for n, v in item["env_encrypted"].items()}
                cfg.setdefault("env", {}).update(user_env)
                # mcp_servers/clean_launch.py hands a server only safe variables; this names the ones the
                # person set for this server so the launcher passes exactly those on.
                cfg["env"][PASS_ENV] = ",".join(sorted(user_env))
            if is_rea(item):
                cfg.setdefault("env", {})["REA_MCP_INPUT_SCHEMA_PROFILE"] = "compact"
        else:
            cfg = {"type": "sse" if item.get("http_kind") == "sse" else "http", "url": item["url"]}
            if item.get("auth") == "oauth":
                # Signed in through core/mcp_oauth.py, which keeps the token
                # fresh. Not signed in: left out, rather than handed to a
                # model as a server that can only answer 401.
                api_key = _oauth_access_token(item)
                if not api_key:
                    continue
            if item.get("headers_encrypted"):
                cfg["headers"] = {n: decrypt(v) for n, v in item["headers_encrypted"].items()}
            if api_key:
                cfg.setdefault("headers", {})["Authorization"] = f"Bearer {api_key}"
        servers[item["name"]] = cfg
    return servers


# -- MCP health and pinned tools (phase 6) ---------------------------------------

def tool_fingerprint(tool: dict) -> str:
    blob = json.dumps([tool.get("name"), tool.get("description") or "", tool.get("schema") or {}], sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _mcp_item(data: dict, item_id: Optional[str] = None, name: Optional[str] = None) -> Optional[dict]:
    for item in data.values():
        if item.get("kind") == "mcp_server" and (item["id"] == item_id or (name is not None and item["name"] == name)):
            return item
    return None


def record_check(item_id: Optional[str] = None, tools: Optional[list[dict]] = None, error: Optional[str] = None,
                 signed_out: bool = False, name: Optional[str] = None) -> Optional[dict]:
    """Keep one check of a server: its status, and with a good tool list its
    pins and held tools. The first good check pins every tool it found.
    Returns the masked record, or None for an unknown server."""
    data = _load()
    item = _mcp_item(data, item_id, name)
    if item is None:
        return None
    now = time.time()
    if signed_out:
        item["status"] = {"state": "signed_out", "tools": None, "checked_at": now, "error": None}
    elif tools is None:
        item["status"] = {"state": "down", "tools": None, "checked_at": now, "error": (error or "no answer")[:300]}
    else:
        current = {t["name"]: {"fingerprint": tool_fingerprint(t), "description": (t.get("description") or "")[:500]}
                   for t in tools}
        # A read-only catalog for composer references. Never cache runtime config.
        marker = "\n[Tool description truncated.]"
        item["discovered_tools"] = {
            t["name"]: {"fingerprint": current[t["name"]]["fingerprint"],
                        "description": (t.get("description") or "") if len(t.get("description") or "") <= 8000
                        else t["description"][:8000 - len(marker)] + marker}
            for t in tools}
        # The server's own read-only claim for each tool that made one; app grants classify from it (kept apart so
        # the discovered catalog's shape stays as composer references expect it).
        item["tool_read_only"] = {t["name"]: t["read_only"] for t in tools if isinstance(t.get("read_only"), bool)}
        if "pinned_tools" not in item:
            item["pinned_tools"] = {n: c["fingerprint"] for n, c in current.items()}
        pinned = item["pinned_tools"]
        item["held_tools"] = {n: {**c, "kind": "new" if n not in pinned else "changed"}
                              for n, c in current.items() if pinned.get(n) != c["fingerprint"]}
        item["status"] = {"state": "working", "tools": len(current) - len(item["held_tools"]), "checked_at": now,
                          "error": None}
    write_json_atomic(integrations_file(), data)
    return _masked(item)


def reference_tools(only_ids=None, user=None, is_admin=False, surface="claude") -> list[dict]:
    """Previously checked, pinned tools of connected servers, without config.

    Checks already run when connecting and periodically. Opening the picker
    must not launch a server, refresh credentials or change a pin.
    """
    found = []
    from core.rea_integration import is_rea
    for item in _load().values():
        if (item.get("kind") != "mcp_server" or not item.get("enabled", True)
                or (only_ids is None and is_rea(item))
                or (only_ids is not None and item["id"] not in only_ids)
                or (item.get("admin_only") and not is_admin)
                or (item.get("owner") and item["owner"] != user and not is_admin)
                or (item.get("status") or {}).get("state") != "working"
                or (item.get("auth") == "oauth" and not (item.get("oauth") or {}).get("tokens"))):
            continue
        for name, tool in (item.get("discovered_tools") or {}).items():
            if (name in (item.get("held_tools") or {})
                    or (item.get("pinned_tools") or {}).get(name) != tool.get("fingerprint")):
                continue
            if surface == "openai":
                from core import mcp_client
                tool_name = mcp_client.function_name(item["name"], name, {t["name"] for t in found})
            else:
                tool_name = claude_tool_name(item["name"], name)
            if len(tool_name) > 200 or len(f"mcp:{item['id']}:{name}") > 500:
                continue
            found.append({"id": f"mcp:{item['id']}:{name}", "name": tool_name,
                          "description": tool.get("description") or ""})
    return found


def held_tools(only_ids: Optional[list[str]] = None) -> dict[str, set]:
    """Held tool names by server name, for the servers a chat may use."""
    return {item["name"]: set(item.get("held_tools") or {}) for item in _load().values()
            if item.get("kind") == "mcp_server" and (only_ids is None or item["id"] in only_ids)
            and item.get("held_tools")}


def claude_tool_name(server: str, tool: str) -> str:
    """The name Claude Code gives an MCP tool: mcp__<server>__<tool>, with
    anything outside letters, digits, _ and - made an underscore."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", f"mcp__{server}__{tool}")


def accept_tools(item_id: str, names: list[str]) -> dict:
    """Pin these held tools as they were when the person reviewed them. A
    tool that changed again since stays held."""
    data = _load()
    item = _mcp_item(data, item_id)
    if item is None:
        raise KeyError(item_id)
    held = item.get("held_tools") or {}
    unknown = [n for n in names if n not in held]
    if unknown:
        raise ValueError(f"not waiting for review: {', '.join(unknown)}")
    for name in names:
        item.setdefault("pinned_tools", {})[name] = held.pop(name)["fingerprint"]
    if item.get("status", {}).get("state") == "working":
        item["status"]["tools"] = (item["status"].get("tools") or 0) + len(names)
    write_json_atomic(integrations_file(), data)
    return _masked(item)


def _oauth_access_token(item: dict) -> Optional[str]:
    import json
    raw = (item.get("oauth") or {}).get("tokens")
    return json.loads(decrypt(raw)).get("access_token") if raw else None


def create_api_service(name: str, base_url: str, api_key: Optional[str] = None) -> dict:
    data = _load()
    item_id = uuid.uuid4().hex[:12]
    data[item_id] = {
        "id": item_id, "kind": "api_service", "name": name,
        "base_url": base_url.rstrip("/"),
        "api_key_encrypted": encrypt(api_key) if api_key else None,
    }
    write_json_atomic(integrations_file(), data)
    return _masked(data[item_id])


def create_mcp_server(name: str, mcp_type: str, command: Optional[str] = None,
                       args: Optional[list[str]] = None, url: Optional[str] = None,
                       api_key: Optional[str] = None, auth: Optional[str] = None, *, replace_id=None) -> dict:
    """`auth="oauth"` marks a server that is used only once signed in
    (core/mcp_oauth.py); the catalog's sign-in servers are added that way."""
    if mcp_type not in MCP_TYPES:
        raise ValueError("mcp_type must be 'stdio' or 'http'")
    if mcp_type == "stdio":
        accounts.require_machine_access("A local MCP command")
    if mcp_type == "stdio" and not command:
        raise ValueError("command is required for a stdio MCP server")
    if mcp_type == "http" and not url:
        raise ValueError("url is required for an http MCP server")
    if auth not in (None, "oauth") or (auth == "oauth" and mcp_type != "http"):
        raise ValueError("auth may only be 'oauth', and only for an http MCP server")
    data = _load()
    previous = data.get(replace_id) if replace_id else None
    if replace_id and (not previous or previous["kind"] != "mcp_server"):
        raise ValueError("Store update requires an existing MCP server")
    if not previous and sum(1 for i in data.values() if i.get("kind") == "mcp_server") >= MAX_MCP_SERVERS:
        raise ValueError(f"Kairos keeps up to {MAX_MCP_SERVERS} MCP servers. Remove one first.")
    item_id = replace_id or uuid.uuid4().hex[:12]
    data[item_id] = {
        "id": item_id, "kind": "mcp_server", "name": name, "mcp_type": mcp_type,
        "command": command, "args": args or [], "url": url,
        "api_key_encrypted": encrypt(api_key) if api_key else None,
    }
    if auth:
        data[item_id]["auth"] = auth
    if previous:
        for key in ("pinned_tools", "enabled"):
            if key in previous:
                data[item_id][key] = previous[key]
        if previous.get("url") == url and previous.get("auth") == auth and previous.get("oauth"):
            data[item_id]["oauth"] = previous["oauth"]
    write_json_atomic(integrations_file(), data)
    return _masked(data[item_id])


# -- the MCP editor's storage (services/bot_mcp_config.py validates; this module stores) ----------

def _secret_slots(previous: dict, given: Optional[dict], label: str) -> dict:
    """Encrypted name -> value slots. A string replaces, True keeps the saved value, a name left out is removed."""
    out = {}
    for name, value in (given or {}).items():
        if value is True:
            if name not in previous:
                raise ValueError(f"{label} {name} has no saved value to keep")
            out[name] = previous[name]
        elif isinstance(value, str) and value:
            out[name] = encrypt(value)
        else:
            raise ValueError(f"{label} {name} needs a value")
    return out


def save_mcp_config(fields: dict, replace_id: Optional[str] = None) -> dict:
    """Create or replace an MCP server from validated editor fields. Returns the masked record.

    Secret slots (headers, environment, key, OAuth client secret) are write-only: a string replaces the saved
    value, True keeps it, a missing name is removed. Tool pins, health and a still-valid sign-in carry over."""
    if fields.get("mcp_type") == "stdio":
        accounts.require_machine_access("A local MCP command")
    data = _load()
    previous = data.get(replace_id) if replace_id else None
    if replace_id and (not previous or previous["kind"] != "mcp_server"):
        raise KeyError(replace_id)
    if not previous and sum(1 for i in data.values() if i.get("kind") == "mcp_server") >= MAX_MCP_SERVERS:
        raise ValueError(f"Kairos keeps up to {MAX_MCP_SERVERS} MCP servers. Remove one first.")
    if previous and fields["name"] != previous["name"]:
        raise ValueError("a server's name cannot change once it is added")
    if any(i.get("kind") == "mcp_server" and i["name"] == fields["name"] and i["id"] != replace_id for i in data.values()):
        raise ValueError("another MCP server already uses that name")
    old = previous or {}
    item_id = replace_id or uuid.uuid4().hex[:12]
    item = {"id": item_id, "kind": "mcp_server", "name": fields["name"], "mcp_type": fields["mcp_type"],
            "command": fields.get("command"), "args": fields.get("args") or [], "url": fields.get("url"),
            "http_kind": fields.get("http_kind") if fields["mcp_type"] == "http" else None,
            "call_timeout_minutes": fields.get("call_timeout_minutes", old.get("call_timeout_minutes", DEFAULT_CALL_MINUTES)),
            "result_budget": fields.get("result_budget", old.get("result_budget", DEFAULT_RESULT_BUDGET)),
            "enabled": fields.get("enabled", old.get("enabled", True)), "origin": fields.get("origin") or old.get("origin") or "added"}
    item["headers_encrypted"] = _secret_slots(old.get("headers_encrypted") or {}, fields.get("headers"), "header")
    item["env_encrypted"] = _secret_slots(old.get("env_encrypted") or {}, fields.get("env"), "variable")
    key = fields.get("api_key", "keep" if previous else None)
    item["api_key_encrypted"] = old.get("api_key_encrypted") if key == "keep" else (encrypt(key) if key else None)
    if fields.get("auth"):
        item["auth"] = fields["auth"]
    client = fields.get("oauth_client")
    if client:
        secret = client.get("client_secret", "keep" if previous else None)
        old_secret = (old.get("oauth_client") or {}).get("client_secret_encrypted")
        item["oauth_client"] = {"client_id": client["client_id"], "scopes": client.get("scopes", ""),
                                "client_secret_encrypted": old_secret if secret in ("keep", True) else (encrypt(secret) if secret else None)}
    if previous:
        for keep in ("pinned_tools", "held_tools", "discovered_tools", "status"):
            if keep in previous:
                item[keep] = previous[keep]
        if previous.get("url") == item["url"] and previous.get("auth") == item.get("auth") and previous.get("oauth"):
            item["oauth"] = previous["oauth"]
    data[item_id] = item
    write_json_atomic(integrations_file(), data)
    return _masked(item)


def mcp_options(item_id_or_name: str) -> dict:
    """How long a call may take and how much of a result a model reads, for one server."""
    for item in _load().values():
        if item.get("kind") == "mcp_server" and item_id_or_name in (item["id"], item["name"]):
            return {"id": item["id"], "name": item["name"],
                    "call_timeout_seconds": int(item.get("call_timeout_minutes", DEFAULT_CALL_MINUTES)) * 60,
                    "result_budget": item.get("result_budget", DEFAULT_RESULT_BUDGET)}
    return {"id": None, "name": item_id_or_name, "call_timeout_seconds": DEFAULT_CALL_MINUTES * 60,
            "result_budget": DEFAULT_RESULT_BUDGET}


def secret_values(item: dict) -> list[str]:
    """Every secret an MCP record holds, decrypted: for redacting them from an error, never for an API."""
    values = []
    for token in [item.get("api_key_encrypted"), *(item.get("headers_encrypted") or {}).values(),
                  *(item.get("env_encrypted") or {}).values(),
                  (item.get("oauth_client") or {}).get("client_secret_encrypted")]:
        if token:
            try:
                values.append(decrypt(token))
            except Exception:
                continue
    try:
        access = _oauth_access_token(item)
        if access:
            values.append(access)
    except Exception:
        pass
    return [v for v in values if len(v) >= 4]


def redact(item: Optional[dict], text: str) -> str:
    """`text` with the record's configured secret values replaced by [hidden]."""
    for value in sorted(secret_values(item or {}), key=len, reverse=True):
        text = text.replace(value, "[hidden]")
    return text


def create_dav(kind: str, name: str, url: str, username: str, password: str) -> dict:
    if kind not in ("caldav_calendar", "carddav_contacts"):
        raise ValueError("kind must be 'caldav_calendar' or 'carddav_contacts'")
    data = _load()
    item_id = uuid.uuid4().hex[:12]
    data[item_id] = {
        "id": item_id, "kind": kind, "name": name, "url": url.rstrip("/") + "/",
        "username": username, "password_encrypted": encrypt(password),
        "last_synced_count": None,
    }
    write_json_atomic(integrations_file(), data)
    return _masked(data[item_id])


def get_dav_credentials(item_id: str) -> tuple[str, str, str]:
    """(url, username, password) with the password decrypted — runtime use
    (sync) only, never returned from an API."""
    item = _load().get(item_id)
    if item is None:
        raise KeyError(f"no such integration: {item_id}")
    return item["url"], item["username"], decrypt(item["password_encrypted"])


def create_ical_feed(name: str, url: str, username: Optional[str] = None, password: Optional[str] = None) -> dict:
    """Plain iCal (.ics) feed subscription (David's ask 2026-08-31) — a
    single specific resource URL, unlike CalDAV's collection URL, so no
    trailing slash is forced on it. Username/password optional since most
    public iCal feeds (Google's "secret address", Apple share links) need
    no auth at all."""
    data = _load()
    item_id = uuid.uuid4().hex[:12]
    data[item_id] = {
        "id": item_id, "kind": "ical_feed", "name": name, "url": url,
        "username": username or "", "password_encrypted": encrypt(password) if password else None,
        "last_synced_count": None,
    }
    write_json_atomic(integrations_file(), data)
    return _masked(data[item_id])


def get_ical_credentials(item_id: str) -> tuple[str, Optional[str], Optional[str]]:
    item = _load().get(item_id)
    if item is None:
        raise KeyError(f"no such integration: {item_id}")
    password = decrypt(item["password_encrypted"]) if item.get("password_encrypted") else None
    return item["url"], (item.get("username") or None), password


def record_sync_count(item_id: str, count: int) -> None:
    data = _load()
    if item_id in data:
        data[item_id]["last_synced_count"] = count
        write_json_atomic(integrations_file(), data)


def delete_integration(item_id: str) -> None:
    data = _load()
    data.pop(item_id, None)
    write_json_atomic(integrations_file(), data)


def set_enabled(item_id: str, enabled: bool) -> dict:
    """Suspend a server while preserving credentials and tool acceptance."""
    data = _load()
    if item_id not in data:
        raise KeyError(item_id)
    data[item_id]["enabled"] = enabled
    write_json_atomic(integrations_file(), data)
    return _masked(data[item_id])


def get_integration(item_id: str) -> Optional[dict]:
    return _load().get(item_id)


def get_integration_masked(item_id: str) -> Optional[dict]:
    item = _load().get(item_id)
    return _masked(item) if item else None
