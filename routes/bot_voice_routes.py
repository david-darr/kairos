"""Authenticated Bots speech endpoints. Static paths precede bot ids."""
import base64
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from typing import Literal

from core.middleware import require_admin
from core.atomic_io import read_json
from services import bot_voice as voice

router = APIRouter(prefix="/api/bot-voice", tags=["bot-voice"], dependencies=[Depends(require_admin)])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Prepare(Body):
    text: str = Field(max_length=100_000)
    voice_id: str | None = Field(default=None, max_length=200)


class Block(Prepare):
    text: str = Field(min_length=1, max_length=1600)


class Note(Body):
    text: str = Field(min_length=1, max_length=1000)


class Settings(Body):
    voice: Literal["marin", "cedar", "coral", "sage", "ash"] = "marin"
    read_typed: StrictBool = False
    idle_minutes: int = Field(default=5, ge=1, le=60, strict=True)


@router.get("/voices")
async def voices():
    try:
        return await voice.call_voices.catalog()
    except Exception:
        return {"voices": [], "models": [], "error": "Local voices could not load. Check the voice engine."}


@router.post("/speak/prepare")
def prepare(body: Prepare):
    return voice.prepare(body.text)


@router.post("/speak/block")
async def block(body: Block):
    if not body.text.strip():
        raise HTTPException(422, "This speech block is empty.")
    if voice.private_text(body.text):
        raise HTTPException(422, "Private text cannot be spoken.")
    # Resolve before streaming so an unavailable engine is a real 409.
    try:
        model, selected = await voice.selection(body.voice_id)
    except voice.VoiceError as error:
        raise HTTPException(error.status, str(error)) from None

    async def events():
        try:
            async for item in voice.call_voices.pcm(body.text, model, selected):
                yield json.dumps({"audio": base64.b64encode(item["audio"]).decode()} if "audio" in item else item) + "\n"
            yield '{"done":true}\n'
        except Exception:
            yield '{"error":"Voice playback failed. Check the local voice engine."}\n'
    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.get("/live-settings")
def settings(user: str = Depends(require_admin)):
    return voice.live_settings(user)


@router.put("/live-settings")
def put_settings(body: Settings, user: str = Depends(require_admin)):
    return voice.live_settings(user, body.model_dump())


@router.get("/notes/{ident}/audio")
def audio(ident: str, user: str = Depends(require_admin)):
    try:
        return FileResponse(voice.note_file(user, ident, ".wav"), media_type="audio/wav", headers={"Cache-Control": "private, no-store"})
    except voice.VoiceError as error:
        raise HTTPException(error.status, str(error)) from None


@router.get("/notes/{ident}/transcript")
def transcript(ident: str, user: str = Depends(require_admin)):
    try:
        return {"transcript": read_json(str(voice.note_file(user, ident, ".json")), {})["transcript"]}
    except voice.VoiceError as error:
        raise HTTPException(error.status, str(error)) from None


@router.post("/{bot_id}/notes")
async def note(bot_id: str, body: Note, user: str = Depends(require_admin)):
    try:
        return await voice.note(bot_id, body.text, user)
    except voice.VoiceError as error:
        raise HTTPException(error.status, str(error)) from None
