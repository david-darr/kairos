"""Design systems for the Design canvas (spec 3d).

A system is tokens (colour roles, fonts, a size and spacing scale, radii,
shadows, the hairline), the `--ds-*` CSS generated from them, a few named
component snippets models copy, and a short guide. Boards use the variables,
never raw values, which is what lets a whole design switch systems in one
click.

The built-in "Kairos" system is the default. Its colours and fonts are read
from the app's own brand layer (static/css/kairos-theme.css) at import, so it
cannot drift from the theme; scripts/test_design_canvas.py pins the mapping.
Saved systems live in DATA_DIR/design_systems/<id>/ (tokens.json, guide.md,
components.html), written only by an admin through design_system_save or the
Tool Store.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
from pathlib import Path
from typing import Optional

from core import design_looks
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR, STATIC_DIR

SYSTEMS_DIR = os.path.join(DATA_DIR, "design_systems")
BUILTIN_ID = "kairos"
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
_lock = threading.Lock()

# Kairos role -> the brand variable it comes from (kairos-theme.css).
KAIROS_MAP = {
    "bg": "--k-parchment", "surface": "--k-surface", "surface-2": "--k-surface-2",
    "text": "--k-ink", "text-dim": "--k-ink-dim", "text-faint": "--k-ink-faint",
    "accent": "--k-gold", "accent-hi": "--k-gold-hi", "accent-text": "--k-gold-text", "on-accent": "--k-ink",
    "danger": "--k-danger", "success": "--k-success", "rose": "--k-rose", "powder": "--k-powder",
    "hairline": "--k-hairline", "hairline-soft": "--k-hairline-soft",
}
ROLES = ("bg", "surface", "text", "text-dim", "accent", "accent-text", "danger", "success")
SCALES = {
    "size": {"1": "12px", "2": "14px", "3": "16px", "4": "20px", "5": "28px", "6": "40px", "7": "56px"},
    "space": {"1": "4px", "2": "8px", "3": "12px", "4": "16px", "5": "24px", "6": "32px", "7": "48px", "8": "64px"},
    "radius": {"s": "6px", "m": "12px", "l": "20px", "pill": "999px"},
}


def _theme_values() -> dict[str, str]:
    text = Path(STATIC_DIR, "css", "kairos-theme.css").read_text(encoding="utf-8")
    block = text[text.find(":root {"):]
    block = block[:block.find("\n}")]
    return {name: value.strip() for name, value in re.findall(r"(--k-[a-z0-9-]+)\s*:\s*([^;]+);", block)}


def _fonts_from_theme(values: dict[str, str]) -> dict[str, str]:
    # display is the headline face every look has (core/design_looks.py); Kairos's is its serif.
    return {"sans": values.get("--k-font-sans", "system-ui, sans-serif"),
            "serif": values.get("--k-font-serif", "serif"),
            "display": values.get("--k-font-serif", "serif")}


def kairos_tokens() -> dict:
    values = _theme_values()
    color = {role: {"$type": "color", "$value": values[var]} for role, var in KAIROS_MAP.items() if var in values}
    return {
        "$name": "Kairos", "$description": "Parchment & Bistre: the Kairos brand.",
        "color": color,
        "font": {name: {"$type": "fontFamily", "$value": value} for name, value in _fonts_from_theme(values).items()},
        **{scale: {key: {"$type": "dimension", "$value": value} for key, value in items.items()}
           for scale, items in SCALES.items()},
        "shadow": {"1": {"$type": "shadow", "$value": "0 1px 2px rgba(58, 42, 32, .08), 0 2px 8px rgba(58, 42, 32, .06)"},
                   "2": {"$type": "shadow", "$value": "0 8px 28px rgba(58, 42, 32, .14)"}},
    }


KAIROS_FONT_FACES = (
    ("Jost", "Jost-Variable.woff2", "100 900", "normal"),
    ("Cormorant Garamond", "CormorantGaramond-Italic-Variable.woff2", "300 700", "italic"),
)
KAIROS_GUIDE = """# Kairos design system
Warm, calm and precise: parchment grounds, bistre ink, a gold point.
- Grounds: var(--ds-bg) for the page, var(--ds-surface) for cards and inputs.
- Text: var(--ds-text); secondary var(--ds-text-dim). Links and focus: var(--ds-accent-text).
- Gold (var(--ds-accent)) is for hairlines, icons and the one point of emphasis. Never text.
- Hairlines: 1px solid var(--ds-hairline). Radius var(--ds-radius-m) for cards, pill for buttons.
- Type: var(--ds-font-sans) (Jost) for everything; var(--ds-font-serif) (Cormorant italic) only for a display line.
- Spacing comes from var(--ds-space-1..8). Buttons are at least 44px tall.
"""
COMPONENTS = """<button data-kd-component="button.primary" style="min-height: 44px; padding: 0 var(--ds-space-5); border: 0; border-radius: var(--ds-radius-pill); background: var(--ds-text); color: var(--ds-bg); font: 500 var(--ds-size-3) var(--ds-font-sans)">Continue</button>
<button data-kd-component="button.secondary" style="min-height: 44px; padding: 0 var(--ds-space-5); border: 1px solid var(--ds-hairline); border-radius: var(--ds-radius-pill); background: var(--ds-surface); color: var(--ds-text); font: 500 var(--ds-size-3) var(--ds-font-sans)">Not now</button>
<label data-kd-component="input" style="display: grid; gap: var(--ds-space-2); color: var(--ds-text-dim); font-size: var(--ds-size-2)">Email<input placeholder="you@example.com" style="min-height: 44px; padding: 0 var(--ds-space-4); border: 1px solid var(--ds-hairline); border-radius: var(--ds-radius-m); background: var(--ds-surface); color: var(--ds-text); font: var(--ds-size-3) var(--ds-font-sans)"></label>
<div data-kd-component="card" style="padding: var(--ds-space-5); border: 1px solid var(--ds-hairline-soft); border-radius: var(--ds-radius-m); background: var(--ds-surface); box-shadow: var(--ds-shadow-1)"><h3 style="margin: 0 0 var(--ds-space-2); font-size: var(--ds-size-4)">Card title</h3><p style="margin: 0; color: var(--ds-text-dim)">Supporting text.</p></div>
<div data-kd-component="list.row" style="display: flex; align-items: center; gap: var(--ds-space-3); min-height: 56px; padding: 0 var(--ds-space-4); border-bottom: 1px solid var(--ds-hairline-soft)"><span style="flex: 1">List item</span><span style="color: var(--ds-text-dim)">Detail</span></div>
<header data-kd-component="nav.bar" style="display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 var(--ds-space-4); border-bottom: 1px solid var(--ds-hairline-soft)"><strong style="font-size: var(--ds-size-4)">Title</strong><button style="min-width: 44px; min-height: 44px; border: 0; background: none; color: var(--ds-accent-text)">Edit</button></header>
<nav data-kd-component="tab.bar" style="display: flex; justify-content: space-around; height: 64px; border-top: 1px solid var(--ds-hairline-soft); background: var(--ds-surface)"><button style="min-width: 64px; border: 0; background: none; color: var(--ds-text)">Home</button><button style="min-width: 64px; border: 0; background: none; color: var(--ds-text-dim)">Search</button><button style="min-width: 64px; border: 0; background: none; color: var(--ds-text-dim)">Profile</button></nav>"""


def _flat(tokens: dict) -> dict[str, str]:
    """{'--ds-bg': '#F3EADB', ...} from a tokens.json tree."""
    out: dict[str, str] = {}
    for group, items in tokens.items():
        if group.startswith("$") or not isinstance(items, dict):
            continue
        for name, token in items.items():
            value = token.get("$value") if isinstance(token, dict) else token
            if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9-]{1,40}", str(name)):
                continue
            key = f"--ds-{name}" if group == "color" else f"--ds-{group}-{name}"
            out[key] = value
    return out


def variables(tokens: dict, overrides: Optional[dict] = None) -> dict[str, str]:
    flat = _flat(tokens)
    for key, value in (overrides or {}).items():
        if key in flat and _safe_value(value):
            flat[key] = value
    return flat


def _safe_value(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 200 and not re.search(r"[;{}<>\\]|url\(|expression|@import", value, re.I)


def tokens_css(tokens: dict, overrides: Optional[dict] = None) -> str:
    lines = [f"  {key}: {value};" for key, value in variables(tokens, overrides).items()]
    return ":root {\n" + "\n".join(lines) + "\n}\n"


def font_faces(system_id: str, base: str) -> str:
    """@font-face rules, from the design's own font route only (no CDN). A bundled look's
    files are named by alias (`fraunces-0.ttf`); design_looks maps them back."""
    faces = KAIROS_FONT_FACES if system_id == BUILTIN_ID else tuple(
        (f.get("family"), f.get("file"), f.get("weight", "400"), f.get("style", "normal"))
        for f in (get(system_id) or {}).get("fonts", []) if isinstance(f, dict))
    rules = []
    for family, file, weight, style in faces:
        if not family or not file or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}\.(?:woff2?|ttf|otf)", file):
            continue
        family = re.sub(r"[\"\\;{}<>]", "", family)[:60]
        folder = "kairos" if system_id == BUILTIN_ID else system_id
        rules.append(f'@font-face {{ font-family: "{family}"; src: url("{base}/{folder}/{file}"); '
                     f'font-weight: {weight}; font-style: {style}; font-display: block; }}')
    return "\n".join(rules)


def font_path(system_id: str, file: str) -> Optional[Path]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}\.(?:woff2?|ttf|otf)", file or ""):
        return None
    if system_id == BUILTIN_ID:
        allowed = {face[1] for face in KAIROS_FONT_FACES}
        return Path(STATIC_DIR, "fonts", file) if file in allowed else None
    if not ID_RE.fullmatch(system_id or ""):
        return None
    if design_looks.get(system_id):
        allowed = {face["file"] for face in design_looks.fonts(design_looks.get(system_id))}
        return design_looks.font_path(file) if file in allowed else None
    path = Path(SYSTEMS_DIR, system_id, "fonts", file)
    return path if path.is_file() else None


def builtin() -> dict:
    return {"id": BUILTIN_ID, "name": "Kairos", "builtin": True, "tokens": kairos_tokens(),
            "guide": KAIROS_GUIDE, "components": COMPONENTS, "fonts": [
                {"family": f, "file": file, "weight": w, "style": s} for f, file, w, s in KAIROS_FONT_FACES]}


def default_id() -> Optional[str]:
    """The look or system the person chose as their default, if it still exists."""
    from core import settings as settings_store
    chosen = settings_store.get_setting("design_default_look")
    return chosen if isinstance(chosen, str) and chosen != BUILTIN_ID and get(chosen) else (
        BUILTIN_ID if chosen == BUILTIN_ID else None)


def look_system(look: dict) -> dict:
    """A bundled look in the same shape as a saved system, so boards, exports and tools treat it alike."""
    return {"id": look["id"], "name": look["name"], "builtin": False, "bundled": True,
            "tokens": design_looks.tokens(look), "guide": design_looks.guide(look),
            "components": design_looks.components(look), "fonts": design_looks.fonts(look),
            "source": "bundled look", "created_by": None, "look": design_looks.summary(look)}


def get(system_id: Optional[str]) -> Optional[dict]:
    if not system_id or system_id == BUILTIN_ID:
        return builtin()
    if not ID_RE.fullmatch(system_id):
        return None
    look = design_looks.get(system_id)
    if look:
        return look_system(look)
    folder = Path(SYSTEMS_DIR, system_id)
    data = read_json(str(folder / "system.json"), None)
    if not isinstance(data, dict):
        return None
    tokens = read_json(str(folder / "tokens.json"), {})
    guide = (folder / "guide.md").read_text(encoding="utf-8") if (folder / "guide.md").is_file() else ""
    components = (folder / "components.html").read_text(encoding="utf-8") if (folder / "components.html").is_file() else COMPONENTS
    return {"id": system_id, "name": data.get("name") or system_id, "builtin": False, "tokens": tokens,
            "guide": guide, "components": components, "fonts": data.get("fonts") or [],
            "source": data.get("source"), "created_by": data.get("created_by")}


def list_systems() -> list[dict]:
    out = [{"id": BUILTIN_ID, "name": "Kairos", "builtin": True}]
    out += [{"id": look["id"], "name": look["name"], "builtin": False, "bundled": True, "mood": look["mood"]}
            for look in design_looks.load().values()]
    if os.path.isdir(SYSTEMS_DIR):
        for name in sorted(os.listdir(SYSTEMS_DIR)):
            system = get(name) if ID_RE.fullmatch(name) and not design_looks.get(name) else None
            if system:
                out.append({"id": system["id"], "name": system["name"], "builtin": False, "source": system.get("source")})
    return out


def _validate_tokens(tokens) -> dict:
    """A tokens tree the store accepts: known groups, plain values, every
    semantic role present (missing roles fall back to Kairos's)."""
    if not isinstance(tokens, dict):
        raise ValueError("tokens must be an object of groups (color, font, size, space, radius, shadow).")
    base = kairos_tokens()
    clean: dict = {}
    for group in ("color", "font", "size", "space", "radius", "shadow"):
        items = tokens.get(group) or {}
        if not isinstance(items, dict):
            raise ValueError(f"tokens.{group} must be an object.")
        merged = dict(base.get(group, {}))
        for name, token in items.items():
            value = token.get("$value") if isinstance(token, dict) else token
            if not re.fullmatch(r"[a-z0-9-]{1,40}", str(name)) or not _safe_value(value):
                raise ValueError(f"tokens.{group}.{name}: names are lowercase words, values plain CSS without ; {{ }} < > or url().")
            merged[str(name)] = {"$type": {"color": "color", "font": "fontFamily", "shadow": "shadow"}.get(group, "dimension"),
                                 "$value": value}
        clean[group] = merged
    return clean


def save(name: str, tokens: dict, guide: str = "", *, created_by: str = "", source: str = "",
         system_id: Optional[str] = None) -> dict:
    """Persist a design system (admin-only callers). Returns it."""
    if not isinstance(name, str) or not name.strip() or len(name) > 60:
        raise ValueError("name must be 1 to 60 characters.")
    clean = _validate_tokens(tokens)
    if system_id is None:
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "system"
        system_id = f"{base}-{secrets.token_hex(3)}"
    if system_id == BUILTIN_ID or not ID_RE.fullmatch(system_id) or design_looks.get(system_id):
        raise ValueError("That design system cannot be changed.")
    folder = Path(SYSTEMS_DIR, system_id)
    with _lock:
        folder.mkdir(parents=True, exist_ok=True)
        write_json_atomic(str(folder / "tokens.json"), clean)
        (folder / "guide.md").write_text((guide or "")[:4000], encoding="utf-8")
        existing = read_json(str(folder / "system.json"), {}) or {}
        write_json_atomic(str(folder / "system.json"), {**existing, "name": name.strip(), "created_by": created_by,
                                                         "source": source[:200], "fonts": existing.get("fonts", [])})
    return get(system_id)


def from_css(name: str, css: str, *, created_by: str = "", source: str = "") -> dict:
    """A system from a project's CSS custom properties (Tool Store import):
    colours matched to roles by common names, fonts from font variables."""
    found = dict(re.findall(r"(--[A-Za-z0-9_-]+)\s*:\s*([^;}{]+)", css or ""))
    if not found:
        raise ValueError("No CSS custom properties (--name: value) were found.")
    roles = {
        "bg": ("background", "bg", "page", "ground", "base"), "surface": ("surface", "card", "panel"),
        "text": ("text", "foreground", "fg", "ink", "body"), "text-dim": ("muted", "secondary", "dim", "subtle"),
        "accent": ("accent", "primary", "brand"), "accent-text": ("link", "accent-text", "primary-text"),
        "danger": ("danger", "error", "destructive"), "success": ("success", "ok", "positive"),
    }
    color: dict[str, str] = {}
    for role, words in roles.items():
        for var, value in found.items():
            key = var.lower().lstrip("-")
            if any(word in key for word in words) and re.match(r"\s*(#|rgb|hsl)", value) and _safe_value(value.strip()):
                color.setdefault(role, value.strip())
    font = {}
    for var, value in found.items():
        key = var.lower()
        if "font" in key and _safe_value(value.strip()) and not re.match(r"\s*\d", value):
            font.setdefault("serif" if "serif" in key and "sans" not in key else "sans", value.strip())
    if not color:
        raise ValueError("No colour variables could be matched to roles (background, surface, text, accent...).")
    return save(name, {"color": color, "font": font}, f"Imported from {source or 'CSS'}.", created_by=created_by, source=source)


def describe_tokens(system: dict, overrides: Optional[dict] = None) -> str:
    """The token list a model reads (design_tokens)."""
    flat = variables(system["tokens"], overrides)
    lines = [f"Design system: {system['name']} ({system['id']})"]
    lines += [f"{key}: {value}" for key, value in flat.items()]
    if system.get("guide"):
        lines += ["", system["guide"].strip()]
    return "\n".join(lines)
