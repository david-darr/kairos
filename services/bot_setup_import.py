"""Setup import: bring in MCP servers and skills other AI tools left on this computer (Phase 2, unit U5).

A preview reads a few well-known files under the person's home folder and lists what is there. It
copies nothing and runs nothing. Applying imports only what the person selected, and everything lands
inert: MCP servers are saved switched OFF with no secret values (their header, variable and key
names are listed as "needs a value"), skills come in switched off for review (bot_skill_import).

Bounds: 1 MiB per config file, 100 servers in all, two seconds for the scan, no links or junctions,
nothing outside the home folder, and credential files are never opened. Secret values are dropped
the moment an entry is read, so they never reach a preview, a log or a note.
"""
import json
import os
import re
import time
import tomllib
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from core import cli_env, integrations
from services import bot_mcp_config
from services.bot_mcp_config import McpConfigError

MAX_FILE = 1024 * 1024
MAX_SERVERS = 100
MAX_SELECT = 20
SECRET_QUERY = re.compile(r"(?i)(key|token|secret|auth|pass|sig|credential)")
SECRET_ARG = re.compile(r"(?i)^(--?[\w-]*(?:key|token|secret|pass|auth)[\w-]*)=(.+)$")


def _linked(path: Path) -> bool:
    try:
        return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except OSError:
        return True


def _inside(path: Path, home: Path) -> bool:
    try:
        return path.resolve().is_relative_to(home)
    except OSError:
        return False


def _locations(home: Path) -> list[tuple[str, Path, str]]:
    own = cli_env.import_root()
    if own and home == Path(own).resolve():
        # An account with its own Claude and Codex sign-in imports only from those folders.
        return [("Claude Code", Path(cli_env.claude_json()), "json"), ("Codex", Path(cli_env.codex_dir()) / "config.toml", "toml")]
    appdata = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex")
    return [("Claude Code", home / ".claude.json", "json"), ("Claude Code", home / ".mcp.json", "json"),
            ("Claude Desktop", appdata / "Claude" / "claude_desktop_config.json", "json"),
            ("Claude Desktop", home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json", "json"),
            ("Claude Desktop", home / ".config" / "Claude" / "claude_desktop_config.json", "json"),
            ("Cursor", home / ".cursor" / "mcp.json", "json"), ("Codex", codex / "config.toml", "toml")]


def _servers_in(path: Path, kind: str) -> dict:
    """The `mcpServers` map of one config file (also those under a Claude Code project), or {}."""
    try:
        raw = path.read_bytes() if path.stat().st_size <= MAX_FILE else b""
        data = json.loads(raw.decode("utf-8-sig")) if kind == "json" and raw else tomllib.loads(raw.decode("utf-8")) if raw else {}
    except (OSError, ValueError, UnicodeError, tomllib.TOMLDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    found = {}
    top = data.get("mcpServers") if kind == "json" else data.get("mcp_servers")
    if isinstance(top, dict):
        found.update({k: v for k, v in top.items() if isinstance(v, dict)})
    for project in (data.get("projects") or {}).values() if kind == "json" and isinstance(data.get("projects"), dict) else []:
        for name, blob in ((project or {}).get("mcpServers") or {}).items() if isinstance(project, dict) else []:
            if isinstance(blob, dict):
                found.setdefault(name, blob)
    return found


def _scrub_url(url: str) -> tuple[str, list]:
    """The address without sign-in details or key-like query values, and what was removed."""
    parts = urlsplit(url)
    removed = []
    host = parts.hostname or ""
    if parts.port:
        host += f":{parts.port}"
    if parts.username or parts.password:
        removed.append("sign-in details in the address")
    kept = []
    for name, value in parse_qsl(parts.query, keep_blank_values=True):
        if SECRET_QUERY.search(name):
            removed.append(f"address value {name}")
        else:
            kept.append((name, value))
    return urlunsplit((parts.scheme, host, parts.path, urlencode(kept), "")), removed


def _entry(tool: str, name: str, blob: dict) -> dict:
    row = {"tool": tool, "name": name, "status": "ready", "reason": "", "gaps": [], "warnings": [], "summary": ""}
    try:
        built = bot_mcp_config.from_blob(name, blob)
    except McpConfigError as error:
        return {**row, "status": "refused", "reason": str(error)}
    draft, gaps = built["draft"], built["gaps"]
    row["name"] = draft["name"]
    row["gaps"] = [g for names in gaps.values() for g in names]
    if draft["transport"] == "stdio":
        clean_args, secret_args = [], []
        for arg in draft.get("args", []):
            hit = SECRET_ARG.match(arg)
            if hit:
                clean_args.append(hit.group(1) + "=")
                secret_args.append(hit.group(1))
            else:
                clean_args.append(arg)
        draft["args"] = clean_args
        row["gaps"] += secret_args
        row["summary"] = Path(draft["command"].replace("\\", "/")).name
    else:
        draft["url"], removed = _scrub_url(draft["url"])
        row["gaps"] += removed
        row["summary"] = urlsplit(draft["url"]).hostname or ""
    row["warnings"] = ["Needs a value before it can work: " + ", ".join(row["gaps"]) + "."] if row["gaps"] else []
    try:
        bot_mcp_config.clean({k: v for k, v in draft.items() if k != "headers"})
    except McpConfigError as error:
        return {**row, "status": "refused", "reason": str(error)}
    if any(i["kind"] == "mcp_server" and i["name"] == draft["name"] for i in integrations.list_integrations()):
        return {**row, "status": "exists", "reason": "A server with this name is already added."}
    row["_draft"] = draft
    return row


def scan(home=None, *, seconds: float = 2.0, clock=time.monotonic, include_skills: bool = True) -> dict:
    """Preview what other tools left behind. Reads only."""
    home = Path(home or cli_env.import_root() or Path.home()).resolve()
    deadline, limited, seen, mcp = clock() + seconds, False, set(), []
    for tool, path, kind in _locations(home):
        if clock() > deadline or len(mcp) >= MAX_SERVERS:
            limited = True
            break
        if not path.is_file() or _linked(path) or not _inside(path, home):
            continue
        for name, blob in _servers_in(path, kind).items():
            row = _entry(tool, str(name), blob)
            key = (tool, row["name"])
            if key in seen:
                continue
            seen.add(key)
            row.pop("_draft", None)
            mcp.append(row)
            if len(mcp) >= MAX_SERVERS:
                limited = True
                break
    result = {"mcp": mcp, "limited": limited, "skills": [], "skills_available": False, "skills_limited": False, "skills_note": ""}
    if include_skills:
        try:
            from services import bot_skill_import  # another unit's module: this branch works without it
        except ImportError:
            result["skills_note"] = "Skill import is not available in this build."
        else:
            found = bot_skill_import.scan_setup_skills(home)
            result.update(skills=found.get("skills", []), skills_available=True, skills_limited=bool(found.get("limited")))
    return result


def apply(selections: dict, *, home=None, bot_id=None) -> dict:
    """Import the chosen entries, inert. `selections` is {"mcp": [{"tool", "name"}], "skills": [{"tool", "folder"}]}.
    Re-scans first, so only what is still there and still clean is imported."""
    if not isinstance(selections, dict) or set(selections) - {"mcp", "skills"}:
        raise McpConfigError("Choose what to import.")
    wanted_mcp = {(s.get("tool"), s.get("name")) for s in selections.get("mcp") or [] if isinstance(s, dict)}
    wanted_skills = [s for s in selections.get("skills") or [] if isinstance(s, dict)]
    if not wanted_mcp and not wanted_skills:
        raise McpConfigError("Choose at least one thing to import.")
    if len(wanted_mcp) > MAX_SELECT:
        raise McpConfigError(f"Import up to {MAX_SELECT} servers at a time.", 413)
    home_path = Path(home or cli_env.import_root() or Path.home()).resolve()
    results = {"mcp": [], "skills": []}
    if wanted_mcp:
        built = {}
        for tool, path, kind in _locations(home_path):
            if path.is_file() and not _linked(path) and _inside(path, home_path):
                for name, blob in _servers_in(path, kind).items():
                    row = _entry(tool, str(name), blob)
                    built.setdefault((tool, row["name"]), row)
        for tool, name in sorted(wanted_mcp, key=str):
            row = built.get((tool, name))
            if row is None:
                results["mcp"].append({"tool": tool, "name": name, "status": "missing", "reason": "It is no longer in that file."})
            elif row["status"] != "ready":
                results["mcp"].append({"tool": tool, "name": name, "status": row["status"], "reason": row["reason"]})
            else:
                draft = {**row["_draft"], "enabled": False}  # imported servers are always saved off, with no secrets
                try:
                    fields = bot_mcp_config.clean(draft)
                    fields["origin"] = f"setup:{tool}"
                    saved = integrations.save_mcp_config(fields)
                    results["mcp"].append({"tool": tool, "name": name, "status": "imported", "id": saved["id"], "gaps": row["gaps"]})
                except (McpConfigError, ValueError) as error:
                    results["mcp"].append({"tool": tool, "name": name, "status": "refused", "reason": str(error)})
    if wanted_skills:
        try:
            from services import bot_skill_import
        except ImportError as error:
            raise McpConfigError("Skill import is not available in this build.", 501) from error
        results["skills"] = bot_skill_import.apply_setup_skills(bot_id, wanted_skills, home=home_path).get("results", [])
    return results
