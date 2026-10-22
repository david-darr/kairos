"""Choosing a specific model, exactly as the app's own picker offers them
(David, 2026-10-22: "choose the specific model in CLI (sonnet 5.5, sol 6.1,
etc)").

The desktop picker (static/js/views/chat.js, static/js/sessionChat.js):
- connections come from GET /api/models/choices;
- for a Claude Code, Codex or API connection, the models inside it come from
  GET /api/models/{endpoint_id}/catalog: id, display_name, description, and
  supported_efforts / default_effort when the provider advertises them;
- the choice is saved with POST /api/sessions/{id}/model
  {model_endpoint_id, model_override, effort}; model_override null means
  "the connection's own setting", and an effort is offered only for a
  model that lists it (the server validates it again).

So the CLI offers nothing the app would not. The names are cached on disk
(no tokens, no chat content) only so shell tab completion can read them
without pairing.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .connection import Connection, KairosError
from .sanitize import one_line

CATALOG_KINDS = ("claude_cli", "codex_cli", "api")


@dataclass
class Option:
    endpoint_id: str
    connection: str
    kind: str
    model_id: str | None            # None: the connection's own setting
    name: str
    description: str = ""
    efforts: list = field(default_factory=list)   # [{"effort", "description"}]
    default_effort: str | None = None

    @property
    def label(self) -> str:
        return self.name if self.model_id else f"{self.connection} (connection default)"

    @property
    def words(self) -> list[str]:
        text = f"{self.name} {self.model_id or ''} {self.connection}".casefold()
        return [w for w in re.split(r"[\s/_:()\-]+", text) if w]


async def load(conn: Connection) -> tuple[list[dict], dict[str, list[dict]]]:
    """Connections and, for each that has one, its catalog."""
    connections = await conn.get("/api/models/choices")
    catalogs: dict[str, list[dict]] = {}
    for endpoint in connections:
        if endpoint.get("kind") in CATALOG_KINDS:
            try:
                catalogs[endpoint["id"]] = await conn.get(f"/api/models/{endpoint['id']}/catalog") or []
            except KairosError:
                catalogs[endpoint["id"]] = []
    remember(options(connections, catalogs))
    return connections, catalogs


def options(connections: list[dict], catalogs: dict[str, list[dict]]) -> list[Option]:
    out: list[Option] = []
    for endpoint in connections:
        name = one_line(endpoint.get("name") or endpoint["id"], 40)
        out.append(Option(endpoint["id"], name, endpoint.get("kind") or "", None,
                          one_line(endpoint.get("model") or "default", 60)))
        for entry in catalogs.get(endpoint["id"], []):
            if not entry.get("id"):
                continue
            out.append(Option(endpoint["id"], name, endpoint.get("kind") or "", str(entry["id"]),
                              one_line(entry.get("display_name") or entry["id"], 60),
                              one_line(entry.get("description") or "", 120),
                              [e for e in entry.get("supported_efforts") or [] if isinstance(e, dict) and e.get("effort")],
                              entry.get("default_effort")))
    return out


def match(opts: list[Option], wanted: str) -> tuple[Option | None, str | None, str]:
    """(option, effort, problem). Every word must appear in the model's
    name, id or connection; a trailing word that names one of the matched
    model's efforts sets the effort. "sonnet 5.5", "sol 6.1 high",
    "opus 5.5 effort high", or an exact id."""
    text = " ".join(wanted.split()).strip()
    if not text:
        return None, None, "Name a model."
    effort = None
    words = text.casefold().replace(" effort ", " ").split()
    for option in opts:
        if option.model_id and option.model_id.casefold() == text.casefold():
            return option, None, ""
    for option in opts:
        if option.name.casefold() == text.casefold() and option.model_id:
            return option, None, ""

    def candidates(query):
        return [o for o in opts if o.model_id and all(any(w == q or w.startswith(q) for w in o.words) for q in query)]
    found = candidates(words)
    if not found and len(words) > 1:
        found = candidates(words[:-1])
        effort = words[-1]
        found = [o for o in found if any(e["effort"] == effort for e in o.efforts)]
        if not found:
            effort = None
    if not found:
        # A connection by its name or id ("Local", "Scripted"): its own setting.
        found = [o for o in opts if not o.model_id and (
            text.casefold() in (o.connection.casefold(), o.endpoint_id)
            or all(any(w == q or w.startswith(q) for w in o.connection.casefold().split()) for q in words))]
    if len(found) == 1:
        return found[0], effort, ""
    if not found:
        return None, None, f"No model matches {one_line(text, 40)}."
    exact = [o for o in found if o.name.casefold() == " ".join(w for w in words if w != effort)]
    if len(exact) == 1:
        return exact[0], effort, ""
    return None, None, "More than one model matches: " + ", ".join(f"{o.name} ({o.connection})" for o in found[:6])


async def apply(conn: Connection, session_id: str, option: Option, effort: str | None = None) -> dict:
    if effort and not any(e["effort"] == effort for e in option.efforts):
        raise KairosError(f"{option.name} does not offer the {one_line(effort, 20)} effort.")
    body = {"model_endpoint_id": option.endpoint_id, "model_override": option.model_id}
    body["effort"] = effort
    return await conn.post(f"/api/sessions/{session_id}/model", body)


def label(session: dict, connections: list[dict], catalogs: dict[str, list[dict]]) -> str:
    """The chat's model by its real name, as the app shows it."""
    endpoint = next((c for c in connections if c["id"] == session.get("model_endpoint_id")), None)
    if not endpoint:
        return "no model"
    override = session.get("model_override")
    if override:
        entry = next((e for e in catalogs.get(endpoint["id"], []) if e.get("id") == override), None)
        return one_line((entry or {}).get("display_name") or override, 40)
    return one_line(endpoint.get("model") or endpoint.get("name"), 40)


# -- shell completion -------------------------------------------------------------

def cache_file() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "Kairos" / "cli-model-names.json"


def remember(opts: list[Option]) -> None:
    """The model names for shell completion: names only, never a token,
    a URL or chat content."""
    names = sorted({o.name for o in opts if o.model_id} | {o.model_id for o in opts if o.model_id})
    try:
        path = cache_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(names), encoding="utf-8")
    except OSError:
        pass


def complete(prefix: str) -> list[str]:
    try:
        names = json.loads(cache_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    lowered = prefix.casefold()
    return [n for n in names if isinstance(n, str) and n.casefold().startswith(lowered)]


POWERSHELL = r"""# Kairos CLI: tab completion for --model (add to your PowerShell profile).
Register-ArgumentCompleter -Native -CommandName kairos, kairos.cmd -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
    if ($words.Count -ge 2 -and $words[-2] -eq '--model' -or $words[-1] -eq '--model') {
        kairos --complete-models "$wordToComplete" | ForEach-Object {
            $text = if ($_ -match '\s') { "'$_'" } else { $_ }
            [System.Management.Automation.CompletionResult]::new($text, $_, 'ParameterValue', $_)
        }
    }
}
"""

BASH = r"""# Kairos CLI: tab completion for --model (source this from ~/.bashrc).
_kairos_models() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"; prev="${COMP_WORDS[COMP_CWORD-1]}"
    if [ "$prev" = "--model" ]; then
        local IFS=$'\n'
        COMPREPLY=($(kairos --complete-models "$cur"))
    fi
}
complete -F _kairos_models kairos
"""
