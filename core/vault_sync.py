"""Keep the vault's task list and the app's Notes store as one memory.

David hit this live (2026-09-03): he asked the packaged app "any priorities?"
and it answered "none" from Notes/Calendar/Tasks — while his connected vault's
Active Priorities.md was full of real open work. Both halves were correct in
isolation and useless together. The model has vault file access, but the
structured stores every other feature reads (Notes tab, Home stats, the Daily
Brief, list_notes) knew nothing about the vault's contents.

This closes that gap at the data layer rather than by prompting harder:
Active Priorities.md is parsed on launch and its checkbox items become real
Notes, so every existing code path sees them with no further changes.

Mapping (the vault's own conventions, not a new format imposed on it):
    ## Heading          ->  note.project
    - [ ] item text     ->  note.text, completed=False
    - [x] item text     ->  note.text, completed=True

Safety properties, because this touches a user's real memory:
  - Reading is the default. The only write is flipping a single checkbox
    character on a line whose full text still matches exactly what was
    imported; if the line changed or moved, the write is skipped rather
    than guessed at.
  - Notes created here carry a `vault_source`. App-native notes are never
    touched by sync, and vault-sourced notes are never edited by the app
    except through that one checkbox write-back.
  - Re-running is idempotent: items are matched on (file, heading, line text
    with the checkbox ignored), so a second sync updates rather than
    duplicates, a tick made in the vault keeps the note, and the same line
    under two headings is two tasks.
  - A note the user deletes in the app stays hidden (not re-imported) for as
    long as its line is in the vault.
  - An item deleted from the vault removes its imported note, because the
    vault is the source of truth for anything it owns. App-native notes
    are unaffected. But only when the vault really is the one the note came
    from and was read properly: a missing, empty, unreadable or different
    folder never deletes anything (2026-11-06: a profile pointed at an empty
    folder, which the app seeds with a blank Active Priorities.md, lost 90
    notes this way; v2.2.0 has the same hole). Such notes are only marked
    `vault_source.unsynced` and come back to normal when their vault does.
"""
import logging
import os
import re
from typing import Optional

from core.vault import resolve_vault_dir
from services.notes_service import notes_service

logger = logging.getLogger(__name__)

# Active Priorities.md describes itself as "the single master task list", so
# it's the one file synced by default. Kept as a list because a user whose
# vault splits tasks across a couple of files is a plausible next step.
TASK_FILES = ["Active Priorities.md"]

_CHECKBOX_RE = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.*)$")
_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
_BOX_RE = re.compile(r"\[[ xX]\]")

# Placeholder text the seeded vault (and David's own file) uses for an empty
# section — never import it as a real task.
_EMPTY_MARKERS = {"nothing tracked yet.", "nothing tracked yet"}

DISPLAY_MAX = 180


def _display_text(raw: str) -> str:
    """Vault task lines can run to full paragraphs (David's own file has
    several hundred-word entries). Notes cards show text verbatim, so keep a
    readable summary for display while `vault_source.line` retains the exact
    original for matching and write-back."""
    text = raw.strip()
    if len(text) <= DISPLAY_MAX:
        return text
    cut = text[:DISPLAY_MAX]
    # Prefer breaking at a sentence end, then a word boundary.
    for sep in (". ", " — ", ", "):
        idx = cut.rfind(sep)
        if idx > DISPLAY_MAX // 2:
            return cut[:idx + (1 if sep == ". " else 0)].strip() + "…"
    idx = cut.rfind(" ")
    return (cut[:idx] if idx > 0 else cut).strip() + "…"


def parse_task_file(path: str, strict: bool = False) -> Optional[list[dict]]:
    """[{heading, line, text, completed}] for every checkbox item. An unreadable
    file is [] (None when strict, so the caller can tell it from an empty one)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return None if strict else []

    items = []
    heading = "General"
    for line in lines:
        heading_match = _HEADING_RE.match(line)
        if heading_match:
            heading = heading_match.group(1).strip()
            continue
        box = _CHECKBOX_RE.match(line)
        if not box:
            continue
        body = box.group(2).strip()
        if not body or body.lower() in _EMPTY_MARKERS:
            continue
        items.append({
            "heading": heading,
            "line": line,          # exact original, for write-back matching
            "text": _display_text(body),
            "completed": box.group(1).lower() == "x",
        })
    return items


def _vault_tag(vault_dir: str) -> str:
    """Which vault a note was imported from, comparable across runs and spellings of the path."""
    return os.path.normcase(os.path.abspath(vault_dir))


def sync_from_vault() -> dict:
    """Import/refresh vault task items into Notes. Returns a summary dict."""
    vault_dir = resolve_vault_dir()
    tag = _vault_tag(vault_dir)
    summary = {"imported": 0, "updated": 0, "removed": 0, "unsynced": 0, "files": 0, "vault_dir": vault_dir}

    # Existing vault notes by (file, heading, line with the box ignored). Hidden
    # (dismissed) notes are included so a deleted item is not imported again.
    index: dict[tuple, list[dict]] = {}
    for note in notes_service.list_notes(include_dismissed=True):
        if note.get("vault_source"):
            index.setdefault(_note_key(note), []).append(note)
    matched: set[str] = set()
    legacy_matched = False   # a note imported before notes carried their vault matched this vault
    sources: dict[str, dict] = {}   # note id -> vault_source to store (tag, line, unsynced)
    good_files: set[str] = set()    # read fine and not empty: only these may remove notes
    for filename in TASK_FILES:
        path = os.path.join(vault_dir, filename)
        if not os.path.isfile(path):
            continue
        items = parse_task_file(path, strict=True)
        if items is None:
            logger.warning("vault_sync: %s is unreadable; leaving its notes alone", filename)
            continue
        summary["files"] += 1
        if items:
            good_files.add(filename)
        for item in items:
            candidates = index.get((filename, item["heading"], _norm_line(item["line"])))
            existing = candidates.pop(0) if candidates else None
            if existing is None:
                created = notes_service.create_note(
                    text=item["text"],
                    project=item["heading"],
                    vault_source={"file": filename, "line": item["line"], "heading": item["heading"], "vault": tag},
                    completed=item["completed"],
                )
                matched.add(created["id"])
                summary["imported"] += 1
            else:
                matched.add(existing["id"])
                source = existing["vault_source"]
                if source.get("vault") is None:
                    legacy_matched = True
                # A tick made in the vault changes the line: keep the stored
                # original in step so the app's write-back still matches. The
                # vault tag follows the note to wherever its line was found.
                new_source = {k: v for k, v in source.items() if k != "unsynced"}
                new_source.update(line=item["line"], heading=item["heading"], vault=tag)
                if new_source != source:
                    sources[existing["id"]] = new_source
                if existing.get("dismissed"):
                    continue
                changed = {}
                if existing["text"] != item["text"]:
                    changed["text"] = item["text"]
                if existing["project"] != item["heading"]:
                    changed["project"] = item["heading"]
                if existing["completed"] != item["completed"]:
                    changed["completed"] = item["completed"]
                if changed:
                    # write_back=False: the vault already says this, echoing
                    # it back would be a redundant rewrite of the user's file.
                    notes_service.update_note(existing["id"], write_back=False, **changed)
                    summary["updated"] += 1

    # Anything previously imported that's no longer in the vault is gone from
    # the source of truth, so it goes here too, but only with evidence that
    # this is that vault and it was read properly. App-native notes (no
    # vault_source) are never considered. A note from a missing, unreadable or
    # empty file, from a different folder, or (older notes, which don't record
    # their vault) with nothing else matching this vault, is kept and marked
    # unsynced instead: a moved vault, or a setting pointing at an empty folder
    # (which the app seeds with a blank Active Priorities.md), must not wipe
    # them (2026-11-06; it did, in a rehearsal).
    for note in list(notes_service.list_notes(include_dismissed=True)):
        source = note.get("vault_source")
        if not source or note["id"] in matched:
            continue
        own = source.get("vault")
        belongs = own == tag or (own is None and legacy_matched)
        if source.get("file") in good_files and belongs:
            notes_service.delete_note(note["id"])
            summary["removed"] += 1
        elif not source.get("unsynced"):
            sources[note["id"]] = {**source, "unsynced": True}
            summary["unsynced"] += 1
    if sources:
        notes_service.set_vault_sources(sources)

    logger.info(
        "vault_sync: %d imported, %d updated, %d removed, %d unsynced from %d file(s)",
        summary["imported"], summary["updated"], summary["removed"], summary["unsynced"], summary["files"],
    )
    return summary


def write_back_completion(note: dict, completed: bool) -> bool:
    """Flip a single checkbox in the vault file to match the app.

    Deliberately narrow: it finds the one line equal to the imported
    original and rewrites only that line's `[ ]`/`[x]`. Everything else in
    the file — indentation, links, wording, other lines — is preserved
    byte-for-byte. If the line can't be found (the user edited or moved it
    in Obsidian), nothing is written and the next sync_from_vault() will
    reconcile from the vault instead of guessing."""
    source = note.get("vault_source") or {}
    filename, original = source.get("file"), source.get("line")
    if not filename or not original:
        return False

    path = os.path.join(resolve_vault_dir(), filename)
    if not os.path.isfile(path):
        return False

    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            content = f.read()
    except OSError:
        return False

    lines = content.splitlines(keepends=True)
    target_idx = None
    for i, line in enumerate(lines):
        if line.rstrip("\r\n") == original:
            target_idx = i
            break
    if target_idx is None:
        logger.info("vault_sync: source line no longer present, skipping write-back")
        return False

    line = lines[target_idx]
    new_box = "[x]" if completed else "[ ]"
    updated = re.sub(r"\[[ xX]\]", new_box, line, count=1)
    if updated == line:
        return False
    lines[target_idx] = updated

    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.writelines(lines)
    except OSError:
        logger.exception("vault_sync: couldn't write back to %s", filename)
        return False

    # Keep the stored original in step, so a later toggle still matches.
    source["line"] = updated.rstrip("\r\n")
    notes_service.update_note(note["id"], write_back=False, vault_source=source)
    logger.info("vault_sync: wrote %s back to %s", new_box, filename)
    return True


def _norm_line(line: str) -> str:
    return _BOX_RE.sub("[ ]", line, count=1)


def _note_key(note: dict) -> tuple:
    source = note["vault_source"]
    # Notes imported before the heading was stored carry it as their project.
    return (source.get("file"), source.get("heading", note["project"]), _norm_line(source.get("line") or ""))


def sync_on_startup() -> None:
    """Called once from app.py's lifespan, for every account: each one's own
    vault into its own notes. Never raises: a malformed or unreadable vault
    must not stop the app from booting."""
    from core import accounts
    for account_id in accounts.all_accounts():
        try:
            with accounts.as_account(account_id):
                sync_from_vault()
        except Exception:
            logger.exception("vault_sync: startup sync failed for account %s", account_id)
