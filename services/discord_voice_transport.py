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
import struct
import threading

from core import discord_voice_audio as audio

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 20.0
RESTARTS = 3                   # times receiving is restarted after it stopped by itself, per call

# -- DAVE key changes (David's re-test, 2026-11-11 17:28) ------------------------------------------------------
# discord.py 2.7.1 was written against davey 0.1 (its requirement is "davey>=0.1.0"), where processing an MLS commit or
# welcome switched the keys at once. davey 0.2.0, the version installed, added prepare_transition / execute_transition
# and only "starts using the new keys" once they are called; discord.py never calls them (its own _execute_transition
# says "in the future, the session should be signaled too"). So the session never became ready: the bot could not
# open the person's audio (NoDecryptorForUser) and could not encrypt its own (can_encrypt False), so neither side
# heard the other. discord-ext-voice-recv is not the cause: its gateway hook runs after discord.py has handled each
# JSON message, and binary (MLS) frames never reach it.
# The fix, below: the same voice websocket and connection state, with the two davey 0.2 calls added where the DAVE
# protocol puts them (prepare after a commit, welcome or prepare-transition; execute on execute-transition, or at once
# for transition 0). With davey 0.1 (no such methods) they are skipped, and discord.py behaves exactly as before.
OP_PREPARE_TRANSITION, OP_EXECUTE_TRANSITION, OP_PREPARE_EPOCH = 21, 22, 24
OP_EXTERNAL_SENDER, OP_PROPOSALS, OP_COMMIT_TRANSITION, OP_WELCOME = 25, 27, 29, 30
DAVE_OP_NAMES = {21: "prepare transition", 22: "execute transition", 24: "prepare epoch", 25: "external sender",
                 27: "proposals", 29: "commit", 30: "welcome"}
dave_logger = logging.getLogger(__name__ + ".dave")


def _status(session) -> str:
    if session is None:
        return "no session"
    status = getattr(getattr(session, "status", None), "name", getattr(session, "status", "?"))
    return f"status={status} ready={bool(getattr(session, 'ready', False))} can_encrypt={bool(getattr(session, 'can_encrypt', False))}"


def dave_prepare(state, transition_id: int, protocol_version: int) -> None:
    """davey 0.2: get ready to switch to the keys of `transition_id` (once per transition)."""
    session = getattr(state, "dave_session", None)
    prepare = getattr(session, "prepare_transition", None)
    prepared = state.__dict__.setdefault("kairos_prepared", set())
    if prepare is None or transition_id in prepared:
        return
    try:
        prepare(int(transition_id), int(protocol_version))
        prepared.add(transition_id)
    except Exception as error:
        dave_logger.warning("discord voice DAVE: prepare transition %s failed: %s: %s", transition_id, type(error).__name__, error)


def dave_execute(state, transition_id: int) -> None:
    """davey 0.2: switch to the keys of `transition_id`."""
    session = getattr(state, "dave_session", None)
    execute = getattr(session, "execute_transition", None)
    state.__dict__.setdefault("kairos_prepared", set()).discard(transition_id)
    if execute is None:
        return
    try:
        executed = execute(int(transition_id))
        dave_logger.info("discord voice DAVE: transition %s executed (%s); %s", transition_id, executed, _status(session))
    except Exception as error:
        dave_logger.warning("discord voice DAVE: execute transition %s failed: %s: %s", transition_id, type(error).__name__, error)


def dave_classes():
    """The voice client class to connect with: discord-ext-voice-recv's, on a websocket and connection state that
    finish DAVE key changes with davey 0.2 (see above). Built lazily: discord.py and the extension may be missing."""
    from discord.gateway import DiscordVoiceWebSocket
    from discord.voice_state import VoiceConnectionState
    from discord.ext import voice_recv
    from discord.ext.voice_recv.gateway import hook as recv_hook

    class KairosVoiceWebSocket(DiscordVoiceWebSocket):
        async def received_message(self, msg) -> None:
            op, data = msg.get("op"), msg.get("d") or {}
            state = self._connection
            if op in DAVE_OP_NAMES:
                dave_logger.info("discord voice DAVE: %s %s", DAVE_OP_NAMES[op], data)
            if op == OP_PREPARE_TRANSITION and getattr(state, "dave_session", None) is not None:
                # Before discord.py's own handling, which executes transition 0 at once.
                dave_prepare(state, data.get("transition_id", 0), data.get("protocol_version", 0))
            await super().received_message(msg)

        async def received_binary_message(self, msg: bytes) -> None:
            op = msg[2] if len(msg) > 2 else None
            state = self._connection
            session = getattr(state, "dave_session", None)
            if op in DAVE_OP_NAMES:
                dave_logger.info("discord voice DAVE: %s (%d bytes)", DAVE_OP_NAMES[op], len(msg))
            if session is None or op not in (OP_COMMIT_TRANSITION, OP_WELCOME):
                await super().received_binary_message(msg)
                return
            # discord.py's own handling of a commit or welcome (gateway.py, 2.7.1), plus davey 0.2's prepare/execute.
            self.seq_ack = struct.unpack_from(">H", msg, 0)[0]
            transition_id = struct.unpack_from(">H", msg, 3)[0]
            try:
                if op == OP_COMMIT_TRANSITION:
                    should_prepare = session.process_commit(msg[5:])
                else:
                    should_prepare = session.process_welcome(msg[5:])
            except Exception as error:
                dave_logger.warning("discord voice DAVE: %s for transition %s was refused (%s: %s); rejoining",
                                    DAVE_OP_NAMES[op], transition_id, type(error).__name__, error)
                await state._recover_from_invalid_commit(transition_id)
                return
            if should_prepare is not False:
                dave_prepare(state, transition_id, state.dave_protocol_version)
            if transition_id != 0:
                state.dave_pending_transitions[transition_id] = state.dave_protocol_version
                await self.send_transition_ready(transition_id)
            else:
                dave_execute(state, 0)
            dave_logger.info("discord voice DAVE: %s processed for transition %s; %s", DAVE_OP_NAMES[op],
                             transition_id, _status(session))

    class KairosConnectionState(VoiceConnectionState):
        async def _connect_websocket(self, resume: bool):
            # discord.py's own (voice_state.py, 2.7.1), with the websocket above.
            from discord.voice_state import ConnectionFlowState
            seq_ack = getattr(self.ws, "seq_ack", -1)
            ws = await KairosVoiceWebSocket.from_connection_state(self, resume=resume, hook=self.hook, seq_ack=seq_ack)
            self.state = ConnectionFlowState.websocket_connected
            return ws

        async def reinit_dave_session(self) -> None:
            self.__dict__.setdefault("kairos_prepared", set()).clear()
            await super().reinit_dave_session()
            dave_logger.info("discord voice DAVE: session (re)started, protocol %s; %s", self.dave_protocol_version,
                             _status(self.dave_session))

        async def _execute_transition(self, transition_id: int) -> None:
            known = transition_id in self.dave_pending_transitions
            await super()._execute_transition(transition_id)
            if known and self.dave_session is not None:
                dave_execute(self, transition_id)

    class KairosVoiceClient(voice_recv.VoiceRecvClient):
        def create_connection_state(self):
            return KairosConnectionState(self, hook=recv_hook)

    return KairosVoiceWebSocket, KairosConnectionState, KairosVoiceClient


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
        self.on_event = on_event
        self.vc = await self.channel.connect(cls=dave_classes()[2], timeout=CONNECT_TIMEOUT, reconnect=False)
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
            # The frame's RTP timestamp goes with it: the call measures the gaps in their speech by it, not by when
            # frames happen to arrive (network jitter would otherwise delay the end of each turn).
            timestamp = getattr(getattr(data, "packet", None), "timestamp", None)
            timestamp = timestamp if type(timestamp) is int else None
            frame = getattr(data, "opus", None)
            if frame:
                self.on_event(("opus", self.linked_user, bytes(frame), timestamp))
                return
            pcm = getattr(data, "pcm", None)   # a sink that decodes (not used now): already PCM
            if pcm:
                self.on_event(("audio", self.linked_user, bytes(pcm), timestamp))
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
                # No key for them yet (the session is not ready, or they joined and the key change has not finished):
                # "not ready yet", which the call waits out, rather than a frame that is bad.
                pending = not getattr(session, "ready", False) or "NoDecryptor" in str(error)
                raise audio.Undecryptable(f"DAVE could not open it ({type(error).__name__}: {error})",
                                          pending=pending) from None
        if encrypted:
            raise audio.Undecryptable("it is end-to-end encrypted (DAVE) and there is no DAVE session", pending=True)
        return frame

    def ready_to_speak(self) -> bool:
        """Can the person hear the bot yet? With DAVE on, only once discord.py can encrypt (a frame sent before that
        goes out unencrypted and the person's app drops it: David's re-test, 2026-11-11)."""
        state = getattr(self.vc, "_connection", None)
        if state is None:
            return False
        if not getattr(state, "dave_protocol_version", 0):
            return True
        return bool(getattr(state, "can_encrypt", False))

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
                "dave_ready": bool(getattr(session, "ready", False)), "dave": _status(session),
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
