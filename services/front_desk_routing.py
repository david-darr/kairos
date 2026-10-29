"""Read adapters and typed routing over Kairos's existing handoff runtime."""
import json

from core.untrusted import wrap_untrusted


def roster():
    from services.agent_service import agent_service
    return [{"id": a["id"], "name": a["name"], "role": a.get("role", ""), "blurb": a.get("blurb", ""),
             "status": _status(a)}
            for a in agent_service.list_agents() if not a.get("hidden")]


def _status(agent):
    from services import chat_live, agent_handoff
    from services.agent_service import agent_service
    from services.task_service import task_service
    if not agent.get("enabled", True):
        return "off"
    tasks = [t for t in task_service.list_tasks() if t.get("agent_id") == agent["id"]]
    if chat_live.agent_activity(agent["id"]) or any(t.get("status") == "running" or t.get("run_started_at") for t in tasks):
        return "working"
    if agent_handoff.person_inbox(agent["id"]) or any(t.get("status") == "review" for t in tasks):
        return "needs_you"
    return "idle" if agent_service.can_run(agent["id"])[0] else "capped"


def exact_bot(name):
    matches = [a for a in roster() if a["name"] == name]
    if len(matches) != 1:
        raise ValueError("Name one visible bot exactly as it appears in the roster")
    from services import front_desk
    if matches[0]["id"] == front_desk.bot_id():
        raise ValueError("Choose another bot")
    return matches[0]


def wrapped(label, value, ctx):
    if ctx.turn_taint is not None:
        ctx.turn_taint.mark(label)
    return wrap_untrusted(label, json.dumps(value, ensure_ascii=False))


def owner(ctx):
    from core.session_manager import session_manager
    from core.task_scope import current_owner
    from services.bot_attention import legacy_owner
    if ctx.session_id:
        session = session_manager.get_session(ctx.session_id)
        if not session or session.get("agent_id") != ctx.agent_id:
            raise ValueError("Front desk conversation not found")
        result = session.get("owner_user") or legacy_owner()
    else:
        result = current_owner(agent_id=ctx.agent_id)
    if not result:
        raise ValueError("The run has no trusted owner")
    return result


def find_chat(query, ctx):
    from core.session_manager import session_manager
    from core.bot_message_tree import ancestry
    trusted_owner = owner(ctx)
    query = query.strip()
    # None would mean all owners to list_sessions. Never pass it here.
    headers = session_manager.list_sessions(include_agents=True, owner_user=trusted_owner)
    hits = []
    for header in sorted(headers, key=lambda h: h.get("updated_at") or 0, reverse=True):
        if query.casefold() not in (header.get("title") or "").casefold():
            continue
        session = session_manager.get_session(header["id"])
        if not session or session.get("owner_user") != trusted_owner:
            continue
        messages = ancestry(session) if session.get("agent_id") else session.get("messages", [])
        preview = next((" ".join(str(m.get("content") or "").split())[:120] for m in reversed(messages)
                        if m.get("role") in ("user", "assistant") and m.get("content")), "")
        hits.append({"id": header["id"], "title": header.get("title", ""),
                     "updated_at": header.get("updated_at"), "preview": preview})
        if len(hits) == 5:
            break
    return wrapped("conversation search", hits, ctx)


def projects():
    from services.forge_projects import forge_projects
    return [{"id": p["id"], "name": p["name"]} for p in forge_projects.list()]


def forge_propose(project, task, session_id):
    from services.front_desk_cards import post_card
    matches = [p for p in projects() if project in (p["id"], p["name"])]
    if len(matches) != 1:
        raise ValueError("Choose one existing Forge project")
    chosen = matches[0]
    # No import of forge_sessions: only the person's Start button can create a run.
    return post_card(session_id, "forge", {"project_id": chosen["id"], "project_name": chosen["name"], "task": task})


def route(bot, task, constraints, good_answer, ctx):
    from services import agent_handoff, front_desk
    from services.front_desk_cards import post_card
    from services.task_service import task_service
    target = exact_bot(bot)
    front_desk.sync_peers()
    work = compose_task(task, constraints, good_answer)
    result = agent_handoff.assign(ctx.agent_id, target["name"], work, session_id=ctx.session_id,
                                  run_id=ctx.assignment_run_id, source_card_id=ctx.source_card_id)
    if result.startswith("Assignment refused:"):
        return result
    # Resolve the actual returned handoff card, not a model-chosen card id.
    import re
    match = re.search(r"\(card ([A-Za-z0-9_-]+)[,)]", result)  # "(card X)" or "(card X, assignment Y)"
    card = task_service.get_task(match[1]) if match else None
    if card:
        post_card(ctx.session_id, "route", {"bot_id": target["id"], "bot_name": target["name"], "card_id": card["id"]},
                  key=f"fd:route:{card['id']}")
    return result


def compose_task(task, constraints="", good_answer=""):
    return task + (f"\n\nConstraints:\n{constraints}" if constraints else "") + (
        f"\n\nA good answer:\n{good_answer}" if good_answer else "")
