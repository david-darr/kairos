"""Kairos tools for the Content Studio team's bots (build spec "Content Studio Team", sections 3 and 4).

Each tool acts in the calling bot's own account, on that account's studio store (services/content_studio),
and only for the role the store records for that bot (services/content_studio/team.py): a bot that is not on
the team, or is on it in another role, is refused. Reads are fenced as data. No tool approves a post, creates a
channel, adds a niche or retires a channel without the person: a Producer confirm of a channel retirement or a new
niche goes to `awaiting_user`, and approval stays with the person (/api/content-studio/posts/{id}/approve). The
Publisher's direct YouTube upload only ever sends a post the person approved, through their own Google project.

The daily cycle, one tool per step: Researcher add_topic (and propose_niche, youtube_trending), Evaluator
pick_topic, Script Writer save_script (with the shot plan and sources), Editor record_render then submit_post, the
person approves, Publisher publish_youtube or mark_posted, Executor record_metrics and run_review, Producer watch,
confirm and send_report.

Policy checks (services/content_studio/policy.py) run at the pick, when a script is saved and when a post is queued:
sameness against the channel's last 30 posts, no narrator presented as a health, legal, money or political expert, no
distress or rescue hooks, no cross-posting between the team's own channels, and the AI label on every post. The
Evaluator and Producer can run them on demand (check_post). Each post keeps its approval, shot plan, sources and check
results as appeal evidence (post_evidence).
"""
import json
import re
from urllib.parse import urlsplit

from core.tool_registry import READ, WRITE, register
from core.untrusted import wrap_untrusted
from services.content_studio import StudioError, delivery, pipeline, policy, review, studio, team, youtube, youtube_publish


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
            result = fn(args, ctx, bot, role)
            return await result if hasattr(result, "__await__") else result
        except Refused as error:
            return f"Not run: {error}"
        except StudioError as error:
            return f"Not run: {error.detail}"
    return handler


def _add(name, description, schema, effect, roles, fn):
    register(name, description, schema, agent_only=True, effect=effect)(_guarded(roles, fn))


ANY = None


def _pipeline(args, ctx, bot, role):
    """The board plus what each step needs: the live channels with their look, aspect and voice notes, the
    active strategies (the default first) and any open request for a replacement niche."""
    channels = [{"id": c["id"], "niche_id": c["niche_id"], "niche": c["niche_name"], "platform": c["platform"], "handle": c["handle"],
                 "paused": bool(c["paused"]), "look": c["look"], "aspect": c["aspect"] or "9:16",
                 "notes": c["notes"], "voice": c["voice"]} for c in studio.list_channels(status="live")]
    strategies = {r: [{"id": s["id"], "name": s["name"], "default": bool(s["is_default"])}
                      for s in sorted(studio.list_strategies(r, "active"), key=lambda s: not s["is_default"])]
                  for r in ("script_writer", "evaluator")}
    wanted = [{"decision_id": d["id"], "replaces": d["subject_name"]} for d in studio.list_decisions(status="open", kind="replace")
              if d["subject_type"] == "niche"]
    return _data(ctx, "content studio pipeline", {
        "you_are": role, "items": pipeline.pipeline(studio), "approvals_waiting": len(pipeline.approval_queue(studio)),
        "niches": [{"id": n["id"], "name": n["name"], "slots": n["slots"]} for n in studio.list_niches("live")],
        "channels": channels, "strategies": strategies, "niches_wanted": wanted})


def _drafted(post_id):
    post = studio.get_post(post_id)
    if post["state"] != "drafted":
        raise StudioError(f"post {post_id} is {post['state'].replace('_', ' ')}, not drafted")
    return post


def _refuse_if_rejected(post_id, result, step):
    studio.add_evidence(post_id, "policy_check", {"step": step, **result})
    if not result["ok"]:
        raise StudioError("the policy checks stopped this: " + policy.reasons(result))


def _pick(args, ctx, bot, role):
    topic = studio.get_topic(args["topic_id"])
    strategy = team.strategy_by_name(studio, "evaluator", args.get("strategy"))
    if any(p["topic_id"] == topic["id"] and p["channel_id"] == args["channel_id"] for p in studio.list_posts()):
        raise StudioError("that topic is already picked for this channel")
    title = args.get("title") or topic["title"]
    early = (policy.persona_findings(title) + policy.hook_findings(title, "") +
             policy.sameness_findings(studio, args["channel_id"], title, "", args.get("format")))
    if any(f["result"] == "reject" for f in early):
        raise StudioError("the policy checks stopped this pick: " + policy.reasons({"findings": early}))
    post = studio.create_post(args["channel_id"], args.get("title") or topic["title"], topic_id=topic["id"],
                              evaluator_strategy_id=strategy["id"] if strategy else None, format=args.get("format"),
                              pick_reason=args["reason"])
    return _data(ctx, "content studio post", post) + " The Script Writer writes it next."


_URL = re.compile(r"^https?://[^\s]+$")


def _sources(raw):
    """The sources behind the script's facts: each a link with what it supports and the date it was read."""
    out = []
    for n, item in enumerate(raw or []):
        if not isinstance(item, dict) or not isinstance(item.get("url"), str) or not _URL.match(item["url"].strip()):
            raise StudioError(f"sources[{n}] needs the https link it came from")
        out.append({"url": item["url"].strip()[:500], "supports": str(item.get("supports") or "")[:300],
                    "date": str(item.get("date") or "")[:40]})
    return out


def _script(args, ctx, bot, role):
    post = _drafted(args["post_id"])
    strategy = team.strategy_by_name(studio, "script_writer", args.get("strategy"))
    title = args.get("title") or post["title"]
    _refuse_if_rejected(args["post_id"], policy.check(studio, args["post_id"], title=title, script=args["script"]), "script")
    sources = _sources(args.get("sources"))
    fields = {"script_ref": args["script"], "script_strategy_id": strategy["id"] if strategy else None}
    for key in ("title", "caption"):
        if args.get(key):
            fields[key] = args[key]
    post = studio.edit_post(args["post_id"], **fields)
    if args.get("shot_plan"):
        studio.add_evidence(args["post_id"], "shot_plan", {"plan": args["shot_plan"], "by": bot["name"]})
    if sources:
        studio.add_evidence(args["post_id"], "sources", {"sources": sources, "by": bot["name"]})
    tail = " The Editor renders it next."
    if not args.get("shot_plan") and not studio.evidence(args["post_id"], "shot_plan"):
        tail += " It has no shot plan yet: the Editor records it (video_narrate gives the timed plan) before rendering."
    return _data(ctx, "content studio post", post) + tail


def _shot_plan(args, ctx, bot, role):
    _drafted(args["post_id"])
    studio.add_evidence(args["post_id"], "shot_plan", {"plan": args["plan"], "by": bot["name"]})
    return "Shot plan recorded on the post; the Producer brings it with the post for approval."


def _check(args, ctx, bot, role):
    result = policy.check(studio, args["post_id"], title=args.get("title"), script=args.get("script"), fmt=args.get("format"))
    studio.add_evidence(args["post_id"], "policy_check", {"step": "check", "by": bot["name"], **result})
    return _data(ctx, "content studio policy check", result)


def _evidence(args, ctx, bot, role):
    return _data(ctx, "content studio evidence", studio.evidence(args["post_id"]))


_STUDIO_RENDER = re.compile(r"^/api/videos/([a-f0-9]{12})/renders/[A-Za-z0-9._-]+\.mp4$")


def _channel_voice(post, render_ref):
    """A channel keeps one narrator voice: the first narrated render sets it, later ones must match it."""
    match = _STUDIO_RENDER.match((render_ref or "").strip())
    if not match:
        return ""
    from core import video_store
    try:
        project = video_store.get(match.group(1))
    except LookupError:
        raise StudioError("that Studio render's video is not in this account")
    if not video_store.narrated(project):
        return ""
    voice, channel = project["narration"]["voice"], studio.get_channel(post["channel_id"])
    if channel["voice"] and channel["voice"] != voice:
        raise StudioError(f"this channel's narrator is {channel['voice']}, but the video is narrated by {voice}; "
                          f"set narration.voice to {channel['voice']} and render again")
    if not channel["voice"]:
        studio.edit_channel(channel["id"], voice=voice)
        return f" The channel's narrator voice is now {voice}; its later videos use the same voice."
    return ""


def _render(args, ctx, bot, role):
    post = _drafted(args["post_id"])
    if not post["script_ref"]:
        raise StudioError("the post has no script yet; the Script Writer writes it first")
    fields = {"render_status": args["status"]}
    note = ""
    if args.get("render_ref"):
        fields["render_ref"] = args["render_ref"]
    elif args["status"] == "ok":
        raise StudioError("a finished render needs its render_ref (the Studio render or file link)")
    if args["status"] == "ok":
        if not studio.evidence(args["post_id"], "shot_plan"):
            raise StudioError("record the shot plan first (content_studio_save_shot_plan with the plan video_narrate returned)")
        note = _channel_voice(post, args.get("render_ref"))
    for key in ("tags", "caption"):
        if args.get(key) is not None:
            fields[key] = args[key]
    post = studio.edit_post(args["post_id"], **fields)
    tail = " Put it in the approval queue with content_studio_submit_post." if args["status"] == "ok" else " The Producer's watch sees the failure."
    return _data(ctx, "content studio post", post) + tail + note


PLATFORM_HOSTS = {"youtube": ("youtube.com", "youtu.be"), "tiktok": ("tiktok.com",), "instagram": ("instagram.com",)}


def _posted(args, ctx, bot, role):
    post = studio.get_post(args["post_id"])
    url = (args.get("url") or "").strip()
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    allowed = PLATFORM_HOSTS.get(post["platform"], ())
    if parts.scheme != "https" or not any(host == h or host.endswith("." + h) for h in allowed):
        raise StudioError(f"the link must be the https link of the live post on {post['platform']}")
    return _data(ctx, "content studio post", studio.mark_posted(args["post_id"], url)) + " Its numbers can be recorded now."


async def _publish(args, ctx, bot, role):
    result = await youtube_publish.publish(studio, args["post_id"], bot["name"])
    note = (" " + result["note"]) if result["note"] else ""
    return _data(ctx, "content studio upload", {k: result[k] for k in ("video_id", "url", "privacy", "asked_privacy")}) + note


def _propose_niche(args, ctx, bot, role):
    decision = review.propose_niche(studio, args["name"], args["source"], args.get("signal", ""), args.get("reason", ""),
                                    proposed_by=bot["name"])
    return _data(ctx, "content studio decision", decision) + " The Producer confirms it, then the person decides and creates its channels."


async def _trending(args, ctx, bot, role):
    return _data(ctx, "youtube most popular", await youtube.trending(args.get("region") or "US", args.get("category_id"), args.get("count") or 20))


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
_add("content_studio_pick_topic", "Evaluator: pick a topic candidate for one channel, with a short reason. It becomes a post the Script Writer writes. "
     "strategy is your pick strategy's name (the default when left out); it is recorded on the post.",
     _obj({"channel_id": _int("A live channel in the topic's niche"), "topic_id": _int(), "reason": _str(500, "Why this topic, in a sentence"),
           "strategy": _str(80), "title": _str(200, "Working title; the topic's title when left out"),
           "format": _str(80, "The format, for example 'list' or 'explainer'")}, ("channel_id", "topic_id", "reason")),
     WRITE, ("evaluator",), _pick)
_add("content_studio_save_script", "Script Writer: save the script with its beat outline and narration lines for a drafted post, and optionally its "
     "title, caption draft, timestamped shot plan and the sources behind its facts (each {url, supports, date}). strategy is your script "
     "strategy's name (the default when left out); it is recorded on the post. The policy checks run first: a near-copy of a recent post, "
     "a narrator presented as a health, legal, money or political expert, or a distress or rescue hook is refused with the reason.",
     _obj({"post_id": _int(), "script": _str(20000), "strategy": _str(80), "title": _str(200), "caption": _str(5000),
           "shot_plan": _str(20000, "Timestamped shot plan: each shot's time, what is on screen and the narration line"),
           "sources": {"type": "array", "maxItems": 20, "items": _obj({"url": _str(500), "supports": _str(300, "Which claim it backs"),
                                                                       "date": _str(40, "When it was read")}, ("url",))}},
          ("post_id", "script")),
     WRITE, ("script_writer",), _script)
_add("content_studio_save_shot_plan", "Script Writer or Editor: record the timestamped shot plan of a drafted post (video_narrate returns it with "
     "measured times). It goes to the person with the post, and a render cannot be recorded without one.",
     _obj({"post_id": _int(), "plan": _str(20000)}, ("post_id", "plan")), WRITE, ("script_writer", "editor"), _shot_plan)
_add("content_studio_check_post", "Evaluator or Producer: run the policy checks on a post, or on a draft of its title, script or format: sameness "
     "against the channel's last 30 posts, AI personas posing as experts on health, law, money or politics, distress or rescue hooks, "
     "cross-posting between the team's own channels, and the AI label. The result is kept on the post as evidence.",
     _obj({"post_id": _int(), "title": _str(200), "script": _str(20000), "format": _str(80)}, ("post_id",)),
     WRITE, ("evaluator", "producer"), _check)
_add("content_studio_post_evidence", "Read a post's appeal evidence: the person's approval, the shot plan, the sources and the policy checks.",
     _obj({"post_id": _int()}, ("post_id",)), READ, ANY, _evidence)
_add("content_studio_record_render", "Editor: record the render of a scripted post: status ok with render_ref (the link video_render returned, "
     "or the Studio video id), or failed. Optionally the tags (comma separated) and the final caption. Needs the shot plan on record. "
     "A narrated render must use the channel's narrator voice; the first one sets it.",
     _obj({"post_id": _int(), "status": {"type": "string", "enum": ["ok", "failed"]}, "render_ref": _str(500), "tags": _str(500),
           "caption": _str(5000)}, ("post_id", "status")),
     WRITE, ("editor",), _render)
_add("content_studio_mark_posted", "Publisher: record the live link of an approved post the person posted (Prepare post), so its numbers can be tracked. "
     "The link must be the https link on the post's own platform.",
     _obj({"post_id": _int(), "url": _str(500)}, ("post_id", "url")), WRITE, ("publisher",), _posted)
_add("content_studio_publish_youtube", "Publisher: upload an approved YouTube post exactly as approved, with the AI label, through the person's own "
     "connected Google project, and record its link. Only works when the person connected YouTube posting. YouTube may keep it private.",
     _obj({"post_id": _int()}, ("post_id",)), WRITE, ("publisher",), _publish)
_add("content_studio_propose_niche", "Researcher: propose a candidate new niche (for example to replace a retired one), with its source and signal. "
     "The Producer confirms it and the person decides; nothing is created until they do.",
     _obj({"name": _str(80), "source": _str(300, "Where the evidence is"), "signal": _str(300, "What is rising and by how much"),
           "reason": _str(300)}, ("name", "source")), WRITE, ("researcher",), _propose_niche)
_add("content_studio_youtube_trending", "Researcher: read YouTube's most-popular list for a region (and optionally a category), each video with its "
     "source link and the date read. Needs the person's YouTube analytics connection.",
     _obj({"region": _str(2, "Two-letter country code, default US"), "category_id": _str(4, "YouTube video category number"),
           "count": {"type": "integer", "minimum": 1, "maximum": 50}}), READ, ("researcher",), _trending)
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
