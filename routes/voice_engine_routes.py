"""Settings > Speech > Voice engines: ElevenLabs on the person's own key, a VoiceStudio they run themselves.

Keys are sealed per account (core/voice_keys.py) and never returned. "Check" validates without rendering speech: for
ElevenLabs a voices request (free) and the plan's characters left; for VoiceStudio its /health and voice list. Pointing
Kairos at a local address stays with an admin, as for the other local voice servers (it reaches host-only services).
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import call_voices, elevenlabs_voice, voice_keys, voicestudio_voice
from core.auth import auth_manager
from core.middleware import require_admin, require_user

router = APIRouter(prefix="/api/voice-engines", tags=["voice engines"])


def _state() -> dict:
    config = call_voices.configuration()
    studio_url = config["url"] if config.get("protocol") == "voicestudio" and config.get("url") else voicestudio_voice.DEFAULT_URL
    return {"active": config.get("protocol") if config.get("url") else "",
            "elevenlabs": {"has_key": voice_keys.has("elevenlabs"), "key_page": elevenlabs_voice.KEY_PAGE,
                           "models": list(elevenlabs_voice.MODELS), "price_per_1k": elevenlabs_voice.PRICE_PER_1K, "verified": False},
            "voicestudio": {"url": studio_url, "has_key": voice_keys.has("voicestudio"), "repo": voicestudio_voice.REPO,
                            "verified": False}}


class Key(BaseModel):
    api_key: Optional[str] = Field(default=None, max_length=400)


class Studio(BaseModel):
    url: str = Field(default="", max_length=300)
    api_key: Optional[str] = Field(default=None, max_length=400)
    forget_key: bool = False


class Use(BaseModel):
    engine: Literal["elevenlabs", "voicestudio", "kokoro"]


def _fallback_engine() -> None:
    """The engine just lost its key: speak with Kokoro if it is set up, else no neural engine (the device voice)."""
    from core import kokoro_voice
    if kokoro_voice.ready()[0]:
        call_voices.configure("", "kokoro")
    else:
        from core.atomic_io import write_json_atomic
        write_json_atomic(str(call_voices.settings_file()), {"url": "", "protocol": "voicestudio"})


@router.get("")
async def state(user: str = Depends(require_user)):
    return _state()


@router.post("/elevenlabs/check")
async def check_elevenlabs(body: Key, user: str = Depends(require_user)):
    key = voice_keys.clean(body.api_key) if body.api_key else voice_keys.get("elevenlabs")
    if not key:
        raise HTTPException(422, "Paste an ElevenLabs key first.")
    try:
        return await elevenlabs_voice.check(key)
    except elevenlabs_voice.ElevenLabsError as error:
        raise HTTPException(422, str(error)) from None


@router.put("/elevenlabs")
async def save_elevenlabs(body: Key, user: str = Depends(require_user)):
    """Check the key, save it sealed and make ElevenLabs the voice engine. A key that does not work is not saved."""
    try:
        key = voice_keys.clean(body.api_key)
        checked = await elevenlabs_voice.check(key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    voice_keys.set_key("elevenlabs", key)
    call_voices.configure("", "elevenlabs")
    return {**_state(), "check": checked}


@router.delete("/elevenlabs")
async def forget_elevenlabs(user: str = Depends(require_user)):
    voice_keys.clear("elevenlabs")
    if call_voices.configuration().get("protocol") == "elevenlabs":
        _fallback_engine()
    return _state()


@router.post("/voicestudio/check")
async def check_voicestudio(body: Studio, user: str = Depends(require_admin)):
    try:
        origin = call_voices.validate_url(body.url or voicestudio_voice.DEFAULT_URL)
        key = voice_keys.clean(body.api_key) if body.api_key else ("" if body.forget_key else voice_keys.get("voicestudio"))
        return await voicestudio_voice.check(origin, key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.put("/voicestudio")
async def save_voicestudio(body: Studio, user: str = Depends(require_admin)):
    """Check the running VoiceStudio, save its address (and key, sealed) and make it the voice engine."""
    try:
        origin = call_voices.validate_url(body.url or voicestudio_voice.DEFAULT_URL)
        key = voice_keys.clean(body.api_key) if body.api_key else ("" if body.forget_key else voice_keys.get("voicestudio"))
        checked = await voicestudio_voice.check(origin, key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if body.api_key:
        voice_keys.set_key("voicestudio", key)
    elif body.forget_key:
        voice_keys.clear("voicestudio")
    call_voices.configure(origin, "voicestudio")
    return {**_state(), "check": checked}


@router.post("/use")
async def use(body: Use, user: str = Depends(require_user)):
    if body.engine == "voicestudio" and not auth_manager.is_admin(user):
        raise HTTPException(403, "Only an admin can point Kairos at a local voice server.")
    try:
        config = call_voices.configuration()
        url = config["url"] if body.engine == "voicestudio" and config.get("protocol") == "voicestudio" else ""
        call_voices.configure(url, body.engine)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return _state()
