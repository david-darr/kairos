"""Bot speech and private voice-note files, using the installed local PCM adapter."""
import asyncio
import hashlib
import io
import os
from pathlib import Path
import re
import threading
import uuid
import wave
import textwrap

from core import call_voices
from core.atomic_io import read_json, write_json_atomic
from typing import Optional

from core.constants import DATA_DIR
from core.logs import scrub_credentials

ROOT: Optional[Path] = None  # a test can point it at its own folder


def root() -> Path:
    from core import accounts
    return ROOT or Path(accounts.path("bot_voice"))

LOCK = threading.RLock()
BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")
SECRET = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|"
                    r"(?:password|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S+", re.I)
DEFAULTS = {"voice": "marin", "read_typed": False, "idle_minutes": 5}
VOICES = ("marin", "cedar", "coral", "sage", "ash")


def private_text(text):
    return bool(SECRET.search(text) or scrub_credentials(text) != text)


class VoiceError(ValueError):
    def __init__(self, text, status=422):
        super().__init__(text)
        self.status = status


def private_dir(owner):
    if not owner:
        raise VoiceError("Sign in first.", 403)
    return root() / hashlib.sha256(owner.encode()).hexdigest()[:24]


def save(path, value):
    write_json_atomic(str(path), value)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def live_settings(owner, patch=None):
    with LOCK:
        path = private_dir(owner) / "live.json"
        result = {**DEFAULTS, **read_json(str(path), {})}
        if patch is not None:
            result.update(patch)
            if (set(patch) - set(DEFAULTS) or result["voice"] not in VOICES or
                    type(result["read_typed"]) is not bool or type(result["idle_minutes"]) is not int or
                    not 1 <= result["idle_minutes"] <= 60):
                raise VoiceError("Choose a supported voice and an idle time from 1 to 60 minutes.")
            save(path, result)
        return result


def prepare(text):
    """Same first-sentence, then two-sentence breaths as voiceOutput.createChunker.

    Filter before splitting: a multiline key must never leak its trailing lines.
    Streaming clients retain the unfinished final breath until the final frame.
    """
    if not isinstance(text, str) or len(text) > 100_000:
        raise VoiceError("Speech is limited to 100,000 characters.")
    if private_text(text):
        return {"blocks": [], "withheld": True}
    sentences = [s.strip() for s in BOUNDARY.split(text) if s.strip()]
    breaths = sentences[:1] + [" ".join(sentences[i:i + 2]) for i in range(1, len(sentences), 2)]
    # The existing local engine accepts at most 1,600 characters per render.
    blocks = [part for breath in breaths for part in textwrap.wrap(breath, width=1500, replace_whitespace=False, drop_whitespace=True)]
    return {"blocks": blocks, "withheld": False}


async def selection(voice_id=None):
    if not call_voices.configuration().get("url"):
        raise VoiceError("A voice note needs a local voice engine", 409)
    try:
        catalog = await call_voices.catalog()
    except Exception:
        raise VoiceError("Local voices could not load. Check the voice engine.", 409) from None
    if not catalog.get("models") or not catalog.get("voices"):
        raise VoiceError("A voice note needs a local voice engine", 409)
    voice = voice_id or catalog["voices"][0]["id"]
    if voice not in {v["id"] for v in catalog["voices"]}:
        raise VoiceError("That voice is unavailable. Choose a voice again.", 409)
    return catalog["models"][0], voice


async def audio_events(text, voice_id=None):
    if not text.strip() or len(text) > 1600 or private_text(text):
        raise VoiceError("This speech block cannot be read aloud.")
    model, voice = await selection(voice_id)
    async for item in call_voices.pcm(text, model, voice):
        yield item


async def note(bot_id, text, owner):
    from services.agent_service import agent_service
    bot = agent_service.get(bot_id)
    if not bot or bot.get("owner_user") not in (None, "", owner):
        raise VoiceError("Bot not found", 404)
    if not isinstance(text, str) or not text.strip() or len(text) > 1000:
        raise VoiceError("A voice note needs 1 to 1,000 characters.")
    if private_text(text):
        raise VoiceError("This note contains private text and cannot be spoken.")
    pcm = bytearray()
    rate = None
    try:
        async with asyncio.timeout(180):
            async for item in audio_events(text, bot.get("voice_id")):
                if "sample_rate" in item:
                    current = item["sample_rate"]
                    if type(current) is not int or not 8000 <= current <= 96000 or rate not in (None, current):
                        raise ValueError("Invalid audio rate")
                    rate = current
                if "audio" in item:
                    if not rate:
                        raise ValueError("Missing audio format")
                    pcm.extend(item["audio"])
                    if len(pcm) > min(34_560_000, rate * 2 * 180):
                        raise ValueError("Audio limit")
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("The voice note could not be made. Check the local voice engine.", 502) from None
    if not rate or not pcm or len(pcm) % 2:
        raise VoiceError("The voice engine returned incomplete audio.", 502)
    ident = uuid.uuid4().hex
    folder = private_dir(owner)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (ident + ".wav")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm)
    try:
        with path.open("xb") as output:
            output.write(buf.getvalue())
        os.chmod(path, 0o600)
        save(folder / (ident + ".json"), {"bot_id": bot_id, "transcript": text})
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return {"url": f"/api/bot-voice/notes/{ident}/audio", "seconds": len(pcm) / (rate * 2),
            "transcript": text, "transcript_url": f"/api/bot-voice/notes/{ident}/transcript"}


def note_file(owner, ident, suffix):
    if not re.fullmatch(r"[0-9a-f]{32}", ident):
        raise VoiceError("Voice note not found", 404)
    path = private_dir(owner) / (ident + suffix)
    if not path.is_file():
        raise VoiceError("Voice note not found", 404)
    return path


async def tool_note(args, ctx):
    from core.tool_registry import _bot_scope
    from services.bot_widgets import append_rich_row
    try:
        scope = _bot_scope(ctx)
        if not scope.get("thread_id"):
            raise VoiceError("Open a conversation first.")
        result = await note(scope["bot_id"], args.get("text"), scope["owner"])
        fields = {k: result[k] for k in ("url", "seconds", "transcript_url")}
        append_rich_row(scope["thread_id"], scope["bot_id"], "voice_note", "Voice note", {"voice_note": fields})
        return "Voice note added to this conversation."
    except (VoiceError, ValueError, KeyError) as error:
        return f"Not made: {error}"


TOOLS = [{"name": "voice_note", "description": "Leave a short spoken note in this conversation using your local voice.",
          "effect": "write", "handler": tool_note,
          "schema": {"type": "object", "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 1000}},
                     "required": ["text"], "additionalProperties": False}}]
