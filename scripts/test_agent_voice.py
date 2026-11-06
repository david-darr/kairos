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
