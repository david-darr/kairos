"""Rings: a bot rings the person inside Kairos (no phone provider). The free default for "call me".

A ring is an incoming-call invite for the account's own user and nobody else: the person is never an argument, it is the
user of the account the bot works for. It rings for RING_SECONDS. Answer opens the bot's native call (services/agent_calls.py)
with the reason as the opening context; decline or a timeout leaves a "missed call" item in the Bots notification feed with a
"Call back" action, and the bot waiting on the ring is told how it ended. Delivery: a push to the person's phones
(core/mobile_activity.enqueue_ring), and any open Kairos window polling /api/rings/pending (static/js/ringHost.js).

Limits, per day and per account's own allowance ledger (core/bot_outbound.py, the pattern services/phone_calls.py uses): a few
rings per bot, a few more per account, a pause between rings, one ringing at a time. Every ring spends a unit, answered or not.
Rings live in the account's folder (rings.json), so accounts never see each other's.
"""
import asyncio
import logging
import os
import threading
import time
import uuid
from typing import Optional

from fastapi import HTTPException

from core import accounts, bot_outbound
from core.atomic_io import read_json, write_json_atomic

logger = logging.getLogger(__name__)

RING_SECONDS = 60
MISSED_KEEP_SECONDS = 7 * 86400     # how long a missed call can be called back
COOLDOWN_SECONDS = 90               # between rings from one account
CAPS = {"bot": 3, "account": 6}     # per day
MAX_REASON = 160
MAX_KEPT = 60
RINGING, ANSWERED, DECLINED, MISSED = "ringing", "answered", "declined", "missed"
_lock = threading.RLock()


class RingRefused(Exception):
    """A ring Kairos will not place; the message is shown to the bot as-is."""


def _file(account: str) -> str:
    return os.path.join(accounts.account_dir(account), "rings.json")


def _load(account: str) -> list:
    data = read_json(_file(account), [])
    return data if isinstance(data, list) else []


def _save(account: str, rings: list) -> None:
    write_json_atomic(_file(account), rings[-MAX_KEPT:])


def owner_of(account: str) -> str:
    from core.auth import SINGLE_USER, auth_manager
    return auth_manager.username_for_account(account) or SINGLE_USER


def _clean_reason(text) -> str:
    cleaned = " ".join(str(text or "").replace("\x00", " ").split())
    if not cleaned:
        raise RingRefused("Say what the call is about, in one short line.")
    return cleaned[:MAX_REASON]


def _bot(account: str, bot_id: str, owner: str) -> dict:
    from services import bot_attention
    from services.agent_service import agent_service
    with accounts.as_account(account):
        agent = agent_service.get(bot_id)
    if not agent or (bot_attention.owner_of(agent) and not bot_attention.owns(agent, owner)):
        raise RingRefused("That bot is not one of yours.")
    return agent


def _reserve(account: str, bot_id: str, invocation_id: str) -> list:
    taken = []
    for scope, who in (("account", "ring:account"), ("bot", f"ring:{bot_id}")):
        result = bot_outbound.reserve(account, who, invocation_id, CAPS[scope], tool="ring_me")
        if not result.get("ok"):
            for done in taken:
                bot_outbound.finalize(account, done, invocation_id, bot_outbound.RELEASED)
            raise RingRefused(f"Today's limit for calls to you ({CAPS[scope]} per {scope}) is used up.")
        taken.append(who)
    return taken


def _view(ring: dict, now: float) -> dict:
    return {"id": ring["id"], "agent_id": ring["agent_id"], "bot_name": ring["bot_name"], "reason": ring["reason"],
            "created_at": ring["created_at"], "expires_at": ring["expires_at"], "status": ring["status"],
            "seconds_left": max(0, round(ring["expires_at"] - now)) if ring["status"] == RINGING else 0}


def _missed_item(account: str, ring: dict, how: str) -> None:
    """The missed-call item in the Bots notification feed, with a Call back action."""
    from core import bot_attention_store
    from services import bot_attention
    try:
        with accounts.as_account(account):
            target = bot_attention.target_for(ring["agent_id"], ring["owner"], {})
        verb = "Missed call from" if how == MISSED else "Declined call from"
        bot_attention_store.publish(ring["owner"], "ring:" + ring["id"], {
            "kind": "missed-call", "agent_id": ring["agent_id"], "title": f"{verb} {ring['bot_name']}",
            "body": ring["reason"], "target": target, "at": time.time(), "call_back": {"ring_id": ring["id"]}})
    except Exception:
        logger.exception("rings: could not leave the missed-call item")


def _close_push(ring_id: str) -> None:
    try:
        from core import mobile_activity
        mobile_activity.close_ring(ring_id)
    except Exception:
        logger.exception("rings: could not withdraw the push")


def _settle_locked(account: str, rings: list, ring: dict, status: str, now: float) -> None:
    ring["status"], ring["resolved_at"] = status, now
    _save(account, rings)
    _close_push(ring["id"])
    if status in (DECLINED, MISSED):
        _missed_item(account, ring, status)


def _sweep(account: str, rings: list, now: float) -> None:
    for ring in rings:
        if ring["status"] == RINGING and ring["expires_at"] <= now:
            _settle_locked(account, rings, ring, MISSED, now)


def create(account: str, bot_id: str, reason, invocation_id: str, now: Optional[float] = None) -> dict:
    """Start a ring for the account's own user. Raises RingRefused with the reason in words."""
    from core import reach_me
    reach_me.refuse_if_paused(account, RingRefused)
    now = time.time() if now is None else now
    owner = owner_of(account)
    agent = _bot(account, bot_id, owner)
    text = _clean_reason(reason)
    with _lock:
        rings = _load(account)
        _sweep(account, rings, now)
        existing = next((r for r in rings if r.get("invocation_id") == invocation_id and r["bot_id"] == bot_id), None)
        if existing:
            return existing     # a retried call reuses its ring, and its unit
        if any(r["status"] == RINGING for r in rings):
            raise RingRefused("A call to you is already ringing. Try again after it ends.")
        last = max((r["created_at"] for r in rings), default=0)
        if now - last < COOLDOWN_SECONDS:
            raise RingRefused("A call to you was placed a moment ago. Wait a minute or two before ringing again.")
        taken = _reserve(account, bot_id, invocation_id)
        ring = {"id": uuid.uuid4().hex, "bot_id": bot_id, "agent_id": bot_id, "bot_name": str(agent.get("name") or "A bot")[:60],
                "owner": owner, "reason": text, "created_at": now, "expires_at": now + RING_SECONDS, "status": RINGING,
                "invocation_id": invocation_id}
        rings.append(ring)
        _save(account, rings)
    for who in taken:
        bot_outbound.finalize(account, who, invocation_id, bot_outbound.COMMITTED)
    try:
        from core import mobile_activity
        mobile_activity.enqueue_ring(owner, ring)
    except Exception:
        logger.exception("rings: the push was not queued")
    return ring


def pending(account: str, user: str, now: Optional[float] = None) -> list:
    """The rings ringing for this user now (open windows poll this)."""
    now = time.time() if now is None else now
    with _lock:
        rings = _load(account)
        _sweep(account, rings, now)
        return [_view(r, now) for r in rings if r["status"] == RINGING and r["owner"] == user]


def _find(rings: list, ring_id: str, user: str) -> dict:
    ring = next((r for r in rings if r["id"] == ring_id), None)
    if not ring or ring["owner"] != user:
        raise HTTPException(404, "Call not found.")
    return ring


def answer(account: str, user: str, ring_id: str, now: Optional[float] = None) -> dict:
    """Pick up a ringing call, or call back a missed one. Returns where to go: the bot, its conversation, the reason."""
    from services import bot_attention
    now = time.time() if now is None else now
    with _lock:
        rings = _load(account)
        _sweep(account, rings, now)
        ring = _find(rings, ring_id, user)
        if ring["status"] == RINGING:
            _settle_locked(account, rings, ring, ANSWERED, now)
        elif ring["status"] in (MISSED, DECLINED) and now - ring["resolved_at"] <= MISSED_KEEP_SECONDS:
            ring["callback"] = True
            _save(account, rings)
        else:
            raise HTTPException(409, "That call has ended.")
    with accounts.as_account(account):
        target = bot_attention.target_for(ring["agent_id"], user, {})
    return {"ring_id": ring["id"], "agent_id": ring["agent_id"], "bot_name": ring["bot_name"], "reason": ring["reason"],
            "callback": bool(ring.get("callback")), "target": target}


def decline(account: str, user: str, ring_id: str, now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    with _lock:
        rings = _load(account)
        _sweep(account, rings, now)
        ring = _find(rings, ring_id, user)
        if ring["status"] != RINGING:
            raise HTTPException(409, "That call has ended.")
        _settle_locked(account, rings, ring, DECLINED, now)
    return {"ok": True}


def claim_opening(account: str, user: str, ring_id: str, agent_id: str) -> str:
    """The reason a call opens with: only for the person's own answered (or called-back) ring with this bot."""
    with _lock:
        rings = _load(account)
        ring = next((r for r in rings if r["id"] == ring_id), None)
        if (not ring or ring["owner"] != user or ring["agent_id"] != agent_id
                or not (ring["status"] == ANSWERED or ring.get("callback"))):
            raise ValueError("That call is no longer available.")
        return ring["reason"]


def outcome(account: str, ring_id: str, now: Optional[float] = None) -> str:
    now = time.time() if now is None else now
    with _lock:
        rings = _load(account)
        _sweep(account, rings, now)
        ring = next((r for r in rings if r["id"] == ring_id), None)
        return ring["status"] if ring else MISSED


async def ring_user(account: str, bot_id: str, reason, invocation_id: str, wait: bool = True) -> str:
    """What the bot's ring_me tool does: ring, then tell the bot how it ended."""
    ring = create(account, bot_id, reason, invocation_id)
    if not wait:
        return "Ringing you now."
    while True:
        state = outcome(account, ring["id"])
        if state != RINGING:
            break
        await asyncio.sleep(0.5)
    if state == ANSWERED:
        return "They answered. The call is open now, so carry on there."
    if state == DECLINED:
        return "They declined the call. A missed-call note with your reason is in their inbox. Do not ring again unless they ask."
    return "They did not answer. A missed-call note with your reason is in their inbox. Do not ring again unless they ask."
