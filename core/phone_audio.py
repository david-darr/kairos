"""Audio for the phone bridge (build spec step 8): G.711 mu-law and streaming sample-rate conversion.

A phone line carries 8 kHz mu-law. The speech pipeline (whisper, Smart Turn) wants 16 kHz PCM16, and a neural voice
speaks at 24 kHz or so, so the bridge converts both ways. numpy only: no audioop (gone in new Pythons), no scipy.
`Resampler` is streaming (chunk boundaries do not click) so a voice can be converted as it arrives.
"""
import numpy as np

PHONE_RATE = 8000
SPEECH_RATE = 16000
FRAME_BYTES = 160          # 20 ms of 8 kHz mu-law, the unit providers speak in
BIAS = 0x84
CLIP = 32635


def _decode_table() -> np.ndarray:
    codes = (~np.arange(256, dtype=np.int32)) & 0xFF
    sign = codes & 0x80
    exponent = (codes >> 4) & 0x07
    mantissa = codes & 0x0F
    magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS
    return np.where(sign != 0, -magnitude, magnitude).astype(np.int16)


_DECODE = _decode_table()


def mulaw_decode(data: bytes) -> np.ndarray:
    """mu-law bytes -> int16 samples."""
    return _DECODE[np.frombuffer(data, dtype=np.uint8)]


def mulaw_encode(samples) -> bytes:
    """int16 (or float in [-1, 1]) samples -> mu-law bytes."""
    samples = np.asarray(samples)
    if samples.dtype.kind == "f":
        samples = np.clip(samples, -1.0, 1.0) * 32767.0
    value = samples.astype(np.int32)
    sign = np.where(value < 0, 0x80, 0)
    magnitude = np.minimum(np.abs(value), CLIP) + BIAS
    exponent = np.zeros(magnitude.shape, dtype=np.int32)
    for bit in range(8, 15):
        exponent += (magnitude >= (1 << bit)).astype(np.int32)
    mantissa = (magnitude >> (exponent + 3)) & 0x0F
    return ((~(sign | (exponent << 4) | mantissa)) & 0xFF).astype(np.uint8).tobytes()


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data[: len(data) - (len(data) % 2)], dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(samples) -> bytes:
    return (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class Resampler:
    """Streaming rate conversion for mono float32 audio. Feed any chunking; the output is continuous.
    Downsampling low-passes first (windowed sinc) so nothing aliases; upsampling is linear interpolation."""

    TAPS = 63

    def __init__(self, source: int, target: int):
        if source <= 0 or target <= 0:
            raise ValueError("sample rates must be positive")
        self.source, self.target = int(source), int(target)
        self.step = self.source / self.target
        if self.target < self.source:
            cutoff = 0.45 * self.target / self.source          # fraction of the source rate
            n = np.arange(self.TAPS) - (self.TAPS - 1) / 2
            taps = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(self.TAPS)
            self.taps = (taps / taps.sum()).astype(np.float32)
        else:
            self.taps = np.ones(1, dtype=np.float32)
        self.history = np.zeros(len(self.taps) - 1, dtype=np.float32)
        self.previous = np.float32(0.0)
        self.position = 0.0

    def process(self, samples) -> np.ndarray:
        x = np.asarray(samples, dtype=np.float32)
        if x.size == 0:
            return np.zeros(0, dtype=np.float32)
        if self.source == self.target:
            return x
        joined = np.concatenate([self.history, x])
        filtered = np.convolve(joined, self.taps, mode="valid") if len(self.taps) > 1 else x
        if len(self.history):
            self.history = joined[-len(self.history):]
        count = len(filtered)
        extended = np.concatenate([[self.previous], filtered])
        last = count - 1
        if self.position > last:
            self.position -= count
            self.previous = filtered[-1]
            return np.zeros(0, dtype=np.float32)
        outputs = int((last - self.position) / self.step) + 1
        points = self.position + self.step * np.arange(outputs) + 1.0
        result = np.interp(points, np.arange(len(extended)), extended).astype(np.float32)
        self.position = self.position + outputs * self.step - count
        self.previous = filtered[-1]
        return result


def resample(samples, source: int, target: int) -> np.ndarray:
    """One-shot conversion of a whole clip."""
    return Resampler(source, target).process(samples)


class PhoneToSpeech:
    """Inbound: mu-law 8 kHz frames -> 16 kHz PCM16 bytes for speech-to-text, Smart Turn and the endpointer."""

    def __init__(self):
        self.resampler = Resampler(PHONE_RATE, SPEECH_RATE)

    def feed(self, mulaw: bytes) -> bytes:
        pcm = mulaw_decode(mulaw).astype(np.float32) / 32768.0
        return float_to_pcm16(self.resampler.process(pcm))


class SpeechToPhone:
    """Outbound: PCM16 at the voice's own rate -> mu-law 8 kHz, cut into 20 ms frames by `frames()`."""

    def __init__(self, source_rate: int):
        self.resampler = Resampler(source_rate, PHONE_RATE)
        self.pending = b""

    def feed(self, pcm16: bytes) -> bytes:
        return mulaw_encode(self.resampler.process(pcm16_to_float(pcm16)))

    def frames(self, pcm16: bytes, final: bool = False) -> list[bytes]:
        """mu-law frames of exactly FRAME_BYTES; the last short piece is held back until `final`
        (padded with mu-law silence, 0xFF)."""
        self.pending += self.feed(pcm16)
        out = []
        while len(self.pending) >= FRAME_BYTES:
            out.append(self.pending[:FRAME_BYTES])
            self.pending = self.pending[FRAME_BYTES:]
        if final and self.pending:
            out.append(self.pending + b"\xff" * (FRAME_BYTES - len(self.pending)))
            self.pending = b""
        return out


def wav_bytes(pcm16: bytes, rate: int = SPEECH_RATE) -> bytes:
    """16-bit mono WAV, the shape core/speech.py takes."""
    import io
    import wave
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm16)
    return buffer.getvalue()
