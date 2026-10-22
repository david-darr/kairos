"""Kip, the CLI's pixel rendition of the Kairos mascot (spec decision 5;
vault "Kairos Mascot (Build Spec)", section 6).

The frames come from the mascot work's terminal assets in
static/img/mascot/kip/ (built by scripts/build_kip_assets.cjs; see its
README). This module reads kip.json, format "kairos-kip-sheet" version 1:

    states        idle, thinking, needs-you, done, error
    themes        <theme>.<size>: hex colours; a frame character is "." (clear)
                  or a base-36 index into that list
    sizes         full (24 x 24 pixels, 24 x 12 cells) and mini (12 x 12
                  pixels, 12 x 6 cells, the slot beside the working line);
                  sizes.<size>.frames.<theme>.<state> is a list of frames,
                  a frame a list of rows
    fps, frame_counts, text_face (unicode, ascii), spinner

No image decoding is needed: the frames are text. The PNG sheets beside it
are for sixel or Kitty graphics, which this CLI does not draw yet.

Tiers, chosen by what the terminal can show: truecolour half-blocks from
kip.json; on 256 or 16 colours, the plain half-block still (kip-<state>.txt)
in one theme colour; with no colour, the three-line ASCII text face; and a
one-character mark (the spinner) beside the working line.

$KAIROS_KIP_DIR overrides the folder, for development.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from rich.style import Style
from rich.text import Text

REPO = Path(__file__).resolve().parents[2]
KIP_DIR = REPO / "static" / "img" / "mascot" / "kip"
ASSET_STATES = ("idle", "thinking", "needs-you", "done", "error")
# The CLI's own state words, mapped onto the assets' (sleeping has no frames
# yet and shows idle).
STATE_MAP = {"idle": "idle", "thinking": "thinking", "needs": "needs-you", "success": "done",
             "error": "error", "sleeping": "idle"}
_ROW = re.compile(r"^[.0-9a-z]+$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

Pixel = str | None   # "#RRGGBB" or clear


@dataclass
class Sheet:
    theme: str
    size: str
    fps: dict
    frames: dict[str, list[list[list[Pixel]]]]   # asset state -> frames -> rows -> pixels
    text_face: dict
    spinner: dict
    source: Path

    def frame(self, state: str, tick: int) -> list[list[Pixel]]:
        name = STATE_MAP.get(state, state)
        frames = self.frames.get(name) or self.frames["idle"]
        return frames[tick % len(frames)]


def asset_dir() -> Path:
    override = os.environ.get("KAIROS_KIP_DIR")
    if override and (Path(override) / "kip.json").is_file():
        return Path(override)
    return KIP_DIR


def load_manifest(folder: Path | None = None) -> dict | None:
    try:
        data = json.loads(((folder or asset_dir()) / "kip.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("format") != "kairos-kip-sheet" or int(data.get("version", 0)) != 1:
        return None
    return data


def load_sheet(folder: Path | None = None, theme: str = "night", size: str = "full") -> Sheet | None:
    """Kip's frames for a theme (parchment or night) and size (full or
    mini). None when the assets are missing or malformed: the mascot then
    falls back to the text tiers rather than drawing something wrong."""
    folder = folder or asset_dir()
    data = load_manifest(folder)
    if data is None:
        return None
    try:
        spec = data["sizes"][size]
        grid = int(spec["grid"])
        colours = data["themes"][theme][size]
        if not colours or not all(_HEX.match(c) for c in colours):
            return None
        frames: dict[str, list] = {}
        for state, raw_frames in spec["frames"][theme].items():
            if state not in ASSET_STATES or not raw_frames:
                continue
            decoded = []
            for raw in raw_frames:
                if len(raw) != grid or any(len(row) != grid or not _ROW.match(row) for row in raw):
                    return None
                decoded.append([[None if ch == "." else colours[int(ch, 36)] for ch in row] for row in raw])
            frames[state] = decoded
        if "idle" not in frames:
            return None
        return Sheet(theme, size, dict(data.get("fps") or {}), frames, dict(data.get("text_face") or {}),
                     dict(data.get("spinner") or {}), folder)
    except (KeyError, TypeError, ValueError, IndexError):
        return None


def half_blocks(frame: list[list[Pixel]]) -> list[Text]:
    """Two pixel rows per character: the top pixel is the foreground of an
    upper half block, the bottom one its background."""
    lines = []
    for y in range(0, len(frame) - 1, 2):
        line = Text()
        for top, bottom in zip(frame[y], frame[y + 1]):
            if not top and not bottom:
                line.append(" ")
            elif top and bottom and top == bottom:
                line.append("█", Style(color=top))
            elif top and bottom:
                line.append("▀", Style(color=top, bgcolor=bottom))
            elif top:
                line.append("▀", Style(color=top))
            else:
                line.append("▄", Style(color=bottom))
        lines.append(line)
    return lines


# Used only when kip.json is missing, so the text tiers never disappear.
_FALLBACK_FACE = {"unicode": [" .---.  *", "( ▮ ▮ )", " `---'"], "ascii": [" .---.  *", "( | | )", " `---'"]}
_FALLBACK_SPINNER = {"thinking": ["◜", "◝", "◞", "◟"], "needs-you": ["!"], "done": ["✓"], "error": ["×"], "idle": ["•"],
                     "ascii": {"thinking": ["|", "/", "-", "\\"], "needs-you": ["!"], "done": ["+"], "error": ["x"],
                               "idle": ["."]}}


def plain_still(state: str, folder: Path | None = None) -> list[str] | None:
    """The asset's own colourless half-block still for a state."""
    name = STATE_MAP.get(state, state)
    try:
        lines = ((folder or asset_dir()) / f"kip-{name}.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    lines = [line.rstrip() for line in lines]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    if not lines or any(set(line) - set(" ▀▄█") for line in lines):
        return None   # only half-block characters, never anything a terminal would act on
    return lines


def text_face(state: str, manifest: dict | None = None, ascii_only: bool = False) -> list[str]:
    """Tier 2: three lines, from kip.json."""
    faces = (manifest or {}).get("text_face") or {}
    face = faces.get(STATE_MAP.get(state, state)) or faces.get("idle") or _FALLBACK_FACE
    return list(face["ascii" if ascii_only else "unicode"])


def status_mark(state: str, tick: int, manifest: dict | None = None, ascii_only: bool = False) -> str:
    """Tier 3: one character, from kip.json's spinner."""
    spinner = (manifest or {}).get("spinner") or _FALLBACK_SPINNER
    table = spinner.get("ascii", {}) if ascii_only else spinner
    marks = table.get(STATE_MAP.get(state, state)) or table.get("idle") or ["*"]
    return marks[tick % len(marks)]


class Kip:
    """The mascot for one terminal: picks its tier once, then draws frames."""

    def __init__(self, palette, enabled: bool = True, motion: bool = True, ascii_only: bool = False):
        self.palette = palette
        self.motion = motion
        self.ascii_only = ascii_only
        self.enabled = enabled
        self.manifest = load_manifest() if enabled else None
        theme = "night" if palette.name == "night" else "parchment"
        pixels = enabled and palette.truecolor
        self.sheet = load_sheet(theme=theme, size="full") if pixels else None
        self.mini = load_sheet(theme=theme, size="mini") if pixels else None

    @property
    def tier(self) -> str:
        if not self.enabled:
            return "off"
        if self.sheet:
            return "pixels"
        if not self.ascii_only and self.palette.depth in ("256", "16") and plain_still("idle"):
            return "blocks"
        return "text"

    def tick(self, seconds: float, state: str = "idle") -> int:
        """Frame 0 without motion, as the assets' README asks."""
        if not self.motion:
            return 0
        fps = (self.manifest or {}).get("fps", {}).get(STATE_MAP.get(state, state), 8)
        return int(seconds * fps)

    def banner(self, state: str = "idle", seconds: float = 0.0) -> list[Text]:
        if self.sheet:
            return half_blocks(self.sheet.frame(state, self.tick(seconds, state)))
        if self.tier == "blocks":
            return [Text(line, self.palette.style("text")) for line in plain_still(state) or plain_still("idle")]
        if self.enabled:
            return [Text(line, self.palette.style("text")) for line in text_face(state, self.manifest, self.ascii_only)]
        return []

    def slot(self, state: str, seconds: float) -> list[Text]:
        """The 12 x 6 cell slot beside the working line."""
        if self.mini:
            return half_blocks(self.mini.frame(state, self.tick(seconds, state)))
        return []

    def mark(self, state: str, seconds: float) -> Text:
        color = {"needs": "warn", "error": "danger", "success": "success"}.get(state, "gold")
        tick = int(seconds * 8) if self.motion else 0
        return Text(status_mark(state, tick, self.manifest, self.ascii_only), self.palette.style(color))
