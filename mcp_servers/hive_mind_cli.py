"""JARVIS's tools for Codex, from the shared registry (roadmap phase 2,
2026-10-05; spec: the vault note "Tool Registry - Phase 2 (Build Spec)").

Codex reaches JARVIS by running this script through its own shell tool, as
core/system_prompt.py's for_codex() tells it to:

    hive_mind_cli.py <tool> [--field VALUE ...] [--args_file arguments.json]

Why a command line and not an MCP server: `codex exec` requires a person to
approve every MCP tool call in its Base mode, with no setting that lifts it
short of turning its sandbox off (verified live 2026-09-11). The shell needs
no approval, and a sandboxed Codex may make a network call to this computer.

Every tool, its flags and its help come from core/tool_registry.py, the same
table Claude and local models use; a boolean flag takes true|false (alone it
means true), a list of ids is comma-separated, and anything structured can be
passed as JSON with --args_json. The call itself goes to the running JARVIS
backend, POST /api/tools/{name} (routes/tool_routes.py), with the turn's own
token (JARVIS_TOOL_TOKEN, core/tool_access.py) at JARVIS_API_BASE: the
backend decides who is asking, runs the person's hooks and permission checks,
and audits what changes. This file used to be a hand-written copy of 28
commands, reading data directly and writing through a process-wide token.

Structured fields also accept --<field>_file PATH. Prefer this for multiline
code and nested JSON on Windows; files are UTF-8 JSON, with optional BOM.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from core import tool_registry, tool_search  # noqa: E402


def _value(schema: dict, raw: str):
    kind = schema.get("type")
    if kind == "boolean":
        if raw.lower() not in ("true", "false"):
            raise ValueError(f"expected true or false, got {raw!r}")
        return raw.lower() == "true"
    if kind == "integer":
        return int(raw)
    if kind == "array" and (schema.get("items") or {}).get("type") == "string":
        return [part.strip() for part in raw.split(",") if part.strip()]
    if kind in ("array", "object"):
        return json.loads(raw)
    return raw


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="hive_mind_cli.py", description="Kairos's tools.")
    sub = root.add_subparsers(dest="tool", required=True, metavar="<tool>")
    for spec in tool_registry.specs(tool_registry.CODEX, is_admin=True, agent=True):
        command = sub.add_parser(spec.name, help=spec.description.split(". ")[0], description=spec.description)
        required = set(spec.schema.get("required") or [])
        for name, schema in (spec.schema.get("properties") or {}).items():
            if schema.get("type") in ("object", "array"):
                group = command.add_mutually_exclusive_group(required=name in required)
                group.add_argument(f"--{name}", help=schema.get("description"))
                group.add_argument(f"--{name}_file", help="Read this field from a UTF-8 JSON file (avoids shell quoting)")
            else:
                command.add_argument(f"--{name}", required=name in required, help=schema.get("description"),
                                     **({"nargs": "?", "const": "true"} if schema.get("type") == "boolean" else {}))
        group = command.add_mutually_exclusive_group()
        group.add_argument("--args_json", default=None, help="Any other arguments, as a JSON object")
        group.add_argument("--args_file", help="Read extra arguments from a UTF-8 JSON file")
    # 2026-10-15: MCP helpers post through the same per-turn backend token.
    for schema in tool_search.bridge_schemas():
        function = schema["function"]
        command = sub.add_parser(function["name"], help=function["description"], description=function["description"])
        if function["name"] == tool_search.SEARCH:
            command.add_argument("--query", required=True)
            command.add_argument("--limit", type=int, default=5)
        else:
            command.add_argument("--name", required=True)
            if function["name"] == tool_search.CALL:
                group = command.add_mutually_exclusive_group(required=True)
                group.add_argument("--args_json", help="Tool arguments as a JSON object")
                group.add_argument("--args_file", help="Tool arguments from a UTF-8 JSON file")
    return root


def arguments(spec: tool_registry.ToolSpec, parsed: argparse.Namespace) -> dict:
    args = {}
    if parsed.args_json or parsed.args_file:
        extra = json_file(parsed.args_file) if parsed.args_file else json.loads(parsed.args_json)
        if not isinstance(extra, dict):
            raise ValueError("--args_json must be a JSON object")
        args.update(extra)
    for name, schema in (spec.schema.get("properties") or {}).items():
        raw = getattr(parsed, name, None)
        filename = getattr(parsed, name + "_file", None)
        if filename is not None:
            value = json_file(filename)
            expected = dict if schema.get("type") == "object" else list
            if not isinstance(value, expected): raise ValueError(f"--{name}_file must contain a JSON {schema['type']}")
            args[name] = value
        elif raw is not None:
            args[name] = _value(schema, raw)
    return args


def json_file(filename):
    path = Path(filename)
    if path.stat().st_size > 2_000_000: raise ValueError("JSON argument file exceeds 2 MB")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def call(name: str, args: dict) -> str:
    api_base = os.environ.get("JARVIS_API_BASE")
    token = os.environ.get("JARVIS_TOOL_TOKEN")
    if not api_base or not token:
        raise RuntimeError("Kairos's tools work only when Kairos itself starts Codex "
                           "(JARVIS_API_BASE and JARVIS_TOOL_TOKEN are not set).")
    response = httpx.post(f"{api_base}/tools/{name}", json={"arguments": args},
                          headers={"X-JARVIS-Tool-Token": token}, timeout=180.0)
    response.raise_for_status()
    return response.json()["result"]


def main() -> None:
    # Windows pipes can give this child process a legacy code page even when
    # Codex's PowerShell expects UTF-8. Tool results (including REA) and error
    # messages may contain Unicode that cp1252 cannot print.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parsed = parser().parse_args()
    try:
        if parsed.tool == tool_search.SEARCH:
            args = {"query": parsed.query, "limit": parsed.limit}
        elif parsed.tool == tool_search.DESCRIBE:
            args = {"name": parsed.name}
        elif parsed.tool == tool_search.CALL:
            tool_args = json_file(parsed.args_file) if parsed.args_file else json.loads(parsed.args_json)
            if not isinstance(tool_args, dict):
                raise ValueError("--args_json must be a JSON object")
            args = {"name": parsed.name, "arguments": tool_args}
        else:
            spec = next(s for s in tool_registry.specs(tool_registry.CODEX, is_admin=True, agent=True) if s.name == parsed.tool)
            args = arguments(spec, parsed)
        print(call(parsed.tool, args))
    except (ValueError, RuntimeError, OSError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        print(f"Error: {e.response.status_code} {e.response.text[:300]}", file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPError as e:
        print(f"Error: couldn't reach Kairos - {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
