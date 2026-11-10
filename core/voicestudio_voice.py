"""VoiceStudio (https://github.com/debpalash/VoiceStudio) as a voice engine: a fully local ElevenLabs alternative that the
person installs and runs themselves (desktop app, or Docker on 127.0.0.1:3900). Kairos only talks to it over its
documented Local API, the OpenAI-compatible speech routes. VoiceStudio is AGPL-3.0: none of its code is bundled, copied
or started from here.

Written from the repo's docs/agentic-voice.md, docs/api-auth.md and docs/production-private-api.md (read 2026-11-09):
  GET  /health                                   service readiness
  GET  /v1/audio/voices                          {voices: [{voice_id | id, name, type}]}; "default" is the engine's own voice
  GET  /v1/models                                OpenAI aliases (tts-1 means the active engine), installed engines, the STT engine
  POST /v1/audio/speech                          {model, voice, input, response_format: "pcm", stream_format: "audio"}
                                                 -> raw 24 kHz 16-bit mono PCM (resampled from the engine), chunked
  Auth: none from loopback on the desktop app; Docker (server mode) and remote use need OMNIVOICE_API_KEY, sent as
  "Authorization: Bearer <key>". A wrong or missing key is 401 {"detail": "API key required"}.
Streaming: the speech route streams bytes as they are produced ("chunked bytes"); whether audio starts before the
sentence is finished depends on the engine. Kairos sends one sentence per request and fetches the next while one plays,
so a non-streaming engine still overlaps. UNVERIFIED: no VoiceStudio was running here; only mock-server tests have run.
"""
from typing import AsyncIterator, Optional

import httpx

TRANSPORT: Optional[httpx.AsyncBaseTransport] = None    # tests: a mock VoiceStudio
DEFAULT_URL = "http://127.0.0.1:3900"
SAMPLE_RATE = 24000
ACTIVE_ENGINE = "tts-1"                                   # VoiceStudio maps OpenAI's tts-1 to whichever engine is active
OPENAI_ALIASES = ("tts-1", "tts-1-hd", "gpt-4o-mini-tts")
MAX_TEXT = 1600
REPO = "https://github.com/debpalash/VoiceStudio"


class VoiceStudioError(ValueError):
    """Shown to the person as-is."""


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _client(origin: str, timeout: float = 8.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=origin, transport=TRANSPORT, timeout=httpx.Timeout(timeout, connect=4.0),
                             trust_env=False, follow_redirects=False)


def _problem(response: httpx.Response) -> str:
    if response.status_code == 401:
        return "VoiceStudio wants its API key. Paste the OMNIVOICE_API_KEY it was started with."
    if response.status_code == 403:
        return "VoiceStudio refused the request from Kairos. Use its address on this computer, such as http://127.0.0.1:3900."
    if response.status_code == 409:
        return "Two VoiceStudio voices share that name. Choose the voice again."
    if response.status_code == 429:
        return "VoiceStudio is busy. Try again in a moment."
    if response.status_code == 400:
        return "VoiceStudio could not speak with that engine or voice. Check an engine is installed and active."
    return f"VoiceStudio answered with an error ({response.status_code})."


UNREACHABLE = "Could not reach VoiceStudio at that address. Start it (the desktop app or its Docker container), then check again."


async def catalog(origin: str, key: str) -> dict:
    """{'voices': [{id, name}], 'models': [engine ids]} from the running VoiceStudio."""
    try:
        async with _client(origin) as client:
            voices = await client.get("/v1/audio/voices", headers=_headers(key))
            if voices.status_code >= 400:
                raise VoiceStudioError(_problem(voices))
            models = await client.get("/v1/models", headers=_headers(key))
            listed = models.json().get("data", []) if models.status_code < 400 else []
    except httpx.HTTPError:
        raise VoiceStudioError(UNREACHABLE) from None
    except ValueError as error:
        if isinstance(error, VoiceStudioError):
            raise
        raise VoiceStudioError("VoiceStudio's answer could not be read.") from None
    raw = voices.json()
    values = raw.get("voices", raw.get("data", [])) if isinstance(raw, dict) else raw
    result = [{"id": "default", "name": "Engine default"}]
    for item in (values or [])[:500]:
        if isinstance(item, str):
            result.append({"id": item, "name": item})
        elif isinstance(item, dict):
            if item.get("type") == "openai_alias":
                continue
            ident = item.get("voice_id") or item.get("id") or item.get("name")
            if ident and str(ident) != "default":
                result.append({"id": str(ident), "name": str(item.get("name") or ident)})
    # Engines: the list VoiceStudio gives with its voices when present; else every installed engine from /v1/models;
    # tts-1 (the active engine) is always offered first, so a fresh install with one engine just works.
    engines = []
    if isinstance(raw, dict) and isinstance(raw.get("engines"), list):
        engines = [str(e["id"]) for e in raw["engines"] if isinstance(e, dict) and e.get("id") and e.get("available")
                   and e.get("routing_status") != "unavailable"]
    else:
        engines = [str(m["id"]) for m in listed[:150] if isinstance(m, dict) and m.get("id")
                   and not str(m["id"]).startswith(OPENAI_ALIASES) and "whisper" not in str(m["id"]).lower()]
    return {"voices": result, "models": [ACTIVE_ENGINE] + [e for e in engines if e != ACTIVE_ENGINE]}


async def check(origin: str, key: str) -> dict:
    """Is a VoiceStudio answering there, does it accept the key, and what can it speak with? Renders nothing."""
    try:
        async with _client(origin, 5.0) as client:
            health = await client.get("/health")
            if health.status_code >= 400:
                raise VoiceStudioError(f"Something answered at that address, but not a ready VoiceStudio ({health.status_code}).")
    except httpx.HTTPError:
        raise VoiceStudioError(UNREACHABLE) from None
    found = await catalog(origin, key)
    return {"ok": True, "voices": len(found["voices"]) - 1, "engines": found["models"]}


async def stream(origin: str, key: str, text: str, model: str, voice: str) -> AsyncIterator[dict]:
    """One sentence -> {'sample_rate': 24000} then {'audio': bytes} as VoiceStudio sends them."""
    if not text.strip() or len(text) > MAX_TEXT:
        raise VoiceStudioError("That text cannot be spoken.")
    body = {"model": model or ACTIVE_ENGINE, "voice": voice or "default", "input": text, "response_format": "pcm",
            "stream_format": "audio"}
    try:
        async with _client(origin, 60.0) as client:
            async with client.stream("POST", "/v1/audio/speech", headers=_headers(key), json=body) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise VoiceStudioError(_problem(response))
                yield {"sample_rate": SAMPLE_RATE}
                total = 0
                async for data in response.aiter_bytes():
                    total += len(data)
                    if total > SAMPLE_RATE * 2 * 180:
                        raise VoiceStudioError("Voice response exceeded its limit.")
                    if data:
                        yield {"audio": data}
    except httpx.HTTPError:
        raise VoiceStudioError(UNREACHABLE) from None
