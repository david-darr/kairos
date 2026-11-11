"""The goal control block, kept out of everything the person sees or hears.

In "Work until done" a bot ends each reply with a private control line, <kairos-goal>{"status": ..., "instruction": ...,
"detail": ...}</kairos-goal> (services/bot_goal_runs.py reads it). Two ways it used to reach the person (David,
2026-11-11, Kip's reply ended in a raw {"status": "needs-input", ...} line):
- a model that saw the format earlier in a thread writes the block in an ordinary turn, where no filter ran, and the
  chat's HTML sanitizer drops the unknown <kairos-goal> tags but keeps the JSON between them;
- a model writes the JSON bare, without the tags.

So every reply is cleaned, live and saved, in the Bots chat, the classic chat, Discord and Telegram replies and call
speech: tagged blocks anywhere, an unfinished opening tag at the end, and a bare JSON object of exactly the goal shape
(only status, instruction and detail, string values, a known status) at the very end of a reply that has other text
before it. Any other JSON, and a goal-shaped object that is the whole reply (something the person asked for), stays.
"""
import json
import re

OPEN, CLOSE = "<kairos-goal>", "</kairos-goal>"
STATUSES = ("continue", "completed", "needs-input", "blocked")
KEYS = ("status", "instruction", "detail")
ENVELOPE = re.compile(re.escape(OPEN) + r"(.*?)" + re.escape(CLOSE), re.DOTALL)
MAX_BARE = 6000                      # a goal block is short; anything longer held back is released as ordinary text
_KEY_OPENINGS = tuple(f'"{key}"' for key in KEYS)


def goal_shaped(value) -> bool:
    """Exactly the goal block's shape: a known status and nothing but the goal's own string fields."""
    return (isinstance(value, dict) and value.get("status") in STATUSES and set(value) <= set(KEYS)
            and len(value) >= 2 and all(isinstance(item, str) for item in value.values()))


def _object_end(text: str, start: int) -> int:
    """Just past the JSON object opening at text[start], or -1 when it does not close within text."""
    depth, quoted, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return -1


def _load(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return None


def trailing(text: str) -> tuple[str, dict | None]:
    """(the text before it, the block) when `text` ends with a bare goal-shaped JSON object; else (text, None)."""
    body = (text or "").rstrip()
    if not body.endswith("}"):
        return text or "", None
    floor = max(0, len(body) - MAX_BARE)
    start = body.rfind("{", floor)
    while start >= floor:
        if (start == 0 or body[start - 1].isspace()) and _object_end(body, start) == len(body):
            value = _load(body[start:])
            if goal_shaped(value):
                return body[:start], value
        start = body.rfind("{", floor, start)
    return text or "", None


def split(text: str, goal: bool = False) -> tuple[str, dict | None]:
    """(what the person sees, the last goal block or None). Tagged blocks go wherever they are; a bare one only at the
    end. `goal` (a goal turn, where the reply is expected to carry one): a bare block that is the whole reply goes too."""
    raw = text or ""
    blocks = [_load(match.group(1)) for match in ENVELOPE.finditer(raw)]
    visible = ENVELOPE.sub("", raw)
    cut = visible.find(OPEN)                 # an opening tag that never closed
    if cut >= 0:
        visible = visible[:cut]
    before, bare = trailing(visible)
    if bare is not None and (goal or before.strip()):
        visible = before
        blocks.append(bare)
    if visible == raw:
        return raw, (blocks[-1] if blocks else None)
    return visible.rstrip(), (blocks[-1] if blocks else None)


def strip(text: str, goal: bool = False) -> str:
    """The reply without any goal block. Text with none is returned exactly as it was."""
    return split(text, goal)[0]


class StreamFilter:
    """Keeps goal blocks out of streamed text, chunk by chunk, with the same rules as strip().

    Tags: anything that could still become the opening tag is held until the next chunk shows what it is, and a block
    is dropped whole. Bare blocks: a "{" at the start of the reply or after whitespace, followed by one of the goal's
    keys, is held until it closes. A goal-shaped object followed only by whitespace is held to the end of the reply
    and dropped there (kept when it was the whole reply, unless `goal`); anything else is released at once."""

    def __init__(self, goal: bool = False):
        self.goal = goal
        self.held = ""          # a possible opening or closing tag
        self.inside = False     # inside a tagged block
        self.bare = ""          # a possible bare block
        self.shown = False      # visible text has gone out
        self.last = ""          # the last visible character that went out

    # -- tags --------------------------------------------------------------------------------------------------

    def _tags(self, chunk: str) -> str:
        text, out = self.held + chunk, ""
        self.held = ""
        while text:
            if self.inside:
                end = text.find(CLOSE)
                if end >= 0:
                    text, self.inside = text[end + len(CLOSE):], False
                    continue
                keep = _tail_prefix(text, CLOSE)
                self.held = text[len(text) - keep:] if keep else ""
                break
            start = text.find(OPEN)
            if start >= 0:
                out += text[:start]
                text, self.inside = text[start + len(OPEN):], True
                continue
            keep = _tail_prefix(text, OPEN)
            out += text[:len(text) - keep]
            self.held = text[len(text) - keep:] if keep else ""
            break
        return out

    # -- bare blocks ---------------------------------------------------------------------------------------------

    def _emit(self, text: str) -> str:
        if text:
            self.last = text[-1]
            if text.strip():
                self.shown = True
        return text

    def _candidate(self, text: str) -> int:
        for index, char in enumerate(text):
            if char == "{":
                before = text[index - 1] if index else self.last
                if before == "" or before.isspace():
                    return index
        return -1

    def _holding(self) -> bool:
        """Whether the held "{..." may still be a trailing goal block."""
        held = self.bare
        if len(held) > MAX_BARE:
            return False
        opening = held[1:].lstrip()
        if not any(key.startswith(opening) or opening.startswith(key) for key in _KEY_OPENINGS):
            return False        # not one of the goal's keys: ordinary text
        end = _object_end(held, 0)
        if end < 0:
            return True
        return goal_shaped(_load(held[:end])) and not held[end:].strip()

    def _bare(self, text: str) -> str:
        out = ""
        while True:
            if self.bare:
                self.bare += text
                text = ""
                if self._holding():
                    return out
                text, self.bare = self.bare[1:], ""
                out += self._emit("{")
                continue
            if not text:
                return out
            start = self._candidate(text)
            if start < 0:
                return out + self._emit(text)
            out += self._emit(text[:start])
            self.bare, text = "{", text[start + 1:]

    # -- the stream ------------------------------------------------------------------------------------------------

    def feed(self, chunk: str) -> str:
        return self._bare(self._tags(chunk))

    def flush(self) -> str:
        """Whatever is still held when the reply ends. An unfinished tagged block, and a trailing goal block, are dropped."""
        tail = "" if self.inside else self.held
        self.held, self.inside = "", False
        out = self._bare(tail)
        held, self.bare = self.bare, ""
        if not held:
            return out
        end = _object_end(held, 0)
        complete = end > 0 and not held[end:].strip() and goal_shaped(_load(held[:end]))
        if complete and (self.goal or self.shown or out.strip()):
            return out
        return out + self._emit(held)


def _tail_prefix(text: str, tag: str) -> int:
    """Length of the longest tail of `text` that begins `tag` (but is not all of it)."""
    for size in range(min(len(tag) - 1, len(text)), 0, -1):
        if tag.startswith(text[-size:]):
            return size
    return 0
