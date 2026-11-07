"""Instant acknowledgement: a short, natural sound while the real answer is still being written.

When no first sentence is ready about half a second after the user stopped, Kairos says something small ("Mm, let me
think.", "Okay.", "Sure.") so the line never goes dead. The rules (when to play, which one) live here and are tested;
the audio is rendered by the voice that will speak the answer, lazily, once per voice, and kept on disk.

  - skipped when the answer is quick (a sentence is ready before FILLER_AFTER_MS)
  - skipped for work updates and when the assistant is muted
  - never the same phrase twice in a row, never a request-style "Sure." for a plain question
  - nothing plays until it is cached: the first need only starts the render, so a filler is never itself a delay
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import random
import re
import struct
from typing import Optional

logger = logging.getLogger(__name__)

FILLER_AFTER_MS = 500

# (id, text, kind). "request" ones acknowledge being asked to do something; "question" ones buy thinking time.
FILLERS = (
    ("think", "Mm, let me think.", "question"),
    ("okay", "Okay.", "any"),
    ("sure", "Sure.", "request"),
    ("see", "Let me see.", "any"),
    ("moment", "One moment.", "any"),
    ("hm", "Hmm, good question.", "question"),
    ("right", "Right, give me a second.", "any"),
    ("alright", "Alright.", "request"),
)
_BY_ID = {item[0]: item for item in FILLERS}
_REQUEST = re.compile(r"^(?:please\b|can you\b|could you\b|would you\b|will you\b|i need\b|i want\b|i'd like\b|go ahead\b|"
                      r"remind\b|set\b|add\b|send\b|make\b|open\b|schedule\b|find\b|check\b|look\b|tell\b|show\b|write\b|create\b|book\b|call\b)")


def kind_of(user_text: str) -> str:
    """"request" for something the user wants done, else "question"."""
    text = re.sub(r"^(?:hey|ok|okay|so|and|well|um|uh)[,\s]+", "", str(user_text or "").strip().lower())
    return "request" if _REQUEST.search(text) else "question"


def should_play(elapsed_ms: float, *, first_sentence_ready: bool, muted: bool = False, work_update: bool = False,
                user_speaking: bool = False) -> bool:
    """May a filler play now? `elapsed_ms` counts from the end of the user's turn."""
    if muted or work_update or user_speaking or first_sentence_ready:
        return False
    return elapsed_ms >= FILLER_AFTER_MS


def pick(last: Optional[str] = None, user_text: str = "", rng=random) -> tuple:
    """(id, text) of a filler that is not `last` and fits what the user said."""
    kind = kind_of(user_text)
    pool = [item for item in FILLERS if item[2] in ("any", kind) and item[0] != last]
    chosen = rng.choice(pool or [item for item in FILLERS if item[0] != last])
    return chosen[0], chosen[1]


def text_of(ident: str) -> Optional[str]:
    return _BY_ID[ident][1] if ident in _BY_ID else None


# -- the cache: one small file per (voice, phrase) ----------------------------------------------------------------

def _key(model: str, voice: str, ident: str) -> str:
    return hashlib.sha256(f"{model}\x00{voice}\x00{ident}".encode()).hexdigest()[:32]


def _folder() -> str:
    from core import accounts
    return accounts.path("voice_fillers")


def cached(model: str, voice: str, ident: str):
    """(sample_rate, pcm16 bytes) if this phrase has been rendered for this voice, else None."""
    path = os.path.join(_folder(), _key(model, voice, ident) + ".pcm")
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    if len(data) < 8:
        return None
    (rate,) = struct.unpack("<I", data[:4])
    return rate, data[4:]


def store(model: str, voice: str, ident: str, rate: int, pcm: bytes) -> None:
    folder = _folder()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, _key(model, voice, ident) + ".pcm")
    temporary = path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(struct.pack("<I", rate) + pcm)
    os.replace(temporary, path)


_rendering: dict = {}


async def render(model: str, voice: str, ident: str) -> bool:
    """Render one phrase with the call's own voice engine and keep it. False if the engine could not."""
    text = text_of(ident)
    if text is None:
        return False
    if cached(model, voice, ident):
        return True
    key = (model, voice, ident)
    if key in _rendering:
        return await _rendering[key]

    async def work() -> bool:
        from core import call_voices
        rate, chunks = None, []
        try:
            async for item in call_voices.pcm(text, model, voice):
                if "sample_rate" in item:
                    rate = item["sample_rate"]
                elif "audio" in item:
                    chunks.append(item["audio"])
            if not rate or not chunks:
                return False
            store(model, voice, ident, rate, b"".join(chunks))
            return True
        except Exception:
            logger.info("voice filler %s could not be rendered", ident)
            return False

    task = asyncio.ensure_future(work())
    _rendering[key] = task
    try:
        return await task
    finally:
        _rendering.pop(key, None)


async def warm(model: str, voice: str) -> int:
    """Render every phrase for a voice (a call start does this in the background). Returns how many are cached."""
    done = 0
    for ident, _text, _kind in FILLERS:
        if await render(model, voice, ident):
            done += 1
    return done


def event_lines(ident: str, model: str, voice: str):
    """The NDJSON lines for one filler: its text always, its audio when it is cached. With a neural voice named, a
    phrase that is not cached yet answers `cached: false` (the caller stays quiet; the route renders it for next time)."""
    text = text_of(ident)
    if text is None:
        return []
    lines = [json.dumps({"filler": {"id": ident, "text": text}})]
    neural = bool(model and voice)
    found = cached(model, voice, ident) if neural else None
    if neural and not found:
        lines.append(json.dumps({"cached": False}))
    if found:
        rate, pcm = found
        lines.append(json.dumps({"sample_rate": rate}))
        for at in range(0, len(pcm), 48000):
            lines.append(json.dumps({"audio": base64.b64encode(pcm[at:at + 48000]).decode()}))
    return lines
