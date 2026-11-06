"""Connected apps: one inventory over everything a bot can be given (Phase 2, unit U5).

Reads what already exists (MCP servers and their sign-ins, Google accounts, mailboxes, calendar and
contact feeds, the cards for HighLevel, X research and Whop) and shows it as apps with accounts,
a state, a category and which bots use it. Nothing here stores a credential. The only state it
owns is account aliases (`bot-connections/aliases.json`): a short name per account, required when
an app has more than one so a bot is never ambiguous about which mailbox it means.

Exposed for the grant catalogue (U4): `catalogue_entries()` lists each connected app with its
accounts and classified tools (`mcp:<integration id>:<tool>` selectors, effect read/write/unknown).
`usable_for` for saved logins lives in bot_logins.py.
"""
import os
import threading
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from services import bot_connection_catalog as catalog
from services.bot_app_adapters import AdapterError, EmailAdapter, GoogleAdapter, McpAdapter

MAX_ALIAS = 64
ALIAS_FILE = "aliases.json"
_lock = threading.RLock()


class ConnectionError_(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _alias_path() -> str:
    from core import accounts
    return accounts.path("bot-connections", ALIAS_FILE)


def _aliases() -> dict:
    data = read_json(_alias_path(), {})
    return data if isinstance(data, dict) else {}


def _save_aliases(data: dict) -> None:
    os.makedirs(os.path.dirname(_alias_path()), exist_ok=True)
    write_json_atomic(_alias_path(), data)


def clean_alias(value) -> str:
    text = " ".join(str(value or "").split())
    if not text or len(text) > MAX_ALIAS or any(ord(c) < 32 for c in text):
        raise ConnectionError_(f"An alias is 1 to {MAX_ALIAS} characters.")
    return text


def set_alias(app_id: str, account_id: str, alias, owner: str = "") -> dict:
    """Name one account. Aliases are unique within an app, ignoring case."""
    text = clean_alias(alias)
    with _lock:
        app = _app(app_id, owner)
        if app is None:
            raise ConnectionError_("That app was not found.", 404)
        if account_id not in {a["id"] for a in app["accounts"]}:
            raise ConnectionError_("That account was not found.", 404)
        data = _aliases()
        taken = {k.split("/", 1)[1]: v["alias"].lower() for k, v in data.items() if k.startswith(app_id + "/")}
        if any(other != account_id and name == text.lower() for other, name in taken.items()):
            raise ConnectionError_("Another account of this app already has that alias.", 409)
        data[f"{app_id}/{account_id}"] = {"alias": text}
        _save_aliases(data)
    return {"app": app_id, "account": account_id, "alias": text}


def _apply_aliases(app_id: str, accounts: list[dict]) -> list[dict]:
    with _lock:
        data = _aliases()
        changed = False
        waiting = data.get(f"{app_id}/pending") or {}
        pending, known = waiting.get("alias"), set(waiting.get("known") or [])
        for account in accounts:
            key = f"{app_id}/{account['id']}"
            # A new account (one that was not there when the sign-in began) takes the alias that was typed for it.
            if key not in data and pending and account["id"] not in known:
                data[key] = {"alias": pending}
                data.pop(f"{app_id}/pending", None)
                pending, changed = None, True
            account["alias"] = (data.get(key) or {}).get("alias", "")
        if changed:
            _save_aliases(data)
    return accounts


def _forget_aliases(app_id: str, account_id: Optional[str] = None) -> None:
    with _lock:
        data = _aliases()
        keep = {k: v for k, v in data.items() if not (k == f"{app_id}/{account_id}" if account_id else k.startswith(app_id + "/"))}
        if keep != data:
            _save_aliases(keep)


# -- inventory -----------------------------------------------------------------------------------

def _agents() -> list[dict]:
    from services.agent_service import agent_service
    return [a for a in agent_service.list_agents() if not a.get("hidden")]


def _users(app_id: str, integration_default: bool, agents: list[dict]) -> list[dict]:
    """Bots that can reach an app: an explicit scope, or (for an MCP server) the server list they select."""
    found = []
    for agent in agents:
        scope = (agent.get("connector_scopes") or {}).get(app_id)
        selected = agent.get("integration_ids")
        uses = scope in ("read", "write") or (integration_default and scope != "off" and (selected is None or app_id in selected))
        if uses:
            found.append({"id": agent["id"], "name": agent.get("name") or agent["id"], "scope": scope or "write",
                          "color": agent.get("color")})
    return found


def _limited(app_id: str, agents: list[dict]) -> list[str]:
    """Bots whose tool selection narrows this app (a deny entry for one of its tools)."""
    prefix = f"mcp:{app_id}:"
    return [a["id"] for a in agents if any(s.startswith(prefix) and not s.endswith(":*")
                                           for s in ((a.get("tool_scope") or {}).get("deny") or []))]


def _mcp_state(item: dict) -> tuple[str, str]:
    status = item.get("status") or {}
    if not item.get("enabled", True):
        return "off", "Switched off."
    if item.get("auth") == "oauth" and not item.get("signed_in"):
        return ("expired" if _last_oauth_error(item) else "pending"), "Sign in to finish setup."
    if status.get("state") == "down":
        return "failed", status.get("error") or "The server did not answer."
    if status.get("state") == "working":
        return "connected", ""
    return "pending", "Not tested yet."


def _last_oauth_error(item: dict) -> bool:
    try:
        from core import mcp_oauth
        return bool(mcp_oauth.status(item["id"]).get("error"))
    except Exception:
        return False


def _catalog_match(item: dict) -> Optional[dict]:
    from core import integrations
    url = (item.get("url") or "").rstrip("/")
    if not url:
        return None
    try:
        return next((s for s in integrations.mcp_catalog() if (s.get("url") or "").rstrip("/") == url), None)
    except (OSError, ValueError):
        return None


def _mcp_apps(agents: list[dict], mcp: McpAdapter) -> list[dict]:
    from core import integrations
    apps = []
    for item in integrations.list_integrations():
        if item["kind"] != "mcp_server":
            continue
        matched = _catalog_match(item)
        state, reason = _mcp_state(item)
        accounts = _apply_aliases(item["id"], mcp.accounts(item["id"]))
        tools = (item.get("status") or {}).get("tools")
        apps.append({"id": item["id"], "kind": "mcp", "label": item["name"], "category": catalog.category_for(
            (matched or {}).get("id", ""), item["name"]), "description": (matched or {}).get("description") or "An MCP tool server.",
            "state": state, "reason": reason, "enabled": item.get("enabled", True), "auth": item.get("auth"),
            "multi_account": False, "accounts": accounts, "tools": tools, "held_tools": len(item.get("held_tools") or []),
            "used_by": _users(item["id"], True, agents), "limited_for": _limited(item["id"], agents),
            "catalog_id": (matched or {}).get("id")})
    return apps


def _native_apps(owner: str, agents: list[dict], google: GoogleAdapter, email: EmailAdapter) -> list[dict]:
    from core import integrations
    apps = []
    for spec in catalog.NATIVE_APPS:
        app = {**spec, "state": "available", "reason": "", "accounts": [], "used_by": [], "limited_for": [], "tools": None}
        try:
            if spec["id"] == "google":
                accounts = google.accounts(owner)
                app["accounts"] = _apply_aliases("google", accounts)
                if not google.configured():
                    app["state"], app["reason"] = "unavailable", "Add your Google OAuth client ID in Settings > Integrations first."
            elif spec["id"] == "email":
                app["accounts"] = _apply_aliases("email", email.accounts(owner))
        except Exception as error:  # a broken upstream shows as unavailable, never as an empty list that hides it
            app["state"], app["reason"] = "unavailable", str(error)[:200]
        if app["accounts"]:
            bad = [a for a in app["accounts"] if a["status"] != "connected"]
            app["state"] = "expired" if bad and len(bad) == len(app["accounts"]) else "connected"
        if spec["id"] in ("highlevel", "x"):
            from services import bot_keys
            slot = bot_keys.get_slot("highlevel" if spec["id"] == "highlevel" else "x")
            if slot["has_value"]:
                app["state"], app["accounts"] = "connected", [{"id": "key", "label": spec["label"], "status": "connected",
                                                               "error": None, "default": True, "alias": ""}]
        if spec["id"] == "whop":
            added = next((i for i in integrations.list_integrations() if i["kind"] == "mcp_server" and i["name"] == "whop"), None)
            if added:
                app["state"], app["accounts"] = "added", []
                app["integration_id"] = added["id"]
        app["used_by"] = _users(spec["id"], False, agents)
        apps.append(app)
    return apps


def _available_catalog(added_urls: set) -> list[dict]:
    from core import integrations
    out = []
    try:
        servers = integrations.mcp_catalog()
    except (OSError, ValueError):
        return out
    for server in servers:
        if server["id"] == "rea" or (server.get("url") or "").rstrip("/") in added_urls:
            continue
        out.append({"id": "catalog:" + server["id"], "kind": "mcp", "label": server["name"], "category": catalog.category_for(server["id"], server["name"]),
                    "description": server.get("description", ""), "state": "available", "reason": "", "auth": server.get("auth"),
                    "multi_account": False, "accounts": [], "used_by": [], "limited_for": [], "tools": None, "catalog_id": server["id"],
                    "docs": server.get("docs")})
    return out


def inventory(owner: str, *, query: str = "", category: str = "", mcp_only: bool = False, connected_only: bool = False,
              google: Optional[GoogleAdapter] = None, email: Optional[EmailAdapter] = None, mcp: Optional[McpAdapter] = None) -> dict:
    """Every app a bot could use, filtered. `connected_only` keeps apps with an account or a working setup."""
    from core import integrations
    agents = _agents()
    mcp = mcp or McpAdapter()
    apps = _mcp_apps(agents, mcp)
    added_urls = {(i.get("url") or "").rstrip("/") for i in integrations.list_integrations() if i["kind"] == "mcp_server"}
    if not mcp_only:
        apps += _native_apps(owner, agents, google or GoogleAdapter(), email or EmailAdapter())
    apps += _available_catalog(added_urls)
    needle = (query or "").strip().lower()
    if needle:
        apps = [a for a in apps if needle in " ".join((a["label"], a.get("description", ""), a["category"])).lower()]
    if category:
        apps = [a for a in apps if a["category"] == category]
    if connected_only:
        apps = [a for a in apps if a["state"] in ("connected", "expired", "failed", "pending", "off", "added")]
    rank = {"expired": 0, "failed": 1, "pending": 2, "connected": 3, "off": 4, "added": 4, "available": 5, "unavailable": 6}
    apps.sort(key=lambda a: (rank.get(a["state"], 7), a["label"].lower()))
    without = [{"id": a["id"], "name": a.get("name")} for a in agents if a.get("integration_ids") == []]
    return {"apps": apps, "categories": catalog.CATEGORIES,
            "counts": {"connected": sum(1 for a in apps if a["state"] == "connected"), "total": len(apps)},
            "bots_without_apps": without}


def _app(app_id: str, owner: str) -> Optional[dict]:
    return next((a for a in inventory(owner)["apps"] if a["id"] == app_id), None)


# -- authorize, reconnect, disconnect ------------------------------------------------------------

async def authorize(service: str, owner: str, redirect_base: str, alias: Optional[str] = None, *, account: Optional[str] = None,
                    google: Optional[GoogleAdapter] = None, mcp: Optional[McpAdapter] = None) -> dict:
    """A bounded sign-in link (https or this computer, 2,048 characters, five minutes) for one app.

    A catalogue app is added first (switched on, untested), then signed in to when it needs it."""
    mcp = mcp or McpAdapter()
    cleaned = clean_alias(alias) if alias not in (None, "") else None
    try:
        if service == "google":
            google = google or GoogleAdapter()
            if cleaned and google.accounts(owner):
                with _lock:
                    data = _aliases()
                    data["google/pending"] = {"alias": cleaned, "known": [a["id"] for a in google.accounts(owner)]}
                    _save_aliases(data)
            elif not cleaned and len(google.accounts(owner)) >= 1 and account is None:
                raise ConnectionError_("Give the new Google account an alias so a bot can tell the accounts apart.")
            return google.authorize(owner, redirect_base, cleaned, account)
        from core import integrations
        item_id = service
        if service.startswith("catalog:"):
            from services import bot_mcp_config
            item_id = bot_mcp_config.add_from_catalog(service.split(":", 1)[1])["id"]
        item = integrations.get_integration(item_id)
        if not item or item["kind"] != "mcp_server":
            raise ConnectionError_("That app cannot be signed in to from here. Use its setup card.", 404)
        if item.get("auth") != "oauth":
            return {"added": item_id, "note": "This app needs no sign-in. Test it to check the connection."}
        result = await mcp.authorize(item_id, redirect_base + "/integrations/oauth/callback")
        return {**result, "integration_id": item_id}
    except AdapterError as error:
        raise ConnectionError_(str(error), error.status) from error


def disconnect(service: str, account: str, owner: str, *, google: Optional[GoogleAdapter] = None, mcp: Optional[McpAdapter] = None) -> dict:
    """Sign one of the owner's accounts out. A mailbox is removed in the Email tab; an MCP server keeps its record."""
    try:
        if service == "google":
            (google or GoogleAdapter()).disconnect(owner, account)
        elif service == "email":
            EmailAdapter().disconnect(owner, account)
        else:
            (mcp or McpAdapter()).disconnect(service)
    except AdapterError as error:
        raise ConnectionError_(str(error), error.status) from error
    _forget_aliases(service, account)
    return {"ok": True}


# -- for the grant catalogue (U4) ----------------------------------------------------------------

def catalogue_entries(owner: str = "") -> list[dict]:
    """Connected apps with classified tools, for U4's catalogue: selectors use integration ids."""
    from core import integrations
    entries = []
    for item in integrations.list_integrations():
        if item["kind"] != "mcp_server":
            continue
        raw = (integrations.get_integration(item["id"]) or {})
        held = set(raw.get("held_tools") or {})
        claims = raw.get("tool_read_only") or {}
        tools = [{"name": name, "selector": f"mcp:{item['id']}:{name}", "effect": catalog.effect_of(name, claims.get(name)),
                  "held": name in held}
                 for name in sorted(raw.get("discovered_tools") or {})]
        state, _ = _mcp_state({**item, "signed_in": item.get("signed_in")})
        entries.append({"app_id": item["id"], "kind": "mcp", "label": item["name"], "state": state, "accounts": _apply_aliases(item["id"], McpAdapter().accounts(item["id"])),
                        "tools": tools})
    return entries


def usage_summary(app_id: str) -> list[dict]:
    return _users(app_id, True, _agents())


def forget_bot(bot_id: str) -> None:
    """Nothing here is stored per bot; kept so bot deletion can call every resource unit the same way."""
    return None
