"""Pack B's optional Blender renderer: one part of a video rendered by the person's own Blender, its labels and captions
composited over it in FFmpeg (Video Styles build spec, unit 5; David, 2026-11-10: "just add both as options").

Used only when a video's stage beats are set to render with Blender (`renderer: blender`, from its style pack or its
channel) and Blender is installed (core/blender_tools.py; never bundled, downloaded or required). Without Blender the
video renders with three.js, built in, and its notes say so plainly (renderer_note).

A Blender video renders in parts like a long video (core/video_longform.py runs it, so chapters, resume, Stop and
Resume, progress and the lossless join are the same): an unchaptered video is one part, a chaptered one a part per
chapter. Each part, in its own folder under the long render's parts:
1. The overlay pass: the render worker plays the video's own player with `layer=overlay` (electron/designRender.js): every
   2D thing (cards, captions, the floating labels and numbers over heads) is drawn as usual and the 3D stage shots are left
   transparent; it returns PNG frames with alpha, the 3D pose of every frame, and the stage models (static/motion/stage.js).
   Because the poses come from the same code three.js draws from, Blender plays exactly the same animation.
2. The Blender pass: `blender -b --factory-startup -P blender/kairos_stage.py -- ...` renders the frames that show a stage
   shot as PNGs (Eevee). Progress comes from the script's "KD_FRAME" lines; Stop ends the process; frames already written
   are kept and skipped next time, so a stopped part resumes where it was.
3. FFmpeg composites the overlay over Blender's frames (frames without a stage shot sit on black, which the opaque 2D
   cards cover) and encodes the part with the one setting every render uses, so parts join without a second encode.
The big PNG intermediates are removed once the part is encoded. The checks run on composited sample frames.

Transitions into and out of a stage shot are cuts with Blender (its picture is composited under the overlay, so it cannot
move with a whip or a zoom); three.js keeps every transition.
"""
from __future__ import annotations

import asyncio
import io
import json
import math
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from PIL import Image

from core import blender_tools, design_render_bridge, ffmpeg_tools, video_store
from core.atomic_io import write_json_atomic

SAMPLES = 32           # Eevee samples a frame (the spike: 64 at 0.43 s a frame, 16 at 0.27 s with slightly speckled shadows)


def wants_blender(project) -> bool:
    return project.get("renderer") == "blender" and any(b["kind"] == "stage" for b in project["beats"])


def effective(project) -> str:
    """The renderer this video's stage beats will use now: blender only when it was picked and is installed."""
    if not any(b["kind"] == "stage" for b in project["beats"]):
        # Pack C's voxel shots and the classic Story Short draw with three.js (static/motion/voxel3d.js, classic3d.js).
        return "threejs" if any(b["kind"] in ("voxel", "story") for b in project["beats"]) else "2d-engine"
    return "blender" if wants_blender(project) and blender_tools.find() else "threejs"


def renderer_note(project) -> list[str]:
    if wants_blender(project) and not blender_tools.find():
        return [blender_tools.detect()["message"]]
    return []


def _progress(state, chapter, total, overlay=1., blender=0.):
    """A part's progress for Studio: the overlay pass is the first tenth of it, Blender most of the rest."""
    chapter["done"] = int(total * (.1 * overlay + .85 * blender))
    state["frames_done"] = sum(c.get("done", 0) for c in state["chapters"])


def _black(path: Path, w: int, h: int):
    if not path.is_file():
        Image.new("RGB", (w, h), (0, 0, 0)).save(path, "PNG")


def _png_ok(path: Path) -> bool:
    """A whole PNG (a stopped render can leave a half-written last frame)."""
    try:
        size = path.stat().st_size
        if size < 64:
            return False
        with path.open("rb") as f:
            head = f.read(8)
            f.seek(size - 12)
            return head == b"\x89PNG\r\n\x1a\n" and b"IEND" in f.read(12)
    except OSError:
        return False


async def _overlay(project, aspect, span, folder: Path, state, chapter, sample_frames):
    """The 2D pass with alpha and the poses. Returns (poses, stage models, layouts, overlay PNGs kept for the samples)."""
    from core import video_render
    over = folder / "overlay"
    over.mkdir(parents=True, exist_ok=True)
    job = video_render._job(project, aspect, secrets.token_hex(8), frame_times=[f / video_store.fps(project) for f in sample_frames],
                            frames=(span["first_frame"], span["frames"]))
    job["path"] += "&layer=overlay"
    job["alpha"] = True
    poses, layouts, stage, seen = [], [], {}, 0

    async def consume(frames, layout, frame_poses, models=None):
        nonlocal seen
        layouts.extend(layout)
        if models is not None:
            stage.update(models)
        def write():
            for i, raw in enumerate(frames):
                (over / f"o_{span['first_frame'] + seen + i:06d}.png").write_bytes(raw)
        await asyncio.to_thread(write)
        poses.extend(frame_poses)
        seen += len(frames)
        chapter["overlay"] = seen
        _progress(state, chapter, span["frames"], seen / span["frames"])
        state["status"] = f"overlay pass {seen}/{span['frames']}"

    await design_render_bridge.video(job, consume)
    return poses, stage, layouts


def command(exe, folder: Path, frames: Path, w: int, h: int, first: int) -> list[str]:
    """The Blender command line: headless, factory settings (no add-ons or user scripts), Kairos's script, its two files."""
    return [exe, "-b", "--factory-startup", "-P", str(blender_tools.SCRIPT), "--", "--stage", str(folder / "stage.json"),
            "--poses", str(folder / "poses.json"), "--out", str(frames), "--width", str(w), "--height", str(h),
            "--first", str(first), "--samples", str(SAMPLES)]


async def _blender(folder: Path, aspect, span, stage, poses, state, chapter):
    """Run Blender over the part's stage frames; resumable (frames on disk are kept) and stoppable."""
    exe = blender_tools.find()
    if not exe:
        raise RuntimeError(blender_tools.MISSING)
    frames = folder / "blender"
    frames.mkdir(parents=True, exist_ok=True)
    for path in frames.glob("f_*.png"):
        if not _png_ok(path):
            path.unlink(missing_ok=True)
    (folder / "stage.json").write_text(json.dumps(stage, separators=(",", ":")), encoding="utf-8")
    (folder / "poses.json").write_text(json.dumps(poses, separators=(",", ":")), encoding="utf-8")
    w, h = video_store.ASPECTS[aspect]
    wanted = [span["first_frame"] + i for i, p in enumerate(poses) if p]
    done = sum((frames / f"f_{n:06d}.png").is_file() for n in wanted)
    chapter["blender_frames"], chapter["blender_done"] = len(wanted), done
    if done == len(wanted):
        return {"frames": 0, "seconds": 0.}
    argv = command(exe, folder, frames, w, h, span["first_frame"])
    began = time.monotonic()
    process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                   stdin=asyncio.subprocess.DEVNULL,
                                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    tail, rendered = [], 0
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip()
            tail = (tail + [text])[-40:]
            if text.startswith("KD_FRAME "):
                rendered += 1
                chapter["blender_done"] = done + rendered
                _progress(state, chapter, span["frames"], 1., (done + rendered) / max(1, len(wanted)))
                spent = time.monotonic() - began
                chapter["blender_fps"] = round(rendered / spent, 3) if spent > 0 else None
                state["status"] = f"Blender {done + rendered}/{len(wanted)}"
        code = await process.wait()
    except asyncio.CancelledError:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if code != 0:
        raise RuntimeError("Blender stopped with an error: " + " | ".join(t for t in tail[-8:] if t)[:1200])
    missing = [n for n in wanted if not (frames / f"f_{n:06d}.png").is_file()]
    if missing:
        raise RuntimeError(f"Blender did not write {len(missing)} frames (first {missing[0]}).")
    return {"frames": rendered, "seconds": time.monotonic() - began}


def composite(base_dir: Path, overlay_dir: Path, first: int, count: int, out: Path, timeout=3600, fps=30):
    """FFmpeg overlays the 2D pass on Blender's frames and encodes a picture-only part with the shared video settings."""
    exe = ffmpeg_tools.find()
    if not exe:
        raise RuntimeError(ffmpeg_tools.MISSING)
    vf = ffmpeg_tools.VIDEO_ARGS[1]
    video = [a for i, a in enumerate(ffmpeg_tools.VIDEO_ARGS) if i not in (0, 1)]
    ffmpeg_tools._run([exe, "-y", "-framerate", str(fps), "-start_number", str(first), "-i", str(base_dir / "f_%06d.png"),
                       "-framerate", str(fps), "-start_number", str(first), "-i", str(overlay_dir / "o_%06d.png"),
                       "-filter_complex", f"[0:v][1:v]overlay=0:0:format=auto,{vf}[v]", "-map", "[v]", "-frames:v", str(count),
                       *video, "-an", "-movflags", "+faststart", str(out)], timeout, "composite the overlay on Blender's frames")
    return out


async def chapter(project, aspect, span, key, parts: Path, state, index, sample_frames):
    """One part with Blender: overlay pass, Blender pass, composite. Returns (frames, seconds, samples, layouts)."""
    folder = parts / f"{key}-blender"
    folder.mkdir(parents=True, exist_ok=True)
    chapter_ = state["chapters"][index]
    began = time.monotonic()
    poses, stage, layouts = await _overlay(project, aspect, span, folder, state, chapter_, sample_frames)
    overlay_seconds = time.monotonic() - began
    result = await _blender(folder, aspect, span, stage, poses, state, chapter_)
    w, h = video_store.ASPECTS[aspect]
    base = folder / "blender"
    black = folder / "black.png"
    _black(black, w, h)
    for i, pose in enumerate(poses):
        n = span["first_frame"] + i
        target = base / f"f_{n:06d}.png"
        if not pose and not target.is_file():
            try:
                target.hardlink_to(black)
            except OSError:
                shutil.copyfile(black, target)
    state["status"] = "compositing"
    temp = parts / f"{key}.partial.mp4"
    await asyncio.to_thread(composite, base, folder / "overlay", span["first_frame"], span["frames"], temp, 3600, video_store.fps(project))
    samples = []
    for n in sample_frames:
        with Image.open(base / f"f_{n:06d}.png") as b, Image.open(folder / "overlay" / f"o_{n:06d}.png") as o:
            frame = b.convert("RGBA")
            frame.alpha_composite(o.convert("RGBA"))
            buf = io.BytesIO()
            frame.convert("RGB").save(buf, "JPEG", quality=92)
            samples.append((n, buf.getvalue()))
    chapter_["done"] = span["frames"]
    spent = time.monotonic() - began
    blender_fps = round(result["frames"] / result["seconds"], 3) if result["seconds"] else None
    return {"temp": temp, "seconds": spent, "samples": samples, "layouts": layouts, "folder": folder,
            "measured": {"overlay_seconds": round(overlay_seconds, 1), "blender_frames": result["frames"],
                         "blender_seconds": round(result["seconds"], 1), "blender_fps": blender_fps, "samples": SAMPLES,
                         "blender": blender_tools.detect()["version"]}}


def tidy(folder: Path):
    """Remove a finished part's PNG intermediates (gigabytes for a long part)."""
    shutil.rmtree(folder, ignore_errors=True)
