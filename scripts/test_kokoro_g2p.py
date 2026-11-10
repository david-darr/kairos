"""Kokoro without espeak: misaki phonemes (core/kokoro_g2p.py) driving the model (core/kokoro_engine.py).

No Kokoro model needed: the ONNX session is stood in for. The misaki tests run when misaki and spaCy's English model
are installed (they ship with the app) and are skipped otherwise.
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-kokoro-g2p-')
os.environ['JARVIS_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np
from core import kokoro_engine, kokoro_g2p, kokoro_voice, speech_optional
from core.kokoro_engine import SAMPLE_RATE, VOCAB, KokoroEngine, split_phonemes, trim

HAVE_MISAKI = not kokoro_g2p.missing()


class FakeInput:
    def __init__(self, name, type_):
        self.name, self.type = name, type_


class FakeSession:
    """Kokoro's graph inputs; renders 0.3 s of quiet, a tone as long as the tokens, then 0.7 s of quiet (the pad the
    real model leaves around speech)."""

    def __init__(self):
        self.runs = []

    def get_inputs(self):
        return [FakeInput('input_ids', 'tensor(int64)'), FakeInput('style', 'tensor(float)'), FakeInput('speed', 'tensor(float)')]

    def run(self, _outputs, inputs):
        self.runs.append(inputs)
        tokens = inputs['input_ids'][0]
        speech = np.sin(np.arange(len(tokens) * 1200) * 2 * np.pi * 220 / SAMPLE_RATE).astype(np.float32) * 0.3
        quiet = lambda s: np.random.default_rng(0).normal(0, 1e-4, int(s * SAMPLE_RATE)).astype(np.float32)
        return [np.concatenate([quiet(0.3), speech, quiet(0.7)])]


def voices_file(folder):
    path = os.path.join(folder, 'voices.bin')
    rows = np.arange(510, dtype=np.float32)[:, None, None] * np.ones((1, 1, 256), dtype=np.float32)
    with open(path, 'wb') as handle:
        np.savez(handle, af_heart=rows, bf_emma=rows + 1000)
    return path


class Vocabulary(unittest.TestCase):
    def test_vocab_is_kokoro_v1s(self):
        # sha256 of the 114-entry table in hexgrad/Kokoro-82M config.json (the same table kokoro-onnx 0.6.1 ships).
        digest = hashlib.sha256(json.dumps(VOCAB, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(len(VOCAB), 114)
        self.assertEqual(digest, '5977eee9e44024553a1511cbc7f2c9320fbd4f6409228bcab0b5d26922260beb')

    def test_no_gpl_package_is_imported(self):
        for module in ('kokoro_onnx', 'phonemizer', 'espeakng_loader'):
            for source in ('core/kokoro_engine.py', 'core/kokoro_g2p.py', 'core/kokoro_voice.py'):
                text = Path(__file__).resolve().parent.parent.joinpath(source).read_text(encoding='utf-8')
                self.assertNotRegex(text, rf'^\s*(from|import) {module}\b', f'{source} imports {module}')


class Guess(unittest.TestCase):
    def test_unknown_words_get_speakable_phonemes(self):
        for word in ('Zylbersztajn', 'Siobhan', 'Kokoro', 'blorptastic', 'Qwghlm', 'XKCD', 'Nguyen', "O'Shaughnessy"):
            ps = kokoro_g2p.guess(word)
            self.assertTrue(ps, word)
            self.assertTrue(all(c in VOCAB for c in ps), f'{word} -> {ps!r} has a symbol Kokoro cannot say')
        self.assertEqual(kokoro_g2p.guess('~'), '', 'a stray symbol is dropped, not spoken')
        self.assertEqual(kokoro_g2p.guess('Qwghlm')[:4], 'kjˈu', 'a word with no vowel is spelled')

    def test_fallback_seam_is_tried_first_and_cannot_crash(self):
        with patch.object(kokoro_g2p, 'FALLBACK', lambda word, british: 'tˈɛst'):
            self.assertEqual(kokoro_g2p._unknown('anything', False), 'tˈɛst')
        def broken(word, british):
            raise OSError('espeak-ng is not installed')
        with patch.object(kokoro_g2p, 'FALLBACK', broken):
            self.assertEqual(kokoro_g2p._unknown('Kokoro', False), kokoro_g2p.guess('Kokoro'))

    def test_written_forms_misaki_misreads_are_spelled_out(self):
        cases = {
            'Elm St. now.': 'Elm Street now.', 'St. Louis is big.': 'Saint Louis is big.', 'I live on 5th St.': 'I live on 5th Street.',
            'Lives on Elm St. He left.': 'Lives on Elm Street. He left.', 'between Nov. 12 and Dec. 3.': 'between November 12 and December 3.',
            'It ships in Dec. Then we rest.': 'It ships in December. Then we rest.', 'Mt. Fuji': 'Mount Fuji',
            'Acme Inc. makes them.': 'Acme Incorporated makes them.', '7 lbs, 1 lb and 3 oz.': '7 pounds, 1 pound and 3 ounces.',
            '10 km at 60 mph': '10 kilometers at 60 miles per hour', 'it took 3 min.': 'it took 3 minutes.',
            'Call 555-0123.': 'Call five five five, zero one two three.',
            'Or (415) 555-0199': 'Or four one five, five five five, zero one nine nine',
            'Dr. Smith at 10:30, in 2024-2025.': 'Dr. Smith at 10:30, in 2024-2025.',
        }
        for text, spoken in cases.items():
            self.assertEqual(kokoro_g2p.expand(text), spoken, text)

    def test_language_by_voice(self):
        self.assertEqual(kokoro_g2p.lang_for_voice('bf_emma'), 'en-gb')
        self.assertEqual(kokoro_g2p.lang_for_voice('bm_george'), 'en-gb')
        for voice in ('af_heart', 'am_adam', 'jf_alpha', '', None):
            self.assertEqual(kokoro_g2p.lang_for_voice(voice), 'en-us')


class Engine(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(dir=DATA.name)
        self.session = FakeSession()
        self.engine = KokoroEngine(self.session, voices_file(self.folder), phonemize=lambda text, lang: text)

    def test_feeds_the_model_like_kokoro(self):
        audio, rate = self.engine.create('hˈɛlO.', 'af_heart')
        self.assertEqual(rate, 24000)
        run = self.session.runs[0]
        self.assertEqual(run['input_ids'].tolist(), [[0, VOCAB['h'], VOCAB['ˈ'], VOCAB['ɛ'], VOCAB['l'], VOCAB['O'], VOCAB['.'], 0]])
        self.assertEqual(float(run['style'][0, 0]), 5.0, 'the style row is the phoneme count minus one')
        self.assertEqual(run['speed'].dtype, np.float32)

    def test_edge_silence_is_trimmed_to_a_short_margin(self):
        raw = self.session.run(None, {'input_ids': np.zeros((1, 8), dtype=np.int64)})[0]
        cut, head, tail = trim(raw)
        self.assertAlmostEqual(head / SAMPLE_RATE, 0.3 - kokoro_engine.LEAD_MARGIN, delta=0.011)
        self.assertAlmostEqual(tail / SAMPLE_RATE, 0.7 - kokoro_engine.TAIL_MARGIN, delta=0.011)
        self.assertEqual(len(cut), len(raw) - head - tail)
        self.assertEqual(trim(np.zeros(24000, dtype=np.float32))[1:], (0, 0), 'a silent clip is left alone')
        audio, _ = self.engine.create('hˈɛlO.', 'af_heart')
        self.assertLess(len(audio), len(raw) - 0.8 * SAMPLE_RATE)

    def test_long_text_is_cut_into_batches_the_model_takes(self):
        sentence = 'ðɪs ɪz ə lˈɔŋ sˈɛntəns, wɪð ə klˈɔz. '
        batches = split_phonemes(sentence * 30)
        self.assertGreater(len(batches), 1)
        self.assertTrue(all(len(b) <= 510 for b in batches))
        self.assertTrue(all(b.endswith('.') for b in batches[:-1]), 'cut at a sentence end when there is one')
        self.assertEqual(''.join(split_phonemes('a' * 1200)), 'a' * 1200, 'an unbroken run is sliced, never dropped')
        self.engine.create(sentence * 30, 'af_heart')
        self.assertEqual(len(self.session.runs), len(batches))

    def test_unknown_voice_and_empty_text_raise(self):
        with self.assertRaises(ValueError):
            self.engine.create('hˈɛlO', 'zz_nobody')
        with self.assertRaises(ValueError):
            self.engine.create('❓❓', 'af_heart')
        self.assertEqual(self.engine.get_voices(), ['af_heart', 'bf_emma'])


@unittest.skipUnless(HAVE_MISAKI, 'misaki and spaCy English model not installed')
class Misaki(unittest.TestCase):
    def test_sentences_become_kokoro_phonemes(self):
        ps = kokoro_g2p.phonemize('Sure thing.')
        self.assertEqual(ps, 'ʃˈʊɹ θˈɪŋ.')
        ps = kokoro_g2p.phonemize('It costs $1,249.99 on Tuesday, March 3rd at 4:30 p.m.')
        for spoken in ('θˈWzᵊnd', 'dˈɑləɹz', 'sˈɛnts', 'tˈuzdˌA', 'θˈɜɹd', 'θˈɜɹTi'):
            self.assertIn(spoken, ps)
        self.assertTrue(all(c in VOCAB for c in ps), ps)
        # Each of these lost words on misaki alone (measured 2026-11-10).
        self.assertIn('tˈɛn θˈɜɹTi', kokoro_g2p.phonemize('Dr. Smith moved it to 10:30.'), 'the colon does not cost the time')
        self.assertIn('stɹˈit', kokoro_g2p.phonemize('They live on Elm St. now.'))
        self.assertIn('nOvˈɛmbəɹ', kokoro_g2p.phonemize('It arrives Nov. 12.'))
        self.assertIn('ɪnkˈɔɹpəɹ', kokoro_g2p.phonemize('Made by Acme Inc.'))
        self.assertIn('zˈɪɹO wˈʌn tˈu θɹˈi', kokoro_g2p.phonemize('Call 555-0123 tomorrow.'))

    def test_an_unknown_word_does_not_cost_the_sentence(self):
        ps = kokoro_g2p.phonemize('Zylbersztajn met Siobhan at ten.')
        self.assertNotIn('❓', ps)
        self.assertIn('mˈɛt', ps)
        self.assertIn('tˈɛn.', ps)
        self.assertTrue(ps.startswith(kokoro_g2p.guess('Zylbersztajn')), ps)
        self.assertTrue(all(c in VOCAB for c in ps), ps)

    def test_british_voices_read_british(self):
        self.assertNotEqual(kokoro_g2p.phonemize('Water, tomato.', 'en-gb'), kokoro_g2p.phonemize('Water, tomato.', 'en-us'))
        self.assertIn('ɑː', kokoro_g2p.phonemize('Tomato.', 'en-gb'))

    def test_spacy_is_never_asked_to_download(self):
        import spacy.cli
        kokoro_g2p.reset()
        with patch.object(spacy.cli, 'download', side_effect=AssertionError('tried to download a spaCy model')):
            kokoro_g2p.phonemize('Hello.')
        with patch.object(kokoro_g2p, '_have', side_effect=lambda m: m != 'en_core_web_sm'):
            kokoro_g2p.reset()
            with self.assertRaisesRegex(RuntimeError, 'en_core_web_sm'):
                kokoro_g2p.phonemize('Hello.')
        kokoro_g2p.reset()

    def test_engine_speaks_through_misaki_without_kokoro_onnx(self):
        folder = tempfile.mkdtemp(dir=DATA.name)
        with patch.dict(sys.modules, {'kokoro_onnx': None, 'phonemizer': None, 'espeakng_loader': None}):
            session = FakeSession()
            engine = KokoroEngine(session, voices_file(folder))
            audio, rate = engine.create('Kokoro met Zylbersztajn.', 'bf_emma', lang='en-gb')
        self.assertEqual(rate, 24000)
        self.assertGreater(len(session.runs[0]['input_ids'][0]), 20)
        self.assertGreater(float(session.runs[0]['style'][0, 0]), 999, "the British voice's own style rows")


class Wiring(unittest.TestCase):
    """core/kokoro_voice.py opens this engine, and a phonemizer failure is not blamed on the graphics card."""

    def setUp(self):
        self.folder = tempfile.mkdtemp(dir=DATA.name)
        self.patches = [patch.object(speech_optional, 'OPTIONAL_DIR', self.folder), patch.object(kokoro_voice, 'ENGINE_FACTORY', None),
                        patch.object(speech_optional, 'module_available', return_value=True)]
        for p in self.patches:
            p.start()
        Path(self.folder, 'kokoro-model.onnx').write_bytes(b'')
        Path(self.folder, 'kokoro-voices.bin').write_bytes(Path(voices_file(self.folder)).read_bytes())
        kokoro_voice.reset(forget_failures=True)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        kokoro_voice.reset(forget_failures=True)

    def test_phonemizer_failure_does_not_give_up_on_directml(self):
        from core import onnx_providers as op
        with patch.object(op, 'available', return_value=[op.DML, op.CPU]), patch.object(op.sys, 'platform', 'win32'), \
                patch.object(kokoro_g2p, 'warm', side_effect=RuntimeError('no spaCy')):
            with self.assertRaises(kokoro_voice.KokoroUnavailable):
                kokoro_voice.synthesize('Hello.', 'af_heart')
        self.assertEqual(kokoro_voice._failed, {}, 'DirectML was not blamed')

    def test_british_voice_gets_british_rules(self):
        seen = []

        class Recorder:
            def get_voices(self):
                return ['bf_emma', 'af_heart']

            def create(self, text, voice, speed, lang):
                seen.append((voice, lang))
                return np.zeros(2400, dtype=np.float32), 24000
        with patch.object(kokoro_voice, '_open', return_value=Recorder()):
            kokoro_voice.synthesize('Hello.', 'bf_emma')
            kokoro_voice.synthesize('Hello.', 'af_heart')
        self.assertEqual(seen, [('bf_emma', 'en-gb'), ('af_heart', 'en-us')])


if __name__ == '__main__':
    unittest.main()
