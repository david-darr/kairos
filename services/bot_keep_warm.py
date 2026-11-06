"""Opt-in API cache reads, driven by the single scheduler tick.

Snapshots live only in memory, never on disk. No CLI/local requests, no tool
execution, three pings per idle period. A cold response retires the snapshot.
"""
import asyncio
import copy
import json
import logging
import time

import httpx

from core import runs

log = logging.getLogger(__name__)
INTERVAL = 270
_idle = {}
_tasks = {}
_enabled = True


def eligible(bot, endpoint, usage):
    return (bot.get("cache_keep_warm") == "on" and endpoint.get("kind") == "api"
            and (usage.cache_write_tokens or 0) > 0)


def observe(bot, sid, endpoint, brain, usage, now=None):
    """Called only after a real successful turn. follow defaults to off."""
    now = time.monotonic() if now is None else now
    _idle.pop(sid, None)
    if usage is None or not eligible(bot, endpoint, usage):
        return
    messages = getattr(brain, "_messages", None)
    tools = getattr(brain, "tools", None)
    if not isinstance(messages, list) or len(json.dumps(messages)) > 2_000_000:
        return
    if len(_idle) >= 20:
        _idle.pop(next(iter(_idle)))
    from core import accounts
    try:
        account_id = accounts.effective_account()
    except accounts.NoAccount:
        return
    _idle[sid] = {"bot_id": bot["id"], "endpoint": dict(endpoint), "model": brain.model,
                  "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools),
                  "last": now, "count": 0, "account": account_id}


def _busy(bot_id, sid):
    from services.chat_service import is_busy
    from services.agent_service import agent_service
    return is_busy(sid) or any(r.get("agent_id") == bot_id for r in agent_service._reservations.values())


async def _ping(sid, state):
    from core import model_endpoints
    from core.providers.openai_compatible import _post_chat
    from services import bot_spend
    from services.agent_service import agent_service
    from core.session_manager import session_manager
    bot = agent_service.get(state["bot_id"])
    session = session_manager.get_session(sid) or {}
    endpoint = model_endpoints.get_endpoint(state["endpoint"]["id"])
    if (not bot or bot.get("cache_keep_warm") != "on" or bot.get("enabled") is False or bot.get("archived")
            or not endpoint or endpoint.get("kind") != "api" or session.get("agent_id") != bot["id"]
            or session.get("model_endpoint_id") != endpoint["id"]):
        _idle.pop(sid, None)
        return
    if _busy(bot["id"], sid) or bot_spend.budget()["near_cap"]:
        return
    bot_spend.check(bot["id"])
    base, model, key, _ = model_endpoints.resolve_runtime(endpoint["id"])
    context = runs.RunContext("task", session_id=sid, agent_id=bot["id"], endpoint_id=endpoint["id"],
                              model_kind="api", model=state["model"] or model, trigger="helper")
    tally = runs.Tally()
    try:
        # Plain API call, no tool executor and no changes to the chat brain.
        async with httpx.AsyncClient(timeout=20) as client:
            response = await _post_chat(client, base, key, {
                "model": context.model, "messages": [*state["messages"], {"role": "user", "content": "Reply OK. Do no work."}],
                "tools": state["tools"], "tool_choice": "none", "max_tokens": 1})
        event = runs.usage_event(response.get("usage"))
        if event:
            tally.add(event)
        tally.add(runs.result(event is not None))
        runs.record(context, tally, "finished")
        from core import token_usage
        if tally.usage:
            token_usage.record_usage(endpoint["id"], tally.usage)
        usage = tally.usage
        if not usage or not usage.cache_read_tokens or (usage.cache_write_tokens or 0) > usage.cache_read_tokens * .1:
            if _idle.get(sid) is state: _idle.pop(sid, None)
    except asyncio.CancelledError:
        runs.record(context, tally, "stopped")
        raise
    except Exception:
        runs.record(context, tally, "failed", detail="Cache read failed")
        if _idle.get(sid) is state: _idle.pop(sid, None)
    finally:
        state["messages"] = [] if _idle.get(sid) is not state else state["messages"]


async def tick(now=None, ping=None, busy=None):
    """Never waits for network; a bot/chat has at most one ping in flight."""
    if not _enabled: return
    now = time.monotonic() if now is None else now
    ping, busy = ping or _ping, busy or _busy
    for sid, state in list(_idle.items()):
        task = _tasks.get(sid)
        if task and not task.done(): continue
        if state["count"] >= 3:
            _idle.pop(sid, None); continue
        # The chat's own account (Multi-Account group 4): the ping, its budget and usage land there.
        from core import accounts
        with accounts.as_account(state.get("account") or accounts.local_account()):
            if now - state["last"] < INTERVAL or busy(state["bot_id"], sid): continue
            from services.bot_spend import budget
            if budget()["near_cap"]: continue
            state["last"], state["count"] = now, state["count"] + 1
            async def work(ident=sid, snapshot=state):
                try: await ping(ident, snapshot)
                except Exception: log.exception("Cache read could not start")
                finally: _tasks.pop(ident, None)
            _tasks[sid] = asyncio.create_task(work())


def start():
    global _enabled
    _enabled = True


def stop():
    global _enabled
    _enabled = False
    for task in _tasks.values(): task.cancel()
    _idle.clear()
