"""Settings > Speech > Voice: the one Voice choice that every speaker follows (core/call_voices.py), and the setup each
choice needs. Kairos Voice needs nothing. GPT-Live needs an OpenAI key (one step here, core/openai_key.py). ElevenLabs
needs its key (sealed per account, core/voice_keys.py, never returned). Under More options an admin can connect a
Voicebox or another voice server on this computer (they reach host-only services, like the other local voice servers).

"Check" validates without rendering speech: for ElevenLabs a voices request (free) and the plan's characters left; for
Voicebox its /health and voice list; for OpenAI its model list.
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import call_voices, elevenlabs_voice, openai_key, voice_keys, voicebox_voice
from core.auth import auth_manager
from core.middleware import require_admin, require_user

router = APIRouter(prefix="/api/voice-engines", tags=["voice engines"])

GPT_LIVE_PRICE = 0.05          # dollars a minute, billed per second (OpenAI's model page, read 2026-11-09)


def _gpt_live() -> Optional[dict]:
    from services import realtime_session
    return next((c for c in realtime_session.choices() if c.get("provider") == "openai_live"), None)


def _state() -> dict:
    from core import kokoro_voice
    saved = call_voices.stored()
    ready, reason = kokoro_voice.ready()
    live = _gpt_live()
    return {"choice": saved["choice"], "notice": saved["notice"],
            "kairos": {"kokoro_ready": ready, "kokoro_reason": reason or ""},
            "gpt_live": {"available": bool(live), "endpoint_id": (live or {}).get("id"), "price_per_minute": GPT_LIVE_PRICE,
                         "key_page": openai_key.KEY_PAGE, "verified": False},
            "elevenlabs": {"has_key": voice_keys.has("elevenlabs"), "key_page": elevenlabs_voice.KEY_PAGE,
                           "models": list(elevenlabs_voice.MODELS), "price_per_1k": elevenlabs_voice.PRICE_PER_1K, "verified": False},
            "voicebox": {"url": saved["voicebox_url"] or voicebox_voice.DEFAULT_URL, "repo": voicebox_voice.REPO, "verified": False},
            "compatible": {"url": saved["compatible_url"], "voices": saved["compatible_voices"]}}


class Key(BaseModel):
    api_key: Optional[str] = Field(default=None, max_length=400)


class Address(BaseModel):
    url: str = Field(default="", max_length=300)


class Compatible(Address):
    voices: str = Field(default="", max_length=2000)    # typed voice names, comma separated


class Choice(BaseModel):
    choice: Literal["kairos", "gpt_live", "elevenlabs", "voicebox", "compatible"]


@router.get("")
async def state(user: str = Depends(require_user)):
    return _state()


@router.put("/choice")
async def choose(body: Choice, user: str = Depends(require_user)):
    """Make this the Voice. A local server is an admin's to choose; GPT-Live needs an OpenAI key first."""
    if body.choice in ("voicebox", "compatible") and not auth_manager.is_admin(user):
        raise HTTPException(403, "Only an admin can point Kairos at a voice server on this computer.")
    if body.choice == "gpt_live" and not _gpt_live():
        raise HTTPException(422, "Add your OpenAI key first.")
    try:
        call_voices.set_choice(body.choice)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return _state()


@router.post("/notice/dismiss")
async def dismiss(user: str = Depends(require_user)):
    call_voices.dismiss_notice()
    return _state()


@router.put("/openai")
async def save_openai(body: Key, user: str = Depends(require_user)):
    """Check the OpenAI key, save it as a connection and make GPT-Live the Voice. A key that does not work is not saved."""
    try:
        await openai_key.connect(body.api_key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if not _gpt_live():
        raise HTTPException(422, "The key was saved, but GPT-Live is not offered on it. Check the connection in Settings > Models.")
    call_voices.set_choice("gpt_live")
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
    """Check the key, save it sealed and make ElevenLabs the Voice. A key that does not work is not saved."""
    try:
        key = voice_keys.clean(body.api_key)
        checked = await elevenlabs_voice.check(key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    voice_keys.set_key("elevenlabs", key)
    call_voices.set_choice("elevenlabs")
    return {**_state(), "check": checked}


@router.delete("/elevenlabs")
async def forget_elevenlabs(user: str = Depends(require_user)):
    voice_keys.clear("elevenlabs")
    if call_voices.choice() == "elevenlabs":
        call_voices.set_choice("kairos")          # no key, no ElevenLabs: Kairos Voice speaks again
    return _state()


@router.post("/voicebox/check")
async def check_voicebox(body: Address, user: str = Depends(require_admin)):
    try:
        return await voicebox_voice.check(call_voices.validate_url(body.url or voicebox_voice.DEFAULT_URL))
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.put("/voicebox")
async def save_voicebox(body: Address, user: str = Depends(require_admin)):
    """Check the running Voicebox, save its address and make it the Voice."""
    try:
        origin = call_voices.validate_url(body.url or voicebox_voice.DEFAULT_URL)
        checked = await voicebox_voice.check(origin)
        call_voices.set_choice("voicebox", origin)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return {**_state(), "check": checked}


@router.put("/compatible")
async def save_compatible(body: Compatible, user: str = Depends(require_admin)):
    """Another OpenAI-compatible voice server on this computer, with voice names to use if it cannot list its own."""
    try:
        call_voices.set_compatible_voices(body.voices.split(","))
        call_voices.set_choice("compatible", body.url)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return _state()


class Pronunciation(BaseModel):
    word: str = Field(default="", max_length=60)
    say: str = Field(default="", max_length=120)
    phonemes: str = Field(default="", max_length=160)


class Pronunciations(BaseModel):
    items: list[Pronunciation] = Field(default_factory=list, max_length=200)


@router.get("/pronunciations")
async def pronunciations_list(user: str = Depends(require_user)):
    from core import pronunciations
    return {"items": pronunciations.items()}


@router.put("/pronunciations")
async def pronunciations_save(body: Pronunciations, user: str = Depends(require_user)):
    """Replace the account's list. A respelling is turned into phonemes here (misaki loads once, so off the event loop)."""
    import asyncio
    from core import accounts, pronunciations
    entries = [item.model_dump() for item in body.items]
    account = accounts.effective_account()
    def run():
        with accounts.as_account(account):
            return pronunciations.save(entries)
    try:
        return {"items": await asyncio.to_thread(run)}
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
