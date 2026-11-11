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

from core import phone_audio, voice_style
from core.voice_backchannel import is_backchannel
from core.phone_providers import Provider

logger = logging.getLogger(__name__)

SENTENCE = re.compile(r"(?<=[.!?])\s+")
LEAD_SECONDS = 2.0            # how far ahead of playback frames are sent (what a barge-in has to clear)
BARGE_VOICED_MS = 400         # speech this long over the bot's voice is an interruption; shorter is a backchannel
MAX_CALL_SECONDS = 30 * 60
STALL_FLUSH_SECONDS = 0.1     # a finished sentence with no more text after it this long is spoken (callVoice.js: 100 ms)
RENDER_AHEAD = 2              # sentences rendered while the one before them plays (callVoice.js prefetches the same way)


class Endpointer:
    """Speech turns from 16 kHz float audio. Energy based, all timing from sample counts.

    push() returns events: ('start',), ('pause', id, samples) when Smart Turn should be asked, ('segment', samples,
    quiet_ms) with how long the person had been quiet when the turn was ended (the endpoint wait).
    With Smart Turn on, a verdict of complete ends the turn after the 200 ms pause; incomplete waits up to `cap_ms` of
    quiet; no verdict falls back to the ordinary silence wait. Smart Turn hears the last `window_ms` up to the end of the
    voice plus the trailing keep. This mirrors static/js/speechSegments.js (the app call's endpointer), number for number.
    """
    HOP = 320                  # 20 ms at 16 kHz

    def __init__(self, rate: int = 16000, pre_roll_ms: int = 400, silence_ms: int = 700, smart: bool = False,
                 cap_ms: int = 2500, pause_ms: int = 200, onset_ms: int = 60, min_voiced_ms: int = 120,
                 max_ms: int = 30000, trailing_ms: int = 160, window_ms: int = 8000):
        self.rate, self.smart = rate, smart
        ms = lambda value: int(rate * value / 1000)   # noqa: E731
        self.pre_roll, self.silence, self.cap, self.pause = ms(pre_roll_ms), ms(silence_ms), ms(cap_ms), ms(pause_ms)
        self.onset, self.min_voiced, self.max, self.trailing = ms(onset_ms), ms(min_voiced_ms), ms(max_ms), ms(trailing_ms)
        self.window = ms(window_ms)
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
            events.append(("pause", self.pause_id, self._heard()[-self.window:]))
        return events + self._decide()

    def _heard(self):
        """The utterance so far, cut `trailing` after the last voiced audio."""
        audio = np.concatenate(self.parts)
        if self.quiet > self.trailing:
            audio = audio[: len(audio) - (self.quiet - self.trailing)]
        return audio

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
        voiced, quiet = self.voiced, self.quiet
        audio = self._heard() if voiced >= self.min_voiced else None
        self._reset()
        if audio is None:
            return []
        return [("segment", audio, round(quiet * 1000 / self.rate))]


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


# The app call's sentence rule (static/js/voiceOutput.js createChunker), so a phone or Discord call starts speaking as
# soon as an app call would: a boundary only where the next thing starts a sentence, no split after an abbreviation, the
# first sentence alone (however short), or at a clause break once it has FIRST_CLAUSE_WORDS words.
SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")
ABBREVIATION = re.compile(
    r"(?:\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Ave|Blvd|Dept|Gen|Col|Lt|Sgt|Capt|Rep|Sen|Gov|Hon|Rev|vs|Inc|Ltd|Co|Corp|"
    r"Fig|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)|\b(?!I\.)[A-Z]|\b[A-Za-z]\.[A-Za-z]|\be\.g|\bi\.e)\.$")
CLAUSE_BREAK = re.compile(r"[,;](?=\s)|\s+-{1,2}\s+|\s*[—–]\s*")
FIRST_CLAUSE_WORDS = 6
FINISHED = re.compile(r"[.!?][\"')\]]?\s*$")


class SentenceChunker:
    """Streamed text -> sentences to speak, the moment each is complete (see SENTENCE_END above)."""

    def __init__(self):
        self.buffer, self.started = "", False

    @staticmethod
    def _sentence_end(text: str):
        for match in SENTENCE_END.finditer(text):
            if not ABBREVIATION.search(text[:match.start()]):
                return match
        return None

    @staticmethod
    def _clause_end(text: str):
        for match in CLAUSE_BREAK.finditer(text):
            head = text[: match.start() + (1 if match.group(0)[:1] in ",;" else 0)].strip()
            if len(head.split()) >= FIRST_CLAUSE_WORDS:
                return head, match.end()
        return None

    def _emit(self, out: list, sentence: str) -> None:
        if sentence:
            self.started = True
            out.append(sentence)

    def feed(self, text: str) -> list:
        self.buffer += text
        out: list = []
        while True:
            match = self._sentence_end(self.buffer)
            clause = None if self.started else self._clause_end(self.buffer)
            if clause and (match is None or clause[1] <= match.start() + 1):
                self.buffer = self.buffer[clause[1]:]
                self._emit(out, clause[0])
                continue
            if match is None:
                return out
            sentence = self.buffer[: match.start() + 1].strip()
            self.buffer = self.buffer[match.end():]
            self._emit(out, sentence)

    def holds_sentence(self) -> bool:
        """The text so far ends a sentence, but the next token could still change that ("3." may be "3.5")."""
        tail = self.buffer
        return bool(FINISHED.search(tail)) and not ABBREVIATION.search(tail.rstrip()) and not re.search(r"\d\.\s*$", tail)

    def flush_sentence(self) -> list:
        """No more text came for a moment: a finished sentence goes now instead of waiting for the next one."""
        if not self.holds_sentence():
            return []
        out: list = []
        sentence, self.buffer = self.buffer.strip(), ""
        self._emit(out, sentence)
        return out

    def finish(self) -> list:
        out: list = []
        leftover, self.buffer = self.buffer.strip(), ""
        self._emit(out, leftover)
        return out


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
    def touch(self) -> None: ...
    async def close(self) -> None: ...
    def record_latency(self, gap_ms=None, first_audio_ms=None) -> None:
        """How long after the person stopped the bot's voice began (each turn), and the call's first audio."""
    def on_typed(self, callback) -> None:
        """Texts the person types during the call reach `callback(text)` (agent_calls.text_into_call)."""
    def end_requested(self) -> bool:
        """The bot asked to end the call (an ask answered), past the hang-up guard (agent_calls.request_end)."""
        return False
    async def warm(self) -> Optional[dict]:
        """Load what the first turn would otherwise wait for (the conversation model, speech-to-text, Smart Turn, the
        voice), as an app call does when it starts. Returns what was warmed and how long it took, in ms."""
        return None


class TurnBridge:
    """The turn-taking both voice bridges share (a phone line here, a Discord voice channel in
    services/discord_voice.py): the endpointer's events become turns, a turn is transcribed, answered and spoken a
    sentence at a time, speech over a reply is a barge-in (long), a nod (short) or a real interjection (checked by
    transcribing it). Nothing is said while the answer is being written: the line stays quiet until its first
    sentence (no filler). A subclass says how audio leaves: `_new_converter` / `_converter_rate` (speech audio to its
    frames), `_emit` (one frame out), `_frame_seconds` and `_clear_output` (drop what is queued); `_turn_over` and
    `_speech_started` are hooks."""
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
        self.dropped_backchannels = 0
        self.sent_frames = 0
        self.heard: list[str] = []
        self.frames_in = 0
        # Latency (Hermes audit): when the person last stopped, waiting for the bot's first frame; the call's start.
        # The gap is measured from the end of their speech (the endpoint wait included), as the app call measures it.
        self.call_started = clock()
        self.awaiting_since: Optional[float] = None
        self.segment_at: Optional[float] = None
        self.speech_end_at: Optional[float] = None
        self.first_audio_done = False
        self.timing: Optional[dict] = None     # the current turn's stages, logged once its first frame is out
        self.turn_count = 0
        self.typed_waiting: list[str] = []
        try:
            pipeline.on_typed(self.typed)
        except Exception:
            logger.info("%s: typed texts will not reach this call", self.LABEL)

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
                self.segment_at = self.clock()
                quiet_ms = event[2] if len(event) > 2 else 0
                self.speech_end_at = self.segment_at - quiet_ms / 1000
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
            await self._speak_opening()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s: the opening line failed", self.LABEL)
        finally:
            self.phase = "idle"
            self._turn_over()
            self._next_typed()

    async def _speak_opening(self) -> None:
        """Say the opening line (a subclass may have it rendered ahead of time)."""
        await self._say(self._once(self.opening))

    # -- text typed during the call -------------------------------------------------------------

    @property
    def end_requested(self) -> bool:
        """Pipeline.end_requested(); a pipeline that keeps its own end flag (outbound calls) is left to its own flow."""
        check = getattr(self.pipeline, "end_requested", None)
        if not callable(check):
            return False
        try:
            return bool(check())
        except Exception:
            return False

    def typed(self, text: str) -> None:
        """The person typed this in the bot's chat during the call: it is answered as their next turn (Hermes audit)."""
        if not str(text or "").strip():
            return
        self.typed_waiting.append(str(text))
        self._next_typed()

    def _next_typed(self) -> None:
        busy = self.turn is not None and not self.turn.done() and self.turn is not asyncio.current_task()
        if not self.typed_waiting or self.phase != "idle" or busy or self.endpointer.active:
            return
        text = self.typed_waiting.pop(0)
        self.turn = asyncio.ensure_future(self._respond(None, False, text, measure=False))

    @staticmethod
    async def _once(text: str):
        yield text

    async def _respond(self, samples, during: bool = False, text: Optional[str] = None, measure: bool = True) -> None:
        self.phase = "thinking"
        started = None
        if measure:
            ended = self.speech_end_at if self.speech_end_at is not None else self.segment_at
            started = ended if ended is not None else self.clock()
        timing = {"speech_end": started, "decided": self.segment_at if self.segment_at is not None else started} \
            if measure else None
        self.segment_at = self.speech_end_at = None
        self.awaiting_since = started
        self.timing = timing
        try:
            if text is None:
                began = self.clock()
                text = (await self.pipeline.transcribe(phone_audio.float_to_pcm16(samples))).strip()
                if timing is not None:
                    timing["stt"] = self.clock() - began
            if not text:
                return
            if during and is_backchannel(text, self._asked()):
                self.dropped_backchannels += 1     # said over the bot's voice: a nod, not a turn
                return
            self.played = []
            self.heard.append(text)
            request_id = self.REQUEST_PREFIX + ":" + uuid.uuid4().hex
            if timing is not None:
                timing["converse"] = self.clock()
            await self._say(self.pipeline.converse(text, request_id), timing)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s: a turn failed", self.LABEL)
        finally:
            self.phase = "idle"
            if self.awaiting_since is not None and self.awaiting_since == started:
                self.awaiting_since = None        # no audio came of it: nothing to measure
            if self.timing is timing:
                self.timing = None
            self._turn_over()
            self._next_typed()

    def _converted(self, converter, rate: int):
        if converter is not None and self._converter_rate(converter) == rate:
            return converter
        return self._new_converter(rate)

    async def _say(self, deltas, timing: Optional[dict] = None) -> None:
        """Speak a stream of text as an app call does: each sentence goes to the voice the moment it is complete (the
        first one alone, or at a clause break; a finished sentence with no text after it for STALL_FLUSH_SECONDS goes
        too), up to RENDER_AHEAD sentences render while the one before them plays, and frames go out as each piece of
        audio comes. Three stages run apart, so the model is never held up by the voice and the voice never by
        playback. Nothing plays before the first sentence (no filler); `self.played` records when each sentence starts
        so a barge-in knows what was heard. `timing` (a measured turn) gets each stage's time."""
        texts: asyncio.Queue = asyncio.Queue()       # model text as it streams
        sentences: asyncio.Queue = asyncio.Queue()   # (number, sentence) ready to speak
        audio: asyncio.Queue = asyncio.Queue()       # (number, sentence, frames) ready to send; None ends it
        ahead = asyncio.Semaphore(RENDER_AHEAD + 1)  # the sentence playing, and the ones rendered after it
        holding: set = set()                         # sentences holding a place in `ahead`
        self.played = []

        def mark(name: str) -> None:
            if timing is not None and name not in timing:
                timing[name] = self.clock()

        async def pump() -> None:
            try:
                async for delta in deltas:
                    if delta:
                        mark("first_output")
                        texts.put_nowait(delta)
            finally:
                texts.put_nowait(None)

        async def chunk() -> None:
            chunker, count = SentenceChunker(), 0
            try:
                while True:
                    try:
                        delta = await (asyncio.wait_for(texts.get(), STALL_FLUSH_SECONDS) if chunker.holds_sentence()
                                       else texts.get())
                    except asyncio.TimeoutError:
                        delta = ""
                    if delta is None:
                        found = chunker.finish()
                    elif delta:
                        found = chunker.feed(delta)
                    else:
                        found = chunker.flush_sentence()     # the model paused after a full stop
                    for sentence in found:
                        count += 1
                        mark("first_sentence")
                        sentences.put_nowait((count, sentence))
                    if delta is None:
                        return
            finally:
                sentences.put_nowait(None)

        async def render_one(number: int, sentence: str) -> bool:
            converter, sent = None, False
            if number == 1:
                mark("tts_start")
            async for rate, pcm in self.pipeline.speak(spoken_text(sentence)):
                if number == 1:
                    mark("tts_audio")
                converter = self._converted(converter, rate)
                frames = converter.frames(pcm)
                if frames:
                    sent = True
                    audio.put_nowait((number, sentence, frames))
            if converter:
                tail = converter.frames(b"", final=True)
                if tail:
                    sent = True
                    audio.put_nowait((number, sentence, tail))
            return sent

        async def render() -> None:
            try:
                while (item := await sentences.get()) is not None:
                    number, sentence = item
                    await ahead.acquire()
                    holding.add(number)
                    if not await self._guarded(render_one, number, sentence):
                        holding.discard(number)      # nothing to play: its place goes to the next sentence
                        ahead.release()
            finally:
                audio.put_nowait(None)

        stages = [asyncio.create_task(stage()) for stage in (pump, chunk, render)]
        playing = None
        try:
            while (item := await audio.get()) is not None:
                number, sentence, frames = item
                self.phase = "speaking"
                if number != playing:
                    playing = number
                    for done in [n for n in holding if n < number]:
                        holding.discard(done)        # played: the voice may render one more ahead
                        ahead.release()
                    self.played.append((sentence, max(self.play_end, self.clock())))
                await self._send_frames(frames)
            await asyncio.gather(*stages)            # a model failure surfaces here, as before
            if self.pace and self.phase == "speaking":
                await self.sleep(max(0.0, self.play_end - self.clock()))
        finally:
            # Every stage ends with put_nowait, never a wait, so cancelling here cannot hang (2026-11-11: a barge-in
            # over a long reply waited forever on a full queue and froze the call).
            for stage in stages:
                stage.cancel()
            await asyncio.gather(*stages, return_exceptions=True)

    async def _guarded(self, render, number: int, sentence: str):
        try:
            return await render(number, sentence)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("%s: a sentence could not be spoken", self.LABEL)
            return None

    def _first_frame(self) -> None:
        now = self.clock()
        try:
            if not self.first_audio_done:
                self.first_audio_done = True
                self.pipeline.record_latency(first_audio_ms=round((now - self.call_started) * 1000))
            if self.awaiting_since is not None:
                gap, self.awaiting_since = now - self.awaiting_since, None
                self.pipeline.record_latency(gap_ms=round(gap * 1000))
        except Exception:
            logger.info("%s: latency not recorded", self.LABEL)
        timing, self.timing = self.timing, None
        if timing is not None and timing.get("speech_end") is not None:
            timing["first_frame"] = now
            self._log_timing(timing)

    def _log_timing(self, timing: dict) -> None:
        """One line per measured turn, the stages the app call reports (call audio timing, speech timing):
        endpoint_ms   the person stopped -> the turn was ended (silence wait, or Smart Turn's pause and verdict)
        stt_ms        speech-to-text
        first_output_ms  the model asked -> its first text
        first_sentence_ms  the model asked -> the first sentence ready for the voice
        tts_first_audio_ms  the first sentence to the voice -> its first audio
        send_ms       that audio -> the first frame out (resampled, encoded, queued)
        speech_end_to_audio_ms  the person stopped -> the bot's first frame out"""
        def ms(later: str, earlier: str):
            a, b = timing.get(later), timing.get(earlier)
            return round((a - b) * 1000) if a is not None and b is not None else None
        self.turn_count += 1
        stt = round(timing["stt"] * 1000) if timing.get("stt") is not None else None
        logger.info("%s timing turn=%d endpoint_ms=%s stt_ms=%s first_output_ms=%s first_sentence_ms=%s "
                    "tts_first_audio_ms=%s send_ms=%s speech_end_to_audio_ms=%s", self.LABEL, self.turn_count,
                    ms("decided", "speech_end"), stt, ms("first_output", "converse"), ms("first_sentence", "converse"),
                    ms("tts_audio", "tts_start"), ms("first_frame", "tts_audio"), ms("first_frame", "speech_end"))

    async def _send_frames(self, frames: list) -> None:
        if frames and (self.awaiting_since is not None or not self.first_audio_done):
            self._first_frame()
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
                if self.end_requested and self.phase == "idle" and (self.turn is None or self.turn.done()):
                    break           # asked and answered: the goodbye has played, the call ends
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
