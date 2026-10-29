"""The MCP server editor's contract (Phase 2, unit U5): validate, save, test, import.

Parsing a pasted link, setup command or config block is done in the browser (static/js/botsMcpPaste.js)
and arrives here as plain fields. Nothing in this module ever runs a command: a stdio server's
command and arguments are stored as data, and only a person pressing Test (or a bot turn using an
enabled server) starts it, through the clean launcher, on the probe limits (8 s local, 30 s remote).

Records are the existing integrations (core/integrations.py). Secrets are write-only slots: a header
or variable is stored encrypted and only its name comes back. Saving with a name and the marker
`true` keeps the saved value; leaving a name out removes it. A bot may propose a server, but it is
only ever saved OFF with empty secrets (`propose`).
"""
import re
from typing import Optional

from core import integrations, mcp_oauth

NAME = re.compile(r"[a-z][a-z0-9_-]{0,31}")
HEADER_NAME = re.compile(r"[A-Za-z0-9-]{1,64}")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
FORBIDDEN_HEADERS = {"host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "proxy-authorization"}
FORBIDDEN_ENV = re.compile(r"(?i)^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|PYTHON.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|"
                           r"BASH_ENV|ENV|IFS|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|MCP_API_KEY|KAIROS_.*|JARVIS_.*|OP_SERVICE_ACCOUNT_TOKEN)$")
SECRET_QUERY = re.compile(r"(?i)(key|token|secret|auth|pass|sig|credential)")
MAX_HEADERS, MAX_ENV, MAX_ARGS = 20, 40, 64
FIELDS = {"name", "transport", "url", "command", "args", "headers", "env", "oauth", "call_timeout_minutes", "result_budget", "enabled"}


class McpConfigError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _text(value, label: str, limit: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not value.strip() and not allow_empty):
        raise McpConfigError(f"{label} is required.")
    if len(value) > limit or any(c in value for c in "\0\r\n"):
        raise McpConfigError(f"{label} is up to {limit} characters on one line.")
    return value.strip()


def _slots(value, label: str, name_re, limit: int, forbidden=None) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > limit:
        raise McpConfigError(f"{label} are a list of up to {limit} names.")
    out = {}
    for name, secret in value.items():
        if not isinstance(name, str) or not name_re.fullmatch(name):
            raise McpConfigError(f"{label[:-1] if label.endswith('s') else label} name {name!r} is not valid.")
        if forbidden and forbidden(name):
            raise McpConfigError(f"{name} cannot be set for an MCP server.")
        if secret is not True:
            if not isinstance(secret, str) or not secret or len(secret) > 4096 or any(c in secret for c in "\0\r\n"):
                raise McpConfigError(f"{name} needs a value of up to 4,096 characters on one line, or the keep marker.")
        out[name] = secret
    return out


def clean(body: dict, previous: Optional[dict] = None) -> dict:
    """Validate an editor body into the fields core/integrations.save_mcp_config stores."""
    unknown = set(body) - FIELDS
    if unknown:
        raise McpConfigError(f"Unknown fields: {', '.join(sorted(unknown))}.")
    name = body.get("name") if body.get("name") is not None else (previous or {}).get("name")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise McpConfigError("A name starts with a lowercase letter and uses lowercase letters, digits, - or _ (32 characters at most).")
    if previous and name != previous["name"]:
        raise McpConfigError("A server's name cannot change once it is added.")
    transport = body.get("transport")
    if not transport and previous:
        transport = "stdio" if previous.get("mcp_type") == "stdio" else previous.get("http_kind") or "http"
    if previous:  # a field left out of an edit keeps what is saved; send the field (even empty) to change it
        body = {**body}
        for key, saved in (("headers", previous.get("headers_encrypted")), ("env", previous.get("env_encrypted"))):
            if key not in body and saved:
                body[key] = {n: True for n in saved}
        if transport == "stdio":
            body.setdefault("command", previous.get("command"))
            body.setdefault("args", previous.get("args") or [])
        else:
            body.setdefault("url", previous.get("url"))
            if "oauth" not in body and previous.get("oauth_client"):
                body["oauth"] = {"client_id": previous["oauth_client"]["client_id"], "scopes": previous["oauth_client"].get("scopes", "")}
    if transport not in ("http", "sse", "stdio"):
        raise McpConfigError("Choose a remote link (http or sse) or a local command.")
    fields: dict = {"name": name, "mcp_type": "stdio" if transport == "stdio" else "http"}
    if transport == "stdio":
        fields["command"] = _text(body.get("command"), "The command", 500)
        args = body.get("args") or []
        if not isinstance(args, list) or len(args) > MAX_ARGS:
            raise McpConfigError(f"Arguments are a list of up to {MAX_ARGS} items.")
        fields["args"] = [_text(a, "An argument", 2000, allow_empty=True) if isinstance(a, str) else _text(str(a), "An argument", 2000) for a in args]
        if body.get("url"):
            raise McpConfigError("A local command has no address.")
        fields["env"] = _slots(body.get("env"), "Variables", ENV_NAME, MAX_ENV, lambda n: bool(FORBIDDEN_ENV.match(n)))
        if body.get("headers"):
            raise McpConfigError("A local command has no headers.")
    else:
        url = _text(body.get("url"), "The address", 2048)
        try:
            mcp_oauth.secure_url(url, "The address")
        except ValueError as error:
            raise McpConfigError(str(error)) from error
        if "@" in url.split("//", 1)[-1].split("/", 1)[0]:
            raise McpConfigError("Leave sign-in details out of the address; use a header instead.")
        from urllib.parse import parse_qsl, urlsplit
        if any(SECRET_QUERY.search(name) for name, _ in parse_qsl(urlsplit(url).query, keep_blank_values=True)):
            raise McpConfigError("Keys do not belong in the address. Put the key in a header instead.")
        fields["url"], fields["http_kind"] = url, "sse" if transport == "sse" else "http"
        fields["headers"] = _slots(body.get("headers"), "Headers", HEADER_NAME, MAX_HEADERS, lambda n: n.lower() in FORBIDDEN_HEADERS)
        if body.get("command") or body.get("args"):
            raise McpConfigError("A remote link has no command.")
        if body.get("env"):
            raise McpConfigError("A remote link has no variables.")
        oauth = body.get("oauth")
        if oauth:
            if not isinstance(oauth, dict) or set(oauth) - {"client_id", "client_secret", "scopes"}:
                raise McpConfigError("The sign-in block is a client id, an optional secret and optional scopes.")
            client = {"client_id": _text(oauth.get("client_id"), "The client id", 300), "scopes": _text(oauth.get("scopes") or "", "Scopes", 500, allow_empty=True)}
            secret = oauth.get("client_secret", "keep" if previous else None)
            if secret not in (None, "keep", True) and (not isinstance(secret, str) or len(secret) > 1000 or "\n" in secret):
                raise McpConfigError("The client secret is up to 1,000 characters.")
            if secret not in (None, ""):
                client["client_secret"] = "keep" if secret is True else secret
            fields["oauth_client"], fields["auth"] = client, "oauth"
    if body.get("call_timeout_minutes") is not None:
        minutes = body["call_timeout_minutes"]
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= 60:
            raise McpConfigError("The call timeout is a whole number of minutes from 1 to 60.")
        fields["call_timeout_minutes"] = minutes
    if body.get("result_budget") is not None:
        from core import bot_tool_results
        try:
            fields["result_budget"] = bot_tool_results.clean_budget(body["result_budget"])
        except ValueError as error:
            raise McpConfigError(str(error)) from error
    if body.get("enabled") is not None:
        if not isinstance(body["enabled"], bool):
            raise McpConfigError("Enabled is true or false.")
        fields["enabled"] = body["enabled"]
    return fields


def save(body: dict, replace_id: Optional[str] = None) -> dict:
    """Create (or edit, with `replace_id`) a server. Returns the masked record."""
    previous = integrations.get_integration(replace_id) if replace_id else None
    if replace_id and (not previous or previous["kind"] != "mcp_server"):
        raise McpConfigError("That MCP server was not found.", 404)
    fields = clean(body, previous)
    try:
        return integrations.save_mcp_config(fields, replace_id)
    except KeyError as error:
        raise McpConfigError("That MCP server was not found.", 404) from error
    except ValueError as error:
        raise McpConfigError(str(error), 409 if "already uses" in str(error) or "up to" in str(error) else 400) from error


def propose(body: dict) -> dict:
    """A bot's proposed server: saved OFF, with no secrets, whatever it asked for."""
    stripped = {k: v for k, v in body.items() if k in FIELDS - {"headers", "env", "oauth", "enabled"}}
    fields = clean(stripped)
    fields["enabled"], fields["origin"] = False, "proposed"
    return integrations.save_mcp_config(fields)


def add_from_catalog(catalog_id: str) -> dict:
    """One step: a catalogue server added as an ordinary MCP record (sign-in comes after, for OAuth ones)."""
    server = next((s for s in integrations.mcp_catalog() if s["id"] == catalog_id and s.get("url")), None)
    if server is None:
        raise McpConfigError("That app is not in the catalogue.", 404)
    existing = next((i for i in integrations.list_integrations() if i["kind"] == "mcp_server" and i.get("url", "").rstrip("/") == server["url"].rstrip("/")), None)
    if existing:
        return existing
    name = re.sub(r"[^a-z0-9_-]", "-", server["id"].lower())[:32]
    try:
        return integrations.save_mcp_config({"name": name, "mcp_type": "http", "url": server["url"], "http_kind": "http",
                                             "auth": "oauth" if server.get("auth") == "oauth" else None, "origin": "catalog"})
    except ValueError as error:
        raise McpConfigError(str(error), 409) from error


def set_enabled(item_id: str, enabled: bool) -> dict:
    try:
        return integrations.set_enabled(item_id, enabled)
    except KeyError as error:
        raise McpConfigError("That MCP server was not found.", 404) from error


def remove(item_id: str) -> None:
    if integrations.get_integration(item_id) is None:
        raise McpConfigError("That MCP server was not found.", 404)
    integrations.delete_integration(item_id)


async def test(item_id: str) -> dict:
    """Probe a saved server (8 s local, 30 s remote, up to 100 tools) and record the result as its health."""
    from core import mcp_client
    item = integrations.get_integration(item_id)
    if item is None or item.get("kind") != "mcp_server":
        raise McpConfigError("That MCP server was not found.", 404)
    await mcp_oauth.refresh_due([item_id])
    config = integrations.list_mcp_servers_runtime([item_id]).get(item["name"]) if item.get("enabled", True) else None
    if config is None:
        reason = "off" if not item.get("enabled", True) else "auth"
        masked = integrations.record_check(item_id, signed_out=True) if reason == "auth" else integrations.get_integration_masked(item_id)
        return {"state": "auth_required" if reason == "auth" else "failed", "reason": reason, "tools": 0, "tool_names": [], "server": masked}
    found = await mcp_client.probe(config, keep_tools=True)
    tools = found.pop("_tools", None)
    if found["state"] == "connected":
        masked = integrations.record_check(item_id, tools=tools)
    elif found["state"] == "auth_required":
        masked = integrations.record_check(item_id, signed_out=True)
    else:
        masked = integrations.record_check(item_id, error=f"The test failed ({found['reason']}).")
    return {**found, "server": masked}


# -- config files from other tools (setup import) --------------------------------------------------

def from_blob(name: str, blob: dict) -> dict:
    """One server from another tool's config (Claude Code, Cursor, Claude Desktop, Codex), as a draft with its secret
    values removed: `gaps` lists the header and variable names that need a value. Never run, never saved here."""
    if not isinstance(blob, dict):
        raise McpConfigError("That server entry is not usable.")
    slug = re.sub(r"[^a-z0-9_-]", "-", str(name).lower()).strip("-_")[:32]
    if not slug or not slug[0].isalpha():
        slug = ("mcp-" + slug)[:32]
    draft: dict = {"name": slug}
    kind = str(blob.get("type") or blob.get("transport") or "").lower()
    if blob.get("url") or blob.get("serverUrl"):
        draft["transport"] = "sse" if kind == "sse" else "http"
        draft["url"] = str(blob.get("url") or blob.get("serverUrl"))
        headers = blob.get("headers") or blob.get("http_headers") or {}
        gaps = {"headers": sorted(str(k) for k in headers)} if isinstance(headers, dict) else {"headers": []}
    elif blob.get("command"):
        draft["transport"] = "stdio"
        command, args = blob["command"], blob.get("args") or []
        if isinstance(command, list):
            command, args = command[0], list(command[1:]) + list(args)
        draft["command"], draft["args"] = str(command), [str(a) for a in args]
        env = blob.get("env") or {}
        gaps = {"env": sorted(str(k) for k in env)} if isinstance(env, dict) else {"env": []}
    else:
        raise McpConfigError("That server entry has neither an address nor a command.")
    return {"draft": draft, "gaps": gaps}
