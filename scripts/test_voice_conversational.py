"""Conversational voice (Fluid Voice, track B): the spoken style and its text clean-up, instant acknowledgements,
interruption memory and backchannels. Fakes only: no model, no microphone, no voice engine, no network.
Run: python scripts/test_voice_conversational.py
"""
import asyncio
import json
import os
import random
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

from core import call_voices, voice_backchannel, voice_dialogue, voice_fillers, voice_style  # noqa: E402
from core.middleware import require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes.call_routes import router  # noqa: E402
from services import agent_calls as calls, chat_service, phone_bridge  # noqa: E402
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


class Fillers(unittest.IsolatedAsyncioTestCase):
    def test_only_a_slow_answer_gets_one(self):
        quick = dict(first_sentence_ready=True)
        self.assertFalse(voice_fillers.should_play(900, **quick), 'a sentence is ready: the answer was quick')
        self.assertFalse(voice_fillers.should_play(300, first_sentence_ready=False), 'not yet half a second')
        self.assertTrue(voice_fillers.should_play(voice_fillers.FILLER_AFTER_MS, first_sentence_ready=False))
        self.assertFalse(voice_fillers.should_play(2000, first_sentence_ready=False, work_update=True), 'work updates never')
        self.assertFalse(voice_fillers.should_play(2000, first_sentence_ready=False, muted=True), 'a muted assistant never')
        self.assertFalse(voice_fillers.should_play(2000, first_sentence_ready=False, user_speaking=True), 'not over the user')

    def test_never_the_same_phrase_twice_in_a_row_and_it_varies(self):
        rng = random.Random(7)
        last, seen = None, set()
        for _ in range(300):
            ident, text = voice_fillers.pick(last, 'what is the capital of france', rng)
            self.assertNotEqual(ident, last)
            self.assertEqual(text, voice_fillers.text_of(ident))
            seen.add(ident)
            last = ident
        self.assertGreaterEqual(len(seen), 4, 'a call hears several different acknowledgements')

    def test_a_plain_question_never_gets_a_request_phrase(self):
        rng = random.Random(3)
        for _ in range(200):
            ident, _ = voice_fillers.pick(None, 'why is the sky blue', rng)
            self.assertNotEqual(voice_fillers._BY_ID[ident][2], 'request')
        self.assertEqual(voice_fillers.kind_of('Can you remind me to call Sam'), 'request')
        self.assertEqual(voice_fillers.kind_of('hey, set a timer for ten minutes'), 'request')
        self.assertEqual(voice_fillers.kind_of('how far is the moon'), 'question')

    async def test_a_voices_phrases_render_lazily_once_and_are_kept(self):
        rendered = []

        async def fake_pcm(text, model, voice):
            rendered.append((text, model, voice))
            yield {'sample_rate': 24000}
            yield {'audio': b'\x01\x00' * 2400}

        with patch.object(call_voices, 'pcm', fake_pcm):
            self.assertIsNone(voice_fillers.cached('eng', 'voiceA', 'okay'))
            self.assertTrue(await voice_fillers.render('eng', 'voiceA', 'okay'))
            self.assertTrue(await voice_fillers.render('eng', 'voiceA', 'okay'))
            self.assertEqual(len(rendered), 1, 'rendered once, then served from the kept copy')
            rate, pcm = voice_fillers.cached('eng', 'voiceA', 'okay')
            self.assertEqual((rate, len(pcm)), (24000, 4800))
            self.assertIsNone(voice_fillers.cached('eng', 'voiceB', 'okay'), 'each voice has its own')
            await asyncio.gather(voice_fillers.render('eng', 'voiceB', 'okay'), voice_fillers.render('eng', 'voiceB', 'okay'))
            self.assertEqual(len(rendered), 2, 'two asks at once render once')
            self.assertFalse(await voice_fillers.render('eng', 'voiceB', 'not-a-phrase'))

    async def test_events_give_text_to_a_device_voice_and_audio_only_when_cached(self):
        device = [json.loads(line) for line in voice_fillers.event_lines('okay', '', '')]
        self.assertEqual(device, [{'filler': {'id': 'okay', 'text': 'Okay.'}}])
        cold = [json.loads(line) for line in voice_fillers.event_lines('see', 'eng', 'never-rendered')]
        self.assertEqual(cold[-1], {'cached': False})
        voice_fillers.store('eng', 'warm', 'see', 22050, b'\x02\x00' * 100)
        warm = [json.loads(line) for line in voice_fillers.event_lines('see', 'eng', 'warm')]
        self.assertEqual(warm[1], {'sample_rate': 22050})
        self.assertEqual(len(warm), 3)

    async def test_the_route_picks_without_repeating_and_warms_in_the_background(self):
        app = FastAPI(); app.include_router(router); app.dependency_overrides[require_user] = lambda: 'david'
        started = []

        async def fake_render(model, voice, ident):
            started.append((model, voice, ident))
            return True

        with patch.object(voice_fillers, 'render', fake_render):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                lines = (await client.post('/api/agent-calls/filler', json={'last': 'okay', 'text': 'what time is it'})).text.splitlines()
                first = json.loads(lines[0])['filler']
                self.assertNotEqual(first['id'], 'okay')
                cold = await client.post('/api/agent-calls/filler', json={'text': 'hi', 'model': 'eng', 'voice': 'uncached'})
                self.assertIn('"cached": false', cold.text)
                await asyncio.sleep(0.05)
                self.assertTrue(started and started[0][:2] == ('eng', 'uncached'), 'an uncached phrase starts rendering for next time')
                self.assertEqual((await client.post('/api/agent-calls/filler/warm', json={'model': 'eng', 'voice': 'v'})).json(), {'ok': True})


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


# -- the phone bridge: nods, what was heard, and the acknowledgement -------------------------------------------------
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

    async def test_a_slow_answer_gets_one_acknowledgement_and_a_quick_one_gets_none(self):
        async def filler(text, last):
            async def parts():
                yield 24000, b'\x10\x00' * 2400
            return 'okay', parts()
        self.pipeline.filler = filler
        release = asyncio.Event()

        async def slow(text, request_id):
            await release.wait()
            yield 'The slow answer is here.'
        self.pipeline.converse = slow
        with patch.object(phone_bridge.voice_fillers, 'FILLER_AFTER_MS', 120):
            await self.start()
            await self.say()
            await self.feed(phone.silence(900))
            self.assertTrue(await phone.Settled.until(lambda: len(self.socket.media_sent()) > 3), 'the acknowledgement played while the model was still working')
            self.assertEqual(self.pipeline.spoken, [], 'no sentence of the answer yet')
            release.set()
            self.assertTrue(await phone.Settled.until(lambda: self.pipeline.spoken == ['The slow answer is here.']))
            self.assertEqual(self.bridge.last_filler, 'okay')
            await self.finish()

        quick = phone.FakePipeline(); quick.filler_calls = 0

        async def never(text, last):
            quick.filler_calls += 1
            return None
        quick.filler = never
        self.pipeline, self.socket, self.inbound = quick, phone.FakeSocket(), asyncio.Queue()
        with patch.object(phone_bridge.voice_fillers, 'FILLER_AFTER_MS', 800):
            await self.start()
            await self.say()
            await self.feed(phone.silence(900))
            self.assertTrue(await phone.Settled.until(lambda: quick.spoken))
            await self.finish()
        self.assertEqual(quick.filler_calls, 0, 'the answer was ready first: the acknowledgement was never even looked up')


if __name__ == '__main__':
    unittest.main()
