"""Untrusted text, made safe to print.

Model output, tool arguments, chat titles and file names can all carry
terminal escape sequences: a reply could clear the screen, retitle the
window, rewrite earlier lines or fake a permission prompt. Everything from
the backend goes through clean() before it reaches the terminal, as Codex
does before inserting history (spec section 6). Rich markup is never parsed
from it either: callers build Text objects, never markup strings.
"""
import re

# Whole escape sequences first (CSI, OSC, DCS/SOS/PM/APC, two-byte ESC), so
# their parameters do not survive as visible junk; then any lone control
# character. Tab and newline are kept; carriage return is dropped, because it
# would let a line overwrite itself.
_SEQUENCES = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"            # CSI
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\x5c)?"  # OSC, ended by BEL or ST
    r"|\x1b[PX^_][^\x1b]*(?:\x1b\x5c)?"      # DCS, SOS, PM, APC
    r"|\x9b[0-?]*[ -/]*[@-~]"             # 8-bit CSI
    r"|\x1b[@-_]?"                         # anything else starting with ESC
)
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# Bidirectional overrides can reorder what a line appears to say.
_BIDI = re.compile(r"[‪-‮⁦-⁩]")


def clean(text, keep_newlines: bool = True) -> str:
    if text is None:
        return ""
    value = _SEQUENCES.sub("", str(text))
    value = _CONTROLS.sub("", value)
    value = _BIDI.sub("", value)
    if not keep_newlines:
        value = value.replace("\n", " ").replace("\t", " ")
    return value


def one_line(text, limit: int = 120) -> str:
    value = " ".join(clean(text, keep_newlines=False).split())
    return value if len(value) <= limit else value[: max(0, limit - 1)] + "…"
