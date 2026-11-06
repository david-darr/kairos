"""Kairos tools for the Content Studio team's bots (build spec "Content Studio Team", sections 3 and 4).

Each tool acts in the calling bot's own account, on that account's studio store (services/content_studio),
and only for the role the store records for that bot (services/content_studio/team.py): a bot that is not on
the team, or is on it in another role, is refused. Reads are fenced as data. No tool approves a post, posts
one, creates a channel or retires a channel without the person: a Producer confirm of a channel retirement
goes to `awaiting_user`, and approval stays with the person (/api/content-studio/posts/{id}/approve).
"""
import json

from core.tool_registry import READ, WRITE, register
from core.untrusted import wrap_untrusted
from services.content_studio import StudioError, delivery, pipeline, review, studio, team


def _obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def _str(limit, description=""):
    return {"type": "string", "maxLength": limit, **({"description": description} if description else {})}


def _int(description=""):
    return {"type": "integer", **({"description": description} if description else {})}


class Refused(Exception):
    pass


def _bot(ctx, roles):
    """The calling bot in the current account, if it holds one of `roles` (None: any team role)."""
    from services.agent_service import agent_service
    bot = agent_service.get(ctx.agent_id) if ctx.agent_id else None
    if bot is None:
        raise Refused("A bot of this account must call this tool.")
    role = team.role_of(studio, bot["id"])
    if role is None:
        raise Refused("This bot is not on the Content Studio team.")
    if roles and role not in roles:
        raise Refused(f"Only the {' or '.join(r.replace('_', ' ').title() for r in roles)} can do that; you are the {role.replace('_', ' ').title()}.")
    return bot, role


def _data(ctx, label, value):
    if ctx.turn_taint:
        ctx.turn_taint.mark(label)
    return wrap_untrusted(label, json.dumps(value, ensure_ascii=False, default=str))


def _guarded(roles, fn):
    async def handler(args, ctx):
        try:
            bot, role = _bot(ctx, roles)
            return fn(args, ctx, bot, role)
        except Refused as error:
            return f"Not run: {error}"
        except StudioError as error:
            return f"Not run: {error.detail}"
    return handler


def _add(name, description, schema, effect, roles, fn):
    register(name, description, schema, agent_only=True, effect=effect)(_guarded(roles, fn))


ANY = None


def _pipeline(args, ctx, bot, role):
    return _data(ctx, "content studio pipeline", {"items": pipeline.pipeline(studio), "approvals_waiting": len(pipeline.approval_queue(studio))})


def _add_topic(args, ctx, bot, role):
    topic = studio.add_topic(args["niche_id"], args["title"], args["source"], args.get("evidence_date"), args.get("signal", ""))
    return _data(ctx, "content studio topic", topic)


def _run_review(args, ctx, bot, role):
    return _data(ctx, "content studio review", review.run_review(studio, None, args.get("dry_run", True)))


def _confirm(args, ctx, bot, role):
    decision = review.confirm(studio, args["decision_id"], "producer", bot["name"])
    note = " A retirement that archives a channel now waits for the person's OK." if decision["status"] == "awaiting_user" else ""
    return _data(ctx, "content studio decision", decision) + note


def _reject(args, ctx, bot, role):
    return _data(ctx, "content studio decision", review.reject(studio, args["decision_id"], bot["name"], args.get("reason", "")))


def _submit(args, ctx, bot, role):
    post = studio.submit_for_approval(args["post_id"])
    return _data(ctx, "content studio post", post) + " It now waits for the person's approval."


def _watch(args, ctx, bot, role):
    findings = pipeline.watch(studio)
    sent = delivery.deliver_findings(studio, findings) if args.get("notify", True) else []
    return _data(ctx, "content studio watch", {"findings": findings, "sent_to_inbox": [f["message"] for f in sent]})


def _send_report(args, ctx, bot, role):
    result = delivery.deliver_report(studio)
    head = "The weekly report is in the person's Inbox." if result["delivered"] else "The report was built but could not be delivered."
    return head + "\n" + wrap_untrusted("content studio report", result["text"])


def _metrics(args, ctx, bot, role):
    try:
        stored = studio.add_snapshots(args["rows"])
    except TypeError:
        raise StudioError("each row needs post_id, views, avg_view_duration_s and video_length_s")
    return f"Stored {len(stored)} snapshot(s). Earlier snapshots are never changed."


def _warning(args, ctx, bot, role):
    channel = studio.record_warning(args["channel_id"], args["text"])
    sent = delivery.deliver_warning(studio, args["channel_id"])
    return f"Channel {channel['handle']} is paused. " + ("The person has been told." if sent else "Tell the Producer to tell the person.")


_add("content_studio_pipeline", "Read the Content Studio pipeline: each idea's step, owner, age and status, and how many posts wait for approval.",
     _obj({}), READ, ANY, _pipeline)
_add("content_studio_add_topic", "Researcher: add a sourced topic candidate to a live niche. A topic needs its source and the date you saw it.",
     _obj({"niche_id": _int("The live niche"), "title": _str(200), "source": _str(300, "Where you saw it"),
           "evidence_date": {"type": "number", "description": "Unix time you saw it; defaults to now"},
           "signal": _str(300, "What is rising and by how much")}, ("niche_id", "title", "source")),
     WRITE, ("researcher",), _add_topic)
_add("content_studio_run_review", "Executor: run the weekly selection review. dry_run (the default) shows the proposals and records nothing; "
     "dry_run false files them as decisions for the Producer to confirm.", _obj({"dry_run": {"type": "boolean"}}), WRITE, ("executor",), _run_review)
_add("content_studio_confirm_decision", "Producer: confirm an Executor proposal. A retirement of a channel (or a niche with live channels) is not applied: "
     "it moves to awaiting the person's OK. Everything else is applied.", _obj({"decision_id": _int()}, ("decision_id",)),
     WRITE, ("producer",), _confirm)
_add("content_studio_reject_decision", "Producer: reject an Executor proposal, with a reason.",
     _obj({"decision_id": _int(), "reason": _str(300)}, ("decision_id",)), WRITE, ("producer",), _reject)
_add("content_studio_submit_post", "Editor or Producer: put a rendered post in the approval queue. Only the person can approve it.",
     _obj({"post_id": _int()}, ("post_id",)), WRITE, ("editor", "producer"), _submit)
_add("content_studio_watch", "Producer: run the watch (overdue steps, render failures, posts rejected twice, spend near the cap, platform warnings). "
     "Urgent findings go to the person's Inbox once; set notify false to only read.", _obj({"notify": {"type": "boolean"}}), WRITE, ("producer",), _watch)
_add("content_studio_send_report", "Producer: put the weekly report (what won, what is retiring, what replaces it, spend) in the person's Inbox.",
     _obj({}), WRITE, ("producer",), _send_report)
_add("content_studio_record_warning", "Any team bot: record a platform warning, strike or limit on a channel. The channel is paused at once and the person is told.",
     _obj({"channel_id": _int(), "text": _str(500)}, ("channel_id", "text")), WRITE, ANY, _warning)
_add("content_studio_record_metrics", "Executor: record metrics snapshots for posted items, as new rows in the time series (never edits an earlier one). "
     "All rows are checked first; one bad row stores nothing.",
     _obj({"rows": {"type": "array", "minItems": 1, "maxItems": 500, "items": _obj({
         "post_id": _int(), "views": _int(), "avg_view_duration_s": {"type": "number"}, "video_length_s": {"type": "number"},
         "likes": _int(), "comments": _int(), "shares": _int(), "follows_gained": _int(),
         "taken_at": {"type": "number", "description": "Unix time the numbers were read; defaults to now"}},
         ("post_id", "views", "avg_view_duration_s", "video_length_s"))}}, ("rows",)),
     WRITE, ("executor",), _metrics)
