"""Serialize video captures and stream frames into an external encoder.

Only contact-sheet frames and a thumbnail stay in memory. A project version
is pinned in its signed player URL so edits during capture cannot change it.
"""
from __future__ import annotations
import asyncio
import io
import math
import secrets
from urllib.parse import quote
import weakref
from PIL import Image
from core import accounts, design_render, design_render_bridge, ffmpeg_tools, video_audio, video_checks, video_store

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
        end = start + beat["bars"] * 240 / project["bpm"]
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


def _job(project, aspect, job_id, times=None):
    w, h = _aspect(project, aspect)
    version = project["version"]
    token = design_render.sign(project["id"], f"video:{aspect}:{version}", 900)
    samples = sorted({round(b["start"] + (b["end"] - b["start"]) * f, 6)
                      for b in outline(project) for f in (.25, .5, .75)})
    return {"id": job_id, "kind": "video", "path": f"/api/videos/{project['id']}/player?aspect={quote(aspect, safe='')}&rt={token}&v={version}",
            "w": w, "h": h, "look": project["look"], "fps": 30,
            "frames": math.ceil(video_store.duration(project) * 30 - 1e-7),
            "preview": times is not None, "times": times or [], "layoutTimes": samples}


def status(job_id):
    if job_id not in _jobs or _owners.get(job_id) != accounts.effective_account():
        raise LookupError("No such video job.")
    return dict(_jobs[job_id])


def jobs_for(video_id):
    """The current account's render jobs of one video."""
    me = accounts.effective_account()
    return [dict(job) for job_id, job in list(_jobs.items()) if _owners.get(job_id) == me and job["video_id"] == video_id]


def cancel(job_id):
    status(job_id)
    task = _tasks.get(job_id)
    if task and not task.done() and not task.cancelling():
        task.cancel()
        _jobs[job_id]["status"] = "failed: cancelled"
    return status(job_id)


def start(video_id, aspect):
    """Return a reviewable job id immediately; fail before queuing without FFmpeg."""
    project = video_store.get(video_id)
    _aspect(project, aspect)
    if not ffmpeg_tools.find():
        raise RuntimeError(ffmpeg_tools.MISSING)
    if not design_render_bridge.available():
        raise design_render_bridge.Unavailable("Video rendering needs the Kairos desktop app. Open the desktop app and try again.")
    job_id = secrets.token_hex(8)
    _owners[job_id] = accounts.effective_account()
    _jobs[job_id] = {"id": job_id, "video_id": video_id, "aspect": aspect, "version": project["version"], "status": "queued"}
    _tasks[job_id] = asyncio.create_task(_render(project, aspect, job_id))
    # Bound completed status records; live jobs are never evicted.
    for old in list(_jobs)[:-200]:
        if old in _tasks and _tasks[old].done():
            _jobs.pop(old, None)
            _owners.pop(old, None)
            _tasks.pop(old, None)
    return status(job_id)


async def render(video_id, aspect):
    job = start(video_id, aspect)
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
        folder = video_store._folder(project["id"]) / "renders"
        wav = folder / "soundtrack.wav"
        await _thread_done(video_audio.write_wav, wav, project)
        slug = aspect.replace(":", "-")
        n = 1
        while (folder / f"{slug}-v{n}.mp4").exists():
            n += 1
        out = folder / f"{slug}-v{n}.mp4"
        temp = out.with_name(out.stem + ".partial.mp4")
        encoder = ffmpeg_tools.Encoder(temp, wav)
        job = _job(project, aspect, job_id)
        total, seen = job["frames"], 0
        indices = {round(i * (total - 1) / 11) for i in range(12)}
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
                    samples.append(frame)
                if seen == thumb_index:
                    thumb = frame
                seen += 1
            state["status"] = f"rendering {seen}/{total}"

        await design_render_bridge.video(job, consume)
        state["status"] = "encoding"
        await asyncio.to_thread(encoder.finish)
        encoder = None
        measured = await _thread_done(ffmpeg_tools.loudness, temp)
        notes = video_checks.check(project, aspect, layouts, samples, measured)
        sheet = folder / f"sheet-{slug}.png"
        sheet.write_bytes(ffmpeg_tools.contact_sheet(samples, 4))
        thumb_path = folder / f"thumb-{slug}.png"
        if thumb:
            with Image.open(io.BytesIO(thumb)) as image:
                image.thumbnail((480, 480))
                image.save(thumb_path, "PNG")
        temp.replace(out)
        state.update(status="ready", file=out.name, path=str(out), loudness=measured, notes=notes,
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


async def preview(video_id, aspect, times):
    project = video_store.get(video_id)
    _aspect(project, aspect)
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
    _last_preview[video_id] = {"version": project["version"], "notes": video_checks.check(project, aspect, layouts, frames)}
    return frames
