"""Bundled looks for the Design canvas (Creative Output Quality spec, Phase 1).

A look is a complete design system shipped with the app: colour roles, a type
pairing from self-hosted OFL fonts, shape settings (corner radius, button
style, border weight, label case), mood words, the subjects it suits, and a
short guide. Each lives in design_looks/<id>/look.json, read once at start and
never written. core/design_systems.py serves them beside the built-in Kairos
system and saved ones, so boards use the same --ds-* tokens whatever the look.

Components and the Tool Store preview are built here from a look's shape
settings, so every look gets its own buttons and cards (not Kairos's pills)
without 24 hand-written copies drifting apart.

A look whose main text and accent pairs fail WCAG AA is refused at load, so a
model can't pick a look that makes unreadable boards.
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Optional

from core.constants import BASE_DIR, STATIC_DIR
from core.image_treatments import TREATMENTS, PATTERNS

LOOKS_DIR = Path(BASE_DIR, "design_looks")
FONTS_DIR = Path(STATIC_DIR, "fonts", "looks")
ID_RE = re.compile(r"[a-z][a-z0-9-]{1,40}")
_lock = threading.Lock()
_cache: Optional[dict[str, dict]] = None

# Font key -> (CSS family name, fallback stack). Files are found on disk: static/fonts/looks/<key>/ for
# the bundled OFL families, static/fonts/ for the three the app already ships.
FAMILIES = {
    "anton": ("Anton", "Impact, sans-serif"), "archivo": ("Archivo", "Arial, sans-serif"),
    "archivoblack": ("Archivo Black", "Arial Black, sans-serif"),
    "barlowcondensed": ("Barlow Condensed", "Arial Narrow, sans-serif"),
    "bebasneue": ("Bebas Neue", "Impact, sans-serif"),
    "bricolagegrotesque": ("Bricolage Grotesque", "system-ui, sans-serif"), "dmsans": ("DM Sans", "system-ui, sans-serif"),
    "dmserifdisplay": ("DM Serif Display", "Georgia, serif"), "ebgaramond": ("EB Garamond", "Garamond, Georgia, serif"),
    "fraunces": ("Fraunces", "Georgia, serif"), "fredoka": ("Fredoka", "system-ui, sans-serif"),
    "ibmplexsans": ("IBM Plex Sans", "Arial, sans-serif"), "ibmplexserif": ("IBM Plex Serif", "Georgia, serif"),
    "instrumentserif": ("Instrument Serif", "Georgia, serif"), "jetbrainsmono": ("JetBrains Mono", "Consolas, monospace"),
    "librebaskerville": ("Libre Baskerville", "Georgia, serif"), "lora": ("Lora", "Georgia, serif"),
    "manrope": ("Manrope", "system-ui, sans-serif"), "nunito": ("Nunito", "system-ui, sans-serif"),
    "oswald": ("Oswald", "Arial Narrow, sans-serif"), "outfit": ("Outfit", "system-ui, sans-serif"),
    "playfairdisplay": ("Playfair Display", "Georgia, serif"), "pressstart2p": ("Press Start 2P", "monospace"),
    "sourceserif4": ("Source Serif 4", "Georgia, serif"), "spacegrotesk": ("Space Grotesk", "system-ui, sans-serif"),
    "spacemono": ("Space Mono", "Consolas, monospace"), "syne": ("Syne", "system-ui, sans-serif"),
    "unbounded": ("Unbounded", "system-ui, sans-serif"), "vt323": ("VT323", "monospace"),
    "inter": ("Inter", "system-ui, sans-serif"), "jost": ("Jost", "system-ui, sans-serif"),
}
APP_FONTS = {"inter": [("Inter-Variable.woff2", "100 900", "normal")],
             "jost": [("Jost-Variable.woff2", "100 900", "normal")]}
STATIC_WEIGHTS = {"Thin": "100", "ExtraLight": "200", "Light": "300", "Regular": "400", "Medium": "500",
                  "SemiBold": "600", "Bold": "700", "ExtraBold": "800", "Black": "900"}
ROLES = ("bg", "surface", "text", "text-dim", "accent", "accent-text", "on-accent", "hairline")
# The pairs a board's text actually sits on. Each must reach WCAG AA (4.5:1).
AA_PAIRS = (("text", "bg"), ("text", "surface"), ("text-dim", "bg"), ("text-dim", "surface"),
            ("accent-text", "bg"), ("on-accent", "accent"))
BUTTONS = ("pill", "soft", "square", "underline")
LOOK_FIELDS = ("name", "mood", "tags", "good_for", "fonts", "office_fonts", "color", "shape", "imagery",
               "image_treatment", "pattern", "archetypes", "guide")


def _face_files(key: str) -> list[tuple[str, Path, str, str]]:
    """(alias, path, weight, style) for each file of a font key. The alias is what URLs carry
    (`fraunces-0.ttf`), since real names hold brackets and commas."""
    if key in APP_FONTS:
        return [(f"{key}-{i}{Path(f).suffix}", Path(STATIC_DIR, "fonts", f), w, s)
                for i, (f, w, s) in enumerate(APP_FONTS[key])]
    folder = FONTS_DIR / key
    out = []
    for i, path in enumerate(sorted(folder.glob("*.ttf")) if folder.is_dir() else []):
        name = path.stem
        style = "italic" if "Italic" in name else "normal"
        if "[" in name:
            weight = "100 1000"  # variable: the browser clamps to the axis the file has
        else:
            suffix = name.split("-")[-1].replace("Italic", "") or "Regular"
            weight = STATIC_WEIGHTS.get(suffix, "400")
        out.append((f"{key}-{i}.ttf", path, weight, style))
    return out


def _contrast(a: str, b: str) -> float:
    from core.design_html import contrast, _hex
    return contrast(_hex(a), _hex(b))


def _rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def to_hex(rgb) -> str:
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(c))) for c in rgb[:3])


def mix(a: str, b: str, t: float) -> str:
    """a moved toward b by t (0..1), in RGB."""
    ra, rb = _rgb(a), _rgb(b)
    return to_hex([x + (y - x) * t for x, y in zip(ra, rb)])


def readable(fg: str, bg: str, target: float = 4.5) -> str:
    """fg, with its lightness pushed away from bg until the pair reaches target (WCAG AA).
    Keeps the hue: a dim grey stays grey, a brand red stays red, only lighter or darker."""
    import colorsys
    if _contrast(fg, bg) >= target:
        return fg.upper()
    r, g, b = (c / 255 for c in _rgb(fg))
    h, light, s = colorsys.rgb_to_hls(r, g, b)
    bg_light = colorsys.rgb_to_hls(*(c / 255 for c in _rgb(bg)))[1]
    step = -0.02 if bg_light >= 0.5 else 0.02
    for _ in range(60):
        light = max(0.0, min(1.0, light + step))
        candidate = to_hex([c * 255 for c in colorsys.hls_to_rgb(h, light, s)])
        if _contrast(candidate, bg) >= target:
            return candidate
    return "#000000" if bg_light >= 0.5 else "#FFFFFF"


def repair(color: dict) -> list[str]:
    """Bring a colour set's text and accent pairs to WCAG AA in place; one plain note per change.
    Used for styles made from references (core/design_references.py); bundled looks must already pass."""
    notes = []
    pairs = (("text", "bg"), ("text", "surface"), ("text-dim", "bg"), ("text-dim", "surface"), ("accent-text", "bg"))
    # Aim a little above 4.5 so rounding never lands on 4.4999; loop because fixing a colour against the
    # card can undo it against the page when both sit near mid-grey.
    for _ in range(4):
        changed = False
        for fg, bg in pairs:
            if _contrast(color[fg], color[bg]) < 4.5:
                before = color[fg]
                color[fg] = readable(before, color[bg], 4.6)
                notes.append(f"{fg} changed from {before} to {color[fg]} so it reads on {bg} ({_contrast(color[fg], color[bg]):.1f}:1)")
                changed = True
        if not changed:
            break
    for fg in ("text", "text-dim", "accent-text"):  # A palette no hue can satisfy: plain black or white text.
        if any(_contrast(color[fg], color[bg]) < 4.5 for f, bg in pairs if f == fg):
            best = max(("#111111", "#FFFFFF"), key=lambda c: min(_contrast(c, color[bg]) for f, bg in pairs if f == fg))
            notes.append(f"{fg} set to {best}: the page and card colours left no readable tint")
            color[fg] = best
    if _contrast(color["on-accent"], color["accent"]) < 4.5:
        black, white = _contrast("#111111", color["accent"]), _contrast("#FFFFFF", color["accent"])
        before = color["on-accent"]
        color["on-accent"] = "#111111" if black >= white else "#FFFFFF"
        if max(black, white) < 4.5:  # A mid-tone accent: move the accent itself, keep its hue.
            old = color["accent"]
            color["accent"] = readable(old, color["on-accent"])
            notes.append(f"accent changed from {old} to {color['accent']} so button text reads on it")
        elif before != color["on-accent"]:
            notes.append(f"text on the accent set to {color['on-accent']} for contrast")
    return notes


def _validate(look_id: str, raw: dict) -> dict:
    # Reference drafts and saved styles from before pictures have no image defaults yet.
    raw = {"image_treatment": "duotone", "pattern": "dots", **raw}
    missing = [f for f in LOOK_FIELDS if f not in raw]
    if missing:
        raise ValueError(f"{look_id}: missing {', '.join(missing)}")
    for field, names in (("image_treatment", TREATMENTS), ("pattern", PATTERNS)):
        if raw[field] not in names:
            raise ValueError(f"{look_id}: {field} is one of {', '.join(names)}")
    color = raw["color"]
    for role in ROLES:
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(color.get(role, ""))):
            raise ValueError(f"{look_id}: color.{role} must be #RRGGBB")
    for fg, bg in AA_PAIRS:
        ratio = _contrast(color[fg], color[bg])
        if ratio < 4.5:
            raise ValueError(f"{look_id}: {fg} on {bg} is {ratio:.2f}:1, under WCAG AA 4.5:1")
    for role in ("display", "body"):
        key = raw["fonts"].get(role)
        if key not in FAMILIES or not _face_files(key):
            raise ValueError(f"{look_id}: font {role} `{key}` has no files")
    if raw["fonts"].get("mono") and raw["fonts"]["mono"] not in FAMILIES:
        raise ValueError(f"{look_id}: font mono `{raw['fonts']['mono']}` unknown")
    if raw["shape"].get("button") not in BUTTONS:
        raise ValueError(f"{look_id}: shape.button is one of {', '.join(BUTTONS)}")
    return {"id": look_id, **{k: raw[k] for k in LOOK_FIELDS}}


def load(refresh: bool = False) -> dict[str, dict]:
    """Every bundled look, validated. A broken look raises: the bundle ships tested."""
    global _cache
    with _lock:
        if _cache is None or refresh:
            looks = {}
            for folder in sorted(LOOKS_DIR.iterdir()) if LOOKS_DIR.is_dir() else []:
                path = folder / "look.json"
                if folder.is_dir() and ID_RE.fullmatch(folder.name) and path.is_file():
                    looks[folder.name] = _validate(folder.name, json.loads(path.read_text(encoding="utf-8")))
            _cache = looks
        return _cache


def get(look_id: Optional[str]) -> Optional[dict]:
    return load().get(look_id or "")


def _stack(key: str) -> str:
    family, fallback = FAMILIES[key]
    return f'"{family}", {fallback}'


def tokens(look: dict) -> dict:
    """The look as a design-system tokens tree (the same DTCG shape as Kairos's)."""
    from core.design_systems import SCALES
    color = {role: {"$type": "color", "$value": value} for role, value in look["color"].items()}
    fonts = look["fonts"]
    font = {"sans": _stack(fonts["body"]), "display": _stack(fonts["display"]),
            "serif": _stack(fonts["display"]), "mono": _stack(fonts.get("mono") or "jetbrainsmono")}
    radius = look["shape"]["radius"]
    soft = {"0px": ("0px", "0px", "0px"), "2px": ("2px", "2px", "3px")}.get(radius)
    radii = {"s": soft[0], "m": soft[1], "l": soft[2], "pill": "999px"} if soft else {
        "s": f"calc({radius} / 2)", "m": radius, "l": f"calc({radius} * 1.5)", "pill": "999px"}
    shadow = ("0 1px 2px rgba(0,0,0,.06), 0 4px 14px rgba(0,0,0,.06)", "0 10px 32px rgba(0,0,0,.14)")
    return {
        "$name": look["name"], "$description": ", ".join(look["mood"]),
        "color": color,
        "font": {k: {"$type": "fontFamily", "$value": v} for k, v in font.items()},
        **{scale: {k: {"$type": "dimension", "$value": v} for k, v in items.items()} for scale, items in SCALES.items()},
        "radius": {k: {"$type": "dimension", "$value": v} for k, v in radii.items()},
        "shadow": {"1": {"$type": "shadow", "$value": shadow[0]}, "2": {"$type": "shadow", "$value": shadow[1]}},
        "border": {"w": {"$type": "dimension", "$value": look["shape"]["border"]}},
    }


def fonts(look: dict) -> list[dict]:
    """Font faces for design_systems.font_faces: {family, file (alias), weight, style}."""
    keys = list(dict.fromkeys(k for k in (look["fonts"]["display"], look["fonts"]["body"], look["fonts"].get("mono")) if k))
    return [{"family": FAMILIES[k][0], "file": alias, "weight": w, "style": s}
            for k in keys for alias, _, w, s in _face_files(k)]


def font_path(alias: str) -> Optional[Path]:
    match = re.fullmatch(r"([a-z0-9]+)-(\d+)\.(ttf|woff2)", alias or "")
    if not match or match.group(1) not in FAMILIES:
        return None
    for name, path, _, _ in _face_files(match.group(1)):
        if name == alias and path.is_file():
            return path
    return None


def guide(look: dict) -> str:
    shape = look["shape"]
    return (f"# {look['name']} look\n{look['guide']}\n"
            f"- Mood: {', '.join(look['mood'])}. Suits: {', '.join(look['tags'][:8])}.\n"
            f"- Headlines: var(--ds-font-display), weight {shape['display_weight']}"
            f"{', italic' if shape['display_style'] == 'italic' else ''}. Body: var(--ds-font-sans).\n"
            f"- Labels and kickers: {'UPPER CASE' if shape['label_case'] == 'upper' else 'sentence case'}, "
            f"letter-spacing {shape['label_tracking']}.\n"
            f"- Buttons: {shape['button']}; corners var(--ds-radius-m); borders {shape['border']} solid var(--ds-hairline).\n"
            "- Text: var(--ds-text) on var(--ds-bg) or var(--ds-surface); secondary var(--ds-text-dim). "
            "On an accent fill, text is var(--ds-on-accent).\n"
            f"- Imagery: {look['imagery']}. Treatment: {look['image_treatment']}; pattern: {look['pattern']}.\n"
            "- One accent moment per board; var(--ds-accent-2) only as a small second highlight.")


def _button(look: dict, variant: str) -> str:
    shape = look["shape"]
    case = "text-transform: uppercase; " if shape["label_case"] == "upper" else ""
    tracking = f"letter-spacing: {shape['label_tracking']}; "
    base = (f"min-height: 48px; padding: 0 var(--ds-space-5); font: 600 var(--ds-size-3) var(--ds-font-sans); "
            f"{case}{tracking}cursor: pointer")
    radius = {"pill": "var(--ds-radius-pill)", "soft": "var(--ds-radius-m)", "square": "var(--ds-radius-s)",
              "underline": "0"}[shape["button"]]
    if shape["button"] == "underline":
        if variant == "primary":
            return (f'<button data-kd-component="button.primary" style="{base}; padding: 0; border: 0; '
                    f'border-bottom: 2px solid var(--ds-accent); border-radius: 0; background: none; color: var(--ds-text)">Continue</button>')
        return (f'<button data-kd-component="button.secondary" style="{base}; padding: 0; border: 0; '
                f'border-bottom: 1px solid var(--ds-hairline); border-radius: 0; background: none; color: var(--ds-text-dim)">Not now</button>')
    if variant == "primary":
        return (f'<button data-kd-component="button.primary" style="{base}; border: {shape["border"]} solid var(--ds-accent); '
                f'border-radius: {radius}; background: var(--ds-accent); color: var(--ds-on-accent)">Continue</button>')
    return (f'<button data-kd-component="button.secondary" style="{base}; border: {shape["border"]} solid var(--ds-hairline); '
            f'border-radius: {radius}; background: var(--ds-surface); color: var(--ds-text)">Not now</button>')


def components(look: dict) -> str:
    """The look's own component snippets, in the same named set as Kairos's (design_outline lists them)."""
    shape = look["shape"]
    border = f"{shape['border']} solid var(--ds-hairline)"
    label = ("text-transform: uppercase; " if shape["label_case"] == "upper" else "") + f"letter-spacing: {shape['label_tracking']}"
    display = f"font-family: var(--ds-font-display); font-weight: {shape['display_weight']}; font-style: {shape['display_style']}"
    return "\n".join([
        _button(look, "primary"),
        _button(look, "secondary"),
        f'<label data-kd-component="input" style="display: grid; gap: var(--ds-space-2); color: var(--ds-text-dim); font: var(--ds-size-2) var(--ds-font-sans); {label}">Email'
        f'<input placeholder="you@example.com" style="min-height: 48px; padding: 0 var(--ds-space-4); border: {border}; border-radius: var(--ds-radius-s); '
        f'background: var(--ds-surface); color: var(--ds-text); font: var(--ds-size-3) var(--ds-font-sans); text-transform: none; letter-spacing: 0"></label>',
        f'<div data-kd-component="card" style="padding: var(--ds-space-5); border: {border}; border-radius: var(--ds-radius-m); background: var(--ds-surface)">'
        f'<p style="margin: 0 0 var(--ds-space-2); color: var(--ds-accent-text); font: 600 var(--ds-size-1) var(--ds-font-sans); {label}">Label</p>'
        f'<h3 style="margin: 0 0 var(--ds-space-2); font-size: var(--ds-size-5); {display}">Card title</h3>'
        f'<p style="margin: 0; color: var(--ds-text-dim); font: var(--ds-size-3) var(--ds-font-sans)">Supporting text.</p></div>',
        f'<div data-kd-component="list.row" style="display: flex; align-items: center; gap: var(--ds-space-3); min-height: 56px; padding: 0 var(--ds-space-4); '
        f'border-bottom: {border}; font: var(--ds-size-3) var(--ds-font-sans)"><span style="flex: 1">List item</span><span style="color: var(--ds-text-dim)">Detail</span></div>',
        f'<header data-kd-component="nav.bar" style="display: flex; align-items: center; justify-content: space-between; height: 64px; padding: 0 var(--ds-space-5); '
        f'border-bottom: {border}"><strong style="font-size: var(--ds-size-4); {display}">Title</strong>'
        f'<button style="min-width: 44px; min-height: 44px; border: 0; background: none; color: var(--ds-accent-text); font: 600 var(--ds-size-2) var(--ds-font-sans); {label}">Edit</button></header>',
        f'<nav data-kd-component="tab.bar" style="display: flex; justify-content: space-around; height: 64px; border-top: {border}; background: var(--ds-surface)">'
        f'<button style="min-width: 64px; border: 0; background: none; color: var(--ds-text); font: 600 var(--ds-size-2) var(--ds-font-sans)">Home</button>'
        f'<button style="min-width: 64px; border: 0; background: none; color: var(--ds-text-dim); font: var(--ds-size-2) var(--ds-font-sans)">Search</button>'
        f'<button style="min-width: 64px; border: 0; background: none; color: var(--ds-text-dim); font: var(--ds-size-2) var(--ds-font-sans)">Profile</button></nav>',
        f'<p data-kd-component="kicker" style="margin: 0; color: var(--ds-accent-text); font: 600 var(--ds-size-2) var(--ds-font-sans); {label}">Kicker</p>',
        f'<h1 data-kd-component="headline" style="margin: 0; font-size: var(--ds-size-7); line-height: 1.02; {display}">Headline</h1>',
    ])


def sample(look: dict) -> str:
    """A 1200x800 preview board for Tool Store > Design systems, in the look's own tokens."""
    shape = look["shape"]
    label = ("text-transform: uppercase; " if shape["label_case"] == "upper" else "") + f"letter-spacing: {shape['label_tracking']}"
    display = f"font-family: var(--ds-font-display); font-weight: {shape['display_weight']}; font-style: {shape['display_style']}"
    mood = " · ".join(look["mood"])
    swatches = "".join(f'<span style="width: 56px; height: 56px; border: 1px solid var(--ds-hairline-soft, var(--ds-hairline)); '
                       f'border-radius: var(--ds-radius-s); background: var(--ds-{role})"></span>'
                       for role in ("bg", "surface", "text", "accent", "accent-2"))
    return (f'<main style="box-sizing: border-box; display: grid; grid-template-columns: 1.3fr 1fr; gap: var(--ds-space-8); width: 1200px; height: 800px; '
            f'padding: var(--ds-space-8); background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans)">'
            f'<section style="display: flex; flex-direction: column; justify-content: center; gap: var(--ds-space-5)">'
            f'<p style="margin: 0; color: var(--ds-accent-text); font: 600 18px var(--ds-font-sans); {label}">{mood}</p>'
            f'<h1 style="margin: 0; font-size: 104px; line-height: .98; {display}">{look["name"]}</h1>'
            f'<p style="margin: 0; max-width: 560px; color: var(--ds-text-dim); font-size: 22px; line-height: 1.5">{look["guide"].split(". ")[0]}.</p>'
            f'<div style="display: flex; gap: var(--ds-space-4); align-items: center">{_button(look, "primary")}{_button(look, "secondary")}</div></section>'
            f'<section style="display: flex; flex-direction: column; justify-content: center; gap: var(--ds-space-5)">'
            f'<div style="padding: var(--ds-space-6); border: {shape["border"]} solid var(--ds-hairline); border-radius: var(--ds-radius-l); background: var(--ds-surface)">'
            f'<p style="margin: 0 0 var(--ds-space-3); color: var(--ds-accent-text); font: 600 14px var(--ds-font-sans); {label}">Aa</p>'
            f'<p style="margin: 0 0 var(--ds-space-3); font-size: 44px; line-height: 1.05; {display}">The quick brown fox</p>'
            f'<p style="margin: 0; color: var(--ds-text-dim); font-size: 18px; line-height: 1.5">Body copy sits here, set for reading at length.</p></div>'
            f'<div style="display: flex; gap: var(--ds-space-3)">{swatches}</div></section></main>')


def summary(look: dict) -> dict:
    """What a chat or the Tool Store sees about a look."""
    return {"id": look["id"], "name": look["name"], "mood": look["mood"], "tags": look["tags"],
            "good_for": look["good_for"], "imagery": look["imagery"],
            "image_treatment": look["image_treatment"], "pattern": look["pattern"], "archetypes": look["archetypes"],
            "fonts": {role: FAMILIES[key][0] for role, key in look["fonts"].items()},
            "palette": {role: look["color"][role] for role in ("bg", "surface", "text", "accent", "accent-2") if role in look["color"]}}
