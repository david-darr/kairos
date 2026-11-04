"""Deterministic original music on the project's bar grid, with AAC headroom.

The starter's kick, high-pass hats, detuned chords and rising noise are mixed
in floating point before normalization, soft clipping and PCM conversion.
"""
from pathlib import Path
import wave
import numpy as np
from core.video_store import duration, validate

SR = 48000


def synthesize(project):
    p = validate(project)
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
        boundary += b["bars"] * bar
    peak = float(np.max(np.abs(mix)))
    if peak:
        mix = np.tanh(mix * (1.1 / peak))
    times = np.arange(count) / SR
    fade = np.minimum(1, times / .03) * np.clip((seconds - times) / 1.5, 0, 1)
    mix *= fade[:, None]
    peak = float(np.max(np.abs(mix)))
    if peak:
        mix *= (10 ** (-1.5 / 20) / peak) * p["music"]["volume"]
    return mix.astype(np.float32)


def write_wav(path, project):
    """Write byte-identical stereo 48 kHz PCM for the same project."""
    samples = synthesize(project)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(np.rint(samples * 32767).astype("<i2").tobytes())
    return Path(path)
