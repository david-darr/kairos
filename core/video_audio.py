"""Deterministic original music on the project's bar grid, with AAC headroom, and the narration mixed over it.

The starter's kick, high-pass hats, detuned chords and rising noise are mixed
in floating point before normalization, soft clipping and PCM conversion.

A narrated video (core/video_narration.py) puts the voice on top: the voice is levelled, the music sits under it and
ducks a further DUCK_DB while a line is spoken (the duck opens slightly before each line, since the whole timeline is
known), and the mix keeps headroom below -1 dBFS with no clipping. The encoder's loudness pass then brings the file to
-16 LUFS (core/ffmpeg_tools.LOUDNORM).
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


def synthesize(project, report=None):
    """Stereo float32 at 48 kHz. `report`, when given, is filled with the narration levels for the checks."""
    p = validate(project)
    music = _music(p)
    if not narrated(p):
        return music
    from core import video_narration
    voice, stats = video_narration.track(p, SR)
    return _mix(music, voice, stats, p["music"]["volume"], report)


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
