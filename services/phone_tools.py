"""Bot tools that reach the person (build spec step 8, and Reach me in the 2.3.0 plan): a message, a call or a text to
the account the bot works for. Where it goes is the person's choice in Settings > Reach me (core/reach_me.py,
services/reach_me.py); a number or chat is never an argument, so a bot (or a prompt injected into one) cannot reach
anyone else. The names carry a send word ("message", "notify", "ring") so the approval levels classify every one as an
outbound send (core/bot_policy.py). The five that only reach the person themselves (message_me, ring_me,
ask_me_by_call, notify_me_by_call, notify_me_by_text) are on bot_policy.SELF_ONLY_TOOLS and go ahead without asking,
bounded by the daily limits, quiet hours and cooldowns applied here and in services/phone_calls.py; dial_someone
still asks.
"""
from core import phone_connection  # noqa: F401  (tests patch phone_tools.phone_connection)
from services import call_ask, outbound_calls, phone_calls, reach_me, rings  # noqa: F401

_MESSAGE = {"type": "object", "additionalProperties": False, "required": ["message"],
            "properties": {"message": {"type": "string", "minLength": 1, "maxLength": phone_calls.MAX_MESSAGE}}}


def _scope(ctx, args, prefix: str):
    from core import accounts
    from core.tool_registry import _bot_scope
    scope = _bot_scope(ctx)
    text = args.get("reason") or args.get("message")
    ident = ctx.invocation_id or f"{prefix}-{scope['bot_id']}-{abs(hash(str(text)))}"
    return accounts.effective_account(), scope["bot_id"], text, ident


async def _run(args, ctx, action):
    try:
        account, bot_id, text, ident = _scope(ctx, args, "phone")
        return await action(account, bot_id, text, ident)
    except (phone_calls.PhoneRefused, reach_me.ReachRefused) as error:
        return f"Not sent: {error}"
    except (ValueError, KeyError) as error:
        return f"Not sent: {error}"


async def tool_call(args, ctx):
    """notify_me_by_call: the person's call order in Reach me (a phone call, an in-app ring, Discord voice, a
    Telegram voice message), the first that is set up."""
    return await _run(args, ctx, reach_me.call_me)


async def tool_ring(args, ctx):
    """ring_me: the same call order as notify_me_by_call."""
    return await _run(args, ctx, reach_me.call_me)


async def tool_ask(args, ctx):
    """ask_me_by_call: one question by call through the Reach me call order; the spoken answer comes back as text."""
    async def action(account, bot_id, text, ident):
        return await call_ask.ask_me(account, bot_id, text, ident, args.get("wait_seconds"))
    return await _run({"reason": args.get("question")}, ctx, action)


async def tool_message(args, ctx):
    """message_me: the person's message order in Reach me, with fallback, through the durable outbox."""
    return await _run(args, ctx, reach_me.message_me)


async def tool_text(args, ctx):
    from core import reach_me as reach_settings
    try:
        account, _bot_id, _text, _ident = _scope(ctx, args, "phone")
        held = reach_settings.quiet_until(account)
    except (ValueError, KeyError) as error:
        return f"Not sent: {error}"
    if held:
        return (f"Not sent: it is the person's quiet hours until {reach_settings.clock(held, account)} their time. "
                "Use message_me instead; it waits until then.")
    return await _run(args, ctx, phone_calls.text_user)


async def tool_dial(args, ctx):
    """Phone someone else for the person (step 9). The person has approved this exact call at the gate already
    (dial_someone is an explicit-review tool: core/permissions.py asks every time, at every level)."""
    from core import accounts
    from core.tool_registry import _bot_scope
    try:
        scope = _bot_scope(ctx)
        ident = ctx.invocation_id or f"dial-{scope['bot_id']}-{abs(hash(str(args.get('to')) + str(args.get('goal'))))}"
        return await outbound_calls.place(accounts.effective_account(), scope["bot_id"], args.get("to"), args.get("who"),
                                          args.get("topic"), args.get("goal"), ident, thread_id=ctx.session_id)
    except outbound_calls.CallRefused as error:
        return f"Not called: {error}"
    except (ValueError, KeyError) as error:
        return f"Not called: {error}"


_DIAL = {"type": "object", "additionalProperties": False, "required": ["to", "who", "topic", "goal"],
         "properties": {"to": {"type": "string", "minLength": 7, "maxLength": 40,
                               "description": "The number, with its country code, such as +15551234567."},
                        "who": {"type": "string", "minLength": 1, "maxLength": outbound_calls.LIMITS["who"],
                                "description": "Who you are calling, such as Luigi's Trattoria."},
                        "topic": {"type": "string", "minLength": 1, "maxLength": outbound_calls.LIMITS["topic"],
                                  "description": "A few words said at the start of the call, such as a dinner reservation."},
                        "goal": {"type": "string", "minLength": 1, "maxLength": outbound_calls.LIMITS["goal"],
                                 "description": "Your private brief: what to get done, the details you may share, and what to ask the person about."}}}

_REASON = {"type": "object", "additionalProperties": False, "required": ["reason"],
           "properties": {"reason": {"type": "string", "minLength": 1, "maxLength": rings.MAX_REASON}}}

_ASK = {"type": "object", "additionalProperties": False, "required": ["question"],
        "properties": {"question": {"type": "string", "minLength": 1, "maxLength": call_ask.MAX_QUESTION,
                                    "description": "The one question to ask, as you would say it."},
                       "wait_seconds": {"type": "integer", "minimum": call_ask.WAIT_MIN, "maximum": call_ask.WAIT_MAX,
                                        "description": f"How long to wait for the answer, {call_ask.WAIT_MIN} to {call_ask.WAIT_MAX} seconds (default {call_ask.WAIT_DEFAULT})."}}}

_CALLS_FOLLOW = ("It goes the way the person chose in Settings > Reach me, in their order: a real phone call to their own "
                 "mobile, a ring inside Kairos, their Discord voice channel, or a Telegram voice message (Telegram bots "
                 "cannot call). ")

TOOLS = [
    {"name": "message_me", "effect": "external", "handler": tool_message, "schema": _MESSAGE,
     "description": ("Send the person a short message where they want bots to reach them: the apps they chose in "
                     "Settings > Reach me, in their order (the Kairos app, Telegram, Discord, WhatsApp, iMessage, Signal "
                     "or SMS), falling back to the next one that works. Use it for a finished job, something they asked "
                     "to hear about, or anything they should see soon but that is not urgent enough for a call. One or "
                     "two plain sentences; it is signed with your name. During their quiet hours it waits until they end. "
                     "Only the person themselves can be messaged, with a daily limit. The result says where it went; do "
                     "not send the same message again.")},
    {"name": "ring_me", "effect": "external", "handler": tool_ring, "schema": _REASON,
     "description": ("Call the person, for something urgent or time-sensitive, or when they asked 'call me when it's ready'. "
                     + _CALLS_FOLLOW + "The reason is one short line they see or hear first. An in-app ring lasts a "
                     "minute and the result tells you if they answered, declined or missed it; a missed ring tries the next way "
                     "in their order, and if nothing is answered they get a missed-call note, so do not call again. No calls "
                     "during their quiet hours. Only the person themselves can be called, a few times a day.")},
    {"name": "ask_me_by_call", "effect": "external", "handler": tool_ask, "schema": _ASK,
     "description": ("Ask the person one short question by call and get their spoken answer back as text, for a quick "
                     "decision or approval you cannot wait on. " + _CALLS_FOLLOW + "The call opens by saying who you are "
                     "and asks the question; the first thing they say is the answer, transcribed, and the call then ends. "
                     "The tool waits for it (2 minutes by default). Not answered: you are told, and should ask by "
                     "message_me instead. Counts as a call to them: no calls during quiet hours, a few a day.")},
    {"name": "notify_me_by_call", "effect": "external", "handler": tool_call, "schema": _MESSAGE,
     "description": ("Call the person about something urgent or time-sensitive, or because they asked 'call me when it's "
                     "ready'. " + _CALLS_FOLLOW + "Say in the message what the call is about, in one or two sentences; a "
                     "call opens by saying who you are and that you are an AI assistant, then the message. No calls "
                     "during their quiet hours. Only the person themselves can be called, a few times a day.")},
    {"name": "dial_someone", "effect": "external", "handler": tool_dial, "schema": _DIAL,
     "description": ("Phone someone else for the person, such as a restaurant, a shop or a client, when they asked you to. "
                     "The person approves every call before it is placed. The call opens by saying you are an AI assistant "
                     "calling on their behalf, that the call is transcribed, and the topic. During the call you talk with the "
                     "other party yourself and can ask the person a question; they watch a live transcript. The tool returns "
                     "once the call is placed; the summary arrives in this conversation when it ends. Needs Calls to other "
                     "people turned on in Settings > Phone. A few calls a day, between 8 am and 9 pm, never to numbers that "
                     "asked not to be called. Not for marketing.")},
    {"name": "notify_me_by_text", "effect": "external", "handler": tool_text, "schema": _MESSAGE,
     "description": ("Send an SMS text to the person's own mobile number, only when they asked for a text message "
                     "specifically; otherwise use message_me, which goes where they prefer. Only their own number can be "
                     "texted, with a daily limit shared with message_me. Needs their Phone connection or SMS connector.")},
]
