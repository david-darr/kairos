"""Built-in speech calls and chat organization regressions; no live models."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-call-test-')
os.environ['JARVIS_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from core import agent_conversations
from core.middleware import require_admin, require_user
from routes.speech_routes import router
from services.agent_service import validate_avatar


class NativeCalls(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[require_admin] = lambda: 'david'
        self.app.dependency_overrides[require_user] = lambda: 'david'
        self.client = TestClient(self.app)

    def test_native_transcription_uses_local_engine(self):
        with patch('routes.speech_routes.speech.transcribe', return_value='Build a parkour level') as transcribe:
            response = self.client.post('/api/speech/transcribe', files={'audio': ('speech.wav', b'RIFFaudio', 'audio/wav')})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'text': 'Build a parkour level'})
            transcribe.assert_called_once_with(b'RIFFaudio')

    def test_native_missing_model_has_actionable_error(self):
        from core.speech import SpeechUnavailable
        with patch('routes.speech_routes.speech.transcribe', side_effect=SpeechUnavailable('No speech model is downloaded yet. Add one in Settings.')):
            response = self.client.post('/api/speech/transcribe', files={'audio': ('speech.wav', b'audio')})
            self.assertEqual(response.status_code, 422)
            self.assertIn('No speech model', response.json()['detail'])

    def test_size_limit_stops_before_engine(self):
        with patch('routes.speech_routes.speech.MAX_AUDIO_BYTES', 4), patch('routes.speech_routes.speech.transcribe') as transcribe:
            self.assertEqual(self.client.post('/api/speech/transcribe', files={'audio': ('speech.wav', b'12345')}).status_code, 413)
            transcribe.assert_not_called()

    def test_model_setup_is_explicit_and_admin_gated(self):
        with patch('routes.speech_routes.speech.status', return_value={'engine_available': True, 'active_model': None, 'models': []}), patch('routes.speech_routes.speech.start_download') as download:
            self.assertEqual(self.client.get('/api/speech/status').status_code, 200)
            download.assert_not_called()
            self.assertEqual(self.client.post('/api/speech/models/base.en/download').status_code, 200)
            download.assert_called_once_with('base.en')
            def forbidden(): raise HTTPException(403, 'Admin required')
            self.app.dependency_overrides[require_admin] = forbidden
            self.assertEqual(self.client.post('/api/speech/models/base.en/download').status_code, 403)
            self.assertEqual(download.call_count, 1)

    def test_external_server_setup_is_no_longer_exposed(self):
        self.assertEqual(self.client.get('/api/speech/calls/a1/config').status_code, 404)

    def test_call_model_selection_and_timings_reach_engine(self):
        with patch('routes.speech_routes.speech.transcribe', return_value='The full sentence') as transcribe:
            response = self.client.post('/api/speech/transcribe', data={'model': 'small.en'}, files={'audio': ('speech.wav', b'audio')})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['model'], 'small.en')
            self.assertIn('recognition_ms', response.json()['timings'])
            transcribe.assert_called_once_with(b'audio', model_name='small.en')
        with patch('routes.speech_routes.speech.prepare', return_value='small.en') as prepare:
            response = self.client.post('/api/speech/prepare', json={'model': 'small.en'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['model'], 'small.en')
            prepare.assert_called_once_with('small.en')

    def test_engine_uses_explicit_installed_model_and_rejects_paths(self):
        from core import speech
        with tempfile.TemporaryDirectory() as directory, patch.object(speech, 'SPEECH_DIR', directory), patch.object(speech, 'engine_available', return_value=True), patch.object(speech, '_load') as load:
            Path(speech.model_path('base.en')).write_bytes(b'base')
            Path(speech.model_path('small.en')).write_bytes(b'small')
            self.assertEqual(speech.prepare('small.en'), 'small.en')
            load.assert_called_once_with('small.en')
            self.assertEqual(speech.selected_model(), 'base.en', 'Existing dictation keeps its default')
            for invalid in ['../../outside', 'unoffered', 'tiny.en']:
                with self.subTest(invalid=invalid), self.assertRaises(speech.SpeechUnavailable): speech.selected_model(invalid)

    def test_recognition_keeps_status_and_chat_loop_responsive(self):
        import asyncio
        import threading
        import httpx
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        def recognize(data):
            started.set()
            release.wait(2)
            finished.set()
            return 'Ready'
        async def exercise():
            with patch('routes.speech_routes.speech.transcribe', side_effect=recognize), patch('routes.speech_routes.speech.status', return_value={'engine_available': True}):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as client:
                    task = asyncio.create_task(client.post('/api/speech/transcribe', files={'audio': ('test.wav', b'audio')}))
                    try:
                        self.assertTrue(await asyncio.to_thread(started.wait, 1))
                        self.assertEqual((await client.get('/api/speech/status')).status_code, 200)
                        self.assertFalse(finished.is_set(), 'The request loop must respond while recognition is still working')
                    finally:
                        release.set()
                        self.assertEqual((await task).status_code, 200)
        asyncio.run(exercise())

    def test_call_backend_and_fallback_are_visible_to_client(self):
        info = {'text': 'The complete sentence', 'model': 'small.en', 'engine': 'cpu', 'fallback': 'GPU unavailable'}
        with patch('routes.speech_routes.speech.transcribe_call', return_value=info) as recognize:
            response = self.client.post('/api/speech/transcribe', data={'model':'small.en','backend':'auto'}, files={'audio':('speech.wav', b'audio')})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['fallback'], 'GPU unavailable')
            recognize.assert_called_once_with(b'audio', 'small.en', 'auto')
        with patch('routes.speech_routes.speech.prepare_call', return_value={k:v for k,v in info.items() if k != 'text'}) as prepare:
            response = self.client.post('/api/speech/prepare', json={'model':'small.en','backend':'auto'})
            self.assertEqual(response.json()['engine'], 'cpu')
            prepare.assert_called_once_with('small.en', 'auto')
        self.assertEqual(self.client.post('/api/speech/transcribe', data={'backend':'auto'}, files={'audio':('speech.wav',b'audio')}).status_code, 422)
        self.assertEqual(self.client.post('/api/speech/prepare', json={'model':'small.en','backend':'remote'}).status_code, 422)

    def test_gpu_failure_preserves_small_model_on_cpu(self):
        from core import speech, speech_acceleration
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech_acceleration, 'status', return_value={'configured':True}), patch.object(speech_acceleration, 'prepare', side_effect=ValueError('No usable GPU')), patch.object(speech, 'prepare') as prepare:
            info = speech.prepare_call('small.en')
            self.assertEqual(info, {'model':'small.en','engine':'cpu','fallback':'No usable GPU'})
            prepare.assert_called_once_with('small.en')

    def test_gpu_runtime_registration_requires_admin_and_never_downloads(self):
        from core import speech_acceleration
        with patch.object(speech_acceleration, 'register', return_value={'configured':True}) as register:
            self.assertEqual(self.client.post('/api/speech/runtime', json={'folder':'C:/trusted/runtime'}).status_code, 200)
            register.assert_called_once_with('C:/trusted/runtime')
            def forbidden(): raise HTTPException(403, 'Admin required')
            self.app.dependency_overrides[require_admin] = forbidden
            self.assertEqual(self.client.post('/api/speech/runtime', json={'folder':'C:/trusted/runtime'}).status_code, 403)
            self.assertEqual(self.client.delete('/api/speech/runtime').status_code, 403)
            self.assertEqual(register.call_count, 1)

    @unittest.skipUnless(os.name == 'nt', 'Windows optional CUDA runtime')
    def test_changed_runtime_is_rejected_before_execution(self):
        from core import speech_acceleration as runtime
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime, 'CONFIG', Path(directory)/'runtime.json'):
            folder = Path(directory)/'cuda';folder.mkdir()
            (folder/'whisper-server.exe').write_bytes(b'test-executable')
            (folder/'ggml-cuda.dll').write_bytes(b'test-dll')
            self.assertTrue(runtime.register(str(folder))['configured'])
            (folder/'ggml-cuda.dll').write_bytes(b'changed')
            with patch.object(runtime.subprocess, 'Popen') as execute, self.assertRaisesRegex(ValueError, 'files changed'):
                runtime.prepare('small-model.bin')
            execute.assert_not_called()
            runtime.unregister()


    # ---- rolling transcription (Fluid Voice build order step 4): partial endpoint, lock rules, fallback ----
    @staticmethod
    def _wav(seconds=1.0):
        import io, wave
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as handle:
            handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(16000); handle.writeframes(bytes(int(16000 * seconds) * 2))
        return buffer.getvalue()

    def test_partial_returns_text_and_timed_segments_from_either_engine(self):
        from core import speech, speech_acceleration
        parts = [{'text': 'hello there', 'start_ms': 0, 'end_ms': 900}, {'text': '[BLANK_AUDIO]', 'start_ms': 900, 'end_ms': 1200}, {'text': 'how are', 'start_ms': 1200, 'end_ms': 2000}]
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech_acceleration, 'is_ready', return_value=True), \
                patch.object(speech_acceleration, 'transcribe_segments', return_value=('hello there [BLANK_AUDIO] how are', parts)) as gpu:
            body = self.client.post('/api/speech/partial', data={'model': 'small.en', 'backend': 'auto'}, files={'audio': ('p.wav', self._wav(), 'audio/wav')}).json()
        self.assertEqual(body['engine'], 'cuda'); self.assertEqual(body['text'], 'hello there how are')
        self.assertEqual([(x['text'], x['end_ms']) for x in body['segments']], [('hello there', 900), ('how are', 2000)], 'markers are dropped, timings kept')
        self.assertTrue(gpu.call_args.kwargs['timed'], 'the GPU server is asked for timed segments only for partials')
        self.assertIn('recognition_ms', body['timings'])
        class Piece:
            def __init__(self, text, t0, t1): self.text, self.t0, self.t1 = text, t0, t1
        class Engine:
            def transcribe(self, samples): return [Piece(' one two', 0, 80), Piece(' three', 80, 150)]
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech, 'prepare_call', return_value={'model': 'small.en', 'engine': 'cpu', 'fallback': None}), \
                patch.object(speech, 'engine_available', return_value=True), patch.object(speech, '_load', return_value=Engine()):
            body = self.client.post('/api/speech/partial', data={'model': 'small.en', 'backend': 'cpu'}, files={'audio': ('p.wav', self._wav(), 'audio/wav')}).json()
        self.assertEqual(body['engine'], 'cpu'); self.assertEqual(body['text'], 'one two three')
        self.assertEqual([x['end_ms'] for x in body['segments']], [800, 1500], 'whisper.cpp centiseconds become milliseconds')

    def test_cuda_requests_do_not_take_the_engine_lock_but_cpu_requests_do(self):
        import threading
        from core import speech, speech_acceleration
        inside, release = threading.Barrier(3, timeout=3), threading.Event()
        def gpu(audio, path, timed=True):
            inside.wait(); release.wait(3); return 'ok', []
        results = []
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech_acceleration, 'is_ready', return_value=True), patch.object(speech_acceleration, 'transcribe_segments', side_effect=gpu):
            with speech.ENGINE_LOCK:   # a CPU job (say dictation) is running: GPU calls must not wait for it
                threads = [threading.Thread(target=lambda: results.append(speech.transcribe_call(self._wav(), 'small.en', 'auto'))) for _ in range(2)]
                for thread in threads: thread.start()
                try:
                    inside.wait()   # both GPU requests are inside the server call at the same time, with the lock held elsewhere
                finally:
                    release.set()
                for thread in threads: thread.join(3)
        self.assertEqual([r['engine'] for r in results], ['cuda', 'cuda'])
        self.assertTrue(all(r['queue_ms'] < 500 for r in results))

        running, hold, order = threading.Event(), threading.Event(), []
        def cpu(audio, name):
            order.append('start'); running.set(); hold.wait(3); order.append('end'); return 'text', [{'text': 'text', 'start_ms': 0, 'end_ms': 1}]
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech, 'prepare_call', return_value={'model': 'small.en', 'engine': 'cpu', 'fallback': None}), \
                patch.object(speech, 'transcribe_segments', side_effect=cpu):
            first = threading.Thread(target=lambda: speech.transcribe_call(self._wav(), 'small.en', 'cpu')); first.start()
            self.assertTrue(running.wait(2))
            self.assertEqual(speech.transcribe_call(self._wav(), 'small.en', 'cpu', segments=True, blocking=False), {'text': '', 'busy': True}, 'a partial never queues behind a running CPU job')
            second = threading.Thread(target=lambda: order.append(speech.transcribe_call(self._wav(), 'small.en', 'cpu')['text'])); second.start()
            threading.Event().wait(.15)
            self.assertEqual(order, ['start'], 'a real (blocking) CPU request waits its turn')
            hold.set(); first.join(3); second.join(3)
            self.assertEqual(order[0:2], ['start', 'end']); self.assertEqual(order[-1], 'text')

    def test_gpu_failure_inside_a_partial_falls_back_to_cpu_without_losing_the_text(self):
        from core import speech, speech_acceleration
        class Piece:
            def __init__(self, text, t0, t1): self.text, self.t0, self.t1 = text, t0, t1
        class Engine:
            def transcribe(self, samples): return [Piece('on the cpu', 0, 100)]
        with patch.object(speech, 'selected_model', return_value='small.en'), patch.object(speech_acceleration, 'is_ready', return_value=True), \
                patch.object(speech_acceleration, 'transcribe_segments', side_effect=ValueError('GPU recognition stopped. Using built-in CPU recognition.')), \
                patch.object(speech, 'engine_available', return_value=True), patch.object(speech, '_load', return_value=Engine()):
            body = self.client.post('/api/speech/partial', data={'model': 'small.en', 'backend': 'auto'}, files={'audio': ('p.wav', self._wav(), 'audio/wav')}).json()
        self.assertEqual((body['text'], body['engine']), ('on the cpu', 'cpu')); self.assertIn('GPU recognition stopped', body['fallback'])

    def test_partial_validates_like_transcribe(self):
        self.assertEqual(self.client.post('/api/speech/partial', files={'audio': ('p.wav', b'x')}).status_code, 422, 'a model is required')
        self.assertEqual(self.client.post('/api/speech/partial', data={'model': 'small.en', 'backend': 'remote'}, files={'audio': ('p.wav', b'x')}).status_code, 422)
        with patch('routes.speech_routes.speech.MAX_AUDIO_BYTES', 4):
            self.assertEqual(self.client.post('/api/speech/partial', data={'model': 'small.en'}, files={'audio': ('p.wav', b'12345')}).status_code, 413)
        from core.speech import SpeechUnavailable
        with patch('routes.speech_routes.speech.transcribe_call', side_effect=SpeechUnavailable('Download the selected speech model before starting the call.')):
            response = self.client.post('/api/speech/partial', data={'model': 'small.en'}, files={'audio': ('p.wav', b'audio')})
        self.assertEqual(response.status_code, 422); self.assertIn('Download', response.json()['detail'])

    def test_final_transcription_is_unchanged_for_a_tail_only_clip(self):
        # The end-of-turn pass is the ordinary /transcribe call, just with less audio: same shape, no segments asked for.
        info = {'text': 'the tail', 'model': 'small.en', 'engine': 'cuda', 'fallback': None, 'queue_ms': 0}
        with patch('routes.speech_routes.speech.transcribe_call', return_value=info) as recognize:
            body = self.client.post('/api/speech/transcribe', data={'model': 'small.en', 'backend': 'auto'}, files={'audio': ('t.wav', b'tail')}).json()
        recognize.assert_called_once_with(b'tail', 'small.en', 'auto')
        self.assertEqual(body['text'], 'the tail'); self.assertNotIn('segments', body); self.assertNotIn('queue_ms', body)
        self.assertEqual(set(body['timings']), {'queue_ms', 'recognition_ms'})

    def test_gpu_runtime_ready_check_needs_no_lock_and_a_replaced_server_is_not_latched_failed(self):
        from core import speech_acceleration as runtime
        with patch.object(runtime, '_read', return_value=None):
            self.assertFalse(runtime.is_ready('m.bin'))
        class Live:
            def poll(self): return None
        with patch.object(runtime, '_read', return_value={'folder': 'x'}), patch.object(runtime, '_process', Live()), patch.object(runtime, '_model', 'm.bin'), patch.object(runtime, '_port', 1234), patch.object(runtime, '_failed', None):
            runtime._gpu.set()
            try:
                self.assertTrue(runtime.is_ready('m.bin')); self.assertFalse(runtime.is_ready('other.bin'))
            finally:
                runtime._gpu.clear()
        # A request that fails after the server was swapped out must not latch the NEW server as failed.
        with patch.object(runtime, 'is_ready', return_value=True), patch.object(runtime, '_port', 1111), patch.object(runtime, 'stop') as stop, patch.object(runtime.httpx, 'Client') as client:
            def fail(*a, **k):
                runtime._port = 2222   # another thread restarted the server on a new port while this was in flight
                raise OSError('connection reset')
            client.return_value.__enter__.return_value.post.side_effect = fail
            with self.assertRaises(ValueError):
                runtime.transcribe_segments(b'x', 'm.bin')
            stop.assert_not_called(); self.assertIsNone(runtime._failed)


class Organization(unittest.TestCase):
    def test_pins_unread_and_new_session_do_not_leak_between_users(self):
        Path(agent_conversations._file()).unlink(missing_ok=True)
        from core.session_manager import session_manager
        latest = {'id': 'one', 'updated_at': 10}
        messages = [{'role': 'user', 'content': 'Hi'}, {'role': 'assistant', 'content': 'Hello'}]
        with patch.object(session_manager, 'list_sessions', side_effect=lambda **kw: [latest]), patch.object(session_manager, 'get_session', side_effect=lambda ident: {'messages': messages}):
            agent_conversations.change('david', 'agent:a1', 'read', 2, 'one')
            agent_conversations.change('david', 'agent:a1', 'pin')
            messages.append({'role': 'assistant', 'content': 'New result', 'ts': 11})
            row = agent_conversations.agent_threads('david', [{'id': 'a1'}])['agents'][0]
            self.assertEqual(row['preview'], 'New result'); self.assertEqual(row['unread'], 1); self.assertTrue(row['pinned'])
            self.assertFalse(agent_conversations.agent_threads('other', [{'id': 'a1'}])['agents'][0]['pinned'])
            latest['id'] = 'two'
            messages[:] = [{'role': 'assistant', 'content': 'Different conversation'}]
            self.assertEqual(agent_conversations.agent_threads('david', [{'id': 'a1'}])['agents'][0]['unread'], 1)
            agent_conversations.change('david', 'agent:a1', 'read', 1, 'two')
            self.assertEqual(agent_conversations.agent_threads('david', [{'id': 'a1'}])['agents'][0]['unread'], 0)

    def test_avatar_v2_still_validates_as_ajar_and_rejects_bad_layers(self):
        # Kairos Mascot (2026-10-22): a v2 dot face is accepted and stored as Ajar.
        legacy = {'form': 'cloud', 'color': '#FA70AB', 'finish': 'plush', 'face': 'smile', 'accessory': 'flower'}
        self.assertEqual(validate_avatar(legacy, 'a1')['color'], '#D99A92')
        rich = {**legacy, 'version': 2, 'form': 'shield', 'style': 'folded', 'eyes': 'oval', 'mouth': 'none', 'accent': '#123abc', 'accessories': ['hat', 'glasses']}
        self.assertEqual(validate_avatar(rich, 'a1')['acc'], 'spectacles')
        for bad in [{'version': 3}, {'version': True}, {'eyes': 'javascript'}, {'mouth': 'angry'}, {'accessories': ['hat', 'hat']}, {'accessories': [{}]}, {'accessories': ['none']}, {'accent': 'red'}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError): validate_avatar({**rich, **bad})


if __name__ == '__main__': unittest.main()
