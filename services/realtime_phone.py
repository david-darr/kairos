"""A phone call in realtime mode (build spec 6b): the provider's 8 kHz mu-law media stream bridged to a realtime
speech-to-speech session instead of the local cascade.

Inbound mu-law is decoded and resampled to 16 kHz for the session (which resamples again to the provider's own rate);
the model's audio comes back at its rate and is resampled to 8 kHz mu-law in 20 ms frames, queued, and paced out so a
barge-in has only about two seconds to clear. The provider's own voice activity detection decides when the caller
interrupts: on `speech_started` the queue is dropped, the phone provider's buffer is cleared, and the session is told
how much of the reply was actually played (frames sent, never more than the clock allows), which it truncates at the
provider and in the transcript. The same Pipeline-less shape as services/phone_bridge.py: tests drive it with a fake
media stream and a mock realtime server.
"""
import asyncio
import logging
import time
from typing import Callable, Optional

from core import phone_audio
from core.phone_providers import Provider
from services import phone_bridge
from services.realtime_session import RealtimeSession

logger = logging.getLogger(__name__)

FRAME_SECONDS = phone_audio.FRAME_BYTES / phone_audio.PHONE_RATE


class RealtimePhoneBridge:
    def __init__(self, provider: Provider, send: Callable, call: dict, endpoint_id: str, voice: str, *, stream_id: str = "",
                 opening: str = "", pace: bool = True, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable = asyncio.sleep, max_seconds: float = phone_bridge.MAX_CALL_SECONDS,
                 truncate_grace: float = 0.3):
        self.provider, self.send_text, self.call = provider, send, call
        self.stream_id, self.opening, self.pace = stream_id, opening, pace
        self.clock, self.sleep, self.max_seconds = clock, sleep, max_seconds
        self.inbound = phone_audio.PhoneToSpeech()
        self.outbound: Optional[phone_audio.SpeechToPhone] = None
        self.queue: asyncio.Queue = asyncio.Queue()
        self.session = RealtimeSession(call, endpoint_id, voice, self._sink, clock=clock, truncate_grace=truncate_grace)
        self.play_end = 0.0
        self.sent_frames = 0
        self.cleared = 0
        self.sent_item: Optional[str] = None       # the reply being played and how much of it has gone out
        self.item_first = 0.0
        self.item_ms = 0.0
        self.sender: Optional[asyncio.Task] = None
        self.ended = asyncio.Event()

    # -- the session's events ---------------------------------------------------------------------------------

    async def _sink(self, event: dict) -> None:
        kind = event["type"]
        if kind == "audio":
            await self._audio(event)
        elif kind == "speech_started":
            await self._barge_in(event)
        elif kind in ("error", "ended"):
            if kind == "ended":
                self.ended.set()

    async def _audio(self, event: dict) -> None:
        import base64
        rate = int(event["rate"])
        if self.outbound is None or self.outbound.resampler.source != rate:
            self.outbound = phone_audio.SpeechToPhone(rate)
        frames = self.outbound.frames(base64.b64decode(event["data"]))
        if frames:
            self.queue.put_nowait((event.get("item_id"), frames))

    async def _barge_in(self, event: dict) -> None:
        """The caller talked over the bot: drop what is queued, clear the provider's buffer, report what was heard."""
        dropped = 0
        while not self.queue.empty():
            dropped += len(self.queue.get_nowait()[1])
        self.outbound = None
        item = event.get("item_id") or self.sent_item
        played = 0.0
        if self.sent_item is not None:
            played = min(self.item_ms, max(0.0, (self.clock() - self.item_first) * 1000))
        self.sent_item = None
        self.item_ms = 0.0
        await self.send_text(self.provider.clear_frame(self.stream_id))
        self.cleared += 1
        self.play_end = 0.0
        await self.session.played(item, played if self.sent_frames else 0)

    async def _send_loop(self) -> None:
        while True:
            item_id, frames = await self.queue.get()
            for frame in frames:
                now = self.clock()
                if self.pace and self.play_end - now > phone_bridge.LEAD_SECONDS:
                    await self.sleep(self.play_end - now - phone_bridge.LEAD_SECONDS)
                if item_id != self.sent_item:
                    self.sent_item, self.item_first, self.item_ms = item_id, self.clock(), 0.0
                await self.send_text(self.provider.media_frame(self.stream_id, frame))
                self.sent_frames += 1
                self.item_ms += FRAME_SECONDS * 1000
                self.play_end = max(self.play_end, self.clock()) + FRAME_SECONDS

    # -- the media loop ---------------------------------------------------------------------------------------

    async def run(self, recv: Callable) -> None:
        started = self.clock()
        try:
            await self.session.start()
            self.sender = asyncio.create_task(self._send_loop())
            if self.opening:
                await self.session.push_text(f"The call just connected. Say this opening line to the caller now, word for word, "
                                             f"then wait for them: {self.opening}")
            while self.clock() - started < self.max_seconds and not self.ended.is_set():
                raw = await recv()
                if raw is None:
                    break
                kind, data = self.provider.parse_stream(raw)
                if kind == "start" and data.get("stream_id"):
                    self.stream_id = data["stream_id"]
                elif kind == "media":
                    await self.session.send_audio(self.inbound.feed(data), phone_audio.SPEECH_RATE)
                elif kind == "stop":
                    break
        finally:
            if self.sender:
                self.sender.cancel()
                await asyncio.gather(self.sender, return_exceptions=True)
            await self.session.close()
