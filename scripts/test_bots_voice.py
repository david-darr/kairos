"""Real routes, private files and speech block safety, without a voice server."""
import io
import os
from pathlib import Path
import sys
import unittest
import wave
from unittest.mock import patch

from test_data_support import TestDataDirectory
ENV = TestDataDirectory("kairos-voice-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_admin, require_user
from routes.bot_voice_routes import router
from services import bot_voice as voice


class VoiceTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_admin] = lambda: "alice"; app.dependency_overrides[require_user] = lambda: "alice"
        self.app = app
        self.client = TestClient(app)

    def test_chunks_and_private_blocks(self):
        text = 'Hello there. This is next! Then another? Final line.'
        self.assertEqual(voice.prepare(text)["blocks"], ['Hello there.', 'This is next! Then another?', 'Final line.'])
        for text in ('Here is sk-abcdefghijklmnop12345. Next.', 'password=hunter2', '-----BEGIN RSA PRIVATE KEY-----\nSECRET\nEND'):
            self.assertEqual(voice.prepare(text), {"blocks": [], "withheld": True})
            self.assertEqual(self.client.post('/api/bot-voice/speak/block', json={"text": text}).status_code, 422)
        self.assertTrue(all(len(block) <= 1500 for block in voice.prepare('Long ' * 900)['blocks']))

    def test_bounds_and_no_engine(self):
        self.assertEqual(self.client.post('/api/bot-voice/x/notes', json={"text": 'x'*1001}).status_code, 422)
        self.assertEqual(self.client.post('/api/bot-voice/speak/block', json={"text": '   '}).status_code, 422)
        with patch('services.agent_service.agent_service.get', return_value={"id": "x"}), patch.object(voice.call_voices, 'configuration', return_value={"url": ""}):
            response = self.client.post('/api/bot-voice/x/notes', json={"text": 'Hello'})
            self.assertEqual(response.status_code, 409)
            self.assertIn('local voice engine', response.text)

    def test_live_settings_are_bounded_and_per_person(self):
        url = '/api/bot-voice/live-settings'
        for bad in ({"idle_minutes": 0}, {"idle_minutes": 61}, {"idle_minutes": True}, {"read_typed": 1}, {"voice": "bogus"}, {"extra": 1}):
            self.assertEqual(self.client.put(url, json=bad).status_code, 422)
        self.assertEqual(self.client.put(url, json={"voice": "cedar", "read_typed": True, "idle_minutes": 12}).status_code, 200)
        self.assertEqual(self.client.get(url).json()['idle_minutes'], 12)
        self.assertEqual(voice.live_settings('bob')['idle_minutes'], 5)

    def test_block_stream_uses_the_adapter_and_no_engine_is_409(self):
        with patch.object(voice.call_voices, 'configuration', return_value={"url": ""}):
            self.assertEqual(self.client.post('/api/bot-voice/speak/block', json={"text": "Hello"}).status_code, 409)
        async def selection(_): return 'local', 'chosen'
        async def pcm(text, model, selected):
            self.assertEqual((text, model, selected), ('Hello', 'local', 'chosen'))
            yield {"sample_rate": 24000}
            yield {"audio": b'\x01\x00'}
        with patch.object(voice, 'selection', selection), patch.object(voice.call_voices, 'pcm', pcm):
            result = self.client.post('/api/bot-voice/speak/block', json={"text": 'Hello', "voice_id": 'chosen'})
            self.assertEqual(result.status_code, 200)
            import json
            self.assertEqual([json.loads(line) for line in result.text.splitlines()], [{"sample_rate": 24000}, {"audio": 'AQA='}, {"done": True}])

    def test_wav_roundtrip_owner_and_transcript(self):
        async def pcm(*_):
            yield {"sample_rate": 24000}
            yield {"audio": b'\x00\x00'*2400}
        async def catalog():
            return {"models": ["local"], "voices": [{"id": "default"}]}
        with patch('services.agent_service.agent_service.get', return_value={"id": "x", "owner_user": "alice"}), \
             patch.object(voice.call_voices, 'configuration', return_value={"url": "http://localhost:8000"}), \
             patch.object(voice.call_voices, 'catalog', catalog), patch.object(voice.call_voices, 'pcm', pcm):
            result = self.client.post('/api/bot-voice/x/notes', json={"text": 'Hello there.'})
            self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        response = self.client.get(data['url'])
        with wave.open(io.BytesIO(response.content), 'rb') as wav:
            self.assertEqual((wav.getnchannels(), wav.getnframes(), wav.getframerate()), (1, 2400, 24000))
        self.assertEqual(self.client.get(data['transcript_url']).json()['transcript'], 'Hello there.')
        self.app.dependency_overrides[require_admin] = lambda: 'bob'; self.app.dependency_overrides[require_user] = lambda: 'bob'
        self.assertEqual(self.client.get(data['url']).status_code, 404)

    def test_engine_failure_leaves_no_files(self):
        async def bad(*_):
            yield {"audio": b'\x01'}
        with patch('services.agent_service.agent_service.get', return_value={"id": "x"}), patch.object(voice, 'audio_events', bad):
            result = self.client.post('/api/bot-voice/x/notes', json={"text": 'Hello'})
            self.assertEqual(result.status_code, 502)


if __name__ == '__main__':
    unittest.main()
