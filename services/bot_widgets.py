"""Bots widgets: bot-made cards inside the conversation (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, sections 3.3, 4 and 5.3.

A widget is a small, declarative card a bot shows with `show_widget` and changes with
`update_widget`: a Card (or a List) of layout, text, fields and buttons. It is a document, never
code: this module checks it against the limits below, stores `{rev, doc, settled}` on the message
row, and turns a press into a normal user message in the thread. The browser draws it from DOM
nodes only (static/js/botsWidget.js).

Limits: 32,000 bytes of JSON, 250 nodes, depth 10, 20 fields, 40 list items, at most 6 images.
A form field is never a password (or any secret). A press carries the card's `rev`: a card that
changed since is refused with 409 and nothing is sent. A repeat press with the same `send_id`
returns the first answer, and once a card is answered it folds to one line.

The same module holds the small helpers apps and data results use to put a display-only row
(`kind` widget, app or data_result) into a conversation and to find it again by message id.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Awaitable, Callable, Optional

from core.logs import scrub_credentials

MAX_BYTES = 32_000
MAX_NODES = 250
MAX_DEPTH = 10
MAX_FIELDS = 20
MAX_LIST_ITEMS = 40
MAX_IMAGES = 6
MAX_OPTIONS = 40
MAX_CHART_SERIES = 4
MAX_CHART_POINTS = 100
MAX_TABLE_ROWS = 100
MAX_TABLE_COLS = 12
MAX_VALUES_BYTES = 8000
SIZES = ("sm", "md", "lg", "full")
TONES = ("quiet", "good", "warn", "bad")
GAPS = ("sm", "md", "lg")
INPUT_KINDS = ("text", "number", "email", "url", "tel", "search")
CHART_KINDS = ("bar", "line", "area")
# The drawings a widget may name: a subset of static/js/botsIcons.js (scripts/test_bots_widgets.py
# checks that every name exists there). Parity with botsWidgetModel.js ICONS.
ICONS = ("plus", "x", "search", "settings", "pencil", "trash-2", "copy", "archive", "pin", "folder", "message-square",
         "zap", "check", "circle-alert", "triangle-alert", "info", "eye", "sliders-horizontal", "brain", "wrench", "plug",
         "calendar-clock", "shield", "history", "gauge", "bell", "sparkles", "upload", "image", "refresh-cw",
         "arrow-left", "arrow-down", "chevron-down", "chevron-right", "chevron-left", "external-link", "lock", "clock",
         "send", "mic", "paperclip", "undo-2", "share-2", "download", "user", "users", "book-open", "phone", "repeat",
         "monitor", "rotate-ccw", "play", "pause", "panel-right", "messages-square", "archive-restore", "folder-plus",
         "ellipsis", "square")
FIELD_TYPES = ("Select", "Date", "Time", "Weekday", "Checkbox", "Radio", "Input", "Textarea")
LAYOUT = ("Box", "Row", "Col", "Form")
TEXT_NODES = {"Text": 2000, "Title": 200, "Caption": 400, "Label": 200, "Markdown": 8000}
NODE_TYPES = set(LAYOUT) | set(TEXT_NODES) | set(FIELD_TYPES) | {"Table", "Image", "Icon", "Chart", "Badge", "Progress",
                                                                  "Button", "Spacer", "Divider"}
ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
REF_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,59}$")
SECRETISH = re.compile(r"pass(word|code|phrase)|\bsecret\b|api[ _-]?key|\bpin\b|\bcvv\b|card number|\bssn\b|private key|"
                       r"recovery (code|phrase)|one[- ]time code|\botp\b", re.IGNORECASE)
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
RATE_PRESS_SECONDS = 0.0


class WidgetError(ValueError):
    """A refusal the person or the model reads. `status` is the HTTP code a route returns."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# -- validation ---------------------------------------------------------------------

def _text(value: Any, label: str, limit: int, required: bool = False) -> Optional[str]:
    if value is None or value == "":
        if required:
            raise WidgetError(f"{label} is needed.")
        return None
    if not isinstance(value, str):
        raise WidgetError(f"{label} must be text.")
    text = value.replace("\x00", "")
    if len(text) > limit:
        raise WidgetError(f"{label} is limited to {limit} characters.")
    return text


def _https(url: Any, label: str) -> str:
    if not isinstance(url, str) or len(url) > 2048 or not re.match(r"^https://[^\s/$.?#][^\s]*$", url, re.IGNORECASE):
        raise WidgetError(f"{label} must be an https link.")
    return url


class _Check:
    def __init__(self):
        self.nodes = 0
        self.fields: dict[str, dict] = {}
        self.images = 0
        self.refs: dict[str, dict] = {}
        self.client_refs: set[str] = set()

    def count(self) -> None:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise WidgetError(f"A widget can have at most {MAX_NODES} parts.")

    def ref(self, value: Any, label: str, *, client: bool = False, required: bool = True) -> Optional[str]:
        if value is None and not required:
            return None
        if not isinstance(value, str) or not REF_RE.match(value):
            raise WidgetError(f"{label} needs a short ref made of letters, digits, dots, dashes or underscores.")
        if value in self.refs:
            raise WidgetError(f"The ref '{value}' is used twice.")
        self.refs[value] = {"client": client}
        if client:
            self.client_refs.add(value)
        return value


def _options(raw: Any, label: str) -> list[dict]:
    if not isinstance(raw, list) or not raw or len(raw) > MAX_OPTIONS:
        raise WidgetError(f"{label} needs 1 to {MAX_OPTIONS} options.")
    out, seen = [], set()
    for item in raw:
        if isinstance(item, str):
            item = {"value": item, "label": item}
        if not isinstance(item, dict):
            raise WidgetError(f"{label} options are text or {{value, label}}.")
        value = _text(item.get("value"), f"{label} option value", 120, True)
        if value in seen:
            raise WidgetError(f"{label} has the option '{value}' twice.")
        seen.add(value)
        out.append({"value": value, "label": _text(item.get("label"), f"{label} option label", 120) or value})
    return out


def _field(node: dict, check: _Check) -> dict:
    kind = node["type"]
    ident = node.get("id")
    if not isinstance(ident, str) or not ID_RE.match(ident):
        raise WidgetError(f"A {kind} field needs an id of lowercase letters, digits and underscores.")
    if ident in check.fields:
        raise WidgetError(f"The field id '{ident}' is used twice.")
    if len(check.fields) >= MAX_FIELDS:
        raise WidgetError(f"A widget can have at most {MAX_FIELDS} fields.")
    out: dict = {"type": kind, "id": ident, "label": _text(node.get("label"), "A field label", 120, True)}
    for key in ("label", "placeholder"):
        if out.get(key) and SECRETISH.search(out[key]):
            raise WidgetError("Widgets cannot ask for passwords or other secrets.")
    if SECRETISH.search(ident):
        raise WidgetError("Widgets cannot ask for passwords or other secrets.")
    if kind in ("Input", "Textarea"):
        placeholder = _text(node.get("placeholder"), "A placeholder", 120)
        if placeholder:
            if SECRETISH.search(placeholder):
                raise WidgetError("Widgets cannot ask for passwords or other secrets.")
            out["placeholder"] = placeholder
        if node.get("input_type", node.get("kind")) is not None and kind == "Input":
            input_kind = node.get("input_type", node.get("kind"))
            if input_kind not in INPUT_KINDS:
                raise WidgetError("An Input is text, number, email, url, tel or search. It is never a password.")
            out["input_type"] = input_kind
        elif kind == "Input":
            out["input_type"] = "text"
        if node.get("value") is not None:
            out["value"] = _text(node["value"], "A field value", 2000)
        if kind == "Textarea" and node.get("rows") is not None:
            rows = node["rows"]
            if isinstance(rows, bool) or not isinstance(rows, int) or not 2 <= rows <= 12:
                raise WidgetError("rows is a whole number from 2 to 12.")
            out["rows"] = rows
    elif kind in ("Select", "Radio"):
        out["options"] = _options(node.get("options"), f"The {kind} '{ident}'")
        out["other"] = bool(node.get("other"))
        value = node.get("value")
        if value is not None:
            if value not in [o["value"] for o in out["options"]]:
                raise WidgetError(f"The starting value of '{ident}' is not one of its options.")
            out["value"] = value
    elif kind == "Checkbox":
        value = node.get("value", False)
        if not isinstance(value, bool):
            raise WidgetError("A checkbox starts true or false.")
        out["value"] = value
    elif kind == "Date":
        value = node.get("value")
        if value is not None and not (isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise WidgetError("A date starts as YYYY-MM-DD.")
        out["value"] = value
    elif kind == "Time":
        value = node.get("value")
        if value is not None and not (isinstance(value, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value)):
            raise WidgetError("A time starts as HH:MM.")
        out["value"] = value
    elif kind == "Weekday":
        value = node.get("value")
        if value is not None and value not in WEEKDAYS:
            raise WidgetError("A weekday is mon, tue, wed, thu, fri, sat or sun.")
        out["value"] = value
    if node.get("required") is not None:
        out["required"] = bool(node["required"])
    check.fields[ident] = out
    return out


def _chart(node: dict) -> dict:
    kind = node.get("kind", "bar")
    if kind not in CHART_KINDS:
        raise WidgetError("A chart is bar, line or area.")
    series = node.get("series")
    if not isinstance(series, list) or not 1 <= len(series) <= MAX_CHART_SERIES:
        raise WidgetError(f"A chart has 1 to {MAX_CHART_SERIES} series.")
    out = []
    for item in series:
        if not isinstance(item, dict):
            raise WidgetError("A chart series is {name, points}.")
        points = item.get("points")
        if not isinstance(points, list) or not points or len(points) > MAX_CHART_POINTS:
            raise WidgetError(f"A chart series has 1 to {MAX_CHART_POINTS} points.")
        clean = []
        for point in points:
            if not isinstance(point, dict) or isinstance(point.get("y"), bool) or not isinstance(point.get("y"), (int, float)):
                raise WidgetError("A chart point is {x, y} with a number for y.")
            clean.append({"x": _text(str(point.get("x", "")), "A chart label", 60) or "", "y": point["y"]})
        out.append({"name": _text(item.get("name"), "A series name", 60) or "", "points": clean})
    return {"type": "Chart", "kind": kind, "series": out, "title": _text(node.get("title"), "A chart title", 120),
            "height": 160}


def _node(raw: Any, check: _Check, depth: int, *, in_form: bool = False) -> dict:
    if depth > MAX_DEPTH:
        raise WidgetError(f"Parts are nested too deeply (at most {MAX_DEPTH} levels).")
    if not isinstance(raw, dict):
        raise WidgetError("Every part is an object with a type.")
    kind = raw.get("type")
    if kind not in NODE_TYPES:
        raise WidgetError(f"Unknown part type: {str(kind)[:40]}.")
    check.count()
    if kind in LAYOUT:
        children = raw.get("children", [])
        if not isinstance(children, list):
            raise WidgetError(f"{kind} holds a list of parts.")
        if len(children) > MAX_NODES:
            raise WidgetError(f"A widget can have at most {MAX_NODES} parts.")
        out: dict = {"type": kind, "children": [_node(c, check, depth + 1, in_form=in_form or kind == "Form") for c in children]}
        if raw.get("gap") is not None:
            if raw["gap"] not in GAPS:
                raise WidgetError("gap is sm, md or lg.")
            out["gap"] = raw["gap"]
        return out
    if kind in TEXT_NODES:
        out = {"type": kind, "text": _text(raw.get("text"), f"{kind} text", TEXT_NODES[kind], True)}
        if raw.get("tone") is not None:
            if raw["tone"] not in TONES:
                raise WidgetError("tone is quiet, good, warn or bad.")
            out["tone"] = raw["tone"]
        return out
    if kind in FIELD_TYPES:
        return _field(raw, check)
    if kind == "Table":
        columns, rows = raw.get("columns"), raw.get("rows")
        if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_TABLE_COLS or not isinstance(rows, list) or len(rows) > MAX_TABLE_ROWS:
            raise WidgetError(f"A table has 1 to {MAX_TABLE_COLS} columns and at most {MAX_TABLE_ROWS} rows.")
        clean_rows = []
        for row in rows:
            if not isinstance(row, list) or len(row) > len(columns):
                raise WidgetError("Each table row is a list no longer than the columns.")
            clean_rows.append([_text(str(c) if c is not None else "", "A table cell", 300) or "" for c in row])
        return {"type": "Table", "columns": [_text(str(c), "A column title", 80) or "" for c in columns], "rows": clean_rows}
    if kind == "Image":
        check.images += 1
        if check.images > MAX_IMAGES:
            raise WidgetError(f"A widget can show at most {MAX_IMAGES} images.")
        return {"type": "Image", "url": _https(raw.get("url"), "An image"), "alt": _text(raw.get("alt"), "Image text", 200) or ""}
    if kind == "Icon":
        name = raw.get("name")
        if name not in ICONS:
            raise WidgetError(f"'{str(name)[:30]}' is not an icon a widget can use.")
        return {"type": "Icon", "name": name}
    if kind == "Chart":
        return _chart(raw)
    if kind == "Badge":
        tone = raw.get("tone", "quiet")
        if tone not in TONES:
            raise WidgetError("tone is quiet, good, warn or bad.")
        return {"type": "Badge", "text": _text(raw.get("text"), "A badge", 60, True), "tone": tone}
    if kind == "Progress":
        value = raw.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100:
            raise WidgetError("Progress is a number from 0 to 100.")
        return {"type": "Progress", "value": value, "label": _text(raw.get("label"), "A progress label", 120)}
    if kind == "Button":
        return _button(raw, check)
    if kind in ("Spacer", "Divider"):
        return {"type": kind}
    raise WidgetError("Unknown part.")


def _button(raw: dict, check: _Check) -> dict:
    label = _text(raw.get("label"), "A button label", 60, True)
    action = raw.get("action")
    out: dict = {"type": "Button", "label": label}
    if isinstance(action, dict):
        kind = action.get("type")
        if kind == "open_url":
            out["action"] = {"type": "open_url", "url": _https(action.get("url"), "A button link")}
            return out
        if kind == "open_thread":
            thread = _text(action.get("thread_id"), "A thread id", 80, True)
            out["action"] = {"type": "open_thread", "thread_id": thread}
            return out
        if kind not in (None, "press"):
            raise WidgetError("A button action is press, open_url or open_thread.")
    out["ref"] = check.ref(raw.get("ref"), f"The button '{label}'")
    out["keep_open"] = bool(raw.get("keep_open"))
    if raw.get("tone") is not None:
        if raw["tone"] not in ("primary", "quiet", "danger"):
            raise WidgetError("A button tone is primary, quiet or danger.")
        out["tone"] = raw["tone"]
    return out


def _action(raw: Any, check: _Check, default_label: str, name: str) -> Optional[dict]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise WidgetError(f"{name} is {{label, ref}}.")
    return {"label": _text(raw.get("label"), f"The {name} label", 60) or default_label,
            "ref": check.ref(raw.get("ref", name), f"The {name} button")}


def validate(doc: Any) -> dict:
    """The clean widget document, or a WidgetError. Unknown keys are dropped, strings are bounded."""
    if not isinstance(doc, dict):
        raise WidgetError("A widget is an object.")
    try:
        size = len(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise WidgetError("A widget must be plain JSON.")
    if size > MAX_BYTES:
        raise WidgetError(f"A widget is limited to {MAX_BYTES:,} bytes (this one is {size:,}).")
    kind = doc.get("type", "card")
    if kind not in ("card", "list"):
        raise WidgetError("A widget is a card or a list.")
    check = _Check()
    out: dict = {"type": kind, "title": _text(doc.get("title"), "The title", 120),
                 "caption": _text(doc.get("caption"), "The caption", 240), "meta": _text(doc.get("meta"), "The meta line", 80),
                 "status": _text(doc.get("status"), "The status line", 160)}
    if kind == "card":
        size_name = doc.get("size", "md")
        if size_name not in SIZES:
            raise WidgetError("size is sm, md, lg or full.")
        out["size"] = size_name
        body = doc.get("children", [])
        if not isinstance(body, list):
            raise WidgetError("A card holds a list of parts.")
        if len(body) > MAX_NODES:
            raise WidgetError(f"A widget can have at most {MAX_NODES} parts.")
        out["children"] = [_node(c, check, 1) for c in body]
        out["confirm"] = _action(doc.get("confirm"), check, "Confirm", "confirm")
        out["cancel"] = _action(doc.get("cancel"), check, "Cancel", "cancel")
    else:
        items = doc.get("items")
        if not isinstance(items, list) or not items or len(items) > MAX_LIST_ITEMS:
            raise WidgetError(f"A list has 1 to {MAX_LIST_ITEMS} items.")
        clean = []
        for item in items:
            if not isinstance(item, dict):
                raise WidgetError("A list item is an object.")
            check.count()
            entry = {"title": _text(item.get("title"), "An item title", 200, True), "caption": _text(item.get("caption"), "An item caption", 400),
                     "meta": _text(item.get("meta"), "An item meta line", 80)}
            if item.get("ref") is not None:
                entry["ref"] = check.ref(item["ref"], f"The item '{entry['title'][:30]}'")
            if item.get("children"):
                body = item["children"]
                if not isinstance(body, list) or len(body) > 20:
                    raise WidgetError("An item holds up to 20 parts.")
                entry["children"] = [_node(c, check, 2) for c in body]
            clean.append(entry)
        out["items"] = clean
        out["confirm"] = _action(doc.get("confirm"), check, "Confirm", "confirm")
        out["cancel"] = _action(doc.get("cancel"), check, "Cancel", "cancel")
    if not out.get("title") and not out.get("children") and not out.get("items"):
        raise WidgetError("A widget needs a title or some content.")
    out["_refs"] = sorted(r for r in check.refs if r not in check.client_refs)
    return {k: v for k, v in out.items() if v is not None}


def refs_of(doc: dict) -> set[str]:
    """The refs a press may name (buttons that go to the server)."""
    return set(doc.get("_refs") or [])


def fields_of(doc: dict) -> dict[str, dict]:
    found: dict[str, dict] = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") in FIELD_TYPES and node.get("id"):
                found[node["id"]] = node
            for child in node.get("children") or []:
                walk(child)
            for item in node.get("items") or []:
                walk(item)
    walk(doc)
    return found


# -- rows in a conversation ---------------------------------------------------------------

def _store():
    from core import session_manager_store as store
    return store


def find_row(session_id: str, message_id: str) -> Optional[tuple[int, dict]]:
    store = _store()
    with store.transaction() as conn:
        row = conn.execute("SELECT idx, doc FROM messages WHERE session_id=? AND json_extract(doc,'$.bot_message_id')=?",
                           (session_id, message_id)).fetchone()
    return (row["idx"], json.loads(row["doc"])) if row else None


def set_fields(session_id: str, index: int, fields: dict) -> None:
    _store().update_message_fields(session_id, index, fields)


def append_rich_row(session_id: str, bot_id: str, kind: str, content: str, fields: dict) -> str:
    """Add a display-only assistant row of `kind` (widget, app, data_result) and tell open clients.
    Returns the new message's id."""
    from core.session_manager import session_manager
    index = session_manager.append_message(session_id, "assistant", content or kind, "complete",
                                           {"display_only": True, "kind": kind, **fields})
    message = _store().get_message(session_id, index) or {}
    message_id = message.get("bot_message_id", "")
    try:
        from services import chat_live
        chat_live.broadcast_owner({"type": "bot_rich", "sessionId": session_id, "messageId": message_id, "kind": kind})
    except Exception:
        pass
    return message_id


# -- storage on the row -----------------------------------------------------------------------

_LOCK = threading.RLock()


# -- cards in rooms ---------------------------------------------------------------------------
# A bot answers in a room through its seat session, which the room never shows. A card it makes there is
# posted into the room's transcript as a row from that bot (kind "widget", the card on meta.widget); the
# person's press goes to that row and back into the room as "@Bot I answered the card ...", so the same
# bot picks it up.

def _seat(session_id: str) -> Optional[tuple[str, str]]:
    try:
        from core import bot_rooms_store
        return bot_rooms_store.room_for_seat(session_id)
    except Exception:
        return None


def _room_thread(room_id: str, bot_id: str) -> str:
    from core import bot_rooms_store as store
    from services import bot_rooms
    running = next((t for t in store.turns(room_id, status="running") if t.get("bot_id") == bot_id), None)
    return running["thread_id"] if running else bot_rooms.thread_or_404(room_id, None)["id"]


def _room_card(room_id: str, message_id: str) -> dict:
    from core import bot_rooms_store as store
    message = store.get_message(room_id, str(message_id))
    if not message or message.get("kind") != "widget" or not isinstance((message.get("meta") or {}).get("widget"), dict):
        raise WidgetError("That card is gone.", 404)
    return message


def _room_save(room_id: str, message_id: str, widget: dict) -> None:
    from core import bot_rooms_store as store
    from services import bot_rooms
    message = store.get_message(room_id, message_id)
    updated = store.update_message(room_id, message_id, meta={**(message.get("meta") or {}), "widget": widget})
    try:
        from services import bot_room_events as feed
        room = store.get_room(room_id)
        feed.publish("room.message", room_id, {"message": bot_rooms.message_view(updated)}, room["owner"] if room else None)
    except Exception:
        pass


def show(session_id: str, bot_id: str, doc: Any) -> dict:
    clean = validate(doc)
    seat = _seat(session_id)
    if seat:
        from services import bot_rooms
        room_id = seat[0]
        message, _ = bot_rooms.add_row(room_id, _room_thread(room_id, bot_id), "bot", clean.get("title") or "Card", kind="widget",
                                       bot_id=bot_id, meta={"widget": {"rev": 1, "doc": clean, "settled": None}})
        return {"message_id": message["id"], "rev": 1, "room_id": room_id}
    message_id = append_rich_row(session_id, bot_id, "widget", clean.get("title") or "Card",
                                 {"widget": {"rev": 1, "doc": clean, "settled": None}})
    return {"message_id": message_id, "rev": 1}


def update(session_id: str, message_id: str, doc: Any) -> dict:
    clean = validate(doc)
    seat = _seat(session_id)
    if seat:
        with _LOCK:
            message = _room_card(seat[0], message_id)
            if message.get("bot_id") != seat[1]:
                raise WidgetError("There is no card with that id in this conversation.", 404)
            current = message["meta"]["widget"]
            if current.get("settled"):
                raise WidgetError("The person already answered that card. Show a new one instead.", 409)
            rev = int(current.get("rev") or 1) + 1
            _room_save(seat[0], message_id, {"rev": rev, "doc": clean, "settled": None})
        return {"message_id": message_id, "rev": rev}
    with _LOCK:
        found = find_row(session_id, message_id)
        if not found or not isinstance(found[1].get("widget"), dict):
            raise WidgetError("There is no card with that id in this conversation.", 404)
        index, row = found
        current = row["widget"]
        if current.get("settled"):
            raise WidgetError("The person already answered that card. Show a new one instead.", 409)
        rev = int(current.get("rev") or 1) + 1
        set_fields(session_id, index, {"widget": {"rev": rev, "doc": clean, "settled": None}})
    try:
        from services import chat_live
        chat_live.broadcast_owner({"type": "bot_rich", "sessionId": session_id, "messageId": message_id, "kind": "widget"})
    except Exception:
        pass
    return {"message_id": message_id, "rev": rev}


def get(session_id: str, message_id: str) -> dict:
    found = find_row(session_id, message_id)
    if not found or not isinstance(found[1].get("widget"), dict):
        raise WidgetError("There is no card with that id.", 404)
    return found[1]["widget"]


# -- pressing ---------------------------------------------------------------------------------

def _clean_values(doc: dict, values: Any, other: Any) -> dict:
    if values is None:
        values = {}
    if not isinstance(values, dict):
        raise WidgetError("The answers must be an object.")
    fields = fields_of(doc)
    if len(json.dumps(values, ensure_ascii=False).encode("utf-8")) > MAX_VALUES_BYTES:
        raise WidgetError("Those answers are too long.")
    others = other if isinstance(other, dict) else {}
    out: dict = {}
    for key, value in values.items():
        field = fields.get(key)
        if not field:
            raise WidgetError("That card has no field called " + str(key)[:30] + ".")
        kind = field["type"]
        if kind == "Checkbox":
            if not isinstance(value, bool):
                raise WidgetError(f"{field['label']} is yes or no.")
        elif kind in ("Select", "Radio"):
            allowed = [o["value"] for o in field["options"]]
            if value in allowed:
                pass
            elif field.get("other") and isinstance(others.get(key), str) and others[key].strip():
                value = others[key].strip()[:500]
            else:
                raise WidgetError(f"Pick one of the choices for {field['label']}.")
        elif kind == "Weekday":
            if value not in WEEKDAYS:
                raise WidgetError(f"{field['label']} is a weekday.")
        elif kind == "Date":
            if not (isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
                raise WidgetError(f"{field['label']} is a date.")
        elif kind == "Time":
            if not (isinstance(value, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value)):
                raise WidgetError(f"{field['label']} is a time.")
        else:
            if not isinstance(value, str):
                raise WidgetError(f"{field['label']} is text.")
            if field.get("input_type") == "number" and value.strip() and not re.fullmatch(r"-?\d+(\.\d+)?", value.strip()):
                raise WidgetError(f"{field['label']} is a number.")
            value = value[:2000]
        if isinstance(value, str):
            value = scrub_credentials(value)
        out[key] = value
    for key, field in fields.items():
        if field.get("required") and key not in out:
            raise WidgetError(f"{field['label']} is needed.")
    return out


def describe_press(doc: dict, ref: str, values: dict) -> tuple[str, str]:
    """(label of what was pressed, one plain sentence for the thread)."""
    label = ref
    for action in ("confirm", "cancel"):
        if doc.get(action) and doc[action]["ref"] == ref:
            label = doc[action]["label"]

    def walk(node):
        nonlocal label
        if isinstance(node, dict):
            if node.get("type") == "Button" and node.get("ref") == ref:
                label = node["label"]
            for child in node.get("children") or []:
                walk(child)
            for item in node.get("items") or []:
                if item.get("ref") == ref:
                    label = item["title"]
                walk(item)
    walk(doc)
    fields = fields_of(doc)
    lines = [f"{fields[k]['label']}: {('yes' if v else 'no') if isinstance(v, bool) else v}" for k, v in values.items()]
    title = doc.get("title") or "card"
    text = f'I answered the card "{title}": {label}.' + ("\n" + "\n".join(lines) if lines else "")
    return label, text


Sender = Callable[[str, str, dict], Awaitable[dict]]


async def press(owner: str, session_id: str, body: dict, sender: Optional[Sender] = None) -> dict:
    """The person pressed something on a card. Validates, sends one user message, settles the card.

    Repeat of the same `send_id` returns the first answer. Raises WidgetError (404 unknown card, 409 stale
    or already answered, 400 bad answers)."""
    from services import bot_chat_service
    send = sender or bot_chat_service.send
    session, _bot = bot_chat_service.require(owner, session_id)
    if session.get("room_id") or (session.get("thread") or {}).get("room_id"):
        raise WidgetError("Answer this card in its room.", 409)
    message_id, ref, send_id = body.get("message_id"), body.get("ref"), body.get("send_id")
    if not isinstance(send_id, str) or not 8 <= len(send_id) <= 100:
        raise WidgetError("This press needs a send id.")
    with _LOCK:
        found = find_row(session_id, str(message_id))
        if not found or not isinstance(found[1].get("widget"), dict):
            raise WidgetError("That card is gone.", 404)
        index, row = found
        state = row["widget"]
        settled = state.get("settled")
        if settled and settled.get("send_id") == send_id:
            if settled.get("pending"):
                raise WidgetError("That answer is still being sent.", 409)
            return settled["result"]
        if body.get("rev") != state.get("rev"):
            raise WidgetError("This card changed. Look at the new one.", 409)
        if settled:
            raise WidgetError("This card was already answered.", 409)
        doc = state["doc"]
        if ref not in refs_of(doc):
            raise WidgetError("That button is not on this card.", 400)
        values = _clean_values(doc, body.get("values"), body.get("other"))
        label, text = describe_press(doc, ref, values)
        text = scrub_credentials(text)
        reserved = {"at": time.time(), "ref": ref, "label": label, "send_id": send_id, "result": None,
                    "summary": text, "pending": True}
        if not _keeps_open(doc, ref):
            set_fields(session_id, index, {"widget": {**state, "settled": reserved}})
    try:
        result = await send(owner, session_id, {"text": text, "send_id": send_id, "mode": None})
    except Exception:
        with _LOCK:
            found = find_row(session_id, str(message_id))
            if found and not _keeps_open(doc, ref):
                set_fields(session_id, found[0], {"widget": {**state, "settled": None}})
        raise
    result = result if isinstance(result, dict) else {"ok": True}
    if not _keeps_open(doc, ref):
        with _LOCK:
            found = find_row(session_id, str(message_id))
            if found:
                done = {**reserved, "result": result}
                done.pop("pending", None)
                set_fields(session_id, found[0], {"widget": {**state, "settled": done}})
    return result


async def press_room(owner: str, room_id: str, body: dict, sender=None) -> dict:
    """The person pressed something on a card in a room. Validates the same way as a chat card, marks it
    answered, and sends the answer into the room addressed to the bot that showed it."""
    from core import bot_rooms_store as store
    from services import bot_rooms, bot_room_turns
    from services.agent_service import agent_service
    bot_rooms.get(room_id, owner)
    message_id, ref, send_id = str(body.get("message_id")), body.get("ref"), body.get("send_id")
    if not isinstance(send_id, str) or not 8 <= len(send_id) <= 100:
        raise WidgetError("This press needs a send id.")
    with _LOCK:
        message = _room_card(room_id, message_id)
        state = message["meta"]["widget"]
        settled = state.get("settled")
        if settled and settled.get("send_id") == send_id:
            if settled.get("pending"):
                raise WidgetError("That answer is still being sent.", 409)
            return settled["result"]
        if body.get("rev") != state.get("rev"):
            raise WidgetError("This card changed. Look at the new one.", 409)
        if settled:
            raise WidgetError("This card was already answered.", 409)
        doc = state["doc"]
        if ref not in refs_of(doc):
            raise WidgetError("That button is not on this card.", 400)
        values = _clean_values(doc, body.get("values"), body.get("other"))
        label, text = describe_press(doc, ref, values)
        text = scrub_credentials(text)
        reserved = {"at": time.time(), "ref": ref, "label": label, "send_id": send_id, "result": None, "summary": text, "pending": True}
        if not _keeps_open(doc, ref):
            _room_save(room_id, message_id, {**state, "settled": reserved})
    bot = agent_service.get(message.get("bot_id")) or {}
    addressed = f"@{bot['name']} {text}" if bot.get("name") else text
    try:
        submit = sender or bot_room_turns.submit
        result = submit(room_id, message["thread_id"], addressed, send_id, "text", owner, message_id)
    except Exception:
        with _LOCK:
            if not _keeps_open(doc, ref) and store.get_message(room_id, message_id):
                _room_save(room_id, message_id, {**state, "settled": None})
        raise
    result = {"ok": True, "message_id": (result or {}).get("message", {}).get("id")} if isinstance(result, dict) else {"ok": True}
    if not _keeps_open(doc, ref):
        with _LOCK:
            done = {**reserved, "result": result}
            done.pop("pending", None)
            _room_save(room_id, message_id, {**state, "settled": done})
    return result


def _keeps_open(doc: dict, ref: str) -> bool:
    found = False

    def walk(node):
        nonlocal found
        if isinstance(node, dict):
            if node.get("type") == "Button" and node.get("ref") == ref and node.get("keep_open"):
                found = True
            for child in node.get("children") or []:
                walk(child)
            for item in node.get("items") or []:
                walk(item)
    walk(doc)
    return found


# -- the tools ---------------------------------------------------------------------------------

def _bot(ctx) -> tuple[str, str]:
    bot_id, session_id = getattr(ctx, "agent_id", None), getattr(ctx, "session_id", None)
    if not bot_id:
        raise WidgetError("This tool is for bots.")
    if not session_id:
        raise WidgetError("There is no conversation to show this in.")
    return bot_id, session_id


def _decode(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


async def _tool_show(args: dict, ctx) -> str:
    try:
        bot_id, sid = _bot(ctx)
        result = show(sid, bot_id, _decode((args or {}).get("widget")))
    except WidgetError as error:
        return "Not shown: " + str(error)
    return (f"Card shown. Message id {result['message_id']}, revision {result['rev']}. The person's answer arrives as their next "
            "message. Use update_widget with this id to change it before they answer.")


async def _tool_update(args: dict, ctx) -> str:
    try:
        _, sid = _bot(ctx)
        result = update(sid, str((args or {}).get("message_id") or ""), _decode((args or {}).get("widget")))
    except WidgetError as error:
        return "Not updated: " + str(error)
    return f"Card updated to revision {result['rev']}."


def _object(properties: dict, required: tuple = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required)}


_WIDGET_SCHEMA = {"type": "object", "description": (
    "A card: {type: card, size sm|md|lg|full, title, caption, meta, status, children: [parts], confirm: {label, ref}, "
    "cancel: {label, ref}} or a list: {type: list, items: [{title, caption, meta, ref}]}. Parts: Box, Row, Col, Form (children); "
    "Text, Title, Caption, Label, Markdown ({text}); Table ({columns, rows}); Image ({url https, alt}); Icon ({name}); "
    "Chart ({kind bar|line|area, series:[{name, points:[{x,y}]}]}); Badge ({text, tone}); Progress ({value 0-100}); "
    "Button ({label, ref} or {label, action:{type:open_url,url}}); Spacer; Divider. Fields (each with id and label): Select, "
    "Radio ({options, other}), Date, Time, Weekday, Checkbox, Input ({input_type text|number|email|url}), Textarea. Never ask "
    "for a password. Limits: 32,000 bytes, 250 parts, 20 fields, 40 list items.")}

TOOLS = [
    {"name": "show_widget", "effect": "write", "handler": _tool_show,
     "description": ("Show the person a card in the conversation: a short form, a choice, a summary or a list they can answer "
                     "with a button. Their answer comes back as a normal message. Never put a password field in it."),
     "schema": _object({"widget": _WIDGET_SCHEMA}, ("widget",))},
    {"name": "update_widget", "effect": "write", "handler": _tool_update,
     "description": "Change a card you showed, by its message id, until the person answers it.",
     "schema": _object({"message_id": {"type": "string"}, "widget": _WIDGET_SCHEMA}, ("message_id", "widget"))},
]
