"""Bot tools that reach the person's own phone (build spec step 8): a call or a text to the verified mobile number of
the account the bot works for. The number is never an argument, so a bot (or a prompt injected into one) cannot
dial anyone else. The names carry "notify" so the approval levels treat both as outbound sends (core/bot_policy.py),
on top of the daily limits services/phone_calls.py applies itself.
"""
from core import phone_connection
from services import phone_calls, rings

_MESSAGE = {"type": "object", "additionalProperties": False, "required": ["message"],
            "properties": {"message": {"type": "string", "minLength": 1, "maxLength": phone_calls.MAX_MESSAGE}}}


async def _run(args, ctx, action):
    from core import accounts
    from core.tool_registry import _bot_scope
    try:
        scope = _bot_scope(ctx)
        account = accounts.effective_account()
        ident = ctx.invocation_id or f"phone-{scope['bot_id']}-{abs(hash(str(args.get('message'))))}"
        return await action(account, scope["bot_id"], args.get("message"), ident)
    except phone_calls.PhoneRefused as error:
        return f"Not sent: {error}"
    except (ValueError, KeyError) as error:
        return f"Not sent: {error}"


def _phone_ready() -> bool:
    from core import accounts
    try:
        record = phone_connection.get(accounts.effective_account())
    except Exception:
        record = None
    return bool(record and record.get("enabled") and phone_connection.calls_ready(record))


def _preference() -> str:
    """Settings > the ring preference: app (default) | discord | phone."""
    from core import settings as settings_store
    try:
        return settings_store.get_setting("ring_preference") or "app"
    except Exception:
        return "app"


async def _by_discord(args, ctx):
    """Join the person in their Discord voice channel. None when that is not available here (not set up, not
    installed, not connected), so the caller falls back; a limit or other refusal is returned to the bot as-is."""
    from core import accounts
    from core.tool_registry import _bot_scope
    from services import discord_voice
    try:
        scope = _bot_scope(ctx)
        message = args.get("reason") or args.get("message")
        ident = ctx.invocation_id or f"discord-{scope['bot_id']}-{abs(hash(str(message)))}"
        return await discord_voice.call_user(accounts.effective_account(), scope["bot_id"], message, ident)
    except discord_voice.VoiceRefused as error:
        return None if error.unavailable else f"Not sent: {error}"
    except (ValueError, KeyError) as error:
        return f"Not sent: {error}"


async def tool_call(args, ctx):
    """A phone call when the person prefers Discord (their voice channel) or the account has a working Phone
    connection; otherwise the free in-app ring."""
    if _preference() == "discord":
        joined = await _by_discord(args, ctx)
        if joined is not None:
            return joined
    if _phone_ready():
        return await _run(args, ctx, phone_calls.call_user)
    return await _ring_in_app(args, ctx)


async def tool_ring(args, ctx):
    """Reach the person the way they prefer (Settings): inside Kairos by default, in their Discord voice channel, or
    on their phone. Anything not available falls back to the in-app ring."""
    preference = _preference()
    if preference == "discord":
        joined = await _by_discord(args, ctx)
        if joined is not None:
            return joined
    elif preference == "phone" and _phone_ready():
        return await _run(args, ctx, phone_calls.call_user)
    return await _ring_in_app(args, ctx)


async def _ring_in_app(args, ctx):
    """Ring the person inside Kairos (phone and desktop), and say how it ended."""
    from core import accounts
    from core.tool_registry import _bot_scope
    try:
        scope = _bot_scope(ctx)
        account = accounts.effective_account()
        message = args.get("reason") or args.get("message")
        ident = ctx.invocation_id or f"ring-{scope['bot_id']}-{abs(hash(str(message)))}"
        return await rings.ring_user(account, scope["bot_id"], message, ident)
    except rings.RingRefused as error:
        return f"Not sent: {error}"
    except (ValueError, KeyError) as error:
        return f"Not sent: {error}"


async def tool_text(args, ctx):
    return await _run(args, ctx, phone_calls.text_user)


_REASON = {"type": "object", "additionalProperties": False, "required": ["reason"],
           "properties": {"reason": {"type": "string", "minLength": 1, "maxLength": rings.MAX_REASON}}}

TOOLS = [
    {"name": "ring_me", "effect": "external", "handler": tool_ring, "schema": _REASON,
     "description": ("Ring the person inside Kairos, on their phone and computer, like an incoming call. Use it for something "
                     "urgent or time-sensitive, or when they asked 'call me when it's ready'. The reason is one short line "
                     "they see while it rings; if they answer, the call opens with it. Free, needs no phone service. It rings "
                     "for a minute and the result tells you if they answered, declined or missed it; if not answered, they "
                     "get a missed-call note with your reason, so do not ring again. Only the person themselves can be "
                     "rung, a few times a day.")},
    {"name": "notify_me_by_call", "effect": "external", "handler": tool_call, "schema": _MESSAGE,
     "description": ("Phone the person on their own mobile number, for something urgent or time-sensitive, or because they asked "
                     "'call me when it's ready'. Say in the message what the call is about, in one or two sentences; the call "
                     "opens by saying who you are and that you are an AI assistant, then the message. Only their own number "
                     "can be called, a few times a day. Uses their Phone connection when one is set; with none, it rings them inside Kairos instead.")},
    {"name": "notify_me_by_text", "effect": "external", "handler": tool_text, "schema": _MESSAGE,
     "description": ("Send a text message to the person's own mobile number, for something they should see on their phone. "
                     "Only their own number can be texted, with a daily limit. Needs their Phone connection or SMS "
                     "connector in Settings.")},
]
