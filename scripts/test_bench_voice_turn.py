"""The voice turn benchmark in CI-light mode (scripts/bench_voice_turn.py --light): fake speech-to-text and voice, synthetic
audio, the app's real endpoint, rolling transcript, chunker, acknowledgement and barge-in modules driven by node. It checks
that the plumbing and the arithmetic are right, not how fast this machine is. Run: python scripts/test_bench_voice_turn.py
"""
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bench_voice_turn as bench  # noqa: E402


class Arithmetic(unittest.TestCase):
    def test_percentiles(self):
        self.assertEqual(bench.percentile([10], 0.5), 10)
        self.assertEqual(bench.percentile([10, 20, 30, 40], 0.5), 25)
        self.assertAlmostEqual(bench.percentile(list(range(1, 101)), 0.95), 95.05)
        self.assertIsNone(bench.percentile([None, None], 0.5))
        self.assertEqual(bench.percentile([None, 5, 7], 0.5), 6)

    def test_word_error(self):
        self.assertEqual(bench.wer("call my sister", "Call my sister."), 0)
        self.assertAlmostEqual(bench.wer("call my sister", "call my brother"), 1 / 3)
        self.assertEqual(bench.wer("", "anything"), 0)

    def test_speech_edges(self):
        import numpy as np
        audio = np.zeros(16000, dtype=np.float32)
        audio[4000:8000] = 0.2
        first, last = bench.edges(audio)
        self.assertEqual((first, last), (4000, 8000))

    def test_fixtures_have_a_pause_and_known_edges(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            fixtures, barge = bench.build_fixtures(Path(folder))
            self.assertEqual([f["name"] for f in fixtures], [name for name, _ in bench.SPEECH])
            for fixture in fixtures:
                self.assertTrue(Path(fixture["wav"]).is_file())
                self.assertGreater(fixture["speech_end_sample"], 16000)
            self.assertEqual({b["name"] for b in barge}, {"interrupt", "nod"})


@unittest.skipUnless(shutil.which("node"), "node is needed to run the real browser modules")
class LightRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        args = bench.parser().parse_args(["--light"])
        args.repeats = 1
        cls.summaries, cls.text = bench.run(args)
        cls.slow, cls.fast = cls.summaries

    def test_the_endpoint_is_the_700_ms_silence_wait_from_the_audio(self):
        for summary in self.summaries:
            self.assertGreaterEqual(summary["endpoint_ms"]["p50"], 700)
            self.assertLess(summary["endpoint_ms"]["p95"], 730)

    def test_stages_are_in_order_and_the_fake_delays_show_up(self):
        for summary in self.summaries:
            stages = [summary[k]["p50"] for k in ("endpoint_ms", "transcript_final_ms", "first_token_ms", "first_sentence_ms", "first_audio_ms")]
            self.assertEqual(stages, sorted(stages))
            self.assertAlmostEqual(summary["stt_ms"]["p50"], 155, delta=60)            # the 150 ms fake recognizer
            self.assertAlmostEqual(summary["first_audio_ms"]["p50"] - summary["first_sentence_ms"]["p50"], 75, delta=50)   # 50 ms voice + 25 ms lead
        self.assertEqual(self.fast["wer"], 0)
        self.assertEqual(self.fast["splits"], 0, "the 0.6 s pause inside a sentence does not split the turn")
        self.assertEqual(self.fast["long_pause_splits"], self.fast["long_pause_n"], "a 1.0 s pause does split it (no Smart Turn here)")

    def test_only_the_slow_model_gets_an_acknowledgement_after_half_a_second(self):
        self.assertEqual(self.fast["filler"]["turns"], 0, "the first words arrive in time: no acknowledgement")
        self.assertEqual(self.slow["filler"]["turns"], self.slow["turns"])
        gap = self.slow["first_sound_ms"]["p50"] - self.slow["transcript_final_ms"]["p50"]
        self.assertAlmostEqual(gap, 500 + 25, delta=60, msg="the acknowledgement is heard half a second (plus the 25 ms lead) after the turn went out")
        self.assertLess(self.slow["first_sound_ms"]["p50"], self.slow["first_audio_ms"]["p50"])
        self.assertEqual(self.fast["first_sound_ms"]["p50"], self.fast["first_audio_ms"]["p50"])

    def test_barge_in_pauses_fast_and_a_nod_does_not_interrupt(self):
        for summary in self.summaries:
            barge = summary["barge"]
            self.assertLess(barge["stop_p50"], 200)
            self.assertEqual(barge["interrupts_heard"], barge["interrupt_n"])
            self.assertEqual(barge["nods_ignored"], barge["nod_n"])
            self.assertEqual(barge["nods_that_cut"], 0)
            self.assertGreater(barge["commit_p50"], barge["detect_p50"])

    def test_the_table_prints(self):
        self.assertIn("first audio (the answer)", self.text)
        self.assertIn("barge-in: voice starts to audio stops", self.text)


if __name__ == "__main__":
    unittest.main()
