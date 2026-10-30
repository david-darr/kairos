"""Group calls from a room (Bots Phase 6): who can join, who answers, and the one summary that goes back to the room."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-group-call-', ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
import httpx
from core.middleware import require_admin
from core import bot_rooms_store
from services import agent_calls as calls, bot_rooms
from services.agent_service import agent_service
from routes.call_routes import router


class FakeConversation:
    """Records what each turn was given; replies with a fixed line, or a work tag when asked to."""
    seen = []
    def __init__(self, *args): self.closed = False
    async def close(self): self.closed = True
    async def stream(self, messages, max_tokens=320):
        if max_tokens != 320:
            yield 'Agreed to ship on Friday.'
            return
        self.seen.append(messages)
        if 'start the research' in messages[-1]['content']:
            yield 'Sure. <kairos-work>{"title":"Research","request":"Research it"}</kairos-work>'
            return
        yield 'Happy to help.'


class GroupCalls(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        calls._calls.clear(); calls._locks.clear(); calls._turns.clear(); calls._summaries.clear(); calls._conversations.clear()
        FakeConversation.seen = []
        self.temp = tempfile.TemporaryDirectory(); self.root = patch.object(calls, 'ROOT', Path(self.temp.name)); self.root.start()
        self.model = patch.object(calls, 'Conversation', FakeConversation); self.model.start()
        tag = uuid.uuid4().hex[:6]
        self.ada = agent_service.create(f'Ada {tag}', endpoint_id=None)
        self.bo = agent_service.create(f'Bo {tag}', endpoint_id=None)
        self.cy = agent_service.create(f'Cy {tag}', endpoint_id=None)
        self.room = bot_rooms.create('david', 'Launch', bot_ids=[self.ada['id'], self.bo['id'], self.cy['id']], setup_done=True)
        bot_rooms_store.update_member(self.room['id'], self.cy['id'], held_at=time.time())

    async def asyncTearDown(self):
        for task in list(calls._summaries.values()) + list(calls._turns.values()):
            if task is not asyncio.current_task() and not task.done(): task.cancel()
        await asyncio.gather(*calls._summaries.values(), return_exceptions=True)
        for c in calls._conversations.values(): await c.close()
        self.root.stop(); self.model.stop(); self.temp.cleanup()

    def start(self, agent=None, **extra):
        return calls.require(calls.start('', (agent or self.ada)['id'], 'fast', 'small', 'david', room_id=self.room['id'], **extra)['id'], 'david')

    async def say(self, call, text, request_id=None):
        return [event async for event in calls.turn(call, text, request_id or uuid.uuid4().hex)]

    def test_a_group_call_holds_the_room_members_that_are_not_on_hold(self):
        call = self.start()
        self.assertEqual(call['room_id'], self.room['id'])
        self.assertEqual(call['parent_id'], self.room['id'])
        self.assertEqual(call['members'], [self.ada['id'], self.bo['id']], 'a held member stays out of the call')
        self.assertEqual(calls.view(call)['members'], call['members'])

    def test_refusals(self):
        with self.assertRaises(HTTPException) as caught: self.start(self.cy)
        self.assertEqual(caught.exception.status_code, 404, 'a held member cannot open the call')
        with self.assertRaises(HTTPException) as caught: self.start(mode='cloud')
        self.assertEqual(caught.exception.status_code, 422, 'group calls are local only')
        with self.assertRaises(HTTPException) as caught: calls.start('', self.ada['id'], 'fast', 'small', 'someone-else', room_id=self.room['id'])
        self.assertEqual(caught.exception.status_code, 404, "another person's room is not found")
        bot_rooms_store.update_room(self.room['id'], {'archived_at': time.time()})
        with self.assertRaises(HTTPException) as caught: self.start()
        self.assertEqual(caught.exception.status_code, 409, 'a closed room cannot start a call')

    async def test_the_named_member_answers_and_later_turns_stay_with_the_last_speaker(self):
        call = self.start()
        events = await self.say(call, f"{self.bo['name']}, what do you think?")
        self.assertEqual(events[0], {'type': 'speaker', 'id': self.bo['id'], 'name': self.bo['name']}, 'the speaker comes first')
        self.assertEqual(call['messages'][-1]['speaker'], self.bo['id'])
        events = await self.say(call, 'And the timeline?')
        self.assertEqual(events[0]['id'], self.bo['id'], 'nobody named: the last speaker keeps the floor')
        events = await self.say(call, f"{self.ada['name']} and {self.bo['name']}, agreed?")
        self.assertEqual(events[0]['id'], self.ada['id'], 'the first name said wins')

    async def test_the_room_responder_answers_when_nobody_is_named(self):
        bot_rooms_store.update_room(self.room['id'], {'default_responder': {'kind': 'member', 'bot_id': self.bo['id']}})
        events = await self.say(self.start(), 'Where are we?')
        self.assertEqual(events[0]['id'], self.bo['id'])

    async def test_each_bot_speaks_as_itself_and_sees_the_others_marked(self):
        call = self.start()
        await self.say(call, f"{self.ada['name']}, start us off.")
        await self.say(call, f"{self.bo['name']}, your turn.")
        system, *history = FakeConversation.seen[-1]
        self.assertIn(f"Your name: {self.bo['name']}", system['content'])
        self.assertIn('group voice call in the room Launch', system['content'])
        self.assertIn(self.ada['name'], system['content'], 'the other members are named')
        marked = [m for m in history if m['content'].startswith(f"[{self.ada['name']}, another bot on this call]")]
        self.assertEqual(len(marked), 1, "Ada's line reaches Bo as another bot's words, not as Bo's own")
        self.assertEqual(marked[0]['role'], 'user')

    async def test_a_replayed_request_returns_the_same_speaker(self):
        call = self.start()
        await self.say(call, f"{self.bo['name']}, hello", 'same')
        events = await self.say(call, f"{self.bo['name']}, hello", 'same')
        self.assertEqual([e['type'] for e in events], ['speaker', 'done'])
        self.assertEqual(events[0]['id'], self.bo['id'])

    async def test_no_background_work_starts_from_a_group_call(self):
        call = self.start()
        events = await self.say(call, 'Please start the research')
        self.assertFalse([e for e in events if e['type'] == 'job'])
        self.assertEqual(call['jobs'], [])
        with self.assertRaises(HTTPException) as caught: calls.delegate(call, 'Research', 'Research it', 'k')
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('never write a kairos-work tag', FakeConversation.seen[-1][0]['content'])

    async def test_the_summary_is_one_row_in_the_room_and_chat_is_untouched(self):
        call = self.start()
        await self.say(call, f"{self.ada['name']}, when do we ship?")
        call['ended'] = True
        await calls.finalize(call)
        self.assertEqual(call['summary_state'], 'saved')
        await calls.finalize(call)
        rows = [m for m in bot_rooms_store.messages(self.room['id']) if m['kind'] == 'call_summary']
        self.assertEqual(len(rows), 1, 'a second finalize finds the same row')
        self.assertEqual(rows[0]['role'], 'system')
        self.assertTrue(rows[0]['text'].startswith(f"Group call with {self.ada['name']}, {self.bo['name']}"))
        self.assertIn('Agreed to ship on Friday.', rows[0]['text'])
        self.assertEqual(rows[0]['meta']['call_id'], call['id'])

    async def test_a_failed_summary_is_listed_for_the_room_and_access_stays_with_the_owner(self):
        call = self.start()
        call['ended'] = True; call['summary_state'] = 'failed'; calls._save(call)
        self.assertEqual([r['id'] for r in calls.pending(self.room['id'], 'david')], [call['id']])
        with self.assertRaises(HTTPException): calls.pending(self.room['id'], 'someone-else')
        with self.assertRaises(HTTPException): calls.require(call['id'], 'someone-else')

    async def test_the_route_takes_a_room(self):
        app = FastAPI(); app.include_router(router); app.dependency_overrides[require_admin] = lambda: 'david'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            made = await client.post('/api/agent-calls', json={'parent_id': '', 'agent_id': self.bo['id'], 'endpoint_id': 'fast', 'model': 'small', 'room_id': self.room['id']})
            self.assertEqual(made.status_code, 200, made.text)
            self.assertEqual(made.json()['room_id'], self.room['id'])
            self.assertEqual((await client.get(f"/api/agent-calls/{made.json()['id']}")).json()['members'], [self.ada['id'], self.bo['id']])


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        bot_rooms_store.close()
        DATA.cleanup()
