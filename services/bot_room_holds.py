"""Holds and mentions in a room (Phase 4, unit U2).

A person can quiet one teammate, or the whole room, in plain words: "@Scout
stop", "@everyone pause". That member is held: it does not take turns, and
messages addressed to it are remembered (the last 20). "@Scout resume", or a
message that is only "@Scout", lets it back in and hands it what it missed.

Reading rules, all pinned by tests:
- Only a person's text is read. Quoted lines (start with `>`), fenced code and
  inline code are ignored, so a pasted log that says "stop" holds nobody.
- A stop word (stop, halt, pause) only counts in the same sentence as an
  @mention. "Don't stop" and "no need to pause" are not holds.
- A bare typed stop word with no mention ("stop", "stop all") is a person Stop
  for the whole room, handled by services/bot_room_turns.py.
"""
import re
import time

from core import bot_rooms_store as store
from services import bot_room_events as feed

MAX_HELD_MESSAGES = 20
_FENCE = re.compile(r"```.*?(```|$)", re.DOTALL)
_INLINE = re.compile(r"`[^`\n]*`")
_QUOTE = re.compile(r"^[ \t]*>.*$", re.MULTILINE)
_SENTENCE = re.compile(r"[.!?;\n]+")
_STOP = re.compile(r"\b(stop|halt|pause|stand down)\b")
_NEGATED = re.compile(r"(don'?t|do not|dont|never|not|no need to|without|won'?t|didn'?t)\s+(?:\w+\s+){0,2}(stop|halt|pause)\b")
_RESUME = re.compile(r"\b(resume|unpause|carry on|go on|continue)\b")
_PERSON_STOP = {"stop", "stop all", "stop everyone", "stop everything", "halt", "stop it", "stop now", "stop please",
                "please stop"}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").casefold()).strip("-")


def strip_ignored(text: str) -> str:
    """The text with quoted lines, fenced code and inline code blanked out."""
    text = _FENCE.sub(" ", text or "")
    text = _QUOTE.sub(" ", text)
    return _INLINE.sub(" ", text)


def _candidates(members: list[dict]) -> list[tuple[str, str]]:
    """(lower-case spelling, bot id), longest first, so "@Scout Two" beats "@Scout"."""
    found = []
    for item in members:
        name = (item.get("name") or "").casefold().strip()
        for spelling in {name, slug(name), name.replace(" ", ""), (item.get("bot_id") or "").casefold()}:
            if spelling:
                found.append((spelling, item["bot_id"]))
    return sorted(found, key=lambda pair: -len(pair[0]))


def _tail_ok(text: str, end: int) -> bool:
    return end >= len(text) or not (text[end].isalnum() or text[end] in "_-")


def find_mentions(text: str, members: list[dict], *, keep_ignored: bool = False) -> dict:
    """{"ids": [bot ids in order of appearance], "everyone": bool, "you": bool, "unknown": [names]}.
    `members` are {"bot_id", "name"}; unknown names come back so a caller can tell the person."""
    source = text or "" if keep_ignored else strip_ignored(text)
    lower = source.casefold()
    found, everyone, you, unknown = [], False, False, []
    candidates = _candidates(members)
    index = 0
    while True:
        at = lower.find("@", index)
        if at < 0:
            break
        index = at + 1
        if at > 0 and (lower[at - 1].isalnum() or lower[at - 1] in "_."):
            continue  # an email address, not a mention
        rest = lower[at + 1:]
        for word in ("everyone", "all"):
            if rest.startswith(word) and _tail_ok(lower, at + 1 + len(word)):
                everyone = True
                index = at + 1 + len(word)
                break
        else:
            if rest.startswith("you") and _tail_ok(lower, at + 4):
                you = True
                index = at + 4
                continue
            for spelling, bot_id in candidates:
                if rest.startswith(spelling) and _tail_ok(lower, at + 1 + len(spelling)):
                    if bot_id not in found:
                        found.append(bot_id)
                    index = at + 1 + len(spelling)
                    break
            else:
                match = re.match(r"[\w-]{1,40}", source[at + 1:])
                if match and match.group(0).casefold() not in unknown:
                    unknown.append(match.group(0).casefold())
    return {"ids": found, "everyone": everyone, "you": you, "unknown": unknown}


def is_person_stop(text: str) -> bool:
    plain = re.sub(r"[^\w\s]", "", strip_ignored(text).casefold()).strip()
    return plain in _PERSON_STOP


def intent(text: str, members: list[dict]) -> dict:
    """{"hold": [bot ids], "release": [bot ids]} a person's message asks for."""
    everyone_ids = [m["bot_id"] for m in members]
    hold: list[str] = []
    release: list[str] = []
    cleaned = strip_ignored(text)
    for segment in _SENTENCE.split(cleaned):
        found = find_mentions(segment, members, keep_ignored=True)
        targets = list(everyone_ids) if found["everyone"] else list(found["ids"])
        if not targets:
            continue
        low = segment.casefold()
        if _STOP.search(low) and not _NEGATED.search(low):
            for bot_id in targets:
                if bot_id not in hold:
                    hold.append(bot_id)
                if bot_id in release:
                    release.remove(bot_id)
        elif _RESUME.search(low):
            for bot_id in targets:
                if bot_id not in release:
                    release.append(bot_id)
                if bot_id in hold:
                    hold.remove(bot_id)
    found = find_mentions(cleaned, members, keep_ignored=True)
    leftover = cleaned
    spellings = sorted({spelling for spelling, _ in _candidates(members)}, key=len, reverse=True)
    for spelling in spellings:  # "@Scout Two" is one mention, not "@Scout" plus a stray "Two"
        leftover = re.sub(r"@" + re.escape(spelling) + r"(?![\w-])", " ", leftover, flags=re.IGNORECASE)
    leftover = re.sub(r"@[\w-]+", " ", leftover)
    if found["ids"] and not re.sub(r"[\W_]+", "", leftover):
        for bot_id in found["ids"]:  # a bare mention lets the member back in
            if bot_id not in hold and bot_id not in release:
                release.append(bot_id)
    order = {bot_id: i for i, bot_id in enumerate(everyone_ids)}
    return {"hold": sorted(hold, key=lambda b: order.get(b, 0)), "release": sorted(release, key=lambda b: order.get(b, 0))}


# -- state -----------------------------------------------------------------------

def is_held(room_id: str, bot_id: str) -> bool:
    item = store.member(room_id, bot_id)
    return bool(item and item["held_at"])


def held_ids(room_id: str) -> list[str]:
    return [m["bot_id"] for m in store.members(room_id) if m["held_at"]]


def hold(room_id: str, bot_id: str, owner: str | None = None, interrupt: bool = True) -> bool:
    """Hold one member. True when it changed. A running seat turn is interrupted."""
    item = store.member(room_id, bot_id)
    if item is None or item["held_at"]:
        return False
    store.update_member(room_id, bot_id, held_at=time.time(), held_for=[])
    feed.publish("room.hold", room_id, {"bot_id": bot_id, "held": True}, owner)
    if interrupt:
        from services import bot_room_turns
        bot_room_turns.interrupt_member(room_id, bot_id, "held")
    return True


def release(room_id: str, bot_id: str, owner: str | None = None) -> bool:
    item = store.member(room_id, bot_id)
    if item is None or not item["held_at"]:
        return False
    state = dict(item["state"] or {})
    if item["held_for"]:
        state["released_block"] = item["held_for"]
    store.update_member(room_id, bot_id, held_at=None, held_for=[], state=state)
    feed.publish("room.hold", room_id, {"bot_id": bot_id, "held": False}, owner)
    return True


def record_addressed(room_id: str, bot_id: str, message: dict) -> None:
    """Remember a message addressed to a held member (the newest 20)."""
    item = store.member(room_id, bot_id)
    if item is None or not item["held_at"]:
        return
    kept = (item["held_for"] or []) + [{"id": message["id"], "text": (message.get("text") or "")[:2000],
                                         "at": message.get("created_at") or time.time()}]
    store.update_member(room_id, bot_id, held_for=kept[-MAX_HELD_MESSAGES:])


def take_released_block(room_id: str, bot_id: str) -> str:
    """What this member missed while held, once, as a block for its next turn. Empty when nothing."""
    from core.untrusted import wrap_untrusted
    item = store.member(room_id, bot_id)
    missed = ((item or {}).get("state") or {}).get("released_block")
    if not missed:
        return ""
    state = dict(item["state"])
    state.pop("released_block", None)
    store.update_member(room_id, bot_id, state=state)
    lines = "\n".join(f"- {entry['text']}" for entry in missed)
    return ("You were on hold in this room and are back. These messages were addressed to you while you were held:\n"
            + wrap_untrusted("messages from the person, kept while you were held", lines))


def apply_person_message(room_id: str, text: str, message: dict, owner: str | None = None) -> dict:
    """Apply what a person's message says about holds, and remember it for held members it addresses.
    Returns {"held": [...], "released": [...], "addressed_held": [...]}."""
    members = [{"bot_id": m["bot_id"], "name": _name(m["bot_id"])} for m in store.members(room_id)]
    wanted = intent(text, members)
    held, released = [], []
    for bot_id in wanted["hold"]:
        if hold(room_id, bot_id, owner):
            held.append(bot_id)
    for bot_id in wanted["release"]:
        if release(room_id, bot_id, owner):
            released.append(bot_id)
    found = find_mentions(text, members)
    addressed = [m["bot_id"] for m in store.members(room_id) if m["held_at"] and
                 (found["everyone"] or m["bot_id"] in found["ids"]) and m["bot_id"] not in held]
    for bot_id in addressed:
        record_addressed(room_id, bot_id, message)
    return {"held": held, "released": released, "addressed_held": addressed}


def _name(bot_id: str) -> str:
    from services.agent_service import agent_service
    return (agent_service.get(bot_id) or {}).get("name") or bot_id
