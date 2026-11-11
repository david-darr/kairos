"""Kokoro-82M as an optional neural voice engine that Kairos runs itself (build spec step 7).

It plugs into the existing neural-voice architecture (core/call_voices.py): protocol "kokoro" sits beside "voicebox",
"elevenlabs" and "compatible", and answers the same two questions (which voices exist, give me PCM for this sentence), so the
prefetching speaker in static/js/callVoice.js and the bots read-aloud queue use it unchanged.

Gated on two things, each reported honestly: the model + voices files (a user-started download,
core/speech_optional.py) and the runtime that ships with the app: onnxruntime, plus misaki with spaCy's English model,
which turn text into phonemes (core/kokoro_g2p.py; Apache-2.0 and MIT, no espeak-ng). core/kokoro_engine.py drives the
model. If anything is missing the engine is simply unavailable: `ready()` says why, `voices()` is empty,
`synthesize()` raises KokoroUnavailable, and the device (OS) voice stays the fallback. Nothing here can crash a call.
A voice whose id starts with "b" (bf_emma, bm_george) is read with British English rules, every other with American.

Where it runs: the best execution provider this machine has (core/onnx_providers.py: DirectML on Windows, Core ML on
macOS, else the processor). If the graphics provider fails to load, or fails while speaking, the same sentence is
spoken again on the processor and the processor is used for the rest of the session; `device()` says which is in use
and why, for Settings > Speech.
"""
import logging
import threading

from core import kokoro_g2p, onnx_providers, speech_optional

logger = logging.getLogger(__name__)

NAME = "kokoro"
SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"
MAX_TEXT = 1600

_lock = threading.Lock()
_run_lock = threading.Lock()      # DirectML sessions take one Run at a time (its documented limit)
_engine = None
_provider = None                  # the provider _engine runs on
_failed: dict[str, str] = {}      # provider -> why it was given up on, for this session

# A test supplies a fake engine without onnxruntime. Called with (model_path, voices_path); the result needs
# get_voices() -> list[str] and create(text, voice=, speed=, lang=) -> (float32 samples, sample_rate).
ENGINE_FACTORY = None

# The benchmark pins one provider (e.g. "CPUExecutionProvider") to time it; None means choose the best.
FORCE_PROVIDER = None


class KokoroUnavailable(Exception):
    """Message is meant to be shown to the user as-is."""


def reset(forget_failures: bool = False) -> None:
    global _engine, _provider
    with _lock:
        _engine = None
        _provider = None
        if forget_failures:
            _failed.clear()


def _open(provider: str):
    """A real engine on `provider`. Separate so tests can stand in for onnxruntime per provider."""
    model, voices = speech_optional.path_of(NAME, 0), speech_optional.path_of(NAME, 1)
    from core.kokoro_engine import KokoroEngine
    try:
        kokoro_g2p.warm(british=False)       # misaki + spaCy load once (about 3 s), with the model, not mid-sentence
    except Exception as e:                   # not the graphics card's fault: no provider is given up on for this
        raise KokoroUnavailable("Kokoro's phonemizer could not load.") from e
    return KokoroEngine(onnx_providers.session(model, provider), voices)


def _give_up_on(provider: str, error: Exception) -> None:
    _failed[provider] = (str(error).strip().splitlines() or [type(error).__name__])[0][:200]
    logger.warning("kokoro: %s failed, using the processor from now on: %s", provider, _failed[provider])


def device() -> dict:
    """Which provider Kokoro uses (or will use once loaded), in words for Settings > Speech."""
    if ENGINE_FACTORY is not None:
        provider, loaded = onnx_providers.CPU, _engine is not None
    else:
        loaded = _engine is not None
        provider = _provider if loaded else (FORCE_PROVIDER or onnx_providers.candidates(skip=_failed)[0])
    where = onnx_providers.label(provider)
    gave_up = [p for p in _failed if p != onnx_providers.CPU]
    if gave_up and provider == onnx_providers.CPU:
        card = onnx_providers.label(gave_up[0])
        text = f"Runs on the processor. {card[:1].upper() + card[1:]} could not run it on this PC."
    elif loaded:
        text = f"Runs on {where}."
    else:
        text = f"Will run on {where}."
    return {"provider": provider, "loaded": loaded, "label": where, "text": text, "failed": dict(_failed)}


def ready() -> tuple[bool, str | None]:
    if ENGINE_FACTORY is None:
        missing = speech_optional.missing_runtime(NAME)
        if missing:
            return False, speech_optional.runtime_message(missing)
    if not speech_optional.downloaded(NAME):
        return False, "Kokoro is not downloaded"
    return True, None


def _get_engine():
    global _engine, _provider
    with _lock:
        if _engine is not None:
            return _engine
        if ENGINE_FACTORY is not None:
            model, voices = speech_optional.path_of(NAME, 0), speech_optional.path_of(NAME, 1)
            _engine, _provider = ENGINE_FACTORY(model, voices), onnx_providers.CPU
            return _engine
        order = [FORCE_PROVIDER] if FORCE_PROVIDER else onnx_providers.candidates(skip=_failed)
        for provider in order:
            try:
                engine = _open(provider)
            except KokoroUnavailable:
                raise
            except Exception as e:
                if provider == onnx_providers.CPU or FORCE_PROVIDER:
                    raise
                _give_up_on(provider, e)
                continue
            _engine, _provider = engine, provider
            logger.info("kokoro: loaded on %s", provider)
            return _engine
        raise KokoroUnavailable("Kokoro could not load.")


def _create(engine, provider, text, voice, speed=1.0):
    if provider == onnx_providers.DML:
        with _run_lock:
            return engine.create(text, voice=voice, speed=speed, lang=kokoro_g2p.lang_for_voice(voice))
    return engine.create(text, voice=voice, speed=speed, lang=kokoro_g2p.lang_for_voice(voice))


def _render(text: str, voice: str, speed: float = 1.0):
    """(samples, rate) on the chosen provider; a graphics-provider failure retries the same text on the processor."""
    global _engine, _provider
    engine = _get_engine()
    provider = _provider
    try:
        return _create(engine, provider, text, voice, speed)
    except Exception as e:
        # Only the runtime's own errors count against the provider; a bad voice id or text is not the card's fault.
        runtime_error = type(e).__module__.startswith("onnxruntime")
        if not runtime_error or provider in (None, onnx_providers.CPU) or FORCE_PROVIDER or ENGINE_FACTORY is not None:
            raise
        with _lock:
            _give_up_on(provider, e)
            if _engine is engine:
                _engine, _provider = None, None
        engine = _get_engine()
        return _create(engine, _provider, text, voice, speed)


def voices() -> list[dict]:
    ok, _ = ready()
    if not ok:
        return []
    try:
        names = sorted(str(v) for v in _get_engine().get_voices())
    except Exception:
        logger.exception("kokoro: could not list voices")
        return []
    # 2026-11-10: callers that fall back to "the first voice" (a bot with no valid saved voice) got af_alloy, a weak
    # voice, because the list is alphabetical. The best voice leads the list, so every fallback lands on it.
    if DEFAULT_VOICE in names:
        names.remove(DEFAULT_VOICE)
        names.insert(0, DEFAULT_VOICE)
    return [{"id": v, "name": v} for v in names]


def warm() -> bool:
    """Load the model and voices and render one short phrase, so a call's first sentence does not pay the load and
    onnxruntime's first-run setup (a first sentence took about 3 s after a 2 s load on David's machine, against about a quarter second warm).
    A call start does this in the background when Kokoro is the call voice. Never raises; False when not set up."""
    if not ready()[0]:
        return False
    try:
        synthesize("Okay.", DEFAULT_VOICE)
        return True
    except Exception:
        logger.exception("kokoro: warm-up failed")
        return False


def synthesize(text: str, voice: str, speed: float = 1.0) -> bytes:
    """One sentence -> 24 kHz mono PCM16 bytes. Blocking; call from a worker thread. `speed` is Kokoro's own speaking
    rate (1 is its normal pace; the Story Short's characters speak at 1.08 to 1.14)."""
    ok, reason = ready()
    if not ok:
        raise KokoroUnavailable(reason)
    if not text or not text.strip() or len(text) > MAX_TEXT:
        raise KokoroUnavailable("That text cannot be spoken.")
    import numpy as np
    try:
        wanted = voice if voice and voice != "default" else DEFAULT_VOICE
        samples, rate = _render(text, wanted, max(.5, min(2., float(speed))))
    except Exception as e:
        logger.exception("kokoro: synthesis failed")
        raise KokoroUnavailable("Kokoro could not speak. Check its download and the selected voice.") from e
    if rate != SAMPLE_RATE:
        raise KokoroUnavailable("Kokoro returned an unexpected audio format.")
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    return pcm.tobytes()
