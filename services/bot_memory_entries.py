"""Notebook entries (Bots Phase 2, unit U1; phase-2-design.md section 3.2).

Pure text work, no disk. An entry is one bullet in a notebook document, under a `## Section`:

    - YYYY-MM-DD · from <source> · <text>[ · until YYYY-MM-DD]          (new grammar)
    - ~~YYYY-MM-DD · from <source> · <text>~~ · superseded YYYY-MM-DD   (superseded, kept struck through)
    - YYYY-MM-DD[ (until YYYY-MM-DD)]: <text>                           (legacy grammar, read as it is)

Both grammars are understood everywhere. A new entry may carry up to 20 lines (continuation lines
start with two spaces); legacy entries are one line. Anything that is not an entry (headings, the
person's own sentences, undated bullets) is never touched by an automatic change.

Actions: append, replace, remove, supersede. Expiry follows the local date: an `until` date at or
before today is expired. Make-room moves old entries to the archive but never a protected one
(safety and health facts) and never unclassified text; when that is not enough it raises
CapacityConflict and the document stays as it was.
"""
import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Callable, Optional

from services.bot_memory_store import CapacityConflict, NotebookError

ENTRY_CHARS = 1000
ENTRY_LINES = 20
SECTION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 &'/_-]{0,59}")
DEFAULT_SECTION = "Notes"
SOURCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}")
ACTIONS = ("append", "replace", "remove", "supersede")

_LEGACY = re.compile(r"^\s*-\s+(\d{4}-\d{2}-\d{2})(?:\s+([^:]*))?\s*:\s*(.*)$")
_NEW = re.compile(r"^-\s+(\d{4}-\d{2}-\d{2}) · from ([^·\n]{1,40}?) · (.*)$", re.DOTALL)
_STRUCK = re.compile(r"^-\s+~~(\d{4}-\d{2}-\d{2}) · from ([^·\n]{1,40}?) · (.*?)~~ · superseded (\d{4}-\d{2}-\d{2})$", re.DOTALL)
_UNTIL = re.compile(r"^(.*) · until (\d{4}-\d{2}-\d{2})$", re.DOTALL)
_PROTECTED = re.compile(
    r"\b(allerg\w*|anaphyla\w*|epipen|medicat\w*|medicine|prescription|diagnos\w*|diabet\w*|asthma\w*|seizure\w*|"
    r"health\w*|medical\w*|surgery|pregnan\w*|disabilit\w*|blood type|blood pressure|emergency contact|"
    r"safety|unsafe|do not call|self-harm|suicid\w*)\b", re.IGNORECASE)
_PROTECTED_SECTIONS = {"safety", "health"}


def local_today(now: Optional[float] = None) -> date:
    """The owner's local date (Kairos runs on the owner's machine, so this is the configured local day)."""
    return datetime.fromtimestamp(now).date() if now is not None else datetime.now().date()


def _day(value: str) -> Optional[date]:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


@dataclass
class Entry:
    start: int
    end: int                    # exclusive line index
    section: str
    learned: date
    source: str
    text: str
    until: Optional[date]
    superseded: Optional[date]
    legacy: bool
    raw: str
    eid: str = ""

    def expired(self, today: date) -> bool:
        return self.superseded is not None or (self.until is not None and self.until <= today)

    def protected(self) -> bool:
        return self.section.strip().lower() in _PROTECTED_SECTIONS or is_protected_text(self.text)


def is_protected_text(text: str) -> bool:
    """Safety and health facts: automatic filing keeps them in the index and make-room never moves them."""
    return bool(_PROTECTED.search(text or ""))


@dataclass
class Doc:
    lines: list = field(default_factory=list)
    entries: list = field(default_factory=list)


def parse_line(line: str):
    """One entry line in either grammar as (learned, until, text, source, superseded, legacy), or None."""
    body = line.rstrip("\r\n")
    struck = _STRUCK.match(body)
    if struck and _day(struck[1]) and _day(struck[4]):
        return _day(struck[1]), None, struck[3].strip(), struck[2].strip(), _day(struck[4]), False
    fresh = _NEW.match(body)
    if fresh and _day(fresh[1]):
        text, until = fresh[3], None
        tail = _UNTIL.match(text)
        if tail and _day(tail[2]):
            text, until = tail[1], _day(tail[2])
        return _day(fresh[1]), until, text.strip(), fresh[2].strip(), None, False
    old = _LEGACY.fullmatch(body)
    if old and _day(old[1]):
        until = None
        meta = re.fullmatch(r"\(\s*until\s+(.*?)\s*\)", (old[2] or "").strip(), re.IGNORECASE)
        if meta:
            until = _day(meta[1])   # a typo must not hide the person's note: it stays permanent
        return _day(old[1]), until, old[3].strip(), "legacy", None, True
    return None


def legacy_tuple(line: str):
    """(learned, expires, body) for services/agent_service._memory_entry. A superseded entry reads as expired
    on its superseded day, so every prompt surface and tidy pass drops it."""
    parsed = parse_line(line)
    if not parsed:
        return None
    learned, until, text, _, superseded, _ = parsed
    return learned, (superseded or until), text


def parse(text: str) -> Doc:
    lines = text.splitlines(keepends=True)
    doc = Doc(lines=lines)
    section, index, seen = "", 0, {}
    while index < len(lines):
        line = lines[index]
        if line.startswith("## "):
            section = line[3:].strip()
            index += 1
            continue
        parsed = parse_line(line)
        if not parsed:
            index += 1
            continue
        learned, until, body, source, superseded, legacy = parsed
        end = index + 1
        if not legacy:
            # Continuation lines belong to a new-grammar entry: two leading spaces, not blank.
            while end < len(lines) and lines[end].startswith("  ") and end - index < ENTRY_LINES:
                end += 1
            if end > index + 1 and not superseded:
                joined = "".join(lines[index:end])
                again = parse_line_multiline(joined)
                if again:
                    learned, until, body, source = again
        raw = "".join(lines[index:end])
        base = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
        seen[base] = seen.get(base, 0) + 1
        eid = base if seen[base] == 1 else f"{base}-{seen[base]}"
        doc.entries.append(Entry(index, end, section, learned, source, body, until, superseded, legacy, raw, eid))
        index = end
    return doc


def parse_line_multiline(raw: str):
    fresh = _NEW.match(raw.rstrip("\r\n"))
    if not fresh or not _day(fresh[1]):
        return None
    text, until = fresh[3], None
    tail = _UNTIL.match(text)
    if tail and _day(tail[2]):
        text, until = tail[1], _day(tail[2])
    body = "\n".join(part[2:] if part.startswith("  ") else part for part in text.split("\n"))
    return _day(fresh[1]), until, body.strip(), fresh[2].strip()


# -- building entries ---------------------------------------------------------------------------------------------
def clean_text(text) -> str:
    """A bounded entry body: no control characters but newlines, 1,000 characters, 20 lines, never starting
    like a heading, so an entry cannot forge structure."""
    if not isinstance(text, str):
        raise NotebookError("an entry needs text")
    body = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not body:
        raise NotebookError("there is nothing to remember")
    if len(body) > ENTRY_CHARS:
        raise NotebookError(f"this entry exceeds the {ENTRY_CHARS:,}-character limit")
    rows = [row.rstrip() for row in body.split("\n")]
    if len(rows) > ENTRY_LINES:
        raise NotebookError(f"an entry is limited to {ENTRY_LINES} lines")
    return "\n".join(rows)


def clean_source(source) -> str:
    source = " ".join(str(source or "").split())
    return source if SOURCE_RE.fullmatch(source) else "unknown"


def clean_section(section) -> str:
    name = " ".join(str(section or DEFAULT_SECTION).split())
    if not SECTION_RE.fullmatch(name):
        raise NotebookError("a section name uses letters, numbers and simple punctuation (60 characters at most)")
    return name


def clean_until(until) -> Optional[date]:
    if until in (None, ""):
        return None
    if isinstance(until, date):
        return until
    parsed = _day(str(until))
    if parsed is None:
        raise NotebookError("expiry must be a date in YYYY-MM-DD format")
    return parsed


def format_entry(learned: date, source: str, text: str, until: Optional[date] = None) -> list:
    rows = text.split("\n")
    first = f"- {learned.isoformat()} · from {source} · {rows[0]}"
    tail = f" · until {until.isoformat()}" if until else ""
    if len(rows) == 1:
        return [first + tail + "\n"]
    return [first + "\n", *[("  " + row if row else "  ") + "\n" for row in rows[1:-1]], "  " + rows[-1] + tail + "\n"]


def _struck(entry: Entry, today: date) -> list:
    body = " ".join(entry.text.split())
    return [f"- ~~{entry.learned.isoformat()} · from {entry.source} · {body}~~ · superseded {today.isoformat()}\n"]


def _ensure_newline(lines: list) -> list:
    if lines and not lines[-1].endswith(("\n", "\r")):
        lines[-1] += "\n"
    return lines


def _section_end(lines: list, section: str):
    """Index after a section's last entry (before its blank gap), or None when the heading is absent."""
    heading = f"## {section}"
    top = next((i for i, value in enumerate(lines) if value.rstrip("\r\n") == heading), None)
    if top is None:
        return None
    end = top + 1
    while end < len(lines) and not lines[end].startswith("## "):
        end += 1
    while end > top + 1 and not lines[end - 1].strip():
        end -= 1
    return end


def _insert(lines: list, section: str, block: list, after: Optional[int] = None) -> tuple[list, int]:
    """Put a block in a section (made at the end when missing). Returns the lines and the block's start index."""
    lines = _ensure_newline(list(lines))
    if after is not None:
        lines[after:after] = block
        return lines, after
    end = _section_end(lines, section)
    if end is None:
        lines += ["\n"] if lines and lines[-1].strip() else []
        lines += [f"## {section}\n"]
        end = len(lines)
    lines[end:end] = block
    return lines, end


# -- make room ----------------------------------------------------------------------------------------------------
Fits = Callable[[str], bool]


def make_room(lines: list, keep: set, fits: Fits, today: date, exact: Optional[tuple] = None):
    """Archive old entries until the document fits. `keep` holds start indices that must stay (the new
    entry). `exact` is (section, text): an exact repeat in the same section goes first, then expired or
    superseded entries, then the oldest. Protected entries and non-entry text never go.
    Returns (lines, displaced) with displaced as (section, raw) pairs, or raises CapacityConflict."""
    lines = list(lines)
    displaced = []
    for _ in range(5000):
        if fits("".join(lines)):
            return lines, displaced
        doc = parse("".join(lines))
        marks = {i for i in keep}
        candidates = []
        for entry in doc.entries:
            if entry.start in marks or entry.protected():
                continue
            if exact and entry.section == exact[0] and entry.text == exact[1] and entry.superseded is None:
                priority = 0
            elif entry.expired(today):
                priority = 1
            else:
                priority = 2
            candidates.append((priority, entry.learned, entry.start, entry))
        if not candidates:
            raise CapacityConflict("memory cannot fit this entry without removing hand-written text or headings; "
                                   "make room in the agent's Memory box", {})
        chosen = min(candidates, key=lambda item: item[:3])[3]
        displaced.append((chosen.section, chosen.raw if chosen.raw.endswith("\n") else chosen.raw + "\n"))
        removed = chosen.end - chosen.start
        lines = lines[:chosen.start] + lines[chosen.end:]
        keep = {i - removed if i > chosen.start else i for i in keep}
    raise CapacityConflict("memory could not be made to fit", {})


def archive_block(displaced: list, today: date, label: str = "") -> str:
    """The text appended to the archive for displaced entries."""
    heading = f"\n## Archived {today.isoformat()}{label}\n"
    return heading + "".join(f"\n### {section or 'Unsectioned'}\n{raw}" for section, raw in displaced)


# -- actions ------------------------------------------------------------------------------------------------------
def entry_by_id(doc: Doc, eid: str) -> Entry:
    found = next((e for e in doc.entries if e.eid == eid), None)
    if found is None:
        raise NotebookError("that note is not in the document any more; reload it")
    return found


def apply_action(text: str, action: str, *, fits: Fits, today: date, section: Optional[str] = None,
                 body: Optional[str] = None, source: str = "owner", until=None, target: Optional[str] = None):
    """One entry action on a document. Returns (new_text, displaced, summary) where displaced lists the
    (section, raw) entries that make-room moved to the archive. Nothing is written."""
    if action not in ACTIONS:
        raise NotebookError(f"action must be one of: {', '.join(ACTIONS)}")
    lines = text.splitlines(keepends=True)
    expiry = clean_until(until)
    source = clean_source(source)
    if action == "append":
        body = clean_text(body)
        section = clean_section(section)
        block = format_entry(today, source, body, expiry)
        lines, start = _insert(lines, section, block)
        lines, displaced = make_room(lines, {start}, fits, today, exact=(section, body))
        return "".join(lines), displaced, f"Added a note to {section}"
    doc = parse(text)
    entry = entry_by_id(doc, target or "")
    if action == "remove":
        lines = lines[:entry.start] + lines[entry.end:]
        return "".join(lines), [], "Removed a note"
    body = clean_text(body)
    if action == "replace":
        block = format_entry(today, source, body, expiry)
        lines = lines[:entry.start] + block + lines[entry.end:]
        rebuilt = "".join(lines)
        if not fits(rebuilt):
            lines, displaced = make_room(lines, {entry.start}, fits, today)
            return "".join(lines), displaced, "Changed a note"
        return rebuilt, [], "Changed a note"
    # supersede: the old entry stays, struck through, and the new one follows it.
    if entry.superseded is not None:
        raise NotebookError("that note was already replaced")
    block = _struck(entry, today) + format_entry(today, source, body, expiry)
    lines = lines[:entry.start] + block + lines[entry.end:]
    new_start = entry.start + 1
    lines, displaced = make_room(lines, {new_start, entry.start}, fits, today)
    return "".join(lines), displaced, "Replaced a note"
