"""A bot talking with the person by voice in a Discord voice channel.

Discord bots cannot place a one-to-one call, but a bot can join a voice channel in a server it is in. So "call me" can
mean: the bot joins the voice channel the person set for it (Settings > Channels > the Discord bot, off by default),
DMs a link, and talks there. The channel is a public-ish room, so the safety rules are strict:

- Only the Discord account linked to the Kairos account (the Discord bot's allowed user) is ever heard or answered.
  Anyone else's audio is dropped before it is decoded, buffered or transcribed.
- The bot says "This is <bot>, an AI assistant from Kairos." as soon as the person is there.
- It leaves when the person leaves, when nobody joined in time, after IDLE_SECONDS of quiet, and at MAX_SECONDS.
- It never sits silent when it cannot hear them (their frames will not decode, or receiving stopped and would not
  restart): it says CANT_HEAR_LINE, leaves, and DMs them to carry on in text. A single bad frame is only dropped.
- A call to the person is rate limited like a ring (bot_outbound allowance, a pause between calls), per account.

The conversation reuses the phone-call pipeline: the same endpointer (Smart Turn asked on a pause when available), the
same speech-to-text and conversation model (services/phone_calls.LivePipeline), sentence-streamed speech out, and
barge-in (sustained speech over the bot cancels the reply and clears what is queued; a short "mm-hm" does not).

Everything that touches Discord sits behind `HOST` (the connected client, the channel, DMs, the voice transport), and the
real one needs packages that may not be installed (core/discord_voice_audio.missing_requirements), so tests run the
whole thing against fakes (scripts/test_discord_voice.py) and nothing here opens a connection by itself.
"""
import asyncio
import inspect
import logging
import re
import time
import uuid
from typing import Callable, Optional

import numpy as np

from core import accounts, bot_outbound, discord_bots_store, discord_voice_audio as audio, phone_audio
from services import phone_bridge, phone_calls

logger = logging.getLogger(__name__)

IDLE_SECONDS = 5 * 60          # quiet this long (nobody talking, nothing being said) and the bot leaves
JOIN_WAIT_SECONDS = 2 * 60     # how long it waits in the channel for the person to arrive (a call they asked for)
RING_WAIT_SECONDS = 60         # a bot calling them: like a ring, about a minute, then Reach me's next way
MAX_SECONDS = 30 * 60
TICK_SECONDS = 0.05
# Discord sends audio only while someone talks, so the endpointer is fed silence for the gaps. The time line it hears is
# kept on the wall clock (2026-11-11: it used to run ahead by every network hiccup, since a late frame's gap was filled
# and the frames bunched behind it were then added on top, so the end of a turn was decided that much later):
# - between two of their frames, the gap their own RTP timestamps show (exact, jitter does not matter), or, with no
#   timestamps, the arrival gap past SILENCE_FILL_GAP;
# - after their last frame, silence up to now once TAIL_GRACE has passed with nothing (a frame merely late is not
#   silence), then every tick, so the 700 ms wait (or Smart Turn's pause) ends when it would in an app call.
SILENCE_FILL_GAP = 0.06
TAIL_GRACE = 0.1
TAIL_STEP = 0.02
MAX_FILL_SECONDS = 5.0
RTP_WRAP = 2 ** 32
CAPS = {"bot": 3, "account": 6}      # bot-started calls per day (the same as rings)
USER_CAP = 30                        # calls the person asks for themselves, per day
BOT_COOLDOWN_SECONDS = 90
USER_COOLDOWN_SECONDS = 20
LEAD_SECONDS = phone_bridge.LEAD_SECONDS
BARGE_VOICED_MS = phone_bridge.BARGE_VOICED_MS
CANT_HEAR_PACKETS = 250        # this many of the person's frames in a row that are bad (five seconds of talking)
DAVE_SETUP_SECONDS = 10.0      # their audio arrives but the encryption keys for it never come: give up after this long
SPEAK_READY_SECONDS = 10.0     # the greeting waits this long for the connection to be able to encrypt the bot's voice
SPEAK_READY_STEP = 0.05
RECEIVE_CHECK_SECONDS = 1.0    # how often the connection is asked whether it is still receiving
CANT_HEAR_LINE = "I can't hear you on Discord right now, so Kairos will message you instead."
CANT_HEAR_DM = "I couldn't hear you in #{channel}, so I left the call. Message me here and I'll pick it up."

# "call me", "/kairos call", "join me in voice": short and exact, so "call me when the build is done" is left alone.
CALL_REQUEST = re.compile(
    r"^\W*(?:/?kairos\s+call|[/!]call|call\s+me|ring\s+me|phone\s+me|voice\s+call|join\s+me(?:\s+in\s+voice)?|"
    r"(?:hop|jump)\s+(?:on|in)\s+(?:a\s+)?(?:call|voice))(?:\s+(?:now|please|pls))?\W*$", re.IGNORECASE)


class VoiceRefused(Exception):
    """A call into a Discord voice channel that will not be placed; the message is shown as-is.
    `unavailable` means the feature is not set up or cannot run here (the caller may fall back to a ring),
    as opposed to a limit or a conflict (which it must not work around)."""

    def __init__(self, message: str, unavailable: bool = False, missed: bool = False):
        super().__init__(message)
        self.unavailable = unavailable
        self.missed = missed            # rang (joined and DMed) but nobody came in time: Reach me tries the next way


def is_call_request(text) -> bool:
    return bool(CALL_REQUEST.match(str(text or "")))


def disclosure(name: str) -> str:
    return phone_calls.disclosure(name)


# -- the bridge: one voice session's speech, thinking and talking ---------------------------------------------

class VoiceBridge(phone_bridge.TurnBridge):
    """Events in (audio, opus packets, the person joining or leaving), Opus packets out. The turn-taking is the phone
    bridge's (phone_bridge.TurnBridge); this adds who is heard, silence filling, and when to leave. Time comes from
    `clock`, so a test steps it by hand and calls `tick()`; `run(queue)` is the same loop with a real wait. `ended`
    says why it ended.
    """
    LABEL = "discord voice"
    REQUEST_PREFIX = "discord"

    def __init__(self, pipeline: phone_bridge.Pipeline, *, linked_user: str, send: Callable, clear: Callable, codec,
                 opening: str = "", present: bool = False, smart_turn: bool = False, pace: bool = True,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable = asyncio.sleep,
                 idle_seconds: float = IDLE_SECONDS, join_wait_seconds: float = JOIN_WAIT_SECONDS,
                 max_seconds: float = MAX_SECONDS, unwrap: Optional[Callable] = None,
                 receiving: Optional[Callable] = None, on_begin: Optional[Callable] = None,
                 ready_to_speak: Optional[Callable] = None):
        self._init_turns(pipeline, opening=opening, smart_turn=smart_turn, pace=pace, clock=clock, sleep=sleep)
        self.linked_user, self.send, self.clear, self.codec = str(linked_user), send, clear, codec
        self.present = present
        self.idle_seconds, self.join_wait_seconds, self.max_seconds = idle_seconds, join_wait_seconds, max_seconds
        # The connection's own steps (services/discord_voice_transport): open a received frame (DAVE), say whether it
        # is still receiving, and hear that the person arrived. None: frames are plain Opus, receiving never stops.
        self.unwrap, self.receiving, self.on_begin = unwrap, receiving, on_begin
        self.ready_to_speak = ready_to_speak    # can the person hear the bot yet (DAVE keys in place)? None: always
        self.inbound = audio.DiscordToSpeech()
        self.decoder = None
        self.begun = False
        self.ignored = 0                       # events from anyone but the linked person
        self.decoded = 0                       # the person's frames opened and decoded
        self.bad_packets = 0                   # ... and those that could not be (dropped, the decoder reset)
        self.bad_run = 0                       # bad ones in a row
        self.cant_hear: Optional[str] = None   # why the bot cannot hear them (it says so and leaves)
        self.checked_receiving = 0.0
        self.opening_render: Optional[asyncio.Task] = None
        self.pending_frames = 0                # frames that came before the keys to open them (not counted as bad)
        self.pending_since: Optional[float] = None
        self.started = clock()
        self.last_activity = self.started
        self.heard_until = self.started        # the wall time the endpointer has heard up to (their audio or silence)
        self.tail_filled = 0.0                 # silence fed since their last frame
        self.last_timestamp: Optional[int] = None
        self.last_frame_seconds = audio.FRAME_SECONDS
        self.ended: Optional[str] = None
        self.done = asyncio.Event()
        self.arrived = asyncio.Event()         # the person is in the channel and the opening has started

    # -- the loop --------------------------------------------------------------------------------------

    async def run(self, queue: asyncio.Queue) -> str:
        self.started = self.last_activity = self.heard_until = self.clock()
        self.prepare()
        try:
            if self.present:
                await self._begin()
            while not self.done.is_set():
                try:
                    event = await asyncio.wait_for(queue.get(), TICK_SECONDS)
                except asyncio.TimeoutError:
                    event = None
                if event is not None:
                    await self.handle(event)
                await self.tick()
        finally:
            await self._shutdown()
        return self.ended or "stopped"

    def end(self, reason: str) -> None:
        if self.ended is None:
            self.ended = reason
        self.done.set()

    async def handle(self, event) -> None:
        kind = event[0]
        if kind in ("audio", "opus"):
            if str(event[1]) != self.linked_user:
                self.ignored += 1            # never decoded, buffered or transcribed
                return
            if not self.present:
                self.present = True
            await self._begin()
            if self.cant_hear is not None:
                return                       # it is saying so and leaving
            data = event[2]
            if kind == "opus":
                data = self._decode(data)
                if data is None:
                    return
            await self._audio(data, event[3] if len(event) > 3 else None)
        elif kind == "joined" and str(event[1]) == self.linked_user:
            self.present = True
            await self._begin()
        elif kind == "left" and str(event[1]) == self.linked_user and self.present:
            self.present = False
            self.end("user left")
        elif kind == "stop":
            self.end("stopped")

    async def tick(self) -> None:
        """Time passing with no audio: silence for the endpointer, and the reasons to leave."""
        if self.done.is_set():
            return
        if self.end_requested and self.phase == "idle" and (self.turn is None or self.turn.done()):
            return self.end("done")
        now = self.clock()
        if not self.begun and now - self.started > self.join_wait_seconds:
            return self.end("nobody joined")
        if now - self.started > self.max_seconds:
            return self.end("time limit")
        if not self.begun:
            return
        if self.receiving is not None and self.cant_hear is None and now - self.checked_receiving >= RECEIVE_CHECK_SECONDS:
            self.checked_receiving = now
            try:
                alive = bool(self.receiving())
            except Exception:
                logger.exception("discord voice: could not check receiving")
                alive = True
            if not alive:
                self._cannot_hear("receiving stopped and could not be restarted")
        gap = now - self.heard_until
        if gap >= (TAIL_STEP if self.tail_filled else TAIL_GRACE):
            await self._feed_silence(gap)
            self.heard_until = now
            self.tail_filled += gap
        if self.phase == "idle" and not self.endpointer.active and now - self.last_activity > self.idle_seconds:
            self.end("idle")

    async def _begin(self) -> None:
        if self.begun or not self.present:
            return
        self.begun = True
        self.arrived.set()
        self.last_activity = self.heard_until = self.checked_receiving = self.clock()
        self.tail_filled = 0.0
        if self.on_begin is not None:
            try:
                self.on_begin()
            except Exception:
                logger.exception("discord voice: the connection's arrival step failed")
        if self.opening:
            self.prepare()
            self.turn = asyncio.create_task(self._open())

    # -- the greeting, rendered while the bot waits ------------------------------------------------

    def prepare(self) -> None:
        """Start rendering the greeting now, before the person is there (David's test, 2026-11-11: the voice loaded
        only when he joined, so the greeting came about four seconds late). Joining then plays it at once."""
        if self.opening and self.opening_render is None:
            self.opening_render = asyncio.ensure_future(self._render_opening())

    async def _render_opening(self) -> list:
        """The greeting in frames. Rendering it at join is also what warms the voice (Kokoro loads and runs once)
        before the person's first turn."""
        sentences, rest = phone_bridge.split_sentences(self.opening)
        if rest.strip():
            sentences.append(rest)
        began = time.perf_counter()
        rendered = await self._render_sentences(sentences)
        logger.info("discord voice: greeting rendered ahead in %d ms (the voice is warm)", (time.perf_counter() - began) * 1000)
        return rendered

    async def _render_sentences(self, sentences: list) -> list:
        rendered = []
        for sentence in sentences:
            converter, frames = None, []
            async for rate, pcm in self.pipeline.speak(phone_bridge.spoken_text(sentence)):
                converter = self._converted(converter, rate)
                frames += converter.frames(pcm)
            if converter:
                frames += converter.frames(b"", final=True)
            if frames:
                rendered.append((sentence, frames))
        return rendered

    async def _speak_opening(self) -> None:
        rendered = None
        if self.opening_render is not None:
            try:
                rendered = await self.opening_render
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("discord voice: the greeting could not be rendered ahead; saying it now", exc_info=True)
        if not await self._wait_until_heard():
            self._cannot_hear("the bot's voice could not be encrypted for the call", speak=False)
            return
        if not rendered:
            await super()._speak_opening()
            return
        self.played = []
        self.phase = "speaking"
        for sentence, frames in rendered:
            self.played.append((sentence, max(self.play_end, self.clock())))
            await self._send_frames(frames)
        logger.info("discord voice: greeting sent (%d frames)", sum(len(frames) for _, frames in rendered))
        if self.pace:
            await self.sleep(max(0.0, self.play_end - self.clock()))

    async def _wait_until_heard(self) -> bool:
        """Wait (up to SPEAK_READY_SECONDS) until the connection can encrypt the bot's voice; True when it can. With
        DAVE, audio sent before that is dropped by the person's app (David's re-test, 2026-11-11)."""
        if self.ready_to_speak is None:
            return True
        for step in range(int(SPEAK_READY_SECONDS / SPEAK_READY_STEP) + 1):
            try:
                if self.ready_to_speak():
                    if step:
                        logger.info("discord voice: the connection could encrypt after %.1f s", step * SPEAK_READY_STEP)
                    return True
            except Exception:
                logger.exception("discord voice: could not check whether the voice can be heard")
                return True
            await asyncio.sleep(SPEAK_READY_STEP)
        return False

    # -- not hearing them --------------------------------------------------------------------------

    def _decode(self, frame: bytes) -> Optional[bytes]:
        """One of the person's received frames -> 48 kHz stereo PCM, or None when it cannot be opened or decoded. A bad
        frame is dropped and the decoder reset, so it never stops what follows (2026-11-11: one undecodable frame used
        to end all receiving). A frame whose key has not arrived yet (DAVE still being set up for them) is only
        waited out, for up to DAVE_SETUP_SECONDS. Five seconds of nothing but bad frames means the bot cannot hear
        them: it says so."""
        try:
            opus = self.unwrap(self.linked_user, frame) if self.unwrap is not None else frame
            if not opus:
                return None
            if self.decoder is None:
                self.decoder = self.codec.new_decoder()
            pcm = self.decoder.decode(opus)
        except audio.Undecryptable as error:
            if not getattr(error, "pending", False):
                return self._bad_frame(frame, error)
            self.pending_frames += 1
            now = self.clock()
            if self.pending_since is None:
                self.pending_since = now
                logger.info("discord voice: their audio is encrypted and its key has not arrived yet (%s); waiting", error)
            elif now - self.pending_since > DAVE_SETUP_SECONDS and self.cant_hear is None:
                self._cannot_hear(f"the keys to their encrypted audio never arrived ({now - self.pending_since:.0f} s, "
                                  f"{self.pending_frames} frames: {error})")
            return None
        except Exception as error:
            return self._bad_frame(frame, error)
        self.bad_run = 0
        self.pending_since = None
        self.decoded += 1
        return pcm

    def _bad_frame(self, frame: bytes, error: Exception) -> None:
        """A frame that will not open or decode: dropped, the decoder reset; a long run of them ends the call."""
        self.bad_packets += 1
        self.bad_run += 1
        self.decoder = None
        if self.bad_packets == 1:
            encrypted = " (end-to-end encrypted)" if audio.is_dave_frame(frame) else ""
            logger.warning("discord voice: a received frame could not be decoded%s: %s: %s; dropped, decoder reset "
                           "(later ones are logged only as a count)", encrypted, type(error).__name__, error)
        if self.bad_run >= CANT_HEAR_PACKETS and self.cant_hear is None:
            self._cannot_hear(f"{self.bad_run} frames in a row could not be decoded ({type(error).__name__}: {error})")
        return None

    def _cannot_hear(self, why: str, speak: bool = True) -> None:
        """Say plainly that the bot cannot hear them (when they can hear it), then leave; the session DMs them to carry
        on in text."""
        self.cant_hear = why
        logger.warning("discord voice: cannot hear the person (%s; %d decoded, %d bad, %d waiting for keys); leaving",
                       why, self.decoded, self.bad_packets, self.pending_frames)
        previous, self.turn = self.turn, None
        self.turn = asyncio.ensure_future(self._say_cannot_hear(previous, speak))

    async def _say_cannot_hear(self, previous, speak: bool = True) -> None:
        try:
            if previous is not None and not previous.done():
                await asyncio.gather(previous, return_exceptions=True)     # let the greeting finish first
            if speak and self.ready_to_speak is not None and not self.ready_to_speak():
                speak = False                    # they could not hear it anyway; the DM says it
            if speak:
                self.phase = "speaking"
                await self._say(self._once(CANT_HEAR_LINE))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("discord voice: could not say that it cannot hear")
        finally:
            self.phase = "idle"
            self.end("cannot hear")

    # -- inbound ---------------------------------------------------------------------------------------

    async def _feed_silence(self, seconds: float) -> None:
        count = int(min(seconds, MAX_FILL_SECONDS) * phone_audio.SPEECH_RATE)
        if count:
            await self._push(np.zeros(count, dtype=np.float32))

    async def _audio(self, pcm_stereo: bytes, timestamp: Optional[int] = None) -> None:
        """One of their frames (48 kHz stereo PCM16), with its RTP timestamp when the connection gives it."""
        self.frames_in += 1
        if self.frames_in % 50 == 0:
            self.pipeline.touch()
        now = self.clock()
        seconds = len(pcm_stereo) / (audio.CHANNELS * 2 * audio.DISCORD_RATE) or audio.FRAME_SECONDS
        missing = self._missing(now, seconds, timestamp)
        if missing > 0:
            await self._feed_silence(missing)
        self.heard_until, self.tail_filled = now, 0.0      # this frame ends now: never ahead of the clock
        if timestamp is not None:
            self.last_timestamp, self.last_frame_seconds = int(timestamp), seconds
        await self._push(phone_audio.pcm16_to_float(self.inbound.feed(pcm_stereo)))

    def _missing(self, now: float, seconds: float, timestamp: Optional[int]) -> float:
        """Silence they did not send between their last frame and this one, less what the tail already fed."""
        if timestamp is not None and self.last_timestamp is not None:
            step = ((int(timestamp) - self.last_timestamp) % RTP_WRAP) / audio.DISCORD_RATE
            between = step - self.last_frame_seconds
            if 0 <= between <= MAX_FILL_SECONDS:
                return max(0.0, between - self.tail_filled)
        between = (now - seconds) - self.heard_until
        return between if between > SILENCE_FILL_GAP else 0.0

    def _speech_started(self) -> None:
        self.last_activity = self.clock()

    def _turn_over(self) -> None:
        self.last_activity = self.clock()

    # -- audio out -------------------------------------------------------------------------------------

    def _new_converter(self, rate: int):
        return audio.SpeechToDiscord(rate)

    def _converter_rate(self, converter) -> int:
        return converter.source

    async def _emit(self, frame) -> None:
        result = self.send(self.codec.encode(frame))
        if inspect.isawaitable(result):
            await result

    def _frame_seconds(self, frame) -> float:
        return audio.FRAME_SECONDS

    async def _clear_output(self) -> None:
        result = self.clear()
        if inspect.isawaitable(result):
            await result

    async def _shutdown(self) -> None:
        render = self.opening_render
        if render is not None and not render.done():
            render.cancel()
            await asyncio.gather(render, return_exceptions=True)
        await super()._shutdown()


class DiscordHost:
    """The real Discord side: the connected client of a bot (core/channels/discord_channel), its channel, DMs and the
    voice transport. Tests replace `HOST` with a fake of the same four methods."""

    def client(self, bot_id: str):
        from core.channels import discord_channel
        client = discord_channel._clients.get(bot_id)
        return client if client is not None and getattr(client, "is_ready", lambda: False)() else None

    async def channel(self, client, channel_id: str):
        number = int(channel_id)
        found = client.get_channel(number) or await client.fetch_channel(number)
        if getattr(found, "guild", None) is None or not hasattr(found, "connect"):
            raise VoiceRefused("That ID is not a voice channel in a server this bot is in.")
        return found

    def describe(self, channel) -> tuple[str, str]:
        return str(channel.name), str(channel.guild.id)

    def transport(self, client, channel, linked_user: str):
        from services import discord_voice_transport
        return discord_voice_transport.RealTransport(channel, linked_user, asyncio.get_running_loop())

    async def dm(self, client, user_id: str, text: str) -> None:
        user = await client.fetch_user(int(user_id))
        await user.send(text)

    async def user_name(self, client, user_id: str) -> str:
        user = client.get_user(int(user_id)) or await client.fetch_user(int(user_id))
        return getattr(user, "global_name", None) or getattr(user, "display_name", None) or getattr(user, "name", "") or ""

    async def mention(self, channel, text: str) -> None:
        """A message in the voice channel's own text chat (Discord voice channels have one)."""
        await channel.send(text)


HOST = DiscordHost()
CODEC_FACTORY: Callable = audio.real_codec     # tests: a fake codec
REQUIREMENTS: Callable = audio.missing_requirements
PIPELINE_FACTORY: Optional[Callable] = None    # tests: a fake pipeline; None is the live one


# -- sessions ---------------------------------------------------------------------------------------------

class Session:
    def __init__(self, **fields):
        self.__dict__.update(fields)

    def post(self, event) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, event)


_sessions: dict[str, Session] = {}      # discord bot id -> its session
_joining: set = set()
_last_join: dict[str, float] = {}


def session_for(bot_id: str) -> Optional[Session]:
    return _sessions.get(bot_id)


def _eligible(bot: dict) -> str:
    """Why this Discord bot cannot take a voice call, or ''."""
    if not discord_bots_store.mine(bot):
        return "That Discord bot belongs to another account."
    if not bot.get("voice_channel_id"):
        return "Voice in Discord is off. Choose a voice channel for the Discord bot in Settings, Channels."
    if not bot.get("allowed_user_id"):
        return "Voice in Discord needs the bot's allowed user set, so only you are ever heard."
    missing = REQUIREMENTS()
    if missing:
        return "Voice in Discord needs these installed first: " + ", ".join(missing) + "."
    if HOST.client(bot["id"]) is None:
        return "The Discord bot is not connected right now."
    return ""


def pick_bot(account: str) -> dict:
    """The first of the account's Discord bots that can take a voice call."""
    reason = "No Discord bot is set up for voice."
    with accounts.as_account(account):
        for bot in discord_bots_store.list_bots():
            if not discord_bots_store.mine(bot):
                continue
            problem = _eligible(bot)
            if not problem:
                return bot
            reason = problem
    raise VoiceRefused(reason, unavailable=True)


def _reserve(account: str, agent_id: str, invocation_id: str, user_started: bool) -> list:
    caps = (("account", "discordvoice:account", USER_CAP),) if user_started else (
        ("account", "discordvoice:account", CAPS["account"]), ("bot", f"discordvoice:{agent_id}", CAPS["bot"]))
    taken = []
    for scope, who, cap in caps:
        result = bot_outbound.reserve(account, who, invocation_id, cap, tool="discord_voice")
        if not result.get("ok"):
            for done in taken:
                bot_outbound.finalize(account, done, invocation_id, bot_outbound.RELEASED)
            raise VoiceRefused(f"Today's limit for voice calls to you ({cap} per {scope}) is used up.")
        taken.append(who)
    return taken


def _settle(account: str, taken: list, invocation_id: str, outcome: str) -> None:
    for who in taken:
        try:
            bot_outbound.finalize(account, who, invocation_id, outcome)
        except Exception:
            logger.exception("discord voice: could not settle an allowance unit")


async def _live_pipeline(account: str, agent: dict, bot: dict):
    from fastapi import HTTPException
    from core import phone_connection
    from services import agent_calls
    record = phone_connection.get(account) or {}
    endpoint = record.get("conversation_endpoint_id") or bot.get("model_endpoint_id")
    if not endpoint:
        raise VoiceRefused("Pick a conversation model first (the Discord bot's default model, or the Phone connection's).")
    model = record.get("conversation_model") if record.get("conversation_endpoint_id") == endpoint else None
    owner = phone_calls.owner_of(account)
    try:
        started = agent_calls.start(phone_calls._thread_for(agent, owner), agent["id"], endpoint, model, owner)
        call = agent_calls.require(started["id"], owner)
    except HTTPException as error:
        raise VoiceRefused(str(error.detail)) from None
    except ValueError as error:
        raise VoiceRefused(str(error)) from None
    return phone_calls.LivePipeline(account, owner, {}, agent, call)


async def join(account: str, bot: dict, agent: dict, reason: str = "", *, user_started: bool = False,
               invocation_id: str = "", clock: Callable[[], float] = time.monotonic,
               sleep: Callable = asyncio.sleep, pace: bool = True, ring: bool = False, ask_id: Optional[str] = None) -> str:
    """Join the Discord bot's voice channel for a call with the account's own person, and DM them the link.
    Raises VoiceRefused with the reason in words. Returns what to tell the caller.

    `ring` (a bot calling them, 2026-11-10): the DM is worded like a call ("<Bot> is calling you. Tap to join: <link>")
    and mentions them, the bot greets them by name the moment they join, and this waits RING_WAIT_SECONDS for them;
    nobody joining leaves the channel and raises VoiceRefused(missed=True), so Reach me tries its next way."""
    with accounts.as_account(account):
        problem = _eligible(bot)
    if problem:
        raise VoiceRefused(problem, unavailable=True)
    bot_id, user_id = bot["id"], str(bot["allowed_user_id"])
    if bot_id in _sessions or bot_id in _joining:
        return "Already in the voice channel with you."
    invocation_id = invocation_id or uuid.uuid4().hex
    now = time.time()
    cooldown = USER_COOLDOWN_SECONDS if user_started else BOT_COOLDOWN_SECONDS
    if now - _last_join.get(account, 0) < cooldown:
        raise VoiceRefused("A voice call to you was placed a moment ago. Wait a little before asking again.")
    _joining.add(bot_id)
    taken, transport = [], None
    try:
        taken = _reserve(account, agent["id"], invocation_id, user_started)
        client = HOST.client(bot_id)
        channel = await HOST.channel(client, bot["voice_channel_id"])
        name, guild_id = HOST.describe(channel)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        session = Session(bot_id=bot_id, account=account, agent=agent, user_id=user_id, channel_id=str(channel.id),
                          channel_name=name, loop=loop, queue=queue, transport=None, task=None, bridge=None,
                          client=client, warming=None)
        transport = HOST.transport(client, channel, user_id)
        await transport.connect(session.post)
        session.transport = transport
        with accounts.as_account(account):
            pipeline = await (PIPELINE_FACTORY or _live_pipeline)(account, agent, bot)
            # While the person is still clicking the link: load the conversation model, speech-to-text and Smart Turn,
            # as an app call does when it starts (the first Discord turn paid all of it, 2026-11-11).
            session.warming = asyncio.ensure_future(_warm(pipeline))
            from core import turn_detect
            smart = turn_detect.ready()[0] if PIPELINE_FACTORY is None else False
            name_for_speech = agent.get("name") or "Kairos"
            opening = (f"{disclosure(name_for_speech)} {reason}".strip() if reason
                       else f"{disclosure(name_for_speech)} How can I help?")
            if ring:
                try:
                    person = clean_name(await HOST.user_name(client, user_id))
                except Exception:
                    person = ""
                opening = f"Hi {person}. {opening}" if person else f"Hi. {opening}"
            if ask_id and isinstance(getattr(pipeline, "call", None), dict):
                from services import call_ask
                call_ask.attach(pipeline.call, ask_id)
            session.bridge = VoiceBridge(pipeline, linked_user=user_id, send=transport.send, clear=transport.clear,
                                         codec=CODEC_FACTORY(), opening=opening, smart_turn=smart,
                                         present=user_id in transport.members(), clock=clock, sleep=sleep, pace=pace,
                                         unwrap=getattr(transport, "decrypt", None),
                                         receiving=getattr(transport, "receiving", None),
                                         on_begin=getattr(transport, "joined", None),
                                         ready_to_speak=getattr(transport, "ready_to_speak", None),
                                         **({"join_wait_seconds": RING_WAIT_SECONDS} if ring else {}))
            session.task = asyncio.create_task(_run(session))
        _sessions[bot_id] = session
        _last_join[account] = now
        link = f"https://discord.com/channels/{guild_id}/{channel.id}"
        if ring:
            caller = agent.get("name") or "Kairos"
            text = f"<@{user_id}> **{caller} is calling you.** Tap to join: {link}"
        else:
            text = f"I'm in #{name}. Join me: {link}"
        if reason:
            text += f"\n{reason}"
        try:
            await HOST.dm(client, user_id, text)
        except Exception:
            logger.exception("discord voice: could not DM the link")
            if ring:
                # No DM (the person blocks DMs from server members): the mention goes in the voice channel's own chat.
                try:
                    await HOST.mention(channel, text)
                except Exception:
                    logger.exception("discord voice: could not mention them in the channel either")
    except BaseException:
        _settle(account, taken, invocation_id, bot_outbound.RELEASED)
        if transport is not None:
            try:
                await transport.disconnect()
            except Exception:
                logger.exception("discord voice: cleanup disconnect failed")
        raise
    finally:
        _joining.discard(bot_id)
    _settle(account, taken, invocation_id, bot_outbound.COMMITTED)
    if ring:
        return await _wait_for_person(session, name)
    return f"Joined #{name} and sent you the link. Carry on there."


async def _warm(pipeline) -> Optional[dict]:
    try:
        warmed = await pipeline.warm()
    except Exception:
        logger.warning("discord voice: warming up for the call failed; the first turn may be slower", exc_info=True)
        return None
    if warmed:
        logger.info("discord voice: warmed for the call (ms): %s", warmed)
    return warmed


async def _wait_for_person(session: Session, name: str) -> str:
    """A bot's call: about a minute for the person to join. Nobody: leave, and tell Reach me to try the next way."""
    bridge = session.bridge
    waiting = asyncio.ensure_future(bridge.arrived.wait())
    ending = asyncio.ensure_future(bridge.done.wait())
    try:
        await asyncio.wait({waiting, ending}, timeout=RING_WAIT_SECONDS, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (waiting, ending):
            task.cancel()
    if bridge.arrived.is_set():
        return f"They joined #{name}. The call is open now, so carry on there."
    await leave(session.bot_id)
    raise VoiceRefused(f"Nobody joined #{name} within a minute.", missed=True)


def clean_name(value) -> str:
    """A display name fit to say aloud: letters, digits, spaces and a few marks, at most 40 characters."""
    text = re.sub(r"[^\w .'-]", " ", str(value or ""))
    return " ".join(text.split())[:40]


async def _run(session: Session) -> None:
    try:
        reason = await session.bridge.run(session.queue)
        logger.info("discord voice: left #%s (%s; %d frames heard, %d could not be decoded)", session.channel_name,
                    reason, session.bridge.decoded, session.bridge.bad_packets)
        if reason == "cannot hear":
            try:
                await HOST.dm(session.client, session.user_id, CANT_HEAR_DM.format(channel=session.channel_name))
            except Exception:
                logger.exception("discord voice: could not DM them after not hearing them")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("discord voice: the session crashed")
    finally:
        if _sessions.get(session.bot_id) is session:
            _sessions.pop(session.bot_id, None)
        try:
            await session.transport.disconnect()
        except Exception:
            logger.exception("discord voice: disconnect failed")


async def leave(bot_id: str) -> bool:
    session = _sessions.get(bot_id)
    if not session:
        return False
    session.post(("stop",))
    await asyncio.gather(session.task, return_exceptions=True)
    return True


async def leave_all() -> None:
    for bot_id in list(_sessions):
        await leave(bot_id)


def typed_into_call(bot_id: str, text: str) -> bool:
    """The person texted this Discord bot while they are in its voice call: the text is answered in the call, as their
    next turn (Hermes audit: texts during a call go into the call). False when no call is live with them."""
    session = _sessions.get(bot_id)
    said = " ".join(str(text or "").split())[:2000]
    if not session or not session.bridge or not session.bridge.begun or session.bridge.done.is_set() or not said:
        return False
    session.loop.call_soon_threadsafe(session.bridge.typed, f"(typed) {said}")
    return True


def notify_voice_state(bot_id: str, user_id: str, before_channel_id, after_channel_id) -> None:
    """A member's voice state changed (the gateway's on_voice_state_update). Only the session's linked person matters."""
    session = _sessions.get(bot_id)
    if not session or str(user_id) != session.user_id:
        return
    before = str(before_channel_id) if before_channel_id is not None else None
    after = str(after_channel_id) if after_channel_id is not None else None
    if after == session.channel_id and before != after:
        session.post(("joined", session.user_id))
    elif before == session.channel_id and after != before:
        session.post(("left", session.user_id))


# -- the two ways in -------------------------------------------------------------------------------------------

async def call_user(account: str, agent_id: str, reason, invocation_id: str) -> str:
    """A bot ringing the person (ring_me, notify_me_by_call) when they prefer Discord. Raises VoiceRefused."""
    from core import reach_me
    from services.agent_service import agent_service
    reach_me.refuse_if_paused(account, VoiceRefused)
    text = " ".join(str(reason or "").replace("\x00", " ").split())[:phone_calls.MAX_MESSAGE]
    with accounts.as_account(account):
        agent = agent_service.get(agent_id)
    if not agent:
        raise VoiceRefused("That bot is not one of yours.")
    bot = pick_bot(account)
    from services import call_ask
    return await join(account, bot, agent, text, invocation_id=invocation_id, ring=True, ask_id=call_ask.ASK.get())


async def handle_call_request(account: str, bot: dict) -> Optional[str]:
    """The person asked this Discord bot to call them ("call me"). None when it joined (the link is already DMed),
    else the reason it did not, to say back."""
    from services import front_desk
    from services.agent_service import agent_service
    with accounts.as_account(account):
        ident = front_desk.bot_id()
        agent = agent_service.get(ident) if ident else None
    if not agent:
        return "No bot is set up to take calls yet."
    try:
        await join(account, bot, agent, "", user_started=True)
    except VoiceRefused as error:
        return str(error)
    except Exception:
        logger.exception("discord voice: a call request failed")
        return "I could not join the voice channel. Check the app logs."
    return None
