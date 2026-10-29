"""Bot delegation tools. Every write passes through the permission broker."""
import asyncio
import json
import time

from core.tool_registry import register, _object, _str, READ, WRITE

COORDINATE_SCHEMA = _object({
    "bot_ids": {"type": "array", "items": _str(), "minItems": 1, "maxItems": 4, "uniqueItems": True},
    "message": {"type": "string", "minLength": 1, "maxLength": 4000},
    "mode": {"type": "string", "enum": ["work", "consult", "notify"]},
    "thread": {"type": "string", "enum": ["standing", "new"]},
    "reply": {"type": "string", "enum": ["resume", "none"]},
    "title": {"type": "string", "maxLength": 80}, "reason": {"type": "string", "maxLength": 200},
    "done_when": {"type": "string", "maxLength": 1000}, "rework": {"type": "boolean"},
}, ("bot_ids", "message"))


async def coordinate(args, ctx):
    from core import permissions
    from services import bot_peers, agent_handoff
    from services.agent_service import agent_service
    if not ctx.agent_id:
        return "Not run: start from a bot conversation."
    ids = args.get("bot_ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 4 or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Choose 1 to 4 different bots.")
    if not isinstance(args.get("message"), str) or not 1 <= len(args["message"].strip()) <= 4000:
        raise ValueError("Write 1 to 4000 characters.")
    if args.get("mode", "work") not in ("work", "consult", "notify") or args.get("thread", "new") not in ("standing", "new") or args.get("reply", "resume") not in ("resume", "none"):
        raise ValueError("Choose valid delegation options.")
    if args.get("mode") == "consult" and args.get("reply") == "none":
        raise ValueError("A consult needs a reply.")
    for key, cap in (("title", 80), ("reason", 200), ("done_when", 1000)):
        if not isinstance(args.get(key, ""), str) or len(args.get(key, "")) > cap:
            raise ValueError(f"{key} is too long.")
    targets = [bot_peers.resolve(target) for target in ids]
    if len({t["id"] for t in targets}) != len(targets):
        raise ValueError("Choose different bots.")
    lines = []
    for target in targets:
        needs_approval = False
        try:
            verdict = bot_peers.authorize(ctx.agent_id, target, session_id=ctx.session_id)
        except PermissionError:
            needs_approval = True
        except ValueError as error:
            lines.append(f"Assignment refused: {error}")
            continue
        key = f"coordinate_bots:{target['id']}"
        tainted = bool(ctx.turn_taint and ctx.turn_taint.tainted)
        decision = await permissions.decide(surface=(ctx.permission_surface if needs_approval or tainted else f"agent:{ctx.agent_id}"), tool="coordinate_bots",
            arguments={"bot_id": target["id"], "message": args["message"], "kind": "peer_approval"},
            title=f"Contact {target['name']}?", description=(f"This turn read {ctx.turn_taint.reason}. " if tainted else "") +
                f"Delegate to {target['name']}: {args['message'][:300]}", target=key,
            is_admin=ctx.is_admin, force_prompt=needs_approval or tainted,
            choices=[{"id": "once", "label": "Allow", "behavior": "allow", "scope": "once"},
                     {"id": "forever", "label": f"Always allow contact with {target['name']}", "behavior": "allow", "scope": "forever"},
                     {"id": "reject", "label": "Deny", "behavior": "deny", "scope": "once"}])
        if decision.behavior != "allow":
            lines.append(f"Not run: {decision.reason or 'peer contact was not approved'}")
            continue
        if decision.rule and decision.rule.get("scope") == "forever":
            def remember(bot):
                rules = list(bot.get("always_allow") or [])
                if key not in rules:
                    bot["always_allow"] = (rules + [key])[-200:]
            agent_service.mutate_bot(ctx.agent_id, remember)
        lines.append(agent_handoff.assign(ctx.agent_id, target["id"], args["message"], ctx.session_id,
            ctx.assignment_run_id, ctx.source_card_id, approved=True,
            **{key: args[key] for key in ("mode", "thread", "reply", "title", "reason", "done_when", "rework") if key in args}))
    if ctx.turn_taint:
        ctx.turn_taint.mark("delegation receipt from another bot")
    return "\n".join(lines)


@register("coordinate_bots", "Delegate, consult or notify 1 to 4 reachable bots. End your turn after sending; do not poll.",
          COORDINATE_SCHEMA, agent_only=True, effect=WRITE, core=True)
async def coordinate_bots(args, ctx):
    return await coordinate(args, ctx)


@register("list_peers", "List reachable bots and their current status. Reach grants no administrative authority.",
          _object(), agent_only=True, effect=READ)
async def list_peers(args, ctx):
    from services.bot_peers import roster
    return json.dumps(roster(ctx.agent_id), ensure_ascii=False)


@register("assignment_status", "Wait for earlier assignments in this conversation, at most 240 seconds. Never poll assignments created this turn.",
          _object({"ids": {"type": "array", "minItems": 1, "maxItems": 20, "items": _str()},
                   "timeout": {"type": "number", "minimum": 0, "maximum": 240}}, ("ids",)),
          agent_only=True, effect=READ)
async def assignment_status(args, ctx):
    from core import bot_assignments, runs
    from services.bot_peers import provenance
    ids = args.get("ids")
    timeout = args.get("timeout", 240)
    if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or any(not isinstance(i, str) for i in ids):
        raise ValueError("Choose 1 to 20 assignments.")
    if not isinstance(timeout, (int, float)) or not 0 <= timeout <= 240:
        raise ValueError("Wait from 0 to 240 seconds.")
    context = runs.current_for(ctx.session_id)
    run_id = ctx.assignment_run_id or (context.run_id if context else None)
    deadline = time.monotonic() + timeout
    while True:
        rows = []
        for aid in ids:
            node = bot_assignments.get(aid)
            if not node or node["requester"].get("bot_id") != ctx.agent_id or node["requester"].get("session_id") != ctx.session_id:
                raise ValueError("Assignment not found in this conversation.")
            if not run_id or node["requester"].get("run_id") == run_id:
                raise ValueError("End this turn before checking its assignments.")
            rows.append(node)
        if all(n["status"] in bot_assignments.TERMINAL or n["status"] == "needs_input" for n in rows) or time.monotonic() >= deadline:
            from services.bot_peers import can_reach
            result = []
            for node in rows:
                visible = can_reach(ctx.agent_id, node["assignee_bot_id"])
                result.append({"id": node["id"], "status": node["status"], "outcome": node["outcome"],
                    "result": provenance(node["assignee_bot_id"], node["result"], taint=ctx.turn_taint) if visible else "No longer reachable.",
                    "evidence": node["evidence"] if visible else {}})
            return json.dumps(result, ensure_ascii=False)
        await asyncio.sleep(min(.25, max(0, deadline - time.monotonic())))
