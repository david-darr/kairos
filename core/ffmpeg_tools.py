"""Discover external FFmpeg without installing it; stream JPEGs with backpressure."""
from __future__ import annotations
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from PIL import Image

MISSING = "Video needs FFmpeg, which isn't installed. On Windows run `winget install --id Gyan.FFmpeg -e`, on macOS `brew install ffmpeg`, on Debian or Ubuntu `sudo apt install ffmpeg`; then try again. Kairos never installs it for you."
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"


def _runnable(path):
    try:
        return subprocess.run([str(path), "-version"], capture_output=True, timeout=5,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def find():
    from core import settings
    configured = settings.get_setting("ffmpeg_path")
    if configured and _runnable(configured):
        return str(configured)
    found = shutil.which("ffmpeg")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        root = Path(local) / "Microsoft" / "WinGet"
        link = root / "Links" / "ffmpeg.exe"
        if link.is_file() and _runnable(link):
            return str(link)
        for path in sorted((root / "Packages").glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe")):
            if _runnable(path):
                return str(path)
    return None


def version():
    executable = find()
    if not executable:
        return None
    try:
        result = subprocess.run([executable, "-version"], capture_output=True, timeout=5,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return result.stdout.decode("utf-8", "replace").splitlines()[0] if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, IndexError):
        return None


# The picture settings every render uses. A long video's chapter parts are encoded with exactly these, so FFmpeg's
# concat demuxer joins them by copying the streams, with no second encode (core/video_longform.py).
VIDEO_ARGS = ["-vf", "scale=out_range=tv:out_color_matrix=bt709",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709",
              "-color_primaries", "bt709", "-color_trc", "bt709", "-crf", "18", "-preset", "medium"]
# loudnorm resamples to 192 kHz internally; bring the audio back to 48 kHz.
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-af", LOUDNORM, "-ar", "48000"]


class Encoder:
    """A pipe whose stderr goes to disk so verbose FFmpeg cannot deadlock it. Without a soundtrack it writes a
    picture-only part (a long video's chapter); the whole video's sound is added when the parts are joined."""
    def __init__(self, out, soundtrack, *, executable=None, timeout=180):
        self.path = Path(out)
        self.timeout = timeout
        exe = executable or find()
        if not exe:
            raise RuntimeError(MISSING)
        self.stderr = tempfile.TemporaryFile()
        # JPEG frames are full range; players expect TV range BT.709, or the colours wash out.
        self.argv = ([exe, "-y", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "-"]
                     + (["-i", str(soundtrack)] if soundtrack is not None else []) + VIDEO_ARGS
                     + (AUDIO_ARGS + ["-shortest"] if soundtrack is not None else ["-an"])
                     + ["-movflags", "+faststart", str(out)])
        try:
            self.process = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                            stderr=self.stderr, shell=False,
                                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except BaseException:
            self.stderr.close()
            raise

    def _error(self):
        self.stderr.seek(0, 2)
        length = self.stderr.tell()
        self.stderr.seek(max(0, length - 8000))
        return self.stderr.read().decode("utf-8", "replace")

    def write(self, jpeg_bytes):
        if not jpeg_bytes.startswith(b"\xff\xd8"):
            raise ValueError("The video worker must send JPEG frames.")
        try:
            self.process.stdin.write(jpeg_bytes)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise RuntimeError("FFmpeg could not encode the frame: " + self._error()) from None

    def finish(self):
        try:
            self.process.stdin.close()
            try:
                code = self.process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise RuntimeError("FFmpeg took too long to finish: " + self._error()) from None
            if code:
                raise RuntimeError("FFmpeg could not encode this video: " + self._error())
            return self.path
        finally:
            self.stderr.close()

    def abort(self):
        """Release the encoder on cancellation and never leave a partial MP4."""
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        self.stderr.close()
        self.path.unlink(missing_ok=True)


def _run(argv, timeout, what):
    """Run FFmpeg with its stderr in a file (a long join prints a lot); raise with the tail of it on failure."""
    with tempfile.TemporaryFile() as err:
        try:
            code = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, timeout=timeout,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"FFmpeg took too long to {what}.") from None
        err.seek(0, 2)
        err.seek(max(0, err.tell() - 8000))
        text = err.read().decode("utf-8", "replace")
    if code:
        raise RuntimeError(f"FFmpeg could not {what}: " + text[-1500:])
    return text


def join(parts, soundtrack, out, timeout=1800):
    """A long video from its chapter parts: the pictures are copied as they are (FFmpeg's concat demuxer; the parts share
    one encoder setting, so nothing is encoded twice) and the whole video's soundtrack is added with one loudness pass
    over all of it, so the music runs on across chapter joins and the level is the same everywhere."""
    exe = find()
    if not exe:
        raise RuntimeError(MISSING)
    out = Path(out)
    listing = out.with_suffix(".parts.txt")
    # The concat list quotes each path; a single quote inside one is written '\'' as the demuxer expects.
    listing.write_text("ffconcat version 1.0\n" + "".join(
        "file '" + str(Path(p).resolve()).replace("\\", "/").replace("'", "'\\''") + "'\n" for p in parts), encoding="utf-8")
    try:
        _run([exe, "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-i", str(soundtrack),
              "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
              # The copied stream keeps BT.709 TV range; these tag the container so players read it that way.
              "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
             + AUDIO_ARGS + ["-shortest", "-movflags", "+faststart", str(out)],
             timeout, "join the chapters")
    finally:
        listing.unlink(missing_ok=True)
    return out


def count_frames(path, timeout=600):
    """The number of video frames in a file, counted by reading the stream without decoding it."""
    exe = find()
    if not exe:
        raise RuntimeError(MISSING)
    text = _run([exe, "-v", "info", "-nostats", "-i", str(path), "-map", "0:v:0", "-c", "copy", "-f", "null", "-"],
                timeout, "read the video")
    found = re.findall(r"frame=\s*(\d+)", text)
    if not found:
        raise RuntimeError("FFmpeg did not report the frame count: " + text[-500:])
    return int(found[-1])


def loudness(path):
    exe = find()
    if not exe:
        raise RuntimeError(MISSING)
    result = subprocess.run([exe, "-i", str(path), "-af", LOUDNORM + ":print_format=json", "-f", "null", "-"],
                            capture_output=True, timeout=180,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stderr = result.stderr.decode("utf-8", "replace")
    if result.returncode:
        raise RuntimeError("FFmpeg could not measure loudness: " + stderr[-1500:])
    for block in reversed(re.findall(r"\{[^{}]*\}", stderr)):
        try:
            data = json.loads(block)
            return {key: float(data[key]) for key in ("input_i", "input_tp")}
        except (ValueError, KeyError, TypeError):
            continue
    raise RuntimeError("FFmpeg could not measure loudness: " + stderr[-1500:])


def contact_sheet(frames: list[bytes], cols=4):
    """Return PNG tiles in sample order, bounded for previews and chat images."""
    if not frames or not isinstance(cols, int) or cols < 1:
        raise ValueError("A contact sheet needs frames and at least one column.")
    images = []
    for raw in frames:
        with Image.open(io.BytesIO(raw)) as im:
            im = im.convert("RGB")
            im.thumbnail((400, 400))
            images.append(im.copy())
    cols = min(cols, len(images))
    w, h = max(im.width for im in images), max(im.height for im in images)
    sheet = Image.new("RGB", (cols * (w + 4) + 4, ((len(images) + cols - 1) // cols) * (h + 4) + 4))
    for i, im in enumerate(images):
        sheet.paste(im, (4 + (i % cols) * (w + 4), 4 + (i // cols) * (h + 4)))
    out = io.BytesIO()
    sheet.save(out, "PNG")
    return out.getvalue()
