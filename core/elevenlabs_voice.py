"""ElevenLabs as a voice (text-to-speech) engine in the local pipeline, on the person's own ElevenLabs key.

It answers the same two questions as every engine in core/call_voices.py (which voices exist, give me PCM for this
sentence), so calls, Open Mic, bots reading aloud, voice notes, fillers and phone calls (to the person and to others)
use it unchanged. The speaker already cuts replies into sentences and fetches the next one while one plays; each
sentence here is one streaming request, so the first audio arrives while ElevenLabs is still rendering.

Written from ElevenLabs' API reference (read 2026-11-09):
  POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000   header xi-api-key; body {text, model_id}
       -> raw 16-bit little-endian mono PCM at 24 kHz, streamed
  GET  /v2/voices?page_size=..&next_page_token=..                      -> {voices: [{voice_id, name, category}], has_more}
  GET  /v1/user/subscription                                           -> character_count, character_limit (optional)
Models: eleven_flash_v2_5 (about 100 ms model latency, 40,000 characters a request, half the price per character) and
eleven_multilingual_v2 (richer, slower). API price per 1,000 characters (ElevenLabs' API pricing page): Flash $0.04,
Multilingual v2 $0.08; a plan's included credits are used first. Speech runs about 800 to 1,000 characters a minute.
UNVERIFIED WITHOUT A REAL KEY: only mock-server tests have run.

Not used, on purpose (2026-11-09): ElevenLabs speech-to-text (Scribe v2 Realtime, $0.39 an hour) and its Conversational
agents ($0.08 a minute plus their language model). Kairos already hears locally for free and privately (whisper.cpp
plus Smart Turn), and an ElevenLabs agent would run its own model instead of the bot's own model and tools, which is what
realtime mode with do_work or GPT-Live delegation already gives. Revisit Scribe only for machines too slow to hear locally.
"""
import re
from typing import AsyncIterator, Optional

import httpx

BASE = "https://api.elevenlabs.io"
TRANSPORT: Optional[httpx.AsyncBaseTransport] = None    # tests: a mock of ElevenLabs' API
SAMPLE_RATE = 24000
MODELS = ("eleven_flash_v2_5", "eleven_multilingual_v2")
PRICE_PER_1K = {"eleven_flash_v2_5": 0.04, "eleven_multilingual_v2": 0.08}
MAX_TEXT = 1600
MAX_VOICES = 500
KEY_PAGE = "https://elevenlabs.io/app/settings/api-keys"
_VOICE = re.compile(r"[A-Za-z0-9]{8,64}")


class ElevenLabsError(ValueError):
    """Shown to the person as-is."""


def _client(timeout: float = 15.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=BASE, transport=TRANSPORT, timeout=httpx.Timeout(timeout, connect=8.0),
                             trust_env=False, follow_redirects=False)


def _problem(response: httpx.Response) -> str:
    """A plain sentence for an error answer; never echoes the key or the provider's raw body."""
    status = response.status_code
    detail = ""
    try:
        body = response.json()
        found = body.get("detail") if isinstance(body, dict) else None
        detail = str((found or {}).get("status") or (found or {}).get("code") or "") if isinstance(found, dict) else ""
    except Exception:
        pass
    if status == 401 and "quota" in detail:
        return "ElevenLabs says this account is out of credits. Add credits on elevenlabs.io or switch voice engine."
    if status in (401, 403):
        return "ElevenLabs did not accept the key. Check it was copied in full and has text to speech and voices access."
    if status == 402 or "quota" in detail or "payment" in detail:
        return "ElevenLabs says this account is out of credits. Add credits on elevenlabs.io or switch voice engine."
    if status == 404:
        return "ElevenLabs does not know that voice. Choose a voice again."
    if status == 422:
        return "ElevenLabs could not read that request."
    if status == 429:
        return "ElevenLabs is busy or this plan's limit was reached. Try again in a moment."
    return f"ElevenLabs answered with an error ({status}). Try again in a minute."


async def check(key: str) -> dict:
    """Does the key work? One voices request (free) and, when the key may read it, the plan's characters left. Spends nothing."""
    try:
        async with _client() as client:
            response = await client.get("/v2/voices", params={"page_size": 1}, headers={"xi-api-key": key})
            if response.status_code >= 400:
                raise ElevenLabsError(_problem(response))
            total = (response.json() or {}).get("total_count")
            left = None
            plan = await client.get("/v1/user/subscription", headers={"xi-api-key": key})
            if plan.status_code < 400:
                data = plan.json() or {}
                used, limit = data.get("character_count"), data.get("character_limit")
                if isinstance(used, int) and isinstance(limit, int):
                    left = max(0, limit - used)
    except httpx.HTTPError:
        raise ElevenLabsError("Could not reach ElevenLabs. Check this computer is online, then try again.") from None
    except ValueError as error:
        if isinstance(error, ElevenLabsError):
            raise
        raise ElevenLabsError("ElevenLabs' answer could not be read. Try again in a minute.") from None
    return {"ok": True, "voices": total if isinstance(total, int) else None, "characters_left": left}


async def voices(key: str) -> list:
    """The voices on the person's account (their own, cloned and added library voices), up to MAX_VOICES."""
    found, token = [], None
    try:
        async with _client() as client:
            for _ in range(MAX_VOICES // 100):
                params = {"page_size": 100, **({"next_page_token": token} if token else {})}
                response = await client.get("/v2/voices", params=params, headers={"xi-api-key": key})
                if response.status_code >= 400:
                    raise ElevenLabsError(_problem(response))
                data = response.json() or {}
                for item in data.get("voices") or []:
                    ident = str(item.get("voice_id") or "")
                    if not _VOICE.fullmatch(ident):
                        continue
                    name = str(item.get("name") or ident)[:80]
                    category = str(item.get("category") or "")
                    found.append({"id": ident, "name": f"{name} ({category})" if category in ("cloned", "professional", "generated") else name})
                token = data.get("next_page_token")
                if not data.get("has_more") or not token:
                    break
    except httpx.HTTPError:
        raise ElevenLabsError("Could not reach ElevenLabs. Check this computer is online, then try again.") from None
    return found[:MAX_VOICES]


async def stream(text: str, model: str, voice: str, key: str) -> AsyncIterator[dict]:
    """One sentence -> {'sample_rate': 24000} then {'audio': bytes} pieces as ElevenLabs renders them."""
    if not _VOICE.fullmatch(voice or ""):
        raise ElevenLabsError("Choose an ElevenLabs voice first.")
    if not text.strip() or len(text) > MAX_TEXT:
        raise ElevenLabsError("That text cannot be spoken.")
    body = {"text": text, "model_id": model if model in MODELS else MODELS[0]}
    try:
        async with _client(60.0) as client:
            async with client.stream("POST", f"/v1/text-to-speech/{voice}/stream", params={"output_format": f"pcm_{SAMPLE_RATE}"},
                                     headers={"xi-api-key": key, "Accept": "audio/pcm"}, json=body) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise ElevenLabsError(_problem(response))
                yield {"sample_rate": SAMPLE_RATE}
                total = 0
                async for data in response.aiter_bytes():
                    total += len(data)
                    if total > SAMPLE_RATE * 2 * 180:
                        raise ElevenLabsError("Voice response exceeded its limit.")
                    if data:
                        yield {"audio": data}
    except httpx.HTTPError:
        raise ElevenLabsError("Could not reach ElevenLabs. Check this computer is online, then try again.") from None


def cost_estimate(characters: int, model: str = MODELS[0]) -> float:
    return round(max(0, characters) / 1000 * PRICE_PER_1K.get(model, PRICE_PER_1K[MODELS[0]]), 4)
