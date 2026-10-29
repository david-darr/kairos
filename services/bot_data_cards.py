"""Bots data panel: the saved result cards (Phase 6 unit U2, 2026-10-29).

A card is a title, the SQL that makes it and how to draw it. Never the rows:
rows are always re-read from the bot's own database. At most 200 cards per bot;
a pinned card is never dropped to make room.

File: data/bot_data/<bot_id>/cards.json (written atomically).
"""
from __future__ import annotations

import os
import re
import threading
import time
import uuid
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

ROOT = os.path.join(DATA_DIR, "bot_data")
MAX_CARDS = 200
MAX_TITLE = 120
MAX_SQL_BYTES = 100 * 1024
BOT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_LOCK = threading.RLock()
KEYS = ("id", "title", "sql", "spec", "pinned", "created_at", "updated_at")


class CardError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def folder(bot_id: str) -> str:
    """The bot's data folder, confined under ROOT."""
    if not isinstance(bot_id, str) or not BOT_ID.match(bot_id):
        raise CardError("Unknown bot.", 404)
    path = os.path.join(ROOT, bot_id)
    if os.path.commonpath([os.path.realpath(ROOT), os.path.realpath(path)]) != os.path.realpath(ROOT):
        raise CardError("Unknown bot.", 404)
    return path


def _file(bot_id: str) -> str:
    return os.path.join(folder(bot_id), "cards.json")


def _load(bot_id: str) -> list[dict]:
    data = read_json(_file(bot_id), {"cards": []})
    cards = data.get("cards") if isinstance(data, dict) else None
    return [c for c in (cards or []) if isinstance(c, dict) and c.get("id") and isinstance(c.get("sql"), str)]


def _save(bot_id: str, cards: list[dict]) -> None:
    os.makedirs(folder(bot_id), exist_ok=True)
    write_json_atomic(_file(bot_id), {"cards": [{k: c.get(k) for k in KEYS} for c in cards]})


def _clean_spec(spec) -> Optional[dict]:
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise CardError("A chart spec is an object.")
    from services import bot_data_charts
    try:
        return bot_data_charts.validate(spec)
    except bot_data_charts.ChartError as error:
        raise CardError(str(error))


def _clean_title(title, fallback="Result") -> str:
    text = " ".join(str(title or "").split())[:MAX_TITLE]
    return text or fallback


def _clean_sql(sql) -> str:
    if not isinstance(sql, str) or not sql.strip():
        raise CardError("A card needs a query.")
    if len(sql.encode("utf-8", "replace")) > MAX_SQL_BYTES:
        raise CardError("That query is too long.")
    return sql


def list_cards(bot_id: str) -> list[dict]:
    with _LOCK:
        cards = _load(bot_id)
    return sorted(cards, key=lambda c: (not c.get("pinned"), -(c.get("updated_at") or 0)))


def get(bot_id: str, card_id: str) -> dict:
    with _LOCK:
        for card in _load(bot_id):
            if card["id"] == card_id:
                return card
    raise CardError("That result is gone.", 404)


def create(bot_id: str, sql: str, title=None, spec=None, pinned: bool = False) -> dict:
    sql, spec = _clean_sql(sql), _clean_spec(spec)
    with _LOCK:
        cards = _load(bot_id)
        if len(cards) >= MAX_CARDS:
            unpinned = sorted((c for c in cards if not c.get("pinned")), key=lambda c: c.get("updated_at") or 0)
            if not unpinned:
                raise CardError("Every saved result is pinned. Unpin or delete one to make room.", 409)
            drop = unpinned[0]["id"]
            cards = [c for c in cards if c["id"] != drop]
        now = time.time()
        card = {"id": uuid.uuid4().hex[:16], "title": _clean_title(title), "sql": sql, "spec": spec,
                "pinned": bool(pinned), "created_at": now, "updated_at": now}
        cards.append(card)
        _save(bot_id, cards)
    return card


def update(bot_id: str, card_id: str, **fields) -> dict:
    with _LOCK:
        cards = _load(bot_id)
        card = next((c for c in cards if c["id"] == card_id), None)
        if card is None:
            raise CardError("That result is gone.", 404)
        unknown = set(fields) - {"title", "sql", "spec", "pinned"}
        if unknown:
            raise CardError("That cannot be changed on a result.")
        if "title" in fields:
            card["title"] = _clean_title(fields["title"], card["title"])
        if "sql" in fields:
            card["sql"] = _clean_sql(fields["sql"])
        if "spec" in fields:
            card["spec"] = _clean_spec(fields["spec"])
        if "pinned" in fields:
            if not isinstance(fields["pinned"], bool):
                raise CardError("pinned is true or false.")
            card["pinned"] = fields["pinned"]
        card["updated_at"] = time.time()
        _save(bot_id, cards)
    return card


def delete(bot_id: str, card_id: str) -> None:
    with _LOCK:
        cards = _load(bot_id)
        kept = [c for c in cards if c["id"] != card_id]
        if len(kept) == len(cards):
            raise CardError("That result is gone.", 404)
        _save(bot_id, kept)


def delete_all(bot_id: str) -> None:
    with _LOCK:
        path = _file(bot_id)
        if os.path.exists(path):
            os.remove(path)
