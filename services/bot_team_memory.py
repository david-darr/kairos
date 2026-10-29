"""Revision-checked team facts. Accepted text is always prompt data."""
import copy
import hashlib
import json
import os
import time
import uuid

from fastapi import HTTPException
from core.logs import scrub_credentials
from core.untrusted import wrap_untrusted
from services import bot_departments as teams

KINDS = ("person", "place", "decision", "term")
FIELDS = ("kind", "name", "detail", "aliases", "key", "pinned", "source_quote")


def _path(team_id, user=None):
    return teams.directory(team_id, user) / "memory.json"


def _read(team_id, user=None):
    data = teams.load(_path(team_id, user), {"version": 1, "entries": []})
    if (not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), list) or
            any(not isinstance(e, dict) or not isinstance(e.get("id"), str) or
                e.get("kind") not in KINDS or e.get("status") not in ("proposed", "accepted") or
                not isinstance(e.get("revision"), str) or not isinstance(e.get("history"), list)
                for e in data["entries"])):
        raise HTTPException(503, "Team memory could not be read")
    return data


def _revision(entry):
    return hashlib.sha256(json.dumps({k: v for k, v in entry.items() if k not in ("revision", "history")},
                                    sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _clean(fields, base=None):
    unknown = set(fields) - set(FIELDS)
    if unknown:
        raise HTTPException(400, "Unknown team memory field")
    result = {**(base or {}), **fields}
    if result.get("kind") not in KINDS:
        raise HTTPException(400, "Choose a memory kind")
    for key, limit, required in (("name", 120, True), ("detail", 600, True), ("key", 240, False),
                                  ("source_quote", 2000, False)):
        value = result.get(key, "")
        if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
            raise HTTPException(400, f"Invalid memory {key.replace('_', ' ')}")
        result[key] = scrub_credentials(value.strip())
    aliases = result.get("aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 8 or any(not isinstance(a, str) or not 1 <= len(a.strip()) <= 120 for a in aliases):
        raise HTTPException(400, "Use up to 8 short aliases")
    result["aliases"] = list(dict.fromkeys(scrub_credentials(a.strip()) for a in aliases))
    if type(result.get("pinned", False)) is not bool:
        raise HTTPException(400, "Pinned must be true or false")
    result.setdefault("pinned", False)
    return result


def listing(team_id, user=None):
    with teams.LOCK:
        entries = copy.deepcopy(_read(team_id, user)["entries"])
        return {"entries": entries, "max_prompt_bytes": 6000}


def propose(team_id, fields, source_bot_id=None, *, accept=False, user=None):
    with teams.LOCK:
        teams.get(team_id, user)
        if source_bot_id and source_bot_id not in {b["id"] for b in teams.members(team_id, user)}:
            raise HTTPException(403, "Only a team member can propose memory")
        clean = _clean(fields)
        data = _read(team_id, user)
        if len(data["entries"]) >= 2000:
            raise HTTPException(409, "Team memory is full")
        entry = {**clean, "id": uuid.uuid4().hex, "status": "proposed", "source_bot_id": source_bot_id,
                 "created_at": time.time(), "updated_at": time.time(), "history": []}
        entry["revision"] = _revision(entry)
        data["entries"].append(entry)
        teams.save(_path(team_id, user), data)
        if accept:
            return action(team_id, entry["id"], "accept", entry["revision"], user=user)
        return copy.deepcopy(entry)


def _entry(data, ident, expected):
    entry = next((e for e in data["entries"] if e["id"] == ident), None)
    if not entry:
        raise HTTPException(404, "Memory entry not found")
    if entry["revision"] != expected:
        raise HTTPException(409, "Team memory changed. Reload it first")
    return entry


def _remember(entry):
    return [{k: copy.deepcopy(v) for k, v in entry.items() if k != "history"}, *entry["history"]][:50]


def edit(team_id, ident, fields, expected_revision, user=None):
    with teams.LOCK:
        data = _read(team_id, user)
        entry = _entry(data, ident, expected_revision)
        after = _clean(fields, entry)
        after.update(history=_remember(entry), updated_at=time.time())
        after["revision"] = _revision(after)
        entry.clear()
        entry.update(after)
        teams.save(_path(team_id, user), data)
        return copy.deepcopy(entry)


def _journal_path(team_id, user=None):
    return teams.directory(team_id, user) / "journal.ndjson"


def _journal(team_id, user=None):
    path = _journal_path(team_id, user)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        rows = [json.loads(line) for line in lines if line.strip()]
        if any(not isinstance(r, dict) or "id" not in r for r in rows):
            raise ValueError("invalid journal")
        return rows
    except FileNotFoundError:
        return []
    except (OSError, ValueError, UnicodeError) as error:
        raise HTTPException(503, "Team memory history could not be read") from error


def action(team_id, ident, action, expected_revision, *, user=None, restore_revision=None):
    with teams.LOCK:
        data = _read(team_id, user)
        entry = _entry(data, ident, expected_revision)
        journal = _journal(team_id, user)  # damaged audit state blocks any mutation
        if action in ("delete", "skip"):
            if action == "skip" and entry["status"] != "proposed":
                raise HTTPException(409, "This entry was already accepted")
            data["entries"].remove(entry)
            teams.save(_path(team_id, user), data)
            return {"ok": True}
        before = copy.deepcopy(entry)
        if action == "accept":
            if entry["status"] != "proposed":
                raise HTTPException(409, "This entry was already accepted")
            entry["status"] = "accepted"
        elif action == "restore":
            old = next((h for h in entry["history"] if h["revision"] == restore_revision), None)
            if not old:
                raise HTTPException(404, "Memory version not found")
            entry.update({k: old[k] for k in FIELDS if k in old})
        elif action == "undo":
            receipt = next((j for j in reversed(journal) if j.get("entry_id") == ident and
                            j.get("after_revision") == expected_revision and j.get("kind") == "accept"), None)
            if not receipt:
                raise HTTPException(409, "This memory change can no longer be undone")
            entry.clear()
            entry.update(copy.deepcopy(receipt["before"]))
        else:
            raise HTTPException(400, "Unknown memory action")
        entry.update(history=_remember(before), updated_at=time.time())
        entry["revision"] = _revision(entry)
        receipt = {"id": uuid.uuid4().hex, "entry_id": ident, "kind": action, "before": before,
                   "after_revision": entry["revision"], "at": time.time()}
        # Write ahead. A torn or unavailable journal never allows an accept.
        path = _journal_path(team_id, user)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(receipt, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        teams.save(_path(team_id, user), data)
        return copy.deepcopy(entry)


def search(team_id, query, user=None):
    if not isinstance(query, str) or len(query) > 500:
        raise HTTPException(400, "Use a short memory search")
    needle = query.casefold()
    return [e for e in listing(team_id, user)["entries"] if e["status"] == "accepted" and
            needle in " ".join(str(e.get(k, "")) for k in ("name", "detail", "aliases", "key")).casefold()][:50]


def prompt(team_id):
    accepted = [e for e in listing(team_id)["entries"] if e["status"] == "accepted"]
    if not accepted:
        return ""
    accepted.sort(key=lambda e: (not e.get("pinned"), -e.get("updated_at", e["created_at"]), e["id"]))
    chosen = []
    def block(rows):
        content = "\n".join(f"{e['kind']}: {e['name']}: {e['detail']}" for e in rows)
        return "Team memory\n" + wrap_untrusted("team memory", f"Loaded {len(rows)} of {len(accepted)}\n{content}\nSearch team memory for other facts.")
    for entry in accepted:
        if len(block(chosen + [entry]).encode("utf-8")) > 6000:
            break
        chosen.append(entry)
    return block(chosen)
