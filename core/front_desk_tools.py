"""Front-desk tools. Metadata is exported for the P2 catalogue and P3 confinement gate.

register_all accepts the real registry decorator; importing this module never
registers tools or imports a later phase. Missing sibling services fail visibly.
"""
import inspect
import hashlib
import json
from importlib import import_module

TASK_FRAME = "do the work, do not start another task"
READ_TOOLS = {"fd_list_bots", "fd_find_chat", "fd_forge_projects"}
WATCH_TOOLS = READ_TOOLS | {"fd_suggest", "fd_save_draft"}


def _text(limit, *, enum=None):
    return {"type": "string", "minLength": 1, "maxLength": limit, **({"enum": enum} if enum else {})}


def _schema(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def _validate(value, schema):
    # The registry deliberately does not validate arguments. Enforce the same
    # bounds here for every provider, including direct and deferred calls.
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict) or set(value) - set(schema["properties"]) or set(schema.get("required", [])) - set(value):
            raise ValueError("Use the tool's declared fields")
        for key, item in value.items():
            _validate(item, schema["properties"][key])
    elif kind == "string":
        if (not isinstance(value, str) or not value.strip() or
                not schema.get("minLength", 0) <= len(value) <= schema["maxLength"]):
            raise ValueError("Use short, nonempty text")
        if schema.get("enum") and value not in schema["enum"]:
            raise ValueError("Choose one of the listed kinds")
    elif kind == "array":
        if not isinstance(value, list) or not schema.get("minItems", 1) <= len(value) <= schema["maxItems"]:
            raise ValueError("Use a short list")
        for item in value:
            _validate(item, schema["items"])


def _watch(ctx, session):
    # Unclassified unattended calls get the conservative watch ceiling.
    # Only trusted session metadata can identify an owner-started task.
    from core import task_scope
    scope = task_scope._current.get()
    if (session.get("front_desk_watch") or getattr(ctx, "watch_run", False) or
            getattr(ctx, "access", None) == "read-and-draft"):
        return True
    # An owner-started task uses internal admission, but is not a watch run.
    if (session.get("thread") or {}).get("opened_by") == "task":
        return False
    return bool(not ctx.session_id or session.get("agent_unattended") or (scope and scope.get("active")))


async def _await(result):
    return await result if inspect.isawaitable(result) else result


def _service(name):
    try:
        return import_module(f"services.{name}")
    except ModuleNotFoundError as error:
        if error.name != f"services.{name}":
            raise
        raise ValueError("This front desk feature is not available yet") from error


async def _suggest(title, detail, ctx, source=None):
    from services.front_desk_cards import post_card
    result = await _await(_service("front_desk_suggestions").add(
        title[:120], detail[:400], source, "check_in" if _watch_context(ctx) else "asked",
        run_id=_run_id(ctx)))
    if result:
        from services import front_desk
        sid = front_desk.main_thread_id() if _watch_context(ctx) else ctx.session_id
        post_card(sid, "suggestion", {"suggestion_id": result["id"], "title": result["title"],
                  "detail": result.get("detail", ""), "source_label": (source or {}).get("app", "")},
                  key=f"fd:suggestion:{result['id']}")
    return json.dumps({"suggestion": result, "message": "Saved for Up next." if result else "Already in Up next."})


def _run_id(ctx):
    from core import runs
    current = runs.current_for(ctx.session_id)
    return ctx.assignment_run_id or (current.run_id if current else None)


def _turn_key(ctx, session):
    return _run_id(ctx) or next((m.get("bot_message_id") or str(m.get("ts"))
                               for m in reversed(session.get("messages", [])) if m.get("role") == "user"), "welcome")


def _watch_context(ctx):
    from core.session_manager import session_manager
    return _watch(ctx, (session_manager.get_session(ctx.session_id) or {}) if ctx.session_id else {})


async def _execute(name, args, ctx):
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    from services import front_desk, front_desk_routing as routing
    from services.front_desk_cards import post_card
    agent = agent_service.get(ctx.agent_id)
    if not agent or agent.get("builtin") != "front_desk":
        return "Not run: this tool belongs to the front desk."
    session = session_manager.get_session(ctx.session_id) if ctx.session_id else {}
    if ctx.session_id and (not session or session.get("agent_id") != ctx.agent_id):
        return "Not run: front desk conversation not found."
    if _watch(ctx, session) and name not in WATCH_TOOLS:
        return "Not run: watch runs may only read, suggest work or save a local draft."
    spec = next(t for t in TOOLS if t["name"] == name)
    _validate(args, spec["schema"])
    if name not in READ_TOOLS:
        from core import permissions
        decision = await permissions.decide(surface=ctx.permission_surface, tool=name, arguments=args,
                                            title=spec["description"], is_admin=ctx.is_admin)
        if decision.behavior != "allow":
            return "Not run: " + decision.reason
        # Recheck trusted scope after an approval wait.
        current = agent_service.get(ctx.agent_id)
        if not current or current.get("builtin") != "front_desk":
            return "Not run: the front desk is no longer available."
        session = session_manager.get_session(ctx.session_id) if ctx.session_id else {}
        if ctx.session_id and (not session or session.get("agent_id") != ctx.agent_id):
            return "Not run: front desk conversation not found."
        if _watch(ctx, session) and name not in WATCH_TOOLS:
            return "Not run: watch runs may only read, suggest work or save a local draft."
    if name == "fd_list_bots":
        front_desk.sync_peers()
        return json.dumps(routing.roster(), ensure_ascii=False)
    if name == "fd_find_chat":
        return routing.find_chat(args["query"], ctx)
    if name == "fd_forge_projects":
        return json.dumps(routing.projects(), ensure_ascii=False)
    if name in {"fd_start_task", "fd_make"} and (session.get("thread") or {}).get("opened_by") == "task":
        return "Not run: " + TASK_FRAME + "."
    if name in {"fd_route", "fd_start_task", "fd_make", "fd_forge_propose"} and ctx.turn_taint and ctx.turn_taint.tainted:
        if name == "fd_route":
            target = routing.exact_bot(args["bot"])
            return await _suggest(f"Hand this to {target['name']}?", routing.compose_task(
                args["task"], args.get("constraints", ""), args.get("good_answer", "")), ctx)
        return await _suggest(args.get("ask") or args.get("brief") or args["task"], args.get("why", ""), ctx)
    if name == "fd_route":
        return routing.route(args["bot"], args["task"], args.get("constraints", ""), args.get("good_answer", ""), ctx)
    if name == "fd_forge_propose":
        routing.forge_propose(args["project"], args["task"], ctx.session_id)
        return "The Forge card is ready. Press Start to begin."
    if name in {"fd_start_task", "fd_make"}:
        task = await _await(_service("front_desk_tasks").start(args.get("ask") or args["brief"],
            origin="make" if name == "fd_make" else "asked", kind="make" if name == "fd_make" else "task",
            make_kind=args.get("kind"), why=args.get("why"), send_id=f"fd:{_turn_key(ctx, session)}:{name}:" +
            hashlib.sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()[:24]))
        post_card(ctx.session_id, "task_link", {"task_id": task["id"]}, key=f"fd:task:{task['id']}")
        return json.dumps({"task_id": task["id"], "message": "On it."})
    if name == "fd_suggest":
        return await _suggest(args["title"], args.get("detail", ""), ctx, args.get("source"))
    if name == "fd_add_tasks":
        return "\n".join([await _suggest(item["title"], item.get("detail", ""), ctx) for item in args["items"]])
    if name == "fd_save_draft":
        return json.dumps(await _await(_service("front_desk_drafts").save(**args)), default=str)
    if name == "fd_chips":
        from core import permissions
        if not any(m.get("role") == "user" for m in session.get("messages", [])):
            return "No chips on the first day."
        if permissions.pending_for(ctx.permission_surface):
            return "No chips beside a waiting card."
        try:
            cards = import_module("services.bot_cards")
        except ModuleNotFoundError as error:
            if error.name != "services.bot_cards":
                raise
        else:
            # P3 U5 CardStore contract; kept lazy while that branch is unmerged.
            if cards.store().list_cards(routing.owner(ctx), thread_id=ctx.session_id, status="pending"):
                return "No chips beside a waiting card."
        key = f"fd:chips:{_turn_key(ctx, session)}"
        post_card(ctx.session_id, "chips", {"options": args["options"]}, key=key)
        return "Reply choices are on screen."
    return "Not run: unknown front desk tool."


def _definition(name, description, schema, operation):
    async def handler(args, ctx):
        return await _execute(name, args, ctx)
    return {"name": name, "description": description, "schema": schema, "handler": handler,
            "effect": "read" if operation == "read" else "write", "operation": operation,
            "watch_allowed": name in WATCH_TOOLS, "builtin_only": "front_desk"}


TOOLS = [
    _definition("fd_list_bots", "Read the visible bot roster.", _schema({}), "read"),
    _definition("fd_route", "Pass typed work to an exact bot name.", _schema({"bot": _text(80), "task": _text(4000),
        "constraints": _text(2000), "good_answer": _text(2000)}, ("bot", "task")), "execute"),
    _definition("fd_find_chat", "Find up to five of this person's conversations by title.",
        _schema({"query": _text(200)}, ("query",)), "read"),
    _definition("fd_forge_projects", "Read available Forge project names.", _schema({}), "read"),
    _definition("fd_forge_propose", "Show a Forge proposal for the person to start.",
        _schema({"project": _text(120), "task": _text(4000)}, ("project", "task")), "execute"),
    _definition("fd_start_task", "Start larger work in its own task conversation.",
        _schema({"ask": _text(4000), "why": _text(400)}, ("ask",)), "execute"),
    _definition("fd_add_tasks", "Save up to eight task suggestions for Up next.", _schema({"items": {"type": "array",
        "maxItems": 8, "items": _schema({"title": _text(120), "detail": _text(400)}, ("title",))}}, ("items",)), "draft"),
    _definition("fd_make", "Make something to keep or read in a task conversation.", _schema({
        "kind": _text(20, enum=["design", "slides", "website", "files"]), "brief": _text(4000)}, ("kind", "brief")), "execute"),
    _definition("fd_suggest", "Save a grounded suggestion for Up next.", _schema({"title": _text(120), "detail": _text(400),
        "source": _schema({"app": _text(20, enum=["mail", "calendar"]), "ref": _text(200)}, ("app", "ref"))}, ("title",)), "draft"),
    _definition("fd_save_draft", "Save a local email draft. This never sends.", _schema({"to": _text(1000),
        "subject": _text(1000), "body": _text(8000), "in_reply_to": _text(200), "account": _text(200),
        "source_row": _text(200)}, ("to", "subject", "body")), "draft"),
    _definition("fd_chips", "Offer one to four short reply choices after your answer.", _schema({"options": {
        "type": "array", "maxItems": 4, "items": _text(120)}}, ("options",)), "draft"),
]


def operation_for(name):
    """Unknown tools never inherit read authority."""
    return next((t["operation"] for t in TOOLS if t["name"] == name), "opaque")


def guard_call(name, ctx):
    """Registry integration hook, including legacy aliases and unknown tools.

    Call before dispatch for every tool, not just the eleven front-desk tools.
    P3's broader read-and-draft ceiling remains authoritative too.
    """
    from core import tool_registry
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    agent = agent_service.get(ctx.agent_id)
    if not agent or agent.get("builtin") != "front_desk":
        return None
    session = (session_manager.get_session(ctx.session_id) or {}) if ctx.session_id else {}
    if _watch(ctx, session) and name not in WATCH_TOOLS and not tool_registry.read_tool(name):
        return "Not run: watch runs may only read, suggest work or save a local draft."
    if (ctx.turn_taint and ctx.turn_taint.tainted and name in {"agent_assign", "hand_to_agent", "create_task"}):
        return "Not run: use fd_route or fd_start_task to offer this work in Up next."
    return None


def register_all(register):
    for spec in TOOLS:
        register(spec["name"], spec["description"], spec["schema"], agent_only=True,
                 effect=spec["effect"])(spec["handler"])
