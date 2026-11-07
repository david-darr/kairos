"""The real Discord voice connection for services/discord_voice.py.

Needs packages that discord.py does not bring by default (see core/discord_voice_audio.missing_requirements): PyNaCl and
davey for the encrypted connection, libopus, and discord-ext-voice-recv, because discord.py alone can only SEND voice.
Everything here is imported lazily, so the app starts without them; discord_voice refuses a call before it gets here
when any is missing. Not exercised by the fake-based tests: it needs a real Discord test (see the build report).

Receive: the extension decodes each speaker's Opus to 48 kHz stereo PCM16 and calls our sink from its own thread; only the
linked user's audio is forwarded to the session (others are dropped right here). Send: 20 ms Opus packets are queued and
the discord.py player thread sends them in real time; `clear()` drops what is queued (barge-in).
"""
import collections
import logging
import threading

from core import discord_voice_audio as audio

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 20.0


def _queue_source(queue: collections.deque, lock: threading.Lock):
    import discord

    class OpusQueueSource(discord.AudioSource):
        def is_opus(self) -> bool:
            return True

        def read(self) -> bytes:
            with lock:
                return queue.popleft() if queue else audio.OPUS_SILENCE

    return OpusQueueSource()


class RealTransport:
    def __init__(self, channel, linked_user: str, loop):
        self.channel, self.linked_user, self.loop = channel, str(linked_user), loop
        self.vc = None
        self.on_event = None
        self._queue: collections.deque = collections.deque()
        self._lock = threading.Lock()

    async def connect(self, on_event) -> None:
        from discord.ext import voice_recv
        self.on_event = on_event
        self.vc = await self.channel.connect(cls=voice_recv.VoiceRecvClient, timeout=CONNECT_TIMEOUT, reconnect=False)
        self.vc.listen(voice_recv.BasicSink(self._on_voice))
        self.vc.play(_queue_source(self._queue, self._lock))

    def _on_voice(self, user, data) -> None:
        # The extension's thread. Anyone but the linked person is dropped before anything else happens.
        if user is None or str(getattr(user, "id", "")) != self.linked_user:
            return
        pcm = getattr(data, "pcm", None)
        if pcm:
            self.on_event(("audio", str(user.id), bytes(pcm)))

    def members(self) -> set:
        return {str(member.id) for member in getattr(self.channel, "members", [])}

    def send(self, packet: bytes) -> None:
        with self._lock:
            self._queue.append(packet)

    def clear(self) -> None:
        with self._lock:
            self._queue.clear()

    async def disconnect(self) -> None:
        vc, self.vc = self.vc, None
        if vc is None:
            return
        try:
            vc.stop_listening()
        except Exception:
            logger.debug("discord voice: stop_listening failed", exc_info=True)
        await vc.disconnect(force=True)
