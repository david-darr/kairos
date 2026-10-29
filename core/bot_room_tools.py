"""Model tools for rooms (Phase 4, unit U2): `post_to_room` and `list_room_targets`.

Both are for bots only. The room comes from the conversation the bot is in:
inside a room turn it is that room; anywhere else the bot names one of the rooms
it belongs to. The bot's identity is the run's, never an argument.

`post_to_room` writes one message into a room the bot belongs to and never
starts a turn there; the posting guard (services/bot_room_guard.py) can refuse
it, and the refusal text says why. It leaves a "Posted in <room>" line in the
bot's own conversation. `list_room_targets` lists the room's teammates by id, so
the bot can hand real work on with `coordinate_bots`.

Registered once, at import, like the other tool modules; core/bot_team_tools.py
imports this file.
"""
import json
import time

from core.tool_registry import WRITE, READ, _object, _str, register


def _room_for(ctx, name: str | None) -> tuple[dict | None, bool, str]:
    """(room, is the room the current conversation, a refusal)."""
    from core import bot_rooms_store as store
    if not getattr(ctx, "agent_id", None):
        return None, False, "Rooms are for bots."
    seat = store.room_for_seat(ctx.session_id) if getattr(ctx, "session_id", None) else None
    if seat and seat[1] == ctx.agent_id and not name:
        return store.get_room(seat[0]), True, ""
    mine = [store.get_room(r) for r in store.rooms_of_bot(ctx.agent_id)]
    mine = [r for r in mine if r and not r["archived_at"]]
    if not name:
        return None, False, ("Name the room. Rooms you are in: " + (", ".join(r["name"] for r in mine) or "none") + ".")
    wanted = name.strip().casefold()
    found = [r for r in mine if wanted in (r["id"].casefold(), r["name"].casefold())]
    if len(found) != 1:
        return None, False, "Name one room you belong to. Rooms you are in: " + (", ".join(r["name"] for r in mine) or "none") + "."
    return found[0], bool(seat and seat[0] == found[0]["id"]), ""


@register(
    "post_to_room",
    "Post one message into a room you belong to, without starting a turn there. Use it to report something "
    "to the room from outside it. Up to 3 posts per turn. Name the room unless you are already in one.",
    _object({"text": _str("What to post"), "room": _str("Room name or id (leave out inside a room)")}, ("text",)),
    agent_only=True, effect=WRITE,
)
async def _post_to_room(args, ctx):
    from core import bot_rooms_store as store, runs
    from services import bot_room_guard as guard, bot_room_holds as holds, bot_rooms as rooms
    text = str(args.get("text") or "").strip()
    if not text:
        return "Not posted: say what to post."
    if len(text) > 12000:
        return "Not posted: keep it under 12,000 characters."
    room, inside, refusal = _room_for(ctx, args.get("room"))
    if room is None:
        return "Not posted: " + refusal
    if inside:
        return "Not posted: you are already in this room. Just reply here."
    verdict = rooms.can_speak(ctx.agent_id, room["id"])
    if not verdict:
        return "Not posted: " + verdict.reason
    context = runs.current_for(getattr(ctx, "session_id", None))
    turn_id = (context.run_id if context else None) or getattr(ctx, "assignment_run_id", None) or getattr(ctx, "session_id", None)
    infos = [{"bot_id": m["bot_id"], "name": m["name"]} for m in rooms.members(room["id"])]
    targets = holds.find_mentions(text, infos)["ids"]
    check = guard.check(room["id"], ctx.agent_id, text, targets=targets, now=time.time(), turn_id=turn_id, per_turn=True)
    if not check:
        return "Not posted: " + check.message
    thread = store.threads(room["id"])[0]
    rooms.add_row(room["id"], thread["id"], "bot", text, bot_id=ctx.agent_id, kind="text",
                  meta={"posted_from": "post_to_room"})
    if getattr(ctx, "session_id", None):
        from core.session_manager import session_manager
        try:
            session_manager.append_message(ctx.session_id, "assistant", f"Posted in {room['name']}",
                                           extra={"display_only": True, "kind": "posted_in", "room_id": room["id"],
                                                  "room_name": room["name"]})
        except KeyError:
            pass
    return f"Posted in {room['name']}. This did not start a turn there."


@register(
    "list_room_targets",
    "List the teammates in your room with their ids, so you can hand work on with coordinate_bots. Inside a room "
    "turn it is that room; otherwise name a room you belong to.",
    _object({"room": _str("Room name or id (leave out inside a room)")}),
    agent_only=True, effect=READ,
)
async def _list_room_targets(args, ctx):
    from core import bot_rooms_store as store
    from services import bot_rooms as rooms
    room, _inside, refusal = _room_for(ctx, args.get("room"))
    if room is None:
        return "No room: " + refusal
    rows = [{"id": m["bot_id"], "name": m["name"], "held": m["held"], "working": m["working"]}
            for m in rooms.members(room["id"]) if m["bot_id"] != ctx.agent_id]
    thread = store.threads(room["id"])[0]
    return json.dumps({"room": room["name"], "thread_id": thread["id"], "teammates": rows}, ensure_ascii=False)
