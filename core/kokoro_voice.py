"""Kokoro-82M as an optional neural voice engine that Kairos runs itself (build spec step 7).

It plugs into the existing neural-voice architecture (core/call_voices.py): protocol "kokoro" sits beside "voicestudio"
and "compatible", and answers the same two questions (which voices exist, give me PCM for this sentence), so the
prefetching speaker in static/js/callVoice.js and the bots read-aloud queue use it unchanged.

Gated on three things, each reported honestly and none of them fetched automatically: the model + voices files
(user-started download, core/speech_optional.py), onnxruntime, and the `kokoro_onnx` package that turns text into
phonemes and drives the model. If any is missing the engine is simply unavailable: `ready()` says why, `voices()` is
empty, `synthesize()` raises KokoroUnavailable, and the device (OS) voice stays the fallback. Nothing here can crash a
call.
"""
import logging
import threading

from core import speech_optional

logger = logging.getLogger(__name__)

NAME = "kokoro"
SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"
MAX_TEXT = 1600

_lock = threading.Lock()
_engine = None

# A test supplies a fake engine without onnxruntime. Called with (model_path, voices_path); the result needs
# get_voices() -> list[str] and create(text, voice=, speed=, lang=) -> (float32 samples, sample_rate).
ENGINE_FACTORY = None


class KokoroUnavailable(Exception):
    """Message is meant to be shown to the user as-is."""


def reset() -> None:
    global _engine
    with _lock:
        _engine = None


def ready() -> tuple[bool, str | None]:
    if ENGINE_FACTORY is None:
        missing = speech_optional.missing_runtime(NAME)
        if missing:
            return False, speech_optional.runtime_message(missing)
    if not speech_optional.downloaded(NAME):
        return False, "Kokoro is not downloaded"
    return True, None


def _get_engine():
    global _engine
    with _lock:
        if _engine is not None:
            return _engine
        model, voices = speech_optional.path_of(NAME, 0), speech_optional.path_of(NAME, 1)
        if ENGINE_FACTORY is not None:
            _engine = ENGINE_FACTORY(model, voices)
        else:
            from kokoro_onnx import Kokoro
            _engine = Kokoro(model, voices)
        return _engine


def voices() -> list[dict]:
    ok, _ = ready()
    if not ok:
        return []
    try:
        names = sorted(str(v) for v in _get_engine().get_voices())
    except Exception:
        logger.exception("kokoro: could not list voices")
        return []
    return [{"id": v, "name": v} for v in names]


def warm() -> bool:
    """Load the model and voices and render one short phrase, so a call's first sentence does not pay the load and
    onnxruntime's first-run setup (about four seconds cold on David's machine, against about a quarter second warm).
    A call start does this in the background when Kokoro is the call voice. Never raises; False when not set up."""
    if not ready()[0]:
        return False
    try:
        synthesize("Okay.", DEFAULT_VOICE)
        return True
    except Exception:
        logger.exception("kokoro: warm-up failed")
        return False


def synthesize(text: str, voice: str) -> bytes:
    """One sentence -> 24 kHz mono PCM16 bytes. Blocking; call from a worker thread."""
    ok, reason = ready()
    if not ok:
        raise KokoroUnavailable(reason)
    if not text or not text.strip() or len(text) > MAX_TEXT:
        raise KokoroUnavailable("That text cannot be spoken.")
    import numpy as np
    try:
        engine = _get_engine()
        wanted = voice if voice and voice != "default" else DEFAULT_VOICE
        samples, rate = engine.create(text, voice=wanted, speed=1.0, lang="en-us")
    except Exception as e:
        logger.exception("kokoro: synthesis failed")
        raise KokoroUnavailable("Kokoro could not speak. Check its download and the selected voice.") from e
    if rate != SAMPLE_RATE:
        raise KokoroUnavailable("Kokoro returned an unexpected audio format.")
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    return pcm.tobytes()
