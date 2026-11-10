"""Voicebox (https://github.com/jamiepine/voicebox, MIT) as a voice engine on a copy the person runs themselves. Voicebox
is a local voice studio (cloned, preset and designed voices) whose app starts a REST server on 127.0.0.1:17493. Kairos
only talks to that server; nothing of Voicebox is bundled, installed or started from here.

Written from Voicebox's route code at commit 8af7efe6 (read 2026-11-10, see the vault's "Voicebox Study for Kairos Voice"):
  GET  /health                 HealthResponse: {status: "healthy", model_loaded, gpu_available, ...} (no name field)
  GET  /profiles               [VoiceProfileResponse: {id, name, language, voice_type, default_engine, preset_engine, ...}]
  POST /generate/stream        GenerationRequest {profile_id, text, language, engine?} -> the whole clip as audio/wav,
                               sent in 64 KB slices once rendered; 404 {"detail": "Profile not found"}, 400 for a bad
                               engine. Nothing is saved in Voicebox's history.
  POST /generate               same body -> {id, status: "generating"}; then GET /generate/{id}/status (Server-Sent
                               Events about once a second: {id, status: generating | loading_model | completed | failed,
                               error}) and GET /audio/{id} (the WAV). Used only when /generate/stream is missing.
Voicebox renders a whole clip before any of it plays (no streaming synthesis). Kairos sends one sentence per request and
fetches the next while one plays (core/call_voices.py callers), so the wait is about one sentence's render.
UNVERIFIED: no Voicebox was running here; only a mock server written from that source has been tested.
"""
import json
import struct
from typing import AsyncIterator, Optional

import httpx
import numpy as np

TRANSPORT: Optional[httpx.AsyncBaseTransport] = None    # tests: a mock Voicebox
DEFAULT_URL = "http://127.0.0.1:17493"
REPO = "https://github.com/jamiepine/voicebox"
PROFILE_ENGINE = "profile"                               # "use the engine the voice profile is set to"
ENGINES = ("qwen", "qwen_custom_voice", "qwen_voice_design", "luxtts", "chatterbox", "chatterbox_turbo", "tada", "kokoro",
           "omnivoice")
MAX_TEXT = 1600
MAX_WAV = 48000 * 4 * 2 * 180                            # three minutes of 48 kHz float stereo
RENDER_TIMEOUT = 120.0                                   # a first render may load the model
_LANGUAGES: dict = {}                                    # profile id -> language, from the last voice list


class VoiceboxError(ValueError):
    """Shown to the person as-is."""


UNREACHABLE = "Could not reach Voicebox at that address. Open the Voicebox app, then check again."


def _client(origin: str, timeout: float = 8.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=origin, transport=TRANSPORT, timeout=httpx.Timeout(timeout, connect=4.0),
                             trust_env=False, follow_redirects=False)


def _detail(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    return detail if isinstance(detail, str) else ""


def _problem(response: httpx.Response) -> str:
    detail = _detail(response)
    if response.status_code == 404 and "profile" in detail.lower():
        return "That Voicebox voice is gone. Choose another voice."
    if response.status_code == 400:
        return "Voicebox could not speak with that voice and engine. Choose the voice's own engine, or another voice."
    if response.status_code == 202 or "download" in detail.lower():
        return "Voicebox is still downloading that voice's model. Try again when it is done."
    return f"Voicebox answered with an error ({response.status_code})."


async def catalog(origin: str) -> dict:
    """{'voices': [{id, name}], 'models': ['profile', engines the profiles use]} from the running Voicebox."""
    try:
        async with _client(origin) as client:
            response = await client.get("/profiles")
    except httpx.HTTPError:
        raise VoiceboxError(UNREACHABLE) from None
    if response.status_code >= 400:
        raise VoiceboxError(_problem(response))
    try:
        listed = response.json()
    except ValueError:
        raise VoiceboxError("Voicebox's answer could not be read.") from None
    voices, engines = [], []
    for item in listed[:500] if isinstance(listed, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            continue
        voices.append({"id": item["id"], "name": str(item.get("name") or item["id"])[:120]})
        if isinstance(item.get("language"), str):
            _LANGUAGES[item["id"]] = item["language"]
        for key in ("default_engine", "preset_engine"):
            if item.get(key) in ENGINES and item[key] not in engines:
                engines.append(item[key])
    return {"voices": voices, "models": [PROFILE_ENGINE] + engines}


async def check(origin: str) -> dict:
    """Is a Voicebox answering there, and how many voices does it have? Renders nothing."""
    try:
        async with _client(origin, 5.0) as client:
            health = await client.get("/health")
    except httpx.HTTPError:
        raise VoiceboxError(UNREACHABLE) from None
    try:
        body = health.json() if health.status_code < 400 else {}
    except ValueError:
        body = {}
    # Voicebox's health answer carries no name, so its shape is the test: status "healthy" plus gpu_available.
    if not isinstance(body, dict) or body.get("status") != "healthy" or "gpu_available" not in body:
        raise VoiceboxError("Something answered at that address, but it is not Voicebox.")
    found = await catalog(origin)
    return {"ok": True, "voices": len(found["voices"])}


def wav_to_pcm16(data: bytes) -> tuple[int, bytes]:
    """(sample rate, 16-bit mono PCM) from a WAV file: PCM 16, 24 or 32 bit, or 32-bit float, any channel count."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise VoiceboxError("Voicebox sent audio Kairos cannot read.")
    at, fmt, samples = 12, None, None
    while at + 8 <= len(data):
        kind, size = data[at:at + 4], struct.unpack("<I", data[at + 4:at + 8])[0]
        body = data[at + 8:at + 8 + size]
        if kind == b"fmt " and len(body) >= 16:
            tag, channels, rate, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            if tag == 0xFFFE and len(body) >= 26:
                tag = struct.unpack("<H", body[24:26])[0]
            fmt = (tag, channels, rate, bits)
        elif kind == b"data":
            samples = body
        at += 8 + size + (size & 1)
    if not fmt or samples is None or not fmt[1] or not 8000 <= fmt[2] <= 96000:
        raise VoiceboxError("Voicebox sent audio Kairos cannot read.")
    tag, channels, rate, bits = fmt
    if tag == 1 and bits == 16:
        values = np.frombuffer(samples[:len(samples) // 2 * 2], "<i2").astype(np.float64)
    elif tag == 1 and bits == 24:
        raw = np.frombuffer(samples[:len(samples) // 3 * 3], np.uint8).reshape(-1, 3).astype(np.int32)
        values = ((raw[:, 0] | raw[:, 1] << 8 | raw[:, 2] << 16) << 8 >> 8).astype(np.float64) / 256
    elif tag == 1 and bits == 32:
        values = np.frombuffer(samples[:len(samples) // 4 * 4], "<i4").astype(np.float64) / 65536
    elif tag == 3 and bits == 32:
        values = np.frombuffer(samples[:len(samples) // 4 * 4], "<f4").astype(np.float64) * 32768
    else:
        raise VoiceboxError("Voicebox sent audio Kairos cannot read.")
    values = values[:len(values) // channels * channels].reshape(-1, channels).mean(axis=1)
    return rate, np.clip(np.rint(values), -32768, 32767).astype("<i2").tobytes()


async def _render(client: httpx.AsyncClient, body: dict) -> bytes:
    """The whole clip for one sentence: /generate/stream, or the queued /generate route on a Voicebox without it."""
    async with client.stream("POST", "/generate/stream", json=body) as response:
        if response.status_code < 400:
            data = bytearray()
            async for piece in response.aiter_bytes():
                data.extend(piece)
                if len(data) > MAX_WAV:
                    raise VoiceboxError("Voice response exceeded its limit.")
            return bytes(data)
        await response.aread()
        if response.status_code not in (404, 405) or "profile" in _detail(response).lower():
            raise VoiceboxError(_problem(response))
    started = await client.post("/generate", json=body)
    if started.status_code >= 400:
        raise VoiceboxError(_problem(started))
    ident = str((started.json() or {}).get("id") or "")
    if not ident or not all(c.isalnum() or c in "-_" for c in ident):
        raise VoiceboxError("Voicebox did not start the voice.")
    async with client.stream("GET", f"/generate/{ident}/status") as events:
        async for line in events.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                status = json.loads(line[5:]).get("status")
            except (ValueError, AttributeError):
                continue
            if status == "completed":
                break
            if status in ("failed", "not_found"):
                raise VoiceboxError("Voicebox could not speak that sentence.")
        else:
            raise VoiceboxError("Voicebox stopped before the voice was ready.")
    audio = await client.get(f"/audio/{ident}")
    if audio.status_code >= 400:
        raise VoiceboxError(_problem(audio))
    return audio.content[:MAX_WAV + 1]


async def stream(origin: str, text: str, model: str, voice: str) -> AsyncIterator[dict]:
    """One sentence -> {'sample_rate': rate} then {'audio': bytes} in about 100 ms pieces, once Voicebox has rendered it."""
    if not text.strip() or len(text) > MAX_TEXT:
        raise VoiceboxError("That text cannot be spoken.")
    if not voice or len(voice) > 160 or not all(c.isalnum() or c in "-_" for c in voice):
        raise VoiceboxError("Choose a Voicebox voice first.")
    body = {"profile_id": voice, "text": text, "language": _LANGUAGES.get(voice, "en")}
    if model in ENGINES:
        body["engine"] = model
    try:
        async with _client(origin, RENDER_TIMEOUT) as client:
            data = await _render(client, body)
    except httpx.HTTPError:
        raise VoiceboxError(UNREACHABLE) from None
    if len(data) > MAX_WAV:
        raise VoiceboxError("Voice response exceeded its limit.")
    rate, pcm = wav_to_pcm16(data)
    yield {"sample_rate": rate}
    piece = rate // 10 * 2
    for at in range(0, len(pcm), piece):
        yield {"audio": pcm[at:at + piece]}
