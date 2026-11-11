"""Deterministic original music on the project's bar grid, with AAC headroom, and the narration mixed over it.

The starter's kick, high-pass hats, detuned chords and rising noise are mixed
in floating point before normalization, soft clipping and PCM conversion.

A narrated video (core/video_narration.py) puts the voice on top: the voice is levelled, the music sits under it and
ducks a further DUCK_DB while a line is spoken (the duck opens slightly before each line, since the whole timeline is
known), and the mix keeps headroom below -1 dBFS with no clipping. The encoder's loudness pass then brings the file to
-16 LUFS (core/ffmpeg_tools.LOUDNORM).

A Story Short (Pack C classic, David 2026-11-10) mixes differently, at the reference's levels: the dialogue at a median
of STORY_VOICE_DB while speaking, a soft piano bed synthesized here at STORY_BED_DB (dipped a further STORY_DIP_DB in
flashbacks; music volume 0 turns it off), and one sound effect per event from the beats' `sfx` (boom, splat, sting, riser,
pop, whoosh, impact, steps, gasp), every one synthesized in code here: nothing is downloaded. A soft clip keeps the peaks;
the encoder then brings the file to -14 LUFS (STORY_LUFS) instead of -16.
"""
from pathlib import Path
import wave
import numpy as np
from core.video_store import beat_seconds, duration, narrated, validate

SR = 48000
VOICE_RMS_DB = -20.0      # the voice's level while speaking, before the loudness pass
BED_DB = -9.0             # music between lines, relative to the speaking voice
DUCK_DB = -12.0           # further down while a line is spoken
MIX_PEAK = 10 ** (-1.5 / 20)


STORY_VOICE_DB = -15.0    # the dialogue's median level while speaking (a Story Short)
STORY_BED_DB = -29.0      # its piano bed
STORY_DIP_DB = -6.0       # the bed further down in a flashback
STORY_SFX_DB = -17.0      # a sound effect's level (RMS over its loud part)
STORY_LUFS = -14.0


def is_story(project) -> bool:
    return any(b["kind"] == "story" for b in project["beats"])


def synthesize(project, report=None):
    """Stereo float32 at 48 kHz. `report`, when given, is filled with the narration levels for the checks."""
    p = validate(project)
    if is_story(p):
        return _sounds(p, _story(p, report), report)
    music = _music(p)
    if narrated(p):
        from core import video_narration
        voice, stats = video_narration.track(p, SR)
        music = _mix(music, voice, stats, p["music"]["volume"], report)
    return _sounds(p, music, report)


def _sounds(p, mix, report=None):
    """The audio tracks' sound clips (Content Studio Editor step 3), from the person's own uploaded files: each clip's
    stretch of its file (in to out) at its volume with linear fades, placed at its start, over the music and voice.
    A muted (hidden) track adds nothing. The mix is then kept under the same headroom as before."""
    from core import video_store, video_tracks
    clips = [c for t in p.get("tracks") or [] if t["kind"] == "audio" and not t["hidden"] for c in t["clips"]]
    if not clips:
        return mix
    count, cache, placed = len(mix), {}, 0
    for clip in clips:
        name = clip["audio"]
        if name not in cache:
            with wave.open(str(video_store.asset_path(p["id"], name[len("assets/"):])), "rb") as w:
                if w.getframerate() != SR or w.getnchannels() != 2 or w.getsampwidth() != 2:
                    raise ValueError(f"The sound {name} is not a 48 kHz stereo file; upload it again.")
                cache[name] = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 2)
        source = cache[name]
        first, last = round(clip["in"] * SR), min(len(source), round(clip["out"] * SR))
        at = round(clip["start"] * SR)
        n = min(last - first, count - at)
        if n <= 0:
            continue
        piece = source[first:first + n].astype(np.float32) / 32768 * np.float32(clip["volume"])
        t = np.arange(n, dtype=np.float32) / SR
        gain = np.ones(n, dtype=np.float32)
        if clip["fade_in"] > 0:
            gain = np.minimum(gain, t / np.float32(clip["fade_in"]))
        if clip["fade_out"] > 0:
            gain = np.minimum(gain, (np.float32(video_tracks.length(clip)) - t) / np.float32(clip["fade_out"]))
        mix[at:at + n] += piece * np.clip(gain, 0, 1)[:, None]
        placed += 1
    peak = float(np.max(np.abs(mix))) if count else 0.
    if peak > MIX_PEAK:
        mix *= MIX_PEAK / peak
    if report is not None:
        report["sound_clips"] = placed
    return mix


def _envelope(active, frame):
    """Gain per sample from per-frame speech activity: opens 120 ms early, releases over 400 ms, never steps."""
    ahead, hold = int(.12 * SR / frame), int(.4 * SR / frame)
    near = active.copy()
    for shift in range(1, ahead + 1):
        near[:-shift] |= active[shift:]
    for shift in range(1, hold + 1):
        near[shift:] |= active[:-shift]
    target = np.where(near, 10 ** (DUCK_DB / 20), 1.0)
    width = max(1, int(.08 * SR / frame))
    smooth = np.convolve(np.pad(target, (width, width), mode="edge"), np.ones(2 * width + 1) / (2 * width + 1), mode="same")[width:-width]
    return np.repeat(smooth.astype(np.float32), frame)


def _mix(music, voice, stats, volume, report):
    frame = SR // 100
    n = len(music)
    voice = np.pad(voice[:n], (0, max(0, n - len(voice))))
    frames = len(voice) // frame
    level = np.sqrt((voice[:frames * frame].reshape(frames, frame) ** 2).mean(axis=1) + 1e-12)
    active = level > (level.max() * 10 ** (-40 / 20) if frames else 1)
    speaking = float(np.sqrt(np.mean(level[active] ** 2))) if active.any() else 0.
    if speaking > 0:
        gain = 10 ** (VOICE_RMS_DB / 20) / speaking
        if stats["peak"] * gain > 10 ** (-3 / 20):        # never push the voice's own peaks past -3 dBFS
            gain = 10 ** (-3 / 20) / stats["peak"]
        voice = voice * gain
        speaking *= gain
    m_level = float(np.sqrt(np.mean(music.astype(np.float64) ** 2))) if n else 0.
    bed = 0.
    if m_level > 0 and speaking > 0:
        bed = speaking * 10 ** (BED_DB / 20) * (volume / .7) / m_level
    duck = _envelope(active, frame)
    duck = np.pad(duck[:n], (0, max(0, n - len(duck))), constant_values=1.0)
    mix = music * (np.float32(bed) * duck)[:, None] + voice[:, None]
    peak = float(np.max(np.abs(mix))) if n else 0.
    if peak > MIX_PEAK:
        mix *= MIX_PEAK / peak
    if report is not None:
        under = active.any() and bed > 0
        # The music's level per 10 ms frame under the duck (constant within a frame), in pieces so a 20-minute
        # timeline is never copied whole as float64.
        energy = np.zeros(frames)
        for i in range(0, frames, 6000):
            piece = music[i * frame:min(frames, i + 6000) * frame].astype(np.float64)
            energy[i:i + 6000] = (piece.reshape(-1, frame, 2) ** 2).mean(axis=(1, 2))
        gain = bed * duck[:frames * frame:frame].astype(np.float64)
        m_rms = np.sqrt(energy * gain ** 2 + 1e-12) if frames else np.zeros(0)
        report.update({"lines": stats["lines"], "voice_clipped_samples": stats["clipped_samples"],
                       "voice_peak_dbfs": round(float(20 * np.log10(max(stats["peak"], 1e-9))), 1),
                       "mix_peak_dbfs": round(float(20 * np.log10(max(float(np.max(np.abs(mix))) if n else 0., 1e-9))), 1),
                       "voice_over_music_db": round(float(20 * np.log10(speaking / float(np.sqrt(np.mean(m_rms[active] ** 2))))), 1)
                       if under else None})
    return mix.astype(np.float32)


def _music(p):
    seconds = duration(p)
    count = round(seconds * SR)
    mix = np.zeros((count, 2), dtype=np.float32)
    rng = np.random.default_rng(7)
    beat, bar = 60 / p["bpm"], 240 / p["bpm"]
    mood = p["music"]["mood"]
    # Gain, drum density, chord brightness and key decay distinguish the moods.
    presets = {"energetic": (.65, 1, .055, 18), "calm": (.12, 4, .09, 3),
               "warm": (.28, 2, .075, 6), "dark": (.55, 2, .035, 10),
               "playful": (.38, 1, .04, 22)}
    kick_gain, stride, pad_gain, decay = presets[mood]

    def voice(start, length, sound, pan=0):
        offset = round(start * SR)
        t = np.arange(round(length * SR), dtype=np.float64) / SR
        samples = sound(t)
        left, right = max(0, offset), min(count, offset + len(t))
        if left < right:
            samples = samples[left - offset:right - offset]
            mix[left:right, 0] += samples * (1 - pan * .5)
            mix[left:right, 1] += samples * (1 + pan * .5)

    def kick(start, gain):
        def sound(t):
            phase = np.cumsum(48 + 140 * np.exp(-t * 35)) / SR
            return np.sin(2 * np.pi * phase) * np.exp(-t * 12) * gain
        voice(start, .35, sound)

    def key(start, frequency, pan):
        def sound(t):
            carrier = np.sin(2 * np.pi * frequency * t)
            if mood == "warm":
                carrier += .25 * np.sin(2 * np.pi * frequency * 3 * t) * np.exp(-t * 12)
            if mood == "playful":
                carrier += .3 * np.sin(2 * np.pi * frequency * 4 * t) * np.exp(-t * 30)
            return carrier * np.minimum(1, t / .006) * np.exp(-t * decay) * .10
        voice(start, beat * (1.7 if mood == "calm" else .85), sound, pan)

    chords = [[48, 52, 55], [45, 48, 52], [41, 45, 48]]
    mtof = lambda note: 440 * 2 ** ((note - 69) / 12)
    for b in range(int(np.ceil(seconds / bar))):
        chord = chords[(b // 2) % 3]
        if mood == "dark":
            chord = [chord[0] - 12, chord[0] + 3, chord[0] + 7]
        for n in range(4):
            start = b * bar + n * beat
            if start >= seconds:
                break
            if start > 0 and n % stride == 0:
                kick(start, kick_gain)
            if mood in ("energetic", "playful", "warm"):
                def hat(t):
                    noise = rng.uniform(-1, 1, len(t))
                    return np.diff(noise, prepend=0) * np.exp(-t * 70) * .07
                voice(start + beat / 2, .06, hat, .6 if n % 2 else -.6)
            f = mtof(chord[0] - 12)
            voice(start, beat * .85, lambda t: np.sin(2 * np.pi * f * t) * np.minimum(1, t / .008) * np.exp(-t * 6) * .25)
            if n % stride == 0:
                key(start + beat / 2, mtof(chord[n % 3] + 12), .4 if n % 2 else -.4)
        for index, note in enumerate(chord):
            f = mtof(note)
            def pad(t):
                env = np.minimum(1, t / .08) * np.clip((bar - t) / .16, 0, 1)
                duck = 1 - (.5 if mood == "energetic" else .15) * np.exp(-(t % beat) * 16)
                return (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * f * 1.003 * t)) * env * duck * pad_gain
            voice(b * bar, bar, pad, (index - 1) * .6)
    boundary = 0
    for b in p["beats"]:
        if boundary > 0 and b.get("transition", "cut") != "cut":
            def whoosh(t):
                x = t / .35
                noise = rng.uniform(-1, 1, len(t))
                # A moving average takes the edge off noise, as the starter's low-pass does.
                low = np.convolve(noise, np.ones(12) / 12, mode="same")
                return low * np.sin(np.pi * x) * x * .45
            voice(boundary - .35, .35, whoosh, .25)
            kick(boundary, .85)
        boundary += beat_seconds(b, p["bpm"])
    peak = float(np.max(np.abs(mix)))
    if peak:
        mix = np.tanh(mix * (1.1 / peak))
    # The fade in and out touch only the ends; a long video's whole timeline is never held as float64 times.
    head = min(count, int(.03 * SR) + 1)
    mix[:head] *= (np.arange(head) / SR / .03).astype(np.float32)[:, None]
    tail = min(count, int(1.5 * SR) + 1)
    times = (count - tail + np.arange(tail)) / SR
    mix[count - tail:] *= np.clip((seconds - times) / 1.5, 0, 1).astype(np.float32)[:, None]
    peak = float(np.max(np.abs(mix)))
    if peak:
        mix *= (10 ** (-1.5 / 20) / peak) * p["music"]["volume"]
    return mix.astype(np.float32)


# -- the Story Short's soundtrack ---------------------------------------------------------------------------------------

def _starts(p):
    out, at = [], 0.
    for b in p["beats"]:
        out.append(at)
        at += beat_seconds(b, p["bpm"])
    return out


def event_time(beat, start, ref):
    """When a story beat's {word: n} or {t: seconds} happens on the timeline (a word at its aligned start)."""
    if "t" in ref:
        return start + float(ref["t"])
    words = (beat.get("spoken") or {}).get("words")
    if words and ref["word"] < len(words):
        return start + words[ref["word"]][0] + ref.get("after", 0)
    # Before alignment: the words share the line by letters.
    from core.video_store import STORY_LEAD, clause_words
    said = clause_words(beat.get("say", ""))
    speech = (beat.get("spoken") or {}).get("seconds") or len(said) / 2.6
    total = sum(len(w) + 1 for w in said) or 1
    return start + STORY_LEAD + speech * sum(len(w) + 1 for w in said[:ref["word"]]) / total + ref.get("after", 0)


def piano(seconds, rng_seed=11):
    """A soft piano bed: plucked notes (a few decaying harmonics, a hammer click), a slow four-chord loop at 84 bpm."""
    count = round(seconds * SR)
    out = np.zeros(count, dtype=np.float64)
    beat = 60 / 84
    chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]]
    mtof = lambda n: 440 * 2 ** ((n - 69) / 12)

    def note(at, freq, gain):
        start = round(at * SR)
        length = min(count - start, round(2.6 * SR))
        if length <= 0:
            return
        t = np.arange(length) / SR
        tone = sum(np.sin(2 * np.pi * freq * k * t) * (.6 / k ** 1.4) * np.exp(-t * (1.6 + .9 * k)) for k in range(1, 6))
        tone += np.exp(-t * 90) * np.sin(2 * np.pi * freq * 7.1 * t) * .05
        out[start:start + length] += tone * np.minimum(1, t / .004) * gain
    for n in range(int(seconds / beat) + 1):
        chord = chords[(n // 4) % 4]
        at = n * beat
        if n % 4 == 0:
            note(at, mtof(chord[0] - 12), .55)
        note(at + (beat / 2 if n % 2 else 0), mtof(chord[(n * 3 + 1) % 4] + (12 if n % 8 > 4 else 0)), .3)
    return out.astype(np.float32)


def sfx(kind, rng):
    """One sound effect, synthesized (mono float32 at SR): every one is made here from noise and tones."""
    def noise(sec):
        return rng.uniform(-1, 1, round(sec * SR)).astype(np.float64)

    def low(x, k):
        return np.convolve(x, np.ones(k) / k, mode="same")
    t = lambda sec: np.arange(round(sec * SR)) / SR
    if kind == "boom":
        x = t(1.6)
        body = np.sin(2 * np.pi * np.cumsum(40 + 90 * np.exp(-x * 8)) / SR) * np.exp(-x * 2.6)
        crack = low(noise(1.6), 6) * np.exp(-x * 5) * .9 + low(noise(1.6), 40) * np.exp(-x * 1.4) * .8
        return (body * 1.1 + crack) * np.minimum(1, x / .003)
    if kind == "splat":
        x = t(.5)
        return low(noise(.5), 10) * np.exp(-x * 14) * 1.2 + np.sin(2 * np.pi * np.cumsum(180 - 120 * x) / SR) * np.exp(-x * 18) * .7
    if kind == "sting":
        x = t(1.4)
        return sum(np.sin(2 * np.pi * f * x) for f in (220, 261.6, 311.1, 370)) * np.exp(-x * 2.2) * .35 * np.minimum(1, x / .01)
    if kind == "riser":
        x = t(1.2)
        n = noise(1.2)
        return (n - low(n, 6 + (x[::-1] * 30).astype(int).clip(1).max())) * (x / 1.2) ** 2 * .9 + np.sin(2 * np.pi * np.cumsum(200 + 600 * x) / SR) * (x / 1.2) ** 3 * .3
    if kind == "pop":
        x = t(.18)
        return np.sin(2 * np.pi * np.cumsum(900 - 2600 * x) / SR) * np.exp(-x * 30)
    if kind == "whoosh":
        x = t(.7)
        return low(noise(.7), 14) * np.sin(np.pi * x / .7) ** 2 * 1.4
    if kind == "impact":
        x = t(.5)
        return np.sin(2 * np.pi * np.cumsum(70 + 60 * np.exp(-x * 30)) / SR) * np.exp(-x * 9) + low(noise(.5), 4) * np.exp(-x * 40) * .5
    if kind == "steps":
        out = np.zeros(round(1.3 * SR))
        for k in range(4):
            at, x = round(k * .3 * SR), t(.08)
            out[at:at + len(x)] += low(rng.uniform(-1, 1, len(x)), 5) * np.exp(-x * 60) * (1 if k % 2 else .8)
        return out
    if kind == "gasp":
        x = t(.55)
        n = noise(.55)
        breath = n - low(n, 3)
        return breath * np.sin(np.pi * np.clip(x / .55, 0, 1)) ** .7 * np.exp(-x * 2) * .9
    raise ValueError(f"No sound effect {kind}.")


def _rms_db(x):
    loud = x[np.abs(x) > np.abs(x).max() * .05] if len(x) and np.abs(x).max() > 0 else x
    return 20 * np.log10(float(np.sqrt(np.mean(loud ** 2))) + 1e-12) if len(loud) else -120.


def _story(p, report=None):
    """The Story Short's mix: dialogue at its median level, the piano bed under it (dipped in flashbacks), the effects."""
    from core import video_narration
    seconds = duration(p)
    count = round(seconds * SR)
    voice, stats = video_narration.track(p, SR)
    voice = np.pad(voice[:count], (0, max(0, count - len(voice))))
    starts = _starts(p)
    # The dialogue's median speaking level, from each line's own RMS.
    levels = []
    for b, at in zip(p["beats"], starts):
        if "say" in b and "spoken" in b:
            a = round((at + .06) * SR)
            piece = voice[a:a + round(b["spoken"]["seconds"] * SR)]
            if len(piece):
                levels.append(_rms_db(piece))
    gain = 10 ** ((STORY_VOICE_DB - float(np.median(levels))) / 20) if levels else 1.
    if stats["peak"] * gain > 10 ** (-1 / 20):
        gain = 10 ** (-1 / 20) / stats["peak"]
    voice = voice * gain
    mix = np.repeat(voice[:, None], 2, axis=1)
    volume = p["music"]["volume"]
    bed_level = None
    if volume > 0:
        bed = piano(seconds)
        bed *= 10 ** ((STORY_BED_DB + 20 * np.log10(volume / .7 if volume else 1) - _rms_db(bed)) / 20)
        dip = np.ones(count, dtype=np.float32)
        for b, at in zip(p["beats"], starts):
            if b.get("flashback"):
                a, z = round(at * SR), round((at + beat_seconds(b, p["bpm"])) * SR)
                dip[a:z] = 10 ** (STORY_DIP_DB / 20)
        k = int(.15 * SR)
        dip = np.convolve(np.pad(dip, (k, k), mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="same")[k:-k].astype(np.float32)
        tail = min(count, int(1.2 * SR))
        dip[count - tail:] *= np.linspace(1, 0, tail, dtype=np.float32)
        mix += (bed[:count] * dip[:len(bed[:count])])[:, None]
        bed_level = round(_rms_db(bed), 1)
    placed = []
    rng = np.random.default_rng(23)
    for b, at in zip(p["beats"], starts):
        for e in (b.get("story") or {}).get("sfx", []):
            sound = sfx(e["kind"], rng)
            sound *= 10 ** ((STORY_SFX_DB - _rms_db(sound)) / 20)
            when = event_time(b, at, e["at"]) - (1.1 if e["kind"] == "riser" else 0)
            a = max(0, round(when * SR))
            n = min(len(sound), count - a)
            if n > 0:
                pan = .15 if e["kind"] in ("steps", "whoosh") else 0
                mix[a:a + n, 0] += sound[:n] * (1 - pan)
                mix[a:a + n, 1] += sound[:n] * (1 + pan)
                placed.append(e["kind"])
    # A soft clip above -3 dBFS, then headroom under -1.5 dBFS.
    knee = 10 ** (-3 / 20)
    over = np.abs(mix) > knee
    mix[over] = np.sign(mix[over]) * (knee + (1 - knee) * np.tanh((np.abs(mix[over]) - knee) / (1 - knee)))
    peak = float(np.max(np.abs(mix))) if count else 0.
    if peak > MIX_PEAK:
        mix *= MIX_PEAK / peak
    if report is not None:
        speaking = np.abs(voice) > 1e-4
        report.update({"lines": stats["lines"], "voice_clipped_samples": stats["clipped_samples"], "format": "story-short",
                       "voice_median_db": round(STORY_VOICE_DB if levels else -120., 1), "bed_db": bed_level, "sfx": placed,
                       "voice_peak_dbfs": round(float(20 * np.log10(max(stats["peak"] * gain, 1e-9))), 1),
                       "mix_peak_dbfs": round(float(20 * np.log10(max(float(np.max(np.abs(mix))) if count else 0., 1e-9))), 1),
                       "voice_over_music_db": round(STORY_VOICE_DB - bed_level, 1) if bed_level is not None and speaking.any() else None})
    return mix.astype(np.float32)


def write_wav(path, project, report=None):
    """Write byte-identical stereo 48 kHz PCM for the same project."""
    samples = synthesize(project, report)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(np.rint(samples * 32767).astype("<i2").tobytes())
    return Path(path)
