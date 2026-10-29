"""One pending computer help request per bot, with bounded stale receipts."""
import copy
import time
import uuid
from collections import OrderedDict

from services import bot_workbench as state

_booted = False
_settled = OrderedDict()


def _boot():
    global _booted
    if not _booted:
        data = state.read_state()
        for item in data["help"].values():
            item["outcome"] = "unavailable"
        if data["help"]:
            state.save_state(data)
        _booted = True


def current(bot_id):
    with state.LOCK:
        _boot()
        return copy.deepcopy(state.read_state()["help"].get(bot_id))


def _receipt(ident):
    _settled[ident] = True
    while len(_settled) > 1000:
        _settled.popitem(last=False)


def raise_help(bot_id, reason, site=None, thread_id=None):
    from services.agent_service import agent_service
    agent = agent_service.get(bot_id)
    if not agent:
        raise KeyError(bot_id)
    state.thread_for(agent, thread_id)
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 280:
        raise ValueError("Help reason must be from 1 to 280 characters")
    if site is not None and (not isinstance(site, str) or len(site) > 253 or any(c in site for c in '/@\\\n\r')):
        raise ValueError("Invalid site")
    with state.LOCK:
        _boot()
        data = state.read_state()
        old = data["help"].get(bot_id)
        if old:
            _receipt(old["id"])
        item = {"id": uuid.uuid4().hex, "reason": reason.strip(), "site": site, "since": time.time(),
                "thread_id": thread_id, "type": "sign_in" if site else "computer_help"}
        data["help"][bot_id] = item
        state.save_state(data)
    # Tell the person, who may not have the computer panel open (the attention inbox turns this into a notification).
    from core import events
    events.emit("bot.help", f"Sign in to {site}" if site else "Take over the computer", agent_id=bot_id, session_id=thread_id,
                help_id=item["id"])
    return copy.deepcopy(item)


def settle_help(bot_id, help_id, outcome):
    from core import computer
    if outcome not in ("done", "cancel", "answer_in_chat"):
        raise ValueError("Choose Done or Cancel")
    with state.LOCK:
        item = current(bot_id)
        if not item or item["id"] != help_id:
            if help_id in _settled:
                raise ValueError("This help request was already settled or replaced")
            raise KeyError(help_id)
        if item.get("outcome"):
            raise ValueError("This help request is no longer available")
        data = state.read_state()
        data["help"].pop(bot_id, None)
        state.save_state(data)
        _receipt(help_id)
        computer.manager.hand_back("agent:" + bot_id)
        return {"id": help_id, "outcome": outcome}


def answer_in_chat(bot_id, thread_id):
    item = current(bot_id)
    if item and not item.get("outcome") and item.get("thread_id") == thread_id:
        return settle_help(bot_id, item["id"], "answer_in_chat")


def request_help(args, ctx):
    """Registry adapter: identity is entirely from the trusted tool context."""
    if not ctx.agent_id:
        raise ValueError("Computer help is available to bots")
    return raise_help(ctx.agent_id, args["reason"], args.get("site"), ctx.session_id)
