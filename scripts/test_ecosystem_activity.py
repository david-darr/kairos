"""Read-only agent activity projection; isolated from David's data and providers."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_data = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR'] = _data.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services import chat_live
from routes import agent_routes


class ActivityTests(unittest.TestCase):
    def test_projection_is_bounded_and_excludes_other_agents_and_finished_turns(self):
        runs = {'one': {'status': 'processing', 'sessionTitle': 'Study', 'prompt': 'x' * 1000, 'startedAt': 1},
                'two': {'status': 'processing', 'sessionTitle': 'Other agent', 'prompt': 'private', 'startedAt': 3},
                'three': {'status': 'done', 'sessionTitle': 'Finished', 'prompt': 'old', 'startedAt': 4}}
        with patch.dict(chat_live._runs, runs, clear=True), patch.object(chat_live.chat_service.session_manager, 'get_session', side_effect=lambda sid: {'agent_id': 'b' if sid == 'two' else 'a'}):
            value = chat_live.agent_activity('a')
        self.assertEqual(value['name'], 'Study')
        self.assertEqual(len(value['detail']), 240)
        self.assertEqual(value['count'], 1)
        self.assertNotIn('text', value)

    def test_latest_chat_and_any_pending_approval_are_reported(self):
        runs = {'old': {'status': 'processing', 'sessionTitle': 'Study', 'prompt': '', 'startedAt': 1, 'permission': {'tool': 'read'}},
                'new': {'status': 'processing', 'sessionTitle': 'Debug', 'prompt': '', 'startedAt': 2}}
        with patch.dict(chat_live._runs, runs, clear=True), patch.object(chat_live.chat_service.session_manager, 'get_session', return_value={'agent_id': 'a'}):
            value = chat_live.agent_activity('a')
        self.assertTrue(value['waiting'])
        self.assertEqual(value['name'], 'Debug')
        self.assertEqual(value['count'], 2)

    def test_chat_activity_reaches_admin_summary_and_stops_when_finished(self):
        agent = {'id': 'a', 'enabled': True}
        with patch.object(agent_routes, '_owned', return_value=[]), patch('services.agent_handoff.person_inbox', return_value=[]), patch.object(agent_routes.agent_service, 'can_run', return_value=(True, '')), patch.object(agent_routes.agent_service, 'runs_today', return_value=0):
            with patch.object(chat_live, 'agent_activity', return_value={'kind':'chat','working':True,'waiting':True,'name':'Homework','detail':'','count':1}):
                value = agent_routes._summary(agent)
            self.assertEqual(value['status'], 'working')
            self.assertEqual(value['needs_you'], 1)
            self.assertEqual(value['activity']['name'], 'Homework')
            with patch.object(chat_live, 'agent_activity', return_value=None):
                value = agent_routes._summary(agent)
            self.assertEqual(value['status'], 'idle')
            self.assertIsNone(value['activity'])

    def test_task_projection_stays_bounded_and_off_agents_cannot_appear_working(self):
        task = {'schedule_kind':'card','status':'running','name':'Study','prompt':'a' * 1000}
        with patch.object(agent_routes, '_owned', return_value=[task]), patch('services.agent_handoff.person_inbox', return_value=[]), patch.object(agent_routes.agent_service, 'can_run', return_value=(False, 'off')), patch.object(agent_routes.agent_service, 'runs_today', return_value=0), patch.object(chat_live, 'agent_activity', return_value=None):
            value = agent_routes._summary({'id':'a','enabled':False})
        self.assertEqual(value['status'], 'off')
        self.assertEqual(value['activity']['kind'], 'task')
        self.assertEqual(len(value['activity']['detail']), 240)


if __name__ == '__main__':
    unittest.main()
