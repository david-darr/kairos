"""Audio for Discord voice channels (a bot talking with the person by voice in a server channel).

Discord carries Opus at 48 kHz stereo in 20 ms frames. The speech pipeline (speech-to-text, Smart Turn, the endpointer)
wants 16 kHz mono PCM16, and a voice speaks mono at its own rate (often 24 kHz), so this converts both ways. numpy only,
through core/phone_audio.Resampler (streaming, so chunk boundaries do not click).

Opus itself sits behind a small codec seam (`encode` a 20 ms PCM frame, `new_decoder().decode` a packet) so tests run
with a fake and the real one (discord.py's libopus binding) is only built when the library can actually be loaded.
Nothing here touches a network or Discord.
"""
import importlib.util
from typing import Optional

import numpy as np

from core import phone_audio

DISCORD_RATE = 48000
CHANNELS = 2
FRAME_SAMPLES = 960                        # 20 ms at 48 kHz
FRAME_SECONDS = FRAME_SAMPLES / DISCORD_RATE
FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2  # 3840: 20 ms of 48 kHz stereo PCM16
OPUS_SILENCE = b"\xf8\xff\xfe"             # a 20 ms Opus frame of silence


def to_mono_float(pcm_stereo: bytes) -> np.ndarray:
    """48 kHz-style interleaved stereo PCM16 -> mono float32 (the channels averaged)."""
    usable = len(pcm_stereo) - (len(pcm_stereo) % (CHANNELS * 2))
    samples = np.frombuffer(pcm_stereo[:usable], dtype="<i2").astype(np.float32) / 32768.0
    return samples.reshape(-1, CHANNELS).mean(axis=1) if samples.size else np.zeros(0, dtype=np.float32)


class DiscordToSpeech:
    """Inbound: one person's 48 kHz stereo PCM16 -> 16 kHz mono PCM16 bytes."""

    def __init__(self):
        self.resampler = phone_audio.Resampler(DISCORD_RATE, phone_audio.SPEECH_RATE)

    def feed(self, pcm_stereo: bytes) -> bytes:
        return phone_audio.float_to_pcm16(self.resampler.process(to_mono_float(pcm_stereo)))


class SpeechToDiscord:
    """Outbound: mono PCM16 at the voice's own rate -> exact 20 ms frames of 48 kHz stereo PCM16 (FRAME_BYTES each).
    The last short piece is held back until `final` and padded with silence."""

    def __init__(self, source_rate: int):
        self.resampler = phone_audio.Resampler(source_rate, DISCORD_RATE)
        self.source = int(source_rate)
        self.pending = b""

    def frames(self, pcm16: bytes, final: bool = False) -> list[bytes]:
        mono = self.resampler.process(phone_audio.pcm16_to_float(pcm16))
        stereo = np.repeat(mono, CHANNELS)
        self.pending += (np.clip(stereo, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        out = []
        while len(self.pending) >= FRAME_BYTES:
            out.append(self.pending[:FRAME_BYTES])
            self.pending = self.pending[FRAME_BYTES:]
        if final and self.pending:
            out.append(self.pending + b"\x00" * (FRAME_BYTES - len(self.pending)))
            self.pending = b""
        return out


def missing_requirements() -> list[str]:
    """What voice in a Discord channel needs that is not installed here (empty when it can work).
    PyNaCl encrypts the voice connection, davey is Discord's end-to-end voice encryption, discord-ext-voice-recv
    receives other people's audio (discord.py alone only sends), and libopus encodes and decodes it."""
    missing = []
    for label, module in (("PyNaCl", "nacl"), ("davey", "davey"), ("discord-ext-voice-recv", "discord.ext.voice_recv")):
        try:
            found = importlib.util.find_spec(module)
        except (ImportError, ValueError):
            found = None
        if found is None:
            missing.append(label)
    if not _opus_loadable():
        missing.append("libopus")
    return missing


def _opus_loadable() -> bool:
    try:
        import discord
        if discord.opus.is_loaded():
            return True
        discord.opus._load_default()
        return discord.opus.is_loaded()
    except Exception:
        return False


class OpusCodec:
    """The real codec: 20 ms of 48 kHz stereo PCM16 <-> an Opus packet, through discord.py's libopus binding."""

    def __init__(self):
        import discord
        self._discord = discord
        self._encoder = discord.opus.Encoder()

    def encode(self, pcm_frame: bytes) -> bytes:
        return self._encoder.encode(pcm_frame, FRAME_SAMPLES)

    def new_decoder(self):
        return _Decoder(self._discord.opus.Decoder())


class _Decoder:
    def __init__(self, decoder):
        self._decoder = decoder

    def decode(self, packet: bytes) -> bytes:
        return self._decoder.decode(packet, fec=False)


def real_codec() -> Optional[OpusCodec]:
    return OpusCodec() if _opus_loadable() else None
