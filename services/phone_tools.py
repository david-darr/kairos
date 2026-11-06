"""Bot tools that reach the person's own phone (build spec step 8): a call or a text to the verified mobile number of
the account the bot works for. The number is never an argument, so a bot (or a prompt injected into one) cannot
dial anyone else. The names carry "notify" so the approval levels treat both as outbound sends (core/bot_policy.py),
on top of the daily limits services/phone_calls.py applies itself.
"""
from services import phone_calls

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


async def tool_call(args, ctx):
    return await _run(args, ctx, phone_calls.call_user)


async def tool_text(args, ctx):
    return await _run(args, ctx, phone_calls.text_user)


TOOLS = [
    {"name": "notify_me_by_call", "effect": "external", "handler": tool_call, "schema": _MESSAGE,
     "description": ("Phone the person on their own mobile number, for something urgent or time-sensitive, or because they asked "
                     "'call me when it's ready'. Say in the message what the call is about, in one or two sentences; the call "
                     "opens by saying who you are and that you are an AI assistant, then the message. Only their own number "
                     "can be called, a few times a day. Needs their Phone connection in Settings.")},
    {"name": "notify_me_by_text", "effect": "external", "handler": tool_text, "schema": _MESSAGE,
     "description": ("Send a text message to the person's own mobile number, for something they should see on their phone. "
                     "Only their own number can be texted, with a daily limit. Needs their Phone connection or SMS "
                     "connector in Settings.")},
]
