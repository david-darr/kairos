"""Isolated Home week API tests; no model, network or live data.
Run: python scripts/test_home_week.py
"""
import os
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix='kairos-home-week-')
os.environ['JARVIS_DATA_DIR'] = fixture.name

import httpx
from fastapi import FastAPI
from core import session_manager_store as store
from core.atomic_io import write_json_atomic
from core.middleware import require_user
from routes.system_routes import custom_views_router
from services.home_week import home_week
from services.task_service import tasks_file, runs_file


def stamp(day, hour=0, minute=0):
    return datetime.fromisoformat(f'{day}T{hour:02}:{minute:02}:00').timestamp()


class WeekTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        with store.transaction() as conn:
            conn.execute('DELETE FROM messages')
            conn.execute('DELETE FROM sessions')
        write_json_atomic(tasks_file(), {})
        write_json_atomic(runs_file(), [])
        self.user = 'alice'
        app = FastAPI()
        app.include_router(custom_views_router)
        app.dependency_overrides[require_user] = lambda: self.user
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()

    def session(self, sid, owner, messages):
        store.save_session({'id': sid, 'owner_user': owner, 'messages': [
            {'role': role, 'content': 'fixture', 'ts': ts} for role, ts in messages]})

    async def week(self, value='2026-10-21'):
        response = await self.client.get('/api/home/week', params={'week': value})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_empty_week(self):
        data = await self.week()
        self.assertEqual((data['start'], data['end']), ('2026-10-19', '2026-10-25'))
        self.assertEqual(len(data['slots']), 14)
        self.assertEqual(data['totals'], {'chats': 0, 'agent_runs': 0, 'notes_done': 0})
        self.assertIsNone(data['busiest'])
        self.assertIn('notes_done', data['unavailable'])

    async def test_am_pm_and_distinct_sessions(self):
        self.session('a', 'alice', [('user', stamp('2026-10-19', 0)), ('user', stamp('2026-10-19', 11, 59)),
                                    ('user', stamp('2026-10-19', 12)), ('assistant', stamp('2026-10-20', 10))])
        self.session('b', 'alice', [('user', stamp('2026-10-19', 10))])
        data = await self.week()
        self.assertEqual([s['chats'] for s in data['slots'][:3]], [2, 1, 0])
        self.assertEqual(data['totals']['chats'], 3)
        self.assertEqual(data['busiest'], 'Mon')

    async def test_week_boundaries(self):
        self.session('a', 'alice', [('user', stamp('2026-10-18', 23, 59)), ('user', stamp('2026-10-19')),
                                    ('user', stamp('2026-10-25', 23, 59)), ('user', stamp('2026-10-26'))])
        data = await self.week()
        self.assertEqual(data['totals']['chats'], 2)
        self.assertEqual(data['slots'][0]['chats'], 1)
        self.assertEqual(data['slots'][-1]['chats'], 1)

    async def test_owner_scoping_including_admin(self):
        self.session('a', 'alice', [('user', stamp('2026-10-20', 10))])
        self.session('b', 'bob', [('user', stamp('2026-10-20', 10))])
        self.session('legacy', None, [('user', stamp('2026-10-20', 10))])
        write_json_atomic(tasks_file(), {'a': {'owner_user': 'alice'}, 'b': {'owner_user': 'bob'}, 'shared': {}})
        write_json_atomic(runs_file(), [{'task_id': key, 'started_at': stamp('2026-10-20', 12)} for key in ('a', 'b', 'shared')])
        data = await self.week()
        self.assertEqual(data['totals']['chats'], 1)
        self.assertEqual(data['totals']['agent_runs'], 1)
        self.user = 'admin'
        data = await self.week()
        self.assertEqual(data['totals']['chats'], 0)
        self.assertEqual(data['totals']['agent_runs'], 0)

    async def test_runs_not_messages_and_boundaries(self):
        write_json_atomic(tasks_file(), {'a': {'owner_user': 'alice'}})
        write_json_atomic(runs_file(), [{'task_id': 'a', 'started_at': stamp(day, hour)} for day, hour in
                                         [('2026-10-18', 23), ('2026-10-19', 0), ('2026-10-19', 12), ('2026-10-25', 23), ('2026-10-26', 0)]])
        data = await self.week()
        self.assertEqual(data['totals']['agent_runs'], 3)
        self.assertEqual([data['slots'][i]['agent_runs'] for i in (0, 1, 13)], [1, 1, 1])

    async def test_old_runs_do_not_use_finish_time(self):
        write_json_atomic(tasks_file(), {'a': {'owner_user': 'alice'}})
        write_json_atomic(runs_file(), [{'task_id': 'a', 'ran_at': stamp('2026-10-20')}])
        data = await self.week()
        self.assertEqual(data['totals']['agent_runs'], 0)
        self.assertIn('agent_runs', data['unavailable'])

    async def test_origin_owner_live_and_queued_runs(self):
        self.session('origin', 'alice', [])
        write_json_atomic(tasks_file(), {'a': {'origin_session_id': 'origin'}})
        write_json_atomic(runs_file(), [
            {'task_id': 'a', 'started_at': stamp('2026-10-20', 9), 'outcome': 'running'},
            {'task_id': 'a', 'started_at': None, 'admitted_at': stamp('2026-10-20', 9), 'outcome': 'queued'},
            {'task_id': 'a', 'ran_at': stamp('2026-10-18', 9)},
        ])
        data = await self.week()
        self.assertEqual(data['totals']['agent_runs'], 1)
        self.assertNotIn('agent_runs', data['unavailable'])

    async def test_bad_week(self):
        for value in ('2026-1-02', '2026-02-30', '20261019', '2026-10-19T00:00:00', '', '0000-01-01', '9999-12-31'):
            response = await self.client.get('/api/home/week', params={'week': value})
            self.assertEqual(response.status_code, 422, value)

    async def test_default_local_week(self):
        data = home_week('alice')
        self.assertEqual(datetime.fromisoformat(data['start']).weekday(), 0)
        self.assertLessEqual(data['start'], datetime.now().date().isoformat())
        self.assertGreaterEqual(data['end'], datetime.now().date().isoformat())


if __name__ == '__main__':
    unittest.main(verbosity=2)
