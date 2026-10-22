"""The terminal palette: Parchment for light terminals, Night for dark ones.

Both come from the brand tokens in static/css/kairos-theme.css (spec section
4.5; Night approved 2026-10-22). The terminal keeps its own background; we
only choose foregrounds, and a faint band behind the person's own turns.

Every role has three fixed values, one per colour depth, so a 256- or
16-colour terminal gets a chosen colour rather than whatever a downsampler
lands on. scripts/test_kairos_cli.py checks the truecolour values for
contrast against typical backgrounds and the fallbacks for sanity.

Rule kept from the app: gold (#B8893B) draws rules, the prompt mark and
frames, never body text.
"""
from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass

from rich.style import Style
from rich.theme import Theme

ROLES = ("text", "dim", "meta", "accent", "gold", "gold_hi", "danger", "success", "warn", "info", "band")

# role: (truecolour, 256-colour index, 16-colour name or "" for the terminal default)
PARCHMENT = {
    "text":    ("#3A2A20", 52, ""),
    "dim":     ("#6B5646", 59, "bright_black"),
    "meta":    ("#7A6553", 95, "bright_black"),
    "accent":  ("#83601F", 94, ""),            # gold-text; bold default on 16 colours
    "gold":    ("#B8893B", 137, "yellow"),
    "gold_hi": ("#D9B260", 179, "yellow"),
    "danger":  ("#A8432F", 130, "red"),
    "success": ("#4F6E4A", 59, "green"),
    "warn":    ("#83601F", 94, "red"),          # rose is too light to read on parchment
    "info":    ("#6B5646", 59, "blue"),
    "band":    ("#EDE2D0", 224, ""),
}
NIGHT = {
    "text":    ("#F3EADB", 224, ""),
    "dim":     ("#CDBBA6", 181, "white"),
    "meta":    ("#B8A48E", 144, "bright_black"),
    "accent":  ("#D9B260", 179, "yellow"),      # gold-hi
    "gold":    ("#B8893B", 137, "yellow"),
    "gold_hi": ("#D9B260", 179, "bright_yellow"),
    "danger":  ("#E08A78", 174, "bright_red"),
    "success": ("#9DBB8F", 144, "green"),
    "warn":    ("#D99A92", 174, "magenta"),      # rose
    "info":    ("#B9D2E3", 152, "cyan"),         # powder
    "band":    ("#2A201A", 235, ""),             # a faint bistre band behind your turns
}
THEMES = {"parchment": PARCHMENT, "night": NIGHT}


@dataclass(frozen=True)
class Palette:
    name: str            # parchment | night
    depth: str           # truecolor | 256 | 16 | none

    def color(self, role: str) -> str | None:
        """A Rich colour string for a role at this depth, or None to leave
        the terminal's own colour."""
        true, index, sixteen = THEMES[self.name][role]
        if self.depth == "truecolor":
            return true
        if self.depth == "256":
            return f"color({index})"
        if self.depth == "16":
            return sixteen or None
        return None

    def hex(self, role: str) -> str:
        return THEMES[self.name][role][0]

    def style(self, role: str, **extra) -> Style:
        color = self.color(role)
        if self.depth == "16" and role == "accent" and not color:
            extra.setdefault("bold", True)
        return Style(color=color, **extra)

    def band(self) -> Style:
        """Background for the person's own turns; none on 16 colours."""
        if self.depth in ("16", "none"):
            return Style()
        return Style(bgcolor=self.color("band"))

    def theme(self) -> Theme:
        styles = {f"k.{role}": self.style(role) for role in ROLES if role != "band"}
        styles["k.band"] = self.band()
        styles["k.user"] = self.style("text") + self.band()
        styles["k.code"] = self.style("accent")
        return Theme(styles)

    @property
    def truecolor(self) -> bool:
        return self.depth == "truecolor"


# -- detection ----------------------------------------------------------------

def color_depth(env=None, stream=None) -> str:
    """truecolor, 256, 16 or none. NO_COLOR wins; Windows Terminal and
    COLORTERM=truecolor are truecolour; a 256color TERM is 256."""
    env = os.environ if env is None else env
    forced = (env.get("KAIROS_COLOR") or "").lower()
    if forced in ("truecolor", "256", "16", "none"):
        return forced
    if "NO_COLOR" in env:
        return "none"
    stream = stream or sys.stdout
    if not getattr(stream, "isatty", lambda: False)():
        return "none"
    if (env.get("COLORTERM") or "").lower() in ("truecolor", "24bit"):
        return "truecolor"
    if env.get("WT_SESSION") or env.get("TERM_PROGRAM") in ("vscode", "WezTerm", "iTerm.app"):
        return "truecolor"
    term = (env.get("TERM") or "").lower()
    if "256" in term:
        return "256"
    if sys.platform == "win32":
        # Windows 10+ consoles take 24-bit sequences.
        return "truecolor"
    return "16"


def _luminance(hex_color: str) -> float:
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    la, lb = _luminance(a), _luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def theme_for_background(rgb_hex: str) -> str:
    return "parchment" if _luminance(rgb_hex) > 0.4 else "night"


def parse_osc11(reply: str) -> str | None:
    """'\\x1b]11;rgb:ffff/fafa/f0f0\\x07' -> '#FFFAF0'."""
    marker = reply.find("rgb:")
    if marker < 0:
        return None
    body = reply[marker + 4:].split("\x07")[0].split("\x1b")[0]
    parts = body.split("/")
    if len(parts) != 3:
        return None
    try:
        values = [int(p[:2] if len(p) >= 2 else p * 2, 16) for p in parts]
    except ValueError:
        return None
    return "#" + "".join(f"{v:02X}" for v in values)


def probe_background(timeout: float = 0.15) -> str | None:
    """Ask the terminal for its background colour (OSC 11), as Codex does in
    terminal_palette.rs. Best effort: any failure returns None."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return None
    try:
        if sys.platform == "win32":
            return _probe_windows(timeout)
        return _probe_posix(timeout)
    except Exception:
        return None


def _probe_posix(timeout: float) -> str | None:
    import select
    import termios
    import tty
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        sys.stdout.write("\x1b]11;?\x07")
        sys.stdout.flush()
        reply, deadline = "", time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], max(0.0, deadline - time.monotonic()))
            if not ready:
                break
            reply += os.read(fd, 64).decode("latin-1")
            if "\x07" in reply or "\x1b\\" in reply:
                break
        return parse_osc11(reply)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def _probe_windows(timeout: float) -> str | None:
    import ctypes
    import msvcrt
    from ctypes import wintypes
    kernel = ctypes.windll.kernel32
    handle = kernel.GetStdHandle(-10)
    mode = wintypes.DWORD()
    if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
        return None
    ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
    raw = mode.value & ~(0x0001 | 0x0002 | 0x0004) | ENABLE_VIRTUAL_TERMINAL_INPUT
    kernel.SetConsoleMode(handle, raw)
    try:
        sys.stdout.write("\x1b]11;?\x1b\\")
        sys.stdout.flush()
        reply, deadline = "", time.monotonic() + timeout
        while time.monotonic() < deadline:
            if msvcrt.kbhit():
                reply += msvcrt.getwch()
                if reply.endswith("\x07") or reply.endswith("\x1b\\"):
                    break
            else:
                time.sleep(0.005)
        return parse_osc11(reply)
    finally:
        kernel.SetConsoleMode(handle, mode.value)


def choose(theme: str | None = None, depth: str | None = None, env=None, probe: bool = True) -> Palette:
    """--theme, then KAIROS_THEME, then COLORFGBG, then the OSC 11 probe;
    Night when nothing answers, since most terminals are dark."""
    env = os.environ if env is None else env
    depth = depth or color_depth(env)
    name = (theme or env.get("KAIROS_THEME") or "").lower()
    if name in ("light", "parchment"):
        name = "parchment"
    elif name in ("dark", "night"):
        name = "night"
    else:
        name = ""
        fgbg = env.get("COLORFGBG", "")
        if fgbg:
            try:
                name = "parchment" if int(fgbg.split(";")[-1]) in (7, 15) else "night"
            except ValueError:
                name = ""
        if not name and probe and depth != "none":
            background = probe_background()
            if background:
                name = theme_for_background(background)
        name = name or "night"
    return Palette(name, depth)
