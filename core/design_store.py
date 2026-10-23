"""Designs on disk: the manifest, boards, assets, the version log and comments
(Design Canvas spec 3a, 3e, 3f).

    DATA_DIR/designs/<id>/
        design.json           the manifest
        boards/<slug>.html    one normalised board each
        assets/<sha256>.<ext> images, content-addressed
        versions/<n>.json     one log entry per change
        versions/files/<n>/<slug>.html   the boards that version changed (copy on write)
        comments.json         pinned comments
        thumbs/<slug>.png     cached board thumbnails (render worker)

Every change goes through change(): it applies an edit to a copy, writes the
changed boards, logs a version with only the changed board files, marks the
comments whose elements changed as addressed, and announces design_changed on
the live chat feed. A failed edit changes nothing.

Who may change what: a chat may change a design only when its id is in the
design's chat_ids (it made the design, or the owner attached it), the same
rule chat_artifacts.resolve applies to files. People reach designs they own,
or any design as an admin; shared designs list their viewers in visible_to.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from core import design_formats, design_html, design_systems
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

DESIGNS_DIR = os.path.join(DATA_DIR, "designs")
MAX_BOARDS = 60
MAX_ASSET_BYTES = 25 * 1024 * 1024
MAX_VERSIONS = 300
MAX_HISTORY_BYTES = 200 * 1024 * 1024
MAX_NOTES = 100
MAX_COMMENTS = 500
DESIGN_ID = re.compile(r"[a-f0-9]{12}")
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
FRAMES = {"phone": (390, 844), "tablet": (820, 1180), "desktop": (1440, 900), "browser": (1440, 900),
          "slide": (1920, 1080), "none": (800, 600)}
ASSET_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
               "webp": "image/webp"}
GAP = 120

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()
_listeners: list[Callable[[dict], None]] = []
_session_state_lock = threading.Lock()


class AccessError(PermissionError):
    pass


def _lock(design_id: str) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(design_id, threading.RLock())


def on_change(listener: Callable[[dict], None]) -> None:
    _listeners.append(listener)


def _folder(design_id: str) -> Path:
    if not isinstance(design_id, str) or not DESIGN_ID.fullmatch(design_id):
        raise LookupError("No such design.")
    return Path(DESIGNS_DIR, design_id)


def _now() -> float:
    return round(time.time(), 3)


# -- reading ---------------------------------------------------------------------

def exists(design_id: str) -> bool:
    try:
        return (_folder(design_id) / "design.json").is_file()
    except LookupError:
        return False


def manifest(design_id: str) -> dict:
    data = read_json(str(_folder(design_id) / "design.json"), None)
    if not isinstance(data, dict):
        raise LookupError("No such design.")
    return data


def board_html(design_id: str, slug: str) -> str:
    if not SLUG.fullmatch(slug or ""):
        raise LookupError(f"No board `{slug}`.")
    path = _folder(design_id) / "boards" / f"{slug}.html"
    if not path.is_file():
        raise LookupError(f"No board `{slug}`.")
    return path.read_text(encoding="utf-8")


def ordered_boards(data: dict) -> list[tuple[str, dict]]:
    return sorted(data.get("boards", {}).items(), key=lambda item: (item[1].get("order", 0), item[0]))


def find_board(data: dict, board: str) -> str:
    """A board by slug, by title, or by its 1-based position ("2", "screen 2")."""
    boards = data.get("boards", {})
    if not isinstance(board, str) or not board.strip():
        raise LookupError("board is required: a board slug from design_outline.")
    key = board.strip()
    if key in boards:
        return key
    lowered = key.lower()
    for slug, info in boards.items():
        if (info.get("title") or "").lower() == lowered:
            return slug
    match = re.fullmatch(r"(?:board|screen|slide|#)?\s*([0-9]{1,2})", lowered)
    ordered = ordered_boards(data)
    if match and 1 <= int(match.group(1)) <= len(ordered):
        return ordered[int(match.group(1)) - 1][0]
    listing = ", ".join(f"{slug} \"{info.get('title')}\"" for slug, info in ordered[:20])
    raise LookupError(f"No board `{key}` in this design. Boards: {listing or 'none yet'}.")


def summary(data: dict) -> dict:
    return {"id": data["id"], "title": data.get("title") or "Untitled design", "owner": data.get("owner"),
            "boards": len(data.get("boards", {})), "version": data.get("version", 0),
            "updated": data.get("updated"), "created": data.get("created"),
            "chat_ids": [c for c in data.get("chat_ids", []) if not c.startswith("agent:")],
            "design_system": data.get("design_system") or design_systems.BUILTIN_ID,
            "first_board": (ordered_boards(data)[0][0] if data.get("boards") else None),
            "source": data.get("source")}


def list_designs() -> list[dict]:
    out = []
    if os.path.isdir(DESIGNS_DIR):
        for name in os.listdir(DESIGNS_DIR):
            if DESIGN_ID.fullmatch(name):
                try:
                    out.append(manifest(name))
                except LookupError:
                    continue
    return sorted(out, key=lambda d: d.get("updated") or 0, reverse=True)


def visible_to(data: dict, user: Optional[str], is_admin: bool) -> bool:
    if is_admin:
        return True
    return user is not None and (data.get("owner") == user or user in (data.get("visible_to") or []))


def require_user_access(design_id: str, user: Optional[str], is_admin: bool) -> dict:
    data = manifest(design_id)
    if not visible_to(data, user, is_admin):
        raise LookupError("No such design.")
    return data


def chat_key(session_id: Optional[str], agent_id: Optional[str]) -> Optional[str]:
    if session_id:
        return session_id
    return f"agent:{agent_id}" if agent_id else None


def require_chat_access(design_id: str, key: Optional[str]) -> dict:
    data = manifest(design_id)
    if not key or key not in (data.get("chat_ids") or []):
        raise AccessError("This chat cannot change that design. A chat edits only designs it created or that "
                          "the user attached to it (open the design and use Link to chat).")
    return data


def designs_for_chat(key: Optional[str]) -> list[dict]:
    if not key:
        return []
    return [d for d in list_designs() if key in (d.get("chat_ids") or [])]


# -- design mode (spec 3h) --------------------------------------------------------

def _mode_file() -> str:
    return os.path.join(DESIGNS_DIR, "design_mode.json")


def design_mode(session_id: Optional[str]) -> bool:
    if not session_id:
        return False
    return bool((read_json(_mode_file(), {}) or {}).get(session_id))


def set_design_mode(session_id: str, on: bool) -> None:
    with _session_state_lock:
        os.makedirs(DESIGNS_DIR, exist_ok=True)
        state = read_json(_mode_file(), {}) or {}
        if on:
            state[session_id] = True
        else:
            state.pop(session_id, None)
        write_json_atomic(_mode_file(), state)


# -- writing ----------------------------------------------------------------------

def _slug(title: str, taken) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (title or "board").lower()).strip("-")[:40] or "board"
    if not base[0].isalnum():
        base = "b-" + base
    slug, n = base, 1
    while slug in taken:
        n += 1
        slug = f"{base}-{n}"
    return slug


def board_specs(args: dict) -> list[dict]:
    """The format a board is made in, checked and sized (core/design_formats.py):
    one spec, or two for a website's desktop and mobile pair."""
    return design_formats.resolve(args.get("format"), size=args.get("size"), orientation=args.get("orientation"),
                                  w=args.get("w"), h=args.get("h"), frame=args.get("frame"))


def reflow(draft: dict) -> None:
    """Rows by format, in board order (design_formats.layout), for designs on
    the auto layout: every design made with formats, and an older one once it
    is fitted or a board is dragged or resized on the canvas."""
    if draft.get("layout") != "auto" or not draft.get("boards"):
        return
    order = [slug for slug, _ in ordered_boards(draft)]
    for slug, (x, y) in design_formats.layout(draft["boards"], order).items():
        draft["boards"][slug]["x"], draft["boards"][slug]["y"] = x, y


def frame_size(frame: str, w=None, h=None) -> tuple[int, int]:
    if frame not in FRAMES:
        raise ValueError(f"frame must be one of {', '.join(FRAMES)}.")
    dw, dh = FRAMES[frame]
    if frame == "none":
        dw = _int(w, dw, 120, 4000)
        dh = _int(h, dh, 120, 8000)
    return dw, dh


def _int(value, default, low, high) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def next_slot(data: dict, w: int, h: int) -> tuple[int, int]:
    """The next free place: to the right of the last board on its row."""
    boards = list(data.get("boards", {}).values())
    if not boards:
        return 0, 0
    top = min(b["y"] for b in boards)
    row = [b for b in boards if b["y"] < top + 400]
    return max(b["x"] + b["w"] for b in row) + GAP, top


def starter_html(frame: str, title: str) -> str:
    """An empty board of the right size with the system's base styles."""
    return (f'<main style="min-height: 100%; padding: var(--ds-space-6) var(--ds-space-5); background: var(--ds-bg); '
            f'color: var(--ds-text); font-family: var(--ds-font-sans)"><h1 style="margin: 0; font-size: var(--ds-size-6); '
            f'font-weight: 500">{design_html.html.escape(title)}</h1></main>')


def create(title: str, *, owner: Optional[str], chat_key_: Optional[str], by: str,
           design_system: Optional[str] = None, boards: Optional[list] = None, source: str = "",
           session_id: Optional[str] = None) -> tuple[dict, list[str]]:
    title = (title or "").strip()[:120] or "Untitled design"
    system = design_systems.get(design_system or design_systems.BUILTIN_ID)
    if system is None:
        raise ValueError(f"No design system `{design_system}`. Systems: "
                         + ", ".join(s["id"] for s in design_systems.list_systems()))
    design_id = secrets.token_hex(6)
    folder = _folder(design_id)
    data = {"v": 1, "id": design_id, "title": title, "owner": owner, "chat_ids": [chat_key_] if chat_key_ else [],
            "visible_to": [], "design_system": system["id"], "token_overrides": {}, "boards": {}, "notes": [],
            "version": 0, "created": _now(), "updated": _now(), "source": source[:200] or None, "layout": "auto"}
    (folder / "boards").mkdir(parents=True)
    (folder / "versions").mkdir()
    (folder / "assets").mkdir()
    write_json_atomic(str(folder / "design.json"), data)
    notes: list[str] = []
    starters = boards if boards else []
    if not isinstance(starters, list) or len(starters) > 12:
        raise ValueError("boards must be a list of at most 12 starter boards.")

    def build(draft: dict, files: dict) -> tuple[list[str], str]:
        made = []
        for board in starters or [{"title": "Screen 1", "format": "app", "size": "phone", "orientation": "portrait"}]:
            if not isinstance(board, dict):
                raise ValueError("Each starter board is an object {title, format, orientation, html}.")
            name = board.get("title") or f"Screen {len(made) + 1}"
            try:
                specs = board_specs(board)
            except ValueError as error:
                raise ValueError(f"Board \"{name}\": {error}") from None
            for slug, more in add_boards(draft, files, name, specs, board.get("html"), mobile_html=board.get("mobile_html")):
                made.append(slug)
                notes.extend(f"{slug}: {n}" for n in more)
        return made, f"Created with {len(made)} board{'s' if len(made) != 1 else ''}"
    try:
        result = change(design_id, build, by=by, tool="design_create", session_id=session_id)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return result["manifest"], notes + result["notes"]


def add_boards(draft: dict, files: dict, title: str, specs: list[dict], source: Optional[str], *,
               after: Optional[str] = None, mobile_html: Optional[str] = None) -> list[tuple[str, list[str]]]:
    """One board per spec. A website pair adds its desktop board, then its
    mobile board "<title> (mobile)", which starts from mobile_html or, without
    it, from the desktop HTML with a note to rework it for 390 wide."""
    made = []
    pair = len(specs) > 1
    own_mobile = isinstance(mobile_html, str) and bool(mobile_html.strip())
    for spec in specs:
        mobile = pair and spec.get("size") == "mobile"
        name = f"{title} (mobile)" if mobile else title
        slug, notes = _add_board(draft, files, name, spec, mobile_html if mobile and own_mobile else source, after=after)
        if mobile and not own_mobile and isinstance(source, str) and source.strip():
            notes = notes + ["The mobile board starts as a copy of the desktop HTML: rework it for 390 wide with "
                             "design_edit (or pass mobile_html)."]
        made.append((slug, notes))
        after = slug
    return made


def _add_board(draft: dict, files: dict, title: str, spec, source: Optional[str], *, after: Optional[str] = None,
               w=None, h=None) -> tuple[str, list[str]]:
    if len(draft["boards"]) >= MAX_BOARDS:
        raise ValueError(f"A design holds at most {MAX_BOARDS} boards. Start a new design for more.")
    title = (str(title or "").strip() or "Board")[:80]
    if isinstance(spec, str):  # An old frame name: phone, tablet, desktop, browser or slide.
        spec = board_specs({"frame": spec, "w": w, "h": h})[0]
    width, height = int(spec["w"]), int(spec["h"])
    slug = _slug(title, draft["boards"].keys() | files.keys())
    x, y = next_slot(draft, width, height)
    order = max([b.get("order", 0) for b in draft["boards"].values()] or [0]) + 1
    if after:
        ref = draft["boards"].get(after)
        if ref is None:
            raise LookupError(f"No board `{after}` to add after.")
        order = ref.get("order", 0) + 0.5
    board = {"title": title, "x": x, "y": y, "w": width, "h": height, "frame": spec.get("frame") or "none",
             "order": order, "format": spec.get("format"), "size": spec.get("size"), "orientation": spec.get("orientation")}
    if spec.get("grow"):
        board["min_h"] = int(spec.get("min_h") or height)
    draft["boards"][slug] = board
    _renumber(draft)
    reflow(draft)
    text, _, notes = design_html.normalize(source if isinstance(source, str) and source.strip()
                                           else starter_html(board["frame"], title))
    files[slug] = text
    return slug, notes


def _renumber(draft: dict) -> None:
    for n, (slug, _) in enumerate(ordered_boards(draft), 1):
        draft["boards"][slug]["order"] = n


def change(design_id: str, edit: Callable[[dict, dict], tuple], *, by: str, tool: str,
           session_id: Optional[str] = None, user_edit: bool = False, quiet: bool = False) -> dict:
    """Run one edit as one version. `edit(draft_manifest, files)` changes the
    draft and puts new board HTML in `files` ({slug: html}; None deletes);
    it returns (anything, summary). Raises without writing on any error.

    quiet: a derived layout change only (a growing board's measured height),
    written without a version; listeners still hear it, marked quiet."""
    if quiet:
        return _quiet_change(design_id, edit, by=by, tool=tool)
    with _lock(design_id):
        folder = _folder(design_id)
        data = manifest(design_id)
        draft = copy.deepcopy(data)
        files: dict[str, Optional[str]] = {}
        result, text = edit(draft, files)
        before = {slug: board_html(design_id, slug) for slug in files if slug in data.get("boards", {})}
        changed_boards, changed_ids = [], {}
        for slug, new in files.items():
            old = before.get(slug)
            if new == old:
                continue
            changed_boards.append(slug)
            changed_ids[slug] = design_html.changed_ids(old or "", new or "") if new is not None and old is not None else []
        manifest_changed = {k: v for k, v in draft.items() if k not in ("version", "updated")} != \
                           {k: v for k, v in data.items() if k not in ("version", "updated")}
        if not changed_boards and not manifest_changed:
            return {"result": result, "summary": text, "version": data.get("version", 0), "changed": {},
                    "boards_changed": [], "manifest": data, "notes": ["Nothing changed."], "unchanged": True}
        n = int(data.get("version", 0)) + 1
        draft["version"] = n
        draft["updated"] = _now()
        stored = {}
        version_files = folder / "versions" / "files" / str(n)
        for slug, new in files.items():
            if slug not in changed_boards:
                continue
            path = folder / "boards" / f"{slug}.html"
            if new is None:
                if path.exists():
                    path.unlink()
                continue
            version_files.mkdir(parents=True, exist_ok=True)
            (version_files / f"{slug}.html").write_text(new, encoding="utf-8")
            tmp = path.with_suffix(".tmp")
            tmp.write_text(new, encoding="utf-8")
            os.replace(tmp, path)
            stored[slug] = True
        entry = {"n": n, "at": draft["updated"], "by": by, "tool": tool, "summary": (text or tool)[:300],
                 "boards_changed": changed_boards, "changed_ids": changed_ids, "files": sorted(stored),
                 "manifest": _manifest_snapshot(draft), "session_id": session_id, "user_edit": user_edit,
                 "name": None, "pinned": False, "exported": False}
        write_json_atomic(str(folder / "versions" / f"{n}.json"), entry)
        write_json_atomic(str(folder / "design.json"), draft)
        addressed = _address_comments(design_id, changed_ids, n)
        _prune(design_id)
    packet = {"designId": design_id, "version": n, "boards": changed_boards, "changed": changed_ids,
              "by": by, "tool": tool, "summary": entry["summary"], "sessionId": session_id,
              "manifestChanged": manifest_changed, "addressed": addressed}
    for listener in list(_listeners):
        try:
            listener(packet)
        except Exception:
            pass
    return {"result": result, "summary": text, "version": n, "changed": changed_ids, "boards_changed": changed_boards,
            "manifest": draft, "notes": [], "unchanged": False}


def _quiet_change(design_id: str, edit: Callable[[dict, dict], tuple], *, by: str, tool: str) -> dict:
    with _lock(design_id):
        data = manifest(design_id)
        draft = copy.deepcopy(data)
        files: dict = {}
        result, text = edit(draft, files)
        if files:
            raise ValueError("A quiet change touches the layout only.")
        if draft == data:
            return {"result": result, "summary": text, "version": data.get("version", 0), "changed": {},
                    "boards_changed": [], "manifest": data, "notes": ["Nothing changed."], "unchanged": True}
        write_json_atomic(str(_folder(design_id) / "design.json"), draft)
    packet = {"designId": design_id, "version": data.get("version", 0), "boards": [], "changed": {}, "by": by,
              "tool": tool, "summary": text, "sessionId": None, "manifestChanged": True, "addressed": [], "quiet": True}
    for listener in list(_listeners):
        try:
            listener(packet)
        except Exception:
            pass
    return {"result": result, "summary": text, "version": data.get("version", 0), "changed": {}, "boards_changed": [],
            "manifest": draft, "notes": [], "unchanged": False}


def fit_height(design_id: str, slug: str, height) -> dict:
    """A growing board (website, email) as tall as its content: the canvas
    measures the rendered page and reports it here. Never below the board's
    minimum height; the rows below move to make room. No version: it is the
    content's height, not an edit."""
    def edit(draft, files):
        board = draft["boards"].get(slug)
        if board is None:
            raise LookupError(f"No board `{slug}`.")
        if not design_formats.grows(board):
            raise ValueError("Only website and email boards grow with their content.")
        try:
            content = max(60, min(8000, int(height)))
        except (TypeError, ValueError):
            raise ValueError("height is whole pixels.") from None
        board["content_h"] = content
        board["h"] = max(int(board.get("min_h") or 0), content)
        reflow(draft)
        return board["h"], f"{slug} fits its content"
    return change(design_id, edit, by="Kairos", tool="fit_height", quiet=True)


def _manifest_snapshot(data: dict) -> dict:
    return {key: copy.deepcopy(data.get(key)) for key in ("title", "boards", "notes", "design_system",
                                                         "token_overrides", "layout")}


# -- versions -------------------------------------------------------------------

def versions(design_id: str) -> list[dict]:
    folder = _folder(design_id) / "versions"
    out = []
    for path in folder.glob("*.json"):
        if path.stem.isdigit():
            entry = read_json(str(path), None)
            if isinstance(entry, dict):
                out.append({k: v for k, v in entry.items() if k != "manifest"})
    return sorted(out, key=lambda e: e["n"], reverse=True)


def version_entry(design_id: str, n: int) -> dict:
    entry = read_json(str(_folder(design_id) / "versions" / f"{int(n)}.json"), None)
    if not isinstance(entry, dict):
        raise LookupError(f"No version {n}.")
    return entry


def board_at(design_id: str, slug: str, n: int) -> Optional[str]:
    """A board's HTML as it was at version n (copy on write: the newest
    stored copy at or before n)."""
    folder = _folder(design_id) / "versions" / "files"
    best = None
    if folder.is_dir():
        for child in folder.iterdir():
            if child.name.isdigit() and int(child.name) <= n and (child / f"{slug}.html").is_file():
                if best is None or int(child.name) > best:
                    best = int(child.name)
    if best is None:
        return None
    return (folder / str(best) / f"{slug}.html").read_text(encoding="utf-8")


def snapshot_at(design_id: str, n: int) -> dict:
    entry = version_entry(design_id, n)
    snap = entry["manifest"]
    boards = {slug: board_at(design_id, slug, n) or "" for slug in (snap.get("boards") or {})}
    return {"version": n, "manifest": snap, "boards": boards}


def restore(design_id: str, n: int, *, by: str, session_id: Optional[str] = None, user_edit: bool = True) -> dict:
    target = snapshot_at(design_id, n)

    def edit(draft, files):
        for slug in list(draft["boards"]):
            if slug not in target["boards"]:
                files[slug] = None
        for slug, text in target["boards"].items():
            files[slug] = text
        for key, value in target["manifest"].items():
            draft[key] = copy.deepcopy(value)
        return n, f"Restored version {n}"
    return change(design_id, edit, by=by, tool="restore", session_id=session_id, user_edit=user_edit)


def name_version(design_id: str, n: int, name: Optional[str]) -> dict:
    with _lock(design_id):
        path = _folder(design_id) / "versions" / f"{int(n)}.json"
        entry = version_entry(design_id, n)
        entry["name"] = (name or "").strip()[:60] or None
        entry["pinned"] = bool(entry["name"])
        write_json_atomic(str(path), entry)
        return {k: v for k, v in entry.items() if k != "manifest"}


def mark_exported(design_id: str) -> None:
    with _lock(design_id):
        n = manifest(design_id).get("version", 0)
        path = _folder(design_id) / "versions" / f"{n}.json"
        entry = read_json(str(path), None)
        if isinstance(entry, dict):
            entry["exported"] = True
            write_json_atomic(str(path), entry)


def _history_bytes(folder: Path) -> int:
    return sum(p.stat().st_size for p in (folder / "versions").rglob("*") if p.is_file())


def _prune(design_id: str) -> None:
    """Keep the last 300 versions and 200 MB of history; never a named
    (pinned) or exported version. A pruned version's board files move to
    the next kept version that needs them, so later versions still rebuild."""
    folder = _folder(design_id)
    entries = sorted(versions(design_id), key=lambda e: e["n"])
    over = len(entries) - MAX_VERSIONS
    size = _history_bytes(folder) if over <= 0 else 0
    if over <= 0 and size <= MAX_HISTORY_BYTES:
        return
    current = entries[-1]["n"] if entries else 0
    for entry in entries:
        if entry["n"] == current or entry.get("pinned") or entry.get("exported") or entry["n"] == 1:
            continue
        if over <= 0 and _history_bytes(folder) <= MAX_HISTORY_BYTES:
            break
        later = [e for e in entries if e["n"] > entry["n"] and (folder / "versions" / f"{e['n']}.json").is_file()]
        source = folder / "versions" / "files" / str(entry["n"])
        if source.is_dir() and later:
            nxt = later[0]
            target = folder / "versions" / "files" / str(nxt["n"])
            for file in source.glob("*.html"):
                if not (target / file.name).exists():
                    target.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(file), str(target / file.name))
        shutil.rmtree(source, ignore_errors=True)
        (folder / "versions" / f"{entry['n']}.json").unlink(missing_ok=True)
        over -= 1


def duplicate(design_id: str, *, owner: Optional[str], by: str, version: Optional[int] = None,
              chat_key_: Optional[str] = None) -> dict:
    """Fork a design (optionally as it was at a version) into a new one."""
    data = manifest(design_id)
    snap = snapshot_at(design_id, version) if version else {
        "manifest": _manifest_snapshot(data),
        "boards": {slug: board_html(design_id, slug) for slug in data.get("boards", {})}}
    new_id = secrets.token_hex(6)
    folder = _folder(new_id)
    (folder / "boards").mkdir(parents=True)
    (folder / "versions").mkdir()
    shutil.copytree(_folder(design_id) / "assets", folder / "assets", dirs_exist_ok=True)
    title = f"{snap['manifest'].get('title') or 'Design'} (copy)"[:120]
    fresh = {"v": 1, "id": new_id, "title": title, "owner": owner, "chat_ids": [chat_key_] if chat_key_ else [],
             "visible_to": [], "design_system": snap["manifest"].get("design_system") or design_systems.BUILTIN_ID,
             "token_overrides": {}, "boards": {}, "notes": [], "version": 0, "created": _now(), "updated": _now(),
             "source": f"Duplicated from {data.get('title')} v{version or data.get('version')}"}
    write_json_atomic(str(folder / "design.json"), fresh)

    def edit(draft, files):
        for key, value in snap["manifest"].items():
            draft[key] = copy.deepcopy(value)
        draft["title"] = title
        for slug, text in snap["boards"].items():
            files[slug] = text
        return new_id, "Duplicated"
    return change(new_id, edit, by=by, tool="duplicate")["manifest"]


def delete(design_id: str) -> None:
    with _lock(design_id):
        shutil.rmtree(_folder(design_id), ignore_errors=True)


def link_chat(design_id: str, session_id: str) -> dict:
    with _lock(design_id):
        data = manifest(design_id)
        if session_id not in data.setdefault("chat_ids", []):
            data["chat_ids"].append(session_id)
            data["chat_ids"] = data["chat_ids"][-20:]
            write_json_atomic(str(_folder(design_id) / "design.json"), data)
        return data


# -- assets ---------------------------------------------------------------------

def add_asset(design_id: str, raw: bytes, ext: str) -> str:
    ext = ext.lower().lstrip(".")
    if ext not in ASSET_TYPES:
        raise ValueError("Assets are PNG, JPEG, GIF or WebP images.")
    if len(raw) > MAX_ASSET_BYTES:
        raise ValueError("An asset is at most 25 MB.")
    total = sum(p.stat().st_size for p in (_folder(design_id) / "assets").glob("*"))
    if total + len(raw) > MAX_ASSET_BYTES * 4:
        raise ValueError("This design's assets would exceed 100 MB.")
    digest = hashlib.sha256(raw).hexdigest()
    name = f"{digest}.{'jpg' if ext == 'jpeg' else ext}"
    path = _folder(design_id) / "assets" / name
    if not path.exists():
        path.write_bytes(raw)
    return f"assets/{name}"


def asset_path(design_id: str, name: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}\.(png|jpg|gif|webp)", name or ""):
        raise LookupError("No such asset.")
    path = _folder(design_id) / "assets" / name
    if not path.is_file():
        raise LookupError("No such asset.")
    return path


def asset_from_data_url(design_id: str, data_url: str) -> str:
    match = re.fullmatch(r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)", data_url or "")
    if not match:
        raise ValueError("Expected a data:image/...;base64 URL.")
    return add_asset(design_id, base64.b64decode(match.group(2)), match.group(1))


# -- comments (spec 3f) ------------------------------------------------------------

def comments(design_id: str) -> list[dict]:
    return read_json(str(_folder(design_id) / "comments.json"), []) or []


def _save_comments(design_id: str, items: list[dict]) -> None:
    write_json_atomic(str(_folder(design_id) / "comments.json"), items[-MAX_COMMENTS:])


def add_comment(design_id: str, *, board: str, element_ids: list, point: Optional[dict], text: str, author: str) -> dict:
    with _lock(design_id):
        data = manifest(design_id)
        if board not in data.get("boards", {}):
            raise LookupError(f"No board `{board}`.")
        text = (text or "").strip()
        if not text or len(text) > 4000:
            raise ValueError("A comment is 1 to 4000 characters.")
        ids = [i for i in (element_ids or []) if isinstance(i, str) and design_html.ID_RE.fullmatch(i)][:20]
        known = design_html.index(design_html.parse(board_html(design_id, board)))
        ids = [i for i in ids if i in known]
        if point is not None:
            try:
                point = {"x": max(0.0, min(1.0, float(point["x"]))), "y": max(0.0, min(1.0, float(point["y"])))}
            except (KeyError, TypeError, ValueError):
                raise ValueError("point is {x, y} as fractions of the board.") from None
        if not ids and point is None:
            raise ValueError("A comment pins to elements or to a point on the board.")
        item = {"id": secrets.token_hex(4), "board": board, "element_ids": ids, "point": point, "text": text,
                "author": author, "status": "open", "made_on_version": data.get("version", 0),
                "addressed_in": None, "created": _now(), "note": None}
        items = comments(design_id)
        items.append(item)
        _save_comments(design_id, items)
        return item


def update_comment(design_id: str, comment_id: str, *, status: Optional[str] = None, text: Optional[str] = None,
                   note: Optional[str] = None, version: Optional[int] = None) -> dict:
    with _lock(design_id):
        items = comments(design_id)
        item = next((c for c in items if c["id"] == comment_id), None)
        if item is None:
            raise LookupError(f"No comment `{comment_id}`.")
        if status is not None:
            if status not in ("open", "addressed", "resolved"):
                raise ValueError("status is open, addressed or resolved.")
            item["status"] = status
            if status == "addressed":
                item["addressed_in"] = version or manifest(design_id).get("version")
            if status == "open":
                item["addressed_in"] = None
        if text is not None:
            item["text"] = text.strip()[:4000] or item["text"]
        if note is not None:
            item["note"] = note.strip()[:300] or None
        _save_comments(design_id, items)
        return item


def delete_comment(design_id: str, comment_id: str) -> None:
    with _lock(design_id):
        _save_comments(design_id, [c for c in comments(design_id) if c["id"] != comment_id])


def _address_comments(design_id: str, changed: dict, n: int) -> list[str]:
    path = _folder(design_id) / "comments.json"
    if not path.is_file():
        return []
    items = comments(design_id)
    done = []
    for item in items:
        if item["status"] == "open" and set(item.get("element_ids") or []) & set(changed.get(item["board"], [])):
            item["status"] = "addressed"
            item["addressed_in"] = n
            done.append(item["id"])
    if done:
        _save_comments(design_id, items)
    return done


# -- thumbnails ------------------------------------------------------------------

def thumb_path(design_id: str, slug: str) -> Path:
    if not SLUG.fullmatch(slug or ""):
        raise LookupError("No such board.")
    return _folder(design_id) / "thumbs" / f"{slug}.png"


def board_hash(design_id: str, slug: str) -> str:
    data = manifest(design_id)
    text = board_html(design_id, slug)
    return hashlib.sha256(json.dumps([text, data.get("design_system"), data.get("token_overrides"),
                                      data["boards"][slug]["w"], data["boards"][slug]["h"]]).encode()).hexdigest()[:16]
