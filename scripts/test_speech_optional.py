"""Optional ONNX speech downloads (Smart Turn, Kokoro): catalog, gated downloads, fallbacks. No real models, no network."""
import asyncio
import hashlib
import io
import os
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-optional-speech-')
os.environ['JARVIS_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import httpx
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import call_voices, kokoro_voice, speech_optional, turn_detect

# No test here may reach the network (a pinned entry would otherwise really download). Every client
# refuses to connect unless a test hands it its own transport.
_RealAsyncClient = httpx.AsyncClient


def _no_network(request):
    raise AssertionError(f"test tried to reach the network: {request.url}")


def _guarded_client(**kw):
    kw.setdefault("transport", httpx.MockTransport(_no_network))
    return _RealAsyncClient(**kw)


_network_guard = patch.object(httpx, "AsyncClient", _guarded_client)


def setUpModule():
    _network_guard.start()


def tearDownModule():
    _network_guard.stop()
from core.middleware import require_admin, require_user
from routes.speech_routes import router


def wav(seconds=1.0, rate=16000):
    samples = (np.sin(np.arange(int(rate * seconds)) * 2 * np.pi * 200 / rate) * 8000).astype('<i2')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())
    return buffer.getvalue()


class FakeSession:
    """Stands in for onnxruntime.InferenceSession: records the tensor it was given, answers a fixed probability."""
    def __init__(self, value):
        self.value, self.seen = value, []

    def get_inputs(self):
        return [type('Input', (), {'name': 'input_features'})()]

    def run(self, outputs, feed):
        self.seen.append(feed['input_features'])
        return [np.array([[self.value]], dtype=np.float32)]


class FakeKokoro:
    def __init__(self, model, voices):
        self.paths = (model, voices)

    def get_voices(self):
        return ['bf_emma', 'af_heart']

    def create(self, text, voice, speed, lang):
        return np.full(2400 + len(text), .25, dtype=np.float32), 24000


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        patches = [patch.object(speech_optional, 'OPTIONAL_DIR', self.dir.name),
                   patch.object(call_voices, 'SETTINGS', os.path.join(self.dir.name, 'voice.json')),
                   patch.object(turn_detect, 'SESSION_FACTORY', None), patch.object(kokoro_voice, 'ENGINE_FACTORY', None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        speech_optional._progress.clear()
        turn_detect.reset()
        kokoro_voice.reset()
        self.addCleanup(self.dir.cleanup)
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_user] = lambda: 'david'
        app.dependency_overrides[require_admin] = lambda: 'david'
        self.client = TestClient(app)

    def install(self, name):
        for spec in speech_optional.entry(name)['files']:
            Path(self.dir.name, spec['file']).write_bytes(b'x')


class Catalog(Base):
    def test_entries_are_well_formed(self):
        names = [item['name'] for item in speech_optional.CATALOG]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(names), {'smart-turn', 'kokoro'})
        for item in speech_optional.CATALOG:
            self.assertTrue(item['label'] and item['description'] and item['needs'] and item['files'])
            files = [spec['file'] for spec in item['files']]
            self.assertEqual(len(files), len(set(files)))
            for spec in item['files']:
                self.assertRegex(spec['file'], r'^[a-z0-9.\-]+$')       # a bare filename, never a path
                self.assertGreater(spec['size_mb'], 0)
                # Pinned means https URL + 64-hex SHA-256 together; a half-filled entry is a bug.
                self.assertEqual(spec['url'] is None, spec['sha256'] is None)
                if spec['url'] is not None:
                    self.assertTrue(spec['url'].startswith('https://'))
                    self.assertRegex(spec['sha256'], r'^[0-9a-f]{64}$')

    def test_unpinned_entries_refuse_before_any_network_call(self):
        async def go():
            with patch.object(speech_optional.httpx, 'AsyncClient', side_effect=AssertionError('network touched')):
                for item in speech_optional.CATALOG:
                    if speech_optional.is_pinned(item):
                        continue
                    with self.assertRaisesRegex(ValueError, 'not pinned'):
                        speech_optional.start_download(item['name'])
        asyncio.run(go())
        with self.assertRaises(ValueError):
            speech_optional.start_download('nope')

    def test_half_pinned_is_not_pinned(self):
        item = {'files': [{'url': 'https://x/a', 'sha256': 'a' * 64}, {'url': 'https://x/b', 'sha256': None}]}
        self.assertFalse(speech_optional.is_pinned(item))
        item['files'][1]['sha256'] = 'G' * 64
        self.assertFalse(speech_optional.is_pinned(item))
        item['files'][1].update(sha256='b' * 64, url='http://x/b')
        self.assertFalse(speech_optional.is_pinned(item))

    def test_download_verifies_the_pinned_hash(self):
        good = b'onnx-bytes' * 1000
        entry = {'name': 'fake', 'label': 'Fake', 'kind': 'turn', 'needs': [], 'description': 'd',
                 'files': [{'file': 'fake.onnx', 'size_mb': 1, 'url': 'https://example.test/fake.onnx', 'sha256': hashlib.sha256(good).hexdigest()}]}
        real = _RealAsyncClient

        def run(payload):
            def handler(request):
                return httpx.Response(200, content=payload)

            async def go():
                with patch.object(speech_optional, 'CATALOG', [entry]), \
                        patch.object(speech_optional.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handler), **kw)):
                    speech_optional.start_download('fake')
                    await asyncio.sleep(0.3)
                    return speech_optional.get_progress('fake')
            return asyncio.run(go())

        done = run(good)
        self.assertEqual(done['status'], 'done')
        self.assertEqual(Path(self.dir.name, 'fake.onnx').read_bytes(), good)
        Path(self.dir.name, 'fake.onnx').unlink()
        bad = run(b'tampered')
        self.assertEqual(bad['status'], 'error')
        self.assertIn('SHA-256', bad['error'])
        self.assertFalse(Path(self.dir.name, 'fake.onnx').exists())
        self.assertFalse(Path(self.dir.name, 'fake.onnx.part').exists())

    def test_state_is_honest(self):
        # Kokoro was pinned on 2026-11-07 to its official release files; an entry with no pin still never downloads.
        self.assertTrue(speech_optional.is_pinned(speech_optional.entry('kokoro')), 'Kokoro is pinned to its official files')
        with patch.dict(speech_optional.entry('kokoro')['files'][0], {'sha256': None}):
            self.assertEqual(speech_optional.state('kokoro')['state'], 'not_pinned')
        self.assertTrue(speech_optional.is_pinned(speech_optional.item('smart-turn')) if hasattr(speech_optional, 'item') else True)
        self.assertEqual(speech_optional.state('smart-turn')['state'], 'not_downloaded', 'Smart Turn is pinned to its official file')
        with patch.object(speech_optional, 'is_pinned', return_value=True):
            self.assertEqual(speech_optional.state('smart-turn')['status'], 'Not downloaded')
            self.install('smart-turn')
            with patch.object(speech_optional, 'module_available', return_value=False):
                s = speech_optional.state('smart-turn')
                self.assertEqual((s['state'], s['status'], s['ready']), ('needs_runtime', 'Needs the ONNX runtime', False))
            with patch.object(speech_optional, 'module_available', return_value=True):
                self.assertTrue(speech_optional.state('smart-turn')['ready'])
            self.install('kokoro')
            with patch.object(speech_optional, 'module_available', side_effect=lambda m: m == 'onnxruntime'):
                s = speech_optional.state('kokoro')
                self.assertEqual(s['status'], "Needs the misaki phonemizer, spaCy, spaCy's English model and num2words")
                self.assertEqual(s['missing_runtime_text'], "the misaki phonemizer, spaCy, spaCy's English model and num2words")
            # Licence-clean (David, 2026-11-10): Kokoro no longer needs the GPL kokoro_onnx/phonemizer/espeak packages.
            self.assertNotIn('kokoro_onnx', speech_optional.entry('kokoro')['needs'])
            self.assertFalse({'phonemizer', 'espeakng_loader'} & set(speech_optional.entry('kokoro')['needs']))
            with patch.object(speech_optional, 'module_available', side_effect=lambda m: m not in ('kokoro_onnx', 'phonemizer', 'espeakng_loader')):
                self.assertTrue(speech_optional.state('kokoro')['ready'], 'Kokoro is ready with only the model download')

    def test_remove_deletes_files_and_cached_sessions(self):
        self.install('smart-turn')
        turn_detect.SESSION_FACTORY = lambda path: FakeSession(.9)
        turn_detect._get_session()
        speech_optional.remove('smart-turn')
        self.assertFalse(speech_optional.downloaded('smart-turn'))
        self.assertIsNone(turn_detect._session)


class SmartTurn(Base):
    def test_features_have_the_models_shape(self):
        for seconds in (0.5, 3, 12):
            f = turn_detect.features(np.sin(np.arange(int(16000 * seconds)) / 9).astype(np.float32) * .3)
            self.assertEqual(f.shape, (1, 80, 800))
            self.assertEqual(f.dtype, np.float32)
            self.assertTrue(np.isfinite(f).all())
        filters = turn_detect._mel_filters()
        self.assertEqual(filters.shape, (80, 201))
        self.assertTrue((filters >= 0).all() and (filters.sum(axis=1) > 0).all())

    def test_unavailable_without_runtime_or_model(self):
        ok, reason = turn_detect.ready()
        self.assertFalse(ok)
        self.assertTrue(reason)
        with self.assertRaises(turn_detect.TurnUnavailable):
            turn_detect.predict(wav())
        self.install('smart-turn')
        with patch.object(speech_optional, 'module_available', return_value=False):
            self.assertEqual(turn_detect.ready(), (False, 'Needs the ONNX runtime'))

    def test_complete_and_incomplete_from_the_probability(self):
        self.install('smart-turn')
        for value, complete in ((.93, True), (.5, True), (.12, False)):
            turn_detect.reset()
            session = FakeSession(value)
            turn_detect.SESSION_FACTORY = lambda path, s=session: s
            result = turn_detect.predict(wav(1.2))
            self.assertEqual(result['complete'], complete)
            self.assertAlmostEqual(result['probability'], value, places=3)
            self.assertEqual(session.seen[0].shape, (1, 80, 800))

    def test_a_blip_is_never_a_finished_sentence(self):
        self.install('smart-turn')
        turn_detect.SESSION_FACTORY = lambda path: FakeSession(.99)
        self.assertEqual(turn_detect.predict(wav(0.05)), {'complete': False, 'probability': 0.0})

    def test_inference_failure_is_unavailable_not_a_crash(self):
        self.install('smart-turn')

        class Broken(FakeSession):
            def run(self, *a):
                raise RuntimeError('onnx exploded')
        turn_detect.SESSION_FACTORY = lambda path: Broken(0)
        with self.assertRaises(turn_detect.TurnUnavailable):
            turn_detect.predict(wav())

    def test_route_falls_back_and_decides(self):
        post = lambda body: self.client.post('/api/speech/turn', files={'audio': ('t.wav', body, 'audio/wav')})
        r = post(wav()).json()
        self.assertFalse(r['available'])
        self.assertIsNone(r['probability'])
        self.assertTrue(r['reason'])
        self.install('smart-turn')
        turn_detect.SESSION_FACTORY = lambda path: FakeSession(.2)
        r = post(wav()).json()
        self.assertEqual((r['available'], r['complete']), (True, False))
        turn_detect.reset()
        turn_detect.SESSION_FACTORY = lambda path: FakeSession(.8)
        r = post(wav()).json()
        self.assertEqual((r['available'], r['complete']), (True, True))
        self.assertEqual(post(b'junk').status_code, 422)

    def test_status_lists_optional_downloads_and_never_downloads(self):
        body = self.client.get('/api/speech/status').json()
        self.assertEqual({o['name'] for o in body['optional']}, {'smart-turn', 'kokoro'})
        self.assertFalse(body['turn_detect']['ready'])
        self.assertFalse(any(Path(self.dir.name).iterdir()))
        # An unpinned entry is refused before any network call (Kokoro, pinned since 2026-11-07, stands in unpinned).
        with patch.dict(speech_optional.entry('kokoro')['files'][0], {'sha256': None}):
            response = self.client.post('/api/speech/optional/kokoro/download')
        self.assertEqual(response.status_code, 400)
        self.assertIn('not pinned', response.json()['detail'])
        self.assertEqual(self.client.post('/api/speech/optional/nope/download').status_code, 400)
        self.install('smart-turn')
        self.assertEqual(self.client.delete('/api/speech/optional/smart-turn').status_code, 200)
        self.assertFalse(speech_optional.downloaded('smart-turn'))


class KokoroEngine(Base):
    def test_unavailable_engine_reports_why_and_never_crashes(self):
        ok, reason = kokoro_voice.ready()
        self.assertFalse(ok)
        self.assertTrue(reason)
        self.assertEqual(kokoro_voice.voices(), [])
        with self.assertRaises(kokoro_voice.KokoroUnavailable):
            kokoro_voice.synthesize('Hello there.', 'af_heart')
        with self.assertRaisesRegex(ValueError, 'not ready'):
            call_voices.configure('', 'kokoro')
        self.install('kokoro')
        with patch.object(speech_optional, 'module_available', return_value=False):
            self.assertEqual(kokoro_voice.ready()[1], "Needs the ONNX runtime, the misaki phonemizer, spaCy, spaCy's English model and num2words")

    def test_catalog_falls_back_to_no_voices_with_a_reason(self):
        from core.atomic_io import write_json_atomic
        write_json_atomic(str(call_voices.settings_file()), {'url': call_voices.KOKORO_URL, 'protocol': 'kokoro'})
        data = asyncio.run(call_voices.catalog())
        self.assertEqual((data['voices'], data['models']), ([], []))
        self.assertIn('device voice', data['error'])

        async def collect():
            return [item async for item in call_voices.pcm('Hello.', 'kokoro', 'af_heart')]
        with self.assertRaises(ValueError):
            asyncio.run(collect())

    def test_synthesis_with_a_fake_engine(self):
        self.install('kokoro')
        kokoro_voice.ENGINE_FACTORY = FakeKokoro
        self.assertEqual(kokoro_voice.ready(), (True, None))
        config = call_voices.configure('', 'kokoro')
        self.assertEqual(config['protocol'], 'kokoro')
        self.assertTrue(config['url'])      # voice notes only check that an engine url is set
        data = asyncio.run(call_voices.catalog())
        self.assertEqual([v['id'] for v in data['voices']], ['af_heart', 'bf_emma'])
        self.assertEqual(data['models'], ['kokoro'])
        self.assertNotIn('error', data)

        async def collect():
            return [item async for item in call_voices.pcm('One sentence.', 'kokoro', 'af_heart')]
        events = asyncio.run(collect())
        self.assertEqual(events[0], {'sample_rate': 24000})
        audio = b''.join(item['audio'] for item in events[1:])
        self.assertEqual(len(audio), 2 * (2400 + len('One sentence.')))
        self.assertTrue(all(len(item['audio']) <= 4800 for item in events[1:]))
        self.assertEqual(int(np.frombuffer(audio[:2], dtype='<i2')[0]), int(.25 * 32767))

    def test_a_failing_engine_is_unavailable_not_a_crash(self):
        self.install('kokoro')

        class Bad(FakeKokoro):
            def create(self, *a, **k):
                raise RuntimeError('espeak missing')
        kokoro_voice.ENGINE_FACTORY = Bad
        with self.assertRaises(kokoro_voice.KokoroUnavailable):
            kokoro_voice.synthesize('Hi.', 'af_heart')


class WarmAtCallStart(Base):
    """A call start loads and runs the optional models once, so the first turn does not pay their cold start."""

    def test_warm_is_a_no_op_when_not_set_up(self):
        self.assertFalse(turn_detect.warm())
        self.assertFalse(kokoro_voice.warm())

    def test_warm_runs_each_model_once(self):
        self.install('smart-turn')
        self.install('kokoro')
        session = FakeSession(.9)
        turn_detect.SESSION_FACTORY = lambda path: session
        made = []

        class Counting(FakeKokoro):
            def create(self, text, voice, speed, lang):
                made.append((text, voice))
                return super().create(text, voice, speed, lang)
        kokoro_voice.ENGINE_FACTORY = Counting
        self.assertTrue(turn_detect.warm())
        self.assertEqual(len(session.seen), 1)
        self.assertTrue(kokoro_voice.warm())
        self.assertEqual(made, [('Okay.', kokoro_voice.DEFAULT_VOICE)])

    def test_warm_failures_never_raise(self):
        self.install('smart-turn')

        class Broken(FakeSession):
            def run(self, *a):
                raise RuntimeError('onnx exploded')
        turn_detect.SESSION_FACTORY = lambda path: Broken(0)
        self.assertFalse(turn_detect.warm())

    def test_kokoro_is_warmed_only_when_it_is_the_call_voice(self):
        from routes import speech_routes
        self.install('kokoro')
        made = []

        class Counting(FakeKokoro):
            def create(self, *a, **k):
                made.append(1)
                return super().create(*a, **k)
        kokoro_voice.ENGINE_FACTORY = Counting
        speech_routes._warm_optional()
        self.assertEqual(made, [], 'the device voice or a voice server is in use: Kokoro stays unloaded')
        call_voices.configure('', 'kokoro')
        speech_routes._warm_optional()
        self.assertEqual(made, [1])

    def test_a_call_start_warms_in_the_background_and_dictation_does_not(self):
        from routes import speech_routes
        calls = []
        with patch.object(speech_routes, '_warm_optional', lambda: calls.append('warm')), \
                patch.object(speech_routes.speech, 'prepare_call', lambda model, backend: {'engine': 'cpu'}), \
                patch.object(speech_routes.speech, 'prepare', lambda model: model):
            self.assertEqual(self.client.post('/api/speech/prepare', json={'model': 'small.en'}).status_code, 200)
            self.assertEqual(calls, [])
            self.assertEqual(self.client.post('/api/speech/prepare', json={'model': 'small.en', 'backend': 'auto'}).status_code, 200)
            for _ in range(50):
                if calls:
                    break
                time.sleep(.02)
            self.assertEqual(calls, ['warm'])


if __name__ == '__main__':
    unittest.main()
