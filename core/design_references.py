"""Styles from references (Creative Output Quality spec, Phase 1b).

A person sends photos, screenshots, a PDF, a PowerPoint or a Word file, and
Kairos turns them into a style: a look in the same shape as the bundled ones
(core/design_looks.py), so every model and tool uses it the same way.

Everything here is local and deterministic, with no model call and no network:

- photos and screenshots: a palette (Pillow median cut on a downscaled copy);
- PDF: its first pages rendered with pypdfium2 and read the same way, plus the
  font names it declares;
- PowerPoint and Word: the document theme, which holds the exact brand colours
  (dark 1/2, light 1/2, accents 1-6) and the heading and body fonts. Read through
  office_preview's archive guard and with plain pattern matching, never a full
  XML parser, so a hostile file can't expand entities;
- colours get roles (background, text, accent...), every text pair is pushed to
  WCAG AA, and each change is reported in plain words;
- fonts are matched to the bundled OFL families, never copied out of a file
  (David, D11: bundled fonts only);
- only values are kept (David, D12): the references are read and dropped.

Reference files are untrusted. They are parsed for colour and theme values only,
under the caps below; names read from them are clipped before they reach a reply.
"""
from __future__ import annotations

import colorsys
import re
import secrets
import zipfile
from pathlib import Path
from typing import Optional

from core import design_looks

MAX_FILES = 8
MAX_BYTES = 25 * 1024 * 1024
MAX_PDF_PAGES = 3
MAX_PIXELS = 40_000_000           # Pillow's own bomb guard, set explicitly.
MAX_THEME_BYTES = 1024 * 1024
PALETTE_SIZE = 16                 # Enough slots that a small accent isn't averaged into its neighbours (JPEG noise in PDFs);
                                  # _merge folds the near-duplicates back together.
KINDS = ("image", "pdf", "pptx", "docx")

# Font names (lower case, no spaces) the bundle has under the same name.
_SAME_NAME = {re.sub(r"[^a-z0-9]", "", name.lower()): key for key, (name, _) in design_looks.FAMILIES.items()}
_SAME_NAME.update({"ibmplex": "ibmplexsans", "playfair": "playfairdisplay", "garamond": "ebgaramond",
                   "sourceserif": "sourceserif4", "sourceserifpro": "sourceserif4", "bebas": "bebasneue",
                   "barlow": "barlowcondensed", "jetbrains": "jetbrainsmono", "pressstart": "pressstart2p"})
# Common commercial and system families by kind, matched by words in the name.
_KINDS = (
    ("mono", ("mono", "code", "consol", "courier", "menlo", "monaco", "typewriter"), "jetbrainsmono", "jetbrainsmono"),
    ("condensed", ("condensed", "narrow", "compressed", "impact", "league gothic", "knockout", "druk", "anton"),
     "oswald", "barlowcondensed"),
    ("script", ("script", "hand", "brush", "pacifico", "lobster"), "instrumentserif", "dmsans"),
    ("serif", ("serif", "garamond", "times", "georgia", "baskerville", "caslon", "minion", "cambria", "book antiqua",
               "palatino", "didot", "bodoni", "tiempos", "freight", "merriweather", "charter", "constantia", "roman",
               "century schoolbook", "goudy", "sabon", "domine", "bitter", "slab"), "fraunces", "sourceserif4"),
    ("geometric", ("futura", "avenir", "gotham", "montserrat", "poppins", "century gothic", "proxima", "circular",
                   "gilroy", "sofia", "brandon", "nexa"), "outfit", "manrope"),
)
DEFAULT_SANS = ("inter", "inter")


class ReferenceError(ValueError):
    """A reference that can't be read; the message says why in plain words."""


def kind_of(path: Path, name: str = "") -> Optional[str]:
    """What a file is, from its bytes (never only its name)."""
    with open(path, "rb") as handle:
        head = handle.read(16)
    if head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff") or (head.startswith(b"RIFF") and head[8:12] == b"WEBP"):
        return "image"
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
        except zipfile.BadZipFile:
            return None
        if "ppt/presentation.xml" in names:
            return "pptx"
        if "word/document.xml" in names:
            return "docx"
    return None


def _palette(image, weight: float = 1.0) -> list[tuple[str, float]]:
    from PIL import Image
    image = image.convert("RGB")
    image.thumbnail((200, 200))
    quantized = image.quantize(colors=PALETTE_SIZE, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()[: PALETTE_SIZE * 3]
    counts = quantized.getcolors() or []
    total = sum(c for c, _ in counts) or 1
    return [(design_looks.to_hex(palette[i * 3:i * 3 + 3]), weight * c / total) for c, i in counts]


def _image(path: Path) -> dict:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path) as image:
            return {"palette": _palette(image)}
    except Image.DecompressionBombError:
        raise ReferenceError("this image is too large to read safely")
    except Exception:
        raise ReferenceError("this image could not be read")


def _pdf(path: Path) -> dict:
    import pypdfium2 as pdfium
    try:
        doc = pdfium.PdfDocument(str(path))
    except Exception:
        raise ReferenceError("this PDF could not be read")
    try:
        palette = []
        pages = min(MAX_PDF_PAGES, len(doc))
        for n in range(pages):
            # The first page (usually the cover, where the brand is) counts double.
            palette += _palette(doc[n].render(scale=0.6).to_pil(), 2.0 if n == 0 else 1.0)
    finally:
        doc.close()
    raw = path.read_bytes()
    fonts = []
    for match in re.findall(rb"/BaseFont\s*/([A-Za-z0-9+\-_,]{1,80})", raw):
        name = re.sub(r"^[A-Z]{6}\+", "", match.decode("latin1")).split(",")[0]
        name = re.sub(r"-(Bold|Italic|Regular|Medium|Light|Semibold|SemiBold|Black|Oblique|BoldItalic)+$", "", name)
        if name and name not in fonts:
            fonts.append(name)
    return {"palette": palette, "fonts": fonts[:12]}


_THEME_ROLES = ("dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6")


def _office(path: Path, kind: str) -> dict:
    from core import office_preview
    try:
        office_preview._guard_archive(path)
    except office_preview.PreviewUnavailable as error:
        raise ReferenceError(str(error).rstrip(".").lower().replace("this file", "this file"))
    folder = "ppt/theme/" if kind == "pptx" else "word/theme/"
    with zipfile.ZipFile(path) as archive:
        themes = sorted(n for n in archive.namelist() if n.startswith(folder) and n.endswith(".xml"))
        if not themes:
            raise ReferenceError("this file has no theme to read colours and fonts from")
        info = archive.getinfo(themes[0])
        if info.file_size > MAX_THEME_BYTES:
            raise ReferenceError("this file's theme is too large to read safely")
        text = archive.read(themes[0]).decode("utf-8", "replace")
    colors = {}
    for role in _THEME_ROLES:
        block = re.search(rf"<a:{role}>(.*?)</a:{role}>", text, re.S)
        if not block:
            continue
        found = re.search(r'srgbClr\s+val="([0-9A-Fa-f]{6})"', block.group(1)) or \
            re.search(r'sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"', block.group(1))
        if found:
            colors[role] = "#" + found.group(1).upper()
    fonts = {}
    for role, tag in (("display", "majorFont"), ("body", "minorFont")):
        block = re.search(rf"<a:{tag}>(.*?)</a:{tag}>", text, re.S)
        latin = block and re.search(r'<a:latin\s+typeface="([^"]{1,60})"', block.group(1))
        if latin and latin.group(1).strip():
            fonts[role] = latin.group(1).strip()
    return {"theme": colors, "theme_fonts": fonts}


def read(path: Path, name: str) -> dict:
    """One reference's evidence: {kind, name, palette?, fonts?, theme?, theme_fonts?}."""
    if path.stat().st_size > MAX_BYTES:
        raise ReferenceError("this file is over 25 MB")
    kind = kind_of(path, name)
    if kind is None:
        raise ReferenceError("this isn't a photo, screenshot, PDF, PowerPoint or Word file")
    found = {"image": _image, "pdf": _pdf}.get(kind)
    evidence = found(path) if found else _office(path, kind)
    return {"kind": kind, "name": _clip(name), **evidence}


def _clip(text: str, limit: int = 80) -> str:
    return re.sub(r"[\x00-\x1f<>]", "", str(text or ""))[:limit]


# -- colour roles ----------------------------------------------------------------

def _hls(value: str) -> tuple[float, float, float]:
    r, g, b = (c / 255 for c in design_looks._rgb(value))
    return colorsys.rgb_to_hls(r, g, b)


def _distance(a: str, b: str) -> float:
    return sum((x - y) ** 2 for x, y in zip(design_looks._rgb(a), design_looks._rgb(b))) ** 0.5


def _merge(palette: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Near-duplicate colours merged, heaviest first."""
    merged: list[list] = []
    for color, weight in sorted(palette, key=lambda item: -item[1]):
        for item in merged:
            if _distance(item[0], color) < 28:
                item[1] += weight
                break
        else:
            merged.append([color, weight])
    total = sum(w for _, w in merged) or 1
    return [(c, w / total) for c, w in merged]


def _vivid(color: str) -> float:
    _, light, sat = _hls(color)
    return sat * (1 - abs(light - 0.5) * 1.4)


def roles_from_palette(palette: list[tuple[str, float]], notes: Optional[list] = None) -> dict:
    colors = _merge(palette)
    if not colors:
        raise ReferenceError("no colours could be read from the references")
    bg = colors[0][0]
    text = max((c for c, _ in colors), key=lambda c: design_looks._contrast(c, bg))
    if design_looks._contrast(text, bg) < 7:
        text = design_looks.readable(design_looks.mix(text, "#000000" if _hls(bg)[1] >= 0.5 else "#FFFFFF", 0.5), bg, 7.0)
    candidates = [(c, w) for c, w in colors if c not in (bg, text) and w >= 0.02 and _vivid(c) >= 0.18]
    accent = max(candidates, key=lambda item: _vivid(item[0]) * (item[1] ** 0.35))[0] if candidates else None
    if accent is None:  # A muted reference: the most colourful thing in it, made a little stronger.
        hue_source = max((c for c, _ in colors), key=_vivid)
        h, light, sat = _hls(hue_source)
        accent = design_looks.to_hex([v * 255 for v in colorsys.hls_to_rgb(h, 0.45, max(sat, 0.5))])
    second = [c for c, _ in candidates if c != accent and abs(_hls(c)[0] - _hls(accent)[0]) * 360 > 40]
    accent2 = second[0] if second else design_looks.mix(accent, text, 0.45)
    return _complete({"bg": bg, "text": text, "accent": accent, "accent-2": accent2}, notes=notes)


def roles_from_theme(theme: dict, notes: Optional[list] = None) -> dict:
    """An Office theme's scheme: light 1 is the page, dark 1 the text, accents 1 and 2 the accents."""
    bg = theme.get("lt1", "#FFFFFF")
    text = theme.get("dk1", "#111111")
    accents = [theme[f"accent{n}"] for n in range(1, 7) if f"accent{n}" in theme]
    accent = accents[0] if accents else theme.get("dk2", text)
    accent2 = accents[1] if len(accents) > 1 else design_looks.mix(accent, text, 0.45)
    surface = theme.get("lt2") if theme.get("lt2") and _distance(theme["lt2"], bg) < 60 else None
    return _complete({"bg": bg, "text": text, "accent": accent, "accent-2": accent2}, surface=surface, notes=notes)


def settle_background(bg: str) -> tuple[str, Optional[str]]:
    """A mid-tone page (neither black nor white text reaches 7:1 on it) moved to clearly light or clearly
    dark, keeping its hue: otherwise no text colour reads on both the page and its cards."""
    if max(design_looks._contrast(bg, "#111111"), design_looks._contrast(bg, "#FFFFFF")) >= 7:
        return bg, None
    h, light, s = _hls(bg)
    target = 0.93 if light >= 0.45 else 0.12
    settled = design_looks.to_hex([v * 255 for v in colorsys.hls_to_rgb(h, target, min(s, 0.6))])
    return settled, f"background {'lightened' if target > light else 'darkened'} from {bg.upper()} to {settled} so text reads on it and on cards"


def _complete(core: dict, surface: Optional[str] = None, notes: Optional[list] = None) -> dict:
    bg, note = settle_background(core["bg"])
    if note and notes is not None:
        notes.append(note)
    text, accent = core["text"], core["accent"]
    dark = _hls(bg)[1] < 0.5
    color = {
        "bg": bg.upper(),
        "surface": (surface or design_looks.mix(bg, "#FFFFFF" if not dark else text, 0.06 if dark else 0.55)).upper(),
        "surface-2": design_looks.mix(bg, text, 0.08),
        "text": text.upper(),
        "text-dim": design_looks.mix(text, bg, 0.32),
        "accent": accent.upper(),
        "accent-text": accent.upper(),
        "on-accent": "#111111" if design_looks._contrast("#111111", accent) >= design_looks._contrast("#FFFFFF", accent) else "#FFFFFF",
        "accent-2": core["accent-2"].upper(),
        "hairline": design_looks.mix(bg, text, 0.2),
        "hairline-soft": design_looks.mix(bg, text, 0.1),
        "danger": "#B3261E" if not dark else "#FF8A80",
        "success": "#2E7D32" if not dark else "#81C784",
    }
    return color


# -- fonts, shape and mood ---------------------------------------------------------

def match_font(name: str, role: str) -> Optional[str]:
    """The bundled family for a reference's font name, or None when the name says nothing."""
    key = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    if not key:
        return None
    for known, bundled in _SAME_NAME.items():
        if key == known or (len(known) >= 4 and key.startswith(known)):
            return bundled
    words = (name or "").lower()
    for _, hints, display, body in _KINDS:
        if any(hint in words for hint in hints):
            return display if role == "display" else body
    return None


def _fonts(evidence: list[dict], color: dict, mood: list[str]) -> tuple[dict, list[str]]:
    notes = []
    named = {}
    for item in evidence:
        for role, value in (item.get("theme_fonts") or {}).items():
            named.setdefault(role, value)
    pdf_fonts = [f for item in evidence for f in item.get("fonts") or []]
    if pdf_fonts:
        named.setdefault("display", pdf_fonts[0])
        named.setdefault("body", pdf_fonts[1] if len(pdf_fonts) > 1 else pdf_fonts[0])
    chosen = {}
    for role in ("display", "body"):
        source = named.get(role)
        match = match_font(source, role) if source else None
        if source and match:
            notes.append(f"{role} font {_clip(source, 40)} -> {design_looks.FAMILIES[match][0]}")
        chosen[role] = match
    if not chosen["display"] or not chosen["body"]:
        guess = _font_guess(color, mood)
        chosen["display"] = chosen["display"] or guess[0]
        chosen["body"] = chosen["body"] or guess[1]
    return chosen, notes


def _font_guess(color: dict, mood: list[str]) -> tuple[str, str]:
    """Fonts for a photo, which names none: from the mood its colours give."""
    if "dramatic" in mood:
        # Dark and vivid (a game, a launch at night) is energetic; dark and calm is an evening.
        return ("spacegrotesk", "inter") if "vivid" in mood or "cool" in mood else ("dmserifdisplay", "dmsans")
    if "vivid" in mood:
        return ("bricolagegrotesque", "dmsans")
    if "warm" in mood and "calm" in mood:
        return ("fraunces", "manrope")
    if "calm" in mood:
        return ("instrumentserif", "dmsans")
    return DEFAULT_SANS


def _mood(color: dict) -> list[str]:
    _, bg_light, _ = _hls(color["bg"])
    hue, _, sat = _hls(color["accent"])
    words = ["dramatic" if bg_light < 0.35 else "airy" if bg_light > 0.85 else "grounded"]
    words.append("warm" if hue < 0.14 or hue > 0.9 else "cool" if 0.45 < hue < 0.75 else "fresh")
    words.append("vivid" if sat > 0.65 and _vivid(color["accent"]) > 0.4 else "calm")
    return words


def _shape(color: dict, mood: list[str]) -> dict:
    if "vivid" in mood and "airy" in mood:
        button, radius = "pill", "18px"
    elif "dramatic" in mood:
        button, radius = "soft", "10px"
    elif "calm" in mood:
        button, radius = "soft", "14px"
    else:
        button, radius = "square", "4px"
    return {"radius": radius, "button": button, "border": "1px", "label_case": "upper" if "dramatic" in mood else "none",
            "label_tracking": "0.1em" if "dramatic" in mood else "0.02em", "display_weight": "600", "display_style": "normal"}


_STOP = frozenset("a an and the for of my our your to in on with from style look brand new make this that these those "
                  "please like it its is are be".split())


def _tags(name: str, notes: str, evidence: list[dict]) -> list[str]:
    words = re.findall(r"[a-z][a-z0-9'-]{2,}", f"{name} {notes}".lower())
    stems = [Path(item["name"]).stem.lower() for item in evidence]
    words += [w for stem in stems for w in re.findall(r"[a-z][a-z0-9]{2,}", stem)]
    out = []
    for word in words:
        if word not in _STOP and word not in out:
            out.append(word)
    return out[:16]


def draft(evidence: list[dict], name: str, notes: str = "") -> dict:
    """A style (look.json shape, validated) from the evidence of one or more references, plus
    `changes`: what was matched or repaired, in plain words, and `sources`: the file names."""
    if not evidence:
        raise ReferenceError("send at least one photo, screenshot, PDF, PowerPoint or Word file")
    theme = next((item["theme"] for item in evidence if item.get("theme") and len(item["theme"]) >= 3), None)
    if theme:
        changes = [f"colours from the theme of {next(i['name'] for i in evidence if i.get('theme'))}"]
        color = roles_from_theme(theme, changes)
    else:
        changes = [f"colours read from {len(evidence)} reference{'s' if len(evidence) != 1 else ''}"]
        color = roles_from_palette([c for item in evidence for c in item.get("palette") or []], changes)
    changes += design_looks.repair(color)
    mood = _mood(color)
    fonts, font_notes = _fonts(evidence, color, mood)
    changes += font_notes
    name = _clip(name or "My style", 60).strip() or "My style"
    look = {
        "name": name, "mood": mood, "tags": _tags(name, notes, evidence),
        "good_for": ["poster", "screen", "website", "slides", "social", "print", "email", "banner"],
        "fonts": fonts, "office_fonts": {"display": "Segoe UI Semibold", "body": "Segoe UI"},
        "color": color, "shape": _shape(color, mood),
        "imagery": f"in the spirit of the references ({', '.join(i['name'] for i in evidence)[:120]})",
        "archetypes": ["hero-split", "poster-stack", "bento", "editorial-column", "big-number"],
        "guide": f"{name}: made from {len(evidence)} reference{'s' if len(evidence) != 1 else ''}. "
                 f"{', '.join(mood).capitalize()}. Use var(--ds-accent) for the one moment that matters.",
    }
    design_looks._validate("draft", look)  # Raises if anything is still off; repair() makes this pass.
    return {"look": look, "changes": changes, "sources": [i["name"] for i in evidence]}


def adjust(look: dict, *, colors: Optional[dict] = None, fonts: Optional[dict] = None,
           shape: Optional[dict] = None, name: Optional[str] = None) -> tuple[dict, list[str]]:
    """A person's or a model's edits to a draft, checked the same way: colours must be #RRGGBB and are
    repaired to AA, fonts must be bundled families, shape values from the known set."""
    look = {**look, "color": dict(look["color"]), "fonts": dict(look["fonts"]), "shape": dict(look["shape"])}
    for role, value in (colors or {}).items():
        if role not in look["color"]:
            raise ReferenceError(f"no colour role `{role}`; roles: {', '.join(look['color'])}")
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(value)):
            raise ReferenceError(f"{role} must be a colour like #1A2B3C")
        look["color"][role] = str(value).upper()
    for role, value in (fonts or {}).items():
        key = value if value in design_looks.FAMILIES else match_font(str(value), role)
        if role not in ("display", "body") or not key:
            raise ReferenceError(f"fonts are bundled families only: {', '.join(n for n, _ in design_looks.FAMILIES.values())}")
        look["fonts"][role] = key
    for key, value in (shape or {}).items():
        allowed = {"button": design_looks.BUTTONS, "label_case": ("upper", "none"), "display_style": ("normal", "italic")}
        if key == "radius" and re.fullmatch(r"\d{1,2}px", str(value)):
            look["shape"]["radius"] = str(value)
        elif key in allowed and value in allowed[key]:
            look["shape"][key] = value
        else:
            raise ReferenceError(f"shape {key}={value} isn't allowed")
    if name:
        look["name"] = _clip(name, 60).strip() or look["name"]
    notes = design_looks.repair(look["color"])
    design_looks._validate("draft", look)
    return look, notes


def new_id(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "style").lower()).strip("-")[:28] or "style"
    return f"{base}-{secrets.token_hex(3)}"


# -- drafts: a style before it is saved, kept for an hour, values only ------------------

DRAFT_SECONDS = 3600
DRAFT_RE = re.compile(r"draft-[0-9a-f]{12}")


def _drafts_dir() -> Path:
    from core.constants import DATA_DIR
    return Path(DATA_DIR, "design_style_drafts")


def _prune() -> None:
    import time
    folder = _drafts_dir()
    if folder.is_dir():
        for path in folder.glob("draft-*.json"):
            try:
                if time.time() - path.stat().st_mtime > DRAFT_SECONDS:
                    path.unlink()
            except OSError:
                pass


def save_draft(result: dict, owner: str, draft_id: Optional[str] = None) -> dict:
    """Keep a draft (its look, changes and file names; never the files) for its owner."""
    import json
    import time
    from core.atomic_io import write_json_atomic
    _prune()
    draft_id = draft_id or f"draft-{secrets.token_hex(6)}"
    folder = _drafts_dir()
    folder.mkdir(parents=True, exist_ok=True)
    record = {"id": draft_id, "owner": owner, "created": time.time(), "look": {**result["look"], "id": draft_id},
              "changes": result.get("changes", []), "sources": result.get("sources", [])}
    write_json_atomic(str(folder / f"{draft_id}.json"), json.loads(json.dumps(record)))
    return record


def load_draft(draft_id: str, owner: Optional[str] = None) -> dict:
    """A draft by id; with an owner, only that person's."""
    from core.atomic_io import read_json
    _prune()
    if not DRAFT_RE.fullmatch(draft_id or ""):
        raise LookupError("No such draft; make one again from the references.")
    record = read_json(str(_drafts_dir() / f"{draft_id}.json"), None)
    if not isinstance(record, dict) or (owner is not None and record.get("owner") != owner):
        raise LookupError("No such draft (drafts last an hour); make one again from the references.")
    return record


def drop_draft(draft_id: str) -> None:
    if DRAFT_RE.fullmatch(draft_id or ""):
        try:
            (_drafts_dir() / f"{draft_id}.json").unlink()
        except OSError:
            pass


def describe(record: dict) -> str:
    """A draft as plain text for a model: every role with its value, fonts, shape, what changed."""
    look = record["look"]
    color = look["color"]
    fonts = {role: design_looks.FAMILIES[key][0] for role, key in look["fonts"].items()}
    lines = [f"Draft {record['id']} \"{look['name']}\" from {', '.join(record['sources'])}.",
             "Colours: " + ", ".join(f"{role} {value}" for role, value in color.items()) + ".",
             f"Fonts (bundled only): display {fonts['display']}, body {fonts['body']}.",
             f"Shape: {look['shape']['button']} buttons, corners {look['shape']['radius']}; mood {', '.join(look['mood'])}."]
    if record.get("changes"):
        lines.append("What Kairos did: " + "; ".join(record["changes"]) + ".")
    return "\n".join(lines)
