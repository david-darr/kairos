"""Quality checks on a board that need no shell (Creative Output Quality spec, section 2).

Today a model can only check its work by rendering it itself, which takes a
shell (Claude with Bash) or the desktop app's snapshot. These checks run on
the board's HTML for every model, after every create, add and edit, and come
back as lint notes, never refusals:

- type below the floor for the board's format (slides 24px, posters 20px...);
- more than three typefaces on one board (colours outside the look are
  design_html.lint's raw-colour note);
- empty placeholder boxes and grey "skeleton" bars where content should be
  (round shapes and aria-hidden elements are decoration, never flagged);
- from the board's cached thumbnail, when the desktop app rendered one, a
  page that is mostly empty; for a document, from its cached printed pages,
  any page between the cover and the last that is mostly empty;
- on a slide, more words than one idea needs.

Contrast, raw colours and missing alt text stay in design_html.lint.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from core.design_html import Element, _resolve, _style_items

# Smallest readable text, in CSS px at the board's own size.
TYPE_FLOOR = {"slides": 24, "poster": 20, "social": 22, "banner": 12, "print": 12, "document": 13, "app": 12,
              "website": 12, "email": 12, "custom": 12}
BLANK_PAGE = 0.8           # A printed page (not the cover or the last) more than this blank.
SLIDE_WORDS = 60            # One idea per slide: more words than this reads as a document on a slide.
MAX_FAMILIES = 3
EMPTY_SHARE = 0.45          # A fixed-size board more than this blank reads as unfinished.
FIXED = ("poster", "social", "slides", "print", "banner")
_PX = re.compile(r"^(\d+(?:\.\d+)?)px$")
_CONTENT_TAGS = frozenset({"img", "svg", "picture", "video", "canvas", "input", "textarea", "select", "button"})
_SIZE_PROPS = ("width", "height", "min-height", "aspect-ratio")


def _px(value: str, tokens: dict[str, str]) -> Optional[float]:
    value = (value or "").strip()
    match = re.fullmatch(r"var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)", value)
    if match:
        value = tokens.get(match.group(1), "")
    found = _PX.match(value.strip())
    return float(found.group(1)) if found else None


def _has_content(node: Element) -> bool:
    style = dict(_style_items(node.get("style") or ""))
    if re.search(r"url\s*\(", style.get("background-image", "") + style.get("background", ""), re.I):
        return True
    if node.tag in _CONTENT_TAGS or node.text(200).strip():
        return True
    return any(child.tag in _CONTENT_TAGS for child in node.elements())


def _family(value: str, tokens: dict[str, str]) -> Optional[str]:
    match = re.fullmatch(r"var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)", (value or "").strip())
    if match:
        value = tokens.get(match.group(1), value)
    first = (value or "").split(",")[0].strip().strip("\"'")
    return first.lower() or None


def _font_parts(style: dict[str, str]) -> tuple[Optional[str], Optional[str]]:
    """(size, family) from font-size/font-family or the font shorthand."""
    size, family = style.get("font-size"), style.get("font-family")
    if "font" in style:
        match = re.search(r"(var\([^)]*\)|\d+(?:\.\d+)?px)\s*(?:/\S+)?\s+(.+)$", style["font"])
        if match:
            size = size or match.group(1)
            family = family or match.group(2)
    return size, family


def check(root: Element, board: dict, tokens: dict[str, str], thumb: Optional[Path] = None,
          pages: Optional[list[Path]] = None, *, assets: Optional[set[str]] = None,
          credits: Optional[dict] = None) -> list[str]:
    """Notes for one board. `board` is its manifest entry (format, w, h); `pages` a document's printed pages."""
    fmt = board.get("format") or "custom"
    floor = TYPE_FLOOR.get(fmt, 12)
    area = max(1, int(board.get("w") or 1) * int(board.get("h") or 1))
    small, families, boxes, bars = [], set(), [], []
    for node in root.elements():
        style = dict(_style_items(node.get("style") or ""))
        size, family = _font_parts(style)
        px = _px(size, tokens) if size else None
        if px is not None and px < floor and node.text(200).strip():
            small.append(f"{node.kd or node.tag} ({px:g}px)")
        name = _family(family, tokens) if family else None
        if name:
            families.add(name)
        if node.tag in ("div", "section", "figure", "span", "aside") and not _has_content(node):
            filled = any(p in style for p in ("background", "background-color", "border"))
            radius = style.get("border-radius", "")
            decoration = (node.get("aria-hidden") == "true" or "50%" in radius or "999" in radius
                          or "var(--ds-radius-pill)" in radius)
            if not filled or decoration:
                continue
            w, h = _px(style.get("width", ""), tokens), _px(style.get("height", "") or style.get("min-height", ""), tokens)
            pct = re.match(r"(\d+(?:\.\d+)?)%", style.get("width", ""))
            wide = (w or 0) >= 80 or (pct is not None and float(pct.group(1)) >= 20)
            # A text placeholder is a neutral bar in the flow; an accent-coloured or absolutely placed
            # strip is drawing (pixel art, rules, stripes), never flagged.
            fill = style.get("background-color") or style.get("background") or ""
            neutral = bool(re.search(r"--ds-(surface|hairline|text-dim|bg)", fill)) or bool(re.match(r"\s*#([0-9a-f])\1\1\b|\s*#([0-9a-f]{2})\2\2\b|\s*(gr[ae]y|silver|gainsboro)", fill, re.I))
            if h is not None and h <= 24 and wide and neutral and style.get("position") != "absolute":
                bars.append(node.kd or node.tag)
            elif (w and h and w * h >= 0.06 * area) or ("aspect-ratio" in style and (w or 0) >= 160) \
                    or (h is not None and h >= 160 and not w):
                boxes.append(node.kd or node.tag)
    notes = _imagery_notes(root, fmt, assets, credits)
    if small:
        notes.append(f"Text under the {fmt} floor of {floor}px: {', '.join(small[:6])}. Make it larger or cut words.")
    if len(families) > MAX_FAMILIES:
        notes.append(f"{len(families)} typefaces on one board ({', '.join(sorted(families)[:5])}); "
                     f"keep to var(--ds-font-display) and var(--ds-font-sans).")
    if boxes:
        notes.append(f"Empty placeholder box{'es' if len(boxes) > 1 else ''} {', '.join(boxes[:5])}: put real content there "
                     "(text, a chart, an image from the design's assets) or remove it.")
    if len(bars) >= 3:
        notes.append(f"{len(bars)} grey placeholder bars ({', '.join(bars[:5])}) stand in for text; write the real text.")
    empty = empty_share(thumb) if thumb is not None and fmt in FIXED else None
    if empty is not None and empty > EMPTY_SHARE:
        notes.append(f"About {round(empty * 100)}% of this {fmt} is blank in its render; scale the content to fill the board.")
    if fmt == "slides":
        words = _words(root)
        if words > SLIDE_WORDS:
            notes.append(f"{words} words on one slide; a slide carries one idea. Cut to the point, or split it "
                         "into two slides and move the detail to the speaker's notes.")
    # Printed pages: the cover (page 1) and the last page may be sparse; a page between them more than
    # BLANK_PAGE blank is a section cut off by a forced break (Phase 2 benchmark: such pages measured 0.91
    # and 0.93; full pages, margins and all, measured 0.40 to 0.67, covers up to 0.79).
    blank = [n for n, page in enumerate((pages or [])[1:-1], 2) if (empty_share(page) or 0) > BLANK_PAGE]
    if blank:
        notes.append(f"Page{'s' if len(blank) > 1 else ''} {', '.join(map(str, blank[:6]))} of the printed document "
                     f"{'are' if len(blank) > 1 else 'is'} mostly blank: a section ran a few lines past a page before a "
                     "data-kd-page-break, or a kept-together block didn't fit. Remove that page break (let sections "
                     "follow on) or let the block split.")
    return notes


def _imagery_notes(root: Element, fmt: str, assets: Optional[set[str]], credits: Optional[dict]) -> list[str]:
    picture, drawn, used = False, False, set()
    shapes = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
    for node in root.elements():
        style = dict(_style_items(node.get("style") or ""))
        background = style.get("background-image", "") or style.get("background", "")
        if (node.tag in ("img", "picture", "svg") or
                node.tag == "figure" and node.get("data-chart") is not None or
                "background-image" in style or re.search(r"url\s*\(", background, re.I)):
            picture = True
        paths = [node.get("src") or ""] if node.tag == "img" else []
        paths += [m.group(2).strip() for m in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", node.get("style") or "", re.I)]
        for path in paths:
            match = re.fullmatch(r"assets/([^/?#]+)(?:[?#].*)?", path)
            if match:
                used.add(match.group(1))
        if node.tag == "svg" and fmt in ("poster", "social", "banner", "slides"):
            ancestor = node
            chart = False
            while ancestor is not None:
                chart |= ancestor.get("data-kd-chart-out") is not None
                chart |= ancestor.tag == "figure" and ancestor.get("data-chart") is not None
                ancestor = ancestor.parent
            if not chart and sum(child.tag in shapes for child in node.elements()) > 40:
                drawn = True
    notes = []
    if fmt in ("poster", "social", "banner") and not picture:
        notes.append(f"This {fmt} has no picture. Add one: image_generate (if connected), image_search for a licensed photo, "
                     "image_treat on the person's photo, or image_pattern for a texture. A finished "
                     f"{fmt} has a picture or a texture; place it with design_edit.")
    text = _board_text(root).casefold()
    for name in sorted(used):
        if assets is not None and name not in assets:
            notes.append(f"Image {name} isn't in this design's assets; use a path an image tool returned.")
        credit = (credits or {}).get(f"assets/{name}") or {}
        creator = credit.get("creator") or ""
        if creator and creator.casefold() not in text:
            license = str(credit.get("license") or "").upper()
            version = str(credit.get("license_version") or "")
            label = f"{license} {version}".strip()
            notes.append(f'Photo by {creator} needs its credit on the board: "Photo: {credit.get("title") or ""} '
                         f'by {creator}, {label}" in small type.')
    if drawn:
        notes.append("This board draws a picture in code; use a real image (image_generate, image_search, image_treat) "
                     "or a pattern (image_pattern) instead.")
    return notes


def _board_text(node: Element) -> str:
    """Visible copy only: attributes, styles and hidden chart tables cannot supply a credit."""
    parts = []
    for child in node.children:
        if isinstance(child, Element):
            if child.tag not in ("style", "svg") and child.get("hidden") is None and child.get("aria-hidden") != "true":
                parts.append(_board_text(child))
        else:
            parts.append(child.data)
    return " ".join(parts)


def _words(node) -> int:
    """Words a viewer reads: not a chart's hidden table, its drawing, or styles."""
    count = 0
    for child in node.children:
        if isinstance(child, Element):
            if child.tag not in ("svg", "style") and child.get("hidden") is None:
                count += _words(child)
        else:
            count += sum(1 for w in child.data.split() if any(ch.isalnum() for ch in w))
    return count


def empty_share(png: Path, tile: int = 24) -> Optional[float]:
    """The share of the render's tiles that are one flat colour (from the cached thumbnail)."""
    if not png or not Path(png).is_file():
        return None
    try:
        from PIL import Image
        image = Image.open(png).convert("L")
    except Exception:
        return None
    width, height = image.size
    if width < tile * 2 or height < tile * 2:
        return None
    flat = total = 0
    for y in range(0, height - tile + 1, tile):
        for x in range(0, width - tile + 1, tile):
            low, high = image.crop((x, y, x + tile, y + tile)).getextrema()
            total += 1
            flat += (high - low) < 6
    return flat / total if total else None
