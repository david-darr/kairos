"""Small, plain-text summaries supplied by approved tabs, drawn by Home."""
import math
import re
import unicodedata
from html.parser import HTMLParser

CARD_ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def plain_text(value):
    parser = _Text()
    try:
        parser.feed(value)
        parser.close()
        text = "".join(parser.parts)
    except (AssertionError, ValueError):
        # Malformed declarations must not break another card or tab.
        text = re.sub(r"<[^>]*>", "", value)
    return "".join(c for c in text
                   if unicodedata.category(c) not in ("Cc", "Cf", "Cs"))


def _text(value, limit, *, required=False):
    if not isinstance(value, str):
        raise ValueError("text")
    value = plain_text(value).strip()
    if len(value) > limit or (required and not value):
        raise ValueError("text")
    return value


def _number(value, *, nonnegative=False):
    if type(value) not in (int, float):
        raise ValueError("number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or (nonnegative and value < 0):
        raise ValueError("number")
    return value


def validate_card(raw):
    if not isinstance(raw, dict):
        raise ValueError("shape")
    identity = raw.get("id")
    if not isinstance(identity, str) or not CARD_ID.fullmatch(identity):
        raise ValueError("id")
    card = {"id": identity, "title": _text(raw.get("title"), 40, required=True),
            "kind": raw.get("kind")}
    kind = card["kind"]
    if kind == "stat":
        value = raw.get("value")
        card.update(value=_text(value, 12, required=True) if isinstance(value, str) else _number(value),
                    label=_text(raw.get("label"), 40, required=True))
    elif kind == "progress":
        card.update(label=_text(raw.get("label"), 40, required=True),
                    value=_number(raw.get("value"), nonnegative=True),
                    total=_number(raw.get("total"), nonnegative=True))
        if card["total"] <= 0:
            raise ValueError("number")
    elif kind == "list":
        rows = raw.get("rows")
        if not isinstance(rows, list) or len(rows) > 5:
            raise ValueError("rows")
        card["rows"] = []
        for raw_row in rows:
            if not isinstance(raw_row, dict):
                raise ValueError("rows")
            row = {"title": _text(raw_row.get("title"), 80, required=True)}
            for key, limit in (("meta", 80), ("badge", 20)):
                if key in raw_row:
                    row[key] = _text(raw_row[key], limit)
            if "tone" in raw_row:
                if raw_row["tone"] not in ("default", "warn", "danger", "ok"):
                    raise ValueError("tone")
                row["tone"] = raw_row["tone"]
            card["rows"].append(row)
        if "empty_text" in raw:
            card["empty_text"] = _text(raw["empty_text"], 80)
    else:
        raise ValueError("kind")
    if kind in ("stat", "progress") and "detail" in raw:
        card["detail"] = _text(raw["detail"], 80)
    return card


def validate_cards(result, entry, logger):
    """Drop individual invalid/duplicate/excess cards. Never log payloads."""
    if result is None:
        return []
    if not isinstance(result, list):
        logger.warning("tab %s hook home_cards skipped category=shape", entry["slug"])
        return []
    cards, seen = [], set()
    for raw in result:
        try:
            card = validate_card(raw)
            if card["id"] in seen:
                raise ValueError("duplicate")
            seen.add(card["id"])
            if len(cards) >= 2:
                raise ValueError("limit")
        except ValueError as exc:
            logger.warning("tab %s hook home_cards skipped category=%s", entry["slug"], exc)
            continue
        meta = entry["_metadata"]
        card.update(id=f"tab:{entry['slug']}:{card['id']}", slug=entry["slug"],
                    tab_name=plain_text(meta["name"]), tab_icon=meta.get("icon_svg", ""))
        cards.append(card)
    return cards
