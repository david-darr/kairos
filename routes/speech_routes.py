"""Speech-to-text HTTP surface for chat dictation and Open Mic.

Thin adapter over core/speech.py, matching the shape routes/cookbook_routes.py
already uses for local model downloads: list, start, poll progress.

Transcription is require_user rather than require_admin: dictating into your
own chat is an ordinary per-session action, the same as sending a message.
Downloading a model is admin-gated, because it writes several hundred
megabytes into the shared data directory.
"""
import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from typing import Literal

from core import speech
from core.middleware import require_admin, require_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/speech", tags=["speech"])
# The cached in-process whisper instance is shared, so it (and engine start-up) serialize on this lock while chat
# events, permission answers and Stop stay responsive. It lives in core.speech so transcribe_call can skip it for the
# CUDA server, which answers concurrently. Dictation and Open Mic (no `backend`) still hold it for the whole run.
_transcription_lock = speech.ENGINE_LOCK


def _local_transcription(data: bytes, model: str | None = None, timed: bool = False, backend: str | None = None, partial: bool = False):
    requested = time.perf_counter()
    if backend:
        info = speech.transcribe_call(data, model, backend, segments=True, blocking=False) if partial else speech.transcribe_call(data, model, backend)
        queue_ms = info.pop('queue_ms', 0)
        timings = {'queue_ms': queue_ms, 'recognition_ms': max(0, round((time.perf_counter()-requested)*1000) - queue_ms)}
        text = info['text']
    else:
        with _transcription_lock:
            started = time.perf_counter()
            info = None
            text = speech.transcribe(data, model_name=model) if model else speech.transcribe(data)
            timings = {'queue_ms': round((started-requested)*1000), 'recognition_ms': round((time.perf_counter()-started)*1000)}
    if timed:
        if not partial:
            logger.info('speech timing model=%s bytes=%d queue_ms=%d recognition_ms=%d', model or 'default', len(data), timings['queue_ms'], timings['recognition_ms'])
        return {**(info or {'text': text, 'model': model}), 'timings': timings}
    return text


class PrepareSpeech(BaseModel):
    model: str
    backend: Literal['auto', 'cpu'] | None = None


class SpeechRuntime(BaseModel):
    folder: str = Field(min_length=1, max_length=1000)


@router.post('/runtime')
async def register_runtime(body: SpeechRuntime, user: str = Depends(require_admin)) -> dict:
    from core import speech_acceleration
    def register():
        with _transcription_lock:
            return speech_acceleration.register(body.folder)
    try:
        return await asyncio.to_thread(register)
    except (ValueError, OSError) as error:
        raise HTTPException(422, str(error)) from error


@router.delete('/runtime')
async def unregister_runtime(user: str = Depends(require_admin)) -> dict:
    from core import speech_acceleration
    def remove():
        with _transcription_lock:
            return speech_acceleration.unregister()
    return await asyncio.to_thread(remove)


_warming = set()


def _warm_optional() -> None:
    """A call or Open Mic is starting: get Smart Turn, and Kokoro when it is the call voice, loaded and run once now,
    so the first turn does not pay their cold start. With HD voice its model loads too (several seconds, in its own
    thread), and Kokoro is warmed beside it because Kokoro speaks the first sentences until HD is ready. Best effort;
    each module reports its own failures."""
    import threading
    from core import call_voices, hd_voice, kokoro_voice, turn_detect
    turn_detect.warm()
    try:
        protocol = call_voices.configuration().get('protocol')
    except Exception:
        protocol = None
    if protocol == 'hd':
        voice = call_voices.stored().get('hd_voice') or hd_voice.DEFAULT_VOICE
        threading.Thread(target=lambda: asyncio.run(hd_voice.warm(voice)), daemon=True, name='hd-voice-warm').start()
    if protocol in ('kokoro', 'hd'):
        kokoro_voice.warm()


@router.post('/prepare')
async def prepare_speech(body: PrepareSpeech, user: str = Depends(require_user)) -> dict:
    def load():
        with _transcription_lock:
            return speech.prepare_call(body.model, body.backend) if body.backend else speech.prepare(body.model)
    if body.backend:
        # In the background, beside the speech model's own load: the call does not wait for it.
        task = asyncio.ensure_future(asyncio.to_thread(_warm_optional))
        _warming.add(task); task.add_done_callback(_warming.discard)
    try:
        started = time.perf_counter()
        model = await asyncio.to_thread(load)
        return {**(model if isinstance(model, dict) else {'model': model}), 'prepare_ms': round((time.perf_counter()-started)*1000)}
    except speech.SpeechUnavailable as error:
        raise HTTPException(422, str(error)) from error
    except Exception as error:
        logger.exception('speech: model preparation failed')
        raise HTTPException(422, 'Speech model could not load. Check its download and try again.') from error


@router.get("/status")
async def speech_status(user: str = Depends(require_user)) -> dict:
    """Whether dictation can work at all, and which models are on disk.

    `engine_available` and `active_model` are reported separately on purpose:
    a missing binding and a missing model are different problems with
    different fixes, and collapsing them into one boolean would leave the UI
    unable to say which.
    """
    return speech.status()


@router.post("/models/{name}/download")
async def download_model(name: str, user: str = Depends(require_admin)) -> dict:
    try:
        speech.start_download(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.get("/models/{name}/progress")
async def download_progress(name: str, user: str = Depends(require_user)) -> dict:
    return speech.get_download_progress(name)


@router.post("/optional/{name}/download")
async def download_optional(name: str, user: str = Depends(require_admin)) -> dict:
    """Start a user-requested download of an optional ONNX model. Refused (400) while its URL or SHA-256 is not pinned."""
    from core import speech_optional
    try:
        speech_optional.start_download(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.get("/optional/{name}/progress")
async def optional_progress(name: str, user: str = Depends(require_user)) -> dict:
    from core import speech_optional
    return speech_optional.get_progress(name)


@router.delete("/optional/{name}")
async def remove_optional(name: str, user: str = Depends(require_admin)) -> dict:
    from core import speech_optional
    try:
        await asyncio.to_thread(speech_optional.remove, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.post("/turn")
async def end_of_turn(audio: UploadFile = File(...), user: str = Depends(require_user)) -> dict:
    """Has the speaker finished their sentence? Smart Turn on the utterance so far (16 kHz mono WAV).

    Always 200 with `available`. When the model or onnxruntime is missing it answers {"available": false} and the
    caller keeps its fixed silence wait, exactly as before; this is never an error the user has to see. Otherwise
    {"available": true, "complete": bool, "probability": float}: complete means end the turn now, incomplete means keep
    listening (the caller caps how long).
    """
    from core import turn_detect
    data = await audio.read(speech.MAX_AUDIO_BYTES + 1)
    if len(data) > speech.MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too large.")
    try:
        result = await asyncio.to_thread(turn_detect.predict, data)
    except turn_detect.TurnUnavailable as e:
        return {"available": False, "complete": True, "probability": None, "reason": str(e)}
    except speech.SpeechUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"available": True, **result}


@router.post("/partial")
async def transcribe_partial(audio: UploadFile = File(...), model: str = Form(...), backend: Literal['auto', 'cpu'] = Form(default='auto'), user: str = Depends(require_user)) -> dict:
    """Rolling transcript of the audio so far, while the user is still talking.

    The client sends a window of the utterance (from the last text it has committed to now) about every second. The
    answer is the window's text and its timed segments, so the client can commit the stable ones and later send only
    the tail for the final pass. It is disposable by design: when the in-process CPU engine is busy it answers
    `{"busy": true}` at once instead of queueing, so it can never delay a real transcription behind it. Failure here
    is never fatal; the client falls back to sending the whole clip at the end of the turn.
    """
    data = await audio.read(speech.MAX_AUDIO_BYTES + 1)
    if len(data) > speech.MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too large to transcribe.")
    try:
        return await asyncio.to_thread(_local_transcription, data, model, True, backend, True)
    except speech.SpeechUnavailable as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("speech: unexpected partial transcription failure")
        raise HTTPException(status_code=500, detail="Transcription failed.")


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), model: str | None = Form(default=None), backend: Literal['auto', 'cpu'] | None = Form(default=None), user: str = Depends(require_user)) -> dict:
    """16 kHz mono WAV in, text out.

    Read with an explicit ceiling rather than straight into memory: this
    accepts an upload, and an unbounded read is how a large or hostile one
    would pin the backend. core/speech.py re-checks the same limit, since it
    is also reachable from other callers.
    """
    data = await audio.read(speech.MAX_AUDIO_BYTES + 1)
    if len(data) > speech.MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="That recording is too large to transcribe.")
    if backend and not model:
        raise HTTPException(422, 'Choose a speech model for calls.')
    try:
        result = await asyncio.to_thread(_local_transcription, data, model, bool(model), backend)
        if model:
            return result
        text = result
    except speech.SpeechUnavailable as e:
        # 422 with the message as-is: every SpeechUnavailable is written to be
        # shown to the user, so wrapping it would lose the useful part.
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("speech: unexpected transcription failure")
        raise HTTPException(status_code=500, detail="Transcription failed.")
    # An empty string is a real, successful answer meaning "no speech found"
    # (silence, a mis-click, background noise), not an error. The client
    # decides whether to say anything about it.
    return {"text": text}
