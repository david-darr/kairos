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

from core import phone_audio, voice_fillers, voice_style
from core.voice_backchannel import is_backchannel
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
    """What the voice reads: plain words, with markdown, links and code already turned into speech."""
    return voice_style.strip_for_speech(text)


class Pipeline:
    """What a call needs from the rest of Kairos. The live one is services/phone_calls.py's LivePipeline."""

    async def transcribe(self, pcm16: bytes) -> str: ...
    async def end_of_turn(self, pcm16: bytes) -> Optional[bool]:
        return None
    def converse(self, text: str, request_id: str) -> AsyncIterator[str]: ...
    async def announce(self, text: str, request_id: str) -> None: ...
    def speak(self, text: str) -> AsyncIterator[tuple[int, bytes]]: ...
    def interrupt(self, spoken: bool) -> None: ...
    def note_heard(self, sentences: list) -> None:
        """Before an interrupt(): the sentences the caller had begun to hear (so the history keeps only those)."""
    async def filler(self, user_text: str, last: Optional[str]):
        """An acknowledgement to play while the answer is written: (id, async iterator of (rate, pcm16)) or None."""
        return None
    def touch(self) -> None: ...
    async def close(self) -> None: ...


class TurnBridge:
    """The turn-taking both voice bridges share (a phone line here, a Discord voice channel in
    services/discord_voice.py): the endpointer's events become turns, a turn is transcribed, answered and spoken a
    sentence at a time, speech over a reply is a barge-in (long), a nod (short) or a real interjection (checked by
    transcribing it), and a quick acknowledgement plays if the answer is slow. A subclass says how audio leaves:
    `_new_converter` / `_converter_rate` (speech audio to its frames), `_emit` (one frame out), `_frame_seconds` and
    `_clear_output` (drop what is queued); `_turn_over` and `_speech_started` are hooks."""
    LABEL = "phone"
    REQUEST_PREFIX = "phone"

    def _init_turns(self, pipeline: Pipeline, *, opening: str, smart_turn: bool, pace: bool, clock, sleep) -> None:
        self.pipeline, self.opening = pipeline, opening
        self.pace, self.clock, self.sleep = pace, clock, sleep
        self.endpointer = Endpointer(smart=smart_turn)
        self.phase = "idle"                    # idle | thinking | speaking
        self.turn: Optional[asyncio.Task] = None
        self.background: set = set()
        self.play_end = 0.0
        self.backchannel = False
        self.during = False                    # the person started speaking while the bot was thinking or speaking
        self.played: list = []                 # (sentence, when it starts to play) of the reply being spoken
        self.last_filler: Optional[str] = None
        self.dropped_backchannels = 0
        self.sent_frames = 0
        self.heard: list[str] = []
        self.frames_in = 0

    # -- what a subclass provides ---------------------------------------------------------------------

    def _new_converter(self, rate: int):
        raise NotImplementedError

    def _converter_rate(self, converter) -> int:
        raise NotImplementedError

    async def _emit(self, frame) -> None:
        raise NotImplementedError

    def _frame_seconds(self, frame) -> float:
        raise NotImplementedError

    async def _clear_output(self) -> None:
        raise NotImplementedError

    def _turn_over(self) -> None:
        """A turn (or the opening) finished."""

    def _speech_started(self) -> None:
        """The endpointer heard speech begin."""

    # -- inbound ---------------------------------------------------------------------------------------

    async def _push(self, samples) -> None:
        await self._events(self.endpointer.push(samples))
        if self.phase == "speaking" and self.endpointer.active and self.endpointer.voiced_ms >= BARGE_VOICED_MS:
            await self._barge_in()

    async def _events(self, events: list) -> None:
        for event in events:
            if event[0] == "start":
                self._speech_started()
                self.backchannel = self.phase == "speaking"
                self.during = self.phase in ("speaking", "thinking")
            elif event[0] == "pause":
                self._spawn(self._ask(event[1], event[2]))
            elif event[0] == "segment":
                during, self.during = self.during, False
                if self.backchannel:
                    self.backchannel = False    # a short "mm-hm" over the bot's voice is not a turn
                    continue
                if during and self.turn and not self.turn.done():
                    # The bot is mid-reply: find out whether this is a real turn before cutting the reply off.
                    self._spawn(self._interject(event[1]))
                    continue
                await self._cancel_turn(spoken=False)
                self.turn = asyncio.create_task(self._respond(event[1], during))

    def _asked(self) -> bool:
        """Did the last thing the bot said end in a question? ("yeah" then answers it instead of nodding along.)"""
        return bool(self.played) and self.played[-1][0].rstrip().endswith("?")

    async def _interject(self, samples) -> None:
        """Speech over a reply that was too short to be a barge-in: a nod is ignored, anything else takes the turn."""
        try:
            text = (await self.pipeline.transcribe(phone_audio.float_to_pcm16(samples))).strip()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s: could not hear an interjection", self.LABEL)
            return
        if not text:
            return
        if is_backchannel(text, self._asked()):
            self.dropped_backchannels += 1
            return
        await self._cancel_turn(spoken=False)
        self.turn = asyncio.create_task(self._respond(samples, False, text))

    async def _ask(self, pause_id: int, samples) -> None:
        verdict = None
        try:
            verdict = await self.pipeline.end_of_turn(phone_audio.float_to_pcm16(samples))
        except Exception:
            logger.info("%s: Smart Turn unavailable for this pause", self.LABEL)
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
            logger.exception("%s: the opening line failed", self.LABEL)
        finally:
            self.phase = "idle"
            self._turn_over()

    @staticmethod
    async def _once(text: str):
        yield text

    async def _respond(self, samples, during: bool = False, text: Optional[str] = None) -> None:
        self.phase = "thinking"
        try:
            if text is None:
                text = (await self.pipeline.transcribe(phone_audio.float_to_pcm16(samples))).strip()
            if not text:
                return
            if during and is_backchannel(text, self._asked()):
                self.dropped_backchannels += 1     # said over the bot's voice: a nod, not a turn
                return
            self.played = []
            self.heard.append(text)
            request_id = self.REQUEST_PREFIX + ":" + uuid.uuid4().hex
            await self._say(self.pipeline.converse(text, request_id), filler_for=text)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s: a turn failed", self.LABEL)
        finally:
            self.phase = "idle"
            self._turn_over()

    def _converted(self, converter, rate: int):
        if converter is not None and self._converter_rate(converter) == rate:
            return converter
        return self._new_converter(rate)

    async def _say(self, deltas, filler_for: Optional[str] = None) -> None:
        """Speak a stream of text: each finished sentence is rendered while the one before it is still playing.
        With `filler_for` (what the person just said), a short acknowledgement plays if no sentence is ready within
        half a second; `self.played` records when each sentence starts so a barge-in knows what was heard."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        first_sentence = asyncio.Event()
        self.played = []

        async def render(number: int, sentence: str) -> None:
            converter = None
            async for rate, pcm in self.pipeline.speak(spoken_text(sentence)):
                converter = self._converted(converter, rate)
                frames = converter.frames(pcm)
                if frames:
                    await queue.put((number, sentence, frames))
            if converter:
                tail = converter.frames(b"", final=True)
                if tail:
                    await queue.put((number, sentence, tail))

        async def produce() -> None:
            buffer, count = "", 0
            try:
                async for delta in deltas:
                    buffer += delta
                    sentences, buffer = split_sentences(buffer)
                    for sentence in sentences:
                        count += 1
                        first_sentence.set()
                        await self._guarded(render, count, sentence)
                if buffer.strip():
                    first_sentence.set()
                    await self._guarded(render, count + 1, buffer)
            finally:
                first_sentence.set()
                await queue.put(None)

        async def filler() -> None:
            try:
                await asyncio.wait_for(first_sentence.wait(), voice_fillers.FILLER_AFTER_MS / 1000)
                return                            # the answer was quick: no acknowledgement
            except asyncio.TimeoutError:
                pass
            try:
                found = await self.pipeline.filler(filler_for, self.last_filler)
                if not found or first_sentence.is_set():
                    return
                ident, parts = found
                self.last_filler = ident
                converter = None
                async for rate, pcm in parts:
                    if first_sentence.is_set():
                        return                    # the answer got there first
                    converter = self._converted(converter, rate)
                    frames = converter.frames(pcm)
                    if frames:
                        await queue.put((0, voice_fillers.text_of(ident) or "", frames))
                tail = converter.frames(b"", final=True) if converter else None
                if tail and not first_sentence.is_set():
                    await queue.put((0, voice_fillers.text_of(ident) or "", tail))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.info("%s: no acknowledgement this time", self.LABEL)

        producer = asyncio.create_task(produce())
        helper = asyncio.create_task(filler()) if filler_for else None
        playing = None
        try:
            while (item := await queue.get()) is not None:
                number, sentence, frames = item
                self.phase = "speaking"
                if number != playing:
                    playing = number
                    if number:                    # an acknowledgement is not part of the reply that gets remembered
                        self.played.append((sentence, max(self.play_end, self.clock())))
                await self._send_frames(frames)
            await producer
            if self.pace and self.phase == "speaking":
                await self.sleep(max(0.0, self.play_end - self.clock()))
        finally:
            for task in (producer, helper):
                if task:
                    task.cancel()
            await asyncio.gather(producer, *([helper] if helper else []), return_exceptions=True)

    async def _guarded(self, render, number: int, sentence: str) -> None:
        try:
            await render(number, sentence)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("%s: a sentence could not be spoken", self.LABEL)

    async def _send_frames(self, frames: list) -> None:
        for frame in frames:
            now = self.clock()
            if self.pace and self.play_end - now > LEAD_SECONDS:
                await self.sleep(self.play_end - now - LEAD_SECONDS)
            await self._emit(frame)
            self.sent_frames += 1
            self.play_end = max(self.play_end, self.clock()) + self._frame_seconds(frame)

    # -- interruption and the end ------------------------------------------------------------------

    async def _barge_in(self) -> None:
        self.backchannel = False
        await self._cancel_turn(spoken=True)
        await self._clear_output()
        self.play_end = 0.0

    async def _cancel_turn(self, spoken: bool) -> None:
        task, self.turn = self.turn, None
        if task and not task.done():
            now = self.clock()
            self.pipeline.note_heard([sentence for sentence, starts in self.played if starts <= now])
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
            logger.exception("%s: closing the call failed", self.LABEL)


class PhoneBridge(TurnBridge):
    def __init__(self, provider: Provider, send: Callable, pipeline: Pipeline, *, stream_id: str = "", opening: str = "",
                 smart_turn: bool = False, pace: bool = True, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable = asyncio.sleep, max_seconds: float = MAX_CALL_SECONDS):
        self._init_turns(pipeline, opening=opening, smart_turn=smart_turn, pace=pace, clock=clock, sleep=sleep)
        self.provider, self.send_text, self.stream_id, self.max_seconds = provider, send, stream_id, max_seconds
        self.inbound = phone_audio.PhoneToSpeech()

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
        await self._push(phone_audio.pcm16_to_float(self.inbound.feed(mulaw)))

    # -- audio out -------------------------------------------------------------------------------

    def _new_converter(self, rate: int):
        return phone_audio.SpeechToPhone(rate)

    def _converter_rate(self, converter) -> int:
        return converter.resampler.source

    async def _emit(self, frame) -> None:
        await self.send_text(self.provider.media_frame(self.stream_id, frame))

    def _frame_seconds(self, frame) -> float:
        return len(frame) / phone_audio.PHONE_RATE

    async def _clear_output(self) -> None:
        await self.send_text(self.provider.clear_frame(self.stream_id))
