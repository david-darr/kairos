"""The narration track of a video (Video Styles build spec, unit 1): script lines spoken by Kokoro, locally and free.

Audio-first timeline. Each beat's `say` is cut into its caption parts (core/video_store.clauses: sentences, a long one
at its commas), every part is spoken on its own through Kokoro's synthesis API (core/kokoro_voice.synthesize) and
measured, and the parts are joined with short pauses into the beat's line. The measurement goes into the beat's
`spoken` ({key, seconds, parts}); video_store derives the beat's length from it, so each line's measured length sets
its shot's length and every caption carries a measured time. Kokoro's ONNX model returns audio only (its one output
is `audio`, checked 2026-11-10), so there are no word timings: captions are line parts, not words.

The spoken lines are cached per video as 24 kHz mono WAV files named by their speech key (voice + text), so an edit
re-speaks only the lines it changed. `track()` lays the lines on the 48 kHz timeline for core/video_audio.py, which
ducks the music under them. Nothing here posts, downloads or installs anything; when Kokoro is not set up the
narration step says why and the video stays as it is.
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from core import video_store

RATE = 24000
OUT_RATE = 48000
SENTENCE_GAP = .18      # pause between two spoken sentences of one line
CLAUSE_GAP = .08        # between two parts cut at a comma
CLIP = 32700            # a PCM16 sample at or above this is counted as clipped


class NarrationUnavailable(RuntimeError):
    """Message is meant for the person or the model as-is."""


def _folder(video_id) -> Path:
    return video_store._folder(video_id) / "narration"


def clip_path(video_id, key) -> Path:
    if not isinstance(key, str) or len(key) != 16 or any(c not in "0123456789abcdef" for c in key):
        raise LookupError("No such narration line.")
    return _folder(video_id) / f"{key}.wav"


def _ready(voice):
    from core import kokoro_voice
    ok, reason = kokoro_voice.ready()
    if not ok:
        raise NarrationUnavailable(f"Narration needs the Kokoro voice, which is not ready: {reason}. "
                                   "Set it up in Settings > Speech, then narrate again.")
    names = {v["id"] for v in kokoro_voice.voices()}
    if names and voice not in names:
        raise NarrationUnavailable(f"narration.voice: Kokoro has no voice {voice}. Choose one of: " + ", ".join(sorted(names)) + ".")
    return kokoro_voice


def speak(say, voice, synthesize=None):
    """(int16 samples at 24 kHz, parts) for one line; parts are [start, end, text] in seconds from the line start."""
    if synthesize is None:
        synthesize = _ready(voice).synthesize
    chunks, parts, at = [], [], 0.
    pieces = video_store.clauses(say)
    for n, text in enumerate(pieces):
        audio = np.frombuffer(synthesize(text, voice), dtype="<i2")
        if not len(audio):
            raise NarrationUnavailable(f"Kokoro returned no audio for {text!r}.")
        seconds = len(audio) / RATE
        parts.append([round(at, 3), round(at + seconds, 3), text])
        chunks.append(audio)
        at += seconds
        if n < len(pieces) - 1:
            gap = SENTENCE_GAP if text.rstrip()[-1:] in ".!?…" else CLAUSE_GAP
            chunks.append(np.zeros(int(round(gap * RATE)), dtype="<i2"))
            at += len(chunks[-1]) / RATE
    return np.concatenate(chunks), parts


def _write(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    with wave.open(str(temp), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(samples.astype("<i2").tobytes())
    temp.replace(path)


def read_clip(video_id, key) -> np.ndarray:
    with wave.open(str(clip_path(video_id, key)), "rb") as clip:
        if clip.getframerate() != RATE or clip.getnchannels() != 1 or clip.getsampwidth() != 2:
            raise ValueError("A narration line is in an unexpected format; narrate the video again.")
        return np.frombuffer(clip.readframes(clip.getnframes()), dtype="<i2")


def missing(project) -> list[str]:
    """Ids of narrated beats whose line is not measured yet, or whose audio file is gone."""
    out = []
    for b in project["beats"]:
        if "say" in b and ("spoken" not in b or not clip_path(project["id"], b["spoken"]["key"]).is_file()):
            out.append(b["id"])
    return out


def prepare(video_id, synthesize=None):
    """Speak and measure every narrated beat that needs it, save the measurements, and return the project.
    Lines already measured in the same voice are reused. A video without narration comes back unchanged."""
    project = video_store.get(video_id)
    if not video_store.narrated(project):
        return project
    voice = project["narration"]["voice"]
    todo = missing(project)
    if not todo:
        return project
    speak_one = synthesize or _ready(voice).synthesize
    measured = {}
    for b in project["beats"]:
        if b["id"] not in todo:
            continue
        key = video_store.speech_key(voice, b["say"])
        samples, parts = speak(b["say"], voice, speak_one)
        _write(clip_path(video_id, key), samples)
        measured[b["id"]] = {"key": key, "seconds": round(len(samples) / RATE, 3),
                             "parts": [[round(video_store.LEAD + s, 3), round(video_store.LEAD + e, 3), t] for s, e, t in parts]}
    with video_store._lock("video:" + video_id):
        current = video_store.get(video_id)
        changed = False
        for b in current["beats"]:
            m = measured.get(b["id"])
            # An edit made while speaking wins: only a measurement of the line as it is now is stored.
            if m and "say" in b and m["key"] == video_store.speech_key(current["narration"]["voice"], b["say"]):
                b["spoken"] = m
                changed = True
        return video_store.save(video_id, current) if changed else current


def _upsample(samples):
    """24 kHz -> 48 kHz: the even samples are the input, the odd ones a windowed-sinc half-sample interpolation."""
    x = samples.astype(np.float32) / 32768.0
    taps = np.arange(-16, 16) + .5
    h = np.sinc(taps) * np.blackman(len(taps))
    h /= h.sum()
    odd = np.convolve(x, h, mode="full")[16:16 + len(x)]
    out = np.empty(len(x) * 2, dtype=np.float32)
    out[0::2], out[1::2] = x, odd
    return out


def track(project, rate=OUT_RATE):
    """(mono float32 voice on the project's timeline, report). Each line starts LEAD seconds into its beat."""
    seconds = video_store.duration(project)
    voice = np.zeros(round(seconds * rate), dtype=np.float32)
    report = {"lines": 0, "clipped_samples": 0, "peak": 0.}
    start = 0.
    gone = missing(project)
    if gone:
        raise NarrationUnavailable("These beats' lines are not narrated yet: " + ", ".join(gone) + ". Run video_narrate.")
    for b in project["beats"]:
        if "say" in b:
            raw = read_clip(project["id"], b["spoken"]["key"])
            report["lines"] += 1
            report["clipped_samples"] += int(np.count_nonzero(np.abs(raw.astype(np.int32)) >= CLIP))
            line = _upsample(raw) if rate == 2 * RATE else raw.astype(np.float32) / 32768.0
            offset = round((start + video_store.LEAD) * rate)
            end = min(len(voice), offset + len(line))
            if end > offset:
                voice[offset:end] += line[:end - offset]
        start += video_store.beat_seconds(b, project["bpm"])
    report["peak"] = float(np.max(np.abs(voice))) if len(voice) else 0.
    return voice, report


def timeline(project):
    """The timestamped shot plan: one row per beat with its time, what is on screen and what is said."""
    rows, start = [], 0.
    for b in project["beats"]:
        end = start + video_store.beat_seconds(b, project["bpm"])
        screen = b.get("text") or str(b.get("number", "")) or ", ".join(b.get("items", []))
        rows.append({"id": b["id"], "start": round(start, 2), "end": round(end, 2), "kind": b["kind"], "screen": screen,
                     "say": b.get("say", ""), "measured": "spoken" in b if "say" in b else None,
                     "camera": b.get("camera", "still"), "transition": b.get("transition", "cut")})
        start = end
    return rows


def _clock(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def plan_text(project):
    """The shot plan as plain lines, for the model, the post record and the person's approval."""
    rows = timeline(project)
    narration = project.get("narration")
    head = (f"Shot plan for \"{project['title']}\", {video_store.duration(project):.1f} s, {len(rows)} shots, "
            + (f"narrated by Kokoro voice {narration['voice']}" + (", captions on" if narration["captions"] else ", captions off")
               if video_store.narrated(project) else "music only") + ".")
    lines = [head]
    for r in rows:
        said = f" | says: \"{r['say']}\"" + ("" if r["measured"] else " (length estimated, not yet spoken)") if r["say"] else ""
        lines.append(f"{_clock(r['start'])}-{_clock(r['end'])} {r['id']} {r['kind']}, {r['camera']}: \"{r['screen']}\"{said}")
    return "\n".join(lines)
