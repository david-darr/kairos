"""The shared skill library: reviewed procedures that bots can be given.

Layout under `<DATA_DIR>/bot-skills-library/`: `index.json` (metadata, no text),
`archive/<name>/<revision>.json` (immutable bundles), `skills/<name>/` (a read-only
projection of the current revision), `assignments.json`, `share-notes.json` and
`pending.json`. Retiring or replacing a skill never deletes archived bytes.
A library skill reaches a bot only when it is enabled, reviewed, unchanged on disk,
and assigned to that bot or to "Every bot". A bot's own skill of the same name wins.
"""
import time
import uuid
from pathlib import Path

from core.constants import DATA_DIR
from services.bot_skills import (ABSENT, LOCK, SkillError, atomic, bundle, check_revision, checked, digest, ident,
                                 name, read_json, redact, scan, usable_name, write_json)

ROOT = "bot-skills-library"
TEXT_FIELDS = ("skill_md", "references")


def _path(*parts):
    return checked(Path(DATA_DIR).joinpath(ROOT, *parts))


def _index():
    return read_json(_path("index.json"), {"version": 1, "revision": 0, "skills": {}, "migrated": {}})


def _save_index(value):
    value["revision"] += 1
    write_json(_path("index.json"), value)


def _archive_path(skill_name, revision):
    return _path("archive", name(skill_name), ident(revision) + ".json")


def _full(entry):
    """The entry with its archived text. A missing archive reads as unavailable."""
    path = _archive_path(entry["name"], entry["storage_revision"])
    if not path.exists():
        return None
    text = read_json(path, {})
    return {**entry, "skill_md": text.get("skill_md", ""), "references": text.get("references", {})}


def _intact(value):
    root = _path("skills", value["name"])
    try:
        for relative, content in {"SKILL.md": value["skill_md"], **value["references"]}.items():
            target = checked(root / relative)
            if not target.is_file() or target.read_bytes() != content.encode("utf-8"):
                return False
        return True
    except (OSError, SkillError):
        return False


def _assignments():
    return read_json(_path("assignments.json"), {"version": 1, "revision": 0, "every": [], "bots": {}})


def _view(entry, assignments=None):
    value = _full(entry)
    if value is None:
        value = {**entry, "skill_md": "", "references": {}}
        missing = True
    else:
        missing = False
    assignments = assignments or _assignments()
    value["changed_after_review"] = missing or not _intact(value)
    value["effective_enabled"] = (value["enabled"] and not value["retired"] and not value["changed_after_review"]
                                  and value.get("reviewed_sha256") == value["sha256"])
    value["path"] = str(_path("skills", value["name"], "SKILL.md"))
    value["every_bot"] = value["name"] in assignments["every"]
    value["assigned_bots"] = sorted(b for b, names in assignments["bots"].items() if value["name"] in names)
    value["origin"] = entry.get("origin", "library")
    return value


def summary(value):
    """A listing row: no skill text."""
    row = {k: v for k, v in value.items() if k not in TEXT_FIELDS}
    row["reference_names"] = sorted(value["references"])
    return row


def publish(skill_name, skill_md, *, references=None, tags=None, source="imported", origin="library",
            expected_revision=ABSENT, skipped_files=None, reviewed=False, shared_by=None):
    """Write a new immutable revision. Unreviewed text lands disabled; `reviewed` is for text a person
    already read (a shared private skill, a migrated global skill)."""
    value = bundle(skill_name, skill_md, references, tags)
    entry = {k: v for k, v in value.items() if k not in TEXT_FIELDS}
    entry.update(warnings=scan(value), source=redact(str(source))[:2048], origin=origin, enabled=bool(reviewed),
                 reviewed_sha256=value["sha256"] if reviewed else None, retired=False, imported_at=time.time(),
                 storage_revision=uuid.uuid4().hex, skipped_files=(skipped_files or [])[:200], shared_by=shared_by)
    with LOCK:
        index = _index()
        current = index["skills"].get(skill_name)
        if current and current["retired"]:
            current = None
        check_revision(current, expected_revision)
        write_json(_archive_path(skill_name, entry["storage_revision"]),
                   {**entry, "skill_md": value["skill_md"], "references": value["references"]})
        root = _path("skills", skill_name)
        for relative, content in {"SKILL.md": value["skill_md"], **value["references"]}.items():
            atomic(root / relative, content.encode("utf-8"))
        if current:
            _history(index, current)
        index["skills"][skill_name] = entry
        _save_index(index)
    return get(skill_name)


def _history(index, entry):
    """Remember superseded revisions so a revision list survives updates."""
    past = index.setdefault("history", {}).setdefault(entry["name"], [])
    past.append({"storage_revision": entry["storage_revision"], "sha256": entry["sha256"],
                 "description": entry["description"], "source": entry["source"], "imported_at": entry["imported_at"]})
    del past[:-50]


def get(skill_name):
    entry = _index()["skills"].get(name(skill_name))
    if entry is None:
        raise SkillError("Library skill not found.", 404)
    return _view(entry)


def list_all(query="", tag=""):
    index, assignments = _index(), _assignments()
    rows = []
    for entry in index["skills"].values():
        if entry["retired"]:
            continue
        haystack = " ".join([entry["name"], entry["description"], *entry["tags"]]).lower()
        if query and query.lower() not in haystack or tag and tag not in entry["tags"]:
            continue
        rows.append(summary(_view(entry, assignments)))
    return sorted(rows, key=lambda row: row["name"])


def revisions(skill_name):
    index = _index()
    entry = index["skills"].get(name(skill_name))
    if entry is None:
        raise SkillError("Library skill not found.", 404)
    current = {"storage_revision": entry["storage_revision"], "sha256": entry["sha256"], "description": entry["description"],
               "source": entry["source"], "imported_at": entry["imported_at"], "current": True}
    return [current, *reversed(index.get("history", {}).get(skill_name, []))]


def set_enabled(skill_name, enabled, *, expected_revision, reviewed_sha256=None):
    with LOCK:
        index = _index()
        entry = index["skills"].get(name(skill_name))
        if entry is None or entry["retired"]:
            raise SkillError("Library skill not found.", 404)
        check_revision(entry, expected_revision)
        if enabled:
            value = _view(entry)
            if reviewed_sha256 != entry["sha256"] or value["changed_after_review"]:
                raise SkillError("This skill changed after review. Reload and review it again.", 409)
            scan(value)
            entry["reviewed_sha256"] = reviewed_sha256
        entry["enabled"] = bool(enabled)
        _save_index(index)
    return get(skill_name)


def update(skill_name, *, expected_revision, tags=None, every_bot=None):
    with LOCK:
        index = _index()
        entry = index["skills"].get(name(skill_name))
        if entry is None or entry["retired"]:
            raise SkillError("Library skill not found.", 404)
        check_revision(entry, expected_revision)
        if tags is not None:
            if not isinstance(tags, list) or len(tags) > 8 or any(
                    not isinstance(t, str) or not 1 <= len(t) <= 40 or "\n" in t for t in tags):
                raise SkillError("Use up to eight short tags.")
            entry["tags"] = list(dict.fromkeys(tags))
            _save_index(index)
        if every_bot is not None:
            set_every(skill_name, every_bot)
    return get(skill_name)


def retire(skill_name, *, expected_revision):
    """Hide a skill from every bot. Its archived revisions and projection stay on disk."""
    with LOCK:
        index = _index()
        entry = index["skills"].get(name(skill_name))
        if entry is None or entry["retired"]:
            raise SkillError("Library skill not found.", 404)
        check_revision(entry, expected_revision)
        entry.update(retired=True, enabled=False)
        _save_index(index)
        assignments = _assignments()
        assignments["every"] = [n for n in assignments["every"] if n != skill_name]
        assignments["bots"] = {b: [n for n in names if n != skill_name] for b, names in assignments["bots"].items()}
        assignments["bots"] = {b: names for b, names in assignments["bots"].items() if names}
        assignments["revision"] += 1
        write_json(_path("assignments.json"), assignments)
    return {"retired": skill_name}


# -- assignments ---------------------------------------------------------------------------------

def assignments():
    return _assignments()


def assign(bot_id, names, *, expected_revision):
    """Replace one bot's explicit library skills."""
    ident(bot_id)
    if not isinstance(names, list) or len(names) > 100:
        raise SkillError("Choose up to 100 library skills.")
    with LOCK:
        current = _assignments()
        if expected_revision != current["revision"]:
            raise SkillError("Assignments changed. Reload and try again.", 409)
        index = _index()
        chosen = sorted({name(n) for n in names})
        for skill_name in chosen:
            entry = index["skills"].get(skill_name)
            if entry is None or entry["retired"]:
                raise SkillError(f"Library skill {skill_name} was not found.", 404)
        if chosen:
            current["bots"][bot_id] = chosen
        else:
            current["bots"].pop(bot_id, None)
        current["revision"] += 1
        write_json(_path("assignments.json"), current)
    return current


def assign_to(bot_ids, skill_name):
    """Add one skill to several bots at once (sharing). Skips bots that already hold it."""
    with LOCK:
        current = _assignments()
        entry = _index()["skills"].get(name(skill_name))
        if entry is None or entry["retired"]:
            raise SkillError("Library skill not found.", 404)
        added = []
        for bot_id in bot_ids:
            names = set(current["bots"].get(ident(bot_id), []))
            if skill_name not in names:
                current["bots"][bot_id] = sorted(names | {skill_name})
                added.append(bot_id)
        if added:
            current["revision"] += 1
            write_json(_path("assignments.json"), current)
    return added


def set_every(skill_name, on):
    with LOCK:
        entry = _index()["skills"].get(name(skill_name))
        if entry is None or entry["retired"]:
            raise SkillError("Library skill not found.", 404)
        current = _assignments()
        every = set(current["every"])
        if on == (skill_name in every):
            return current
        current["every"] = sorted(every | {skill_name} if on else every - {skill_name})
        current["revision"] += 1
        write_json(_path("assignments.json"), current)
    return current


def assigned(bot_id):
    """Resolved library skills this bot can use now."""
    ident(bot_id)
    index, current = _index(), _assignments()
    wanted = set(current["every"]) | set(current["bots"].get(bot_id, []))
    result = []
    for skill_name in sorted(wanted):
        entry = index["skills"].get(skill_name)
        if entry is None:
            continue
        value = _view(entry, current)
        if value["effective_enabled"]:
            value["assigned_via"] = "every" if skill_name in current["every"] else "bot"
            result.append(value)
    return result


# -- one-time import of the global Tool Store skills ----------------------------------------------

def migrate_global():
    """Read the first admin's skills folder (where the old global skills lived), whoever is current."""
    from core import accounts
    with accounts.as_account(accounts.local_account()):
        return _migrate_global()


def _migrate_global():
    """Copy the current global skills into the library once, keeping their enabled state.

    The original files are never moved or changed. A skill already migrated is skipped on
    replay, even if the global copy has changed since: the library copy is its own record.
    Only SKILL.md and references/*.md travel; anything else is listed as skipped."""
    from services import skill_curator, skills_service
    imported, skipped = [], []
    with LOCK:
        done = _index().get("migrated", {})
        for item in skills_service.list_skills():
            slug = item["slug"]
            if slug in done or item.get("error"):
                continue
            try:
                name(slug)
                root = Path(skills_service._skill_path(slug)).parent
                skill_md = skills_service._read(str(root / "SKILL.md"))
                references, left = {}, []
                for path in sorted(p for p in root.rglob("*") if p.is_file()):
                    relative = path.relative_to(root).as_posix()
                    if relative == "SKILL.md" or relative == ".provenance":
                        continue
                    if (relative.startswith("references/") and relative.endswith(".md") and relative.count("/") == 1
                            and len(references) < 8 and path.stat().st_size <= 32 * 1024):
                        references[relative] = path.read_text(encoding="utf-8", errors="replace")
                    else:
                        left.append(relative)
                visible = skill_curator.model_visible(slug)
                publish(slug, skill_md, references=references, source="global:" + slug, origin="global",
                        skipped_files=left, reviewed=visible)
                imported.append(slug)
            except (SkillError, OSError, ValueError, skills_service.SkillUnreadable) as error:
                skipped.append({"name": slug, "reason": str(error)[:300]})
            with LOCK:
                index = _index()
                index.setdefault("migrated", {})[slug] = digest(slug)
                _save_index(index)
    return {"imported": imported, "skipped": skipped}
