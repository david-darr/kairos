"""The narration track of a video (Video Styles build spec, unit 1): script lines spoken by Kokoro, locally and free.

Audio-first timeline. Each beat's `say` is cut into its caption parts (core/video_store.clauses: sentences, a long one
at its commas), every part is spoken on its own through Kokoro's synthesis API (core/kokoro_voice.synthesize) and
measured, and the parts are joined with short pauses into the beat's line. The measurement goes into the beat's
`spoken` ({key, seconds, parts}); video_store derives the beat's length from it, so each line's measured length sets
its shot's length and every caption carries a measured time. Kokoro's ONNX model returns audio only (its one output
is `audio`, checked 2026-11-10), so it gives no word timings; when the video's captions light the word being said
(narration.caption_style highlight or box), each line's words are aligned against its own audio by core/video_align.py
(whisper.cpp, already part of the app) and stored as `spoken.words`, with `spoken.align` saying how sure it was.

The spoken lines are cached per video as 24 kHz mono WAV files named by their speech key (voice + text + the account's
Pronunciations entries for words in the line), so an edit, to a line or to the list, re-speaks only the lines it changed. `track()` lays the lines on the 48 kHz timeline for core/video_audio.py, which
ducks the music under them. Nothing here posts, downloads or installs anything; when Kokoro is not set up the
narration step says why and the video stays as it is.

A Story Short (Pack C classic, David 2026-11-10) is pure dialogue: each story beat's line is spoken by its speaker's own
voice (the character spec's {id, speed, pitch}; core/video_store.beat_voice): Kokoro at that speed, then pitched up with a
rate change and the tempo brought back (FFmpeg's asetrate, aresample and atempo, the reference's method), so the speed
holds; each line is rendered alone and its silent edges trimmed. Its words are always aligned (the format's captions show
one word at a time); when whisper.cpp is missing or unsure, the words share the line's parts by letters and the
alignment says so. The line starts STORY_LEAD into its shot and the gap after it comes from the beat.
"""
from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np

from core import ffmpeg_tools, video_align, video_mouth, video_store

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


def speak(say, voice, synthesize=None, speed=1.):
    """(int16 samples at 24 kHz, parts) for one line; parts are [start, end, text] in seconds from the line start."""
    if synthesize is None:
        synthesize = _ready(voice).synthesize
    chunks, parts, at = [], [], 0.
    pieces = video_store.clauses(say)
    for n, text in enumerate(pieces):
        audio = np.frombuffer(synthesize(text, voice, **({"speed": speed} if speed != 1 else {})), dtype="<i2")
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


def pitch_shift(samples, semitones, rate=RATE):
    """The line pitched by `semitones` with its length kept: a rate change (asetrate), resampled back to `rate`, then the
    tempo brought back (atempo), all in FFmpeg. Plain int16 in and out; no file is written."""
    if not semitones:
        return samples
    import subprocess
    exe = ffmpeg_tools.find()
    if not exe:
        raise NarrationUnavailable(ffmpeg_tools.MISSING)
    ratio = 2 ** (float(semitones) / 12)
    chain = f"asetrate={rate * ratio:.3f},aresample={rate},atempo={1 / ratio:.6f}"
    result = subprocess.run([exe, "-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0", "-af", chain,
                             "-f", "s16le", "-ar", str(rate), "-ac", "1", "pipe:1"], input=samples.astype("<i2").tobytes(),
                            capture_output=True, timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise NarrationUnavailable("FFmpeg could not shift the voice's pitch: " + result.stderr.decode("utf-8", "replace")[-400:])
    return np.frombuffer(result.stdout, dtype="<i2").copy()


TRIM_DB, TRIM_PAD = -42., .03


def trim(samples, parts, rate=RATE):
    """Cut the line's silent start and end (under TRIM_DB of its peak, keeping TRIM_PAD), moving its parts with it."""
    if not len(samples):
        return samples, parts
    x = np.abs(samples.astype(np.float32))
    floor = x.max() * 10 ** (TRIM_DB / 20)
    loud = np.nonzero(x > floor)[0]
    if not len(loud):
        return samples, parts
    first, last = max(0, loud[0] - int(TRIM_PAD * rate)), min(len(samples), loud[-1] + int(TRIM_PAD * rate))
    cut, end = first / rate, (last - first) / rate
    moved = [[round(max(0., s - cut), 3), round(min(end, max(0., e - cut)), 3), t] for s, e, t in parts]
    top = math.floor(end * 1000) / 1000
    moved = [[min(s, round(top - .01, 3)), min(top, max(e, s + .01)), t] for s, e, t in moved]
    return samples[first:last], moved


def letter_words(say, parts):
    """Word times by letters inside each spoken part, for a line whisper.cpp could not align (seconds from the line start)."""
    out = []
    for start, end, text in parts:
        words = video_align.words_of(text)
        total = sum(len(w) + 1 for w in words) or 1
        at = start
        for w in words:
            span = (end - start) * (len(w) + 1) / total
            out.append([round(at, 3), round(at + span * .92, 3)])
            at += span
    return out if len(out) == len(video_align.words_of(say)) else []


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
    """Ids of narrated beats whose line is not measured yet, whose audio file is gone, or whose measurement is stale
    (the key no longer matches: a Pronunciations edit changed how the line is said)."""
    out = []
    for b in project["beats"]:
        if "say" in b and ("spoken" not in b or not clip_path(project["id"], b["spoken"]["key"]).is_file()
                           or b["spoken"]["key"] != video_store.speech_key(video_store.voice_key(video_store.beat_voice(project, b)), b["say"])):
            out.append(b["id"])
    return out


# Beats whose characters speak the line: Pack A scenes, Pack B stage shots and Pack C voxel shots. (Stage shots had no
# mouth shapes before Pack C: their lips stayed at rest while the narration played.)
TALKING = ("scene", "stage", "voxel", "story")


def prepare(video_id, synthesize=None):
    """Speak and measure every narrated beat that needs it, save the measurements, and return the project.
    Lines already measured in the same voice are reused. A video without narration comes back unchanged."""
    project = video_store.get(video_id)
    if not video_store.narrated(project):
        return project
    todo = missing(project)
    lips = [b["id"] for b in project["beats"] if b["kind"] in TALKING and "spoken" in b and "mouth" not in b["spoken"]
            and b["id"] not in todo]
    # Word captions: lines spoken before the video asked for them are aligned from their own audio, without speaking again.
    # A Story Short's lines are always aligned (its captions show one word at a time).
    words = video_store.word_captions(project)
    wants_words = lambda b: words or b["kind"] == "story"
    unaligned = [b["id"] for b in project["beats"] if wants_words(b) and "spoken" in b and "align" not in b["spoken"] and b["id"] not in todo]
    if not todo and not lips and not unaligned:
        return project
    speakers = {}
    measured = {}
    for b in project["beats"]:
        lead = video_store.lead_of(b)
        if b["id"] in lips or b["id"] in unaligned:
            # Measured before it became a scene (or before word captions): its mouth shapes and word times come from
            # the line already spoken.
            samples = read_clip(video_id, b["spoken"]["key"])
            measured[b["id"]] = dict(b["spoken"])
            if b["id"] in lips:
                measured[b["id"]]["mouth"] = video_mouth.for_beat(samples, lead, RATE)
            if b["id"] in unaligned:
                line_parts = [[s - lead, e - lead, t] for s, e, t in b["spoken"]["parts"]]
                measured[b["id"]].update(_words_for(b, samples, lead, line_parts))
            continue
        if b["id"] not in todo:
            continue
        voice = video_store.beat_voice(project, b)
        if voice["id"] not in speakers:
            speakers[voice["id"]] = synthesize or _ready(voice["id"]).synthesize
        key = video_store.speech_key(video_store.voice_key(voice), b["say"])
        samples, parts = speak(b["say"], voice["id"], speakers[voice["id"]], voice["speed"])
        if b["kind"] == "story":
            # Each line alone: pitched with its length kept, then trimmed to the voice.
            samples = pitch_shift(samples, voice["pitch"])
            samples, parts = trim(samples, parts)
        _write(clip_path(video_id, key), samples)
        measured[b["id"]] = {"key": key, "seconds": round(len(samples) / RATE, 3),
                             "parts": [[round(lead + s, 3), round(lead + e, 3), t] for s, e, t in parts]}
        if b["kind"] in TALKING:
            # A speaking character's mouth follows this line's own audio envelope (core/video_mouth.py).
            measured[b["id"]]["mouth"] = video_mouth.for_beat(samples, lead, RATE)
        if wants_words(b):
            measured[b["id"]].update(_words_for(b, samples, lead, parts))
    with video_store._lock("video:" + video_id):
        current = video_store.get(video_id)
        changed = False
        for b in current["beats"]:
            m = measured.get(b["id"])
            # An edit made while speaking wins: only a measurement of the line as it is now is stored.
            if m and "say" in b and m["key"] == video_store.speech_key(video_store.voice_key(video_store.beat_voice(current, b)), b["say"]):
                b["spoken"] = m
                changed = True
        return video_store.save(video_id, current) if changed else current


def _words_for(b, samples, lead, parts):
    """Aligned word times for a line; a story line whisper.cpp could not align confidently shares its parts by letters."""
    found = video_align.for_beat(b["say"], samples, RATE, lead, parts)
    if b["kind"] == "story" and "words" not in found:
        spread = letter_words(b["say"], parts)
        if spread:
            note = (found.get("align") or {}).get("note") or "whisper.cpp was unsure of this line"
            found = {"words": [[round(lead + s, 3), round(lead + e, 3)] for s, e in spread],
                     "align": {"method": "letters", "confidence": float((found.get("align") or {}).get("confidence", 0.)),
                               "note": ("Words shared by letters: " + note)[:200]}}
    return found


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
            offset = round((start + video_store.lead_of(b)) * rate)
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
        if b["kind"] == "story":
            story = b.get("story") or {}
            screen = f"{story.get('place', 'meadow')}{', flashback' if b.get('flashback') else ''}: " + ", ".join(
                s.get("shot", "medium") for s in story.get("shots", []))
        rows.append({"id": b["id"], "start": round(start, 2), "end": round(end, 2), "kind": b["kind"], "screen": screen,
                     "say": b.get("say", ""), "measured": "spoken" in b if "say" in b else None,
                     "camera": b.get("camera", "still"), "transition": b.get("transition", "cut"),
                     **({"speaker": b["speaker"]} if b.get("speaker") else {})})
        start = end
    return rows


def _clock(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def plan_text(project):
    """The shot plan as plain lines, for the model, the post record and the person's approval."""
    rows = timeline(project)
    narration = project.get("narration")
    story = any(b["kind"] == "story" for b in project["beats"])
    head = (f"Shot plan for \"{project['title']}\", {video_store.duration(project):.1f} s, {len(rows)} shots, "
            + ("a Story Short: dialogue, each character in its own Kokoro voice, captions one word at a time" if story else
               f"narrated by Kokoro voice {narration['voice']}" + (", captions on" if narration["captions"] else ", captions off")
               if video_store.narrated(project) else "music only") + ".")
    lines = [head]
    names = {}
    if any(r.get("speaker") for r in rows):
        from core import character_store
        for entry in project.get("cast") or []:
            try:
                names[entry["character"]] = character_store.get(entry["character"])["name"]
            except LookupError:
                pass
    for r in rows:
        who = f"{names.get(r['speaker'], 'a character')} " if r.get("speaker") else ""
        said = f" | {who}says: \"{r['say']}\"" + ("" if r["measured"] else " (length estimated, not yet spoken)") if r["say"] else ""
        lines.append(f"{_clock(r['start'])}-{_clock(r['end'])} {r['id']} {r['kind']}, {r['camera']}: \"{r['screen']}\"{said}")
    return "\n".join(lines)
