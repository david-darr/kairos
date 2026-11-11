"""Conversational voice (Fluid Voice, track B): the spoken style and its text clean-up, no thinking fillers,
interruption memory and backchannels. Fakes only: no model, no microphone, no voice engine, no network.
Run: python scripts/test_voice_conversational.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-conversational-', ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR'] = DATA.name
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import accounts, call_voices, realtime_voice, voice_backchannel, voice_dialogue, voice_style  # noqa: E402
from core.middleware import require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes.call_routes import router  # noqa: E402
from services import agent_calls as calls, chat_service, phone_bridge, realtime_session  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

FIXTURES = ROOT / 'scripts' / 'fixtures'


class SpokenStyle(unittest.TestCase):
    def test_strip_for_speech_matches_the_shared_cases(self):
        for case in json.loads((FIXTURES / 'spoken-style-cases.json').read_text(encoding='utf-8')):
            with self.subTest(case['in']):
                self.assertEqual(voice_style.strip_for_speech(case['in']), case['out'])

    def test_clean_text_is_unchanged_and_the_result_is_stable(self):
        for text in ('Okay, that works. Anything else?', 'I will check the calendar, then reply.'):
            self.assertEqual(voice_style.strip_for_speech(text), text)
        messy = '## Plan\n- one\n- two\n```py\nx=1\n```\nSee [docs](http://a.b/c).'
        once = voice_style.strip_for_speech(messy)
        self.assertEqual(voice_style.strip_for_speech(once), once)
        self.assertNotIn('```', once)
        self.assertIn(voice_style.CODE_LINE, once)

    def test_every_voice_turn_gets_the_spoken_style(self):
        for prompt in (voice_dialogue.VOICE_PROMPT, chat_service.OPEN_MIC_DISCIPLINE):
            self.assertIn(voice_style.VOICE_STYLE, prompt)
        for rule in ('short', 'Answer first', 'one question at a time'):
            self.assertIn(rule.lower(), voice_style.VOICE_STYLE.lower())
        self.assertIn('live spoken conversation', chat_service.OPEN_MIC_DISCIPLINE)
        self.assertIn('[interrupted]', voice_dialogue.VOICE_PROMPT)

    def test_the_text_a_voice_engine_receives_is_stripped_once_for_every_caller(self):
        sent = []

        def synthesize(text, voice):
            sent.append(text)
            return b'\x00\x00' * 480

        async def run():
            from core import kokoro_voice
            with patch.object(call_voices, 'configuration', return_value={'protocol': 'kokoro', 'url': call_voices.KOKORO_URL}), \
                    patch.object(kokoro_voice, 'synthesize', synthesize):
                return [item async for item in call_voices.pcm('## Heading\nUse **bold** and [a link](http://x.y).\n```\ncode\n```', 'kokoro', 'af')]
        items = asyncio.run(run())
        self.assertEqual(sent, ["Heading. Use bold and a link. " + voice_style.CODE_LINE])
        self.assertTrue(any('audio' in item for item in items))

    def test_phone_speech_text_is_stripped_too(self):
        self.assertEqual(phone_bridge.spoken_text('**Done.** See https://example.com/x for details.'), 'Done. See a link for details.')


class Backchannels(unittest.TestCase):
    def test_shared_cases(self):
        for case in json.loads((FIXTURES / 'backchannel-cases.json').read_text(encoding='utf-8')):
            with self.subTest(case):
                self.assertEqual(voice_backchannel.is_backchannel(case['text'], case['asked']), case['expect'])


class NoFillers(unittest.IsolatedAsyncioTestCase):
    """David, 2026-11-11: calls said "Ok, let me think" and "Mmm ok" while thinking. No voice surface plays a filler now,
    and every voice prompt tells the model to answer directly."""

    def test_every_voice_prompt_says_answer_directly(self):
        for prompt in (voice_style.VOICE_STYLE, voice_dialogue.VOICE_PROMPT, chat_service.OPEN_MIC_DISCIPLINE,
                       realtime_voice.REALTIME_PROMPT, realtime_session.LIVE_PROMPT):
            self.assertIn(voice_style.NO_FILLER, prompt)
        self.assertIn('let me think', voice_style.NO_FILLER)
        for prompt in (voice_dialogue.VOICE_PROMPT, realtime_voice.REALTIME_PROMPT, realtime_session.LIVE_PROMPT,
                       realtime_voice.TOOL_DESCRIPTION):
            self.assertNotIn('acknowledge', prompt.lower(), 'no prompt asks for an acknowledgement')

    async def test_the_filler_routes_are_gone(self):
        app = FastAPI(); app.include_router(router); app.dependency_overrides[require_user] = lambda: 'david'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            self.assertIn((await client.post('/api/agent-calls/filler', json={'text': 'hi'})).status_code, (404, 405))
            self.assertIn((await client.post('/api/agent-calls/filler/warm', json={'model': 'm', 'voice': 'v'})).status_code, (404, 405))

    def test_old_cached_clips_are_swept_and_nothing_else(self):
        folder = accounts.path('voice_fillers')
        os.makedirs(folder, exist_ok=True)
        for name in ('a.pcm', 'b.pcm.tmp'):
            Path(folder, name).write_bytes(b'z' * 8)
        Path(folder, 'keep.txt').write_text('not ours', encoding='utf-8')
        outside = Path(folder).parent / 'beside.pcm'
        outside.write_bytes(b'z')
        try:
            self.assertEqual(call_voices.sweep_old_filler_cache(), 2)
            self.assertEqual(sorted(os.listdir(folder)), ['keep.txt'], 'only the cached clips go')
            self.assertTrue(outside.exists(), 'nothing outside the folder is touched')
            os.remove(Path(folder, 'keep.txt'))
            self.assertEqual(call_voices.sweep_old_filler_cache(), 0)
            self.assertFalse(os.path.isdir(folder), 'an empty folder is removed')
            self.assertEqual(call_voices.sweep_old_filler_cache(), 0, 'no folder: nothing to do')
        finally:
            outside.unlink(missing_ok=True)


class FakeConversation:
    def __init__(self, *args):
        self.gate = None

    async def close(self):
        pass

    async def stream(self, messages, max_tokens=320):
        yield 'First thing. '
        if self.gate:
            await self.gate.wait()
        yield 'Second thing. Third thing.'


class InterruptionMemory(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        calls._calls.clear(); calls._locks.clear(); calls._turns.clear(); calls._conversations.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(calls, 'ROOT', Path(self.temp.name)), patch.object(calls, 'Conversation', FakeConversation)]
        for item in self.patches:
            item.start()
        agent = agent_service.create('Memory ' + uuid.uuid4().hex[:10], endpoint_id=None)
        parent = session_manager.create_session(owner_user='david')['id']
        from core import session_manager_store as store
        value = session_manager.get_session(parent); value['agent_id'] = agent['id']; value['model_endpoint_id'] = 'strong'; store.save_session(value)
        self.record = calls.require(calls.start(parent, agent['id'], 'fast', 'small', 'david')['id'], 'david')

    async def asyncTearDown(self):
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def test_the_marker_text(self):
        self.assertEqual(calls.interrupted_content(['One.', ' Two. ']), 'One. Two. [interrupted]')
        self.assertEqual(calls.interrupted_content([]), '[interrupted before any of this reply was heard]')
        self.assertEqual(calls.interrupted_content(['x' * 5000])[:4], 'xxxx')
        self.assertLessEqual(len(calls.interrupted_content(['x' * 5000])), 4000 + len(' [interrupted]'))

    async def test_a_finished_reply_is_cut_to_what_was_heard(self):
        async for _ in calls.turn(self.record, 'Tell me three things', 'a'):
            pass
        self.assertEqual(self.record['messages'][-1]['content'], 'First thing. Second thing. Third thing.')
        calls.interrupt(self.record, spoken=True, heard=['First thing.', 'Second thing.'])
        last = self.record['messages'][-1]
        self.assertEqual(last['content'], 'First thing. Second thing. [interrupted]')
        self.assertTrue(last['interrupted'])
        # The next reply is asked with exactly that in its history, not the sentence nobody heard.
        context = calls._context(self.record)
        self.assertIn('First thing. Second thing. [interrupted]', [m['content'] for m in context])
        self.assertNotIn('Third thing', json.dumps(context[1:]))

    async def test_nothing_heard_says_so_and_unknown_changes_nothing(self):
        async for _ in calls.turn(self.record, 'Tell me', 'a'):
            pass
        calls.interrupt(self.record, heard=None)
        self.assertEqual(self.record['messages'][-1]['content'], 'First thing. Second thing. Third thing.', 'heard unknown: the text stays')
        calls.interrupt(self.record, spoken=True, heard=[])
        self.assertEqual(self.record['messages'][-1]['content'], '[interrupted before any of this reply was heard]')

    async def test_a_reply_still_being_written_is_saved_as_what_was_heard(self):
        engine = calls._conversations[self.record['id']] if self.record['id'] in calls._conversations else calls._conversation(self.record)
        engine.gate = asyncio.Event()
        first = asyncio.Event()

        async def consume():
            async for _ in calls.turn(self.record, 'Hello', 'live'):
                first.set()
        task = asyncio.create_task(consume()); await first.wait()
        calls.interrupt(self.record, spoken=True, heard=['First thing.'])
        await asyncio.gather(task, return_exceptions=True)
        last = self.record['messages'][-1]
        self.assertEqual((last['content'], last['interrupted']), ('First thing. [interrupted]', True))
        self.assertNotIn('heard_pending', self.record)

    async def test_an_idle_interrupt_does_not_rewrite_the_history(self):
        async for _ in calls.turn(self.record, 'Hi', 'a'):
            pass
        before = list(self.record['messages'])
        calls.interrupt(self.record)
        self.assertEqual(self.record['messages'], before)

    async def test_the_route_takes_the_sentences_heard(self):
        async for _ in calls.turn(self.record, 'Hi', 'a'):
            pass
        app = FastAPI(); app.include_router(router); app.dependency_overrides[require_user] = lambda: 'david'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            url = f"/api/agent-calls/{self.record['id']}/interrupt"
            self.assertEqual((await client.post(url, json={'spoken': True, 'heard': ['First thing.']})).status_code, 200)
            self.assertEqual(self.record['messages'][-1]['content'], 'First thing. [interrupted]')
            self.assertEqual((await client.post(url, json={'heard': ['x'] * 61})).status_code, 422)

    async def test_open_mic_tells_the_model_what_was_heard_once(self):
        session = session_manager.create_session(owner_user='david')['id']
        session_manager.set_open_mic(session, True)
        plain = chat_service._apply_open_mic_discipline(session, 'Hello')
        self.assertTrue(plain.endswith(chat_service.OPEN_MIC_DISCIPLINE))
        chat_service.note_open_mic_heard(session, ['The first part.', 'And a second.'])
        told = chat_service._apply_open_mic_discipline(session, 'Hello')
        self.assertIn('heard only this of it: "The first part. And a second." [interrupted]', told)
        self.assertEqual(chat_service._apply_open_mic_discipline(session, 'Again'), 'Again' + chat_service.OPEN_MIC_DISCIPLINE, 'used once')
        chat_service.note_open_mic_heard(session, [])
        self.assertIn('before they heard any of it', chat_service._apply_open_mic_discipline(session, 'Hi'))


# -- the phone bridge: nods, what was heard, and quiet until the answer ----------------------------------------------
import test_phone_calls as phone  # noqa: E402


class PhoneConversation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pipeline = phone.FakePipeline()
        self.noted = []
        self.pipeline.note_heard = lambda sentences: self.noted.append(list(sentences))
        self.nods = ['mm-hm']
        self.words = ['hello there']

        async def transcribe(pcm16):
            self.pipeline.heard.append(pcm16)
            return self.words.pop(0) if len(self.words) > 1 else self.words[0]
        self.pipeline.transcribe = transcribe
        self.socket = phone.FakeSocket()
        self.inbound = asyncio.Queue()
        self.provider = phone.providers.Twilio({}, {})

    async def start(self, **options):
        self.bridge = phone_bridge.PhoneBridge(self.provider, self.socket.send, self.pipeline, stream_id='MZ1', pace=False, **options)
        self.task = asyncio.create_task(self.bridge.run(self.inbound.get))

    async def feed(self, frames):
        for frame in frames:
            await self.inbound.put(phone.twilio_media(frame))
            await asyncio.sleep(0)
            await asyncio.sleep(0)

    async def finish(self):
        await self.inbound.put(None)
        await asyncio.wait_for(self.task, 5)

    async def say(self, ms=600):
        await self.feed(phone.silence(300) + phone.frames_of(phone.tone(ms)))

    async def test_a_barge_in_reports_only_the_sentences_that_had_begun_to_play(self):
        self.pipeline.reply = ['First sentence here. ', 'Second sentence here. ', 'Third sentence here.']
        self.pipeline.gate = asyncio.Event()                    # the voice stalls inside the first sentence
        await self.start()
        await self.say()
        await self.feed(phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.phase == 'speaking' and self.socket.media_sent()))
        self.words = ['wait stop']
        await self.feed(phone.frames_of(phone.tone(700)))
        self.assertTrue(await phone.Settled.until(lambda: any(m['event'] == 'clear' for m in self.socket.sent)))
        self.assertTrue(self.noted, 'the pipeline was told before the interrupt')
        self.assertEqual(self.noted[-1], ['First sentence here.'], 'only the first sentence had started when the caller cut in')
        self.pipeline.gate.set()
        await self.finish()

    async def test_a_nod_over_the_reply_is_not_a_turn_and_does_not_cut_it_off(self):
        self.pipeline.gate = asyncio.Event()
        await self.start()
        await self.say()
        await self.feed(phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.phase == 'speaking'))
        turns = len(self.pipeline.heard)
        self.words = ['Mm-hmm, yeah.']
        # 500 ms is past the barge-in time of a bare noise (400 ms voiced) only if it is sustained; this one is a clip of 350 ms
        await self.feed(phone.frames_of(phone.tone(350)) + phone.silence(900))
        await asyncio.sleep(0.1)
        self.assertEqual([m for m in self.socket.sent if m['event'] == 'clear'], [])
        self.assertEqual(self.pipeline.interrupts, [])
        self.assertEqual(len(self.pipeline.heard), turns, 'a short nod is not sent for transcription as a turn')
        self.pipeline.gate.set()
        await self.finish()

    async def test_a_long_nod_after_a_barge_in_is_transcribed_and_dropped(self):
        self.pipeline.gate = asyncio.Event()
        await self.start()
        await self.say()
        await self.feed(phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.phase == 'speaking'))
        self.words = ['yeah, right, okay']
        asked_before = len(self.pipeline.spoken)
        await self.feed(phone.frames_of(phone.tone(800)) + phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.dropped_backchannels == 1))
        self.assertEqual(len(self.pipeline.spoken), asked_before, 'nothing was said in answer to a nod')
        self.pipeline.gate.set()
        await self.finish()

    async def test_an_interjection_while_thinking_is_checked_before_the_reply_is_cut(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def converse(text, request_id):
            started.set()
            await release.wait()
            yield 'Here is the answer.'
        self.pipeline.converse = converse
        await self.start()
        await self.say()
        await self.feed(phone.silence(900))
        await asyncio.wait_for(started.wait(), 3)
        self.words = ['uh huh']
        await self.feed(phone.silence(100) + phone.frames_of(phone.tone(350)) + phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.dropped_backchannels == 1))
        self.assertEqual(self.pipeline.interrupts, [], 'the reply being written was not cut off by a nod')
        release.set()
        self.assertTrue(await phone.Settled.until(lambda: self.pipeline.spoken == ['Here is the answer.']))
        await self.finish()

    async def test_a_slow_answer_is_preceded_by_silence_not_a_filler(self):
        release = asyncio.Event()

        async def slow(text, request_id):
            await release.wait()
            yield 'The slow answer is here.'
        self.pipeline.converse = slow
        self.assertFalse(hasattr(phone_bridge.Pipeline, 'filler'), 'the pipeline has no filler hook any more')
        await self.start()
        await self.say()
        await self.feed(phone.silence(900))
        self.assertTrue(await phone.Settled.until(lambda: self.bridge.phase == 'thinking'))
        await asyncio.sleep(0.8)                      # well past the old half-second filler
        self.assertEqual(self.socket.media_sent(), [], 'nothing is played while the answer is being written')
        release.set()
        self.assertTrue(await phone.Settled.until(lambda: self.pipeline.spoken == ['The slow answer is here.']))
        self.assertTrue(self.socket.media_sent(), 'the answer itself is the first thing heard')
        await self.finish()

if __name__ == '__main__':
    unittest.main()
