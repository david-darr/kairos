"""A bot talking with the person by voice in a Discord voice channel.

Discord bots cannot place a one-to-one call, but a bot can join a voice channel in a server it is in. So "call me" can
mean: the bot joins the voice channel the person set for it (Settings > Channels > the Discord bot, off by default),
DMs a link, and talks there. The channel is a public-ish room, so the safety rules are strict:

- Only the Discord account linked to the Kairos account (the Discord bot's allowed user) is ever heard or answered.
  Anyone else's audio is dropped before it is decoded, buffered or transcribed.
- The bot says "This is <bot>, an AI assistant from Kairos." as soon as the person is there.
- It leaves when the person leaves, when nobody joined in time, after IDLE_SECONDS of quiet, and at MAX_SECONDS.
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
JOIN_WAIT_SECONDS = 2 * 60     # how long it waits in the channel for the person to arrive
MAX_SECONDS = 30 * 60
TICK_SECONDS = 0.05
SILENCE_FILL_GAP = 0.06        # Discord sends audio only while someone talks; gaps longer than this are fed as silence
MAX_FILL_SECONDS = 5.0
CAPS = {"bot": 3, "account": 6}      # bot-started calls per day (the same as rings)
USER_CAP = 30                        # calls the person asks for themselves, per day
BOT_COOLDOWN_SECONDS = 90
USER_COOLDOWN_SECONDS = 20
LEAD_SECONDS = phone_bridge.LEAD_SECONDS
BARGE_VOICED_MS = phone_bridge.BARGE_VOICED_MS

# "call me", "/kairos call", "join me in voice": short and exact, so "call me when the build is done" is left alone.
CALL_REQUEST = re.compile(
    r"^\W*(?:/?kairos\s+call|[/!]call|call\s+me|ring\s+me|phone\s+me|voice\s+call|join\s+me(?:\s+in\s+voice)?|"
    r"(?:hop|jump)\s+(?:on|in)\s+(?:a\s+)?(?:call|voice))(?:\s+(?:now|please|pls))?\W*$", re.IGNORECASE)


class VoiceRefused(Exception):
    """A call into a Discord voice channel that will not be placed; the message is shown as-is.
    `unavailable` means the feature is not set up or cannot run here (the caller may fall back to a ring),
    as opposed to a limit or a conflict (which it must not work around)."""

    def __init__(self, message: str, unavailable: bool = False):
        super().__init__(message)
        self.unavailable = unavailable


def is_call_request(text) -> bool:
    return bool(CALL_REQUEST.match(str(text or "")))


def disclosure(name: str) -> str:
    return phone_calls.disclosure(name)


# -- the bridge: one voice session's speech, thinking and talking ---------------------------------------------

class VoiceBridge:
    """Events in (audio, opus packets, the person joining or leaving), Opus packets out. Time comes from `clock`, so a
    test steps it by hand and calls `tick()`; `run(queue)` is the same loop with a real wait. `ended` says why it ended.
    """

    def __init__(self, pipeline: phone_bridge.Pipeline, *, linked_user: str, send: Callable, clear: Callable, codec,
                 opening: str = "", present: bool = False, smart_turn: bool = False, pace: bool = True,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable = asyncio.sleep,
                 idle_seconds: float = IDLE_SECONDS, join_wait_seconds: float = JOIN_WAIT_SECONDS,
                 max_seconds: float = MAX_SECONDS):
        self.pipeline, self.linked_user = pipeline, str(linked_user)
        self.send, self.clear, self.codec, self.opening = send, clear, codec, opening
        self.present, self.pace, self.clock, self.sleep = present, pace, clock, sleep
        self.idle_seconds, self.join_wait_seconds, self.max_seconds = idle_seconds, join_wait_seconds, max_seconds
        self.inbound = audio.DiscordToSpeech()
        self.endpointer = phone_bridge.Endpointer(smart=smart_turn)
        self.decoder = None
        self.phase = "idle"                    # idle | thinking | speaking
        self.turn: Optional[asyncio.Task] = None
        self.background: set = set()
        self.begun = False
        self.backchannel = False
        self.play_end = 0.0
        self.sent_frames = 0
        self.frames_in = 0
        self.ignored = 0                       # events from anyone but the linked person
        self.heard: list[str] = []
        self.started = clock()
        self.last_activity = self.started
        self.fed_until = self.started
        self.ended: Optional[str] = None
        self.done = asyncio.Event()

    # -- the loop --------------------------------------------------------------------------------------

    async def run(self, queue: asyncio.Queue) -> str:
        self.started = self.last_activity = self.fed_until = self.clock()
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
            data = event[2]
            if kind == "opus":
                if self.decoder is None:
                    self.decoder = self.codec.new_decoder()
                data = self.decoder.decode(data)
            await self._audio(data)
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
        now = self.clock()
        if not self.begun and now - self.started > self.join_wait_seconds:
            return self.end("nobody joined")
        if now - self.started > self.max_seconds:
            return self.end("time limit")
        if not self.begun:
            return
        gap = now - self.fed_until
        if gap >= 0.04:
            await self._feed_silence(gap)
            self.fed_until = now
        if self.phase == "idle" and not self.endpointer.active and now - self.last_activity > self.idle_seconds:
            self.end("idle")

    async def _begin(self) -> None:
        if self.begun or not self.present:
            return
        self.begun = True
        self.last_activity = self.fed_until = self.clock()
        if self.opening:
            self.turn = asyncio.create_task(self._open())

    # -- inbound ---------------------------------------------------------------------------------------

    async def _feed_silence(self, seconds: float) -> None:
        count = int(min(seconds, MAX_FILL_SECONDS) * phone_audio.SPEECH_RATE)
        if count:
            await self._push(np.zeros(count, dtype=np.float32))

    async def _audio(self, pcm_stereo: bytes) -> None:
        self.frames_in += 1
        if self.frames_in % 50 == 0:
            self.pipeline.touch()
        now = self.clock()
        gap = now - self.fed_until
        if gap > SILENCE_FILL_GAP:
            await self._feed_silence(gap)
        self.fed_until = max(self.fed_until, now)
        samples = phone_audio.pcm16_to_float(self.inbound.feed(pcm_stereo))
        self.fed_until += len(samples) / phone_audio.SPEECH_RATE
        await self._push(samples)

    async def _push(self, samples) -> None:
        await self._events(self.endpointer.push(samples))
        if self.phase == "speaking" and self.endpointer.active and self.endpointer.voiced_ms >= BARGE_VOICED_MS:
            await self._barge_in()

    async def _events(self, events: list) -> None:
        for event in events:
            if event[0] == "start":
                self.last_activity = self.clock()
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
            logger.info("discord voice: Smart Turn unavailable for this pause")
        if verdict is not None:
            await self._events(self.endpointer.answer(pause_id, verdict))

    def _spawn(self, coroutine) -> None:
        task = asyncio.create_task(coroutine)
        self.background.add(task)
        task.add_done_callback(self.background.discard)

    # -- one turn --------------------------------------------------------------------------------------

    async def _open(self) -> None:
        self.phase = "speaking"
        try:
            await self.pipeline.announce(self.opening, "open:" + uuid.uuid4().hex)
            await self._say(self._once(self.opening))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("discord voice: the opening line failed")
        finally:
            self.phase = "idle"
            self.last_activity = self.clock()

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
            await self._say(self.pipeline.converse(text, "discord:" + uuid.uuid4().hex))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("discord voice: a turn failed")
        finally:
            self.phase = "idle"
            self.last_activity = self.clock()

    async def _say(self, deltas) -> None:
        """Speak a stream of text: each finished sentence is rendered while the one before it is still playing."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)

        async def render(sentence: str) -> None:
            converter = None
            async for rate, pcm in self.pipeline.speak(phone_bridge.spoken_text(sentence)):
                if converter is None or converter.source != rate:
                    converter = audio.SpeechToDiscord(rate)
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
                    sentences, buffer = phone_bridge.split_sentences(buffer)
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
            logger.warning("discord voice: a sentence could not be spoken")

    async def _send_frames(self, frames: list) -> None:
        for frame in frames:
            now = self.clock()
            if self.pace and self.play_end - now > LEAD_SECONDS:
                await self.sleep(self.play_end - now - LEAD_SECONDS)
            result = self.send(self.codec.encode(frame))
            if inspect.isawaitable(result):
                await result
            self.sent_frames += 1
            self.play_end = max(self.play_end, self.clock()) + audio.FRAME_SECONDS

    # -- interruption and the end ----------------------------------------------------------------------

    async def _barge_in(self) -> None:
        self.backchannel = False
        await self._cancel_turn(spoken=True)
        result = self.clear()
        if inspect.isawaitable(result):
            await result
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
            logger.exception("discord voice: closing the call failed")


# -- Discord itself, behind one seam --------------------------------------------------------------------------

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
               sleep: Callable = asyncio.sleep, pace: bool = True) -> str:
    """Join the Discord bot's voice channel for a call with the account's own person, and DM them the link.
    Raises VoiceRefused with the reason in words. Returns what to tell the caller."""
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
                          channel_name=name, loop=loop, queue=queue, transport=None, task=None, bridge=None)
        transport = HOST.transport(client, channel, user_id)
        await transport.connect(session.post)
        session.transport = transport
        with accounts.as_account(account):
            pipeline = await (PIPELINE_FACTORY or _live_pipeline)(account, agent, bot)
            from core import turn_detect
            smart = turn_detect.ready()[0] if PIPELINE_FACTORY is None else False
            name_for_speech = agent.get("name") or "Kairos"
            opening = (f"{disclosure(name_for_speech)} {reason}".strip() if reason
                       else f"{disclosure(name_for_speech)} How can I help?")
            session.bridge = VoiceBridge(pipeline, linked_user=user_id, send=transport.send, clear=transport.clear,
                                         codec=CODEC_FACTORY(), opening=opening, smart_turn=smart,
                                         present=user_id in transport.members(), clock=clock, sleep=sleep, pace=pace)
            session.task = asyncio.create_task(_run(session))
        _sessions[bot_id] = session
        _last_join[account] = now
        link = f"https://discord.com/channels/{guild_id}/{channel.id}"
        text = f"I'm in #{name}. Join me: {link}"
        if reason:
            text += f"\n{reason}"
        try:
            await HOST.dm(client, user_id, text)
        except Exception:
            logger.exception("discord voice: could not DM the link")
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
    return f"Joined #{name} and sent you the link. Carry on there."


async def _run(session: Session) -> None:
    try:
        reason = await session.bridge.run(session.queue)
        logger.info("discord voice: left #%s (%s)", session.channel_name, reason)
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
    from services.agent_service import agent_service
    text = " ".join(str(reason or "").replace("\x00", " ").split())[:phone_calls.MAX_MESSAGE]
    with accounts.as_account(account):
        agent = agent_service.get(agent_id)
    if not agent:
        raise VoiceRefused("That bot is not one of yours.")
    bot = pick_bot(account)
    return await join(account, bot, agent, text, invocation_id=invocation_id)


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
