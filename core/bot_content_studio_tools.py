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

Formats (Video Styles build spec section 2): the Researcher writes format cards (save_format) and port proposals
(propose_port: a proven format from another niche into ours, with what changes); the Evaluator checks a port (audience
match, distance from the source, cost to make, the series rule) and accepts or rejects it (check_port, decide_port);
a pick from an accepted port records the 'port-proven-format' strategy, the format and the style pack on the post.

Characters (Video Styles unit 3): a post in the flat-2d style pack is made of scene beats with the account's own Pack A
characters. The pipeline lists them with the version each video may cast (the newest one the person approved); the
Editor designs a missing one with character_make and sends its sheet with character_sheet, and only the person
approves it. A flat-2d render is recorded only when its video has scene beats and every cast version is approved.

User-made style packs (Video Styles, user packs): the Producer and Editor can propose a pack (content_studio_propose_style_pack,
from a written brief turned into pack data, or by duplicating a pack with changes) and render its sample
(content_studio_style_pack_sample, which first sends any unapproved character sheet). Only the person approves a pack, in
Studio > Content > Styles; no tool approves. A channel uses its own pack by default, and a post in a user pack is recorded
only when its video is made in that pack's approved version.

Long videos (Video Styles unit 4; the locked cadence: one long video a week per YouTube channel plus daily Shorts): the
Evaluator picks a long video with long_form true, only within the channel's long videos a week (a soft cap the person sets
on the channel; one on YouTube by default). The Script Writer writes it in chapters, the Editor builds it as a chaptered
video and sends its shot plan to the person (content_studio_submit_plan); it renders only after they approve the plan, and
its render carries the chapter timestamps the YouTube description uses. Shorts keep the daily flow.

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
from services.content_studio import StudioError, delivery, formats, pipeline, policy, review, studio, team, youtube, youtube_publish


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
                 "notes": c["notes"], "voice": c["voice"], "style_pack": c.get("style_pack") or "motion-type",
                 "renderer_3d": c.get("renderer") or "the style pack's own",
                 "long_videos_a_week": studio.long_cap(c), "long_videos_last_7_days": studio.long_this_week(c["id"])}
                for c in studio.list_channels(status="live")]
    strategies = {r: [{"id": s["id"], "name": s["name"], "default": bool(s["is_default"])}
                      for s in sorted(studio.list_strategies(r, "active"), key=lambda s: not s["is_default"])]
                  for r in ("script_writer", "evaluator")}
    wanted = [{"decision_id": d["id"], "replaces": d["subject_name"]} for d in studio.list_decisions(status="open", kind="replace")
              if d["subject_type"] == "niche"]
    team.seed_strategies(studio)  # a team imported before a starting strategy existed gains it (a dropped one never returns)
    return _data(ctx, "content studio pipeline", {
        "you_are": role, "items": pipeline.pipeline(studio), "approvals_waiting": len(pipeline.approval_queue(studio)),
        "niches": [{"id": n["id"], "name": n["name"], "slots": n["slots"]} for n in studio.list_niches("live")],
        "channels": channels, "strategies": strategies, "niches_wanted": wanted,
        "formats": [{"id": f["id"], "name": f["name"]} for f in studio.list_formats("active")],
        "ports_accepted": [{"id": p["id"], "format": p["format_name"], "niche_id": p["niche_id"], "style_pack": p["style_pack"]}
                           for p in studio.list_ports(status="accepted")],
        "characters": _characters(),
        "style_packs": [{"id": p["id"], "name": p["name"], "base": p.get("base", p["id"]), "available": p["available"]}
                        for p in formats.packs()]})


def _characters():
    """The account's characters (Pack A flat, Pack B 3D): the version a video may cast (approved) and any waiting for the person."""
    from core import character_store
    def form(m):
        try:
            return character_store.form_of(character_store.spec(m["id"], m["versions"][-1]["version"]))
        except LookupError:
            return "2d"
    return [{"id": m["id"], "name": m["name"], "family": m["family"], "form": form(m), "castable_version": character_store.approved_version(m),
             "waiting_for_person": [v["version"] for v in m["versions"] if v["status"] == "awaiting_approval"]}
            for m in character_store.list_all()]


def _base(pack_id):
    """The built-in pack a post's pack is drawn by: itself for a built-in, the base of a user-made one."""
    pack = formats.all_packs().get(pack_id) or {}
    return pack.get("base", pack_id)


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
    port = studio.get_port(args["port_id"]) if args.get("port_id") else None
    if port and port["status"] != "accepted":
        raise StudioError(f"port {port['id']} is {port['status']}; only an accepted port is picked")
    strategy = team.pick_strategy(studio, args.get("strategy"), ported=port is not None)
    if any(p["topic_id"] == topic["id"] and p["channel_id"] == args["channel_id"] for p in studio.list_posts()):
        raise StudioError("that topic is already picked for this channel")
    format_id = port["format_id"] if port else args.get("format_id")
    card = studio.get_format(format_id) if format_id else None
    title = args.get("title") or topic["title"]
    fmt = card["name"] if card else args.get("format")
    early = (policy.persona_findings(title) + policy.hook_findings(title, "") +
             policy.sameness_findings(studio, args["channel_id"], title, "", fmt))
    if card:
        early += policy.distance_findings(card, {"title": title})
        early += policy.series_findings(studio, args["channel_id"], card["id"], topic["title"])
    if any(f["result"] == "reject" for f in early):
        raise StudioError("the policy checks stopped this pick: " + policy.reasons({"findings": early}))
    post = studio.create_post(args["channel_id"], title, topic_id=topic["id"],
                              evaluator_strategy_id=strategy["id"] if strategy else None, format=fmt,
                              pick_reason=args["reason"], format_id=format_id, port_id=port["id"] if port else None,
                              style_pack=args.get("style_pack"), long_form=bool(args.get("long_form")))
    if card:
        studio.add_evidence(post["id"], "port", {
            "by": bot["name"], "format": {k: card[k] for k in ("id", "name", "premise", "beats", "source_niche", "evidence")},
            "port": ({k: port[k] for k in ("id", "niche_name", "audience_match", "audience_evidence", "premise", "subject",
                                          "mascot", "style_pack", "thumbnail", "checks")} if port else None),
            "pick_checks": early})
    tail = " The Script Writer writes it next."
    if post["long_form"]:
        tail += (" It is this week's long video for the channel: the Script Writer writes it in chapters, and the Editor sends its "
                 "shot plan to the person with content_studio_submit_plan before rendering.")
    if post["style_pack"] not in formats.STYLE_PACKS:
        tail += (f" It is made in the user-made style pack {formats.all_packs()[post['style_pack']]['name']}: the Editor passes "
                 f"style_pack={post['style_pack']} to video_create, which applies the pack's approved look, voice and characters.")
    if _base(post["style_pack"]) == "glossy-3d":
        castable = [c["name"] for c in _characters() if c["castable_version"] and c.get("form") == "3d"]
        channel = studio.get_channel(post["channel_id"]) if post.get("channel_id") else {}
        renderer = (channel or {}).get("renderer")
        tail += (" It is a Glossy 3D post: the Script Writer writes stage beats (a studio set, the mascot, stand-in people and labels "
                 "over heads) for " + (", ".join(castable) if castable else "a 3D character the Editor makes and the person approves first")
                 + "." + (f" The channel renders 3D with {renderer}: the Editor passes renderer={renderer} to video_create." if renderer else ""))
    if _base(post["style_pack"]) == "flat-2d":
        castable = [c["name"] for c in _characters() if c["castable_version"]]
        tail += (" It is a Flat 2D post: the Script Writer writes scene beats for " + ", ".join(castable) + "." if castable else
                 " It is a Flat 2D post and no character is approved yet: the Editor designs one (character_make, character_sheet) "
                 "and the person approves its sheet before the video can render.")
    if card:
        tail += (f" It is an episode of the format \"{card['name']}\" in the {post['style_pack']} style pack: give it its own "
                 "concept, script and opening, and keep every name, mascot, line and look of the source out of it.")
    return _data(ctx, "content studio post", post) + tail


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


def _pack_matches(post, render_ref):
    """A flat-2d post's video is made of scene beats with approved characters (the render itself refuses others); a post
    in a user-made pack is made in that pack's approved version."""
    user_pack = post["style_pack"] not in formats.STYLE_PACKS
    if _base(post["style_pack"]) not in ("flat-2d", "glossy-3d") and not user_pack:
        return
    match = _STUDIO_RENDER.match((render_ref or "").strip())
    if not match:
        raise StudioError("this post's render_ref is its Studio render link, so its pack and cast can be checked")
    from core import style_pack_store, video_render, video_store
    try:
        project = video_store.get(match.group(1))
    except LookupError:
        raise StudioError("that Studio render's video is not in this account")
    if user_pack:
        pin = project.get("style_pack") or {}
        if pin.get("id") != post["style_pack"]:
            raise StudioError("the video is not made in this post's style pack; make it with video_create style_pack="
                              + post["style_pack"])
        if not style_pack_store.is_approved(pin["id"], pin["version"]):
            raise StudioError("the video uses a version of the style pack the person has not approved")
    if _base(post["style_pack"]) == "glossy-3d":
        if not any(b["kind"] == "stage" for b in project["beats"]) or not project.get("cast"):
            raise StudioError("a Glossy 3D post needs stage beats with a cast 3D character; this video has none")
    elif _base(post["style_pack"]) != "flat-2d":
        return
    elif not any(b["kind"] == "scene" for b in project["beats"]) or not project.get("cast"):
        raise StudioError("a Flat 2D post needs scene beats with cast characters; this video has none")
    problems = video_render.cast_problems(project)
    if problems:
        raise StudioError(" ".join(problems))


def _long_matches(post, render_ref):
    """A long post's render is its chaptered video, made after the person approved the plan; a Short's is not chaptered."""
    match = _STUDIO_RENDER.match((render_ref or "").strip())
    if not match:
        if post["long_form"]:
            raise StudioError("a long video's render_ref is its Studio render link, so its chapters and plan approval can be checked")
        return
    from core import video_plan, video_store
    try:
        project = video_store.get(match.group(1))
    except LookupError:
        raise StudioError("that Studio render's video is not in this account")
    if not post["long_form"]:
        if video_store.chaptered(project):
            raise StudioError("this post is a Short, but the video is a long one in chapters; make the Short as its own video")
        return
    if not video_store.chaptered(project):
        raise StudioError("this post is the channel's long video; make it in chapters (video_create chapters)")
    if post["video_id"] and post["video_id"] != project["id"]:
        raise StudioError("the render is of another video than the one whose plan the person was sent")
    problems = video_plan.problems(project)
    if problems:
        raise StudioError(" ".join(problems))


def _submit_plan(args, ctx, bot, role):
    from core import video_narration, video_plan, video_store
    post = _drafted(args["post_id"])
    if not post["long_form"]:
        raise StudioError("only a long video's plan goes to the person before rendering; a Short follows the daily flow")
    try:
        project = video_store.get(args["video_id"])
    except LookupError:
        raise StudioError("no such video in this account")
    if not video_store.chaptered(project):
        raise StudioError("the video has no chapters; a long video is made in chapters (video_create chapters)")
    try:
        project = video_narration.prepare(project["id"])
        measured = True
    except video_narration.NarrationUnavailable:
        measured = False
    studio.link_video(post["id"], project["id"])
    data = video_plan.submit(project["id"], by=bot["name"], post_id=post["id"])
    text = video_plan.plan_text(project)
    studio.add_evidence(post["id"], "shot_plan", {"plan": text[:20000], "by": bot["name"], "video_id": project["id"], "long_form": True})
    if data["status"] == "approved":
        return "The person already approved this plan as it is. Render it with video_render, then record the render."
    video_plan.notify(project, data)
    minutes = round(video_store.duration(project) / 60, 1)
    return (f"The shot plan of '{project['title']}' ({minutes:g} minutes, {len(project['chapters'])} chapters) is with the person in "
            "Studio > Content > Approvals and their Inbox. Render it only after they approve it; video_render refuses until then."
            + ("" if measured else " The lengths are estimates: Kokoro is not ready, so the lines are not spoken yet."))


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
        _pack_matches(post, args.get("render_ref"))
        _long_matches(post, args.get("render_ref"))
        note = _channel_voice(post, args.get("render_ref"))
    for key in ("tags", "caption", "thumbnail"):
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


def _formats(args, ctx, bot, role):
    status = None if args.get("include_retired") else "active"
    cards = studio.list_formats(status)
    ports = [p for p in studio.list_ports() if args.get("include_retired") or p["status"] in ("proposed", "accepted")]
    return _data(ctx, "content studio formats", {"formats": cards, "ports": ports, "style_packs": formats.packs()})


def _save_format(args, ctx, bot, role):
    data = {k: v for k, v in args.items() if k != "format_id"}
    card = studio.save_format(data, by=bot["name"], format_id=args.get("format_id"))
    return _data(ctx, "content studio format", card) + (" Saved. Propose a port with content_studio_propose_port when another "
                                                        "of our niches has the same audience.")


def _port_result(port):
    result = policy.port_findings(studio, port)
    return result, studio.record_port_checks(port["id"], result)


def _propose_port(args, ctx, bot, role):
    data = {k: v for k, v in args.items() if k not in ("format_id", "niche_id")}
    port = studio.create_port(args["format_id"], args["niche_id"], data, by=bot["name"])
    result, port = _port_result(port)
    head = "Proposed. The Evaluator checks it and decides." if result["ok"] else \
        "Proposed, but the checks found problems the Evaluator will refuse; fix them with a new proposal: " + policy.reasons(result)
    return _data(ctx, "content studio port", port) + " " + head


def _check_port(args, ctx, bot, role):
    result, port = _port_result(studio.get_port(args["port_id"]))
    return _data(ctx, "content studio port checks", {"port_id": port["id"], "status": port["status"], **result})


def _decide_port(args, ctx, bot, role):
    port = studio.get_port(args["port_id"])
    if args["verdict"] == "accepted":
        result, port = _port_result(port)
        if not result["ok"]:
            raise StudioError("the port checks refuse it: " + policy.reasons(result))
    port = studio.decide_port(port["id"], args["verdict"], bot["name"], args["reason"])
    tail = (" Pick its episodes with content_studio_pick_topic and port_id; each one needs its own concept."
            if port["status"] == "accepted" else "")
    return _data(ctx, "content studio port", port) + tail


def _pack_line(meta):
    from core import style_pack_store
    versions = ", ".join(f"v{v['version']} {v['status'].replace('_', ' ')}"
                         + (f" (sample: {v['sample']['status']})" if v.get("sample") and v["status"] == "draft" else "")
                         for v in meta["versions"])
    data = style_pack_store.spec(meta["id"], style_pack_store.latest(meta)["version"])
    return {"id": meta["id"], "name": meta["name"], "versions": versions, "approved_version": style_pack_store.approved_version(meta),
            "renderer": data["renderer"], "base": data["base"], "summary": data["summary"], "origin": meta.get("origin", {}).get("kind")}


def _style_packs(args, ctx, bot, role):
    from core import style_pack_store
    out = {"built_in": [{"id": k, "name": v["name"], "available": v["available"], "note": v["note"]}
                        for k, v in formats.STYLE_PACKS.items()],
           "user_packs": [_pack_line(m) for m in style_pack_store.list_all()],
           "starters": style_pack_store.starters()}
    if args.get("pack_id"):
        try:
            meta = style_pack_store.get(args["pack_id"])
            version = args.get("version") or style_pack_store.latest(meta)["version"]
            out["pack"] = {**_pack_line(meta), "spec": style_pack_store.spec(meta["id"], version)}
        except LookupError as error:
            raise StudioError(str(error).strip("'"))
    return _data(ctx, "content studio style packs", out)


_PACK_KEYS = ("name", "summary", "renderer", "base", "look", "characters", "scenes", "pacing", "captions", "music", "voice")


def _propose_pack(args, ctx, bot, role):
    """A new pack from a written brief (the bot turns the brief into pack data), a duplicate of a pack, or a new version
    of a pack; always a draft until the person approves its sample."""
    from core import style_pack_brief, style_pack_store
    brief = (args.get("brief") or "").strip()
    fields = {k: args[k] for k in _PACK_KEYS if k in args}
    try:
        if args.get("pack_id"):
            if brief:
                fields["director_brief"] = brief
            meta = style_pack_store.new_version(args["pack_id"], fields, by=bot["name"], note=args.get("note", ""))
        elif args.get("duplicate_of"):
            meta = style_pack_store.duplicate(args["duplicate_of"], name=fields.pop("name", ""), by=bot["name"])
            if fields or brief:
                meta = style_pack_store.new_version(meta["id"], {**fields, **({"director_brief": brief} if brief else {})},
                                                    by=bot["name"], note=args.get("note", ""))
        else:
            if not brief:
                raise StudioError("a new pack starts from a written brief (brief), or duplicate_of an existing pack")
            data = style_pack_store.default_cast(style_pack_brief.from_fields(brief, fields), by=bot["name"])
            meta = style_pack_store.create(data, by=bot["name"], note=args.get("note", "") or "From a brief.",
                                           origin={"kind": "brief", "from": bot["name"], "brief": brief})
    except LookupError as error:
        raise StudioError(str(error).strip("'"))
    except ValueError as error:
        raise StudioError(str(error))
    v = style_pack_store.latest(meta)["version"]
    return _data(ctx, "content studio style pack", _pack_line(meta)) + (
        f" Version {v} is a draft. Render its sample with content_studio_style_pack_sample (pack_id {meta['id']}, version {v}); "
        "then the person approves or rejects it in Studio > Content > Styles. Tell the Producer it waits for them.")


async def _pack_sample(args, ctx, bot, role):
    from core import character_sheet, style_pack_sample, style_pack_store
    try:
        from services import bot_departments
        meta = await style_pack_sample.make(args["pack_id"], args["version"], owner=bot_departments.owner(bot) or bot["name"], by=bot["name"])
    except (character_sheet.Unavailable, RuntimeError) as error:
        raise StudioError(str(error))
    except LookupError as error:
        raise StudioError(str(error).strip("'"))
    except ValueError as error:
        raise StudioError(str(error))
    if meta["step"] == "sheets":
        waiting = style_pack_store.version_of(meta, args["version"])["sample"].get("waiting", [])
        return (f"The sample waits for the person to approve the character sheets of {', '.join(waiting)} (sent to Studio > Content > "
                "Approvals). Run this again once they are approved.")
    sample = style_pack_store.version_of(meta, args["version"])["sample"]
    notes = sample.get("notes") or []
    return (f"The sample of {meta['name']} version {args['version']} is rendered ({sample.get('seconds')} s) and waits for the person's "
            "approval in Studio > Content > Styles." + ("\nRender notes:\n" + "\n".join(notes) if notes else " No render notes."))


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
     "strategy is your pick strategy's name (the default when left out); it is recorded on the post. To make an episode of an accepted "
     "port, pass port_id: the pick records the port-proven-format strategy, the format card and the port's style pack, and the "
     "distance and series checks run on it. format_id uses one of our own format cards without a port.",
     _obj({"channel_id": _int("A live channel in the topic's niche"), "topic_id": _int(), "reason": _str(500, "Why this topic, in a sentence"),
           "strategy": _str(80), "title": _str(200, "Working title; the topic's title when left out"),
           "format": _str(80, "The format, for example 'list' or 'explainer', when there is no format card"),
           "port_id": _int("An accepted port this episode is made from"), "format_id": _int("A format card, when not from a port"),
           "style_pack": _str(40, "The style pack: motion-type, flat-2d, or the id of an approved user-made pack (content_studio_style_packs); "
                                  "the channel's own pack when left out"),
           "long_form": {"type": "boolean", "description": "This week's long video for a YouTube channel (chapters, several minutes), "
                                                           "within the channel's long videos a week; a Short when left out"}},
          ("channel_id", "topic_id", "reason")),
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
_add("content_studio_submit_plan", "Script Writer, Editor or Producer: send a long post's shot plan to the person before it renders. Give the "
     "post and its chaptered Studio video (video_create with chapters, then video_narrate). The lines are spoken and measured, the plan "
     "with its chapters is kept as the post's shot plan, and the person approves or rejects it in Studio > Content > Approvals. "
     "video_render refuses a long video until they approve; any later change to the plan needs them again.",
     _obj({"post_id": _int(), "video_id": _str(12, "The chaptered Studio video's id")}, ("post_id", "video_id")),
     WRITE, ("script_writer", "editor", "producer"), _submit_plan)
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
           "caption": _str(5000), "thumbnail": _str(300, "What the thumbnail shows, in a sentence")}, ("post_id", "status")),
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
_EVIDENCE_ROW = _obj({"url": _str(500, "https link to the source channel or video"), "channel": _str(100, "The source channel's name"),
                     "title": _str(200, "The source video's title"), "views": _int("Views when you saw it"),
                     "age_days": _int("The video's age in days when you saw it"), "checked": _str(10, "The date you checked, YYYY-MM-DD"),
                     "note": _str(300)}, ("url", "channel", "checked"))
_add("content_studio_formats", "Read the format cards, the port proposals (with their checks) and the style packs, with which packs can be made today.",
     _obj({"include_retired": {"type": "boolean"}}), READ, ANY, _formats)
_add("content_studio_save_format", "Researcher: save a format card, the reusable structure of a proven video format (not its content): the premise in "
     "one line, the beats, the typical length, the audience and the evidence (each row: the source link, channel, views and age when seen, the "
     "date checked). do_not_use lists the source's own names, mascots, series names and lines; the source channels are added to it. "
     "Pass format_id to save a new version of a card.",
     _obj({"format_id": _int("A card to update"), "name": _str(80, "A short name of our own, for example 'Impossible ability, one person at a time'"),
           "premise": _str(200, "The premise in one line"),
           "beats": {"type": "array", "minItems": 2, "maxItems": 12, "items": _str(80), "description": "The structure: hook, rules, repeating segment, escalation, twist, payoff"},
           "length_min_s": {"type": "number"}, "length_max_s": {"type": "number"},
           "audience": _obj({"age_band": _str(40), "interests": _str(300), "platform": {"type": "string", "enum": ["youtube", "tiktok", "instagram"]},
                             "why": _str(300, "Why they watch")}, ("age_band", "interests", "platform", "why")),
           "source_niche": _str(80), "do_not_use": {"type": "array", "maxItems": 30, "items": _str(80)},
           "evidence": {"type": "array", "minItems": 1, "maxItems": 20, "items": _EVIDENCE_ROW}},
          ("name", "premise", "beats", "length_min_s", "length_max_s", "audience", "source_niche", "evidence")),
     WRITE, ("researcher",), _save_format)
_add("content_studio_propose_port", "Researcher: propose porting a format card into one of our live niches: why that niche's audience matches the "
     "source's (with dated links), and what changes: the new premise wording, the subject, our own mascot (or 'none'), the style pack, the "
     "thumbnail and an example title. The Evaluator's checks run at once and are returned; the Evaluator decides.",
     _obj({"format_id": _int(), "niche_id": _int("Our live niche it goes into"), "audience_match": _str(500, "Why the audiences match"),
           "audience_evidence": {"type": "array", "minItems": 1, "maxItems": 10, "items": _obj({
               "url": _str(500), "supports": _str(300, "What it shows"), "checked": _str(10, "YYYY-MM-DD")}, ("url", "supports", "checked"))},
           "premise": _str(200, "The premise in our own words for the new niche"), "subject": _str(200),
           "mascot": _str(80, "Our own mascot or character, or 'none'"),
           "style_pack": _str(40, "motion-type, flat-2d, or a user-made pack's id"),
           "thumbnail": _str(300, "What the thumbnail shows"), "example_title": _str(200)},
          ("format_id", "niche_id", "audience_match", "audience_evidence", "premise", "subject", "mascot", "style_pack", "thumbnail", "example_title")),
     WRITE, ("researcher",), _propose_port)
_add("content_studio_check_port", "Evaluator or Producer: run the port checks: audience match with evidence, distance from the source (no source "
     "names, mascots or lines; a title or thumbnail that could be mistaken for the source's is refused), cost to make in the chosen style "
     "pack, and the series rule. The result is kept on the port.",
     _obj({"port_id": _int()}, ("port_id",)), WRITE, ("evaluator", "producer"), _check_port)
_add("content_studio_decide_port", "Evaluator: accept or reject a proposed port, with the reason. Accepting runs the checks again and is refused "
     "while any check refuses it. Only an accepted port's episodes can be picked.",
     _obj({"port_id": _int(), "verdict": {"type": "string", "enum": ["accepted", "rejected"]}, "reason": _str(500)},
          ("port_id", "verdict", "reason")), WRITE, ("evaluator",), _decide_port)
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
_PACK_SCHEMA = {
    "name": _str(60, "The pack's name. A pack we propose never carries a real channel's name"),
    "summary": _str(300, "One or two sentences on the look"),
    "renderer": {"type": "string", "enum": ["2d-engine", "blender", "threejs"], "description": "Only 2d-engine renders today"},
    "base": {"type": "string", "enum": ["motion-type", "flat-2d"], "description": "flat-2d for characters in scenes, motion-type for type"},
    "look": {"type": "object", "description": "design_look (a Studio look id), palette (dawn, mint, dusk, night, paper, or {sky: [top, bottom], far, mid, "
                                              "near, ground, prop, ink, glow} as hex), families (round, square, triangle), outline (4-14), lighting (flat, soft, glow)"},
    "characters": {"type": "array", "maxItems": 6, "items": _obj({"character": _str(12), "version": _int()}, ("character", "version")),
                   "description": "Character ids and versions from character_list (flat-2d only)"},
    "scenes": {"type": "object", "description": "settings, shots, props, cameras, transitions: the subsets the pack uses"},
    "pacing": {"type": "object", "description": "words_per_second (1.5-4), shot_seconds [shortest, longest], hook_seconds"},
    "captions": {"type": "object", "description": "on (true/false), case (sentence or upper)"},
    "music": {"type": "object", "description": "mood (energetic, calm, warm, dark, playful), volume 0-1"},
    "voice": {"type": "object", "description": "voice: a Kokoro voice id; a channel keeps one voice"},
}
_add("content_studio_style_packs", "Read the style packs: the built-in ones, this account's own packs with each version's status, and the starter "
     "packs. Pass pack_id (and version) for one pack's full data and director brief.",
     _obj({"pack_id": _str(12), "version": _int()}), READ, ANY, _style_packs)
_add("content_studio_propose_style_pack", "Producer or Editor: propose a user-made style pack. New: give the person's written brief as brief and turn it "
     "into the pack fields yourself (look, scenes, pacing, captions, music, voice, characters); the brief stays attached as the director brief. "
     "Or duplicate_of an existing pack with changes, or pack_id to make a new version (a change to the brief too). Use our own geometric "
     "characters only; never name or copy a real channel's characters, logos, artwork or scenes, and never put a real channel's name on a "
     "pack we propose. Always a draft: render its sample next; only the person approves a pack.",
     _obj({"brief": _str(12000, "The written brief, kept as the director brief"), "duplicate_of": _str(12), "pack_id": _str(12),
           "note": _str(300, "What changed and why"), **_PACK_SCHEMA}), WRITE, ("producer", "editor"), _propose_pack)
_add("content_studio_style_pack_sample", "Producer or Editor: render a style pack version's sample (a short narrated video in the pack, through the app's "
     "own render path) and send it for the person's approval. Character sheets in the pack that are not approved yet are rendered and sent "
     "to the person first, and the sample waits for them. Needs the desktop app. Only the person approves.",
     _obj({"pack_id": _str(12), "version": _int()}, ("pack_id", "version")), WRITE, ("producer", "editor"), _pack_sample)
