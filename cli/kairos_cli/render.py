"""Everything the CLI draws, as Rich renderables.

Streaming follows Codex (spec section 2): text is committed to scrollback
only at newline boundaries, and code fences and tables are held in the
mutable tail until they close, so nothing already printed ever has to be
redrawn. All text from the backend passes through sanitize.clean() and is
placed in Text objects, never parsed as markup.

Motion lives in the live area only: the braille "halftone" working bar, the
gold shimmer over the status label, and the short welcome. Each takes a time
in seconds, so a still frame (no motion) is just a fixed time.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from rich.console import Group
from rich.markdown import Markdown
from rich.padding import Padding
from rich.panel import Panel
from rich.style import Style
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from rich import box

from .palette import Palette
from .sanitize import clean, one_line

GUTTER = "  "
NO_EM_DASH = "-"   # UI text here never uses an em dash


# -- streaming ------------------------------------------------------------------

@dataclass
class Block:
    kind: str            # line | code | table
    text: str = ""
    lang: str = ""
    lines: tuple = ()


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)")


class StreamCommitter:
    """Turns a stream of text deltas into finished blocks plus a tail."""

    def __init__(self):
        self.partial = ""
        self.fence: str | None = None
        self.fence_lang = ""
        self.code: list[str] = []
        self.table: list[str] = []

    def feed(self, delta: str) -> list[Block]:
        self.partial += clean(delta)
        out: list[Block] = []
        while "\n" in self.partial:
            line, self.partial = self.partial.split("\n", 1)
            out.extend(self._line(line))
        return out

    def _line(self, line: str) -> list[Block]:
        out: list[Block] = []
        match = _FENCE.match(line)
        if self.fence is not None:
            if match and match.group(1)[0] == self.fence[0] and len(match.group(1)) >= len(self.fence) \
                    and not line.strip()[len(match.group(1)):].strip():
                out.append(Block("code", lang=self.fence_lang, lines=tuple(self.code)))
                self.fence, self.code = None, []
            else:
                self.code.append(line)
            return out
        stripped = line.strip()
        if stripped.startswith("|") and stripped.count("|") >= 2:
            self.table.append(line)
            return out
        if self.table:
            out.append(Block("table", lines=tuple(self.table)))
            self.table = []
        if match:
            self.fence, self.fence_lang = match.group(1), match.group(2)
            return out
        out.append(Block("line", text=line))
        return out

    def finish(self) -> list[Block]:
        """The turn ended: commit whatever is left, closed or not."""
        out: list[Block] = []
        if self.partial:
            line, self.partial = self.partial, ""
            out.extend(self._line(line))
        if self.fence is not None:
            out.append(Block("code", lang=self.fence_lang, lines=tuple(self.code)))
            self.fence, self.code = None, []
        if self.table:
            out.append(Block("table", lines=tuple(self.table)))
            self.table = []
        return out

    def tail(self) -> str:
        """What the live area shows for the part not yet committed."""
        if self.fence is not None:
            lang = f"{self.fence_lang} " if self.fence_lang else ""
            return f"writing {lang}code · {len(self.code)} lines"
        if self.table:
            return f"writing a table · {len(self.table)} rows"
        return self.partial


# -- inline markdown ------------------------------------------------------------

_INLINE = re.compile(r"(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))")


def inline(text: str, palette: Palette, base: Style | None = None) -> Text:
    base = base or palette.style("text")
    out = Text(style=base)
    position = 0
    for match in _INLINE.finditer(text):
        out.append(text[position:match.start()])
        token = match.group(0)
        if token.startswith("`"):
            out.append(token[1:-1], palette.style("accent"))
        elif token.startswith(("**", "__")):
            out.append(token[2:-2], Style(bold=True))
        elif token.startswith("["):
            label, url = re.match(r"\[([^\]]+)\]\(([^)]+)\)", token).groups()
            out.append(label, palette.style("accent", underline=True))
            out.append(f" ({url})", palette.style("meta"))
        else:
            out.append(token[1:-1], Style(italic=True))
        position = match.end()
    out.append(text[position:])
    return out


def render_line(text: str, palette: Palette) -> Text:
    if not text.strip():
        return Text("")
    heading = re.match(r"^(#{1,6})\s+(.*)$", text)
    if heading:
        return inline(heading.group(2), palette, palette.style("accent", bold=True))
    if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", text):
        return Text("· " * 20, palette.style("gold"))
    bullet = re.match(r"^(\s*)[-*+]\s+(.*)$", text)
    if bullet:
        line = Text(bullet.group(1) + "• ", palette.style("gold"))
        return line + inline(bullet.group(2), palette)
    numbered = re.match(r"^(\s*)(\d+[.)])\s+(.*)$", text)
    if numbered:
        line = Text(numbered.group(1) + numbered.group(2) + " ", palette.style("meta"))
        return line + inline(numbered.group(3), palette)
    quote = re.match(r"^\s*>\s?(.*)$", text)
    if quote:
        return Text("│ ", palette.style("gold")) + inline(quote.group(1), palette, palette.style("dim", italic=True))
    return inline(text, palette)


def syntax_theme(palette: Palette) -> str:
    return "gruvbox-dark" if palette.name == "night" else "gruvbox-light"


def render_block(block: Block, palette: Palette):
    if block.kind == "line":
        return Padding(render_line(block.text, palette), (0, 0, 0, 2))
    if block.kind == "code":
        code = "\n".join(block.lines)
        if palette.depth == "none":
            return Padding(Text(code), (0, 0, 0, 4))
        return Padding(Syntax(code, block.lang or "text", theme=syntax_theme(palette),
                              background_color="default", word_wrap=True), (0, 0, 0, 4))
    markdown = Markdown("\n".join(block.lines), code_theme=syntax_theme(palette))
    return Padding(markdown, (0, 0, 0, 2))


# -- turns, tools, rules -------------------------------------------------------------

def dotted_rule(width: int, palette: Palette) -> Text:
    count = max(1, (width - 4) // 2)
    return Text(GUTTER + "· " * count, palette.style("gold"))


def user_turn(text: str, palette: Palette, width: int):
    body = Text(style="k.user")
    body.append("you  ", palette.style("meta") + palette.band())
    body.append(clean(text), palette.style("text") + palette.band())
    return Padding(body, (0, 0, 0, 2), style=palette.band() if palette.depth not in ("16", "none") else "")


def speaker(palette: Palette, name: str = "kairos") -> Text:
    return Text(GUTTER + name, palette.style("accent", bold=True))


def tool_cell(step: dict, palette: Palette, expanded: bool = False):
    """A Forge tool step or a computer event, on one line."""
    name = one_line(step.get("name") or step.get("tool") or step.get("action") or "tool", 24)
    target = one_line(step.get("summary") or step.get("target") or step.get("detail") or "", 60)
    phase = step.get("phase")
    if phase == "started":
        status, role = "running", "gold"
    elif step.get("ok") is False or step.get("status") == "failed":
        status, role = "failed", "danger"
    elif step.get("status") == "asks":
        status, role = "asks you", "warn"
    else:
        status, role = "done", "success"
    seconds = step.get("seconds")
    line = Text("   ▸ ", palette.style("gold"))
    line.append(f"{name:<12} ", palette.style("text", bold=True))
    line.append(f"{target:<44} ", palette.style("dim"))
    line.append(status, palette.style(role))
    if isinstance(seconds, (int, float)) and phase != "started":
        line.append(f"  {seconds:.1f}s", palette.style("meta"))
    if not expanded or not step.get("output"):
        return line
    output = clean(str(step.get("output")))
    lines = output.splitlines()[:40]
    return Group(line, Padding(Text("\n".join(lines), palette.style("meta")), (0, 0, 0, 6)))


def finished_line(status: str, seconds: float, palette: Palette, error: str | None = None) -> Text:
    role = {"done": "success", "failed": "danger", "stopped": "warn"}.get(status, "meta")
    words = {"done": "done", "failed": "failed", "stopped": "stopped"}.get(status, status)
    line = Text(GUTTER + "· ", palette.style("gold"))
    line.append(words, palette.style(role))
    line.append(f" in {seconds:.1f}s", palette.style("meta"))
    if error:
        line.append("  " + one_line(error, 160), palette.style("danger"))
    return line


def permission_box(request: dict, palette: Palette, width: int, note: str = ""):
    """The terminal's approval prompt. Text only, from the request's own
    fields; the choices are the request's own, numbered 1 to 4."""
    tool = one_line(request.get("tool"), 40)
    body = Text()
    title = one_line(request.get("title") or tool, 200)
    body.append(title + "\n", palette.style("text", bold=True))
    if request.get("description"):
        body.append(one_line(request["description"], 400) + "\n", palette.style("dim"))
    if request.get("target"):
        body.append(one_line(request["target"], 200) + "\n", palette.style("accent"))
    arguments = request.get("arguments")
    if arguments:
        text = clean(arguments if isinstance(arguments, str) else str(arguments))
        lines = text.splitlines()
        shown = "\n".join(line[: max(20, width - 10)] for line in lines[:6])
        body.append(shown + ("\n…" if len(lines) > 6 else "") + "\n", palette.style("meta"))
    choices = Text()
    for number, choice in enumerate((request.get("choices") or [])[:9], start=1):
        role = "danger" if choice.get("behavior") == "deny" else "accent"
        choices.append(f"{number} ", palette.style("gold", bold=True))
        choices.append(one_line(choice.get("label"), 60), palette.style(role))
        choices.append("   ")
    body.append_text(choices)
    if note:
        body.append("\n" + note, palette.style("warn"))
    return Panel(body, title=Text(f" Kairos wants to use {tool} ", palette.style("accent")), title_align="left",
                 border_style=palette.style("gold"), box=box.ROUNDED, width=min(width - 2, 100), padding=(0, 1))


# -- diffs -----------------------------------------------------------------------------

def _mix(a: str, b: str, t: float) -> str:
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(ca, cb))


def diff_tints(palette: Palette) -> tuple[Style, Style]:
    """Add and delete backgrounds, derived from the brand's success and
    danger over the theme's ground. Plain sign colours below truecolour."""
    if palette.depth != "truecolor":
        return palette.style("success"), palette.style("danger")
    ground = "#16120F" if palette.name == "night" else "#F3EADB"
    add = _mix(ground, palette.hex("success"), 0.22 if palette.name == "night" else 0.16)
    delete = _mix(ground, palette.hex("danger"), 0.22 if palette.name == "night" else 0.14)
    return Style(bgcolor=add), Style(bgcolor=delete)


def _lexer(path: str) -> str:
    from pygments.lexers import get_lexer_for_filename
    try:
        return get_lexer_for_filename(path).aliases[0]
    except Exception:
        return "text"


def render_diff(files: list[dict], palette: Palette, width: int):
    """Forge changes as Codex draws a diff: per file a header with +/-
    counts, then hunks with old and new line numbers, gutter signs, syntax
    colour and add/delete tints."""
    add_style, delete_style = diff_tints(palette)
    out = []
    if not files:
        return Text(GUTTER + "No changes yet.", palette.style("meta"))
    for row in files:
        path = one_line(row.get("path"), 200)
        header = Text(GUTTER + "● ", palette.style("gold"))
        header.append(path, palette.style("text", bold=True))
        if row.get("untracked"):
            header.append("  new", palette.style("info"))
        if row.get("added") is not None:
            header.append(f"  +{row['added']}", palette.style("success"))
            header.append(f" -{row.get('removed') or 0}", palette.style("danger"))
        out.append(header)
        if row.get("binary") or not row.get("patch"):
            out.append(Text("     " + (row.get("unavailable") or "binary file"), palette.style("meta")))
            continue
        syntax = Syntax("", _lexer(path), theme=syntax_theme(palette), background_color="default") \
            if palette.depth != "none" else None
        old = new = 0
        for raw in clean(row["patch"]).splitlines():
            hunk = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$", raw)
            if hunk:
                old, new = int(hunk.group(1)), int(hunk.group(2))
                line = Text("     ⋯ ", palette.style("gold"))
                line.append(hunk.group(3).strip(), palette.style("meta"))
                out.append(line)
                continue
            if raw.startswith(("diff --git", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename ", "old mode", "new mode", "\\ No newline")):
                continue
            sign, code = (raw[:1], raw[1:]) if raw[:1] in "+- " else (" ", raw)
            if sign == "+":
                numbers, tint, mark_style = f"{'':>5} {new:>5} ", add_style, palette.style("success", bold=True)
                new += 1
            elif sign == "-":
                numbers, tint, mark_style = f"{old:>5} {'':>5} ", delete_style, palette.style("danger", bold=True)
                old += 1
            else:
                numbers, tint, mark_style = f"{old:>5} {new:>5} ", Style(), palette.style("meta")
                old += 1
                new += 1
            line = Text(numbers, palette.style("meta"))
            line.append(sign + " ", mark_style + (tint if sign != " " else Style()))
            body = syntax.highlight(code) if syntax else Text(code)
            body.rstrip()
            body.stylize(tint)
            line.append_text(body)
            if sign != " " and palette.depth == "truecolor":
                pad = max(0, width - line.cell_len - 1)
                line.append(" " * pad, tint)
            out.append(line)
    return Group(*out)


# -- brand moments ---------------------------------------------------------------------

# A five-row block wordmark. Gold, shaded left to right on truecolour.
_LETTERS = {
    "K": ["█  █", "█ █ ", "██  ", "█ █ ", "█  █"],
    "A": [" ██ ", "█  █", "████", "█  █", "█  █"],
    "I": ["███", " █ ", " █ ", " █ ", "███"],
    "R": ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
    "O": [" ██ ", "█  █", "█  █", "█  █", " ██ "],
    "S": [" ███", "█   ", " ██ ", "   █", "███ "],
}
TAGLINE = "The right moment, in your terminal."


def wordmark(palette: Palette) -> list[Text]:
    rows = ["  ".join(_LETTERS[c][r] for c in "KAIROS") for r in range(5)]
    width = len(rows[0])
    out = []
    for row in rows:
        line = Text()
        for x, char in enumerate(row):
            if char == " ":
                line.append(" ")
            elif palette.truecolor:
                line.append(char, Style(color=_mix(palette.hex("gold"), palette.hex("gold_hi"), x / max(1, width - 1))))
            else:
                line.append(char, palette.style("gold"))
        out.append(line)
    return out


_BAYER4 = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
# braille dot bit for (column, row) inside one 2 x 4 cell
_DOTS = ((0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80))


def halftone_sky(width: int, rows: int, palette: Palette, seconds: float = 10.0, fade_seconds: float = 1.2) -> list[Text]:
    """The welcome's halftone sky: braille dots, ordered-dithered (the same
    Bayer 4 x 4 idea as static/js/dither.js), densest at the top and around
    a low sun on the right, gold fading into the meta colour. It fades in
    over fade_seconds; a still frame is seconds >= fade_seconds."""
    reveal = min(1.0, max(0.0, seconds / fade_seconds)) if fade_seconds > 0 else 1.0
    px_w, px_h = width * 2, rows * 4
    sun_x, sun_y = px_w * 0.78, px_h * 1.1
    out = []
    for row in range(rows):
        line = Text()
        for col in range(width):
            bits = 0
            for dx, dy, bit in _DOTS:
                x, y = col * 2 + dx, row * 4 + dy
                sky = 1.0 - y / px_h                          # densest at the top
                glow = max(0.0, 1.0 - math.hypot((x - sun_x) / (px_w * 0.28), (y - sun_y) / (px_h * 1.1)))
                drift = 0.5 + 0.5 * math.sin(x / px_w * math.pi * 1.5)   # a slow band of cloud
                value = min(1.0, 0.42 * sky ** 1.8 * (0.55 + 0.45 * drift) + 0.95 * glow ** 1.6) * reveal
                if value * 16 > _BAYER4[y % 4][x % 4] + 0.5:
                    bits |= bit
            char = chr(0x2800 + bits)
            if palette.truecolor:
                t = row / max(1, rows - 1)
                color = _mix(palette.hex("gold"), palette.hex("meta"), t)
                line.append(char, Style(color=color))
            else:
                line.append(char, palette.style("gold" if row < rows / 2 else "meta"))
        out.append(line)
    return out


def braille_bar(seconds: float, palette: Palette, cells: int = 8) -> Text:
    """The working indicator: a row of braille cells that fills like a
    halftone gradient, the fill sweeping left to right."""
    out = Text()
    phase = (seconds * 1.4) % 2.0
    for col in range(cells):
        position = col / max(1, cells - 1)
        distance = abs(position - (phase - 0.5))
        density = max(0.0, 1.0 - distance * 1.6)
        bits = 0
        for dx, dy, bit in _DOTS:
            if density * 16 > _BAYER4[dy][(col * 2 + dx) % 4] + 0.5:
                bits |= bit
        role = "gold_hi" if density > 0.6 else "gold"
        out.append(chr(0x2800 + (bits or 0x40)), palette.style(role))
    return out


def shimmer(label: str, seconds: float, palette: Palette) -> Text:
    """Codex's shimmer, in gold: a highlight sweeps across the label."""
    out = Text()
    if not palette.truecolor:
        return Text(label, palette.style("accent"))
    span = len(label) + 8
    centre = (seconds * 14) % span - 4
    for index, char in enumerate(label):
        t = max(0.0, 1.0 - abs(index - centre) / 4.0)
        out.append(char, Style(color=_mix(palette.hex("dim"), palette.hex("gold_hi"), t)))
    return out


def status_line(model: str, mode: str, place: str, working: bool, palette: Palette) -> Text:
    line = Text(GUTTER)
    line.append("● " if working else "○ ", palette.style("gold" if working else "meta"))
    for index, part in enumerate(p for p in (model, mode, place) if p):
        if index:
            line.append(" · ", palette.style("meta"))
        line.append(one_line(part, 60), palette.style("dim"))
    return line


def footer(hints: list[tuple[str, str]], palette: Palette) -> Text:
    line = Text(GUTTER)
    for index, (key, words) in enumerate(hints):
        if index:
            line.append(" · ", palette.style("meta"))
        line.append(key, palette.style("dim"))
        line.append(f" {words}", palette.style("meta"))
    return line


def table_of(rows: list[list[str]], headers: list[str], palette: Palette) -> Table:
    table = Table(box=box.SIMPLE_HEAD, border_style=palette.style("gold"), header_style=palette.style("accent"),
                  show_edge=False, pad_edge=False)
    for header in headers:
        table.add_column(header)
    for row in rows:
        table.add_row(*[Text(one_line(cell, 80), palette.style("text")) for cell in row])
    return Padding(table, (0, 0, 0, 2))


def question_box(request, palette, width, state, note=""):
    questions = request.get("questions") or []
    index = min(state.get("index", 0), len(questions) - 1)
    question = questions[index] if questions else {}
    body = Text()
    if len(questions) > 1:
        body.append(f"{index + 1} of {len(questions)}\n", palette.style("dim"))
    body.append(one_line(question.get("question"), 2000) + "\n", palette.style("text", bold=True))
    for i, option in enumerate(question.get("options", []), 1):
        mark = "[x] " if i - 1 in state.get("toggles", set()) else ""
        body.append(f"{i} {mark}" + one_line(option.get("label"), 200) + "\n", palette.style("accent"))
        if option.get("description"):
            body.append("  " + one_line(option["description"], 500) + "\n", palette.style("dim"))
    body.append("1-9 toggle, enter to confirm" if question.get("multiSelect") else "1-9 choose", palette.style("dim"))
    body.append("\ntype an answer and press enter for Other\nesc to skip", palette.style("dim"))
    if note:
        body.append("\n" + one_line(note, 400), palette.style("warn"))
    return Panel(body, title=Text(" Waiting for your response "), title_align="left",
                 border_style=palette.style("gold"), box=box.ROUNDED, width=min(width - 2, 100), padding=(0, 1))
