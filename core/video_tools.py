"""The same beat-sheet video workflow on every model, through the tool registry."""
from __future__ import annotations
import asyncio
import copy
import json
from core import creative_direction, design_store, design_systems, design_tools, ffmpeg_tools, image_gen, video_render, video_store
from core.tool_registry import ALL, READ, WRITE, ToolResult, _object, _str, register
from core.untrusted import wrap_untrusted

LINKED_TOOLS = frozenset({"video_outline", "video_edit", "video_add_image", "video_preview", "video_render"})
FLOW = ("Workflow: creative_direction(type=video) -> video_create with a beat sheet (one idea per beat, "
        "3 to 8 words on screen, 1 to 2 bars each, end card last) -> video_preview -> fix with video_edit -> video_render. ")
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
    lines = [f"Video {project['id']}: {project['title']} ({video_store.duration(project):g}s, version {project['version']})"]
    lines += [f"- {b['id']} {b['start']:g}–{b['end']:g}s {b['kind']}: {b.get('text', b.get('number', ''))}" for b in beats]
    return "\n".join(lines)


@register("video_create", FLOW + "Create a video project with a chosen look and beats; returns a Studio link. Pick a look with creative_direction(type=video) first.",
          _object({"title": _str("Video title"), "look": _str("Look id from creative_direction"),
                   "beats": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": 40},
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
    options = {k: args[k] for k in ("aspects", "bpm", "music") if k in args}
    project = video_store.create(args.get("title"), look=look, beats=beats, owner=owner, chat_key_=key, **options)
    title = project["title"].replace("[", "").replace("]", "").replace("\n", " ")
    return _safe(ctx, _outline(project) + f"\n[Video: {title}](/videos/{project['id']})\nNext: video_preview, fix with video_edit, then video_render.")


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
            if op.get("field") not in ("title", "look", "bpm", "aspects", "music") or "value" not in op:
                raise ValueError(f"ops[{n}].field: project edits title, look, bpm, aspects or music with value.")
            draft[op["field"]] = op["value"]
        elif kind == "set":
            if op.get("field") not in ("kind", "bars", "text", "sub", "number", "items", "image", "camera", "transition", "treatment") or "value" not in op:
                raise ValueError(f"ops[{n}].field: choose a beat field from video_outline and give value.")
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


@register("video_edit", "Change a video atomically. ops: set {op:set,id,field,value}; insert {op:insert,before|after,beat}; "
          "remove {op:remove,id}; move {op:move,id,before|after}; project {op:project,field,value} for title,look,bpm,aspects,music. "
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


@register("video_preview", FLOW + "Render up to six beat midpoint samples into a contact sheet, with readability and safe-area notes. Needs the desktop app; works without FFmpeg.",
          _object({"video_id": _ID, "aspect": _ASPECT}), surfaces=ALL, effect=READ)
@_guard
async def _preview(args, ctx):
    project = _video(args, ctx)
    beats = video_render.outline(project)
    count = min(6, len(beats))
    indices = [round(i * (len(beats) - 1) / max(1, count - 1)) for i in range(count)]
    times = [(beats[i]["start"] + beats[i]["end"]) / 2 for i in indices]
    frames = await video_render.preview(project["id"], args.get("aspect") or project["aspects"][0], times)
    notes = video_render._last_preview.get(project["id"], {}).get("notes", [])
    return ToolResult(_safe(ctx, "Video preview.\n" + ("\n".join(notes) or "No automatic issues in these samples. Inspect the sheet before rendering.")),
                      [ffmpeg_tools.contact_sheet(frames, 3)], image_fallback="")


@register("video_render", FLOW + "Encode the video to MP4 with original music. aspect may be all. "
          "Queues a job visible in Studio, waits up to 10 minutes per aspect, then returns the real download link, loudness and checks.",
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
            await asyncio.wait_for(asyncio.shield(video_render._tasks[job["id"]]), timeout=600)
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
