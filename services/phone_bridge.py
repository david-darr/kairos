"""A phone call as a voice call (build spec step 8): a provider's media stream bridged into the call pipeline.

The line carries 8 kHz mu-law. Inbound audio is decoded and resampled to 16 kHz, cut into turns by a server-side
endpointer (the same energy rules as static/js/speechSegments.js, with Smart Turn asked on a pause when it is available),
transcribed, answered by the bot's conversation model, and spoken back through the local voice, resampled to 8 kHz
mu-law in 20 ms frames. The caller can talk over the bot: sustained speech cancels the reply, clears what the provider
has buffered and listens; a short "mm-hm" does not interrupt.

Everything stateful about *speech, thinking and talking* sits behind `Pipeline`, so tests drive the whole bridge with a
fake media stream and fake speech-to-text, model and voice (scripts/test_phone_calls.py), and nothing here touches a
network or an account by itself.
"""
import asyncio
import logging
import re
import time
import uuid
from typing import AsyncIterator, Callable, Optional

import numpy as np

from core import phone_audio
from core.phone_providers import Provider

logger = logging.getLogger(__name__)

SENTENCE = re.compile(r"(?<=[.!?])\s+")
LEAD_SECONDS = 2.0            # how far ahead of playback frames are sent (what a barge-in has to clear)
BARGE_VOICED_MS = 400         # speech this long over the bot's voice is an interruption; shorter is a backchannel
MAX_CALL_SECONDS = 30 * 60


class Endpointer:
    """Speech turns from 16 kHz float audio. Energy based, all timing from sample counts.

    push() returns events: ('start',), ('pause', id, samples) when Smart Turn should be asked, ('segment', samples).
    With Smart Turn on, a verdict of complete ends the turn after the 200 ms pause; incomplete waits up to `cap_ms` of
    quiet; no verdict falls back to the ordinary silence wait. This mirrors static/js/speechSegments.js.
    """
    HOP = 320                  # 20 ms at 16 kHz

    def __init__(self, rate: int = 16000, pre_roll_ms: int = 400, silence_ms: int = 700, smart: bool = False,
                 cap_ms: int = 2500, pause_ms: int = 200, onset_ms: int = 60, min_voiced_ms: int = 120,
                 max_ms: int = 30000, trailing_ms: int = 160):
        self.rate, self.smart = rate, smart
        ms = lambda value: int(rate * value / 1000)   # noqa: E731
        self.pre_roll, self.silence, self.cap, self.pause = ms(pre_roll_ms), ms(silence_ms), ms(cap_ms), ms(pause_ms)
        self.onset, self.min_voiced, self.max, self.trailing = ms(onset_ms), ms(min_voiced_ms), ms(max_ms), ms(trailing_ms)
        self.pause_id = 0
        self.noise, self.calibration, self.calibrated = 0.002, [], 0
        self.buffer = np.zeros(0, dtype=np.float32)
        self.ring: list = []
        self._reset()

    def _reset(self):
        self.active, self.attack, self.voiced, self.quiet, self.length = False, 0, 0, 0, 0
        self.parts: list = []
        self.asked, self.verdict = False, None

    @property
    def voiced_ms(self) -> float:
        return self.voiced * 1000 / self.rate

    def push(self, samples) -> list:
        self.buffer = np.concatenate([self.buffer, np.asarray(samples, dtype=np.float32)])
        events = []
        while len(self.buffer) >= self.HOP:
            frame, self.buffer = self.buffer[: self.HOP], self.buffer[self.HOP:]
            events.extend(self._frame(frame))
        return events

    def answer(self, pause_id: int, complete: bool) -> list:
        """The verdict for a pause question; ignored if voice resumed since."""
        if self.active and self.asked and pause_id == self.pause_id:
            self.verdict = bool(complete)
            return self._decide()
        return []

    def _frame(self, frame) -> list:
        rms = float(np.sqrt(np.mean(frame * frame)))
        if not self.active:
            self.ring.append(frame)
            while sum(len(f) for f in self.ring) > self.pre_roll and len(self.ring) > 1:
                self.ring.pop(0)
            if self.calibrated < self.rate * 0.2:
                self.calibration.append(rms)
                self.calibrated += len(frame)
                ordered = sorted(self.calibration)
                self.noise = max(0.0005, min(0.012, ordered[int(len(ordered) * 0.2)]))
                return []
            if rms > max(0.004, self.noise * 2.5):
                self.attack += len(frame)
            else:
                self.attack = 0
                self.noise = max(0.0005, min(0.012, self.noise * 0.98 + rms * 0.02))
            if self.attack >= self.onset:
                self.active, self.parts = True, list(self.ring)
                self.length = sum(len(f) for f in self.parts)
                self.voiced, self.quiet, self.asked, self.verdict = self.attack, 0, False, None
                return [("start",)]
            return []
        self.parts.append(frame)
        self.length += len(frame)
        events = []
        if rms > max(0.0025, self.noise * 1.6):
            self.voiced += len(frame)
            self.quiet = 0
            if self.asked:
                self.asked, self.verdict = False, None      # voice resumed: forget the question
        else:
            self.quiet += len(frame)
        if self.length >= self.max:
            return self._finish()
        if self.smart and not self.asked and self.quiet >= self.pause and self.voiced >= self.min_voiced:
            self.asked = True
            self.pause_id += 1
            events.append(("pause", self.pause_id, np.concatenate(self.parts)))
        return events + self._decide()

    def _decide(self) -> list:
        if not self.active:
            return []
        verdict = self.verdict if self.smart else None
        if verdict is True:
            done = self.quiet >= self.pause
        elif verdict is False:
            done = self.quiet >= max(self.cap, self.silence)
        else:
            done = self.quiet >= self.silence
        return self._finish() if done else []

    def _finish(self) -> list:
        voiced, parts, quiet = self.voiced, self.parts, self.quiet
        self._reset()
        if voiced < self.min_voiced:
            return []
        audio = np.concatenate(parts)
        if quiet > self.trailing:
            audio = audio[: len(audio) - (quiet - self.trailing)]
        return [("segment", audio)]


def split_sentences(buffer: str) -> tuple[list[str], str]:
    """Complete sentences in `buffer`, and the unfinished rest. Very short pieces ("Hi.") join the next sentence."""
    pieces = SENTENCE.split(buffer)
    rest = pieces.pop() if pieces else ""
    sentences, carry = [], ""
    for piece in pieces:
        carry = (carry + " " + piece).strip()
        if len(carry) >= 12:
            sentences.append(carry)
            carry = ""
    return sentences, (carry + " " + rest) if carry else rest


def spoken_text(text: str) -> str:
    return re.sub(r"[*_`#>]+", "", text or "").strip()


class Pipeline:
    """What a call needs from the rest of Kairos. The live one is services/phone_calls.py's LivePipeline."""

    async def transcribe(self, pcm16: bytes) -> str: ...
    async def end_of_turn(self, pcm16: bytes) -> Optional[bool]:
        return None
    def converse(self, text: str, request_id: str) -> AsyncIterator[str]: ...
    async def announce(self, text: str, request_id: str) -> None: ...
    def speak(self, text: str) -> AsyncIterator[tuple[int, bytes]]: ...
    def interrupt(self, spoken: bool) -> None: ...
    def touch(self) -> None: ...
    async def close(self) -> None: ...


class PhoneBridge:
    def __init__(self, provider: Provider, send: Callable, pipeline: Pipeline, *, stream_id: str = "", opening: str = "",
                 smart_turn: bool = False, pace: bool = True, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable = asyncio.sleep, max_seconds: float = MAX_CALL_SECONDS):
        self.provider, self.send_text, self.pipeline = provider, send, pipeline
        self.stream_id, self.opening = stream_id, opening
        self.pace, self.clock, self.sleep, self.max_seconds = pace, clock, sleep, max_seconds
        self.inbound = phone_audio.PhoneToSpeech()
        self.endpointer = Endpointer(smart=smart_turn)
        self.phase = "idle"                    # idle | thinking | speaking
        self.turn: Optional[asyncio.Task] = None
        self.background: set = set()
        self.play_end = 0.0
        self.backchannel = False
        self.sent_frames = 0
        self.heard: list[str] = []
        self.frames_in = 0

    # -- the media loop --------------------------------------------------------------------------

    async def run(self, recv: Callable) -> None:
        """Read the provider's messages until the call ends. `recv()` returns the next text message, or None."""
        started = self.clock()
        try:
            if self.opening:
                self.turn = asyncio.create_task(self._open())
            while self.clock() - started < self.max_seconds:
                raw = await recv()
                if raw is None:
                    break
                kind, data = self.provider.parse_stream(raw)
                if kind == "start" and data.get("stream_id"):
                    self.stream_id = data["stream_id"]
                elif kind == "media":
                    await self._audio(data)
                elif kind == "stop":
                    break
        finally:
            await self._shutdown()

    async def _audio(self, mulaw: bytes) -> None:
        self.frames_in += 1
        if self.frames_in % 50 == 0:
            self.pipeline.touch()
        pcm16 = self.inbound.feed(mulaw)
        await self._events(self.endpointer.push(phone_audio.pcm16_to_float(pcm16)))
        if self.phase == "speaking" and self.endpointer.active and self.endpointer.voiced_ms >= BARGE_VOICED_MS:
            await self._barge_in()

    async def _events(self, events: list) -> None:
        for event in events:
            if event[0] == "start":
                self.backchannel = self.phase == "speaking"
            elif event[0] == "pause":
                self._spawn(self._ask(event[1], event[2]))
            elif event[0] == "segment":
                if self.backchannel:
                    self.backchannel = False    # a short "mm-hm" over the bot's voice is not a turn
                    continue
                await self._cancel_turn(spoken=False)
                self.turn = asyncio.create_task(self._respond(event[1]))

    async def _ask(self, pause_id: int, samples) -> None:
        verdict = None
        try:
            verdict = await self.pipeline.end_of_turn(phone_audio.float_to_pcm16(samples))
        except Exception:
            logger.info("phone: Smart Turn unavailable for this pause")
        if verdict is not None:
            await self._events(self.endpointer.answer(pause_id, verdict))

    def _spawn(self, coroutine) -> None:
        task = asyncio.create_task(coroutine)
        self.background.add(task)
        task.add_done_callback(self.background.discard)

    # -- one turn -----------------------------------------------------------------------------------

    async def _open(self) -> None:
        self.phase = "speaking"
        try:
            await self.pipeline.announce(self.opening, "open:" + uuid.uuid4().hex)
            await self._say(self._once(self.opening))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("phone: the opening line failed")
        finally:
            self.phase = "idle"

    @staticmethod
    async def _once(text: str):
        yield text

    async def _respond(self, samples) -> None:
        self.phase = "thinking"
        try:
            text = (await self.pipeline.transcribe(phone_audio.float_to_pcm16(samples))).strip()
            if not text:
                return
            self.heard.append(text)
            await self._say(self.pipeline.converse(text, "phone:" + uuid.uuid4().hex))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("phone: a turn failed")
        finally:
            self.phase = "idle"

    async def _say(self, deltas) -> None:
        """Speak a stream of text: each finished sentence is rendered while the one before it is still playing."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)

        async def render(sentence: str) -> None:
            converter = None
            async for rate, pcm in self.pipeline.speak(spoken_text(sentence)):
                if converter is None or converter.resampler.source != rate:
                    converter = phone_audio.SpeechToPhone(rate)
                frames = converter.frames(pcm)
                if frames:
                    await queue.put(frames)
            if converter:
                tail = converter.frames(b"", final=True)
                if tail:
                    await queue.put(tail)

        async def produce() -> None:
            buffer = ""
            try:
                async for delta in deltas:
                    buffer += delta
                    sentences, buffer = split_sentences(buffer)
                    for sentence in sentences:
                        await self._guarded(render, sentence)
                if buffer.strip():
                    await self._guarded(render, buffer)
            finally:
                await queue.put(None)

        producer = asyncio.create_task(produce())
        try:
            while (frames := await queue.get()) is not None:
                self.phase = "speaking"
                await self._send_frames(frames)
            await producer
            if self.pace and self.phase == "speaking":
                await self.sleep(max(0.0, self.play_end - self.clock()))
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)

    @staticmethod
    async def _guarded(render, sentence: str) -> None:
        try:
            await render(sentence)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("phone: a sentence could not be spoken")

    async def _send_frames(self, frames: list) -> None:
        for frame in frames:
            now = self.clock()
            if self.pace and self.play_end - now > LEAD_SECONDS:
                await self.sleep(self.play_end - now - LEAD_SECONDS)
            await self.send_text(self.provider.media_frame(self.stream_id, frame))
            self.sent_frames += 1
            self.play_end = max(self.play_end, self.clock()) + len(frame) / phone_audio.PHONE_RATE

    # -- interruption and the end ------------------------------------------------------------------

    async def _barge_in(self) -> None:
        self.backchannel = False
        await self._cancel_turn(spoken=True)
        await self.send_text(self.provider.clear_frame(self.stream_id))
        self.play_end = 0.0

    async def _cancel_turn(self, spoken: bool) -> None:
        task, self.turn = self.turn, None
        if task and not task.done():
            self.pipeline.interrupt(spoken)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.phase = "idle"

    async def _shutdown(self) -> None:
        await self._cancel_turn(spoken=False)
        for task in list(self.background):
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)
        try:
            await self.pipeline.close()
        except Exception:
            logger.exception("phone: closing the call failed")
