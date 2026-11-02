"""Read-only, deterministic folder scout. No shell, model or network calls."""
from __future__ import annotations

import json
import os
from pathlib import Path

from core.workspace import vet_workspace
from services import bot_package

MAX_BYTES = 256 * 1024


def scout(path: str, *, owner_user=None):
    raw = Path(path)
    if not raw.is_absolute() or ".." in raw.parts or any(p.is_symlink() or p.is_junction() for p in [raw, *raw.parents]):
        raise ValueError("Choose a real folder without links or parent traversal")
    vetted = vet_workspace(path)
    if vetted is None:
        raise ValueError("This folder is outside the file fence")
    root = Path(vetted)
    names, consumed = [], 0
    with os.scandir(root) as entries:
        for entry in entries:
            # A link inside the folder (a linked node_modules or venv) is left out, never followed or read.
            if entry.is_symlink() or Path(entry.path).is_junction() or entry.name.startswith("."):
                continue
            consumed += len(entry.name.encode("utf-8")) + 1
            if consumed > MAX_BYTES or len(names) >= 2000:
                raise ValueError("Folder evidence exceeds 256 KB")
            names.append(entry.name)
    names.sort(key=str.casefold)
    reads = {}
    for name in names:
        if name.casefold() not in ("package.json", "readme", "readme.md", "readme.txt", "readme.rst"):
            continue
        target = root / name
        if not target.is_file():
            continue
        with target.open("rb") as file:
            data = file.read(MAX_BYTES - consumed + 1)
        consumed += len(data)
        if consumed > MAX_BYTES:
            raise ValueError("Folder evidence exceeds 256 KB")
        reads[name] = data.decode("utf-8", errors="replace")
    evidence = []
    deps = set()
    package_name = next((n for n in reads if n.casefold() == "package.json"), None)
    if package_name:
        try:
            manifest = json.loads(reads[package_name])
            if isinstance(manifest, dict):
                for key in ("dependencies", "devDependencies"):
                    if isinstance(manifest.get(key), dict):
                        deps.update(manifest[key])
        except ValueError:
            pass
    lower = {n.casefold(): n for n in names}
    rules = [
        ("frontend", "Interface builder", "Build clear, accessible interfaces.", {"react", "vue", "svelte", "next"}, {"static", "frontend", "web", "src"}),
        ("tests", "Test reviewer", "Check behaviour with focused tests.", {"vitest", "jest", "playwright", "mocha"}, {"tests", "test", "pytest.ini", "conftest.py"}),
        ("docs", "Documentation writer", "Explain setup and everyday use.", set(), {"docs", "readme.md", "readme", "readme.rst"}),
        ("data", "Data reviewer", "Check data shapes and query results.", {"prisma", "sqlite3", "pg", "mongoose"}, {"data", "schema.sql", "migrations", "prisma"}),
        ("deploy", "Release reviewer", "Check packaging and release steps.", set(), {"dockerfile", "compose.yaml", "docker-compose.yml", "deploy", "electron"}),
        ("review", "Code reviewer", "Check changes against the project rules.", set(), {"agents.md", "contributing.md", "codeowners"}),
    ]
    bots = []
    for key, name, role, dependencies, filenames in rules:
        source = package_name if deps & dependencies else next((lower[n] for n in sorted(filenames) if n in lower), None)
        if not source:
            continue
        evidence.append({"key": key, "file": source, "reason": role})
        bots.append({"key": key, "name": name, "role": role,
                     "soul": f"{role} Work from evidence. Explain assumptions and ask when a decision needs the person.", "routines": []})
        if len(bots) == 5:
            break
    if bots:
        bots.insert(0, {"key": "lead", "name": "Project lead", "role": "Coordinate the work and review the result.",
                        "soul": "Keep the goal, next steps and blockers clear. Give each specialist a concrete outcome. Review before reporting completion.", "routines": []})
        evidence.insert(0, {"key": "lead", "file": ".", "reason": "Leads the specialists this folder suggests."})
    else:
        bots = [{"key": "general", "name": "Project helper", "role": "Help with this project.",
                 "soul": "Start by understanding the goal and the files. Make a short plan and verify each completed step.", "routines": []}]
        evidence = [{"key": "general", "file": ".", "reason": "Nothing in the folder pointed to a specialist."}]
    result = bot_package.inspect(bot_package.canonical(bot_package.seal(bots, name="Project team")), owner_user=owner_user)
    result.update(evidence=evidence, bytes_read=consumed)
    return result
