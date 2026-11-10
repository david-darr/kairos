"""Serialize video captures and stream frames into an external encoder.

Only contact-sheet frames and a thumbnail stay in memory. A project version
is pinned in its signed player URL so edits during capture cannot change it.
"""
from __future__ import annotations
import asyncio
import io
import math
import secrets
import time
from urllib.parse import quote
import weakref
from PIL import Image
from core import (accounts, design_render, design_render_bridge, ffmpeg_tools, video_audio, video_blender, video_checks, video_longform,
                  video_narration, video_plan, video_store)

_jobs = {}
_owners = {}  # job id -> the account that started it; a job is only visible to that account
_tasks = {}
_locks = weakref.WeakKeyDictionary()
_last_preview = {}


def _machine():
    loop = asyncio.get_running_loop()
    return _locks.setdefault(loop, asyncio.Lock())


def outline(project):
    start, out = 0., []
    for beat in project["beats"]:
        end = start + video_store.beat_seconds(beat, project["bpm"])
        out.append({**beat, "start": start, "end": end})
        start = end
    return out


def thumb_frame(project, fps=30):
    """The thumbnail frame: the middle of the beat playing a quarter of the way in, where its text has settled.
    A flat quarter-way frame can land on a transition and come out blank (2026-11-05 pass)."""
    beats = outline(project)
    quarter = beats[-1]["end"] * .25
    beat = next((b for b in beats if b["start"] <= quarter < b["end"]), beats[0])
    if beat["kind"] == "end" and len(beats) > 1:
        beat = beats[0]
    return int((beat["start"] + beat["end"]) / 2 * fps)


def _aspect(project, aspect):
    if aspect not in project["aspects"]:
        raise ValueError("aspect: choose one of this video's aspects: " + ", ".join(project["aspects"]))
    return video_store.ASPECTS[aspect]


LAYOUT_SAMPLES = 120   # the most layout samples the render worker takes (electron/designRender.js)


def _job(project, aspect, job_id, times=None, frame_times=(), frames=None):
    """The worker's job. Layout is sampled a quarter, half and three quarters into each beat, and at every frame
    kept for the checks (`frame_times`), so a sampled frame can be compared with what the rig drew there.
    `frames` = (first, count) renders only those frames of the video: one chapter of a long video
    (core/video_longform.py); its layout samples stay inside the chapter."""
    w, h = _aspect(project, aspect)
    version = project["version"]
    duration = video_store.duration(project)
    fps = video_store.fps(project)
    total = video_store.frame_count(project)
    first, count = frames or (0, total)
    # A chapter can take longer than a short video; the token outlives the capture.
    token = design_render.sign(project["id"], f"video:{aspect}:{version}", 900 if frames is None else max(900, 600 + int(count * .5)))
    low, high = first / fps, (first + count) / fps
    kept = sorted({round(t, 6) for t in list(frame_times) + list(times or []) if 0 <= t < duration})
    beats = sorted({round(b["start"] + (b["end"] - b["start"]) * f, 6)
                    for b in outline(project) for f in (.25, .5, .75)} - set(kept))
    if frames is not None:
        beats = [t for t in beats if low <= t < high]
    room = max(0, LAYOUT_SAMPLES - len(kept))
    if len(beats) > room:   # a long video: an even spread of the beat samples (100 beats would be 300)
        beats = [beats[round(i * (len(beats) - 1) / max(1, room - 1))] for i in range(room)] if room else []
    samples = sorted(set(kept[:LAYOUT_SAMPLES]) | set(beats))
    job = {"id": job_id, "kind": "video", "path": f"/api/videos/{project['id']}/player?aspect={quote(aspect, safe='')}&rt={token}&v={version}",
           "w": w, "h": h, "look": project["look"], "fps": fps, "frames": total,
           "preview": times is not None, "times": times or [], "layoutTimes": samples}
    if frames is not None:
        job.update(first=first, count=count)
    return job


def cast_problems(project):
    """Why a video cannot render with its cast: a character missing, or a version the person has not approved."""
    from core import character_store
    out = []
    for entry in project.get("cast", []):
        try:
            meta = character_store.get(entry["character"])
            status = character_store.version_of(meta, entry["version"])["status"]
        except LookupError as error:
            out.append(str(error).strip("'"))
            continue
        if status != "approved":
            out.append(f"{meta['name']} version {entry['version']} is {status.replace('_', ' ')}; a video may only use an approved "
                       "version. Approve its sheet in Studio > Content > Characters, or cast an approved version.")
    return out


def pack_problems(project, sample_of=None):
    """Why a video cannot render in its style pack: the pack is missing, or the version is not approved. The pack's own
    sample (core/style_pack_sample.py, `sample_of` = (id, version)) renders before approval: it is what the person
    approves."""
    from core import style_pack_store
    pin = project.get("style_pack")
    if not pin:
        return []
    try:
        meta = style_pack_store.get(pin["id"])
        status = style_pack_store.version_of(meta, pin["version"])["status"]
    except LookupError as error:
        return [str(error).strip("'")]
    if status == "approved" or sample_of == (pin["id"], pin["version"]):
        return []
    return [f"The style pack {meta['name']} version {pin['version']} is {status.replace('_', ' ')}; a video renders only in an approved "
            "version. Approve it in Studio > Content > Styles, or use an approved version."]


def pack_notes(project):
    """Where the video strays from its style pack's scene rules and pacing."""
    from core import style_pack_store
    pin = project.get("style_pack")
    if not pin:
        return []
    try:
        return style_pack_store.rule_notes(project, style_pack_store.spec(pin["id"], pin["version"]))
    except LookupError as error:
        return [str(error).strip("'")]


def character_notes(project, layouts, frames, times):
    """Sheet-match checks (section 5) on sampled frames: each character the layout reports at a frame's time."""
    from core import character_checks, character_store
    if not project.get("cast") or not frames:
        return []
    try:
        cast = character_store.resolve(project["cast"])
    except LookupError as error:
        return [str(error).strip("'")]
    by_time = {round(s.get("time", -1), 6): s.get("elements", []) for s in layouts or []}
    notes, measured = [], 0
    for frame, t in zip(frames, times):
        boxes = [b for b in by_time.get(round(t, 6), []) if b.get("kind") in ("character", "prop", "text")]
        if any(b.get("kind") == "character" for b in boxes):
            measured += 1
            notes += character_checks.frame_notes(frame, boxes, cast)
    for key, entry in cast.items():
        if not entry["approved"]:
            notes.append(f"{entry['name']} version {entry['version']} is not approved yet; this preview cannot be rendered.")
    return list(dict.fromkeys(notes))


def wait_seconds(project):
    """How long a caller waits for one render: the capture budget plus narration and encoding."""
    frames = video_store.frame_count(project)
    return design_render_bridge.video_seconds({"frames": frames}) + 120


def status(job_id):
    if job_id not in _jobs or _owners.get(job_id) != accounts.effective_account():
        raise LookupError("No such video job.")
    return dict(_jobs[job_id])


def jobs_for(video_id):
    """The current account's render jobs of one video."""
    me = accounts.effective_account()
    return [dict(job) for job_id, job in list(_jobs.items()) if _owners.get(job_id) == me and job["video_id"] == video_id]


def cancel(job_id):
    """Stop a render. A long video's render pauses: its finished chapters stay, and rendering again resumes it."""
    status(job_id)
    task = _tasks.get(job_id)
    if task and not task.done() and not task.cancelling():
        task.cancel()
        _jobs[job_id]["status"] = "paused" if _jobs[job_id].get("kind") == "long" else "failed: cancelled"
    return status(job_id)


def _register(job_id, state, coro):
    _owners[job_id] = accounts.effective_account()
    _jobs[job_id] = state
    _tasks[job_id] = asyncio.create_task(coro)
    # Bound completed status records; live jobs are never evicted.
    for old in list(_jobs)[:-200]:
        if old in _tasks and _tasks[old].done():
            _jobs.pop(old, None)
            _owners.pop(old, None)
            _tasks.pop(old, None)
    return status(job_id)


def start(video_id, aspect, sample_of=None):
    """Return a reviewable job id immediately; fail before queuing without FFmpeg."""
    project = video_store.get(video_id)
    _aspect(project, aspect)
    problems = cast_problems(project)
    if problems:
        raise ValueError("cast: " + " ".join(problems))
    problems = pack_problems(project, sample_of)
    if problems:
        raise ValueError("style_pack: " + " ".join(problems))
    # Pack B with Blender (core/video_blender.py) renders in parts like a long video, chaptered or not.
    renderer = video_blender.effective(project)
    in_parts = video_store.chaptered(project) or renderer == "blender"
    if video_store.chaptered(project):
        # A long video renders chapter by chapter, resumably, and only after the person approved its plan.
        problems = video_plan.problems(project)
        if problems:
            raise ValueError("plan: " + " ".join(problems))
    if in_parts:
        running = [j for j in jobs_for(video_id) if j.get("kind") == "long" and j["aspect"] == aspect
                   and j["status"] not in ("ready", "paused") and not j["status"].startswith("failed:")]
        if running:
            return running[-1]
    if not ffmpeg_tools.find():
        raise RuntimeError(ffmpeg_tools.MISSING)
    if not design_render_bridge.available():
        raise design_render_bridge.Unavailable("Video rendering needs the Kairos desktop app. Open the desktop app and try again.")
    if in_parts:
        job = video_longform.start(project, aspect, _register, renderer)
        _jobs[job["id"]]["sample_of"] = sample_of
        return status(job["id"])
    job_id = secrets.token_hex(8)
    state = {"id": job_id, "video_id": video_id, "aspect": aspect, "version": project["version"], "status": "queued"}
    return _register(job_id, state, _render(project, aspect, job_id))


async def render(video_id, aspect, sample_of=None):
    job = start(video_id, aspect, sample_of)
    await _tasks[job["id"]]
    return status(job["id"])


async def _thread_done(function, *args):
    """Keep the queue slot until file-producing background work has released its handles."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


async def _render(project, aspect, job_id):
    state = _jobs[job_id]
    encoder = None
    temp = None
    lock = _machine()
    acquired = False
    try:
        await lock.acquire()
        acquired = True
        if video_store.narrated(project):
            # Audio first: speak and measure the lines, which sets each shot's length, before any frame is drawn.
            state["status"] = "narrating"
            project = await _thread_done(video_narration.prepare, project["id"])
            if project["aspects"] and aspect not in project["aspects"]:
                raise ValueError("aspect: the video no longer has this aspect.")
            state["version"] = project["version"]
        folder = video_store._folder(project["id"]) / "renders"
        wav = folder / "soundtrack.wav"
        voice = {}
        await _thread_done(video_audio.write_wav, wav, project, voice)
        slug = aspect.replace(":", "-")
        n = 1
        while (folder / f"{slug}-v{n}.mp4").exists():
            n += 1
        out = folder / f"{slug}-v{n}.mp4"
        temp = out.with_name(out.stem + ".partial.mp4")
        fps = video_store.fps(project)
        encoder = ffmpeg_tools.Encoder(temp, wav, fps=fps)
        total = video_store.frame_count(project)
        indices = {round(i * (total - 1) / 11) for i in range(12)}
        sheet_indices = set(indices)
        # Overlay text clips (Content Studio Editor step 3): one more kept frame inside each, for the contrast check.
        from core import video_tracks
        indices |= video_tracks.check_frames(project, 0, total - 1)
        job = _job(project, aspect, job_id, frame_times=[i / fps for i in indices])
        seen = 0
        thumb_index = min(total - 1, thumb_frame(project, job["fps"]))
        samples, layouts, thumb = [], [], None
        state["status"] = f"rendering 0/{total}"

        async def consume(frames, layout):
            nonlocal seen, thumb
            layouts.extend(layout)
            def feed():
                for frame in frames:
                    encoder.write(frame)
            await asyncio.wait_for(asyncio.to_thread(feed), timeout=60)
            if state["status"].startswith("failed:"):
                return
            for frame in frames:
                if seen in indices:
                    samples.append((seen, frame))
                if seen == thumb_index:
                    thumb = frame
                seen += 1
            state["status"] = f"rendering {seen}/{total}"

        captured = time.monotonic()
        await design_render_bridge.video(job, consume)
        # The measured capture speed (frames a second through the render worker), for the render-speed estimates.
        state["capture_fps"] = round(total / max(1e-6, time.monotonic() - captured), 1)
        state["capture_seconds"] = round(time.monotonic() - captured, 2)
        state["status"] = "encoding"
        await asyncio.to_thread(encoder.finish)
        encoder = None
        measured = await _thread_done(ffmpeg_tools.loudness, temp)
        frames_kept, times_kept = [f for _, f in samples], [i / fps for i, _ in samples]
        notes = video_checks.check(project, aspect, layouts, frames_kept, measured, voice or None)
        notes += character_notes(project, layouts, frames_kept, times_kept)
        notes += video_checks.overlay_notes(project, aspect, layouts, frames_kept, times_kept)
        notes += pack_notes(project)
        notes += video_blender.renderer_note(project)
        sheet = folder / f"sheet-{slug}.png"
        sheet.write_bytes(ffmpeg_tools.contact_sheet([f for i, f in samples if i in sheet_indices], 4))
        thumb_path = folder / f"thumb-{slug}.png"
        if thumb:
            with Image.open(io.BytesIO(thumb)) as image:
                image.thumbnail((480, 480))
                image.save(thumb_path, "PNG")
        temp.replace(out)
        state.update(status="ready", file=out.name, path=str(out), loudness=measured, notes=notes, narration=voice or None, fps=fps, frames=total,
                     renderer=video_blender.effective(project), stage=_stage_info(project),
                     seconds=round(video_store.duration(project), 2),
                     url=f"/api/videos/{project['id']}/renders/{out.name}", sheet=sheet.name, thumbnail=thumb_path.name)
    except asyncio.CancelledError:
        state["status"] = "failed: cancelled"
    except Exception as error:
        state["status"] = "failed: " + str(error)[:1500]
    finally:
        try:
            if encoder:
                await asyncio.to_thread(encoder.abort)
            if temp:
                temp.unlink(missing_ok=True)
        finally:
            if acquired:
                lock.release()


def _stage_info(project):
    return {"renderer": video_blender.effective(project), "picked": project.get("renderer", "threejs")} \
        if any(b["kind"] == "stage" for b in project["beats"]) else None


async def preview(video_id, aspect, times=None):
    """Sample frames at `times`, or (None) at each shot's middle once the narration has set the timeline."""
    project = video_store.get(video_id)
    _aspect(project, aspect)
    if video_store.narrated(project):
        project = await asyncio.to_thread(video_narration.prepare, video_id)
    if times is None:
        beats = outline(project)
        count = min(6, len(beats))
        picks = [round(i * (len(beats) - 1) / max(1, count - 1)) for i in range(count)]
        times = [(beats[i]["start"] + beats[i]["end"]) / 2 for i in picks]
    seconds = video_store.duration(project)
    if (not isinstance(times, list) or not 1 <= len(times) <= 12 or
            any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or not 0 <= t < seconds for t in times)):
        raise ValueError("times: give 1 to 12 times within this video's duration.")
    frames, layouts = [], []
    async def consume(batch, samples):
        frames.extend(batch)
        layouts.extend(samples)
    async with _machine():
        await design_render_bridge.video(_job(project, aspect, secrets.token_hex(8), times), consume)
    notes = (video_checks.check(project, aspect, layouts, frames) + character_notes(project, layouts, frames, times)
             + video_checks.overlay_notes(project, aspect, layouts, frames, times) + pack_notes(project))
    if video_blender.wants_blender(project):
        notes.append("Preview drawn with three.js; the render uses Blender." if video_blender.effective(project) == "blender"
                     else video_blender.renderer_note(project)[0])
    notes += [f"Preview only: {p}" for p in pack_problems(project)]
    _last_preview[video_id] = {"version": project["version"], "notes": list(dict.fromkeys(notes))}
    return frames
