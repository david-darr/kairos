"""Mouth shapes timed from the narration (Video Styles unit 3): which of the six mouth shapes a speaking character
shows on each frame, measured from the spoken line's own audio.

Why the audio envelope and not the phoneme string. core/kokoro_g2p.py gives the phonemes Kokoro says, in order, but
not when: the Kokoro ONNX model has one output (`audio`, checked 2026-11-10), so there are no phoneme durations.
Spreading the phonemes evenly over the clip would drift off the voice within a sentence (pauses at commas, long
vowels, the model's own pacing). The envelope is measured from the exact samples that play in the video, so the lips
close when the voice stops and open when it is loud, every time. What the envelope cannot know is the exact vowel;
the shape within an open mouth is picked from the frame's spectrum against the rest of the line (its darkest third reads as O, its brightest quiet third as E) and noisy,
quiet frames (s, f, v, th) show the teeth (FV). Short silences inside speech close the lips (M/B/P).

The result is one character per frame at 30 fps from the start of the beat: X rest, A, E, O, M (M/B/P), F (F/V).
Deterministic: the same audio always gives the same string.
"""
from __future__ import annotations

import math

import numpy as np

FPS = 30
CODES = "XAEOMF"
SHAPES = {"X": "rest", "A": "A", "E": "E", "O": "O", "M": "MBP", "F": "FV"}
SILENT = .12        # below this share of the line's loud level a frame is silence
OPEN = .50          # above it the mouth is wide open
NOISY = .28         # zero-crossing rate (crossings per sample) of a fricative
LOW_CENTROID, HIGH_CENTROID = 900., 1900.   # Hz, the fallback split when a line has no voiced frame
CLOSE_GAP = 4       # a silence of at most this many frames inside speech closes the lips (M/B/P)


def _frames(samples: np.ndarray, rate: int):
    hop = rate / FPS
    count = int(math.ceil(len(samples) / hop))
    win = int(round(hop * 1.5))
    for i in range(count):
        mid = int(round((i + .5) * hop))
        lo, hi = max(0, mid - win // 2), min(len(samples), mid + win // 2)
        yield samples[lo:hi]


def shapes(samples: np.ndarray, rate: int = 24000) -> str:
    """One mouth code per 1/30 s frame of a mono line (int16 or float)."""
    x = samples.astype(np.float32)
    if np.issubdtype(samples.dtype, np.integer):
        x = x / 32768.0
    if not len(x):
        return ""
    feats = []
    for frame in _frames(x, rate):
        if len(frame) < 8:
            feats.append((0., 0., 0.))
            continue
        rms = float(np.sqrt(np.mean(frame ** 2)))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame).astype(np.int8)))))
        spectrum = np.abs(np.fft.rfft(frame * np.hanning(len(frame))))
        freqs = np.fft.rfftfreq(len(frame), 1 / rate)
        power = spectrum ** 2
        centroid = float((freqs * power).sum() / power.sum()) if power.sum() > 0 else 0.
        feats.append((rms, zcr, centroid))
    levels = np.array([f[0] for f in feats])
    loud = float(np.percentile(levels, 90)) if levels.max() > 0 else 0.
    if loud <= 1e-5:
        return "X" * len(feats)
    # The vowel split is relative to this voice and line: a fixed hertz cut showed nearly every frame of the Kokoro
    # voice as O (measured on the Pack A sample, 2026-11-10). The darkest third of voiced frames read as O, the
    # brightest third as E (or A when loud), the rest A.
    voiced = [c for (r, z, c) in feats if r / loud >= SILENT and not (z > NOISY and r / loud < OPEN)]
    low = max(LOW_CENTROID * .5, float(np.percentile(voiced, 33))) if voiced else LOW_CENTROID
    high = max(low + 1, float(np.percentile(voiced, 67))) if voiced else HIGH_CENTROID
    codes = []
    for rms, zcr, centroid in feats:
        e = rms / loud
        if e < SILENT:
            codes.append("X")
        elif zcr > NOISY and e < OPEN:
            codes.append("F")
        elif centroid < low:
            codes.append("O")
        elif e >= OPEN or centroid < high:
            codes.append("A")
        else:
            codes.append("E")
    # A short silence between two spoken frames is a closed mouth (a stop or a nasal), not a rest.
    i = 0
    while i < len(codes):
        if codes[i] == "X":
            j = i
            while j < len(codes) and codes[j] == "X":
                j += 1
            if i > 0 and j < len(codes) and j - i <= CLOSE_GAP:
                codes[i:j] = ["M"] * (j - i)
            i = j
        else:
            i += 1
    # Hold each open shape at least two frames so the mouth does not flicker.
    for i in range(1, len(codes) - 1):
        if codes[i] not in "XM" and codes[i - 1] == codes[i + 1] and codes[i] != codes[i - 1] and codes[i - 1] not in "XM":
            codes[i] = codes[i - 1]
    return "".join(codes)


def for_beat(samples: np.ndarray, lead: float, rate: int = 24000) -> str:
    """Codes from the start of the beat: rest during the lead, then the line's shapes, then rest to the end."""
    return "X" * int(round(lead * FPS)) + shapes(samples, rate) + "X"
