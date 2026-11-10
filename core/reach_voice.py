"""A bot's message spoken in its own voice and packed as a voice message (OGG with Opus), for Telegram's sendVoice.

The speech comes from the account's chosen voice engine through core/call_voices.py (via services/bot_voice, which picks
the bot's voice in that engine); the packing uses the FFmpeg the person already has (core/ffmpeg_tools.py finds it and
never installs it). Nothing here sends anything.
"""
import asyncio
import subprocess

MAX_SECONDS = 120
BITRATE = "32k"          # speech; Telegram plays any Opus bitrate


class VoiceUnavailable(Exception):
    """The voice message cannot be made here; the message says why, plainly."""


async def speak(text: str, voice_id=None) -> tuple:
    """(sample_rate, PCM16 mono bytes) for the whole text, in the bot's voice."""
    from services import bot_voice
    prepared = bot_voice.prepare(text)
    if prepared["withheld"] or not prepared["blocks"]:
        raise VoiceUnavailable("The message holds something private, so it is not spoken.")
    rate, pcm = None, bytearray()
    try:
        for block in prepared["blocks"]:
            async for item in bot_voice.audio_events(block, voice_id):
                if "sample_rate" in item:
                    if rate not in (None, item["sample_rate"]):
                        raise VoiceUnavailable("The voice engine changed its audio format mid-message.")
                    rate = item["sample_rate"]
                elif "audio" in item:
                    pcm.extend(item["audio"])
                    if rate and len(pcm) > rate * 2 * MAX_SECONDS:
                        raise VoiceUnavailable("The voice message would be longer than two minutes.")
    except bot_voice.VoiceError as error:
        raise VoiceUnavailable(f"{error}. Set a voice up in Settings > Speech.") from None
    except VoiceUnavailable:
        raise
    except Exception as error:
        raise VoiceUnavailable(f"The voice engine could not speak it ({type(error).__name__}).") from None
    if not rate or not pcm:
        raise VoiceUnavailable("The voice engine returned no audio.")
    if len(pcm) % 2:
        pcm = pcm[:-1]
    return rate, bytes(pcm)


def encode_ogg_opus(pcm: bytes, rate: int, executable=None) -> bytes:
    """PCM16 mono at `rate` into an OGG file with one Opus stream, through FFmpeg."""
    from core import ffmpeg_tools
    ffmpeg = executable or ffmpeg_tools.find()
    if not ffmpeg:
        raise VoiceUnavailable("Voice messages need FFmpeg, which isn't installed. Kairos never installs it for you.")
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(int(rate)), "-ac", "1",
               "-i", "pipe:0", "-c:a", "libopus", "-b:a", BITRATE, "-application", "voip", "-ac", "1",
               "-f", "ogg", "pipe:1"]
    try:
        result = subprocess.run(command, input=pcm, capture_output=True, timeout=60,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VoiceUnavailable(f"FFmpeg could not pack the voice message ({type(error).__name__}).") from None
    data = result.stdout
    if result.returncode != 0 or not is_ogg_opus(data):
        raise VoiceUnavailable("FFmpeg could not pack the voice message (no Opus encoder?).")
    return data


def is_ogg_opus(data: bytes) -> bool:
    """An OGG stream whose first packet is an Opus header."""
    return bool(data) and data[:4] == b"OggS" and b"OpusHead" in data[:200]


async def voice_message(text: str, voice_id=None) -> tuple:
    """(ogg bytes, seconds) for a voice message saying `text`."""
    rate, pcm = await speak(text, voice_id)
    ogg = await asyncio.to_thread(encode_ogg_opus, pcm, rate)
    return ogg, len(pcm) / (rate * 2)
