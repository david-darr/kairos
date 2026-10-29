"""The posting guard for rooms (Phase 4, unit U2).

A bot writes into a room two ways that no person asked for: `post_to_room`, and
the reply of a teammate it brought in. This guard keeps those from looping or
flooding. A person's own messages and the answers they ask for are never
checked here.

Refused, with a plain reason the bot is told:
- the same words from the same bot within 60 seconds (duplicate);
- a ring: A brings in B, B brings in C, C brings in A inside 120 seconds. The
  room's bot posts then stop for 5 minutes (breaker);
- more than 10 posts a minute from one bot (rate);
- two bot posts in 5 minutes with no person message since (escalate): the bots
  wait for the person;
- more than 3 `post_to_room` calls in one turn (turn).

The clock is injectable (`now=`), so tests never sleep. Recent posts live in
the rooms store, so a restart does not reset the breaker.
"""
import hashlib
import re
import threading

from core import bot_rooms_store as store

DUPLICATE_SECONDS = 60
RING_SECONDS = 120
BREAKER_SECONDS = 300
RATE_LIMIT, RATE_SECONDS = 10, 60
ESCALATE_POSTS, ESCALATE_SECONDS = 2, 300
PER_TURN = 3

_LOCK = threading.RLock()
_EDGES: dict[str, list[tuple[float, str, str]]] = {}  # room -> (at, from bot, to bot)
_BREAKER: dict[str, float] = {}  # room -> blocked until
_PERSON: dict[str, float] = {}  # room -> last time a person spoke
_TURN_COUNTS: dict[str, int] = {}


class Verdict:
    """Truthy when the post may go ahead. `.reason` is a code, `.message` the words for the bot."""

    def __init__(self, ok: bool, reason: str = "", message: str = ""):
        self.ok, self.reason, self.message = ok, reason, message

    def __bool__(self) -> bool:
        return self.ok

    def __repr__(self) -> str:
        return f"Verdict(ok={self.ok}, reason={self.reason!r})"


def reset() -> None:
    with _LOCK:
        _EDGES.clear()
        _BREAKER.clear()
        _PERSON.clear()
        _TURN_COUNTS.clear()


def fingerprint(text: str) -> str:
    plain = re.sub(r"\s+", " ", (text or "").casefold()).strip()
    return hashlib.sha256(plain.encode()).hexdigest()[:24]


def note_person(room_id: str, now: float) -> None:
    """A person spoke: the escalate count starts over, and a tripped breaker is cleared."""
    with _LOCK:
        _PERSON[room_id] = now
        _BREAKER.pop(room_id, None)


def _ring(room_id: str, sender: str, targets: list[str], now: float) -> bool:
    edges = [e for e in _EDGES.get(room_id, []) if now - e[0] <= RING_SECONDS]
    for target in targets:
        if target == sender:
            continue
        # Is there already a path from `target` back to `sender` over at least one other bot?
        seen, frontier = {target}, [target]
        while frontier:
            here = frontier.pop()
            for _, a, b in edges:
                if a == here and b not in seen:
                    if b == sender and here != target:
                        return True
                    if b == sender:
                        continue  # a two-bot back-and-forth is for the escalate rule, not the ring
                    seen.add(b)
                    frontier.append(b)
    return False


def check(room_id: str, bot_id: str, text: str, *, targets: list[str] | None = None, now: float,
          turn_id: str | None = None, per_turn: bool = False, record: bool = True) -> Verdict:
    """May this bot post `text` (bringing in `targets`) now? Records the post when it may."""
    targets = [t for t in (targets or []) if t != bot_id]
    with _LOCK:
        until = _BREAKER.get(room_id, 0)
        if now < until:
            return Verdict(False, "breaker", "Bot posts in this room are paused for a few minutes because the bots were "
                                             "passing the same request around. Wait for the person.")
        if targets and _ring(room_id, bot_id, targets, now):
            _BREAKER[room_id] = now + BREAKER_SECONDS
            return Verdict(False, "ring", "This request has come back around to the bot that started it. Stop and tell "
                                          "the person instead.")
        if per_turn and turn_id:
            if _TURN_COUNTS.get(turn_id, 0) >= PER_TURN:
                return Verdict(False, "turn", f"You can post in a room at most {PER_TURN} times per turn.")
        print_ = fingerprint(text)
        recent = store.posts_since(room_id, now - max(DUPLICATE_SECONDS, ESCALATE_SECONDS, RATE_SECONDS))
        if any(p["bot_id"] == bot_id and p["fingerprint"] == print_ and now - p["at"] <= DUPLICATE_SECONDS for p in recent):
            return Verdict(False, "duplicate", "You already posted this a moment ago.")
        if sum(1 for p in recent if p["bot_id"] == bot_id and now - p["at"] <= RATE_SECONDS) >= RATE_LIMIT:
            return Verdict(False, "rate", "You are posting too fast. Slow down.")
        last_person = _PERSON.get(room_id, 0)
        unanswered = [p for p in recent if p["at"] > last_person and now - p["at"] <= ESCALATE_SECONDS]
        if len(unanswered) >= ESCALATE_POSTS:
            return Verdict(False, "escalate", "Two bot messages have gone unanswered. Wait for the person before posting again.")
        if record:
            store.post_add(room_id, bot_id, now, print_)
            if per_turn and turn_id:
                _TURN_COUNTS[turn_id] = _TURN_COUNTS.get(turn_id, 0) + 1
            edges = [e for e in _EDGES.get(room_id, []) if now - e[0] <= RING_SECONDS]
            edges += [(now, bot_id, t) for t in targets]
            _EDGES[room_id] = edges
    return Verdict(True)


def end_turn(turn_id: str | None) -> None:
    if turn_id:
        with _LOCK:
            _TURN_COUNTS.pop(turn_id, None)
