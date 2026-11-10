"""Format cards and port proposals (Video Styles build spec, section 2: "port a proven format").

A format is the reusable structure of a video, not its content: the premise in one line, the beat structure and typical
length, the audience profile, and evidence (source channel and video links, views and age when seen, the date checked).
The Researcher writes cards and port proposals ("this format, from niche A, into our niche B, because B's audience
matches on X"), with what changes: new premise wording, new subject, our own mascot and style pack. The Evaluator's
checks on a port (audience match, distance from the source, cost to make, and the series rule) are in policy.py.

Every number keeps its source and date: an evidence row without its https link and the date it was checked is refused.
This module validates input and holds the style pack table; the rows live in the account's studio store (store.py).
"""
import re
from datetime import date

from .store import PLATFORMS, StudioError

# The style packs a post can be made in (spec section 3) come from the registry in core/style_packs.py: Pack 0
# (motion-type) and Pack A (flat-2d) are built; a port into a pack that is not built is refused as "cannot be made
# yet" until its unit lands. `units_per_minute` is a planning estimate of render effort relative to Pack 0 (not
# measured), used only so a long, heavy port does not beat a cheaper format by default. `max_seconds` is what the
# pack can make today. User-made packs (core/style_pack_store.py) join through style_packs.user_packs(): each is drawn by
# its base pack and is available only once the person approved a version.
from core.style_packs import BUILT_IN as STYLE_PACKS, all_packs
COST_WARN_RATIO = 3.0      # a port this many times dearer than the cheapest pack that could make it is a warning
STALE_DAYS = 45            # evidence checked longer ago than this is flagged as stale
PORT_STATES = ("proposed", "accepted", "rejected", "retired")
_URL = re.compile(r"^https://[^\s/]+\.[^\s]+$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _text(value, what, limit, required=True):
    text = value.strip() if isinstance(value, str) else ("" if value is None else str(value).strip())
    if required and not text:
        raise StudioError(f"{what} is required")
    if len(text) > limit:
        raise StudioError(f"{what} is longer than {limit} characters")
    return text


def _day(value, what):
    text = _text(value, what, 10)
    if not _DAY.match(text):
        raise StudioError(f"{what} is a date like 2026-11-10")
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise StudioError(f"{what} is not a real date") from None


def _count(value, what):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0:
        raise StudioError(f"{what} is a whole number of at least 0")
    return int(value)


def _link(value, what):
    url = _text(value, what, 500)
    if not _URL.match(url):
        raise StudioError(f"{what} is the https link it came from")
    return url


def _names(raw, what, most=30):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > most:
        raise StudioError(f"{what} is a list of at most {most} names")
    out = []
    for n, item in enumerate(raw):
        name = _text(item, f"{what}[{n}]", 80)
        if name.lower() not in (x.lower() for x in out):
            out.append(name)
    return out


def clean_evidence(raw):
    """Source channel and video links, views and age when seen, and the date checked. Each number keeps its source."""
    if not isinstance(raw, list) or not raw or len(raw) > 20:
        raise StudioError("a format card needs 1 to 20 evidence rows, each with its link and the date it was checked")
    out = []
    for n, item in enumerate(raw):
        if not isinstance(item, dict):
            raise StudioError(f"evidence[{n}] is an object")
        unknown = set(item) - {"url", "channel", "title", "views", "age_days", "checked", "note"}
        if unknown:
            raise StudioError(f"evidence[{n}] has unknown fields: {', '.join(sorted(unknown))}")
        out.append({"url": _link(item.get("url"), f"evidence[{n}].url"),
                    "channel": _text(item.get("channel"), f"evidence[{n}].channel", 100),
                    "title": _text(item.get("title"), f"evidence[{n}].title", 200, False),
                    "views": _count(item.get("views"), f"evidence[{n}].views"),
                    "age_days": _count(item.get("age_days"), f"evidence[{n}].age_days"),
                    "checked": _day(item.get("checked"), f"evidence[{n}].checked"),
                    "note": _text(item.get("note"), f"evidence[{n}].note", 300, False)})
    return out


def clean_audience(raw):
    if not isinstance(raw, dict):
        raise StudioError("audience is an object: age_band, interests, platform, why")
    unknown = set(raw) - {"age_band", "interests", "platform", "why"}
    if unknown:
        raise StudioError(f"audience has unknown fields: {', '.join(sorted(unknown))}")
    platform = _text(raw.get("platform"), "audience.platform", 20).lower()
    if platform not in PLATFORMS:
        raise StudioError(f"audience.platform is one of {', '.join(PLATFORMS)}")
    return {"age_band": _text(raw.get("age_band"), "audience.age_band", 40),
            "interests": _text(raw.get("interests"), "audience.interests", 300),
            "platform": platform, "why": _text(raw.get("why"), "audience.why (why they watch)", 300)}


def clean_format(data):
    """A format card's fields from the Researcher's input, or a StudioError naming what is missing."""
    if not isinstance(data, dict):
        raise StudioError("a format card is an object")
    beats = data.get("beats")
    if not isinstance(beats, list) or not 2 <= len(beats) <= 12:
        raise StudioError("beats lists the structure in 2 to 12 steps, for example hook, rules, repeating segment, twist, payoff")
    low, high = data.get("length_min_s"), data.get("length_max_s")
    for value, what in ((low, "length_min_s"), (high, "length_max_s")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not 5 <= value <= 3 * 3600:
            raise StudioError(f"{what} is the typical length in seconds, 5 to 10800")
    if low > high:
        raise StudioError("length_min_s is more than length_max_s")
    evidence = clean_evidence(data.get("evidence"))
    names = _names(data.get("do_not_use"), "do_not_use")
    for row in evidence:      # the source channels' own names are never ours to use
        if row["channel"].lower() not in (x.lower() for x in names):
            names.append(row["channel"])
    return {"name": _text(data.get("name"), "name", 80), "premise": _text(data.get("premise"), "premise (in one line)", 200),
            "beats": [_text(b, f"beats[{n}]", 80) for n, b in enumerate(beats)], "length_min_s": float(low),
            "length_max_s": float(high), "audience": clean_audience(data.get("audience")),
            "source_niche": _text(data.get("source_niche"), "source_niche", 80), "do_not_use": names[:40], "evidence": evidence}


def clean_port(data):
    if not isinstance(data, dict):
        raise StudioError("a port is an object")
    raw = data.get("audience_evidence")
    if not isinstance(raw, list) or not raw or len(raw) > 10:
        raise StudioError("audience_evidence needs 1 to 10 rows: the link that shows the audiences match, what it shows, the date checked")
    evidence = []
    for n, item in enumerate(raw):
        if not isinstance(item, dict) or set(item) - {"url", "supports", "checked"}:
            raise StudioError(f"audience_evidence[{n}] is {{url, supports, checked}}")
        evidence.append({"url": _link(item.get("url"), f"audience_evidence[{n}].url"),
                         "supports": _text(item.get("supports"), f"audience_evidence[{n}].supports", 300),
                         "checked": _day(item.get("checked"), f"audience_evidence[{n}].checked")})
    pack = _text(data.get("style_pack"), "style_pack", 40)
    if pack not in all_packs():
        raise StudioError(f"style_pack is one of {', '.join(all_packs())}")
    return {"audience_match": _text(data.get("audience_match"), "audience_match (why the audiences match)", 500),
            "audience_evidence": evidence, "premise": _text(data.get("premise"), "premise (the new wording)", 200),
            "subject": _text(data.get("subject"), "subject", 200), "mascot": _text(data.get("mascot"), "mascot (ours, or none)", 80),
            "style_pack": pack, "thumbnail": _text(data.get("thumbnail"), "thumbnail (what it shows)", 300),
            "example_title": _text(data.get("example_title"), "example_title", 200)}


def cost(pack_id, length_s):
    """The cost to make a video of this length in a pack, against the cheapest pack that could make it today."""
    packs_now = all_packs()
    pack = packs_now[pack_id]
    minutes = max(length_s, 1) / 60
    units = round(pack["units_per_minute"] * minutes, 2)
    able = [p for p in packs_now.values() if p["available"] and p["max_seconds"] >= length_s]
    cheapest = round(min(p["units_per_minute"] for p in able) * minutes, 2) if able else None
    return {"pack": pack_id, "pack_name": pack["name"], "available": pack["available"], "length_s": length_s,
            "max_seconds": pack["max_seconds"], "units": units, "cheapest_units": cheapest,
            "ratio": round(units / cheapest, 2) if cheapest else None, "estimate": "planning units, not measured"}


def packs():
    return [{"id": k, **v} for k, v in all_packs().items()]


def is_stale(day, today=None):
    today = today or date.today()
    try:
        return (today - date.fromisoformat(day)).days > STALE_DAYS
    except (TypeError, ValueError):
        return True
