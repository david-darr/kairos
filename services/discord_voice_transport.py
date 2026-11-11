"""The real Discord voice connection for services/discord_voice.py.

Needs packages that discord.py does not bring by default (see core/discord_voice_audio.missing_requirements): PyNaCl and
davey for the encrypted connection, libopus, and discord-ext-voice-recv, because discord.py alone can only SEND voice.
Everything here is imported lazily, so the app starts without them; discord_voice refuses a call before it gets here
when any is missing. The fake-based tests cover the receive filter, the DAVE step and the restart; a real check is
scripts/discord_voice_probe.py, which David runs himself.

Receive (rebuilt 2026-11-11 after David's test, where Kip joined and never heard a word): Discord end-to-end encrypts
voice (DAVE). discord-ext-voice-recv 0.5.2a179 removes only the transport encryption, then handed the still-encrypted
frame to libopus, which raised "corrupted stream" on the first packet; that exception killed the extension's
packet-router thread, so nothing was received for the rest of the call. Now the sink asks for the raw frames
(`decode=False`, so the extension never runs Opus and cannot die on a bad frame), only the linked user's frames leave
the extension's thread, and the session opens each one (`decrypt`, DAVE through discord.py's own davey session) and
decodes it with its own decoder, dropping a bad packet instead of stopping. If receiving stops anyway, `receiving()`
restarts it a few times and reports when it cannot.

Send: 20 ms Opus packets are queued and the discord.py player thread sends them in real time (discord.py encrypts them
for DAVE itself); `clear()` drops what is queued (barge-in).
"""
import asyncio
import collections
import logging
import threading

from core import discord_voice_audio as audio

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 20.0
RESTARTS = 3                   # times receiving is restarted after it stopped by itself, per call


def _queue_source(queue: collections.deque, lock: threading.Lock):
    import discord

    class OpusQueueSource(discord.AudioSource):
        def is_opus(self) -> bool:
            return True

        def read(self) -> bytes:
            with lock:
                return queue.popleft() if queue else audio.OPUS_SILENCE

    return OpusQueueSource()


def _sink(callback):
    from discord.ext import voice_recv
    # decode=False: the extension hands over the frames as they arrive and never runs Opus itself (see the top).
    return voice_recv.BasicSink(callback, decode=False)


class RealTransport:
    SINK = staticmethod(_sink)

    def __init__(self, channel, linked_user: str, loop):
        self.channel, self.linked_user, self.loop = channel, str(linked_user), loop
        self.vc = None
        self.on_event = None
        self._queue: collections.deque = collections.deque()
        self._lock = threading.Lock()
        self.restarts = 0
        self.sink_errors = 0

    async def connect(self, on_event) -> None:
        from discord.ext import voice_recv
        self.on_event = on_event
        self.vc = await self.channel.connect(cls=voice_recv.VoiceRecvClient, timeout=CONNECT_TIMEOUT, reconnect=False)
        self.vc.listen(self.SINK(self._on_voice))
        self.vc.play(_queue_source(self._queue, self._lock))

    # -- receive -----------------------------------------------------------------------------------

    def _user_id(self, user, data) -> str:
        """Who sent this frame. The extension passes the member when it has one cached; when it does not (no members
        intent), the stream's id is looked up directly. Frames from a stream Discord has not yet said is whose stay
        unknown and are dropped, never held."""
        if user is not None and getattr(user, "id", None) is not None:
            return str(user.id)
        ssrc = getattr(getattr(data, "packet", None), "ssrc", None)
        lookup = getattr(self.vc, "_get_id_from_ssrc", None)
        if ssrc is None or lookup is None:
            return ""
        found = lookup(ssrc)
        return str(found) if found is not None else ""

    def _on_voice(self, user, data) -> None:
        # The extension's thread: an exception here would stop its router, so nothing may escape.
        try:
            if self._user_id(user, data) != self.linked_user:
                return                         # anyone but the linked person: dropped before anything else happens
            frame = getattr(data, "opus", None)
            if frame:
                self.on_event(("opus", self.linked_user, bytes(frame)))
                return
            pcm = getattr(data, "pcm", None)   # a sink that decodes (not used now): already PCM
            if pcm:
                self.on_event(("audio", self.linked_user, bytes(pcm)))
        except Exception:
            self.sink_errors += 1
            if self.sink_errors == 1:
                logger.exception("discord voice: a received frame could not be passed on (later ones still are)")

    def decrypt(self, user_id: str, frame: bytes) -> bytes:
        """Open one received frame. DAVE-encrypted -> Opus through discord.py's davey session; a plain frame (silence,
        passthrough while the call's encryption changes, a channel without DAVE) comes back as it is. Raises
        audio.Undecryptable when the frame is encrypted and cannot be opened. Runs on the event loop."""
        if frame == audio.OPUS_SILENCE:
            return frame
        encrypted = audio.is_dave_frame(frame)
        state = getattr(self.vc, "_connection", None)
        session = getattr(state, "dave_session", None)
        if session is not None and getattr(state, "dave_protocol_version", 0):
            try:
                import davey
                return bytes(session.decrypt(int(user_id), davey.MediaType.audio, frame))
            except Exception as error:
                if not encrypted:
                    return frame
                raise audio.Undecryptable(f"DAVE could not open it ({type(error).__name__}: {error})") from None
        if encrypted:
            raise audio.Undecryptable("it is end-to-end encrypted (DAVE) and there is no DAVE session")
        return frame

    def receiving(self) -> bool:
        """Is audio still being received? When the extension stopped listening by itself, restart it (RESTARTS times)."""
        vc = self.vc
        if vc is None:
            return False
        if vc.is_listening():
            return True
        if not vc.is_connected() or self.restarts >= RESTARTS:
            return False
        self.restarts += 1
        logger.warning("discord voice: receiving stopped by itself; restarting it (%d of %d)", self.restarts, RESTARTS)
        try:
            vc.listen(self.SINK(self._on_voice))
        except Exception:
            logger.exception("discord voice: receiving could not be restarted")
            return False
        return bool(vc.is_listening())

    def status(self) -> dict:
        """For the log: end-to-end encryption on the connection, and whether receiving is on."""
        vc = self.vc
        state = getattr(vc, "_connection", None)
        session = getattr(state, "dave_session", None)
        try:
            listening = bool(vc and vc.is_listening())
        except Exception:
            listening = False
        return {"dave_version": getattr(state, "dave_protocol_version", 0), "dave_session": session is not None,
                "dave_ready": bool(getattr(session, "ready", False)),
                "can_encrypt": bool(getattr(state, "can_encrypt", False)), "listening": listening,
                "restarts": self.restarts}

    def joined(self) -> None:
        """The person is in the channel and the greeting is about to play: log the connection's state, and tell Discord
        again that the bot is speaking (the player said so once, before they were there)."""
        logger.info("discord voice: the person is here; connection %s", self.status())
        try:
            from discord import SpeakingState
            asyncio.ensure_future(self.vc.ws.speak(SpeakingState.voice))
        except Exception:
            logger.debug("discord voice: could not resend the speaking state", exc_info=True)

    # -- the rest ----------------------------------------------------------------------------------

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
