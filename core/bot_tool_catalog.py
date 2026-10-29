"""The one catalogue of what a bot could reach (Bots redesign, Phase 2 unit U4, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 4.5 and 7 (U4).

Advertisement filtering (what a model is shown) and call-time authorization (what it may do)
read this same catalogue, so they cannot disagree. It knows three kinds of tool:

  native   Kairos's own registry tools, plus the file, shell and web tools Claude brings
           (selectors `native:<name|*>`; Bash, PowerShell and run_shell are one family)
  mcp      a connected MCP server's pinned tools (selectors `mcp:<integration id>:<name|*>`)
  app      the connected-app view of both: an app is an MCP integration id, or `google` and
           `email` for Kairos's own Google and email tools

It also says what each tool does to the world (read, write or unknown) because a read-only
app scope permits only classified reads. A server's own hint wins, then the connections unit's
metadata, then the verb in the tool's name; a tool whose effect cannot be told is unknown and
is refused under a read scope.

Nothing here decides anything about a particular bot: services/bot_grants.py does that.
"""
import hashlib
import json
import re
from typing import Optional

READ, WRITE, UNKNOWN = "read", "write", "unknown"

HIVE_PREFIX = "mcp__hive_mind__"
PROXY_SERVER = "kairos_apps"
PROXY_PREFIX = f"mcp__{PROXY_SERVER}__"
MAX_PROXY_NAME = 64 - len(PROXY_PREFIX)

# Bash, PowerShell and run_shell are one capability on three providers: a person who turns the
# shell off means all of it, and a bot cannot get it back by changing model.
SHELL = frozenset({"Bash", "PowerShell", "run_shell"})
FILE_TOOLS = frozenset({"Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"})
WEB_TOOLS = frozenset({"WebFetch", "WebSearch"})
GROUPS = (SHELL,)
# Tools every conversation needs; a narrowed native list never switches these off.
BASELINE = frozenset({"AskUserQuestion", "ask_user", "TodoWrite"})
CLAUDE_EXTRA = {"MultiEdit": "Edit several parts of a file.", "LS": "List a folder.",
                "AskUserQuestion": "Ask the person a question."}
# What each provider brings on its own, outside Kairos's registry. An adapter can enforce a
# restriction on these only if it sees every call (Claude's hooks do; Codex's own shell does not).
PROVIDER_NATIVE = {
    "claude": frozenset(SHELL - {"run_shell"}) | FILE_TOOLS | WEB_TOOLS | {"Task", "TodoWrite", "NotebookEdit"},
    "openai": frozenset(),
    "codex": frozenset({"Bash"}) | FILE_TOOLS | WEB_TOOLS,
    "antigravity": frozenset({"Bash"}) | FILE_TOOLS | WEB_TOOLS,
}
PROVIDER_LABEL = {"claude": "Claude", "openai": "This model", "codex": "Codex", "antigravity": "Antigravity"}
READ_NATIVE = frozenset({"Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"})

# Kairos's own app tools, grouped as the apps a person connects. `read_actions` are the actions of a
# multi-action tool that only look.
NATIVE_APPS = {"google_drive": "google", "google_sheets": "google", "google_forms": "google",
               "google_calendar": "google", "send_email": "email", "list_email_accounts": "email"}
APP_LABELS = {"google": "Google", "email": "Email"}
from services import bot_highlevel, bot_x_research
NATIVE_APPS.update({name: "highlevel" for name in bot_highlevel.TOOLS})
NATIVE_APPS.update({name: "x" for name in bot_x_research.TOOLS})
APP_LABELS.update({"highlevel": "HighLevel", "x": "X research"})
READ_ACTIONS = {"google_drive": {"list", "info", "permissions", "revisions"},
                "google_sheets": {"get", "values"}, "google_forms": {"get", "responses"},
                "google_calendar": {"list_calendars", "list_events"}}

_WORDS = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")
READ_VERBS = frozenset("""get list search read find fetch describe query view lookup count show check inspect browse
preview retrieve peek stat head""".split())
WRITE_VERBS = frozenset("""create add update delete remove send post write set edit merge close run execute exec push
upload move rename trigger cancel approve publish deploy drop reset put patch modify change grant revoke invite assign
submit reply forward archive restore save insert append clear start stop kill install uninstall enable disable schedule
book pay transfer commit fork star unstar follow label tag mark sync import apply call dispatch share unshare lock unlock
attach detach copy clone replace convert generate make build new open edit rotate reopen resolve login logout sign
unsubscribe subscribe delegate escalate comment react vote""".split())


def canonical(name: str) -> str:
    """The native name behind a provider's name for it (Claude prefixes Kairos's tools)."""
    return name[len(HIVE_PREFIX):] if isinstance(name, str) and name.startswith(HIVE_PREFIX) else name


def family(name: str) -> frozenset:
    return next((group for group in GROUPS if name in group), frozenset({name}))


def selector_matches(selector: str, kind: str, server_id: Optional[str], name: str) -> bool:
    """Does one stored selector cover this tool? Native selectors cover a tool's whole family."""
    if kind == "native":
        if not selector.startswith("native:"):
            return False
        wanted = selector[len("native:"):]
        return wanted == "*" or name in family(wanted)
    match = re.fullmatch(r"mcp:([^:\s]+):(\S+)", selector)
    if not match or server_id is None:
        return False
    return match.group(1) == server_id and match.group(2) in ("*", name)


def tokens(name: str) -> list[str]:
    return [t.lower() for t in _WORDS.findall(str(name))]


def classify_name(name: str) -> str:
    """Read when the name opens with a looking verb and holds no changing verb; write when it
    holds a changing verb; otherwise unknown."""
    words = tokens(name)
    if any(word in WRITE_VERBS for word in words):
        return WRITE
    if words and words[0] in READ_VERBS:
        return READ
    return UNKNOWN


# -- native tools ----------------------------------------------------------------------------

def native_entries() -> dict[str, dict]:
    """Every native tool Kairos knows, by name: the registry plus Claude's own."""
    from core import tool_registry as registry
    entries: dict[str, dict] = {}
    for spec in registry._REGISTRY.values():
        entries[spec.name] = {"name": spec.name, "description": spec.description.split(". ")[0][:200],
                              "effect": READ if spec.effect == registry.READ else WRITE,
                              "admin_only": spec.admin_only, "app": NATIVE_APPS.get(spec.name), "source": "kairos"}
    for name, description in {**registry.CLAUDE_NATIVE_TOOLS, **CLAUDE_EXTRA}.items():
        entries.setdefault(name, {"name": name, "description": description,
                                  "effect": READ if name in READ_NATIVE else WRITE,
                                  "admin_only": name in SHELL, "app": None, "source": "claude"})
    return entries


def native_effect(name: str, args: Optional[dict] = None) -> str:
    """Read or write for one native call. A multi-action app tool is a read only for a looking action."""
    name = canonical(name)
    if name in READ_ACTIONS:
        action = (args or {}).get("action") if isinstance(args, dict) else None
        return READ if isinstance(action, str) and action in READ_ACTIONS[name] else WRITE
    entry = native_entries().get(name)
    return entry["effect"] if entry else UNKNOWN


def globally_disabled(name: str) -> bool:
    """Settings > Admin > Agent Tools: switched off for everyone."""
    from core import settings
    disabled = set(settings.get_setting("disabled_tools") or [])
    return name in disabled or HIVE_PREFIX + name in disabled


# -- MCP servers and their tools ---------------------------------------------------------------

def _integrations() -> list[dict]:
    from core import integrations
    return [item for item in integrations._load().values() if item.get("kind") == "mcp_server"]


def servers() -> list[dict]:
    """Each MCP integration as the catalogue sees it, without any secret."""
    from core.rea_integration import is_rea
    rows = []
    for item in _integrations():
        state = (item.get("status") or {}).get("state")
        rows.append({"id": item["id"], "name": item["name"], "enabled": item.get("enabled", True),
                     "rea": is_rea(item), "auth": item.get("auth") or ("key" if item.get("api_key_encrypted") else "none"),
                     "signed_in": bool((item.get("oauth") or {}).get("tokens")), "state": state,
                     "owner": item.get("owner"), "admin_only": bool(item.get("admin_only"))})
    return rows


def server(server_id: str) -> Optional[dict]:
    return next((row for row in servers() if row["id"] == server_id), None)


def servers_named(name: str) -> list[dict]:
    return [row for row in servers() if row["name"] == name]


def server_unavailable(row: dict, owner: Optional[str], is_admin: bool) -> Optional[str]:
    """Why a server cannot be used at all, or None. Plain words, shown to the person."""
    if not row["enabled"]:
        return "It is switched off in Settings."
    if row["auth"] == "oauth" and not row["signed_in"]:
        return "It needs signing in again."
    if row["state"] == "down":
        return "It did not answer its last check."
    if row["admin_only"] and not is_admin:
        return "It is for admins only."
    if row["owner"] and owner is not None and row["owner"] != owner and not is_admin:
        return "It belongs to someone else."
    return None


def declared_effect(server_id: str, tool_name: str) -> Optional[str]:
    """What the connections unit or the server itself says a tool does, or None."""
    try:
        from services import bot_connection_catalog
        hook = getattr(bot_connection_catalog, "tool_effect", None)
        if callable(hook):
            effect = hook(server_id, tool_name)
            if effect in (READ, WRITE):
                return effect
    except Exception:
        pass
    from core import integrations
    item = integrations.get_integration(server_id) or {}
    claims = item.get("tool_read_only") or {}
    if tool_name in claims and type(claims[tool_name]) is bool:
        return READ if claims[tool_name] else WRITE
    hints = ((item.get("discovered_tools") or {}).get(tool_name) or {}).get("annotations") or {}
    if hints.get("readOnlyHint") is True:
        return READ
    if hints.get("readOnlyHint") is False or hints.get("destructiveHint") is True:
        return WRITE
    return None


def mcp_effect(server_id: str, tool_name: str) -> tuple[str, str]:
    """(effect, where it came from): declared, name or unknown."""
    declared = declared_effect(server_id, tool_name)
    if declared:
        return declared, "declared"
    from services import bot_connection_catalog
    guessed = bot_connection_catalog.effect_of(tool_name)
    return guessed, "name" if guessed != UNKNOWN else "unknown"


def server_tools(server_id: str) -> list[dict]:
    """A server's pinned tools: the discovered ones that are not held for review."""
    from core import integrations
    item = integrations.get_integration(server_id) or {}
    held = set(item.get("held_tools") or {})
    pinned = item.get("pinned_tools") or {}
    rows = []
    for name, tool in sorted((item.get("discovered_tools") or {}).items()):
        if name in held or pinned.get(name) != tool.get("fingerprint"):
            continue
        effect, source = mcp_effect(server_id, name)
        rows.append({"name": name, "description": (tool.get("description") or "")[:200],
                     "effect": effect, "effect_source": source})
    return rows


def held_names(server_id: str) -> list[str]:
    from core import integrations
    return sorted((integrations.get_integration(server_id) or {}).get("held_tools") or {})


def accounts(app_id: str, owner: Optional[str]) -> list[dict]:
    """The accounts an app has, from the connections unit when it is merged. Never raises."""
    try:
        from services.bot_app_adapters import GoogleAdapter, EmailAdapter, McpAdapter
        rows = (GoogleAdapter().accounts(owner) if app_id == "google" else
                EmailAdapter().accounts(owner) if app_id == "email" else McpAdapter().accounts(app_id))
        return [{"id": str(a["id"]), "label": str(a.get("label") or a["id"])} for a in rows]
    except Exception:
        pass
    return []


def proxy_name(server: str, tool: str, taken: set) -> str:
    """A short name for the Claude proxy: `mcp__kairos_apps__<this>`, within Claude's 64 characters."""
    base = re.sub(r"[^a-zA-Z0-9_-]", "_", f"{server}__{tool}")[:MAX_PROXY_NAME]
    name, n = base, 2
    while name in taken:
        suffix = f"_{n}"
        name, n = base[:MAX_PROXY_NAME - len(suffix)] + suffix, n + 1
    return name


# -- the whole catalogue ---------------------------------------------------------------------------

def catalogue(owner: Optional[str], is_admin: bool, agent_surface: bool = True) -> dict:
    """Everything that exists, with whether it can be used at all, before any bot's choices.

    {"native": {name: entry + available + reason}, "servers": [row + tools], "apps": [...],
     "revision": a short digest that changes whenever availability does}."""
    from core import addons
    from services import bot_connections
    connections = {entry["app_id"]: entry for entry in bot_connections.catalogue_entries(owner or "")}
    native = {}
    for name, entry in native_entries().items():
        reason = None
        if not addons.tool_available(name):
            reason = "Its add-on is not installed or not switched on in Tool Store."
        elif globally_disabled(name):
            reason = "It is switched off for everyone in Settings."
        elif entry["admin_only"] and not is_admin:
            reason = "It is for admins only."
        native[name] = {**entry, "available": reason is None, "reason": reason}
    rows = []
    for row in servers():
        reason = server_unavailable(row, owner, is_admin)
        rows.append({**row, "available": reason is None, "reason": reason, "tools": server_tools(row["id"]),
                     "held": held_names(row["id"])})
    apps = []
    for app_id, label in APP_LABELS.items():
        tools = sorted(n for n, a in NATIVE_APPS.items() if a == app_id)
        usable = [t for t in tools if native.get(t, {}).get("available")]
        apps.append({"id": app_id, "name": label, "kind": "native", "available": bool(usable),
                     "reason": None if usable else "None of its tools can be used here.",
                     "tools": [{"name": t, "description": native[t]["description"], "effect": native[t]["effect"],
                                "effect_source": "declared", "available": native[t]["available"],
                                "reason": native[t]["reason"]} for t in tools if t in native],
                     "accounts": accounts(app_id, owner)})
    for row in rows:
        apps.append({"id": row["id"], "name": row["name"], "kind": "mcp", "available": row["available"],
                     "reason": row["reason"], "rea": row["rea"],
                     "tools": [{**tool, "available": row["available"], "reason": row["reason"]} for tool in row["tools"]],
                     "accounts": connections.get(row["id"], {}).get("accounts", accounts(row["id"], owner))})
    blob = json.dumps([{n: [e["available"], e["effect"]] for n, e in sorted(native.items())},
                       [[r["id"], r["available"], [[t["name"], t["effect"]] for t in r["tools"]], r["held"]] for r in rows]],
                      sort_keys=True)
    return {"native": native, "servers": rows, "apps": apps,
            "revision": hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]}
