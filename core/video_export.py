"""Other output formats from a finished render (Content Studio Editor build spec, step 6). FFmpeg arguments only.

Every format starts from the MP4 the normal render path makes (narration, chapters, resume and the checks all run
there, once). An export then encodes that file again, which takes seconds to a minute instead of a second capture:
- WebM: VP9 video (constant quality, CRF 32, two threads of rows) and Opus sound at 128 kb/s, for the web.
- MOV: the same H.264 picture and AAC sound copied into a QuickTime file, bit for bit (no second encode), for editors
  that want .mov. ProRes was measured and not chosen: our frames are 8-bit 4:2:0 JPEG captures already, so ProRes adds
  no picture, only size (ProRes 422 HQ was 373 MB against the MP4's 5.7 MB on the 27.9 s sample, 65 times).
- GIF: picture only, a palette made for the clip (FFmpeg palettegen, changed areas only) and an ordered dither, at the
  largest size and frame rate that keeps the file under the cap (15 MB unless asked); at most 60 seconds of video.
YouTube posting keeps the MP4. Nothing here fetches, installs or runs anything but the FFmpeg Kairos already found.
"""
from __future__ import annotations

import asyncio
import re
import secrets
import time
from pathlib import Path

from core import ffmpeg_tools, video_store

FORMATS = ("mp4", "webm", "mov", "gif")
GIF_CAP_MB = 15
GIF_MAX_SECONDS = 60.0
# The GIF ladder, best first: (frames a second, long side in pixels).
GIF_STEPS = ((15, 720), (12, 640), (12, 540), (10, 480), (10, 400), (8, 360), (8, 320))
WEBM_ARGS = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
             "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000"]
MOV_ARGS = ["-c", "copy", "-movflags", "+faststart", "-f", "mov"]
PRORES_ARGS = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le", "-f", "mov"]   # measured only


def out_path(master: Path, fmt) -> Path:
    return master.with_suffix("." + fmt)


def webm(master, out, timeout=3600):
    exe = _exe()
    ffmpeg_tools._run([exe, "-y", "-i", str(master), "-map", "0:v:0", "-map", "0:a:0?", *WEBM_ARGS, str(out)], timeout, "make the WebM")
    return out


def mov(master, out, timeout=600):
    exe = _exe()
    ffmpeg_tools._run([exe, "-y", "-i", str(master), "-map", "0", *MOV_ARGS, str(out)], timeout, "make the MOV")
    return out


def prores(master, out, timeout=3600):
    """ProRes 422 HQ, for the measurement that chose H.264 in MOV (not offered in Studio)."""
    exe = _exe()
    ffmpeg_tools._run([exe, "-y", "-i", str(master), "-map", "0:v:0", "-map", "0:a:0?", *PRORES_ARGS, str(out)], timeout, "make the ProRes MOV")
    return out


def gif(master, out, start=0., end=None, cap_mb=GIF_CAP_MB, timeout=1200):
    """The largest GIF under the cap. Returns {fps, long_side, bytes, seconds, tries}."""
    exe = _exe()
    out = Path(out)
    length = (end if end is not None else _seconds(master)) - start
    if length <= 0:
        raise ValueError("gif: choose a stretch of the video to export.")
    if length > GIF_MAX_SECONDS + 1e-6:
        raise ValueError(f"gif: a GIF holds at most {GIF_MAX_SECONDS:g} seconds; set In and Out around the part you want.")
    width, height = _size(master)
    tries = []
    for fps, side in GIF_STEPS:
        scale = f"scale={side}:-2:flags=lanczos" if width >= height else f"scale=-2:{side}:flags=lanczos"
        graph = (f"fps={fps},{scale},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];"
                 f"[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle")
        temp = out.with_suffix(".partial.gif")
        ffmpeg_tools._run([exe, "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(master), "-an",
                           "-filter_complex", graph, "-loop", "0", "-f", "gif", str(temp)], timeout, "make the GIF")
        size = temp.stat().st_size
        tries.append({"fps": fps, "long_side": side, "bytes": size})
        if size <= cap_mb * 1024 * 1024:
            temp.replace(out)
            return {"fps": fps, "long_side": side, "bytes": size, "seconds": round(length, 2), "tries": tries}
        temp.unlink(missing_ok=True)
    raise ValueError(f"gif: even at {GIF_STEPS[-1][1]} px and {GIF_STEPS[-1][0]} frames a second the GIF is over {cap_mb} MB; "
                     "export a shorter stretch (set In and Out).")


def _exe():
    exe = ffmpeg_tools.find()
    if not exe:
        raise RuntimeError(ffmpeg_tools.MISSING)
    return exe


def _probe(master):
    import subprocess
    result = subprocess.run([_exe(), "-hide_banner", "-i", str(master)], capture_output=True, timeout=60,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return result.stderr.decode("utf-8", "replace")


def _seconds(master):
    found = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", _probe(master))
    if not found:
        raise RuntimeError("FFmpeg could not read the render's length.")
    return int(found[1]) * 3600 + int(found[2]) * 60 + float(found[3])


def _size(master):
    found = re.search(r"Video: [^\n]*?, (\d{2,5})x(\d{2,5})", _probe(master))
    if not found:
        raise RuntimeError("FFmpeg could not read the render's picture size.")
    return int(found[1]), int(found[2])


def make(master, fmt, start=None, end=None, cap_mb=GIF_CAP_MB):
    """Encode one export next to its MP4. Returns {file, bytes, seconds_spent, ...}."""
    master = Path(master)
    out = out_path(master, fmt)
    began = time.monotonic()
    extra = {}
    if fmt == "webm":
        webm(master, out)
    elif fmt == "mov":
        mov(master, out)
    elif fmt == "gif":
        extra = gif(master, out, start or 0., end, cap_mb)
    else:
        raise ValueError("format: choose mp4, webm, mov or gif.")
    return {"file": out.name, "bytes": out.stat().st_size, "seconds_spent": round(time.monotonic() - began, 2), **extra}


def start(video_id, aspect, fmt, start_s=None, end_s=None, register=None):
    """An export job: the master MP4 of this version (made through the normal render path when it is not there yet,
    chapters and resume included), then the format. Returns the job's status."""
    from core import video_render
    if fmt not in FORMATS or fmt == "mp4":
        raise ValueError("format: choose webm, mov or gif (mp4 is the normal render).")
    project = video_store.get(video_id)
    seconds = video_store.duration(project)
    if fmt == "gif":
        a = 0. if start_s is None else float(start_s)
        b = seconds if end_s is None else float(end_s)
        if not 0 <= a < b <= seconds + 1e-6:
            raise ValueError("gif: choose a start and end inside the video.")
        if b - a > GIF_MAX_SECONDS + 1e-6:
            raise ValueError(f"gif: a GIF holds at most {GIF_MAX_SECONDS:g} seconds; set In and Out around the part you want "
                             f"(this video runs {seconds:.0f} seconds).")
        start_s, end_s = a, b
    job_id = secrets.token_hex(8)
    state = {"id": job_id, "video_id": video_id, "aspect": aspect, "version": project["version"], "status": "queued",
             "kind": "export", "format": fmt}
    return (register or video_render._register)(job_id, state, _run(video_id, aspect, fmt, start_s, end_s, job_id))


def _ready_master(video_id, aspect, version):
    from core import video_render
    for job in reversed(video_render.jobs_for(video_id)):
        if (job.get("kind") != "export" and job["aspect"] == aspect and job.get("version") == version and job["status"] == "ready"
                and job.get("file", "").endswith(".mp4")):
            path = video_store._folder(video_id) / "renders" / job["file"]
            if path.is_file():
                return path, job
    return None, None


async def _run(video_id, aspect, fmt, start_s, end_s, job_id):
    from core import video_render
    state = video_render._jobs[job_id]
    try:
        master, job = _ready_master(video_id, aspect, state["version"])
        if master is None:
            state["status"] = "rendering the MP4 first"
            first = video_render.start(video_id, aspect)
            state["master_job"] = first["id"]
            await video_render._tasks[first["id"]]
            job = video_render.status(first["id"])
            if job["status"] != "ready":
                raise RuntimeError("the MP4 render stopped (" + job["status"].replace("failed: ", "") + "); render again to resume, then export.")
            master = video_store._folder(video_id) / "renders" / job["file"]
        state["status"] = f"encoding {fmt.upper()}"
        made = await asyncio.to_thread(make, master, fmt, start_s, end_s)
        state.update(status="ready", master=master.name, file=made["file"], bytes=made["bytes"], seconds_spent=made["seconds_spent"],
                     url=f"/api/videos/{video_id}/renders/{made['file']}", notes=job.get("notes", []),
                     **{k: made[k] for k in ("fps", "long_side", "seconds") if k in made})
    except asyncio.CancelledError:
        state["status"] = "failed: cancelled"
    except Exception as error:
        state["status"] = "failed: " + str(error)[:1500]
