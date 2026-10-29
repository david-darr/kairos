"""Quiet, reversible upkeep of an opted-in bot's dated notes (Agents 2.0, 2026-10-13; moved onto the
notebook for Bots Phase 2, 2026-10-29).

This is the deterministic pass: it archives expired and superseded notes, merges exact near-duplicates and
drops finished projects, never touching a safety or health fact or any hand-written text. It runs through
services/bot_memory.py, so every pass is one journaled, guarded-Undo change in the protected journal, and an
interrupted pass is finished by the notebook's own crash recovery. Unit U2's model-assisted tidy (organize,
dream) replaces the scheduler's call to it; both use the same transactions.
"""
import json
import re
import time
from datetime import datetime

from core import events
from services import bot_memory, bot_memory_journal, bot_memory_store as store
redact = bot_memory_journal.redact
from services.agent_service import _memory_entry
from services.bot_memory_entries import is_protected_text, _PROTECTED_SECTIONS


# Five minutes clears an ordinary pause; the 15-second scheduler sees it on
# the next wake after laptop sleep (Agents 2.0, 2026-10-13).
QUIET_SECONDS = 300
# At most two removed bullets and at most a quarter of dated bullets. A small
# file therefore gets one cautious change at a time (2026-10-13).
MAX_REMOVALS = 2
FINISHED_DAYS = 30
ACTORS = ("upkeep",)


def _checked_path(agent_id):
    return store.state_dir(agent_id) / "upkeep-checked.json"


def _read_checked(agent_id):
    try:
        data = json.loads(_checked_path(agent_id).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_checked(agent_id, checked):
    from services import bot_memory_journal as journal
    journal._dir(agent_id)
    journal._atomic(_checked_path(agent_id), json.dumps(checked).encode("utf-8"))


def recover(service, agent_id):
    """Finish an interrupted change before any memory access (the notebook does it for every access)."""
    bot_memory.ensure_notebook(agent_id)


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
    multi = set()   # a note with continuation lines is left to the person: removing only its first line would orphan the rest
    for i, line in enumerate(lines):
        if line.startswith("## "):
            current = line[3:].strip()
        sections.append(current)
        parsed = _memory_entry(line)
        if parsed and current:
            entries.append((i, current, *parsed))
            if i + 1 < len(lines) and lines[i + 1].startswith("  ") and lines[i + 1].strip():
                multi.add(i)
    if len(entries) < 2:
        return None
    newest = max(entries, key=lambda e: (e[2], e[0]))[0]
    limit = min(MAX_REMOVALS, max(1, len(entries) // 4))
    removals = []
    replacements = {}
    reasons = []

    def select(old, reason, replacement=None):
        index, section = old[:2]
        if index == newest or index in removals or len(removals) >= limit or index in multi:
            return False
        if section.lower() in _PROTECTED_SECTIONS or is_protected_text(old[4]):
            return False   # a safety or health fact stays in the index
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




def upkeep(service, agent_id, *, now=None, topic=None, force=False):
    """Run one quiet pass, or return None without writing unchanged memory. force: the person asked for it now,
    so the quiet window is skipped (a chat in progress still holds it off)."""
    from core.session_manager import session_manager
    from services import chat_service

    agent = service._require(agent_id)
    if not agent.get("memory_upkeep"):
        return None
    moment = time.time() if now is None else now
    sessions = [s for s in session_manager.list_sessions(agent_id=agent_id) if s.get("message_count")]
    if not force and (not sessions or moment - max(s["updated_at"] for s in sessions) < QUIET_SECONDS):
        return None
    if any(chat_service.is_busy(s["id"]) for s in sessions):
        return None
    with service._admission_lock:
        if any(h["agent_id"] == agent_id for h in service._reservations.values()):
            return None
        path = store.topic_path(topic) if topic is not None else store.INDEX_NAME
        with bot_memory.lock(agent_id):
            bot_memory.ensure_notebook(agent_id)
            before = store.read_bytes(agent_id, path)
            if not before:
                return None
            digest = store.sha256(before)
            today = datetime.fromtimestamp(moment).date()
            # Reconsider on a new day so a previously future expiry can mature.
            # Repeated polls within the day do no planning or writing (2026-10-13).
            checked = digest + ":" + today.isoformat()
            marks = _read_checked(agent_id)
            if marks.get(path) == checked:
                return None
            try:
                planned = _plan(before, today)
            except UnicodeDecodeError:
                return None   # a file that is not text is left alone
            if planned is None:
                marks[path] = checked
                _save_checked(agent_id, marks)
                return None
            after, addition, changes = planned
            archive = store.read_bytes(agent_id, store.ARCHIVE_PATH)
            changes_list = [{"path": path, "expected_hash": digest, "data": after},
                            {"path": store.ARCHIVE_PATH, "expected_hash": store.sha256(archive),
                             "data": (archive or b"") + addition}]
            try:
                result = bot_memory.apply_transaction(
                agent_id, changes_list, actor="upkeep", source="tidy", now=moment,
                summary=f"Tidied {len(changes)} note{'' if len(changes) == 1 else 's'}",
                extra={"topic": topic, "changes": [{"section": c["section"], "line": redact(c["line"]), "reason": c["reason"]}
                                                    for c in changes]})
            except (store.CapacityError, store.StaleState):
                return None   # an archive at its size limit, or a note edited mid-pass: try again another day
            row = result["row"]
            marks[path] = store.sha256(after) + ":" + today.isoformat()
            _save_checked(agent_id, marks)
    events.emit("agent.memory_upkeep", f"{agent['name']} tidied {len(changes)} memory entr{'y' if len(changes) == 1 else 'ies'}.",
                agent_id=agent_id, upkeep_id=row["id"])
    return {"id": row["id"], "at": moment, "topic": topic, "changes": changes}


def journal_entries(service, agent_id):
    """The tidy passes, newest first: {id, at, ts, topic, status, summary, changes}."""
    service._require(agent_id)
    bot_memory.ensure_notebook(agent_id)
    from services import bot_memory_journal as journal
    return [{"id": row["id"], "at": row["time"], "ts": row["time"], "topic": row.get("topic"),
             "status": "undone" if row.get("reverted_by") else "committed",
             "summary": row.get("summary", ""), "changes": row.get("changes", [])}
            for row in journal.rows(agent_id, 200) if row.get("actor") in ACTORS]


def undo(service, agent_id, upkeep_id):
    service._require(agent_id)
    with service._admission_lock:
        if any(h["agent_id"] == agent_id for h in service._reservations.values()):
            raise ValueError("Undo refused: this agent has work in flight")
        from services import bot_memory_journal as journal
        bot_memory.ensure_notebook(agent_id)
        row = journal.find_row(agent_id, upkeep_id)
        if row is None or row.get("actor") not in ACTORS or row.get("reverted_by"):
            raise ValueError("Undo refused: pass is missing or already undone")
        bot_memory.revert(agent_id, upkeep_id, actor="person", source="undo of a tidy pass")
        return {"id": upkeep_id, "undone": True}
