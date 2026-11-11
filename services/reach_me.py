"""Reach me: how a bot messages or calls the person, through the order they chose (core/reach_me.py), with fallback.

message_me (a bot's tool): the message is queued in the durable outbox (core/outbox.py) on the channel
"reach:<bot id>", then sent at once, or when the person's quiet hours end. Sending walks the bot's message order: each
way that is set up is tried in turn, and the first that takes it wins; the ones skipped and why are recorded (never
the text). When every way fails and "In the app" is in the order, the message is left in the app's notification feed
instead, so it is never lost; with no app in the order the outbox tries the whole order again later (1, 5, 15, 60
minutes, for a day).

Calls (ring_me, notify_me_by_call): the call order, at once, no queue. A real phone call (the person's Twilio or Telnyx
number), an in-app ring, a Discord voice channel, or a Telegram voice message (Telegram bots cannot call). A way that is
not set up, or whose provider refused, falls to the next; a daily limit, a pause between calls or one call already
ringing is reported to the bot and never worked around on another channel.

Limits: message_me counts against the same daily "texts to you" allowance as notify_me_by_text (services/phone_calls.py
CAPS, per bot and per account); each call way keeps its own. The approval levels (core/bot_policy.py) treat every one
of these tools as a send. STOP on any channel (core/reach_me.py) refuses all of it until START.
"""
import contextvars
import logging
import time
import uuid
from typing import Optional

from core import accounts, bot_outbound, reach_me as settings
from services import phone_calls

logger = logging.getLogger(__name__)

MAX_MESSAGE = phone_calls.MAX_MESSAGE
PRESENCE_SECONDS = 15 * 60
CONNECTOR_KINDS = {"telegram": "telegram", "whatsapp": "whatsapp", "imessage": "bluebubbles", "signal": "signal"}
_result: contextvars.ContextVar = contextvars.ContextVar("reach_result", default=None)


class ReachRefused(Exception):
    """A message or call Kairos will not send; shown to the bot as-is."""


class Skip(Exception):
    """This way cannot take it; the next one is tried."""


class Final(Exception):
    """A limit or conflict on this way: report it, do not try another."""


class Unanswered(Skip):
    """The call reached the person but nobody picked up in time (a missed ring, an empty Discord channel): the next way
    in the order is tried, and if none picks up the bot is told they did not answer."""


def _owner(account: str) -> str:
    return settings.owner_of(account)


def _bot(account: str, bot_id: str, strict: bool = True) -> dict:
    """The account's own bot. Calls pass strict=False: each call way checks the bot itself (rings, phone, Discord)."""
    from services.agent_service import agent_service
    with accounts.as_account(account):
        bot = agent_service.get(bot_id)
    if not bot:
        if strict:
            raise ReachRefused("That bot is not one of yours.")
        return {"id": bot_id, "name": ""}
    return bot


def _clean(text, limit: int = MAX_MESSAGE) -> str:
    cleaned = " ".join(str(text or "").replace("\x00", " ").split())
    if not cleaned:
        raise ReachRefused("Say what the message is about.")
    return cleaned[:limit]


# -- what is set up --------------------------------------------------------------------------------------------

def _connector(kind: str):
    """(record, where deliveries go) for the account's first enabled connector of this kind, else (None, '')."""
    from core.connectors import KINDS, store
    cls = KINDS.get(kind)
    if not cls:
        return None, ""
    for record in store.list_records():
        if record["kind"] == kind and record.get("enabled") and store.mine(record):
            target = str((record.get("settings") or {}).get(cls.target_field or "") or "").strip()
            if target:
                return record, target
    return None, ""


def _adapter(record: dict):
    from core.connectors import hub
    return hub.adapters.get(record["id"]) or hub.build(record)


def _app_reachable(account: str) -> tuple:
    """(ready, detail): someone will see an in-app message: a phone with Kairos notifications on, or a Kairos window
    open in the last few minutes."""
    owner = _owner(account)
    try:
        from core import mobile_activity
        devices = [d for d in mobile_activity.devices(owner) if (d.get("preferences") or {}).get("bot_results", True)]
    except Exception:
        devices = []
    try:
        from services import bot_chat_service
        seen = (bot_chat_service.presence_of(owner) or {}).get("at") or 0
    except Exception:
        seen = 0
    if devices:
        return True, f"Notifications on {len(devices)} device{'s' if len(devices) != 1 else ''}, and in the app's feed."
    if time.time() - seen < PRESENCE_SECONDS:
        return True, "A Kairos window is open. No phone has Kairos notifications on."
    return False, "No phone has Kairos notifications on and no Kairos window is open."


def _discord_dm_ready() -> tuple:
    from core import discord_bots_store
    from core.channels import discord_channel
    mine = [b for b in discord_bots_store.list_bots() if discord_bots_store.mine(b)]
    if not mine:
        return False, "No Discord bot is set up (Settings > Channels)."
    if not any(b.get("allowed_user_id") for b in mine):
        return False, "Your Discord bot has no allowed user to DM."
    if not any(b["id"] in discord_channel._clients for b in mine if b.get("allowed_user_id")):
        return False, "Your Discord bot is not connected right now."
    return True, "DMs your Discord account."


def message_status(account: Optional[str] = None) -> list:
    account = account or accounts.effective_account()
    rows = []
    with accounts.as_account(account):
        for channel in settings.MESSAGE_CHANNELS:
            if channel == "app":
                ready, detail = _app_reachable(account)
            elif channel == "discord":
                ready, detail = _discord_dm_ready()
            elif channel == "sms":
                target, sms = phone_calls.text_target(account)
                ready = bool(target)
                detail = (f"Texts {target} through {'your SMS connector' if sms else 'your Phone connection'}." if target
                          else "No Phone connection or SMS connector (Settings > Phone or Channels).")
            else:
                record, target = _connector(CONNECTOR_KINDS[channel])
                ready = bool(record)
                detail = (f"Sends to {target} through \"{record['name']}\"." if record else
                          f"No {settings.MESSAGE_LABELS[channel]} channel with a place to notify you (Settings > Channels).")
                if channel == "whatsapp" and record:
                    template = ((record.get("settings") or {}).get("template_name") or "").strip()
                    detail += (f" Outside the 24-hour window it sends your template \"{template}\"." if template else
                               " No template set, so after 24 hours without a message from you it is skipped.")
            rows.append({"id": channel, "label": settings.MESSAGE_LABELS[channel], "ready": ready, "detail": detail})
    return rows


def _phone_ready(account: str) -> bool:
    from core import phone_connection
    try:
        record = phone_connection.get(account)
    except Exception:
        record = None
    return bool(record and record.get("enabled") and phone_connection.calls_ready(record))


def _telegram_voice_ready() -> tuple:
    record, _ = _connector("telegram")
    if not record:
        return False, "No Telegram channel with a place to notify you (Settings > Channels)."
    from core import call_voices, ffmpeg_tools
    if not call_voices.configuration().get("url"):
        return False, "Voice messages need a voice set up in Settings > Speech."
    if not ffmpeg_tools.find():
        return False, "Voice messages need FFmpeg, which isn't installed."
    return True, "Sends a voice message in the bot's voice. Telegram bots cannot place calls."


def call_status(account: Optional[str] = None) -> list:
    account = account or accounts.effective_account()
    rows = []
    with accounts.as_account(account):
        for channel in settings.CALL_CHANNELS:
            if channel == "phone":
                ready = _phone_ready(account)
                detail = ("Rings your mobile like any call, even when it is locked." if ready else
                          "Needs a Phone connection with a public address (Settings > Phone).")
            elif channel == "app":
                ready, detail = True, ("Rings any open Kairos window. On a phone it is a notification, not a call "
                                       "screen, and only if Kairos notifications are on.")
            elif channel == "discord":
                from services import discord_voice
                try:
                    discord_voice.pick_bot(account)
                    ready, detail = True, "Joins your Discord voice channel and DMs you a link."
                except discord_voice.VoiceRefused as error:
                    ready, detail = False, str(error)
                except Exception:
                    ready, detail = False, "Discord voice is not available here."
            else:
                ready, detail = _telegram_voice_ready()
            rows.append({"id": channel, "label": settings.CALL_LABELS[channel], "ready": ready, "detail": detail})
    return rows


# -- messages -----------------------------------------------------------------------------------------------------

async def _send_on(account: str, channel: str, bot: dict, text: str) -> str:
    """Send on one way, or raise Skip with why not. Returns a short note on what went, or ''."""
    from core.connectors.base import ConnectorError
    name = bot.get("name") or "Your bot"
    if channel == "app":
        ready, detail = _app_reachable(account)
        if not ready:
            raise Skip(detail)
        _leave_in_app(account, bot, text)
        return ""
    if channel == "discord":
        ready, detail = _discord_dm_ready()
        if not ready:
            raise Skip(detail)
        from core.channels import discord_channel
        if not await discord_channel.send_direct_message(f"**{name}**: {text}"):
            raise Skip("Discord did not take the message.")
        return ""
    if channel == "sms":
        if not phone_calls.text_target(account)[0]:
            raise Skip("No Phone connection or SMS connector.")
        try:
            await phone_calls.send_text(account, f"{name}: {text}")
        except (phone_calls.ProviderError, ConnectorError, phone_calls.PhoneRefused) as error:
            raise Skip(f"The text was refused: {error}") from None
        return ""
    record, target = _connector(CONNECTOR_KINDS[channel])
    if not record:
        raise Skip(f"No {settings.MESSAGE_LABELS[channel]} channel is set up.")
    adapter = _adapter(record)
    try:
        if channel == "whatsapp":
            how = await adapter.send(target, text, bot_name=name)
            return "as your approved template" if how == "template" else ""
        await adapter.send(target, f"{name}: {text}")
    except ConnectorError as error:
        raise Skip(str(error)) from None
    except Exception as error:
        raise Skip(f"{settings.MESSAGE_LABELS[channel]} failed ({type(error).__name__}).") from None
    return ""


def _leave_in_app(account: str, bot: dict, text: str) -> None:
    """The app's notification feed, and a push to the person's own devices (generic text, as every bot push)."""
    from core import bot_attention_store, mobile_activity
    from services import bot_attention
    owner = _owner(account)
    with accounts.as_account(account):
        try:
            target = bot_attention.target_for(bot["id"], owner, {})
        except Exception:
            target = None
        bot_attention_store.publish(owner, "reach:" + uuid.uuid4().hex, {
            "kind": "message", "agent_id": bot["id"], "title": f"Message from {bot.get('name') or 'your bot'}",
            "body": text[:2000], "target": target, "at": time.time()})
        try:
            mobile_activity.enqueue_bot("bot_results", bot["id"], lambda who: who == owner)
        except Exception:
            logger.exception("reach me: the push was not queued")


async def deliver(account: str, bot_id: str, text: str) -> dict:
    """Walk the bot's message order now. {ok, channel, note, tried: [{channel, reason}]}; logged without the text."""
    bot = _bot(account, bot_id)
    order = settings.order_for(bot_id, "message", account)
    tried, result = [], None
    with accounts.as_account(account):
        for channel in order:
            try:
                note = await _send_on(account, channel, bot, text)
                result = {"ok": True, "channel": channel, "note": note}
                break
            except Skip as why:
                tried.append({"channel": channel, "reason": str(why)})
        if result is None and "app" in order:
            _leave_in_app(account, bot, text)        # never lost: the feed holds it until they open Kairos
            result = {"ok": True, "channel": "app", "note": "left in the app; nothing else in the order took it"}
    result = result or {"ok": False, "channel": None, "note": ""}
    result["tried"] = tried
    settings.log({"kind": "message", "bot_id": bot_id, "bot_name": bot.get("name") or "", "ok": result["ok"],
                  "channel": result["channel"], "note": result["note"], "tried": tried}, account)
    return result


async def outbox_send(bot_id: str, text: str) -> bool:
    """The outbox's sender for channel "reach:<bot id>" (core/channels/registry.py), as the row's account."""
    account = accounts.effective_account()
    box = _result.get()
    if settings.paused(account):
        # STOP came after it was queued: it is dropped, not sent and not retried.
        settings.log({"kind": "message", "bot_id": bot_id, "ok": False, "channel": None, "note": "dropped: you replied STOP",
                      "tried": []}, account)
        if box is not None:
            box.update({"ok": False, "paused": True})
        return True
    try:
        result = await deliver(account, bot_id, text)
    except ReachRefused as error:
        result = {"ok": False, "channel": None, "tried": [{"channel": "", "reason": str(error)}]}
    if box is not None:
        box.update(result)
    return result["ok"]


def _channel_label(channel: Optional[str]) -> str:
    return settings.MESSAGE_LABELS.get(channel or "", channel or "")


def _skipped(tried: list) -> str:
    return "; ".join(f"{_channel_label(t['channel']) or 'Kairos'}: {t['reason']}" for t in tried)


async def message_me(account: str, bot_id: str, message, invocation_id: str) -> str:
    """A bot's message_me: through the person's Reach me order, now or after quiet hours."""
    from core import outbox
    settings.refuse_if_paused(account, ReachRefused)
    text = _clean(message)
    bot = _bot(account, bot_id)
    order = settings.order_for(bot_id, "message", account)
    if not order:
        raise ReachRefused("The person turned off messages from this bot in Settings > Reach me.")
    ready = {row["id"]: row for row in message_status(account)}
    if not any(ready[c]["ready"] for c in order) and "app" not in order:
        raise ReachRefused("None of the ways the person chose in Settings > Reach me is set up: "
                           + "; ".join(f"{ready[c]['label']}: {ready[c]['detail']}" for c in order))
    try:
        taken = phone_calls._reserve(account, bot_id, "text", invocation_id)
    except phone_calls.PhoneRefused as error:
        raise ReachRefused(str(error).replace("texts to you", "messages to you")) from None
    held = settings.quiet_until(account)
    with accounts.as_account(account):
        delivery = outbox.enqueue(f"reach:{bot_id}:{invocation_id}", f"reach:{bot_id}", text,
                                  label=f"{bot.get('name') or 'A bot'}'s message to you", not_before=held, send=False)
    phone_calls._settle(account, taken, invocation_id, bot_outbound.COMMITTED)     # queued durably: it will be sent
    if held:
        settings.log({"kind": "message", "bot_id": bot_id, "bot_name": bot.get("name") or "", "ok": True, "channel": None,
                      "note": f"held for quiet hours until {settings.clock(held, account)}", "tried": []}, account)
        return (f"Queued. It is the person's quiet hours, so it goes at {settings.clock(held, account)} their time, "
                "the first way in their Reach me order that works.")
    box = {}
    token = _result.set(box)
    try:
        with accounts.as_account(account):
            row = await outbox.send_one(delivery)
    finally:
        _result.reset(token)
    if box.get("ok"):
        note = f" ({box['note']})" if box.get("note") else ""
        skipped = f" Skipped first: {_skipped(box['tried'])}." if box.get("tried") else ""
        return f"Sent to the person: {_channel_label(box['channel'])}{note}.{skipped}"
    if box.get("paused"):
        return "Not sent: the person paused messages from bots."
    if not box and row and row.get("status") == "delivered":
        return "Already sent to the person. Do not send it again."
    if row and row.get("status") == "pending":
        return (f"Not delivered yet ({_skipped(box.get('tried') or [])}). Kairos tries the same order again in a "
                "minute, and keeps trying for a day. Do not send it again.")
    return f"Not delivered: {_skipped(box.get('tried') or []) or 'the message could not be sent'}."


# -- calls --------------------------------------------------------------------------------------------------------

async def _call_on(account: str, channel: str, bot: dict, reason: str, invocation_id: str) -> str:
    from services import discord_voice, rings
    if channel == "phone":
        if not _phone_ready(account):
            raise Skip("No Phone connection with a public address.")
        try:
            return await phone_calls.call_user(account, bot["id"], reason, invocation_id)
        except phone_calls.PhoneLimit as error:
            raise Final(str(error)) from None
        except phone_calls.PhoneRefused as error:
            raise Skip(str(error)) from None
    if channel == "app":
        try:
            return await rings.ring_user(account, bot["id"], reason, invocation_id, escalate=True)
        except rings.RingUnanswered as error:
            raise Unanswered(str(error)) from None        # missed: the next way in the order (2026-11-10)
        except rings.RingRefused as error:
            raise Final(str(error)) from None
    if channel == "discord":
        try:
            discord_voice.pick_bot(account)        # not set up here: the next way, before anything is spent
        except discord_voice.VoiceRefused as error:
            raise Skip(str(error)) from None
        try:
            return await discord_voice.call_user(account, bot["id"], reason, invocation_id)
        except discord_voice.VoiceRefused as error:
            if error.missed:
                raise Unanswered(str(error)) from None
            if error.unavailable:
                raise Skip(str(error)) from None
            raise Final(str(error)) from None
    return await _telegram_voice(account, bot, reason, invocation_id)


async def _telegram_voice(account: str, bot: dict, reason: str, invocation_id: str) -> str:
    """The "call" on Telegram: the message spoken in the bot's voice, as a voice message, with the text as caption.
    Counts against the daily texts-to-you allowance."""
    from core import reach_voice
    from core.connectors.base import ConnectorError
    ready, detail = _telegram_voice_ready()
    if not ready:
        raise Skip(detail)
    record, target = _connector("telegram")
    name = bot.get("name") or "Your bot"
    spoken = f"{phone_calls.disclosure(name)} {reason}"
    try:
        ogg, seconds = await reach_voice.voice_message(spoken, bot.get("voice_id"))
    except reach_voice.VoiceUnavailable as error:
        raise Skip(str(error)) from None
    ident = invocation_id + ":telegram"
    try:
        taken = phone_calls._reserve(account, bot["id"], "text", ident)
    except phone_calls.PhoneRefused as error:
        raise Final(str(error).replace("texts to you", "messages to you")) from None
    try:
        await _adapter(record).send_voice(target, ogg, seconds, caption=f"{name}: {reason}")
    except ConnectorError as error:
        phone_calls._settle(account, taken, ident, bot_outbound.RELEASED)
        raise Skip(f"Telegram refused the voice message: {error}") from None
    except Exception as error:
        phone_calls._settle(account, taken, ident, bot_outbound.UNCERTAIN)
        raise Skip(f"Telegram may not have taken the voice message ({type(error).__name__}).") from None
    phone_calls._settle(account, taken, ident, bot_outbound.COMMITTED)
    return (f"Sent a {round(seconds)} second Telegram voice message (Telegram bots cannot place calls). "
            "You will not hear back unless they reply.")


async def call_me(account: str, bot_id: str, reason, invocation_id: str, ask: bool = False):
    """ring_me and notify_me_by_call: the bot's call order. Raises ReachRefused. A way that rang but was not picked up
    (a missed ring, nobody joining the Discord channel) falls to the next way, like one that is not set up; when the
    order runs out after one of those, the bot is told they did not answer.

    `ask` (services/call_ask.py) returns a dict instead: {ok, message, channel, label, one_way}, where `one_way` marks a
    way that cannot carry a spoken answer back (a Telegram voice message)."""
    settings.refuse_if_paused(account, ReachRefused)
    text = _clean(reason)
    bot = _bot(account, bot_id, strict=False)
    order = settings.order_for(bot_id, "call", account)
    if not order:
        raise ReachRefused("The person turned off calls from this bot in Settings > Reach me.")
    held = settings.quiet_until(account)
    if held:
        raise ReachRefused(f"It is the person's quiet hours until {settings.clock(held, account)} their time, so no "
                           "calls. Use message_me instead; it waits until then.")
    tried, missed = [], []
    with accounts.as_account(account):
        for channel in order:
            try:
                outcome = await _call_on(account, channel, bot, text, invocation_id)
            except Unanswered as why:
                tried.append({"channel": channel, "reason": str(why)})
                missed.append(channel)
                continue
            except Skip as why:
                tried.append({"channel": channel, "reason": str(why)})
                continue
            except Final as why:
                tried.append({"channel": channel, "reason": str(why)})
                settings.log({"kind": "call", "bot_id": bot_id, "bot_name": bot.get("name") or "", "ok": False,
                              "channel": channel, "note": "", "tried": tried}, account)
                raise ReachRefused(str(why)) from None
            settings.log({"kind": "call", "bot_id": bot_id, "bot_name": bot.get("name") or "", "ok": True,
                          "channel": channel, "note": "", "tried": tried}, account)
            if ask:
                return {"ok": True, "message": outcome, "channel": channel, "label": settings.CALL_LABELS[channel],
                        "one_way": channel == "telegram"}
            return outcome
    settings.log({"kind": "call", "bot_id": bot_id, "bot_name": bot.get("name") or "", "ok": False, "channel": None,
                  "note": "not answered" if missed else "", "tried": tried}, account)
    if missed:
        ways = ", ".join(settings.CALL_LABELS[c] for c in missed)
        message = (f"They did not answer ({ways}). A missed-call note with your reason is in their inbox. Do not call "
                   "again unless they ask.")
        if ask:
            return {"ok": False, "message": message, "channel": None, "label": "", "one_way": False}
        return message
    raise ReachRefused("No way to call the person worked: " + "; ".join(
        f"{settings.CALL_LABELS[t['channel']]}: {t['reason']}" for t in tried))


def view(account: Optional[str] = None) -> dict:
    """What Settings > Reach me shows."""
    account = account or accounts.effective_account()
    data = settings.load(account)
    held = settings.quiet_until(account)
    return {"message": data["message"], "call": data["call"], "quiet": data["quiet"], "bots": data["bots"],
            "paused": data["paused"], "stops": data["stops"][-10:][::-1], "log": data["log"][-15:][::-1],
            "quiet_now": bool(held), "message_channels": message_status(account), "call_channels": call_status(account)}
