"""The same beat-sheet video workflow on every model, through the tool registry."""
from __future__ import annotations
import asyncio
import copy
import json
from core import (character_sheet, character_store, creative_direction, design_store, design_systems, design_tools, ffmpeg_tools,
                  image_gen, style_packs, video_narration, video_render, video_store)
from core.tool_registry import ALL, READ, WRITE, ToolResult, _object, _str, register
from core.untrusted import wrap_untrusted

LINKED_TOOLS = frozenset({"video_outline", "video_edit", "video_add_image", "video_preview", "video_render", "video_narrate"})
SCENES = ("Pack A (flat 2D with characters): cast approved characters (character_list; make one with character_make, then "
          "character_sheet sends its sheet to the person, and only an approved version can be rendered) as cast=[{character, version}] "
          "and palette (dawn, mint, dusk, night or paper; one per channel). A scene beat is kind scene with scene={setting: meadow, city, "
          "space, room, ocean or lab; shot: wide, medium or close; cast: up to 3 of {character, x 0-1, view front|three_quarter|side|back, "
          "turn (the view the head turns to mid-beat), expression neutral|happy|surprised|worried|thinking, action idle|wave|point|walk|"
          "jump|shrug|think|nod, speaking true for the one who says the beat's line, facing left|right}; props: up to 6 of {icon, x, y, "
          "size, float}} and optional short text as a label. The speaking character's mouth follows the narration. Mix scene beats with "
          "the other kinds (a big-number or list between scenes). ")
FLOW = ("Workflow: creative_direction(type=video) -> video_create with a beat sheet (one idea per beat, "
        "3 to 8 words on screen, 1 to 2 bars each, end card last; vary the kinds: at most half statements, a big-number "
        "for a figure, a list, a quote, and an image or split beat with a photo from image_search) -> video_preview -> "
        "fix with video_edit -> video_render. ")
NARRATION = ("Narration: give a beat a say line (what the narrator speaks over it, one or two short sentences, at most "
             f"{video_store.SAY_LIMIT} characters, no clause over {video_store.CLAUSE_LIMIT} without a comma) and the video is "
             "voiced by Kokoro, locally and free. Each line's spoken length sets its beat's length (bars are ignored there); "
             "captions are burned in from the lines; the music ducks under the voice. narration={voice, captions} picks the "
             "Kokoro voice (default af_heart; a channel keeps one voice) and captions on or off. Narrated videos may run to "
             f"{video_store.NARRATED_MAX_SECONDS} seconds and {video_store.NARRATED_MAX_BEATS} beats. Run video_narrate for the "
             "timestamped shot plan before rendering. ")
PACKS = ("Style packs: style_pack names one of this account's approved user-made packs (content_studio_style_packs or the Styles tab "
         "lists them); the video then takes the pack's look, palette, lighting, music, voice, caption style and character set unless "
         "you give your own, renders only in the pack's approved version, and the render notes name any setting, shot, prop, camera, "
         "transition or shot length outside the pack's rules. ")
_ID = _str("Video id; optional when this chat has one linked video")
_ASPECT = {"type": "string", "enum": list(video_store.ASPECTS)}


def linked(key):
    return bool(video_store.videos_for_chat(key))


def video_mode(key):
    # The existing persisted design mode is the shared creative workspace.
    return design_store.design_mode(key) or linked(key)


def _owner(ctx):
    """Resolve a trusted owner before looking up private styles or source assets."""
    from core import task_scope
    return ctx.owner_user or task_scope.current_owner(agent_id=ctx.agent_id) or design_tools._owner(ctx)


def _video(args, ctx):
    key = design_store.chat_key(ctx.session_id, ctx.agent_id)
    if not key:
        raise LookupError("Videos belong to a chat; this call has none.")
    if args.get("video_id"):
        return video_store.require_chat_access(args["video_id"], key)
    mine = video_store.videos_for_chat(key)
    if len(mine) != 1:
        raise LookupError("Call video_create first." if not mine else "This chat has several videos; pass video_id: " + ", ".join(p["id"] for p in mine))
    return mine[0]


def _safe(ctx, text):
    if ctx.turn_taint:
        ctx.turn_taint.mark("video content")
    return wrap_untrusted("video content", text)


def _guard(handler):
    async def run(args, ctx):
        try:
            return await handler(args, ctx)
        except (ValueError, LookupError, PermissionError, RuntimeError, OSError) as error:
            return "Not run: " + str(error).strip("'\"")
    run.__name__ = handler.__name__
    return run


def _outline(project):
    beats = video_render.outline(project)
    voice = project.get("narration", {}).get("voice") if video_store.narrated(project) else None
    lines = [f"Video {project['id']}: {project['title']} ({round(video_store.duration(project), 2):g}s, version {project['version']}"
             + (f", narrated by {voice}" if voice else "") + ")"]
    for b in beats:
        line = f"- {b['id']} {round(b['start'], 2):g}-{round(b['end'], 2):g}s {b['kind']}: {b.get('text', b.get('number', ''))}"
        if "say" in b:
            line += f" | says: {b['say']}" + ("" if "spoken" in b else " (length estimated until video_narrate)")
        lines.append(line)
    return "\n".join(lines)


_NARRATION = {"type": "object", "properties": {"voice": _str("Kokoro voice id, e.g. af_heart, am_michael, bf_emma, bm_george"),
                                               "captions": {"type": "boolean"}}}


@register("video_create", FLOW + NARRATION + SCENES + PACKS + "Create a video project with a chosen look and beats; returns a Studio link. Pick a look with creative_direction(type=video) first.",
          _object({"title": _str("Video title"), "look": _str("Look id from creative_direction"),
                   "beats": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": video_store.NARRATED_MAX_BEATS},
                   "narration": _NARRATION,
                   "cast": {"type": "array", "maxItems": video_store.MAX_CAST, "items": {"type": "object", "properties": {
                       "character": _str("Character id from character_list"), "version": {"type": "integer"}}}},
                   "palette": {"type": "string", "enum": list(style_packs.PALETTES)},
                   "style_pack": _str("A user-made style pack's id; its approved version is used"),
                   "aspects": {"type": "array", "items": _ASPECT}, "bpm": {"type": "number", "minimum": 60, "maximum": 180},
                   "music": {"type": "object", "properties": {"mood": {"type": "string", "enum": list(video_store.MOODS)},
                                                              "volume": {"type": "number", "minimum": 0, "maximum": 1}}}},
                  ("title", "look", "beats")), surfaces=ALL, effect=WRITE)
@_guard
async def _create(args, ctx):
    key = design_store.chat_key(ctx.session_id, ctx.agent_id)
    if not key:
        raise ValueError("A video must be created from a chat.")
    owner = _owner(ctx)
    args = dict(args)
    if args.get("style_pack"):
        from core import style_pack_store
        pack_id = args.pop("style_pack")
        meta, version, data = style_pack_store.usable(pack_id)
        defaults = style_pack_store.video_defaults(data)
        if not any(isinstance(b, dict) and b.get("kind") == "scene" for b in args.get("beats") or []):
            defaults.pop("cast", None)
        for key, value in defaults.items():
            args.setdefault(key, value)
        args["style_pack"] = {"id": meta["id"], "version": version}
    look = args.get("look")
    if not look:
        return _safe(ctx, "Pick a look first. " + creative_direction.describe(args.get("title", ""), "video", owner=owner))
    if not design_systems.visible(design_systems.get(look), owner, ctx.is_admin):
        raise ValueError("look: choose a visible look with creative_direction(type=video).")
    beats = copy.deepcopy(args.get("beats"))
    if isinstance(beats, list):
        for i, beat in enumerate(beats):
            if isinstance(beat, dict):
                beat.setdefault("id", f"b{i + 1}")
    options = {k: args[k] for k in ("aspects", "bpm", "music", "narration", "cast", "palette", "style_pack") if k in args}
    project = video_store.create(args.get("title"), look=look, beats=beats, owner=owner, chat_key_=key, **options)
    title = project["title"].replace("[", "").replace("]", "").replace("\n", " ")
    step = "video_narrate for the shot plan, " if video_store.narrated(project) else ""
    return _safe(ctx, _outline(project) + f"\n[Video: {title}](/videos/{project['id']})\nNext: {step}video_preview, fix with video_edit, then video_render.")


@register("video_outline", "Read beat ids, timing and text before making small changes with video_edit.",
          _object({"video_id": _ID}), surfaces=ALL, effect=READ)
@_guard
async def _read(args, ctx):
    return _safe(ctx, _outline(_video(args, ctx)))


def edit(project, ops):
    """Apply all operations to a copy; the caller commits only a validated result."""
    draft = copy.deepcopy(project)
    if not isinstance(ops, list) or not 1 <= len(ops) <= 200:
        raise ValueError("ops: give 1 to 200 operations.")
    def index(beat_id):
        for i, beat in enumerate(draft["beats"]):
            if beat["id"] == beat_id:
                return i
        raise ValueError(f"id: no beat {beat_id}; read video_outline for ids.")
    for n, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ValueError(f"ops[{n}]: give an operation object.")
        kind = op.get("op")
        if kind == "project":
            if op.get("field") not in ("title", "look", "bpm", "aspects", "music", "narration", "cast", "palette", "style_pack") or "value" not in op:
                raise ValueError(f"ops[{n}].field: project edits title, look, bpm, aspects, music, narration, cast, palette or style_pack with value.")
            draft[op["field"]] = op["value"]
        elif kind == "set":
            if op.get("field") not in ("kind", "bars", "text", "sub", "number", "items", "image", "camera", "transition", "treatment", "say", "scene") or "value" not in op:
                raise ValueError(f"ops[{n}].field: choose a beat field from video_outline and give value.")
            if op["field"] == "say" and op["value"] in (None, ""):
                draft["beats"][index(op.get("id"))].pop("say", None)   # an empty line takes the narration off that beat
            else:
                draft["beats"][index(op.get("id"))][op["field"]] = op["value"]
        elif kind == "remove":
            draft["beats"].pop(index(op.get("id")))
        elif kind in ("insert", "move"):
            if ("before" in op) == ("after" in op):
                raise ValueError(f"ops[{n}]: choose exactly one of before or after, naming a beat id.")
            side = "before" if "before" in op else "after"
            target = op[side]
            index(target)
            if kind == "move":
                if op.get("id") == target:
                    raise ValueError(f"ops[{n}].id: a beat cannot move relative to itself.")
                beat = draft["beats"].pop(index(op.get("id")))
            else:
                beat = copy.deepcopy(op.get("beat"))
                if not isinstance(beat, dict):
                    raise ValueError(f"ops[{n}].beat: give a beat object.")
            draft["beats"].insert(index(target) + (side == "after"), beat)
        else:
            raise ValueError(f"ops[{n}].op: choose set, insert, remove, move or project.")
    return video_store.validate(draft)


@register("video_edit", "Change a video atomically. ops: set {op:set,id,field,value} (field say sets or, with an empty value, removes a narration line); "
          "insert {op:insert,before|after,beat}; remove {op:remove,id}; move {op:move,id,before|after}; "
          "project {op:project,field,value} for title,look,bpm,aspects,music,narration,cast,palette,style_pack ({id, version}); a scene beat's whole scene is set with field scene. "
          "Use beat ids from video_outline. A bad operation changes nothing. Preview again after edits.",
          _object({"video_id": _ID, "ops": {"type": "array", "items": {"type": "object"}}}, ("ops",)), surfaces=ALL, effect=WRITE)
@_guard
async def _edit(args, ctx):
    project = _video(args, ctx)
    with video_store._lock("video:" + project["id"]):
        draft = edit(video_store.get(project["id"]), args.get("ops"))
        if not design_systems.visible(design_systems.get(draft["look"]), _owner(ctx), ctx.is_admin):
            raise ValueError("look: choose a visible look with creative_direction(type=video).")
        saved = video_store.save(project["id"], draft)
    last = video_render._last_preview.get(project["id"], {})
    notes = last.get("notes", [])
    return _safe(ctx, _outline(saved) + ("\nLast preview notes (preview again after edits):\n" + "\n".join(notes) if notes else ""))


@register("video_add_image", "Copy a design photo or treatment into a video. source={design_id,asset:'assets/<sha>.<ext>'} "
          "from image_generate, image_search or image_treat. Then set a beat's image to the returned asset using video_edit.",
          _object({"video_id": _ID, "source": {"type": "object", "properties": {"design_id": _str("Source design id"),
                   "asset": _str("assets/<sha>.<ext> from that design")}, "required": ["design_id", "asset"]}}, ("source",)), surfaces=ALL, effect=WRITE)
@_guard
async def _image(args, ctx):
    project = _video(args, ctx)
    source = args.get("source")
    if not isinstance(source, dict):
        raise ValueError("source: give design_id and asset from an image tool.")
    asset = video_store.add_asset(project["id"], design_id=source.get("design_id"), asset=source.get("asset"),
                                  key=design_store.chat_key(ctx.session_id, ctx.agent_id))
    return _safe(ctx, f"Image copied: {asset}. Set a beat's image to this path with video_edit.")


@register("video_narrate", NARRATION + "Speak every say line with Kokoro (local, free), measure it, set each beat's length from it "
          "and return the timestamped shot plan with the narration checks. Lines already spoken in the same voice are reused. "
          "Run it before video_preview and video_render on a narrated video; bring the shot plan with the post for approval.",
          _object({"video_id": _ID}), surfaces=ALL, effect=WRITE)
@_guard
async def _narrate(args, ctx):
    project = _video(args, ctx)
    if not video_store.narrated(project):
        return "Not run: no beat has a say line yet. Add narration with video_edit (op set, field say) first."
    saved = await asyncio.to_thread(video_narration.prepare, project["id"])
    from core import video_checks
    notes = video_checks.narration_notes(saved)
    return _safe(ctx, video_narration.plan_text(saved) + ("\nNarration notes:\n" + "\n".join(notes) if notes else
                                                          "\nEvery line is spoken and measured; captions match the script."))


@register("video_preview", FLOW + "Render up to six beat midpoint samples into a contact sheet, with readability and safe-area notes. "
          "A narrated video is narrated first so the samples sit on the real timeline. Needs the desktop app; works without FFmpeg.",
          _object({"video_id": _ID, "aspect": _ASPECT}), surfaces=ALL, effect=READ)
@_guard
async def _preview(args, ctx):
    project = _video(args, ctx)
    frames = await video_render.preview(project["id"], args.get("aspect") or project["aspects"][0])
    notes = video_render._last_preview.get(project["id"], {}).get("notes", [])
    return ToolResult(_safe(ctx, "Video preview.\n" + ("\n".join(notes) or "No automatic issues in these samples. Inspect the sheet before rendering.")),
                      [ffmpeg_tools.contact_sheet(frames, 3)], image_fallback="")


@register("video_render", FLOW + "Encode the video to MP4 with original music, and the narration and captions when beats have say lines. aspect may be all. "
          "Queues a job visible in Studio, waits for it (about 10 minutes per aspect, longer for a long narrated video), then returns the real download link, loudness and checks.",
          _object({"video_id": _ID, "aspect": {"type": "string", "enum": list(video_store.ASPECTS) + ["all"]}}), surfaces=ALL, effect=WRITE)
@_guard
async def _render(args, ctx):
    project = _video(args, ctx)
    aspects = project["aspects"] if args.get("aspect") == "all" else [args.get("aspect") or project["aspects"][0]]
    lines = []
    for aspect in aspects:
        job = video_render.start(project["id"], aspect)
        lines.append(f"Job {job['id']} ({aspect}); watch progress in [Studio](/videos/{project['id']}).")
        try:
            await asyncio.wait_for(asyncio.shield(video_render._tasks[job["id"]]), timeout=video_render.wait_seconds(project))
        except asyncio.TimeoutError:
            lines.append("Still working; watch progress in Studio and download there when ready.")
            continue
        result = video_render.status(job["id"])
        if result["status"] != "ready":
            lines.append(result["status"])
            continue
        published = image_gen.register_generated_file(result["path"])
        if ctx.session_id:
            from core.session_manager import session_manager
            session_manager.register_artifact(ctx.session_id, published["url"])
        lines += [f"[{published['filename']}]({published['url']})", "Loudness: " + json.dumps(result["loudness"])]
        lines += result["notes"]
    return _safe(ctx, "\n".join(lines))


# -- Pack A characters (Video Styles unit 3) ------------------------------------------------------------------------

def _character_line(meta):
    versions = ", ".join(f"v{v['version']} {v['status'].replace('_', ' ')}" for v in meta["versions"])
    return f"- {meta['name']} ({meta['family']}), id {meta['id']}: {versions}"


@register("character_list", "List this account's Pack A characters with their versions and approval status, and what a scene can use "
          "(families, settings, palettes, props, actions). Cast only an approved version in a video.",
          _object({}), surfaces=ALL, effect=READ)
@_guard
async def _characters(args, ctx):
    lines = ["Characters:"] + ([_character_line(m) for m in character_store.list_all()] or ["- none yet; make one with character_make."])
    lines += ["Families (starting designs): " + ", ".join(f"{f} ({character_store.STARTERS[f]['name']})" for f in character_store.FAMILIES),
              "Settings: " + ", ".join(style_packs.SETTINGS), "Palettes: " + ", ".join(style_packs.PALETTES),
              "Props: " + ", ".join(style_packs.PROPS), "Actions: " + ", ".join(video_store.ACTIONS),
              "Views: " + ", ".join(character_store.VIEWS), "Expressions: " + ", ".join(character_store.EXPRESSIONS)]
    return _safe(ctx, "\n".join(lines))


def _taken_names():
    """Names on the Content Studio format cards' do-not-use lists: another channel's characters are never ours."""
    try:
        from services.content_studio import studio
        return {n.lower() for card in studio.list_formats(None) for n in card.get("do_not_use", [])}
    except Exception:
        return set()


@register("character_make", "Design an original Pack A character, or change one (which makes a new version). New: family (round, square or "
          "triangle; each starts from Kairos's own design) and name, with any changes to palette (hex: body, body_shade, head, limb, eye, "
          "mouth, outline, accent, cheek), proportions (head, body_width, limb_length, limb_width, eye_size, as shares of height), "
          "outline (4 to 14 thousandths of height) and accessory (none, scarf, antenna, leaf, cap, bow). Change: character_id and changes. "
          "Never copy another channel's or brand's character; names on a format card's do-not-use list are refused. "
          "Then character_sheet sends the sheet to the person; only they approve it.",
          _object({"character_id": _str("A character to change; leave out to make a new one"),
                   "family": {"type": "string", "enum": list(character_store.FAMILIES)}, "name": _str("The character's name"),
                   "changes": {"type": "object", "description": "palette, proportions, outline, accessory or name"},
                   "note": _str("What changed and why")}), surfaces=ALL, effect=WRITE)
@_guard
async def _design(args, ctx):
    changes = dict(args.get("changes") or {})
    if args.get("name"):
        changes["name"] = args["name"]
    if str(changes.get("name", "")).strip().lower() in _taken_names():
        raise ValueError("name: that name belongs to a source channel on a format card; give the character our own name.")
    if args.get("character_id"):
        meta = character_store.new_version(args["character_id"], changes, by="model", note=args.get("note", ""))
    else:
        if not args.get("family"):
            raise ValueError("family: choose round, square or triangle for a new character.")
        meta = character_store.create(character_store.starter(args["family"], **changes), by="model", note=args.get("note", ""))
    v = meta["versions"][-1]["version"]
    return _safe(ctx, _character_line(meta) + f"\nVersion {v} is a draft. Run character_sheet with character_id {meta['id']} and version {v} "
                      "to render its sheet and send it to the person for approval.")


@register("character_sheet", "Render a character version's reference sheet (every view, expression and mouth shape, the palette) with the same "
          "rig the videos use, check it, and send it to the person for approval in Studio > Content > Characters (and their Inbox when the "
          "Content Studio team is set up). Needs the desktop app. Only the person approves.",
          _object({"character_id": _str("Character id"), "version": {"type": "integer"}}, ("character_id", "version")), surfaces=ALL, effect=WRITE)
@_guard
async def _sheet(args, ctx):
    meta = await character_sheet.submit(args["character_id"], args["version"])
    sheet = character_store.sheet_path(meta["id"], args["version"])
    return ToolResult(_safe(ctx, f"The sheet of {meta['name']} version {args['version']} is waiting for the person's approval in "
                                 "Studio > Content > Characters."), [sheet.read_bytes()], image_fallback="")
