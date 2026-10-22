"""Kip, the CLI's pixel rendition of the Kairos mascot (spec decision 5;
vault "Kairos Mascot (Build Spec)", section 5, CLI row).

Three tiers, chosen by what the terminal can show:
1. truecolour half-blocks: the 24 x 24 sprite as 22 x 12 characters on the
   welcome screen, and a 12 x 6 slot (the sprite at half size) beside the
   working line;
2. a three-line text face for plain terminals;
3. a one-character status mark.

Sprite sheet format ("kairos-sprite-sheet", version 1), a folder holding:

    kip.json
      {"format": "kairos-sprite-sheet", "version": 1,
       "frame": [24, 24],                 width, height of one frame in pixels
       "fps": 8,                          playback rate
       "sheets": {"default": "kip.png",   required; drawn on light terminals
                  "night": "kip-night.png"},  optional; dark terminals
       "states": {"idle": {"row": 0, "frames": 16}, ...}}
    kip.png, kip-night.png
      RGBA PNGs; one row of frames per state, left to right; transparent
      pixels are not drawn.

State names are the app's (idle, thinking, listening, speaking, success,
needs, error, sleeping). The CLI uses idle, thinking, needs, success, error
and sleeping; a missing state falls back to idle.

Where the frames come from, first match wins:
- $KAIROS_KIP_DIR;
- REAL_KIP_DIR, the mascot work's static/img/mascot/kip/ (feat/mascot), once
  it holds a kip.json;
- the PLACEHOLDER shipped here, a port of the concept sheet's Kip.
After the mascot branch merges, pointing at the real assets is nothing at
all if it uses this format, and a change to load_sheet() alone if it does not.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from rich.style import Style
from rich.text import Text

REPO = Path(__file__).resolve().parents[2]
REAL_KIP_DIR = REPO / "static" / "img" / "mascot" / "kip"
PLACEHOLDER_DIR = Path(__file__).resolve().parent / "assets" / "kip-placeholder"
STATES = ("idle", "thinking", "listening", "speaking", "success", "needs", "error", "sleeping")

Pixel = tuple[int, int, int] | None


@dataclass
class Sheet:
    name: str
    fps: int
    width: int
    height: int
    frames: dict[str, list[list[list[Pixel]]]]   # state -> frames -> rows -> pixels
    source: Path
    placeholder: bool

    def frame(self, state: str, tick: int) -> list[list[Pixel]]:
        frames = self.frames.get(state) or self.frames.get("idle") or next(iter(self.frames.values()))
        return frames[tick % len(frames)]


def asset_dir() -> Path:
    override = os.environ.get("KAIROS_KIP_DIR")
    if override and (Path(override) / "kip.json").is_file():
        return Path(override)
    if (REAL_KIP_DIR / "kip.json").is_file():
        return REAL_KIP_DIR
    return PLACEHOLDER_DIR


def load_sheet(folder: Path | None = None, theme: str = "night") -> Sheet | None:
    """Read a sprite sheet folder. None when it is missing or unreadable, or
    Pillow is unavailable: the mascot then falls back to the text tiers."""
    folder = folder or asset_dir()
    try:
        manifest = json.loads((folder / "kip.json").read_text(encoding="utf-8"))
        if manifest.get("format") != "kairos-sprite-sheet" or int(manifest.get("version", 0)) != 1:
            return None
        width, height = (int(v) for v in manifest["frame"])
        sheets = manifest["sheets"]
        filename = sheets.get(theme) or sheets["default"]
        path = (folder / filename).resolve()
        if path.parent != folder.resolve():
            return None   # a manifest may only name files beside it
        from PIL import Image
        with Image.open(path) as opened:
            image = opened.convert("RGBA")
        frames: dict[str, list] = {}
        for state, spec in manifest["states"].items():
            if state not in STATES:
                continue
            row, count = int(spec["row"]), int(spec["frames"])
            if count < 1 or (row + 1) * height > image.height or count * width > image.width:
                return None
            frames[state] = [_cut(image, f * width, row * height, width, height) for f in range(count)]
        if not frames:
            return None
        return Sheet(str(manifest.get("name") or "Kip"), max(1, int(manifest.get("fps", 8))), width, height,
                     frames, folder, bool(manifest.get("placeholder")))
    except Exception:
        return None


def _cut(image, left, top, width, height) -> list[list[Pixel]]:
    rows = []
    for y in range(top, top + height):
        row = []
        for x in range(left, left + width):
            r, g, b, a = image.getpixel((x, y))
            row.append((r, g, b) if a >= 128 else None)
        rows.append(row)
    return rows


def _hex(pixel: Pixel) -> str | None:
    return "#%02X%02X%02X" % pixel if pixel else None


def half_blocks(frame: list[list[Pixel]], crop: int = 1, scale: int = 1) -> list[Text]:
    """Pixels to characters: each character is two pixels stacked, the top
    one as foreground of an upper half block, the bottom one as background.
    scale=2 halves the sprite for the 12 x 6 working-line slot."""
    if scale > 1:
        frame = [[_pick(frame, x, y, scale) for x in range(0, len(frame[0]), scale)]
                 for y in range(0, len(frame), scale)]
        crop = 0
    width = len(frame[0])
    lines = []
    for y in range(0, len(frame) - 1, 2):
        line = Text()
        for x in range(crop, width - crop):
            top, bottom = frame[y][x], frame[y + 1][x]
            if not top and not bottom:
                line.append(" ")
            elif top and bottom and top == bottom:
                line.append("█", Style(color=_hex(top)))
            elif top and bottom:
                line.append("▀", Style(color=_hex(top), bgcolor=_hex(bottom)))
            elif top:
                line.append("▀", Style(color=_hex(top)))
            else:
                line.append("▄", Style(color=_hex(bottom)))
        lines.append(line)
    return lines


def _pick(frame, x, y, scale):
    """Downsample by taking the most common opaque pixel in the block, so the
    gold point and the eyes survive halving better than plain sampling."""
    seen: dict = {}
    for dy in range(scale):
        for dx in range(scale):
            if y + dy < len(frame) and x + dx < len(frame[0]):
                pixel = frame[y + dy][x + dx]
                if pixel:
                    seen[pixel] = seen.get(pixel, 0) + 1
    if not seen:
        return None
    if sum(seen.values()) < (scale * scale) // 2:
        return None
    # Prefer a rare bright colour (eye, point) over the body when present.
    body = max(seen, key=seen.get)
    rare = [p for p in seen if p != body]
    if rare and len(seen) > 1 and seen[body] <= scale * scale - 1:
        brightest = max(rare, key=lambda p: abs(sum(p) - sum(body)))
        if abs(sum(brightest) - sum(body)) > 180:
            return brightest
    return body


def text_face(state: str, tick: int, ascii_only: bool = False) -> list[str]:
    """Tier 2: three lines, as in the concept sheet's CLI rendition."""
    eyes = {"idle": "- -" if tick % 40 >= 37 else "▮ ▮", "thinking": "▮ ▮", "listening": "█ █",
            "speaking": "▮ ▮", "success": "^ ^", "needs": "▮ ▮", "error": "; ;", "sleeping": "_ _"}.get(state, "▮ ▮")
    if ascii_only:
        eyes = eyes.replace("▮", "|").replace("█", "#")
    grid = [list(" .---.   "), list("( " + eyes + " )  "), list(" `---'   ")]
    ring = [(0, 6), (1, 7), (2, 6), (2, 3), (2, 0), (1, 0), (0, 0), (0, 3)]
    pos = ring[tick % 8] if state == "thinking" else (1, 7) if state in ("error", "sleeping") else (0, 6)
    point = "!" if state == "needs" and (tick // 4) % 2 else "x" if state == "error" else "*"
    if state == "sleeping":
        grid[0][8] = "z"
    grid[pos[0]][pos[1]] = point
    return ["".join(row).rstrip() for row in grid]


SPINNER = ("◜", "◝", "◞", "◟")


def status_mark(state: str, tick: int, ascii_only: bool = False) -> str:
    """Tier 3: one character."""
    if state == "thinking":
        return "-\\|/"[tick % 4] if ascii_only else SPINNER[tick % 4]
    return {"needs": "!", "success": "+" if ascii_only else "✓", "error": "x" if ascii_only else "×"}.get(
        state, "*" if ascii_only else "•")


class Kip:
    """The mascot for one terminal: picks its tier once, then draws frames."""

    def __init__(self, palette, enabled: bool = True, motion: bool = True, ascii_only: bool = False):
        self.palette = palette
        self.motion = motion
        self.ascii_only = ascii_only
        self.sheet = load_sheet(theme=palette.name if palette.name == "night" else "default") \
            if enabled and palette.truecolor else None
        self.enabled = enabled

    @property
    def tier(self) -> str:
        if not self.enabled:
            return "off"
        return "pixels" if self.sheet else "text"

    def tick(self, seconds: float) -> int:
        fps = self.sheet.fps if self.sheet else 8
        return int(seconds * fps) if self.motion else 2

    def banner(self, state: str = "idle", seconds: float = 0.0) -> list[Text]:
        if self.sheet:
            return half_blocks(self.sheet.frame(state, self.tick(seconds)))
        if self.enabled:
            return [Text(line, self.palette.style("text")) for line in text_face(state, self.tick(seconds), self.ascii_only)]
        return []

    def slot(self, state: str, seconds: float) -> list[Text]:
        """The 12 x 6 cell slot beside the working line."""
        if self.sheet:
            return half_blocks(self.sheet.frame(state, self.tick(seconds)), scale=2)
        return []

    def mark(self, state: str, seconds: float) -> Text:
        color = {"needs": "warn", "error": "danger", "success": "success"}.get(state, "gold")
        return Text(status_mark(state, self.tick(seconds), self.ascii_only), self.palette.style(color))
