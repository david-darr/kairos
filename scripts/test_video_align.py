"""Word timings for captions (Content Studio Editor step 7, core/video_align.py).

The matching and boundary maths are checked with heard words given directly (no model). The accuracy check needs
this computer's Kokoro voice and a whisper.cpp model (Settings > Speech); it is skipped without them. Its narration
has known word times: each word (or phrase) is spoken on its own by Kokoro and the pieces are joined with measured
gaps, so where every word starts is known exactly. Folders: KAIROS_TEST_KOKORO (default: the dev app's ONNX folder)
and KAIROS_TEST_WHISPER (default: the dev app's speech_models folder).

    .venv\\Scripts\\python.exe scripts\\test_video_align.py
"""
import json
import os
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="video-align-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
import numpy as np
from core import video_align

APPDATA = Path(os.environ.get("APPDATA", "")) / "JARVIS-dev" / "data" / "speech_models"
KOKORO = Path(os.environ.get("KAIROS_TEST_KOKORO") or APPDATA / "onnx")
WHISPER = Path(os.environ.get("KAIROS_TEST_WHISPER") or APPDATA)
RATE = 24000
REPORT = {}


def tone(seconds, freq=220.0, rate=RATE, level=.4):
    t = np.arange(int(seconds * rate)) / rate
    return (np.sin(2 * np.pi * freq * t) * level * 32767).astype("<i2")


def silence(seconds, rate=RATE):
    return np.zeros(int(seconds * rate), dtype="<i2")


class MatchingTests(unittest.TestCase):
    """No model: the heard words are given, the audio is tones and silences with known edges."""
    def test_words_split_and_normalise(self):
        self.assertEqual(video_align.words_of("Sunlight looks white, but - it holds every colour."), ["Sunlight", "looks", "white,", "but", "it", "holds", "every", "colour."])
        self.assertEqual(video_align._norm("Colour."), video_align._norm("color"))
        self.assertEqual(video_align._norm("1,000"), "1000")

    def test_boundaries_move_to_pauses_and_misses_are_shared(self):
        # Three words of sound with pauses between them; "heard" starts each word 0.2 s early, at the pause before it,
        # as whisper.cpp tends to, and misses the middle word.
        audio = np.concatenate([silence(.3), tone(.5), silence(.2), tone(.4), silence(.25), tone(.6), silence(.3)])
        heard = [(0.0, .9, "one"), (1.3, 2.25, "three")]
        out = video_align.align("One two three", audio, RATE, heard_words=heard)
        self.assertAlmostEqual(out["confidence"], 2 / 3, places=3)
        starts = [w[0] for w in out["words"]]
        self.assertAlmostEqual(starts[0], .3, delta=.02, msg=out)      # moved off the silence onto the voice
        self.assertAlmostEqual(starts[1], 1.0, delta=.02, msg=out)     # shared, then moved to the end of the pause
        self.assertAlmostEqual(starts[2], 1.65, delta=.02, msg=out)
        self.assertTrue(all(a[1] <= b[0] + 1e-9 for a, b in zip(out["words"], out["words"][1:])), "words never overlap")

    def test_low_confidence_keeps_line_captions(self):
        audio = np.concatenate([silence(.2), tone(1.0), silence(.2)])
        with unittest.mock.patch.object(video_align, "heard", return_value=[(.2, .7, "completely"), (.7, 1.2, "different")]):
            out = video_align.for_beat("Look up on a clear day.", audio, RATE, .25)
        self.assertNotIn("words", out)
        self.assertEqual(out["align"]["confidence"], 0)
        with unittest.mock.patch.object(video_align, "heard", side_effect=video_align.AlignUnavailable("Word captions need local speech recognition: no speech model is downloaded (Settings > Speech).")):
            out = video_align.for_beat("Look up.", audio, RATE, .25)
        self.assertEqual(out["align"]["method"], "none")
        self.assertIn("Settings > Speech", out["align"]["note"])


def _ready():
    from core import kokoro_voice, speech, speech_optional
    if not KOKORO.is_dir() or not any(WHISPER.glob("ggml-*.bin")) or not speech.engine_available():
        return False
    speech_optional.OPTIONAL_DIR = str(KOKORO)
    video_align.MODEL_DIR = str(WHISPER)
    return kokoro_voice.ready()[0]


@unittest.skipUnless(_ready(), "needs Kokoro and a whisper.cpp model on this computer")
class AccuracyTests(unittest.TestCase):
    """Known narration: the true word times are where each separately spoken piece was placed."""
    @staticmethod
    def speak(text):
        from core import kokoro_voice
        audio = np.frombuffer(kokoro_voice.synthesize(text, "af_heart"), dtype="<i2")
        level = np.abs(audio.astype(np.float32)) / 32768
        frames = np.array([level[i:i + 240].max() for i in range(0, len(level), 240)])
        on = np.where(frames > .02)[0]
        return audio[on[0] * 240:(on[-1] + 1) * 240]   # trimmed to the voice, so its start and end are the word's

    def build(self, pieces, seed):
        rng = np.random.default_rng(seed)
        chunks, truth, at = [silence(.3)], [], .3
        for piece in pieces:
            audio = self.speak(piece)
            truth.append((at, at + len(audio) / RATE, piece)); chunks.append(audio); at += len(audio) / RATE
            gap = int(rng.uniform(.04, .16) * RATE); chunks.append(silence(gap / RATE)); at += gap / RATE
        return np.concatenate(chunks), truth

    def test_word_starts_within_tolerance(self):
        words = "Rainbows appear when sunlight bends through falling drops of water and splits into seven bright colours".split()
        audio, truth = self.build(words, 3)
        out = video_align.align(" ".join(words), audio, RATE)
        self.assertEqual(out["confidence"], 1.0)
        start = np.array([w[0] - t[0] for w, t in zip(out["words"], truth)])
        end = np.array([w[1] - t[1] for w, t in zip(out["words"], truth)])
        REPORT["words"] = {"model": video_align.method(), "count": len(words), "start_mean": round(float(np.abs(start).mean()), 3),
                           "start_max": round(float(np.abs(start).max()), 3), "within_0.1": int((np.abs(start) <= .1).sum()),
                           "end_mean": round(float(np.abs(end).mean()), 3), "end_max": round(float(np.abs(end).max()), 3)}
        self.assertLessEqual(np.abs(start).mean(), .1, REPORT["words"])
        self.assertLessEqual(np.abs(start).max(), .25, REPORT["words"])
        self.assertGreaterEqual((np.abs(start) <= .1).mean(), .85, REPORT["words"])
        self.assertLessEqual(np.abs(end).mean(), .12, REPORT["words"])

    def test_phrases_spoken_naturally(self):
        phrases = ["The ocean covers", "most of our planet,", "yet we have mapped", "less of its floor", "than the surface of Mars."]
        audio, truth = self.build(phrases, 5)
        out = video_align.align(" ".join(phrases), audio, RATE)
        self.assertGreaterEqual(out["confidence"], .9)
        k, errors = 0, []
        for start, stop, phrase in truth:
            n = len(phrase.split())
            errors.append((out["words"][k][0] - start, out["words"][k + n - 1][1] - stop))
            # Inside a phrase the words keep their order, each at least 50 ms.
            self.assertTrue(all(out["words"][j][1] - out["words"][j][0] >= .05 for j in range(k, k + n)), out["words"][k:k + n])
            k += n
        REPORT["phrases"] = {"first_word_start_errors": [round(float(a), 3) for a, _ in errors], "last_word_end_errors": [round(float(b), 3) for _, b in errors]}
        self.assertTrue(all(abs(a) <= .1 for a, _ in errors), REPORT["phrases"])
        self.assertTrue(all(abs(b) <= .15 for _, b in errors), REPORT["phrases"])

    def test_a_whole_line_from_the_narration_step(self):
        from core import video_narration, video_store
        say = "Sunlight looks white, but it holds every colour. Air scatters the blue light most, so the whole sky glows blue."
        samples, parts = video_narration.speak(say, "af_heart")
        out = video_align.for_beat(say, samples, RATE, video_store.LEAD, parts)
        whole = video_align.for_beat(say, samples, RATE, video_store.LEAD)
        self.assertEqual(out["align"]["confidence"], 1.0, out)
        words = out["words"]
        self.assertEqual(len(words), len(video_align.words_of(say)))
        voiced = video_align.envelope(samples, RATE)
        for s, e in words:
            self.assertTrue(voiced[int((s - video_store.LEAD) / video_align.HOP):int((e - video_store.LEAD) / video_align.HOP) + 1].any(), (s, e))
        # The second sentence is its own caption part, spoken on its own after a pause: its first word starts where
        # the voice comes back in that part (Kokoro leaves a little quiet at the start of each part).
        second = len(video_align.words_of(parts[0][2]))
        hop = video_align.HOP
        onset = (int(parts[1][0] / hop) + int(np.argmax(voiced[int(parts[1][0] / hop):]))) * hop
        self.assertAlmostEqual(words[second][0], video_store.LEAD + onset, delta=.06, msg=(words[second], parts[1], onset))
        REPORT["line"] = {"second_sentence_start_error": round(words[second][0] - video_store.LEAD - onset, 3),
                          "same_without_parts": round(whole["words"][second][0] - video_store.LEAD - onset, 3)}


if __name__ == "__main__":
    try:
        outcome = unittest.main(exit=False).result
    finally:
        if REPORT:
            print("ALIGNMENT " + json.dumps(REPORT))
        fixture.cleanup()
    sys.exit(0 if outcome.wasSuccessful() else 1)
