"""Video clips from the person's own files (Content Studio Editor build spec, step 7).

A video file the person uploads to a video (MP4, MOV, M4V, WebM, MKV; at most 200 MB) is decoded once by FFmpeg, with
the demuxer forced from the file type and local files only, into numbered JPEG frames at 30 a second (at most 60
seconds, at most 1280 px on the long side), named by the upload's hash. Its sound, when it has one, becomes a sound
asset (core/video_store.add_audio), so the editor can lay it on an audio track beside the picture. Nothing is fetched.

The render never seeks a video: a clip shows frame n = floor((in + t - start) * 30) of its file at timeline time t
(static/motion/overlay.js frameIndex), and the render page loads that exact frame before it draws (engine prepare).
The same file always gives the same frames, so a render is the same every time.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from core.atomic_io import read_json, write_json_atomic

TYPES = {"mp4": "mov", "m4v": "mov", "mov": "mov", "webm": "matroska", "mkv": "matroska"}
UPLOAD_LIMIT = 200 * 1024 * 1024
MAX_SECONDS = 60.0
FPS = 30                      # frames a second of every decoded file (static/motion/overlay.js MEDIA_FPS)
LONG_SIDE = 1280
MAX_FILES = 8
MAX_BYTES = 1024 * 1024 * 1024   # the decoded frames of one video's files together
NAME = re.compile(r"media/[a-f0-9]{64}")
QUALITY = "4"                 # FFmpeg's JPEG quality scale, 2 (best) to 31


def _folder(video_id) -> Path:
    from core import video_store
    return video_store._folder(video_id) / "media"


def info(video_id) -> dict:
    """{"media/<sha>": {seconds, frames, width, height, title, bytes, audio, cut}} for this video's files."""
    stored = read_json(str(_folder(video_id) / "media.json"), {})
    return stored if isinstance(stored, dict) else {}


def lookup(video_id):
    """Seconds of each uploaded video file, for the clip checks (None for a file this video does not hold)."""
    def seconds(name):
        try:
            entry = info(video_id).get(name)
        except LookupError:
            return None
        return entry["seconds"] if entry and (_folder(video_id) / name[6:]).is_dir() else None
    return seconds


def frame_path(video_id, sha, frame) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", str(sha)) or not re.fullmatch(r"\d{1,6}", str(frame)):
        raise LookupError("No such video frame.")
    path = _folder(video_id) / sha / f"{int(frame):06d}.jpg"
    if not path.is_file():
        raise LookupError("No such video frame.")
    return path


def _duration(exe, source, demuxer):
    result = subprocess.run([exe, "-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-f", demuxer, "-i", str(source)],
                            capture_output=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    found = re.search(rb"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", result.stderr)
    has_audio = re.search(rb"Stream #\d+:\d+(?:\[\w+\])?(?:\(\w+\))?: Audio:", result.stderr) is not None
    has_video = re.search(rb"Stream #\d+:\d+(?:\[\w+\])?(?:\(\w+\))?: Video:", result.stderr) is not None
    seconds = int(found[1]) * 3600 + int(found[2]) * 60 + float(found[3]) if found else None
    return seconds, has_video, has_audio


def add_video(video_id, raw, ext, title=""):
    """Decode a person's own video file into frames (and its sound into a sound asset); returns its media entry."""
    from core import ffmpeg_tools, video_store
    ext = str(ext or "").lower().lstrip(".")
    if ext not in TYPES or not isinstance(raw, bytes) or not raw:
        raise ValueError("video: upload an MP4, MOV, M4V, WebM or MKV video file.")
    if len(raw) > UPLOAD_LIMIT:
        raise ValueError("video: choose a video file under 200 MB.")
    exe = ffmpeg_tools.find()
    if not exe:
        raise RuntimeError(ffmpeg_tools.MISSING)
    video_store.get(video_id)
    sha = hashlib.sha256(raw).hexdigest()
    name = "media/" + sha
    folder = _folder(video_id)
    folder.mkdir(parents=True, exist_ok=True)
    known = info(video_id)
    if name in known and (folder / sha).is_dir():
        return {"media": name, **known[name]}
    if len([k for k in known if (folder / k[6:]).is_dir()]) >= MAX_FILES:
        raise ValueError(f"video: a video holds at most {MAX_FILES} video files; remove clips of one you no longer use first.")
    clean = " ".join(str(title or "").replace("<", " ").replace(">", " ").split())[:80] or "Video"
    audio_wav = None
    with tempfile.TemporaryDirectory(dir=str(folder)) as temp:
        source, frames = Path(temp, "in." + ext), Path(temp, "frames")
        source.write_bytes(raw)
        frames.mkdir()
        length, has_video, has_audio = _duration(exe, source, TYPES[ext])
        if not has_video:
            raise ValueError("video: this file has no picture FFmpeg can read.")
        scale = (f"scale=w='if(gte(iw,ih),min({LONG_SIDE},iw),-2)':h='if(gte(iw,ih),-2,min({LONG_SIDE},ih))'")
        result = subprocess.run([exe, "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", TYPES[ext], "-i", str(source),
                                 "-map", "0:v:0", "-an", "-sn", "-dn", "-t", f"{MAX_SECONDS:g}", "-vf", f"fps={FPS},{scale},format=yuvj420p",
                                 "-q:v", QUALITY, "-start_number", "0", "-f", "image2", str(frames / "%06d.jpg")],
                                capture_output=True, timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        made = sorted(frames.glob("*.jpg"))
        if result.returncode or not made:
            raise ValueError("video: this video file could not be read.")
        size = sum(p.stat().st_size for p in made)
        used = sum(p.stat().st_size for d in folder.iterdir() if d.is_dir() and re.fullmatch(r"[a-f0-9]{64}", d.name) for p in d.iterdir())
        if used + size > MAX_BYTES:
            raise ValueError("video: this video's video files would take more than 1 GB once decoded; use a shorter file.")
        from PIL import Image
        with Image.open(made[0]) as first:
            width, height = first.size
        if has_audio:
            wav = Path(temp, "sound.wav")
            sound = subprocess.run([exe, "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", TYPES[ext], "-i", str(source),
                                    "-map", "0:a:0", "-vn", "-t", f"{MAX_SECONDS:g}", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
                                    "-f", "wav", str(wav)], capture_output=True, timeout=300,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if not sound.returncode and wav.is_file() and wav.stat().st_size > 4096:
                audio_wav = wav.read_bytes()
        target = folder / sha
        if target.exists():
            shutil.rmtree(target)
        os.replace(frames, target)
    entry = {"seconds": round(len(made) / FPS, 4), "frames": len(made), "width": width, "height": height, "title": clean,
             "bytes": size, "cut": bool(length and length > MAX_SECONDS + .05), "source_seconds": round(length, 2) if length else None,
             "audio": None}
    if audio_wav:
        try:
            entry["audio"] = video_store.add_audio(video_id, audio_wav, "wav", clean)
        except ValueError:
            entry["audio"] = None      # the picture is still usable; the sound did not fit (the 100 MB images and sounds limit)
    with video_store._lock("video:" + video_id):
        stored = info(video_id)
        stored[name] = entry
        write_json_atomic(str(folder / "media.json"), dict(list(stored.items())[-50:]))
    return {"media": name, **entry}


def player_media(project) -> dict:
    """{sha: {frames, width, height}} for the video files the project's clips use, for the player page."""
    from core import video_tracks
    used = {c["video"] for t in video_tracks.tracks_of(project) for c in t["clips"] if c.get("kind") == "video"}
    known = info(project["id"]) if used else {}
    return {name[6:]: {k: known[name][k] for k in ("frames", "width", "height")} for name in used if name in known}
