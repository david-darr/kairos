"""Additive package installation with a reverse-order undo journal."""
from __future__ import annotations

import copy

from services import bot_package


class ImportFailure(ValueError):
    def __init__(self, message, cleanup_errors=()):
        super().__init__(message)
        self.cleanup_errors = list(cleanup_errors)


def free_name(name, taken):
    used = {n.casefold() for n in taken}
    candidate, number = name, 2
    while candidate.casefold() in used:
        suffix = f" {number}"
        candidate = name[:100 - len(suffix)] + suffix
        number += 1
    return candidate


def selected(package, selection):
    groups = {"bots": "key", "skills": "name", "connections": "name", "presets": "name"}
    if selection is None:
        selection = {k: [r[field] for r in package[k]] for k, field in groups.items()}
        selection["sections"] = list(package.get("sections", {}))
    if not isinstance(selection, dict) or set(selection) - {*groups, "sections"}:
        raise ValueError("Invalid import selection")
    result = {}
    for group, field in groups.items():
        picks = selection.get(group, [])
        available = {r[field] for r in package[group]}
        if not isinstance(picks, list) or any(not isinstance(p, str) for p in picks) or len(set(picks)) != len(picks) or not set(picks) <= available:
            raise ValueError(f"Invalid {group} selection")
        result[group] = [r for r in package[group] if r[field] in picks]
    sections = selection.get("sections", [])
    if not isinstance(sections, list) or any(s not in package.get("sections", {}) for s in sections):
        raise ValueError("Invalid section selection")
    result["sections"] = {s: package["sections"][s] for s in sections}
    return result


def _stage_skill(skill, bot_ids):
    """P2 adapter. Its owner supplies stage_package/remove_package_stage."""
    try:
        from services import bot_skill_import
    except ImportError as exc:
        raise ValueError("Skill import is unavailable. Clear Skills and try again") from exc
    if not hasattr(bot_skill_import, "stage_package"):
        raise ValueError("Skill import is unavailable. Clear Skills and try again")
    receipt = bot_skill_import.stage_package(skill, bot_ids=bot_ids, enabled=False)
    return lambda: bot_skill_import.remove_package_stage(receipt)


def _stage_connection(connection):
    # Disabled local drafts are inert. P2 can review them before adding them to
    # its live integration store. No command or header value is ever accepted.
    import time
    import uuid
    from core.atomic_io import write_json_atomic
    from core.constants import DATA_DIR
    from pathlib import Path
    path = Path(DATA_DIR) / "bot_lifecycle" / "connections" / f"{uuid.uuid4().hex}.json"
    write_json_atomic(str(path), {**connection, "enabled": False, "headers": {h: "" for h in connection["header_names"]},
                                  "created_at": time.time(), "source": "package"})
    return lambda: path.unlink(missing_ok=True)


def apply(package, selection=None, *, owner_user=None):
    from services import bot_record
    from services.agent_service import agent_service
    from services.task_service import task_service
    chosen = selected(package, selection)
    if len(agent_service.list_agents()) + len(chosen["bots"]) > bot_record.MAX_BOTS:
        raise ValueError("The workspace allows at most 100 bots")
    journal, created = [], []
    taken = [a["name"] for a in agent_service.list_agents()]
    try:
        for bot in chosen["bots"]:
            name = free_name(bot["name"], taken)
            result = bot_record.create_configured({
                "profile": {**{k: copy.deepcopy(bot[k]) for k in ("role", "blurb", "soul", "avatar", "color") if k in bot}, "name": name},
                "approval_mode": "full", "integration_ids": [], "routines": [], "memory_seed": bot.get("memory_seed", []),
                "origin": {"kind": "preset", "id": bot["key"]}, "use_defaults": False,
            }, owner_user=owner_user)
            agent = result["agent"]
            journal.append(("bot", lambda ident=agent["id"]: agent_service.delete(ident)))
            created.append({"key": bot["key"], "id": agent["id"], "name": name})
            taken.append(name)
            for routine in bot.get("routines", []):
                fields = {k: v for k, v in routine.items() if k not in ("enabled", "name", "prompt", "schedule_kind")}
                task = task_service.create_task(routine["name"], routine["prompt"], routine["schedule_kind"],
                                                **fields, agent_id=agent["id"], owner_user=owner_user, enabled=False)
                journal.append(("routine", lambda ident=task["id"]: task_service.delete_task(ident)))
        for skill in chosen["skills"]:
            journal.append(("skill", _stage_skill(skill, [r["id"] for r in created])))
        for connection in chosen["connections"]:
            journal.append(("connection", _stage_connection(connection)))
        for preset in chosen["presets"]:
            made = bot_record.add_preset(preset)
            journal.append(("preset", lambda ident=made["id"]: bot_record.delete_preset(ident)))
        mapping = {row["key"]: row["id"] for row in created}
        for name, data in chosen["sections"].items():
            undo = bot_package._sections[name][1](data, mapping)
            if not callable(undo):
                raise ValueError(f"Section {name} did not provide rollback")
            journal.append((name, undo))
        return {"created": created, "warnings": [], "counts": {k: len(v) for k, v in chosen.items()}}
    except Exception as exc:
        errors = list(getattr(exc, "cleanup_errors", []))
        for label, undo in reversed(journal):
            try:
                undo()
            except Exception:
                errors.append(f"Could not remove imported {label}. Check the workspace")
        # Never echo exception text from callbacks: it may carry credentials.
        raise ImportFailure("Import failed. Created items were rolled back" if not errors else
                            "Import failed. Some items could not be removed", errors) from exc
