"""Board formats: the natural sizes a design is made in (David, 2026-10-22).

Models used to pick any width and height, so a website came out 1468 wide and
a phone page 1072 wide. Now every board is made in a named format, and its
size stays true to it:

- website: desktop 1440 wide and mobile 390 wide, made in pairs; the height
  grows with the content, the width never changes;
- app: phone 390x844 and tablet 820x1180, portrait or landscape;
- poster: 2:3, 3:4, A-series (1:1.414), 18x24 or 11x17, portrait or landscape;
- slides: 16:9 at 1920x1080;
- social: square 1:1, portrait 4:5, landscape 1.91:1 and story 9:16;
- print: US letter and A4, portrait or landscape;
- banner: a site header, leaderboard, billboard, skyscraper or LinkedIn cover;
- email: 600 wide, height grows;
- custom: exact pixel sizes, only when the person asks for exact dimensions.

A fixed format keeps its ratio when it is resized; a growing one (website,
email) changes height only. Boards are laid out in rows, one row per format
(a Figma-style section flow), so moving or resizing a board pushes its
neighbours along instead of overlapping them.

Designs made before formats keep their sizes: infer() maps each board onto its
nearest format for a "Fit to format" offer, and nothing changes until the
person (or the model) asks.
"""
from __future__ import annotations

import math
import re
from typing import Optional

ORIENTATIONS = ("portrait", "landscape", "square")
# The device chrome the canvas draws around a board (canvas pixels: top, side, bottom).
CHROME = {"phone": (36, 12, 22), "tablet": (22, 18, 22), "browser": (40, 0, 0)}
GAP = 120          # Between boards in a row.
ROW_GAP = 320      # Between rows (room for the section label and board titles).
TITLE = 34         # A board's title sits this far above its chrome.

# Each format: its sizes (variants), which orientations it takes, its default
# size and orientation, and whether its height grows with the content.
# A size is (width, height) in its first orientation; the other one swaps them.
FORMATS: dict[str, dict] = {
    "website": {"label": "Website", "grow": True, "orientations": (), "default_size": "pair",
                "sizes": {"desktop": {"label": "Desktop", "w": 1440, "h": 900, "frame": "browser"},
                          "mobile": {"label": "Mobile", "w": 390, "h": 844, "frame": "phone"}},
                "hint": "a website or web page: a desktop board and a mobile board, made as a pair"},
    "app": {"label": "App", "grow": False, "orientations": ("portrait", "landscape"), "default_size": "phone",
            "default_orientation": "portrait",
            "sizes": {"phone": {"label": "Phone", "w": 390, "h": 844, "frame": "phone"},
                      "tablet": {"label": "Tablet", "w": 820, "h": 1180, "frame": "tablet"}},
            "hint": "app screens, onboarding, mobile or tablet UI"},
    "poster": {"label": "Poster", "grow": False, "orientations": ("portrait", "landscape"), "default_size": "2:3",
               "sizes": {"2:3": {"label": "2:3", "w": 1200, "h": 1800},
                         "3:4": {"label": "3:4", "w": 1200, "h": 1600},
                         "a-series": {"label": "A-series (A4 to A0)", "w": 1200, "h": 1697},
                         "18x24": {"label": "18x24 in", "w": 1350, "h": 1800},
                         "11x17": {"label": "11x17 in", "w": 1100, "h": 1700}},
               "hint": "a poster, flyer or print ad"},
    "slides": {"label": "Slides", "grow": False, "orientations": ("landscape",), "default_size": "16:9",
               "default_orientation": "landscape",
               "sizes": {"16:9": {"label": "16:9", "w": 1920, "h": 1080, "frame": "slide"}},
               "hint": "a slide deck or presentation, one board per slide"},
    "social": {"label": "Social", "grow": False, "orientations": ("square", "portrait", "landscape"), "default_size": "post",
               "sizes": {"post": {"label": "Post", "by_orientation": {"square": (1080, 1080), "portrait": (1080, 1350),
                                                                      "landscape": (1200, 628)}},
                         "story": {"label": "Story 9:16", "w": 1080, "h": 1920, "only": "portrait"}},
               "hint": "a social post (square 1:1, portrait 4:5, landscape 1.91:1) or a story (9:16)"},
    "print": {"label": "Print", "grow": False, "orientations": ("portrait", "landscape"), "default_size": "letter",
              "sizes": {"letter": {"label": "US Letter", "w": 816, "h": 1056},
                        "a4": {"label": "A4", "w": 794, "h": 1123}},
              "hint": "a printed page: letter, one-pager, resume, certificate"},
    "banner": {"label": "Banner", "grow": False, "orientations": ("landscape",), "default_size": "header",
               "default_orientation": "landscape",
               "sizes": {"header": {"label": "Header 3:1", "w": 1500, "h": 500},
                         "leaderboard": {"label": "Leaderboard", "w": 728, "h": 90},
                         "billboard": {"label": "Billboard", "w": 970, "h": 250},
                         "linkedin": {"label": "LinkedIn cover", "w": 1584, "h": 396},
                         "skyscraper": {"label": "Skyscraper", "w": 160, "h": 600, "only": "portrait"}},
               "hint": "a web banner, ad unit or profile cover"},
    "email": {"label": "Email", "grow": True, "orientations": (), "default_size": "600",
              "sizes": {"600": {"label": "600 wide", "w": 600, "h": 800}},
              "hint": "an email or newsletter, 600 wide"},
    "custom": {"label": "Custom", "grow": False, "orientations": (), "default_size": "custom",
               "sizes": {"custom": {"label": "Custom"}},
               "hint": "exact pixel sizes, ONLY when the person asked for exact dimensions"},
}
FORMAT_IDS = list(FORMATS)
# The frames of designs made before formats, mapped onto their natural format.
LEGACY_FRAMES = {"phone": ("app", "phone", "portrait"), "tablet": ("app", "tablet", "portrait"),
                 "desktop": ("website", "desktop", None), "browser": ("website", "desktop", None),
                 "slide": ("slides", "16:9", "landscape")}


def catalog_text() -> str:
    """One line per format, for tool descriptions and errors."""
    lines = []
    for fid, spec in FORMATS.items():
        names = list(spec["sizes"]) if fid != "website" else ["pair", "desktop", "mobile"]
        sizes = ", ".join(f"{n} (default)" if n == spec["default_size"] else n for n in names)
        orient = "/".join(spec["orientations"]) if spec["orientations"] else "-"
        lines.append(f"{fid} ({spec['hint']}; size {sizes}; orientation {orient})")
    return "; ".join(lines)


def _size_of(fid: str, size: str, orientation: Optional[str]) -> tuple[int, int, Optional[str]]:
    spec = FORMATS[fid]["sizes"][size]
    if "by_orientation" in spec:
        w, h = spec["by_orientation"][orientation]
        return w, h, orientation
    w, h = spec["w"], spec["h"]
    if spec.get("only"):
        orientation = spec["only"]
    if orientation == "landscape" and h > w or orientation == "portrait" and w > h:
        w, h = h, w
    return w, h, orientation


def resolve(fmt: Optional[str], *, size: Optional[str] = None, orientation: Optional[str] = None,
            w=None, h=None, frame: Optional[str] = None) -> list[dict]:
    """A board's format, checked and sized: a list of board specs (two for a
    website pair, one otherwise). Raises ValueError that teaches what is valid.

    `frame` is the old way to ask for a size (phone, tablet, desktop, browser,
    slide); it maps onto its natural format. The old free `none` frame needs a
    format now.
    """
    if not fmt and frame:
        if frame not in LEGACY_FRAMES:
            raise ValueError("Pick a format instead of frame none: " + catalog_text()
                             + ". Use format custom with w and h only when the person asked for exact dimensions.")
        fmt, legacy_size, legacy_orientation = LEGACY_FRAMES[frame]
        size = size or legacy_size
        orientation = orientation or legacy_orientation
    if not fmt:
        raise ValueError("format is required: " + catalog_text() + ".")
    fmt = str(fmt).strip().lower()
    aliases = {"web": "website", "site": "website", "page": "website", "landing": "website", "deck": "slides",
               "slide": "slides", "presentation": "slides", "mobile": "app", "phone": "app", "tablet": "app",
               "flyer": "poster", "instagram": "social", "post": "social", "story": "social", "newsletter": "email",
               "document": "print", "letter": "print", "a4": "print"}
    if fmt not in FORMATS and fmt in aliases:
        implied = {"phone": "phone", "tablet": "tablet", "mobile": "phone", "story": "story", "a4": "a4",
                   "letter": "letter"}.get(fmt)
        size = size or implied
        fmt = aliases[fmt]
    if fmt not in FORMATS:
        raise ValueError(f"No format `{fmt}`. Formats: " + catalog_text() + ".")
    spec = FORMATS[fmt]
    if fmt == "custom":
        try:
            cw, ch = int(w), int(h)
        except (TypeError, ValueError):
            raise ValueError("format custom needs w and h in pixels, and is only for exact dimensions the person "
                             "asked for. Otherwise pick a named format: " + catalog_text() + ".") from None
        if not (120 <= cw <= 4000 and 120 <= ch <= 8000):
            raise ValueError("A custom board is 120 to 4000 wide and 120 to 8000 tall.")
        return [{"format": "custom", "size": "custom", "orientation": _orientation_of(cw, ch), "w": cw, "h": ch,
                 "frame": "none", "grow": False, "min_h": None}]
    size = (str(size).strip().lower() if size else None) or spec["default_size"]
    if fmt == "website" and size in ("both", "desktop+mobile", "pair"):
        return resolve("website", size="desktop") + resolve("website", size="mobile")
    if fmt == "website" and size in ("phone",):
        size = "mobile"
    if size not in spec["sizes"]:
        if fmt == "website" and size not in ("pair",):
            raise ValueError("website size is desktop, mobile or pair (both; the default).")
        raise ValueError(f"{fmt} size is one of {', '.join(spec['sizes'])}.")
    orientation = (str(orientation).strip().lower() if orientation else None)
    allowed = spec["orientations"]
    only = spec["sizes"][size].get("only")
    if only:
        orientation = only
    elif allowed:
        if not orientation:
            orientation = spec.get("default_orientation")
        if not orientation:
            raise ValueError(f"{fmt} needs orientation: {' or '.join(allowed)}. Choose the one that fits the request.")
        if orientation not in allowed:
            raise ValueError(f"{fmt} orientation is {' or '.join(allowed)}.")
    else:
        orientation = None
    bw, bh, orientation = _size_of(fmt, size, orientation)
    frame_name = spec["sizes"][size].get("frame", "none")
    if fmt == "app" and frame_name == "phone" and orientation == "landscape":
        frame_name = "none"  # The phone bezel is drawn upright only.
    board = {"format": fmt, "size": size, "orientation": orientation, "w": bw, "h": bh, "frame": frame_name,
             "grow": bool(spec["grow"]), "min_h": bh if spec["grow"] else None}
    return [board]


def _orientation_of(w: int, h: int) -> str:
    return "square" if abs(w - h) <= max(w, h) * 0.02 else ("landscape" if w > h else "portrait")


def label(board: dict) -> str:
    """"Website · Desktop", "Poster · 2:3 portrait", "Custom", or the frame of an old board."""
    fmt = board.get("format")
    if fmt not in FORMATS:
        return "Custom" if board.get("frame") in (None, "none") else board.get("frame", "Board").title()
    spec = FORMATS[fmt]
    if fmt == "custom":
        return "Custom"
    size = spec["sizes"].get(board.get("size") or "", {}).get("label", board.get("size") or "")
    parts = [spec["label"]]
    if len(spec["sizes"]) > 1 or fmt in ("slides",):
        parts.append(size)
    head = " · ".join(p for p in parts if p)
    if board.get("orientation") and len(spec["orientations"]) > 1 and not spec["sizes"].get(board.get("size") or "", {}).get("only"):
        head += f" {board['orientation']}"
    return head


def section_key(board: dict) -> str:
    """The layout row a board belongs to: its format, and for websites and apps its device."""
    fmt = board.get("format")
    if fmt in ("website", "app"):
        return f"{fmt}:{board.get('size')}"
    if fmt in FORMATS:
        return fmt
    guess = infer(board)
    return section_key(guess) if guess.get("format") else "custom"


def section_label(key: str) -> str:
    fmt, _, size = key.partition(":")
    spec = FORMATS.get(fmt)
    if not spec:
        return "Custom"
    if size and size in spec["sizes"]:
        return f"{spec['label']} · {spec['sizes'][size]['label']}"
    return spec["label"]


def ratio(board: dict) -> Optional[float]:
    """w / h for a fixed-ratio format; None for growing and custom boards."""
    fmt = board.get("format")
    if fmt not in FORMATS or fmt == "custom" or FORMATS[fmt]["grow"]:
        return None
    try:
        w, h, _ = _size_of(fmt, board.get("size"), board.get("orientation"))
    except (KeyError, TypeError):
        return None
    return w / h


def grows(board: dict) -> bool:
    return board.get("format") in FORMATS and bool(FORMATS[board["format"]]["grow"])


def resize(board: dict, w=None, h=None) -> tuple[int, int, Optional[int]]:
    """The size a resize lands on, true to the board's format: a fixed-ratio
    board keeps its ratio, a growing one changes height only (its minimum
    height; the content can still make it taller), a custom or old board takes
    the size asked for. Returns (w, h, min_h)."""
    cw, ch = int(board.get("w") or 800), int(board.get("h") or 600)
    try:
        nw = int(w) if w is not None else cw
        nh = int(h) if h is not None else ch
    except (TypeError, ValueError):
        raise ValueError("w and h are whole pixels.") from None
    if grows(board):
        floor = FORMATS[board["format"]]["sizes"].get(board.get("size"), {}).get("h", 600)
        floor = min(floor, 600)
        min_h = max(floor, min(8000, nh))
        content = int(board.get("content_h") or 0)
        return cw, max(min_h, content), min_h
    r = ratio(board)
    if r:
        # Follow whichever edge moved more, then derive the other from the ratio.
        if abs(nw - cw) / max(cw, 1) >= abs(nh - ch) / max(ch, 1):
            nh = nw / r
        else:
            nw = nh * r
        # Within 4000x8000 and no edge under 60, still at the format's ratio.
        scale = min(1.0, 4000 / nw, 8000 / nh)
        scale = max(scale, 60 / min(nw, nh))
        return round(nw * scale), round(nh * scale), None
    return max(120, min(4000, nw)), max(120, min(8000, nh)), None


def infer(board: dict) -> dict:
    """The nearest format for a board made before formats (or a custom one),
    from its frame, its size and its title. Never changes the board."""
    frame = board.get("frame")
    title = (board.get("title") or "").lower()
    w, h = int(board.get("w") or 0), int(board.get("h") or 0)
    if frame in LEGACY_FRAMES and frame not in ("desktop", "browser"):
        fmt, size, orientation = LEGACY_FRAMES[frame]
        return resolve(fmt, size=size, orientation=orientation)[0]
    if not w or not h:
        return {}
    mobile_words = re.search(r"\b(phone|mobile|ios|android)\b", title)
    slide_words = re.search(r"\b(slide|deck|presentation)\b", title)
    poster_words = re.search(r"\b(poster|flyer)\b", title)
    if frame in ("desktop", "browser"):
        return resolve("website", size="desktop")[0]
    if slide_words or abs(w / h - 16 / 9) < 0.03 and w >= 1000:
        return resolve("slides")[0]
    if poster_words:
        orientation = "landscape" if w > h else "portrait"
        return min((resolve("poster", size=s, orientation=orientation)[0] for s in FORMATS["poster"]["sizes"]),
                   key=lambda b: abs(b["w"] / b["h"] - w / h))
    # Long pages: a website board, desktop or mobile by width (and the title's words).
    if h > w * 1.2 and (w >= 700 or w <= 520):
        size = "mobile" if mobile_words or w <= 520 else "desktop"
        return resolve("website", size=size)[0]
    if mobile_words:
        return resolve("website" if h > 1000 else "app", size="mobile" if h > 1000 else "phone",
                       orientation="portrait")[0]
    if w >= 1200 and h <= w:
        return resolve("website", size="desktop")[0]
    # Otherwise the fixed format whose ratio is closest.
    best, score = {}, math.inf
    for fid in ("social", "print", "poster", "banner", "app"):
        spec = FORMATS[fid]
        for size in spec["sizes"]:
            for orientation in spec["orientations"] or (None,):
                try:
                    cand = resolve(fid, size=size, orientation=orientation)[0]
                except ValueError:
                    continue
                d = abs(math.log((cand["w"] / cand["h"]) / (w / h)))
                if d < score:
                    best, score = cand, d
    return best


def fit(board: dict, target: Optional[dict] = None) -> dict:
    """The board's fields after "Fit to format": its nearest format (or the one
    asked for) at that format's own size. A growing format keeps the board's
    current height as content, so nothing is cut off before it is measured."""
    spec = dict(target or infer(board))
    if not spec.get("format"):
        raise ValueError("No format fits this board; choose one.")
    out = {k: spec[k] for k in ("format", "size", "orientation", "w", "h", "frame")}
    if spec.get("grow"):
        out["min_h"] = spec["min_h"]
        out["content_h"] = None
        out["h"] = max(spec["min_h"], 0)
    else:
        out["min_h"] = None
    return out


def _chrome(board: dict) -> tuple[int, int, int]:
    return CHROME.get(board.get("frame") or "none", (0, 0, 0))


def layout(boards: dict, order: list[str]) -> dict[str, tuple[int, int]]:
    """Rows grouped by format, in board order: each board's (x, y). A row is
    as tall as its tallest board; rows stack with room for their labels.
    Nothing overlaps, whatever the sizes."""
    rows: dict[str, list[str]] = {}
    for slug in order:
        rows.setdefault(section_key(boards[slug]), []).append(slug)
    out, y = {}, 0
    for key, slugs in rows.items():
        top = max(_chrome(boards[s])[0] for s in slugs) + TITLE
        y += top
        x = 0
        bottom = 0
        for slug in slugs:
            b = boards[slug]
            t, side, below = _chrome(b)
            x += side
            out[slug] = (x, y)
            x += int(b["w"]) + side + GAP
            bottom = max(bottom, int(b["h"]) + below)
        y += bottom + ROW_GAP
    return out


def sections(boards: dict, order: list[str]) -> list[dict]:
    """The row labels for the canvas: {key, label, x, y}."""
    seen: dict[str, dict] = {}
    for slug in order:
        b = boards[slug]
        key = section_key(b)
        t = _chrome(b)[0]
        top = int(b["y"]) - t
        if key not in seen:
            seen[key] = {"key": key, "label": section_label(key), "x": int(b["x"]) - _chrome(b)[1], "y": top}
        else:
            seen[key]["y"] = min(seen[key]["y"], top)
            seen[key]["x"] = min(seen[key]["x"], int(b["x"]) - _chrome(b)[1])
    return list(seen.values())
