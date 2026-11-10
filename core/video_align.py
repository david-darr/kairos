"""Word timings for narration captions (Content Studio Editor build spec, step 7).

Kokoro's ONNX model returns audio only (no durations), so a spoken line's words have no times of their own. This
finds them by forced alignment of the line's own cached WAV against its script, with the speech engine Kairos already
ships for dictation: whisper.cpp through pywhispercpp (core/speech.py), on this computer, with the ggml model the
person already downloaded in Settings > Speech. Nothing is installed or downloaded here.

How, part by part (each caption part is spoken on its own, so a part's first word starts with the part):
1. whisper.cpp transcribes the part with token timestamps, one word a segment (max_len 1, split on words). No prompt
   with the script: a prompt equal to the audio's words made whisper.cpp return nonsense times on a test line.
2. The heard words are matched to the script's words in order (difflib on letters and digits only, so "colour" and
   "color", "1,000" and "1000" match). Matched script words take the heard times; a run of unmatched words shares the
   time between its matched neighbours by letter count.
3. The audio decides the edges: a start inside quiet moves to where the voice begins; a boundary moves to a pause of
   at least PAUSE close by (whisper.cpp tends to start a word up to a few tenths of a second early, at the end of the
   word before), when the word after it still has voice; a word left under MIN_WORD shares its neighbour's stretch.
Measured on known narration (scripts/test_video_align.py, base.en): word starts 0.014 s off on average, 0.17 s at most.

Confidence is the share of script words that were heard (matched). Below CONFIDENT the line keeps line captions: a
word highlight that drifts is worse than none. The result is stored on the beat's `spoken` as `words` (one
[start, end] per script word, seconds from the beat's start, LEAD included) and `align` ({method, confidence}).
"""
from __future__ import annotations

import difflib
import os
import re

import numpy as np

CONFIDENT = .8              # the share of script words heard for word captions; below it the line keeps line captions
HOP = .01                   # the audio envelope's step, seconds
PAUSE = .05                 # the shortest quiet stretch counted as a pause between two words
MIN_WORD = .08              # a pause only moves a boundary when the word before it keeps at least this long
REACH_BACK, REACH_ON = .12, .4   # how far before and after whisper's boundary a pause is looked for
MODELS = ("base.en", "small.en", "tiny.en")   # base.en first: the app's default, and on test lines as close as small.en at 2.5x the speed
MODEL_DIR = None            # test override; normally core.speech.SPEECH_DIR


class AlignUnavailable(RuntimeError):
    """Message is meant for the person as-is."""


def words_of(text) -> list[str]:
    """The script's words as the captions show them: split on spaces, punctuation kept on the word."""
    return [w for w in str(text).split() if re.search(r"[\w]", w)]


def _norm(word) -> str:
    w = re.sub(r"[^a-z0-9]", "", word.lower())
    return {"colour": "color", "colours": "colors", "grey": "gray", "metre": "meter", "metres": "meters",
            "centre": "center", "favourite": "favorite"}.get(w, w)


def model_path():
    from core import speech
    folder = MODEL_DIR or speech.SPEECH_DIR
    for name in MODELS:
        path = os.path.join(folder, f"ggml-{name}.bin")
        if os.path.isfile(path):
            return name, path
    return None, None


def available() -> tuple[bool, str]:
    from core import speech
    if not speech.engine_available():
        return False, "speech recognition is not available in this build"
    name, _ = model_path()
    if not name:
        return False, "no speech model is downloaded (Settings > Speech)"
    return True, name


_models = {}


def _model(path):
    if path not in _models:
        from pywhispercpp.model import Model
        _models.clear()
        _models[path] = Model(path, redirect_whispercpp_logs_to=None, print_progress=False, language="en", no_context=True)
    return _models[path]


def _to16k(samples, rate):
    x = samples.astype(np.float32) / 32768.0 if samples.dtype != np.float32 else samples
    n = int(len(x) * 16000 / rate)
    return np.interp(np.linspace(0, len(x), n, endpoint=False), np.arange(len(x)), x).astype(np.float32)


def heard(samples, rate):
    """[(start, end, word)] whisper.cpp hears in the samples, seconds from the first sample."""
    from core import speech
    ok, why = available()
    if not ok:
        raise AlignUnavailable(f"Word captions need local speech recognition: {why}.")
    _, path = model_path()
    with speech.ENGINE_LOCK:
        segments = _model(path).transcribe(_to16k(samples, rate), token_timestamps=True, max_len=1, split_on_word=True)
    out = []
    for s in segments:
        text = (s.text or "").strip()
        if text and not text.startswith("[") and _norm(text):
            out.append((s.t0 / 100, s.t1 / 100, text))
    return out


def envelope(samples, rate):
    """Voiced or not, every HOP seconds: RMS over the frame above 8% of the line's loud level (its 95th percentile)."""
    x = samples.astype(np.float32) / 32768.0 if samples.dtype != np.float32 else samples
    hop = max(1, int(rate * HOP))
    count = len(x) // hop
    if not count:
        return np.zeros(0, bool)
    rms = np.sqrt((x[:count * hop].reshape(count, hop) ** 2).mean(axis=1))
    loud = np.percentile(rms[rms > 0], 95) if np.any(rms > 0) else 0
    return rms > max(1e-3, loud * .08)


def _pause_near(voiced, t):
    """(start, end) of the pause closest to boundary t, or None: a quiet run of at least PAUSE inside the reach."""
    lo, hi = max(0, int((t - REACH_BACK) / HOP)), min(len(voiced), int((t + REACH_ON) / HOP) + 1)
    best, run = None, None
    for i in range(lo, hi + 1):
        quiet = i < hi and not voiced[i]
        if quiet and run is None:
            run = i
        elif not quiet and run is not None:
            if (i - run) * HOP >= PAUSE - 1e-9:
                gap = (run * HOP, i * HOP)
                if best is None or abs(gap[1] - t) < abs(best[1] - t):
                    best = gap
            run = None
    return best


def align(script, samples, rate, heard_words=None):
    """{"words": [[start, end], ...] one per script word (seconds from the first sample), "confidence": 0..1}."""
    script_words = words_of(script)
    if not script_words:
        return {"words": [], "confidence": 0.}
    got = heard(samples, rate) if heard_words is None else heard_words
    a, b = [_norm(w) for w in script_words], [_norm(w) for _, _, w in got]
    times = [None] * len(a)
    for block in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            times[block.a + k] = [got[block.b + k][0], got[block.b + k][1]]
    matched = sum(t is not None for t in times)
    total = len(samples) / rate
    # Unmatched runs share the stretch between their matched neighbours by letter count.
    i = 0
    while i < len(a):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(a) and times[j] is None:
            j += 1
        lo = times[i - 1][1] if i else 0.
        hi = times[j][0] if j < len(a) else total
        letters = [max(1, len(x)) for x in a[i:j]]
        at, span = lo, max(0., hi - lo)
        for k, n in zip(range(i, j), letters):
            step = span * n / sum(letters)
            times[k] = [at, at + step]
            at += step
        i = j
    voiced = envelope(samples, rate)
    # Each word starts on speech (a start inside a quiet stretch moves to where the voice begins) ...
    for k, (start, end) in enumerate(times):
        lo, hi = int(start / HOP), max(int(start / HOP) + 1, int(np.ceil(end / HOP)))
        on = np.where(voiced[lo:hi])[0] if lo < len(voiced) else []
        if len(on):
            times[k][0] = (lo + on[0]) * HOP
    # ... then a boundary moves to a pause close by, when the pause leaves the word before it at least MIN_WORD.
    for k in range(1, len(times)):
        gap = _pause_near(voiced, times[k][0])
        # ... and the word after it still has voice after the pause (a line's trailing quiet is not a boundary).
        speaks = gap and voiced[int(gap[1] / HOP):max(int(gap[1] / HOP) + 1, int(np.ceil(times[k][1] / HOP)))].any()
        if gap and speaks and gap[0] >= times[k - 1][0] + MIN_WORD and (k + 1 == len(times) or gap[1] <= times[k + 1][0]):
            times[k - 1][1], times[k][0] = gap[0], gap[1]
    # A word squeezed under MIN_WORD (whisper.cpp gave it the quiet before it) shares its next word's stretch by letters.
    for k in range(len(times) - 1):
        if times[k][1] - times[k][0] < MIN_WORD and times[k + 1][1] - times[k][0] >= 2 * MIN_WORD:
            span, share = times[k + 1][1] - times[k][0], len(a[k]) / max(1, len(a[k]) + len(a[k + 1]))
            cut = times[k][0] + min(span - MIN_WORD, max(MIN_WORD, span * share))
            times[k][1], times[k + 1][0] = cut, cut
    for k, (start, end) in enumerate(times):
        if k and start < times[k - 1][1]:
            start = times[k - 1][1]
        end = max(end, start + HOP)
        if k + 1 < len(times):
            end = min(end, max(start + HOP, times[k + 1][0]))
        times[k] = [round(min(start, total), 3), round(min(end, total), 3)]
    return {"words": times, "confidence": round(matched / len(a), 3)}


def method() -> str:
    name, _ = model_path()
    return f"whisper.cpp {name}" if name else "whisper.cpp"


def align_parts(say, samples, rate, parts):
    """Each caption part on its own (core/video_narration.speak speaks every part separately and joins them with a
    pause): its words are aligned inside its own stretch of the line, so a part's first word starts with the part
    even where whisper.cpp would start it late. `parts` are [start, end, text] in seconds from the line's start."""
    words, heard_n, total = [], 0., 0
    for start, end, text in parts:
        piece = samples[int(start * rate):int(end * rate)]
        n = len(words_of(text))
        if not n:
            continue
        result = align(text, piece, rate)
        words += [[start + s, start + e] for s, e in result["words"]]
        heard_n += result["confidence"] * n
        total += n
    return {"words": words, "confidence": round(heard_n / total, 3) if total else 0.}


def for_beat(say, samples, rate, lead, parts=None):
    """The `words` and `align` fields for a narrated beat's `spoken`, from its own line audio (by caption part when
    the parts are given). Words only when the alignment is confident; `align` always says what happened, so the
    editor can say why a line keeps line captions."""
    try:
        usable = parts and sum(len(words_of(p[2])) for p in parts) == len(words_of(say))
        result = align_parts(say, samples, rate, parts) if usable else align(say, samples, rate)
    except AlignUnavailable as error:
        return {"align": {"method": "none", "confidence": 0., "note": str(error)[:200]}}
    out = {"align": {"method": method(), "confidence": float(result["confidence"])}}
    if result["confidence"] >= CONFIDENT and len(result["words"]) == len(words_of(say)):
        out["words"] = [[round(float(lead + s), 3), round(float(lead + e), 3)] for s, e in result["words"]]
    return out
