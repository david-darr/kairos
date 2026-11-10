"""Phone calls and texts between a bot and the person, through their OWN Twilio or Telnyx number (build spec step 8).

What is and is not built:
- Inbound: the person calls their number. The provider's webhook is verified (Twilio HMAC-SHA1, Telnyx ed25519, with the
  key of the account the called number belongs to), only that account's own verified mobile number is let in (anyone
  else hears a short refusal), and the call becomes a one-use stream token the provider's media stream presents.
- Outbound, to the person ONLY: a bot may call or text the verified mobile number of the account it works for. The
  number is never an argument. Every call opens "This is <bot>, an AI assistant from Kairos." Calls and texts are
  rate limited here and by the bot's own outbound allowance. Calls to anyone else (step 9, approved one by one) are
  services/outbound_calls.py; they reach this module only as webhooks and a media stream.
- Per account: the connection, its secrets and its numbers belong to one account; a webhook is routed by the number
  that was dialled; nothing runs for an account without a saved, enabled connection.

Live speech (speech-to-text, the conversation model, the voice) is reached only through LivePipeline.
"""
import asyncio
import json
import logging
import os
import secrets
import time
from typing import Optional
from urllib.parse import parse_qsl

from core import accounts, bot_outbound, phone_connection as connection
from core.phone_providers import (ProviderError, ReplayCache, SignatureError, build, parse_form, twiml_gather, twiml_say,
                                   twiml_stream)
from services import phone_bridge

logger = logging.getLogger(__name__)

TRANSPORT = None                  # tests: one mock transport for every provider request
STREAM_TTL = 90
OUTBOUND_TTL = 300
CALL_COOLDOWN_SECONDS = 300
CAPS = {"call": {"bot": 3, "account": 6}, "text": {"bot": 10, "account": 30}}   # per day
REFUSAL = "Sorry, this number is private. Goodbye."
UNAVAILABLE = "Sorry, Kairos can't take calls right now. Goodbye."
MAX_MESSAGE = 500

_tokens: dict[str, dict] = {}
_replays = ReplayCache()
_last_call: dict[str, float] = {}
_pin_failures: dict[str, list] = {}
PIN_ATTEMPTS = 3              # tries per call
PIN_LOCK_FAILURES = 5         # wrong tries per hour, per account, before inbound calls are refused
PIN_LOCK_SECONDS = 3600
PIN_PROMPT = "Please enter your PIN, then press pound."
PIN_AGAIN = "That PIN was not right. Please try again, then press pound."
PIN_GOODBYE = "Goodbye."
PIN_UNSET = "Sorry, calls need a PIN and none is set. Goodbye."


class PhoneRefused(Exception):
    """A bot's call or text that Kairos will not place; the message is shown to the bot as-is."""


def disclosure(bot_name: str) -> str:
    return f"This is {bot_name or 'a Kairos bot'}, an AI assistant from Kairos."


# -- one-use tokens ------------------------------------------------------------------------------

def mint(kind: str, account: str, ttl: float, **data) -> str:
    now = time.time()
    for key in [k for k, v in _tokens.items() if v["expires"] < now]:
        _tokens.pop(key, None)
    if len(_tokens) > 512:
        raise PhoneRefused("Too many calls are being set up at once.")
    token = secrets.token_urlsafe(24)
    _tokens[token] = {"kind": kind, "account": account, "expires": now + ttl, **data}
    return token


def redeem(token: str, kind: str) -> Optional[dict]:
    """The data behind a token, once. A used, unknown, expired or wrong-kind token gives None."""
    item = _tokens.pop(token or "", None)
    if not item or item["kind"] != kind or item["expires"] < time.time():
        return None
    return item


# -- helpers -------------------------------------------------------------------------------------

def owner_of(account: str) -> str:
    from core.auth import SINGLE_USER, auth_manager
    return auth_manager.username_for_account(account) or SINGLE_USER


def provider_for(account: str, record: dict):
    secrets_ = {key: connection.secret(record, key, account) for key in ("auth_token", "api_key")}
    return build(record, secrets_, TRANSPORT)


def bot_for(account: str, record: dict) -> Optional[dict]:
    from services import front_desk
    from services.agent_service import agent_service
    with accounts.as_account(account):
        ident = record.get("bot_id") or front_desk.bot_id()
        return agent_service.get(ident) if ident else None


def pin_attempt(account: str, record: dict, digits) -> str:
    """'ok', 'bad' or 'locked'. Five wrong tries in an hour lock inbound calls for the account, even for the right PIN.
    The digits are checked and dropped; they are never stored or logged."""
    now = time.time()
    tries = [t for t in _pin_failures.get(account, []) if t > now - PIN_LOCK_SECONDS]
    _pin_failures[account] = tries
    if len(tries) >= PIN_LOCK_FAILURES:
        return "locked"
    if connection.check_pin(record, digits):
        _pin_failures.pop(account, None)
        return "ok"
    tries.append(now)
    logger.info("phone: a wrong PIN was entered on an inbound call")
    return "locked" if len(tries) >= PIN_LOCK_FAILURES else "bad"


def pin_gate(account: str, record: dict) -> str:
    """'' when a PIN can be asked for, else the sentence to speak instead."""
    if not record.get("pin_hash"):
        return PIN_UNSET
    now = time.time()
    if len([t for t in _pin_failures.get(account, []) if t > now - PIN_LOCK_SECONDS]) >= PIN_LOCK_FAILURES:
        return REFUSAL
    return ""


def _text(status: int, text: str):
    return status, text.encode(), "text/plain"


def _xml(body: bytes):
    return 200, body, "application/xml"


# -- inbound and outbound-answered webhooks -------------------------------------------------------

async def _session(account: str, record: dict, mode: str, message: str = "") -> dict:
    """Check the call can be held at all, then mint its stream token. {'say': text} when it cannot."""
    bot = bot_for(account, record)
    if not bot:
        return {"say": UNAVAILABLE}
    problem = await live_problem(account, record, bot)
    if problem:
        return {"say": problem if mode == "inbound" else f"{disclosure(bot.get('name'))} {message}".strip()}
    return {"token": mint("stream", account, STREAM_TTL, mode=mode, message=message, bot_id=bot["id"]), "bot": bot}


def realtime_choice(account: str, bot: dict) -> Optional[dict]:
    """{'endpoint_id', 'voice'} when this bot's calls run in realtime mode (its Local | Realtime setting, a realtime
    connection chosen for it and still valid), else None. Choosing the connection is the person's paid consent."""
    mode = (bot or {}).get("call_mode")
    if mode not in ("realtime", "live"):         # "live": the older GPT-Live mode, now GPT-Live as a realtime choice
        return None
    from core import realtime_settings
    from services import realtime_session
    with accounts.as_account(account):
        chosen = realtime_settings.for_bot(bot.get("id") or "")
        offered = realtime_session.choices()
    if mode == "live":
        live = next((c for c in offered if c.get("provider") == "openai_live"), None)
        return {"endpoint_id": live["id"], "voice": None} if live else None
    return chosen if chosen["endpoint_id"] in {c["id"] for c in offered} else None


async def live_problem(account: str, record: dict, bot: dict) -> str:
    """Why a live conversation cannot start (spoken to the caller), or ''. Tests replace this."""
    from core import speech
    from services import bot_voice
    if not (record.get("conversation_endpoint_id") and record.get("conversation_model")):
        return "Phone calls need a conversation model chosen in Kairos settings. Goodbye."
    if realtime_choice(account, bot):
        return ""         # the provider hears and speaks; no local speech engine or voice is needed
    if not speech.engine_available() or not speech.installed_model():
        return "Kairos has no speech recognition set up yet. Goodbye."
    with accounts.as_account(account):
        try:
            await bot_voice.selection(bot.get("voice_id"))
        except Exception:
            return "Kairos has no local voice set up for calls yet. Goodbye."
    return ""


async def twilio_voice(headers: dict, query: str, body: bytes):
    """POST /api/phone/twilio/voice. -> (status, content, media type)."""
    params = parse_form(body)
    outbound = params.get("Direction", "").startswith("outbound")
    found = connection.find_by_number(params.get("From") if outbound else params.get("To"))
    if not found or found[1]["provider"] != "twilio" or not found[1].get("public_url"):
        return _text(403, "forbidden")
    account, record = found
    provider = provider_for(account, record)
    try:
        provider.verify_voice(provider.voice_url(query), body, headers)
    except SignatureError:
        return _text(403, "forbidden")
    if _replays.seen(("twilio", headers_get(headers, "X-Twilio-Signature"))):
        return _text(403, "replayed")
    if outbound:
        if "other" in dict(parse_qsl(query)):
            from services import outbound_calls     # a call to someone else (step 9), picked up
            return _xml(outbound_calls.twilio_answered(account, provider, query, params))
        intent = redeem(dict(parse_qsl(query)).get("out", ""), "outbound")
        if not intent or intent["account"] != account or not connection.same_number(params.get("To"), record["user_number"]):
            return _xml(twiml_say(REFUSAL))
        session = await _session(account, record, "outbound", intent["message"])      # a call Kairos placed needs no PIN
    else:
        if not connection.same_number(params.get("From"), record["user_number"]) or \
                params.get("StirVerstat", "").startswith("TN-Validation-Failed"):
            logger.info("phone: refused a call to an account's number from an unlisted caller")
            return _xml(twiml_say(REFUSAL))
        if connection.pin_required(record):
            query_values = dict(parse_qsl(query))
            blocked = pin_gate(account, record)
            if blocked:
                return _xml(twiml_say(blocked))
            if not query_values.get("pin"):
                return _xml(twiml_gather(provider.voice_url("pin=1&n=1"), PIN_PROMPT, PIN_GOODBYE))
            attempt = int(query_values["n"]) if query_values.get("n", "1").isdigit() else PIN_ATTEMPTS
            verdict = pin_attempt(account, record, params.get("Digits"))
            if verdict == "locked":
                return _xml(twiml_say(REFUSAL))
            if verdict == "bad":
                if attempt >= PIN_ATTEMPTS:
                    return _xml(twiml_say(PIN_GOODBYE))
                return _xml(twiml_gather(provider.voice_url(f"pin=1&n={attempt + 1}"), PIN_AGAIN, PIN_GOODBYE))
        session = await _session(account, record, "inbound")
    if "say" in session:
        return _xml(twiml_say(session["say"]))
    return _xml(twiml_stream(provider.stream_url(), session["token"]))


def headers_get(headers: dict, name: str) -> str:
    return next((v for k, v in headers.items() if k.lower() == name.lower()), "")


async def telnyx_event(headers: dict, body: bytes):
    """POST /api/phone/telnyx/events: Telnyx call-control events. Answers 200 once verified."""
    try:
        data = json.loads(body or b"{}").get("data") or {}
        payload, event = data.get("payload") or {}, data.get("event_type", "")
    except (ValueError, AttributeError):
        return _text(400, "bad body")
    outgoing = payload.get("direction") == "outgoing"
    found = connection.find_by_number(payload.get("from") if outgoing else payload.get("to"))
    if not found or found[1]["provider"] != "telnyx":
        return _text(403, "forbidden")
    account, record = found
    provider = provider_for(account, record)
    try:
        provider.verify_event(body, headers)
    except SignatureError:
        return _text(403, "forbidden")
    if _replays.seen(("telnyx", headers_get(headers, "telnyx-signature-ed25519"))):
        return _text(403, "replayed")
    ccid = payload.get("call_control_id", "")
    state = _decode_state(payload.get("client_state"))
    try:
        if event == "call.initiated" and not outgoing:
            if not connection.same_number(payload.get("from"), record["user_number"]):
                await provider.action(ccid, "answer", {"client_state": _encode_state("refuse")})
            elif connection.pin_required(record):
                blocked = pin_gate(account, record)
                await provider.action(ccid, "answer", {"client_state": _encode_state("say:" + blocked if blocked else "pin:1")})
            else:
                session = await _session(account, record, "inbound")
                if "say" in session:
                    await provider.action(ccid, "answer", {"client_state": _encode_state("say:" + session["say"])})
                else:
                    await provider.answer_with_stream(ccid, session["token"])
        elif event == "call.gather.ended" and state.startswith("pin:") and not outgoing:
            attempt = int(state[4:]) if state[4:].isdigit() else PIN_ATTEMPTS
            verdict = "bad"
            if connection.same_number(payload.get("from"), record["user_number"]):
                verdict = pin_attempt(account, record, payload.get("digits"))
            if verdict == "ok":
                session = await _session(account, record, "inbound")
                if "say" in session:
                    await _telnyx_say(provider, ccid, session["say"])
                else:
                    await provider.start_stream(ccid, session["token"])
            elif verdict == "locked":
                await _telnyx_say(provider, ccid, REFUSAL)
            elif attempt >= PIN_ATTEMPTS:
                await _telnyx_say(provider, ccid, PIN_GOODBYE)
            else:
                await _telnyx_gather(provider, ccid, attempt + 1, PIN_AGAIN)
        elif event == "call.answered":
            if state.startswith("pin:") and not outgoing:
                if connection.same_number(payload.get("from"), record["user_number"]):
                    await _telnyx_gather(provider, ccid, int(state[4:]) if state[4:].isdigit() else 1, PIN_PROMPT)
                else:
                    await provider.hangup(ccid)
            elif state == "refuse" or state.startswith("say:"):
                await provider.action(ccid, "speak", {"payload": state[4:] if state.startswith("say:") else REFUSAL,
                                                      "voice": "female", "language": "en-US", "client_state": _encode_state("hangup")})
            elif state.startswith("other:") and outgoing:
                from services import outbound_calls
                await outbound_calls.telnyx_answered(account, provider, ccid, state[6:], payload.get("to"))
            elif state.startswith("out:"):
                intent = redeem(state[4:], "outbound")
                if intent and intent["account"] == account and connection.same_number(payload.get("to"), record["user_number"]):
                    session = await _session(account, record, "outbound", intent["message"])
                    if "say" in session:
                        await provider.action(ccid, "speak", {"payload": session["say"], "voice": "female", "language": "en-US",
                                                               "client_state": _encode_state("hangup")})
                    else:
                        await provider.start_stream(ccid, session["token"])
                else:
                    await provider.hangup(ccid)
        elif event == "call.speak.ended" and state == "hangup":
            await provider.hangup(ccid)
    except ProviderError:
        logger.warning("phone: a Telnyx call-control action failed (event %s)", event)
    return _text(200, "ok")


async def _telnyx_say(provider, ccid: str, text: str) -> None:
    await provider.action(ccid, "speak", {"payload": text, "voice": "female", "language": "en-US",
                                          "client_state": _encode_state("hangup")})


async def _telnyx_gather(provider, ccid: str, attempt: int, prompt: str) -> None:
    await provider.action(ccid, "gather_using_speak", {
        "payload": prompt, "voice": "female", "language": "en-US", "minimum_digits": 4, "maximum_digits": 8,
        "terminating_digit": "#", "timeout_millis": 8000, "client_state": _encode_state(f"pin:{attempt}")})


def _encode_state(text: str) -> str:
    import base64
    return base64.b64encode(text.encode()).decode()


def _decode_state(value) -> str:
    import base64
    try:
        return base64.b64decode(value or "", validate=True).decode()
    except (ValueError, UnicodeDecodeError):
        return ""


# -- the media stream ------------------------------------------------------------------------------

async def serve_stream(provider_name: str, socket, pipeline_factory=None, bridge_options: Optional[dict] = None) -> str:
    """Hold one provider media stream. `socket` has `recv()` (text or None), `send(text)`, `close(code)`, `headers`
    and `query`. The first messages must include a start event carrying a one-use stream token, and (Twilio) the
    handshake must carry Twilio's signature for the account the token belongs to. Returns why it ended."""
    from core.phone_providers import KINDS
    reader = KINDS[provider_name]({}, {})
    first = None
    try:
        for _ in range(6):
            raw = await asyncio.wait_for(socket.recv(), 10)
            if raw is None:
                return "closed"
            kind, data = reader.parse_stream(raw)
            if kind == "start":
                first = data
                break
    except asyncio.TimeoutError:
        pass
    if first is None:
        await socket.close(1008)
        return "no start"
    token = first.get("token") or socket.query.get("t", "")
    session = redeem(token, "stream")
    record = None
    if session:
        record = connection.get(session["account"])
    if not session or not record or not record.get("enabled") or record["provider"] != provider_name:
        await socket.close(1008)
        return "refused"
    account = session["account"]
    provider = provider_for(account, record)
    try:
        if provider_name == "twilio":
            provider.verify_stream_handshake(socket.headers)
    except SignatureError:
        await socket.close(1008)
        return "unsigned"
    if session["mode"] == "other":
        from services import outbound_calls     # a call to someone else (step 9)
        with accounts.as_account(account):
            return await outbound_calls.serve(account, record, provider, session, first, socket, pipeline_factory, bridge_options)
    with accounts.as_account(account):
        bot = bot_for(account, record)
        if not bot:
            await socket.close(1011)
            return "no bot"
        opening = (f"{disclosure(bot.get('name'))} {session.get('message', '')}".strip() if session["mode"] == "outbound"
                   else f"Hi, it's {bot.get('name') or 'Kairos'}. How can I help?")
        chosen = realtime_choice(account, bot)
        if chosen:
            from services import realtime_phone
            pipeline = await (pipeline_factory or LivePipeline.open)(account, record, bot, session)
            try:
                bridge = realtime_phone.RealtimePhoneBridge(provider, socket.send, pipeline.call, chosen["endpoint_id"],
                                                            chosen["voice"] or "", stream_id=first.get("stream_id", ""),
                                                            opening=opening, **(bridge_options or {}))
                await bridge.run(socket.recv)
            finally:
                await pipeline.close()
            return "ended"
        factory = pipeline_factory or LivePipeline.open
        pipeline = await factory(account, record, bot, session)
        from core import turn_detect
        options = {"stream_id": first.get("stream_id", ""), "opening": opening, "smart_turn": turn_detect.ready()[0],
                   **(bridge_options or {})}
        bridge = phone_bridge.PhoneBridge(provider, socket.send, pipeline, **options)
        await bridge.run(socket.recv)
    return "ended"


class LivePipeline(phone_bridge.Pipeline):
    """The real speech, model and voice, run as the call's account."""

    def __init__(self, account: str, owner: str, record: dict, bot: dict, call: dict):
        self.account, self.owner, self.record, self.bot, self.call = account, owner, record, bot, call
        self.model = None

    @classmethod
    async def open(cls, account: str, record: dict, bot: dict, session: dict):
        from services import agent_calls
        owner = owner_of(account)
        parent = _thread_for(bot, owner)
        started = agent_calls.start(parent, bot["id"], record["conversation_endpoint_id"], record["conversation_model"], owner)
        return cls(account, owner, record, bot, agent_calls.require(started["id"], owner))

    async def transcribe(self, pcm16: bytes) -> str:
        from core import phone_audio, speech
        name = "small.en" if os.path.isfile(speech.model_path("small.en")) else speech.installed_model()
        try:
            result = await asyncio.to_thread(speech.transcribe_call, phone_audio.wav_bytes(pcm16), name, "auto")
        except speech.SpeechUnavailable:
            return ""
        return result.get("text", "")

    async def end_of_turn(self, pcm16: bytes):
        from core import phone_audio, turn_detect
        ok, _ = turn_detect.ready()
        if not ok:
            return None
        return (await asyncio.to_thread(turn_detect.predict, phone_audio.wav_bytes(pcm16)))["complete"]

    async def converse(self, text: str, request_id: str):
        from services import agent_calls
        async for event in agent_calls.turn(self.call, text, request_id):
            if event["type"] == "text":
                yield event["delta"]
            elif event["type"] == "error":
                yield "Sorry, I lost my train of thought."

    async def announce(self, text: str, request_id: str) -> None:
        from services import agent_calls
        async for _ in agent_calls.announce(self.call, text, request_id):
            pass

    async def speak(self, text: str):
        from services import bot_voice
        rate = None
        async for item in bot_voice.audio_events(text, self.bot.get("voice_id")):
            if "sample_rate" in item:
                rate = item["sample_rate"]
            elif "audio" in item and rate:
                yield rate, item["audio"]

    def note_heard(self, sentences: list) -> None:
        self._heard = list(sentences)

    def interrupt(self, spoken: bool) -> None:
        from services import agent_calls
        heard, self._heard = getattr(self, "_heard", None), None
        agent_calls.interrupt(self.call, spoken=spoken, heard=heard)

    async def filler(self, user_text: str, last):
        """A short acknowledgement in the bot's own voice, from the cache. Nothing is looked up or rendered while the
        caller waits: the first time only starts that work in the background, so a filler is never itself a delay."""
        from core import voice_fillers
        chosen = getattr(self, "_voice", None)
        if chosen is None:
            async def prepare():
                from services import bot_voice
                try:
                    self._voice = await bot_voice.selection(self.bot.get("voice_id"))
                    await voice_fillers.warm(*self._voice)
                except Exception:
                    self._voice = ()
            self._voice = ()
            self._warming = asyncio.ensure_future(prepare())
            return None
        if not chosen:
            return None
        model, voice = chosen
        ident, _text = voice_fillers.pick(last, user_text)
        found = voice_fillers.cached(model, voice, ident)
        if not found:
            return None
        rate, pcm = found

        async def parts():
            for at in range(0, len(pcm), 9600):
                yield rate, pcm[at:at + 9600]
        return ident, parts()

    def touch(self) -> None:
        self.call["last_seen"] = time.time()

    async def close(self) -> None:
        from services import agent_calls
        agent_calls.end(self.call)


def _thread_for(bot: dict, owner: str) -> str:
    """The bot's main conversation, where the call summary lands; a new one if it has none yet."""
    from services import bot_threads
    main = bot_threads.ensure_main_threads(bot["id"]).get(bot["id"])
    if main:
        return main
    thread = bot_threads.create_thread(bot, owner, title="Phone calls")
    bot_threads.claim_main_if_none(thread["id"], bot["id"])
    return thread["id"]


# -- a bot reaching the person ---------------------------------------------------------------------

def _reserve(owner: str, bot_id: str, kind: str, invocation_id: str) -> list:
    """Take one unit from the account's and the bot's daily allowance for this kind, or refuse."""
    taken = []
    for scope, who in (("account", "phone:account:" + kind), ("bot", f"phone:{bot_id}:{kind}")):
        result = bot_outbound.reserve(owner, who, invocation_id, CAPS[kind][scope], tool="phone_" + kind)
        if not result.get("ok"):
            for done in taken:
                bot_outbound.finalize(owner, done, invocation_id, bot_outbound.RELEASED)
            raise PhoneRefused(f"Today's limit for {'calls' if kind == 'call' else 'texts'} to you "
                               f"({CAPS[kind][scope]} per {'account' if scope == 'account' else 'bot'}) is used up.")
        taken.append(who)
    return taken


def _settle(owner: str, taken: list, invocation_id: str, outcome: str) -> None:
    for who in taken:
        try:
            bot_outbound.finalize(owner, who, invocation_id, outcome)
        except Exception:
            logger.exception("phone: could not settle an allowance unit")


def _clean_message(text) -> str:
    cleaned = " ".join(str(text or "").replace("\x00", " ").split())
    if not cleaned:
        raise PhoneRefused("Say what the call or text is about.")
    return cleaned[:MAX_MESSAGE]


async def call_user(account: str, bot_id: str, message, invocation_id: str) -> str:
    """A bot calls the account's own verified mobile number. Nothing else can be dialled."""
    record = connection.get(account)
    if not record or not record.get("enabled"):
        raise PhoneRefused("No Phone connection is set up for this account.")
    if not connection.calls_ready(record):
        raise PhoneRefused("Calls need the public address in the Phone settings.")
    bot = bot_for(account, {**record, "bot_id": bot_id}) or {}
    text = _clean_message(message)
    owner = account      # the allowance is the account's, whoever its user is called
    now = time.time()
    if now - _last_call.get(account, 0) < CALL_COOLDOWN_SECONDS:
        raise PhoneRefused("A call to you was placed a moment ago. Wait a few minutes before calling again.")
    taken = _reserve(owner, bot_id, "call", invocation_id)
    provider = provider_for(account, record)
    token = mint("outbound", account, OUTBOUND_TTL, message=text, bot_id=bot_id)
    try:
        if record["provider"] == "twilio":
            await provider.place_call(record["user_number"], record["number"], provider.voice_url("out=" + token))
        else:
            await provider.place_call(record["user_number"], record["number"], "out:" + token)
    except ProviderError as error:
        redeem(token, "outbound")
        _settle(owner, taken, invocation_id, bot_outbound.RELEASED)
        raise PhoneRefused(str(error)) from None
    except Exception:
        _settle(owner, taken, invocation_id, bot_outbound.UNCERTAIN)
        raise
    _last_call[account] = now
    _settle(owner, taken, invocation_id, bot_outbound.COMMITTED)
    return f"Calling you now. It will open with: {disclosure(bot.get('name'))}"


async def text_user(account: str, bot_id: str, message, invocation_id: str) -> str:
    """A bot texts the account's own mobile number: through the account's Twilio SMS connector when it has one,
    else through the Phone connection."""
    from core.connectors import hub, store
    from core.connectors.base import ConnectorError
    record = connection.get(account)
    text = _clean_message(message)
    target = (record or {}).get("user_number") if record and record.get("enabled") else ""
    with accounts.as_account(account):
        sms = next((r for r in store.list_records() if r["kind"] == "sms" and r.get("enabled") and store.mine(r)), None)
    if not target and sms:
        target = connection.normalize_number(((sms.get("settings") or {}).get("default_to")))
    if not target:
        raise PhoneRefused("No number to text is set up for this account.")
    owner = account
    taken = _reserve(owner, bot_id, "text", invocation_id)
    try:
        if sms:
            adapter = hub.adapters.get(sms["id"]) or hub.build(sms)
            await adapter.send(target, text)
        else:
            await provider_for(account, record).send_sms(target, record["number"], text)
    except (ProviderError, ConnectorError) as error:
        _settle(owner, taken, invocation_id, bot_outbound.RELEASED)    # the provider refused it: nothing left
        raise PhoneRefused(f"The text was not sent. {error}") from None
    except Exception as error:
        _settle(owner, taken, invocation_id, bot_outbound.UNCERTAIN)
        raise PhoneRefused(f"The text may not have been sent ({type(error).__name__}).") from None
    _settle(owner, taken, invocation_id, bot_outbound.COMMITTED)
    return "Text sent to your phone."
