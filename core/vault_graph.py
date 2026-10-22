"""Vault graph, note reads and the Library's safe save.

First built 2026-09-01 as a port of the original kiosk's /vault-graph and
/vault-note ("kind of similar to the VAULT tab in our original jarvis
kiosk"), using core/vault.py's resolve_vault_dir() since the vault location
is user-configurable.

Library Vault Polish (locked spec, 2026-10-22) made this the one place links
are resolved, so Browse, Map and the phone page never guess:

- Two edge kinds: "contains" (folder -> direct child) and "link" (note ->
  note). Wikilinks resolve the way Obsidian does: exact vault path first,
  then a path suffix, then the note's basename. `[[Note|alias]]`,
  `[[Note#heading]]` and `![[embed]]` all count. Links to attachments
  (`![[image.png]]`) are not note links. Unresolved targets come back in
  `missing`.
- Note nodes carry `mtime`, `size`, `words`, a `daily` flag and a capped
  `frontmatter` read with a strict YAML subset that never fails the walk.
- The graph is cached, keyed by every note's path, mtime and size, so
  opening a note does not re-read the whole vault.
- Saves are version-checked (409 on an outside edit), keep the file's line
  endings and BOM, are written atomically, and are recorded as a checkpoint
  before the write so they show in History and can be restored.
"""
import hashlib
import os
import re
import tempfile
import threading
from datetime import datetime
from typing import Optional

from core.vault import resolve_vault_dir

_WIKILINK_RE = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
_FENCE_RE = re.compile(r"^(```|~~~)[^\n]*\n.*?^\1[^\n]*$", re.M | re.S)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_DAILY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SKIP_DIRS = {".obsidian", ".trash", ".git"}
_BOM = b"\xef\xbb\xbf"
# Wikilink targets with these extensions are attachments, not notes.
_ATTACHMENT_EXT = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "pdf", "mp3", "mp4", "m4a",
                   "wav", "ogg", "webm", "mov", "canvas", "base", "zip", "csv", "xlsx", "docx", "pptx"}
# Frontmatter sent per node: these keys, plus up to 8 other short ones.
_FRONTMATTER_KEYS = ("status", "project", "type", "tags")
_FRONTMATTER_EXTRA = 8
_VALUE_MAX = 120
_LIST_MAX = 10

_cache_lock = threading.Lock()
_cache: dict = {"key": None, "graph": None}
_write_lock = threading.Lock()


class VersionConflict(Exception):
    """The note changed on disk since the editor opened it."""

    def __init__(self, current: Optional[str]):
        super().__init__("This note changed since you opened it.")
        self.current = current


class PropertiesRemoved(Exception):
    """A save would drop the note's frontmatter block without confirmation."""


def _vault_real_path(rel_path: str) -> Optional[str]:
    """Resolves a vault-relative path and confirms the result is still
    inside the vault root — blocks ../ traversal and absolute-path tricks
    regardless of how os.path.join handles a leading slash, since the
    startswith check below is what actually decides, not the join."""
    if not isinstance(rel_path, str) or not rel_path or "\0" in rel_path:
        return None
    vault_root = resolve_vault_dir()
    candidate = os.path.realpath(os.path.join(vault_root, rel_path))
    root = os.path.realpath(vault_root)
    if candidate != root and not candidate.startswith(root + os.sep):
        return None
    return candidate


# -- frontmatter -----------------------------------------------------------

def split_frontmatter(text: str) -> tuple[Optional[str], str]:
    """(frontmatter block or None, body). The block must open on the first
    line with `---` and close with `---` or `...`."""
    if text.startswith("﻿"):
        text = text[1:]
    match = re.match(r"---[ \t]*\r?\n(.*?)(?:\r?\n)?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)", text, re.S | re.M)
    if not match:
        return None, text
    return match.group(1), text[match.end():]


def _scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value[:_VALUE_MAX]


def parse_frontmatter(block: Optional[str]) -> dict:
    """A strict YAML subset: `key: scalar`, `key: [a, b]` and block lists
    (`key:` then `  - item`). Anything else (maps, anchors, multi-line
    strings) is skipped, never raised, so one odd note can't fail the walk."""
    result: dict = {}
    if not block:
        return result
    current_list: Optional[list] = None
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"^\s+-\s*(.*)$", line) or re.match(r"^-\s+(.*)$", line)
        if item and current_list is not None:
            if len(current_list) < _LIST_MAX and item.group(1).strip():
                current_list.append(_scalar(item.group(1)))
            continue
        pair = re.match(r"^([A-Za-z0-9_][\w .-]{0,40}):(?:\s+(.*))?$", line)
        if not pair:
            current_list = None
            continue
        key, value = pair.group(1).strip(), (pair.group(2) or "").strip()
        if not value:
            current_list = result[key] = []
            continue
        current_list = None
        if value.startswith("[") and value.endswith("]"):
            result[key] = [_scalar(v) for v in value[1:-1].split(",") if v.strip()][:_LIST_MAX]
        elif value[0] in "|>{&*!":
            continue
        else:
            result[key] = _scalar(value)
    return {k: v for k, v in result.items() if v != []}


def _capped_frontmatter(full: dict) -> dict:
    out = {k: full[k] for k in _FRONTMATTER_KEYS if k in full}
    extra = 0
    for key, value in full.items():
        if key in out or extra >= _FRONTMATTER_EXTRA:
            continue
        if isinstance(value, str) and len(value) <= 80 or isinstance(value, list) and len(value) <= 5:
            out[key] = value
            extra += 1
    return out


# -- link resolution -------------------------------------------------------

def _link_text(text: str) -> str:
    """Note text with code removed, so `[[x]]` in a code sample isn't a link."""
    return _INLINE_CODE_RE.sub("", _FENCE_RE.sub("", text))


def parse_wikilink(inner: str) -> tuple[str, str, str]:
    """`Folder/Note#Heading|Alias` -> (target, heading, alias)."""
    target, _, alias = inner.partition("|")
    target, _, heading = target.partition("#")
    return target.strip().replace("\\", "/").lstrip("/"), heading.strip(), alias.strip()


class LinkIndex:
    def __init__(self, note_ids: list[str]):
        self.by_path: dict[str, str] = {}
        self.by_name: dict[str, str] = {}
        # Shallowest, then alphabetical, wins a basename tie (as Obsidian
        # prefers the note nearest the root).
        for note_id in sorted(note_ids, key=lambda p: (p.count("/"), p.lower())):
            stem_path = note_id[:-3].lower()
            self.by_path.setdefault(stem_path, note_id)
            self.by_name.setdefault(stem_path.rsplit("/", 1)[-1], note_id)
        self.paths = sorted(self.by_path.items(), key=lambda kv: (kv[1].count("/"), kv[0]))

    def resolve(self, target: str) -> tuple[str, Optional[str]]:
        """("note", id) when it resolves, ("missing", None) when it doesn't,
        ("attachment", None) for a non-note target and ("self", None) for a
        heading-only link."""
        if not target:
            return "self", None
        lower = target.lower()
        if lower.endswith(".md"):
            lower = lower[:-3]
        else:
            ext = lower.rsplit("/", 1)[-1].rpartition(".")[2]
            if "." in lower.rsplit("/", 1)[-1] and ext in _ATTACHMENT_EXT:
                return "attachment", None
        if lower in self.by_path:
            return "note", self.by_path[lower]
        if "/" in lower:
            for stem_path, note_id in self.paths:
                if stem_path.endswith("/" + lower):
                    return "note", note_id
            lower = lower.rsplit("/", 1)[-1]
        if lower in self.by_name:
            return "note", self.by_name[lower]
        return "missing", None


# -- the graph ---------------------------------------------------------------

def _walk(vault_root: str) -> tuple[list[str], list[tuple[str, str, int, int]]]:
    folders: list[str] = []
    notes: list[tuple[str, str, int, int]] = []
    for dirpath, dirnames, filenames in os.walk(vault_root):
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIRS and not d.startswith("."))
        rel_dir = os.path.relpath(dirpath, vault_root)
        dir_id = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        folders.append(dir_id)
        for fname in sorted(filenames):
            if not fname.lower().endswith(".md") or fname.startswith("."):
                continue
            try:
                stat = os.stat(os.path.join(dirpath, fname))
            except OSError:
                continue
            notes.append((dir_id, fname, stat.st_mtime_ns, stat.st_size))
    return folders, notes


def build_vault_graph() -> dict:
    vault_root = os.path.realpath(resolve_vault_dir())
    folders, notes = _walk(vault_root)
    key = (vault_root, tuple(folders), tuple(notes))
    with _cache_lock:
        if _cache["key"] == key:
            return _cache["graph"]
    graph = _build(vault_root, folders, notes)
    with _cache_lock:
        _cache.update(key=key, graph=graph)
    return graph


def _build(vault_root: str, folders: list[str], notes: list[tuple[str, str, int, int]]) -> dict:
    nodes: list[dict] = []
    edges: list[dict] = []
    for dir_id in folders:
        nodes.append({"id": dir_id, "type": "folder", "name": "Vault" if dir_id == "" else dir_id.rsplit("/", 1)[-1]})
        if dir_id:
            parent = dir_id.rsplit("/", 1)[0] if "/" in dir_id else ""
            edges.append({"source": parent, "target": dir_id, "kind": "contains"})
    note_nodes = []
    for dir_id, fname, mtime_ns, size in notes:
        rel_path = fname if dir_id == "" else f"{dir_id}/{fname}"
        stem = fname[:-3]
        node = {"id": rel_path, "type": "note", "name": stem, "folder": dir_id,
                "mtime": round(mtime_ns / 1e9, 3), "size": size, "daily": bool(_DAILY_RE.match(stem))}
        nodes.append(node)
        note_nodes.append(node)
        edges.append({"source": dir_id, "target": rel_path, "kind": "contains"})

    index = LinkIndex([n["id"] for n in note_nodes])
    seen_links, seen_missing, missing = set(), set(), []
    for node in note_nodes:
        try:
            with open(os.path.join(vault_root, node["id"]), "r", encoding="utf-8-sig", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        block, body = split_frontmatter(text)
        frontmatter = _capped_frontmatter(parse_frontmatter(block))
        if frontmatter:
            node["frontmatter"] = frontmatter
        node["has_frontmatter"] = block is not None
        node["words"] = len(body.split())
        for match in _WIKILINK_RE.finditer(_link_text(text)):
            target, _, _ = parse_wikilink(match.group(2))
            kind, target_id = index.resolve(target)
            if kind == "missing":
                key = (node["id"], target.lower())
                if key not in seen_missing:
                    seen_missing.add(key)
                    missing.append({"source": node["id"], "target": target})
                continue
            if kind != "note" or target_id == node["id"]:
                continue
            key = (node["id"], target_id)
            if key in seen_links:
                continue
            seen_links.add(key)
            edges.append({"source": node["id"], "target": target_id, "kind": "link"})
    return {"nodes": nodes, "edges": edges, "missing": missing}


def resolve_links(text: str) -> list[dict]:
    """Every wikilink in one note's text, resolved against the current graph:
    {raw, target, heading, alias, embed, id or None, kind}. The reader uses
    this so links in the body follow the same rules as the graph."""
    graph = build_vault_graph()
    index = LinkIndex([n["id"] for n in graph["nodes"] if n["type"] == "note"])
    out, seen = [], set()
    for match in _WIKILINK_RE.finditer(_link_text(text)):
        raw = match.group(2)
        if raw in seen:
            continue
        seen.add(raw)
        target, heading, alias = parse_wikilink(raw)
        kind, target_id = index.resolve(target)
        out.append({"raw": raw, "target": target, "heading": heading, "alias": alias,
                    "embed": match.group(1) == "!", "kind": kind, "id": target_id})
    return out


# -- reading and writing ------------------------------------------------------

def _version(raw: bytes) -> str:
    return hashlib.sha1(raw).hexdigest()


def _line_ending(raw: bytes) -> str:
    crlf = raw.count(b"\r\n")
    return "\r\n" if crlf and crlf >= raw.count(b"\n") - crlf else "\n"


def read_vault_note(rel_path: str) -> Optional[str]:
    """The note's text (kept for callers that only want the content)."""
    note = read_vault_note_full(rel_path)
    return note["content"] if note else None


def read_vault_note_full(rel_path: str) -> Optional[dict]:
    """The note for the reader and editor. `content` has LF line endings and
    no BOM; `version` is the SHA-1 of the bytes on disk, sent back on save.
    A note that isn't valid UTF-8 reads with replacement characters and is
    not editable, so a save can never corrupt it."""
    real = _vault_real_path(rel_path)
    if not real or not real.lower().endswith(".md") or not os.path.isfile(real):
        return None
    try:
        with open(real, "rb") as f:
            raw = f.read()
        stat = os.stat(real)
    except OSError:
        return None
    body = raw[3:] if raw.startswith(_BOM) else raw
    try:
        text, editable = body.decode("utf-8"), True
    except UnicodeDecodeError:
        text, editable = body.decode("utf-8", errors="replace"), False
    return {"path": rel_path.replace("\\", "/"), "content": text.replace("\r\n", "\n"), "version": _version(raw),
            "mtime": stat.st_mtime, "size": stat.st_size, "editable": editable,
            "line_ending": "crlf" if _line_ending(raw) == "\r\n" else "lf", "bom": raw.startswith(_BOM)}


def _encode_like(raw: bytes, content: str) -> bytes:
    """`content` encoded with the file's own line endings and BOM, so a save
    in the Library is not a whole-file change to Obsidian or git."""
    text = content.replace("\r\n", "\n")
    if _line_ending(raw) == "\r\n":
        text = text.replace("\n", "\r\n")
    return (_BOM if raw.startswith(_BOM) else b"") + text.encode("utf-8")


def _atomic_write(path: str, data: bytes) -> None:
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".kairos-save-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def save_vault_note(rel_path: str, content: str, version: str, user: str,
                    allow_remove_properties: bool = False) -> Optional[dict]:
    """Overwrites an EXISTING note only, never creates one (the kiosk's
    deliberate restriction), and only if it still matches `version`.
    Returns the new read, or None when there is no such note."""
    from core import file_checkpoints

    real = _vault_real_path(rel_path)
    if not real or not real.lower().endswith(".md") or not os.path.isfile(real):
        return None
    if not isinstance(content, str) or not isinstance(version, str):
        raise ValueError("content and version are required")
    with _write_lock:
        with open(real, "rb") as f:
            raw = f.read()
        if _version(raw) != version:
            raise VersionConflict(_version(raw))
        try:
            old_text = (raw[3:] if raw.startswith(_BOM) else raw).decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("This note is not UTF-8 text, so it can't be edited here.")
        if split_frontmatter(old_text)[0] is not None and split_frontmatter(content)[0] is None and not allow_remove_properties:
            raise PropertiesRemoved("This save would remove the note's properties block.")
        data = _encode_like(raw, content)
        if data != raw:
            def write():
                # A last look, as close to the replace as possible: an editor
                # that saved in the meantime wins, and this save is refused.
                with open(real, "rb") as f:
                    if _version(f.read()) != version:
                        raise VersionConflict(None)
                _atomic_write(real, data)
            vault_root = os.path.realpath(resolve_vault_dir())
            name = os.path.relpath(real, vault_root).replace(os.sep, "/")
            try:
                file_checkpoints.record_file_write(f"library:{user}", vault_root, name, raw, data, write)
            except VersionConflict:
                with open(real, "rb") as f:
                    raise VersionConflict(_version(f.read()))
    return read_vault_note_full(rel_path)


def write_vault_note(rel_path: str, content: str) -> bool:
    """Unversioned overwrite, kept for internal callers. Still atomic and
    still keeps line endings and BOM. The Library uses save_vault_note."""
    real = _vault_real_path(rel_path)
    if not real or not real.lower().endswith(".md") or not os.path.isfile(real):
        return False
    with _write_lock:
        with open(real, "rb") as f:
            raw = f.read()
        _atomic_write(real, _encode_like(raw, content))
    return True


# -- today's note ----------------------------------------------------------------

def daily_note_target(vault_root: str, folder: str, today: datetime) -> str:
    """Where today's note goes: the daily folder, or the current month's
    `NN - Month YYYY` subfolder when the folder already uses monthly ones."""
    base = os.path.join(vault_root, folder)
    month = f"{today.month:02d} - {today.strftime('%B')} {today.year}"
    try:
        has_months = any(re.match(r"^\d{2} - [A-Za-z]+ \d{4}$", d) and os.path.isdir(os.path.join(base, d))
                         for d in os.listdir(base))
    except OSError:
        has_months = False
    name = today.strftime("%Y-%m-%d") + ".md"
    return f"{folder}/{month}/{name}" if has_months else f"{folder}/{name}"


def fill_template(template: str, today: datetime) -> str:
    """Fills the date the template expects: Obsidian's core-template tokens
    ({{date}}, {{date:FORMAT}}, {{title}}) and Templater's tp.date.now(),
    each with today's date."""
    iso = today.strftime("%Y-%m-%d")

    def moment(fmt: str) -> str:
        table = [("YYYY", "%Y"), ("MMMM", "%B"), ("MMM", "%b"), ("MM", "%m"), ("DD", "%d"), ("dddd", "%A"), ("ddd", "%a")]
        out = fmt
        for token, code in table:
            out = out.replace(token, today.strftime(code))
        return out

    # The vault's own template (2026-10-22) heads the note with
    # "{{Day of week}}, {{Month}} {{Day}}, {{Year}}".
    words = {"day of week": today.strftime("%A"), "weekday": today.strftime("%A"), "month": today.strftime("%B"),
             "day": str(today.day), "year": str(today.year)}
    text = re.sub(r"\{\{\s*(day of week|weekday|month|day|year)\s*\}\}", lambda m: words[m.group(1).lower()], template, flags=re.I)
    text = re.sub(r"\{\{\s*date:([^}]+)\}\}", lambda m: moment(m.group(1).strip()), text)
    text = re.sub(r"\{\{\s*(date|title)\s*\}\}", iso, text)
    text = re.sub(r"<%\s*tp\.date\.now\(\s*(?:\"([^\"]*)\"|'([^']*)')?\s*\)\s*%>",
                  lambda m: moment(m.group(1) or m.group(2)) if (m.group(1) or m.group(2)) else iso, text)
    text = re.sub(r"<%\s*tp\.file\.title\s*%>", iso, text)
    return text


def create_daily_note(template_path: str, folder: str, today: datetime, user: str) -> tuple[str, bool]:
    """(path, created). Copies the template to today's note, or returns the
    existing note's path with created=False. Never overwrites."""
    vault_root = os.path.realpath(resolve_vault_dir())
    template_real = _vault_real_path(template_path)
    if not template_real or not os.path.isfile(template_real):
        raise FileNotFoundError(f"The daily note template was not found: {template_path}")
    folder_real = _vault_real_path(folder)
    if not folder_real or not os.path.isdir(folder_real):
        raise FileNotFoundError(f"The daily notes folder was not found: {folder}")
    rel = daily_note_target(vault_root, folder.strip("/"), today)
    real = _vault_real_path(rel)
    if not real:
        raise ValueError("Invalid daily note path")
    with open(template_real, "rb") as f:
        raw = f.read()
    text = (raw[3:] if raw.startswith(_BOM) else raw).decode("utf-8")
    data = _encode_like(raw, fill_template(text.replace("\r\n", "\n"), today))
    from core import file_checkpoints

    def write():
        os.makedirs(os.path.dirname(real), exist_ok=True)
        # O_EXCL: if anything created the file since the check, this fails
        # instead of overwriting it.
        fd = os.open(real, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0))
        with os.fdopen(fd, "wb") as f:
            f.write(data)

    with _write_lock:
        if os.path.exists(real):
            return rel, False
        try:
            file_checkpoints.record_file_write(f"library:{user}", vault_root, rel, None, data, write)
        except FileExistsError:
            return rel, False
    return rel, True


def index_proposal(folder: str, note_path: str) -> Optional[dict]:
    """The one line today's note would add to its folder's index note
    (`<Folder Name>.md`), for the Library to show as a diff and apply only
    on a click. None when there is no index or it already links the note."""
    index_path = f"{folder.strip('/')}/{folder.strip('/').rsplit('/', 1)[-1]}.md"
    index = read_vault_note_full(index_path)
    if not index or not index["editable"]:
        return None
    stem = note_path.rsplit("/", 1)[-1][:-3]
    if re.search(r"\[\[(?:[^\]|#]*/)?" + re.escape(stem) + r"(?:[#|][^\]]*)?\]\]", index["content"]):
        return None
    line = f"- [[{stem}]]: daily session log."
    lines = index["content"].split("\n")
    dated = [i for i, text in enumerate(lines) if re.match(r"^- \[\[\d{4}-\d{2}-\d{2}", text)]
    at = dated[-1] + 1 if dated else len(lines) - (1 if lines and lines[-1] == "" else 0)
    content = "\n".join(lines[:at] + [line] + lines[at:])
    return {"path": index_path, "version": index["version"], "line": line, "after": lines[at - 1] if at else "", "content": content}
