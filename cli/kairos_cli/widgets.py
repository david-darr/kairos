"""The full-screen view's small pieces, as prompt_toolkit fragments.

Everything here is a pure function of its inputs (and a time, for the parts
that move), so it can be tested and snapshotted without a terminal.

The texture is ours (vault spec, Amendment 2026-10-22): braille halftone
fields, dotted gold rules, bars whose empty part is a dithered braille
checker, solid-column histograms and sparklines, and a dotted ring for idle
and working. Colours come from the palette roles only.
"""
from __future__ import annotations

import math

from .palette import Palette, THEMES

Fragments = list[tuple[str, str]]

# xterm's 256-colour cube and greys, so a fixed 256 index can be given to
# prompt_toolkit as the exact hex it maps back to.
_CUBE = (0, 95, 135, 175, 215, 255)


def _xterm_hex(index: int) -> str:
    if index >= 232:
        level = 8 + (index - 232) * 10
        return f"#{level:02x}{level:02x}{level:02x}"
    index -= 16
    r, g, b = index // 36, (index // 6) % 6, index % 6
    return f"#{_CUBE[r]:02x}{_CUBE[g]:02x}{_CUBE[b]:02x}"


_ANSI = {"black": "ansiblack", "red": "ansired", "green": "ansigreen", "yellow": "ansiyellow", "blue": "ansiblue",
         "magenta": "ansimagenta", "cyan": "ansicyan", "white": "ansigray", "bright_black": "ansibrightblack",
         "bright_red": "ansibrightred", "bright_green": "ansibrightgreen", "bright_yellow": "ansiyellow",
         "bright_blue": "ansibrightblue", "bright_magenta": "ansibrightmagenta", "bright_cyan": "ansibrightcyan",
         "bright_white": "ansiwhite"}


class Styles:
    """prompt_toolkit style strings for the palette's roles, at the
    terminal's depth (the same fixed 256 and 16 colour tables as Rich)."""

    def __init__(self, palette: Palette):
        self.palette = palette

    def color(self, role: str) -> str:
        true, index, sixteen = THEMES[self.palette.name][role]
        depth = self.palette.depth
        if depth == "truecolor":
            return true
        if depth == "256":
            return _xterm_hex(index)
        if depth == "16":
            return _ANSI.get(sixteen, "")
        return ""

    def fg(self, role: str, extra: str = "") -> str:
        color = self.color(role)
        parts = [f"fg:{color}" if color else ""]
        if self.palette.depth == "16" and role == "accent" and not color:
            parts.append("bold")
        if extra:
            parts.append(extra)
        return " ".join(p for p in parts if p)

    def bg(self, role: str) -> str:
        if self.palette.depth in ("16", "none"):
            return ""
        color = self.color(role)
        return f"bg:{color}" if color else ""


# -- bars and charts ------------------------------------------------------------

DITHER = "⢕⡪"     # the empty part of a bar: a braille checker, our halftone


def bar(fraction: float | None, width: int, s: Styles, role: str = "accent") -> Fragments:
    """A bar whose filled part is solid and whose empty part is dithered.
    None draws only the texture: there is no number to show."""
    width = max(1, width)
    if fraction is None:
        return [(s.fg("meta"), "".join(DITHER[i % 2] for i in range(width)))]
    fraction = min(1.0, max(0.0, fraction))
    filled = int(round(fraction * width))
    return [(s.fg(role), "█" * filled),
            (s.fg("meta"), "".join(DITHER[(filled + i) % 2] for i in range(width - filled)))]


SPARK = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float], width: int, s: Styles, role: str = "accent") -> Fragments:
    """One row of solid columns, newest on the right."""
    values = list(values)[-width:]
    if not values:
        return [(s.fg("meta"), "·" * width)]
    top = max(values) or 1
    cells = "".join(SPARK[min(7, int(v / top * 7.999))] if v > 0 else " " for v in values)
    return [(s.fg("meta"), "·" * (width - len(values))), (s.fg(role), cells)]


def histogram(values: list[float], height: int, s: Styles, role: str = "accent") -> list[Fragments]:
    """Several rows of solid columns (one per value), top row first."""
    top = max(values) if values and max(values) > 0 else 1
    rows: list[Fragments] = []
    for row in range(height, 0, -1):
        line = ""
        for value in values:
            level = value / top * height
            if level >= row:
                line += "█"
            elif level > row - 1:
                line += SPARK[min(7, int((level - (row - 1)) * 8))] if value > 0 else " "
            else:
                line += " "
        rows.append([(s.fg(role), line)])
    rows.append([(s.fg("meta"), "▔" * len(values))])
    return rows


# A ring of dots in two braille cells; the working ring loses one dot that
# travels round it.
_RING = [(0, 0, 0x08), (1, 0, 0x01), (1, 1, 0x08), (1, 2, 0x10), (1, 3, 0x80), (0, 3, 0x40), (0, 2, 0x04), (0, 1, 0x02)]


def ring(seconds: float | None, s: Styles, role: str = "gold") -> Fragments:
    """The dotted ring: whole and still when idle (seconds None), with a
    moving gap when working."""
    cells = [0, 0]
    gap = None if seconds is None else int(seconds * 8) % len(_RING)
    for index, (cell, _row, bit) in enumerate(_RING):
        if index != gap:
            cells[cell] |= bit
    return [(s.fg(role), chr(0x2800 + cells[0]) + chr(0x2800 + cells[1]))]


# -- halftone fields ---------------------------------------------------------------

_BAYER4 = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
_DOTS = ((0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80))


def field(width: int, height: int, density, s: Styles, role: str = "meta") -> list[Fragments]:
    """A braille halftone field: density(x, y) in 0..1 over pixel space
    (2 x 4 dots per cell), ordered-dithered with Bayer 4 x 4 like
    static/js/dither.js."""
    px_w, px_h = width * 2, height * 4
    rows = []
    for row in range(height):
        line = ""
        for col in range(width):
            bits = 0
            for dx, dy, bit in _DOTS:
                x, y = col * 2 + dx, row * 4 + dy
                if density(x / max(1, px_w - 1), y / max(1, px_h - 1)) * 16 > _BAYER4[y % 4][x % 4] + 0.5:
                    bits |= bit
            line += chr(0x2800 + bits) if bits else " "
        rows.append([(s.fg(role), line)])
    return rows


def dune(x: float, y: float) -> float:
    """The sidebar's ground: dots rising from the bottom in soft dunes."""
    crest = 0.55 + 0.12 * math.sin(x * 6.3) + 0.06 * math.sin(x * 17.0 + 1.3)
    return max(0.0, min(1.0, (y - crest) * 2.4))


def sky(x: float, y: float) -> float:
    """The empty state's sky: densest at the top, a low sun on the right."""
    glow = max(0.0, 1.0 - math.hypot((x - 0.78) / 0.28, (y - 1.05) / 1.0))
    drift = 0.5 + 0.5 * math.sin(x * math.pi * 1.5)
    return min(1.0, 0.42 * (1 - y) ** 1.8 * (0.55 + 0.45 * drift) + 0.95 * glow ** 1.6)


def dotted_rule(width: int, s: Styles, role: str = "gold") -> Fragments:
    return [(s.fg(role), ("· " * (width // 2 + 1))[:width])]


def divider_cell(row: int, height: int, s: Styles) -> Fragments:
    """One cell of the vertical divider: a dotted gold line whose dots thin
    out towards the bottom, like the halftone."""
    density = 1.0 - row / max(1, height)
    char = "⡇" if density > 0.66 else "⠇" if density > 0.33 else "⠃"
    return [(s.fg("gold"), char)]


def fit(text: str, width: int) -> str:
    """Clip to width cells with an ellipsis (narrow characters only here)."""
    if width <= 0:
        return ""
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def human_tokens(value: int | None) -> str:
    if value is None:
        return "n/a"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k".replace(".0k", "k")
    return str(value)


def width_of(fragments: Fragments) -> int:
    from prompt_toolkit.utils import get_cwidth
    return sum(get_cwidth(text) for _, text in fragments)
