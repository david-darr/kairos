"""The Library's Vault page beyond read and save (Library Vault Polish,
locked 2026-10-22): highlighted full-text search, keyword "related" notes,
per-user pins, and "what changed" from the checkpoint store.

Search and related use the existing FTS5 index (core/memory/vault.py). There
is no semantic search in Kairos, so "related" is labelled "by keywords" in
the UI and means exactly that.
"""
import os
import re
from collections import Counter
from pathlib import Path
from typing import Optional

from core import file_checkpoints, settings as settings_store, vault_graph
from core.memory import vault_memory
from core.vault import resolve_vault_dir

# Private-use characters around each matched term in a search snippet; the
# client turns them into <mark> with text nodes, never HTML.
MARK_OPEN, MARK_CLOSE = "", ""
MAX_PINS = 50
_STOP = set("""a an and are as at be been but by can could did do does for from had has have how i if in into is it
its just like more most my no not of on or our out over so some than that the their them then there these they this
those to up us was we were what when where which while who why will with would you your also about after before
should must only very each other any all new one two use used using note notes""".split())


def search(query: str, limit: int = 20) -> list[dict]:
    query = (query or "").strip()[:200]
    if not query:
        return []
    hits = vault_memory().search(query, limit=limit, marks=(MARK_OPEN, MARK_CLOSE))
    return [{"path": h["ref"], "title": h["title"], "snippet": h["snippet"]} for h in hits]


def _terms(text: str, count: int) -> list[str]:
    words = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9'-]{3,}", text)]
    return [w for w, _ in Counter(w for w in words if w not in _STOP).most_common(count)]


def related(path: str, limit: int = 5) -> list[dict]:
    """Up to `limit` notes sharing the most distinctive words with this one
    (its title, then its most frequent body words), excluding itself and the
    notes it already links to or from."""
    note = vault_graph.read_vault_note_full(path)
    if not note:
        return []
    graph = vault_graph.build_vault_graph()
    linked = {path}
    for edge in graph["edges"]:
        if edge["kind"] == "link":
            if edge["source"] == path:
                linked.add(edge["target"])
            elif edge["target"] == path:
                linked.add(edge["source"])
    _, body = vault_graph.split_frontmatter(note["content"])
    title = Path(path).stem
    terms = list(dict.fromkeys([t.lower() for t in re.findall(r"[A-Za-z0-9]{3,}", title) if t.lower() not in _STOP]
                               + _terms(body, 8)))[:10]
    if not terms:
        return []
    hits = vault_memory().search(" ".join(terms), limit=limit + len(linked) + 2, any_word=True)
    out = []
    for hit in hits:
        if hit["ref"] in linked:
            continue
        out.append({"path": hit["ref"], "title": hit["title"], "snippet": hit["snippet"]})
        if len(out) >= limit:
            break
    return out


# -- pins ---------------------------------------------------------------------

def get_pins(user: str) -> list[str]:
    pins = (settings_store.get_setting("vault_pins") or {}).get(user) or []
    return [p for p in pins if isinstance(p, str)]


def set_pins(user: str, pins: list) -> list[str]:
    clean: list[str] = []
    for item in pins:
        if not isinstance(item, str) or not item.lower().endswith(".md") or len(item) > 500:
            raise ValueError("Pins must be vault note paths")
        if vault_graph._vault_real_path(item) is None:
            raise ValueError("A pin points outside the vault")
        if item not in clean:
            clean.append(item.replace("\\", "/"))
    clean = clean[:MAX_PINS]
    all_pins = dict(settings_store.get_setting("vault_pins") or {})
    all_pins[user] = clean
    settings_store.update_settings(vault_pins=all_pins)
    return clean


# -- what changed --------------------------------------------------------------

def source_label(source: str, user: str) -> str:
    """A checkpoint source in plain words."""
    kind, _, rest = source.partition(":")
    if kind == "library":
        return "You, in Library" if rest == user else f"{rest or 'Someone'}, in Library"
    if kind == "chat":
        try:
            from core.session_manager import session_manager
            title = (session_manager.get_session(rest) or {}).get("title")
        except Exception:
            title = None
        return f"Chat: {title}" if title else "Chat"
    if source == "task:triage-email":
        return "Email triage"
    if kind in ("task", "card"):
        try:
            from services.task_service import task_service
            name = (task_service.get_task(rest) or {}).get("name")
        except Exception:
            name = None
        if kind == "card":
            return f"Board card: {name}" if name else "Board card"
        return f"Task: {name}" if name else "Task"
    return source


def _vault_changes() -> list[dict]:
    """Every checkpointed change under the vault root, newest first."""
    root = str(Path(resolve_vault_dir()).resolve())
    out = []
    for event in file_checkpoints.list_events(limit=500):
        for root_info in event["roots"]:
            if root_info["path"] != root:
                continue
            for change in root_info.get("changes", []):
                out.append({"event_id": event["id"], "source": event["source"], "path": change["path"],
                            "when": event.get("finished") or event["created"], "before": change["before"],
                            "after": change["after"], "restored": bool(change.get("restored_at"))})
    return out


def _current_oid(path: str) -> Optional[str]:
    try:
        return file_checkpoints._current_blob_oid(Path(resolve_vault_dir()).resolve(), path)
    except (OSError, file_checkpoints.Conflict):
        return None


def _attribute(changes: list[dict], path: str, user: str) -> tuple[Optional[dict], str]:
    """Who the note's current text came from. The newest checkpoint explains
    it only while the file still holds exactly what that checkpoint wrote (or,
    after a restore, what it restored); anything else was edited outside
    Kairos (Obsidian, a sync tool) since."""
    if not changes:
        return None, "Edited outside Kairos"
    newest, current = changes[0], _current_oid(path)
    if current == newest["after"] and not newest["restored"]:
        return newest, source_label(newest["source"], user)
    if newest["restored"] and current == newest["before"]:
        return newest, "Restored in Kairos"
    return None, "Edited outside Kairos"


def _changes_for(path: str) -> list[dict]:
    path = path.replace("\\", "/")
    return [c for c in _vault_changes() if c["path"] == path]


def note_history(path: str, user: str, limit: int = 15) -> dict:
    root = str(Path(resolve_vault_dir()).resolve())
    path = path.replace("\\", "/")
    changes = _changes_for(path)[:limit]
    entries = []
    for change in changes:
        entry = {"event_id": change["event_id"], "source": change["source"], "path": path, "when": change["when"],
                 "label": source_label(change["source"], user), "added": None, "removed": None,
                 "restore_state": None, "root": root, "created": change["before"] is None}
        try:
            full = file_checkpoints.get_event(change["event_id"])
            for root_info in full["roots"]:
                if root_info["path"] != root:
                    continue
                for detail in root_info.get("changes", []):
                    if detail["path"] == path:
                        entry.update(added=detail.get("added"), removed=detail.get("removed"),
                                     restore_state=detail.get("restore_state"))
        except (KeyError, OSError, ValueError):
            pass
        entries.append(entry)
    note = vault_graph.read_vault_note_full(path)
    explained, label = _attribute(changes, path, user)
    outside = None
    if note and explained is None:
        outside = {"source": "outside", "label": label, "when": note["mtime"], "path": path}
    return {"path": path, "entries": entries, "outside": outside}


def recent_changes(user: str, limit: int = 12) -> list[dict]:
    """The most recently modified notes, each saying who changed it last."""
    graph = vault_graph.build_vault_graph()
    notes = sorted((n for n in graph["nodes"] if n["type"] == "note"), key=lambda n: -n["mtime"])[:limit]
    by_path: dict[str, list[dict]] = {}
    for change in _vault_changes():
        by_path.setdefault(change["path"], []).append(change)
    out = []
    for node in notes:
        change, label = _attribute(by_path.get(node["id"], []), node["id"], user)
        out.append({"path": node["id"], "name": node["name"], "when": node["mtime"],
                    "source": change["source"] if change else "outside", "label": label,
                    "event_id": change["event_id"] if change else None, "kairos": bool(change)})
    return out


def last_change(path: str, user: str) -> Optional[dict]:
    """Who last changed one note, for the reader's meta line."""
    note = vault_graph.read_vault_note_full(path)
    if not note:
        return None
    change, label = _attribute(_changes_for(path), path, user)
    return {"when": note["mtime"], "label": label, "kairos": bool(change)}


def daily_settings() -> tuple[str, str]:
    folder = settings_store.get_setting("vault_daily_folder") or "01 - Daily Notes"
    template = settings_store.get_setting("vault_daily_template") or f"{folder}/Daily Note Template.md"
    return folder.strip("/"), template


def obsidian_url(path: str) -> Optional[str]:
    """`obsidian://open?path=<absolute path>` for the desktop bridge only;
    validated to stay inside the vault."""
    real = vault_graph._vault_real_path(path)
    if not real or not os.path.isfile(real):
        return None
    from urllib.parse import quote
    return "obsidian://open?path=" + quote(real, safe="")
