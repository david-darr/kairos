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


@router.post('/prepare')
async def prepare_speech(body: PrepareSpeech, user: str = Depends(require_user)) -> dict:
    def load():
        with _transcription_lock:
            return speech.prepare_call(body.model, body.backend) if body.backend else speech.prepare(body.model)
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
