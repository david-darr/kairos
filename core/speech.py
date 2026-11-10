"""Local speech-to-text for chat dictation and Open Mic (David's ask 2026-09-15).

Everything runs on this machine. Audio is never uploaded to a transcription
service, which is the same promise the Office previews make and the reason
this exists at all rather than calling a provider's API.

Why pywhispercpp rather than faster-whisper
-------------------------------------------
Measured before choosing, not assumed. faster-whisper pulls ctranslate2,
onnxruntime, tokenizers and av, which together added **206 MB** to the
bundled runtime (432 MB to 638 MB) - roughly +100 MB compressed onto a 225 MB
installer, paid by everyone including people who never speak to it.
pywhispercpp is a **1.3 MB** wheel wrapping whisper.cpp, and it reads the same
ggml `.bin` models The Bridge's whisper.cpp server already uses on this
machine. Verified working before committing to it: model loads in ~0.4s and a
2-second clip transcribes in ~1.9s.

The engine ships; the model does not. A model is downloaded on first use with
real progress, the same pattern core/llamacpp_engine.py already uses for GGUF
files, so the installer does not grow by half a gigabyte for an optional
feature.

Audio arrives as 16 kHz mono WAV
--------------------------------
Dictation uses browser decoding and resampling (static/js/voiceInput.js).
Native calls capture 16 kHz PCM directly with an AudioWorklet and rolling
pre-roll (static/js/callRecorder.js). Both keep a decoder out of the backend - no
ffmpeg, no av - and works identically in the desktop shell and a phone
browser, since Chromium already has the codecs.
"""
import asyncio
import io
import logging
import os
import re
import threading
import time
import wave

import httpx

from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

SPEECH_DIR = os.path.join(DATA_DIR, "speech_models")

# whisper.cpp's own published ggml weights. English-only variants: dictation
# into a chat box is overwhelmingly English here, and the .en models are both
# smaller and more accurate than the multilingual ones at the same size.
CATALOG = [
    {"name": "tiny.en", "label": "Tiny", "size_mb": 75,
     "description": "Fastest, roughest. Fine for short commands.",
     "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"},
    {"name": "base.en", "label": "Base", "size_mb": 142,
     "description": "A good balance for dictation.",
     "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"},
    {"name": "small.en", "label": "Small", "size_mb": 466,
     "description": "Most accurate, noticeably slower on CPU.",
     "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"},
]
DEFAULT_MODEL = "base.en"

# Bounded so a malformed or hostile upload cannot pin memory. Sixty seconds of
# 16 kHz mono 16-bit audio is ~1.9 MB; this leaves generous headroom while
# still refusing anything absurd.
MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_AUDIO_SECONDS = 300

_download_progress: dict[str, dict] = {}
# Loading a model costs ~0.4s and a few hundred MB of compute buffers, so the
# instance is kept for the life of the process rather than rebuilt per
# utterance - which would make Open Mic unusable.
_model = None
_model_name: str | None = None

# The in-process whisper instance is not re-entrant, so everything that touches it (and registers or swaps the engine)
# serializes on this one lock. The routes share it. The CUDA whisper-server child is a separate process that answers
# requests concurrently, so a call that is already on the GPU does NOT take it (see transcribe_call).
ENGINE_LOCK = threading.Lock()


class SpeechUnavailable(Exception):
    """Raised with a message intended to be shown to the user as-is."""


def model_path(name: str) -> str:
    return os.path.join(SPEECH_DIR, f"ggml-{name}.bin")


def list_models() -> list[dict]:
    """The catalog, annotated with what is actually on disk."""
    return [{**entry, "downloaded": os.path.isfile(model_path(entry["name"]))} for entry in CATALOG]


def installed_model() -> str | None:
    """The model that will be used, or None if nothing is downloaded yet.
    Prefers the default, then falls back to whatever the user does have, so a
    machine with only tiny.en still works rather than reporting nothing."""
    if os.path.isfile(model_path(DEFAULT_MODEL)):
        return DEFAULT_MODEL
    for entry in CATALOG:
        if os.path.isfile(model_path(entry["name"])):
            return entry["name"]
    return None


def engine_available() -> bool:
    """Whether the binding imports at all. Separate from whether a model is
    present, because the two fail for different reasons and the UI should say
    which."""
    from core import vc_runtime
    if vc_runtime.missing():
        # whisper.cpp needs the Microsoft Visual C++ runtime; importing it without would only log a DLL traceback.
        return False
    try:
        import pywhispercpp.model  # noqa: F401
        return True
    except Exception as e:
        logger.info("speech: pywhispercpp unavailable (%s)", e)
        return False


def status() -> dict:
    from core import speech_acceleration, speech_optional, turn_detect, vc_runtime
    return {
        # Windows without the Microsoft Visual C++ runtime: Settings > Speech shows one line saying to install it.
        "vc_runtime": vc_runtime.status(),
        # Optional ONNX downloads (Smart Turn, Kokoro): honest per-item state, nothing auto-downloads.
        "optional": speech_optional.status(),
        "turn_detect": turn_detect.status(),
        "engine_available": engine_available(),
        "active_model": installed_model(),
        "models": list_models(),
        "call_model": "small.en",
        "acceleration": speech_acceleration.status(),
    }


def get_download_progress(name: str) -> dict:
    return _download_progress.get(name, {"status": "not_started"})


def start_download(name: str) -> None:
    entry = next((c for c in CATALOG if c["name"] == name), None)
    if entry is None:
        raise ValueError(f"unknown speech model: {name}")
    if _download_progress.get(name, {}).get("status") == "downloading":
        return
    _download_progress[name] = {"status": "downloading", "completed": 0, "total": 0, "done": False, "error": None}
    asyncio.create_task(_run_download(name, entry["url"]))


async def _run_download(name: str, url: str) -> None:
    os.makedirs(SPEECH_DIR, exist_ok=True)
    target = model_path(name)
    # Downloaded to .part and renamed only on success, so an interrupted
    # download can never be mistaken for a usable model on the next launch.
    tmp_path = target + ".part"
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                _download_progress[name]["total"] = total
                completed = 0
                with open(tmp_path, "wb") as handle:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        handle.write(chunk)
                        completed += len(chunk)
                        _download_progress[name]["completed"] = completed
        os.replace(tmp_path, target)
        _download_progress[name].update(status="done", done=True)
        logger.info("speech: downloaded %s", name)
    except Exception as e:
        logger.exception("speech: download failed for %s", name)
        _download_progress[name].update(status="error", done=True, error=str(e)[:300])
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def selected_model(name: str | None = None) -> str:
    if name is None:
        name = installed_model()
    if name is None:
        raise SpeechUnavailable("No speech model is downloaded yet. Add one in Settings.")
    if name not in {entry['name'] for entry in CATALOG}:
        raise SpeechUnavailable("Choose an offered speech model.")
    if not os.path.isfile(model_path(name)):
        raise SpeechUnavailable("Download the selected speech model before starting the call.")
    return name


def prepare(name: str | None = None) -> str:
    if not engine_available():
        raise SpeechUnavailable("Speech recognition is not available in this build.")
    name = selected_model(name)
    _load(name)
    return name


def prepare_call(name: str, backend: str = 'auto') -> dict:
    from core import speech_acceleration
    name = selected_model(name)
    reason = None
    if backend == 'auto' and speech_acceleration.status()['configured']:
        try:
            speech_acceleration.prepare(model_path(name))
            return {'model': name, 'engine': 'cuda', 'fallback': None}
        except ValueError as error:
            reason = str(error)
    prepare(name)
    return {'model': name, 'engine': 'cpu', 'fallback': reason}


def _clean(text: str) -> str:
    # Match Voice-line's non-speech marker filtering on either engine.
    return ' '.join(re.sub(r'\[[^\]]*\]', '', text).split())


def _clean_segments(segments: list[dict]) -> list[dict]:
    cleaned = [{'text': _clean(segment['text']), 'start_ms': segment['start_ms'], 'end_ms': segment['end_ms']} for segment in segments]
    return [segment for segment in cleaned if segment['text']]


def transcribe_call(audio: bytes, name: str, backend: str = 'auto', segments: bool = False, blocking: bool = True) -> dict:
    """One call-quality transcription.

    The lock rule: the CUDA server is a separate process serving requests concurrently, so a request that goes to it
    holds no lock (a rolling partial and the final pass overlap instead of queueing). Only the in-process CPU engine
    and engine start-up/switching take ENGINE_LOCK. `blocking=False` is for disposable rolling partials: when the CPU
    engine is busy they return {'busy': True} at once rather than queue behind (and then delay) a real utterance.
    `segments=True` adds timed segments (end_ms relative to the start of the audio) for the rolling transcript.
    """
    from core import speech_acceleration
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise SpeechUnavailable('No audio was recorded.' if not audio else 'That recording is too large to transcribe.')
    waited = 0.0
    def locked(work):
        nonlocal waited
        began = time.perf_counter()
        if not ENGINE_LOCK.acquire(blocking=blocking):
            return None
        waited += time.perf_counter() - began
        try:
            return work()
        finally:
            ENGINE_LOCK.release()
    def finish(text, info, parts=None):
        result = {'text': _clean(text), **info, 'queue_ms': round(waited * 1000)}
        if segments:
            result['segments'] = _clean_segments(parts or [])
        return result
    if len(_wav_to_float32(audio)) < 3200:
        info = locked(lambda: prepare_call(name, backend))
        return {'text': '', 'busy': True} if info is None else finish('', info)
    path = model_path(selected_model(name))
    if backend == 'auto' and speech_acceleration.is_ready(path):
        info = {'model': name, 'engine': 'cuda', 'fallback': None}
    else:
        info = locked(lambda: prepare_call(name, backend))
        if info is None:
            return {'text': '', 'busy': True}
    if info['engine'] == 'cuda':
        try:
            text, parts = speech_acceleration.transcribe_segments(audio, path, timed=segments)
            return finish(text, info, parts)
        except ValueError as error:
            info = {'model': name, 'engine': 'cpu', 'fallback': str(error)}
    outcome = locked(lambda: transcribe_segments(audio, name))
    if outcome is None:
        return {'text': '', 'busy': True}
    return finish(outcome[0], info, outcome[1])


def _load(name: str):
    global _model, _model_name
    if _model is not None and _model_name == name:
        return _model
    from pywhispercpp.model import Model
    # redirect_whispercpp_logs_to=None silences whisper.cpp's very chatty
    # init output, which otherwise floods the backend log on every load.
    _model = Model(model_path(name), redirect_whispercpp_logs_to=None, print_progress=False,
                   language='en', no_context=True)
    _model_name = name
    return _model


def _wav_to_float32(audio: bytes):
    """16 kHz mono float32, or a message explaining what is wrong with it.

    Deliberately strict about the shape rather than resampling here: the
    browser already produced exactly this format, so anything else means a
    caller bug worth surfacing, not something to paper over.
    """
    import numpy as np

    try:
        with wave.open(io.BytesIO(audio), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.getnframes()
            if width != 2:
                raise SpeechUnavailable("Audio must be 16-bit.")
            if frames / max(rate, 1) > MAX_AUDIO_SECONDS:
                raise SpeechUnavailable("That recording is too long to transcribe.")
            raw = handle.readframes(frames)
    except (wave.Error, EOFError, ValueError):
        # EOFError, not just wave.Error: a truncated upload fails partway
        # through the fmt chunk and raises EOFError, which would otherwise
        # escape as a 500 instead of a message the user can act on. Found by
        # feeding the parser a deliberately cut-off WAV.
        raise SpeechUnavailable("That audio could not be read.")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # Linear resample. Only a fallback: the browser sends 16 kHz already,
        # and this exists so an odd client does not simply fail.
        target_len = int(len(samples) * 16000 / rate)
        if target_len <= 0:
            raise SpeechUnavailable("That recording was too short.")
        samples = np.interp(
            np.linspace(0, len(samples), target_len, endpoint=False),
            np.arange(len(samples)), samples,
        ).astype(np.float32)
    return samples


def transcribe_segments(audio: bytes, model_name: str | None = None) -> tuple[str, list[dict]]:
    """Like transcribe(), also returning the timed segments ({text, start_ms, end_ms}) whisper cut the audio into.
    Callers serialize on ENGINE_LOCK (the cached instance is shared)."""
    if not audio:
        raise SpeechUnavailable("No audio was recorded.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise SpeechUnavailable("That recording is too large to transcribe.")
    if not engine_available():
        raise SpeechUnavailable("Speech recognition is not available in this build.")
    name = selected_model(model_name)

    samples = _wav_to_float32(audio)
    # Under ~0.2s is almost always a mis-click rather than speech, and
    # whisper reports [BLANK_AUDIO] for it, which reads as a bug to a user.
    if len(samples) < 3200:
        return "", []
    try:
        raw = _load(name).transcribe(samples)
    except Exception as e:
        logger.exception("speech: transcription failed")
        raise SpeechUnavailable("That recording could not be transcribed.") from e
    parts = [{"text": segment.text.strip(), "start_ms": int(getattr(segment, "t0", 0)) * 10, "end_ms": int(getattr(segment, "t1", 0)) * 10} for segment in raw]
    text = " ".join(part["text"] for part in parts).strip()
    # whisper.cpp emits these bracketed markers for silence and noise. They
    # are not speech, and inserting them into someone's chat box would be
    # worse than returning nothing.
    for marker in ("[BLANK_AUDIO]", "(blank_audio)", "[ Silence ]", "[SILENCE]"):
        text = text.replace(marker, "")
        for part in parts:
            part["text"] = part["text"].replace(marker, "").strip()
    return " ".join(text.split()), [part for part in parts if part["text"]]


def transcribe(audio: bytes, model_name: str | None = None) -> str:
    """Transcribe 16 kHz mono WAV bytes. Raises SpeechUnavailable with a
    user-facing message when it cannot."""
    return transcribe_segments(audio, model_name)[0]
