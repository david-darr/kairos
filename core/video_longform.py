"""Long videos in chapters: each chapter rendered as its own part, resumable, joined without a second encode
(Video Styles build spec, unit 4; section 7 V3: one long video a week per YouTube channel plus daily Shorts).

A long video is a narrated project with `chapters` (core/video_store.chapter_spans). Rendering it:
1. Narration first (core/video_narration.prepare), so every chapter's place on the timeline is measured.
2. Each chapter is one render worker job over its own frames of the same player (electron/designRender.js `first` and
   `count`), so captions, transitions and timing run on exactly as in one long render. Its frames are encoded to a
   picture-only part with the one encoder setting every render uses (core/ffmpeg_tools.VIDEO_ARGS).
3. The parts are joined by FFmpeg's concat demuxer, copying the pictures, and the whole video's soundtrack (the music
   on the whole timeline, so it carries across every chapter join, with the voice over it) gets one loudness pass over
   the whole video (core/ffmpeg_tools.join). The frame count is checked against the timeline.

Resumable. A part is named by a key over everything that draws its frames: the motion engine's own files, the look, the
aspect, the cast and pack pins, the chapter's beats as measured, the beat on each side of it (transitions and captions
cross a join) and the kinds and ids of the beats before it (the layout's composition order). A part on disk with its key
is reused, so after a crash, an app restart or a cancel, rendering again starts at the first unfinished chapter, and an
edit to one chapter re-renders only that chapter. The job's record (renders/long-<aspect>/job.json) keeps each chapter's
state and the measured frames per second, so Studio shows a stopped render with Resume after a restart. Parts no longer
used are removed when a render finishes; Studio shows the disk the parts and videos take and can remove the parts.

Only a plan the person approved renders (core/video_plan.py). Several long renders never run at once: each chapter and
the join take the render machine in turn (core/video_render._machine), so a Short can render between two chapters.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import secrets
import shutil
import time
from pathlib import Path

from PIL import Image

from core import design_render_bridge, design_systems, ffmpeg_tools, video_audio, video_checks, video_narration, video_plan, video_store
from core.atomic_io import read_json, write_json_atomic
from core.constants import STATIC_DIR

# Frames a second a long render was measured at on the machine it was built on (a 16:9 Flat 2D sample, 2026-11-10); the
# first estimate before this machine has measured its own. Studio and video_render_status use the measured one after that.
TYPICAL_FPS = 45.0     # measured 47.6 and 48.2 on the 3.5-minute Flat 2D sample, rounded down
SAMPLES_PER_CHAPTER = 4
SHEET_SAMPLES = 12
YOUTUBE_MIN_CHAPTERS, YOUTUBE_MIN_SECONDS = 3, 10   # YouTube's chapter rules (support.google.com/youtube/answer/9884579)
ENGINE_FILES = ("engine.js", "kit.js", "layout.js", "rig.js", "scene.js")
_engine = {}


def _slug(aspect):
    return aspect.replace(":", "-")


def folder(video_id, aspect) -> Path:
    return video_store._folder(video_id) / "renders" / f"long-{_slug(aspect)}"


def _parts(video_id, aspect) -> Path:
    return folder(video_id, aspect) / "parts"


def engine_hash() -> str:
    """The motion engine's files, so an app update that draws differently renders the parts again."""
    paths = [Path(STATIC_DIR) / "motion" / name for name in ENGINE_FILES]
    stamp = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths if p.is_file())
    if _engine.get("stamp") != stamp:
        digest = hashlib.sha256()
        for p in paths:
            if p.is_file():
                digest.update(p.read_bytes())
        _engine.update(stamp=stamp, hash=digest.hexdigest()[:16])
    return _engine["hash"]


def _look(look):
    system = design_systems.get(look)
    return hashlib.sha256(json.dumps(system.get("tokens") if system else None, sort_keys=True).encode()).hexdigest()[:16]


def chapter_keys(project, aspect) -> list[str]:
    """The key of each chapter's part (see the module notes): equal keys draw equal frames."""
    beats, spans = project["beats"], video_store.chapter_spans(project)
    shared = {"engine": engine_hash(), "look": project["look"], "tokens": _look(project["look"]), "aspect": aspect,
              "bpm": project["bpm"], "captions": (project.get("narration") or {}).get("captions", True),
              "palette": project.get("palette"), "cast": project.get("cast"), "style_pack": project.get("style_pack")}
    keys = []
    for span in spans:
        first, last = span["first"], span["last"]
        body = {**shared, "beats": beats[first:last], "before": beats[first - 1] if first else None,
                "after": beats[last] if last < len(beats) else None, "order": [[b["kind"], b["id"]] for b in beats[:last]],
                "offset": round(span["start"] * 30 - span["first_frame"], 6), "frames": span["frames"]}
        keys.append(hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:24])
    return keys


def _clock(t):
    t = int(t)
    # YouTube's own example starts the list at 00:00 (support.google.com/youtube/answer/9884579, checked 2026-11-10).
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60:02d}:{t % 60:02d}"


def youtube_chapters(project) -> tuple[str, list[str]]:
    """The chapter list for a YouTube description ("0:00 Title" per line) and why YouTube would not show it as
    chapters, if it would not: the first at 0:00, at least three, each at least ten seconds long."""
    spans = video_store.chapter_spans(project) if video_store.chaptered(project) else []
    text = "\n".join(f"{_clock(s['first_frame'] / 30)} {s['title']}" for s in spans)
    problems = []
    if len(spans) < YOUTUBE_MIN_CHAPTERS:
        problems.append(f"YouTube shows chapters only when there are at least {YOUTUBE_MIN_CHAPTERS}; this video has {len(spans)}.")
    short = [s["title"] for s in spans if s["end"] - s["start"] < YOUTUBE_MIN_SECONDS]
    if short:
        problems.append(f"YouTube chapters are at least {YOUTUBE_MIN_SECONDS} seconds long; too short: " + ", ".join(short) + ".")
    return text, problems


def chapters_file(video_id, file_name) -> Path:
    return video_store._folder(video_id) / "renders" / (Path(file_name).stem + ".chapters.txt")


def chapters_for_render(render_ref) -> str:
    """The YouTube chapter list saved with a long video's render (a Studio render link), or ""."""
    import re
    match = re.match(r"^/api/videos/([a-f0-9]{12})/renders/((?:16-9|9-16|1-1)-v[1-9][0-9]*\.mp4)$", (render_ref or "").strip())
    if not match:
        return ""
    try:
        path = chapters_file(match.group(1), match.group(2))
    except LookupError:
        return ""
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


# -- the record on disk ------------------------------------------------------------------------------------------------

def _record_path(video_id, aspect):
    return folder(video_id, aspect) / "job.json"


def record(video_id, aspect) -> dict:
    data = read_json(str(_record_path(video_id, aspect)), None)
    return data if isinstance(data, dict) else {}


def _save_record(video_id, aspect, data):
    _record_path(video_id, aspect).parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = time.time()
    write_json_atomic(str(_record_path(video_id, aspect)), data)


def _part_ok(parts, key, frames) -> bool:
    meta = read_json(str(parts / f"{key}.json"), None)
    return (parts / f"{key}.mp4").is_file() and isinstance(meta, dict) and meta.get("frames") == frames


def disk(video_id) -> dict:
    """Bytes the video's renders take: chapter parts, finished videos and everything else in its renders folder."""
    root = video_store._folder(video_id) / "renders"
    out = {"parts": 0, "videos": 0, "other": 0}
    if root.is_dir():
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            size = path.stat().st_size
            kind = "parts" if "parts" in path.parts else "videos" if path.suffix == ".mp4" else "other"
            out[kind] += size
    out["total"] = sum(out.values())
    return out


def clean(video_id, aspect=None) -> int:
    """Remove the saved chapter parts (all aspects, or one). A stopped render then starts again from its first chapter."""
    from core import video_render
    if any(j.get("kind") == "long" and not _done(j["status"]) for j in video_render.jobs_for(video_id)):
        raise ValueError("A long render of this video is running; stop it before removing its parts.")
    freed = 0
    for aspect_ in ([aspect] if aspect else list(video_store.ASPECTS)):
        parts = _parts(video_id, aspect_)
        if parts.is_dir():
            freed += sum(p.stat().st_size for p in parts.rglob("*") if p.is_file())
            shutil.rmtree(parts, ignore_errors=True)
        data = record(video_id, aspect_)
        if data and data.get("status") != "ready":
            for chapter in data.get("chapters", []):
                chapter["state"] = "waiting"
            _save_record(video_id, aspect_, data)
    return freed


def _done(status):
    return status in ("ready", "paused") or status.startswith("failed:")


def describe(video_id) -> list[dict]:
    """Each aspect's long render as stored, for Studio after a restart: a record still marked running with no live job
    is shown as interrupted, with Resume."""
    from core import video_render
    live = {j["aspect"]: j for j in video_render.jobs_for(video_id) if j.get("kind") == "long" and not _done(j["status"])}
    out = []
    for aspect in video_store.ASPECTS:
        data = record(video_id, aspect)
        if not data:
            continue
        status = data.get("status", "")
        if status in ("running", "queued") and aspect not in live:
            status = "interrupted"
        out.append({"aspect": aspect, "status": status, "live": aspect in live, "chapters": data.get("chapters", []),
                    "fps": data.get("fps"), "file": data.get("file"), "error": data.get("error"), "version": data.get("version"),
                    "frames_total": data.get("frames_total"), "resumable": status in ("interrupted", "paused", "failed")})
    return out


# -- rendering ---------------------------------------------------------------------------------------------------------

def start(project, aspect, register) -> dict:
    """Queue a long render (or resume one: finished chapters on disk are reused). `register(job_id, state, coro)` puts
    the job in core/video_render's job table, so Studio's job routes and Cancel work on it."""
    problems = video_plan.problems(project)
    if problems:
        raise ValueError("plan: " + " ".join(problems))
    job_id = secrets.token_hex(8)
    state = {"id": job_id, "video_id": project["id"], "aspect": aspect, "version": project["version"], "status": "queued",
             "kind": "long", "chapters": [], "frames_done": 0, "frames_total": 0, "fps": None, "eta_seconds": None}
    return register(job_id, state, _run(project, aspect, state))


def _eta(state):
    left = state["frames_total"] - state["frames_done"]
    fps = state.get("fps")
    state["eta_seconds"] = round(left / fps) if fps and left > 0 else (0 if left <= 0 else None)


async def _thread(function, *args):
    """Keep the render slot until background file work has let go of its handles, even when cancelled."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


def _sample_times(project, span):
    """Frame times inside the chapter kept for the checks and the contact sheet: the middle of up to four of its shots."""
    beats, starts, at = project["beats"], [], 0.
    for b in beats:
        starts.append((at, at + video_store.beat_seconds(b, project["bpm"])))
        at = starts[-1][1]
    picks = list(range(span["first"], span["last"]))
    if len(picks) > SAMPLES_PER_CHAPTER:
        picks = [picks[round(i * (len(picks) - 1) / (SAMPLES_PER_CHAPTER - 1))] for i in range(SAMPLES_PER_CHAPTER)]
    low, high = span["first_frame"], span["first_frame"] + span["frames"] - 1
    return sorted({min(high, max(low, int((starts[i][0] + starts[i][1]) / 2 * 30))) for i in picks})


async def _chapter(project, aspect, span, key, parts, state, index):
    """Render one chapter's frames into its part. Returns (frames, seconds spent capturing)."""
    from core import video_render
    sample_frames = _sample_times(project, span)
    temp = parts / f"{key}.partial.mp4"
    encoder = await asyncio.to_thread(ffmpeg_tools.Encoder, temp, None)
    seen, began = 0, time.monotonic()
    samples, layouts = [], []
    chapter = state["chapters"][index]
    try:
        job = video_render._job(project, aspect, secrets.token_hex(8), frame_times=[f / 30 for f in sample_frames],
                                frames=(span["first_frame"], span["frames"]))

        async def consume(frames, layout):
            nonlocal seen
            layouts.extend(layout)
            def feed():
                for frame in frames:
                    encoder.write(frame)
            await asyncio.wait_for(asyncio.to_thread(feed), timeout=60)
            for frame in frames:
                if span["first_frame"] + seen in sample_frames:
                    samples.append((span["first_frame"] + seen, frame))
                seen += 1
            chapter["done"] = seen
            state["frames_done"] = sum(c["done"] for c in state["chapters"])
            spent = time.monotonic() - began
            if spent > 2:
                state["fps"] = round((state["_frames_run"] + seen) / (state["_seconds_run"] + spent), 2)
            _eta(state)
            state["status"] = f"rendering {state['frames_done']}/{state['frames_total']}"

        await design_render_bridge.video(job, consume)
        await asyncio.to_thread(encoder.finish)
        encoder = None
        spent = time.monotonic() - began
        counted = await asyncio.to_thread(ffmpeg_tools.count_frames, temp)
        if counted != span["frames"]:
            raise RuntimeError(f"chapter {span['title']} has {counted} frames, not {span['frames']}")
        for frame_index, raw in samples:
            (parts / f"{key}-{frame_index}.jpg").write_bytes(raw)
        write_json_atomic(str(parts / f"{key}.json"), {
            "frames": span["frames"], "first_frame": span["first_frame"], "seconds": round(spent, 2),
            "fps": round(span["frames"] / spent, 2) if spent else None, "samples": [i for i, _ in samples],
            "layouts": layouts[:120], "at": time.time()})
        temp.replace(parts / f"{key}.mp4")
        return span["frames"], spent
    finally:
        if encoder:
            await asyncio.to_thread(encoder.abort)
        temp.unlink(missing_ok=True)


async def _run(project, aspect, state):
    from core import video_render
    lock = video_render._machine()
    video_id = project["id"]
    parts = _parts(video_id, aspect)
    began = time.time()
    stored = record(video_id, aspect)
    try:
        async with lock:
            if video_store.narrated(project):
                state["status"] = "narrating"
                project = await _thread(video_narration.prepare, video_id)
            problems = video_plan.problems(project) + video_render.cast_problems(project) + video_render.pack_problems(project)
            if not video_store.chaptered(project):
                problems.append("the video no longer has chapters; render it as a normal video.")
            if problems:
                raise ValueError(" ".join(problems))
            if aspect not in project["aspects"]:
                raise ValueError("aspect: the video no longer has this aspect.")
        state["version"] = project["version"]
        spans, keys = video_store.chapter_spans(project), chapter_keys(project, aspect)
        parts.mkdir(parents=True, exist_ok=True)
        for leftover in parts.glob("*.partial.mp4"):
            leftover.unlink(missing_ok=True)
        resumed = stored.get("status") in ("running", "queued", "paused", "failed", "interrupted")
        state["chapters"] = [{"id": s["id"], "title": s["title"], "key": k, "start": round(s["start"], 2), "end": round(s["end"], 2),
                              "frames": s["frames"], "done": s["frames"] if _part_ok(parts, k, s["frames"]) else 0,
                              "state": "done" if _part_ok(parts, k, s["frames"]) else "waiting"} for s, k in zip(spans, keys)]
        state["frames_total"] = sum(s["frames"] for s in spans)
        state["frames_done"] = sum(c["done"] for c in state["chapters"])
        state["reused"] = sum(c["state"] == "done" for c in state["chapters"])
        state["resumed"] = bool(resumed and state["reused"])
        state["_frames_run"], state["_seconds_run"] = 0, 0.
        state["fps"] = stored.get("fps")
        _eta(state)

        def persist(status, **extra):
            _save_record(video_id, aspect, {"aspect": aspect, "version": project["version"], "status": status,
                                            "started_at": stored.get("started_at") if resumed else began,
                                            "frames_total": state["frames_total"], "fps": state.get("fps"),
                                            "chapters": [{k: c[k] for k in ("id", "title", "key", "start", "end", "frames", "state")}
                                                         for c in state["chapters"]], **extra})
        persist("running")
        for index, (span, key) in enumerate(zip(spans, keys)):
            chapter = state["chapters"][index]
            if chapter["state"] == "done":
                continue
            async with lock:
                chapter["state"], chapter["done"] = "rendering", 0
                state["status"] = f"rendering {state['frames_done']}/{state['frames_total']}"
                persist("running")
                frames, spent = await _chapter(project, aspect, span, key, parts, state, index)
                state["_frames_run"] += frames
                state["_seconds_run"] += spent
                state["fps"] = round(state["_frames_run"] / state["_seconds_run"], 2) if state["_seconds_run"] else state["fps"]
                chapter["state"], chapter["done"], chapter["seconds"] = "done", frames, round(spent, 1)
                state["frames_done"] = sum(c["done"] for c in state["chapters"])
                _eta(state)
                persist("running")
        async with lock:
            state["status"] = "joining"
            result = await _join(project, aspect, spans, keys, parts, state)
        state.update(result)
        state.update(status="ready", render_seconds=round(time.time() - began, 1), eta_seconds=0)
        persist("ready", file=result["file"], render_seconds=state["render_seconds"])
        _clean_stale(parts, keys)
        state["disk"] = disk(video_id)
    except asyncio.CancelledError:
        state["status"] = "paused"
        for chapter in state["chapters"]:
            if chapter["state"] == "rendering":
                chapter["state"], chapter["done"] = "waiting", 0
        state["frames_done"] = sum(c["done"] for c in state["chapters"])
        if state["chapters"]:
            _save_record(video_id, aspect, {**record(video_id, aspect), "status": "paused", "fps": state.get("fps"),
                                            "chapters": [{k: c.get(k) for k in ("id", "title", "key", "start", "end", "frames", "state")}
                                                         for c in state["chapters"]]})
    except Exception as error:
        state["status"] = "failed: " + str(error)[:1500]
        if state["chapters"]:
            _save_record(video_id, aspect, {**record(video_id, aspect), "status": "failed", "error": str(error)[:1500],
                                            "fps": state.get("fps"),
                                            "chapters": [{k: c.get(k) for k in ("id", "title", "key", "start", "end", "frames", "state")}
                                                         for c in state["chapters"]]})
    finally:
        state.pop("_frames_run", None)
        state.pop("_seconds_run", None)
        try:
            state["disk"] = disk(video_id)
        except LookupError:
            pass


def _clean_stale(parts, keys):
    """Remove parts (and their samples) that no chapter of the video as rendered uses any more."""
    keep = set(keys)
    for path in parts.iterdir():
        if path.is_file() and path.name.split(".")[0].split("-")[0] not in keep:
            path.unlink(missing_ok=True)


async def _join(project, aspect, spans, keys, parts, state):
    """The soundtrack for the whole video, the lossless join, the frame count, loudness, checks and contact sheet."""
    from core import video_render
    video_id = project["id"]
    renders = video_store._folder(video_id) / "renders"
    slug = _slug(aspect)
    wav, voice = renders / "soundtrack.wav", {}
    await _thread(video_audio.write_wav, wav, project, voice)
    n = 1
    while (renders / f"{slug}-v{n}.mp4").exists():
        n += 1
    out = renders / f"{slug}-v{n}.mp4"
    temp = out.with_name(out.stem + ".partial.mp4")
    try:
        await _thread(ffmpeg_tools.join, [parts / f"{k}.mp4" for k in keys], wav, temp)
        total = sum(s["frames"] for s in spans)
        counted = await _thread(ffmpeg_tools.count_frames, temp)
        if counted != total:
            raise RuntimeError(f"the joined video has {counted} frames, not {total}")
        measured = await _thread(ffmpeg_tools.loudness, temp)
        samples, layouts = [], []
        for key in keys:
            meta = read_json(str(parts / f"{key}.json"), {})
            layouts += meta.get("layouts", [])
            for i in meta.get("samples", []):
                path = parts / f"{key}-{i}.jpg"
                if path.is_file():
                    samples.append((i, path.read_bytes()))
        samples.sort()
        frames, times = [raw for _, raw in samples], [i / 30 for i, _ in samples]
        notes = video_checks.check(project, aspect, layouts, frames, measured, voice or None)
        notes += video_render.character_notes(project, layouts, frames, times)
        notes += video_render.pack_notes(project)
        text, problems = youtube_chapters(project)
        notes += problems
        picks = samples if len(samples) <= SHEET_SAMPLES else [samples[round(i * (len(samples) - 1) / (SHEET_SAMPLES - 1))] for i in range(SHEET_SAMPLES)]
        (renders / f"sheet-{slug}.png").write_bytes(ffmpeg_tools.contact_sheet([raw for _, raw in picks], 4))
        if samples:
            want = video_render.thumb_frame(project)
            raw = min(samples, key=lambda s: abs(s[0] - want))[1]
            with Image.open(io.BytesIO(raw)) as image:
                image.thumbnail((480, 480))
                image.save(renders / f"thumb-{slug}.png", "PNG")
        temp.replace(out)
        chapters_file(video_id, out.name).write_text(text + "\n", encoding="utf-8")
    finally:
        temp.unlink(missing_ok=True)
    return {"file": out.name, "path": str(out), "loudness": measured, "notes": list(dict.fromkeys(notes)), "narration": voice or None,
            "seconds": round(video_store.duration(project), 2), "url": f"/api/videos/{video_id}/renders/{out.name}",
            "sheet": f"sheet-{slug}.png", "thumbnail": f"thumb-{slug}.png", "chapters_text": text,
            "chapters_file": chapters_file(video_id, out.name).name}
