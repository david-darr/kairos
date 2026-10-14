"""Quiet, reversible upkeep of an opted-in agent's dated memory bullets.

The pending journal is a write-ahead record: after a crash, the next read
rolls both files back before exposing memory (Agents 2.0, 2026-10-13).
"""
import base64
import hashlib
import json
import os
import re
import time
import uuid
from datetime import date, datetime
from pathlib import Path

from core import events
from services.agent_service import _memory_entry


# Five minutes clears an ordinary pause; the 15-second scheduler sees it on
# the next wake after laptop sleep (Agents 2.0, 2026-10-13).
QUIET_SECONDS = 300
# At most two removed bullets and at most a quarter of dated bullets. A small
# file therefore gets one cautious change at a time (2026-10-13).
MAX_REMOVALS = 2
MAX_UNDOABLE = 50
FINISHED_DAYS = 30


def _journal_path(service, agent_id):
    return Path(service._memory_path(agent_id)).with_name("memory-upkeep.json")


def _read_journal(path):
    if not path.exists():
        return {"entries": [], "checked": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".upkeep-tmp")
    with temporary.open("wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def _save(path, journal):
    _atomic(path, json.dumps(journal, ensure_ascii=False, indent=2).encode("utf-8"))


def _pack(value):
    return None if value is None else base64.b64encode(value).decode("ascii")


def _unpack(value):
    return None if value is None else base64.b64decode(value)


def _bytes(path):
    return path.read_bytes() if path.exists() else None


def _restore(path, value):
    if value is None:
        if path.exists():
            path.unlink()
    else:
        _atomic(path, value)


def recover(service, agent_id):
    """Finish an interrupted rollback before any memory access."""
    path = _journal_path(service, agent_id)
    if not path.exists():
        return
    journal = _read_journal(path)
    pending = next((e for e in journal["entries"] if e["status"] in ("pending", "undo-pending")), None)
    if pending is None:
        return
    for file in pending["files"]:
        target = path.parent / file["name"]
        if _bytes(target) not in (_unpack(file["before"]), _unpack(file["after"])):
            raise ValueError("upkeep recovery refused: a file changed during the interrupted pass")
    for file in pending["files"]:
        _restore(path.parent / file["name"],
                 _unpack(file["before"] if pending["status"] == "pending" else file["after"]))
    if pending["status"] == "pending":
        journal["entries"].remove(pending)
    else:
        pending["status"] = "committed"
    _save(path, journal)


def _tokens(body):
    equivalents = {"likes": "prefer", "like": "prefer", "prefers": "prefer",
                   "preferred": "prefer", "concise": "brief", "short": "brief",
                   "answers": "replies"}
    words = re.findall(r"[a-z0-9']+", body.lower())
    return [equivalents.get(w, w[:-1] if len(w) > 4 and w.endswith("s") else w)
            for w in words if w not in ("a", "an", "the")]


def _near(a, b):
    # A tiny equivalence set covers ordinary paraphrases. A different fact
    # word, especially a negation or relation, blocks the merge (2026-10-13).
    left, right = _tokens(a), _tokens(b)
    directional = {"not", "never", "no", "only", "except", "before", "after",
                   "instead", "without", "from", "to"}
    if len(left) < 2:
        return False
    return left == right or (not directional.intersection(left + right) and sorted(left) == sorted(right))


def _supersedes(new, old):
    new, old = new.casefold().rstrip(". "), old.casefold().rstrip(". ")
    return any(marker + old in new for marker in ("replaces: ", "instead of "))


def _plan(content, now):
    lines = content.decode("utf-8").splitlines(keepends=True)
    sections = []
    current = ""
    entries = []
    for i, line in enumerate(lines):
        if line.startswith("## "):
            current = line[3:].strip()
        sections.append(current)
        parsed = _memory_entry(line)
        if parsed and current:
            entries.append((i, current, *parsed))
    if len(entries) < 2:
        return None
    newest = max(entries, key=lambda e: (e[2], e[0]))[0]
    limit = min(MAX_REMOVALS, max(1, len(entries) // 4))
    removals = []
    replacements = {}
    reasons = []

    def select(old, reason, replacement=None):
        index, section = old[:2]
        if index == newest or index in removals or len(removals) >= limit:
            return False
        # A section with even one handwritten line is still nonempty; count
        # every substantive line, not only recognized bullets.
        remaining = [i for i, line in enumerate(lines) if sections[i] == section
                     and i != index and i not in removals and line.strip()
                     and not line.startswith("## ")]
        if not remaining:
            return False
        if replacement is not None:
            replacements.update(replacement)
        removals.append(index)
        reasons.append(reason)
        return True

    # Only merge within a section. Keep newer exact wording, changing just
    # its date to the earlier date; the removed line is archived verbatim.
    for old in entries:
        if len(removals) >= limit:
            break
        for new in sorted(entries, key=lambda e: (e[2], e[0]), reverse=True):
            if old[0] == new[0] or old[1] != new[1] or (old[2], old[0]) >= (new[2], new[0]):
                continue
            if _near(old[4], new[4]) and new[0] not in removals:
                rewritten = re.sub(r"^(\s*-\s+)\d{4}-\d{2}-\d{2}",
                                   lambda match: match[1] + old[2].isoformat(), lines[new[0]], count=1)
                if select(old, "near-duplicate", {new[0]: rewritten}):
                    break
    for old in entries:
        if len(removals) >= limit:
            break
        if any((new[2], new[0]) > (old[2], old[0]) and
               new[1] == "Corrections" and _supersedes(new[4], old[4])
               for new in entries if new[0] not in removals):
            select(old, "superseded")
    for old in entries:
        if len(removals) >= limit:
            break
        if old[3] is not None and old[3] <= now:
            select(old, "expired")
            continue
        project = re.search(r"\bproject ([\w-]+)\b", old[4], re.I)
        if project and any(new[0] != old[0] and (new[2], new[0]) > (old[2], old[0])
                           and re.search(r"\bproject " + re.escape(project[1]) +
                                         r"\b.*\b(completed|finished|closed)\b", new[4], re.I)
                           and (now - new[2]).days >= FINISHED_DAYS for new in entries):
            select(old, "finished project")
    if not removals:
        return None
    after = "".join(replacements.get(i, line) for i, line in enumerate(lines) if i not in removals).encode("utf-8")
    archived = []
    for i in removals:
        archived.append(f"\n### {sections[i]}\n".encode("utf-8") + lines[i].encode("utf-8"))
    addition = f"\n## Archived {now.isoformat()} (memory upkeep)\n".encode("utf-8") + b"".join(archived)
    return after, addition, [{"section": sections[i], "line": lines[i], "reason": reasons[n]}
                             for n, i in enumerate(removals)]


def upkeep(service, agent_id, *, now=None, topic=None):
    """Run one quiet pass, or return None without writing unchanged memory."""
    from core.session_manager import session_manager
    from services import chat_service

    agent = service._require(agent_id)
    if not agent.get("memory_upkeep"):
        return None
    moment = time.time() if now is None else now
    sessions = [s for s in session_manager.list_sessions(agent_id=agent_id) if s.get("message_count")]
    if not sessions or moment - max(s["updated_at"] for s in sessions) < QUIET_SECONDS:
        return None
    if any(chat_service.is_busy(s["id"]) for s in sessions):
        return None
    with service._admission_lock:
        if any(h["agent_id"] == agent_id for h in service._reservations.values()):
            return None
        recover(service, agent_id)
        memory = Path(service._topic_path(agent_id, topic) if topic is not None else service._memory_path(agent_id))
        before = _bytes(memory)
        if not before:
            return None
        journal_path = _journal_path(service, agent_id)
        journal = _read_journal(journal_path)
        digest = hashlib.sha256(before).hexdigest()
        today = datetime.fromtimestamp(moment).date()
        # Reconsider on a new day so a previously future expiry can mature.
        # Repeated polls within the day do no planning or writing (2026-10-13).
        checked = digest + ":" + today.isoformat()
        if journal["checked"].get(memory.name if topic is None else "memory/" + memory.name) == checked:
            return None
        if sum(e["status"] == "committed" for e in journal["entries"]) >= MAX_UNDOABLE:
            return None  # Never evict an undoable pass silently.
        planned = _plan(before, today)
        key = memory.name if topic is None else "memory/" + memory.name
        if planned is None:
            journal["checked"][key] = checked
            _save(journal_path, journal)
            return None
        after, addition, changes = planned
        archive = memory.parent.parent / f"memory-{topic}-archive.md" if topic else memory.with_name("memory-archive.md")
        archive_before = _bytes(archive)
        archive_after = (archive_before or b"") + addition
        entry = {"id": uuid.uuid4().hex, "at": moment, "topic": topic, "status": "pending",
                 "changes": changes, "files": [
                     {"name": key, "before": _pack(before), "after": _pack(after)},
                     {"name": archive.name, "before": _pack(archive_before), "after": _pack(archive_after)}]}
        journal["entries"] = [e for e in journal["entries"] if e["status"] != "undone"] + [entry]
        # A large archive can make snapshots expensive. Stop at the byte cap
        # instead of silently evicting still-undoable history (2026-10-13).
        if len(json.dumps(journal).encode("utf-8")) > 8_000_000:
            return None
        _save(journal_path, journal)
        _atomic(archive, archive_after)
        _atomic(memory, after)
        entry["status"] = "committed"
        journal["checked"][key] = hashlib.sha256(after).hexdigest() + ":" + today.isoformat()
        _save(journal_path, journal)
    events.emit("agent.memory_upkeep", f"{agent['name']} tidied {len(changes)} memory entr{'y' if len(changes) == 1 else 'ies'}.",
                agent_id=agent_id, upkeep_id=entry["id"])
    return {"id": entry["id"], "at": moment, "topic": topic, "changes": changes}


def journal_entries(service, agent_id):
    service._require(agent_id)
    recover(service, agent_id)
    return [{k: v for k, v in entry.items() if k != "files"}
            for entry in reversed(_read_journal(_journal_path(service, agent_id))["entries"])]


def undo(service, agent_id, upkeep_id):
    service._require(agent_id)
    with service._admission_lock:
        if any(h["agent_id"] == agent_id for h in service._reservations.values()):
            raise ValueError("Undo refused: this agent has work in flight")
        recover(service, agent_id)
        path = _journal_path(service, agent_id)
        journal = _read_journal(path)
        entry = next((e for e in journal["entries"] if e["id"] == upkeep_id), None)
        if entry is None or entry["status"] != "committed":
            raise ValueError("Undo refused: pass is missing or already undone")
        names = {f["name"] for f in entry["files"]}
        if any(e["status"] == "committed" and names.intersection(f["name"] for f in e["files"])
               for e in journal["entries"][journal["entries"].index(entry) + 1:]):
            raise ValueError("Undo refused: a newer pass changed the same file; undo it first")
        for file in entry["files"]:
            if _bytes(path.parent / file["name"]) != _unpack(file["after"]):
                raise ValueError("Undo refused: memory or archive changed since this pass")
        entry["status"] = "undo-pending"
        _save(path, journal)
        for file in entry["files"]:
            _restore(path.parent / file["name"], _unpack(file["before"]))
        entry["status"] = "undone"
        journal["checked"].pop(entry["files"][0]["name"], None)
        _save(path, journal)
        return {"id": upkeep_id, "undone": True}
