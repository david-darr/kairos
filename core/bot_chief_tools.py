"""Chief/team tools. All mutations enter through the registry permission gate."""
import json

from fastapi import HTTPException
from core.tool_registry import READ, WRITE, register
from core.untrusted import wrap_untrusted
from services import bot_chief, bot_departments as teams


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def string(limit):
    return {"type": "string", "maxLength": limit}


def scope(ctx, *, chief=True):
    from core import runs, task_scope
    from core.session_manager import session_manager
    bot = teams.service().get(ctx.agent_id)
    if not bot:
        raise HTTPException(403, "A trusted bot caller is required")
    session = session_manager.get_session(ctx.session_id) if ctx.session_id else None
    if session:
        if session.get("agent_id") != bot["id"]:
            raise HTTPException(404, "Conversation not found")
        owner = session.get("owner_user")
        if owner is None:
            owner = teams.owner(bot)
        if teams.owner(bot) != owner:
            raise HTTPException(404, "Bot not found")
    else:
        owner = task_scope.current_owner(bot["id"])
        if not owner or owner != teams.owner(bot):
            raise HTTPException(403, "A trusted owner is required")
    if chief and not bot_chief.managed(bot["id"]):
        raise HTTPException(403, "Only a team chief can do that")
    run = runs.current_for(ctx.session_id)
    turn_id = run.run_id if run else ctx.assignment_run_id
    return bot["id"], owner, turn_id, session


def data(ctx, label, value):
    if ctx.turn_taint:
        ctx.turn_taint.mark(label)
    return wrap_untrusted(label, json.dumps(value, ensure_ascii=False, default=str))


@register("propose_team_memory", "Suggest a fact for your team's shared memory.", obj({
    "kind": {"type": "string", "enum": ["person", "place", "decision", "term"]},
    "name": string(120), "detail": string(600), "aliases": {"type": "array", "items": string(120), "maxItems": 8},
    "key": string(240), "quote": string(2000)}, ("kind", "name", "detail")), agent_only=True, effect=WRITE)
async def propose_memory(args, ctx):
    from services import bot_team_memory
    bot_id, owner, _, session = scope(ctx, chief=False)
    if session and (session.get("private") or session.get("restricted") or
                    (session.get("thread") or {}).get("private")):
        raise HTTPException(403, "Private conversations cannot propose team memory")
    team = teams.team_of(bot_id)
    if not team:
        raise HTTPException(409, "Join a team before proposing shared memory")
    fields = {k: v for k, v in args.items() if k != "quote"}
    fields["source_quote"] = args.get("quote", "")
    entry = bot_team_memory.propose(team["id"], fields, bot_id, user=owner,
                                    accept=bot_chief.effective_level(bot_id, ctx.session_id) == "full")
    if session:
        from core.session_manager import session_manager
        session_manager.append_message(session["id"], "assistant", "Remembered for the team" if entry["status"] == "accepted" else "Remember this for the team?", extra={
            "display_only": True, "kind": "card", "card_type": "team_memory", "card": {
                "kind": "team_memory", "department_id": team["id"], "entry": entry}})
    return data(ctx, "team memory proposal", entry)


@register("search_team_memory", "Find accepted facts in your team's shared memory.", obj({"query": string(500)}, ("query",)), agent_only=True, effect=READ)
async def search_memory(args, ctx):
    from services import bot_team_memory
    bot_id, owner, _, _ = scope(ctx, chief=False)
    team = teams.team_of(bot_id)
    return data(ctx, "team memory search", bot_team_memory.search(team["id"], args["query"], owner) if team else [])


@register("propose_team_setup", "Propose creating or updating bots in your teams. Returns a diff card with Undo.", obj({
    "reason": string(500), "new_departments": {"type": "array", "items": string(60), "maxItems": 8},
    "ops": {"type": "array", "minItems": 1, "maxItems": 24, "items": obj({
        "op": {"type": "string", "enum": ["create", "update"]}, "bot_id": string(100),
        "fields": obj({"name": string(80), "role": string(120), "soul": string(1000), "section": string(60),
                       "endpoint_id": string(200), "model_override": string(200), "model_effort": string(40), "chief": {"type": "boolean"}})}, ("op", "fields"))}}, ("ops",)), agent_only=True, effect=WRITE)
async def propose_setup(args, ctx):
    from services import bot_team_changes
    bot_id, _, turn_id, _ = scope(ctx)
    row = bot_team_changes.propose(bot_id, "set_up_team", args["ops"], args.get("reason", ""), session_id=ctx.session_id,
                                   turn_id=turn_id, new_departments=args.get("new_departments", []))
    return data(ctx, "team setup proposal", row)


@register("propose_bot_deletion", "Propose deleting one bot in your teams. Always waits for the person.",
          obj({"bot_id": string(100), "reason": string(500)}, ("bot_id",)), agent_only=True, effect=WRITE)
async def propose_delete(args, ctx):
    from services import bot_team_changes
    bot_id, _, turn_id, _ = scope(ctx)
    return data(ctx, "bot deletion proposal", bot_team_changes.propose(bot_id, "bot_deletion", [{"op": "delete", "bot_id": args["bot_id"]}],
                args.get("reason", ""), session_id=ctx.session_id, turn_id=turn_id))


@register("list_team_setup", "Read the bots and setup proposals in your teams.", obj({}), agent_only=True, effect=READ)
async def list_setup(args, ctx):
    from services import bot_team_changes
    bot_id, owner, _, _ = scope(ctx)
    bots = []
    for bot in teams.service().list_agents():
        try:
            bot_chief.authorize(bot_id, "read", bot["id"])
            bots.append({k: bot.get(k) for k in ("id", "name", "role", "section", "revision")})
        except HTTPException:
            pass
    return data(ctx, "team setup", {"bots": bots, "changes": [r for r in bot_team_changes.listing(owner) if r["chief_bot_id"] == bot_id]})


@register("read_incidents", "Read incidents in your teams.", obj({}), agent_only=True, effect=READ)
async def read_incidents(args, ctx):
    from services import bot_incidents
    bot_id, owner, _, _ = scope(ctx)
    rows = []
    for row in bot_incidents.listing(owner):
        try:
            bot_chief.authorize(bot_id, "read_incidents", row["bot_id"])
            rows.append(row)
        except HTTPException:
            pass
    return data(ctx, "team incidents", rows)


@register("retry_thread", "Retry a failed teammate conversation, at most twice per hour.", obj({"incident_id": string(100)}, ("incident_id",)), agent_only=True, effect=WRITE)
async def retry(args, ctx):
    from services import bot_incidents
    bot_id, owner, _, _ = scope(ctx)
    return json.dumps(await bot_incidents.retry_thread(args["incident_id"], user=owner, chief_id=bot_id))


@register("close_thread", "Archive an idle conversation in your teams.", obj({"thread_id": string(100)}, ("thread_id",)), agent_only=True, effect=WRITE)
async def close(args, ctx):
    from services import bot_attention, bot_chat_service, bot_threads
    chief_id, owner, _, _ = scope(ctx)
    session = bot_attention.require_thread(args["thread_id"], owner)
    bot_chief.authorize(chief_id, "close_thread", session["agent_id"])
    bot = teams.service().get(session["agent_id"])
    if bot_chat_service._reason(session["id"], bot):
        raise HTTPException(409, "Wait for this conversation to finish first")
    import time
    return json.dumps(bot_threads.update_thread(bot, session["id"], {"archived_at": time.time()}), default=str)


@register("create_room", "Open a room within your teams. You must remain a member.", obj({"name": string(100),
    "member_ids": {"type": "array", "minItems": 1, "maxItems": 100, "items": string(100)}}, ("name", "member_ids")), agent_only=True, effect=WRITE)
async def create_room(args, ctx):
    chief_id, owner, turn_id, _ = scope(ctx)
    if chief_id not in args["member_ids"]:
        raise HTTPException(403, "The chief must stay in the room")
    for ident in args["member_ids"]:
        bot_chief.authorize(chief_id, "create_room", ident)
    from services import bot_rooms
    bot_chief.reserve(chief_id, turn_id, "create_room")
    return data(ctx, "created room", bot_rooms.create(name=args["name"], member_ids=args["member_ids"], user=owner))


@register("manage_room", "Change the name or members of a room in your teams.", obj({"room_id": string(100), "name": string(100),
    "member_ids": {"type": "array", "minItems": 1, "maxItems": 100, "items": string(100)}}, ("room_id",)), agent_only=True, effect=WRITE)
async def manage_room(args, ctx):
    chief_id, owner, _, _ = scope(ctx)
    from services import bot_rooms
    current = bot_rooms.members(args["room_id"])
    ids = [m if isinstance(m, str) else m["bot_id"] for m in current]
    if chief_id not in ids or chief_id not in args.get("member_ids", ids):
        raise HTTPException(403, "The chief must stay in the room")
    for ident in set(ids + args.get("member_ids", [])):
        bot_chief.authorize(chief_id, "manage_room", ident)
    return data(ctx, "updated room", bot_rooms.update(args["room_id"], {k: v for k, v in args.items() if k != "room_id"}, user=owner))
