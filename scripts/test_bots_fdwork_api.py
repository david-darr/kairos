"""Bounded front-desk routes in a tiny ASGI app, no app startup or network."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-fdwork-api-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]

import httpx
from fastapi import FastAPI
from bots_chat_harness import Harness, OWNER
from core.atomic_io import write_json_atomic
from core.middleware import require_admin
from routes import front_desk_work_routes as routes
from services import front_desk_tasks as tasks
from services.agent_service import agent_service

app = FastAPI()
app.include_router(routes.router)
app.dependency_overrides[require_admin] = lambda: OWNER


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        bot = self.h.bot("Kip API")
        agent_service._agents[bot["id"]]["builtin"] = "front_desk"
        main = self.h.thread(bot)
        write_json_atomic(os.path.join(tasks.DIRECTORY, "state.json"), {"bot_id": bot["id"], "main_thread_id": main})
        tasks.write_rows("tasks", [])
        tasks.write_rows("suggestions", [])
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_complete_task_flow_and_static_routes(self):
        result = await self.client.post('/api/front-desk/tasks', json={"text": "Prepare a plan", "send_id": "api-task-1"})
        self.assertEqual(result.status_code, 200, result.text)
        task = result.json()
        self.h.threads.append(task["thread_id"])
        await self.h.idle()
        self.assertEqual((await self.client.get('/api/front-desk/work?resolved=1')).status_code, 200)
        self.assertEqual((await self.client.get('/api/front-desk/suggestions')).json(), {"suggestions": []})
        base = '/api/front-desk/tasks/' + task["id"]
        for path in (base, base + '/report'):
            self.assertEqual((await self.client.get(path)).status_code, 200)
        self.assertEqual((await self.client.post(base + '/resolve', json={})).json()["state"], "resolved")
        self.assertEqual((await self.client.post(base + '/reopen', json={})).json()["state"], "ready_for_review")
        self.assertEqual((await self.client.post(base + '/again', json={"turn_count": 1})).status_code, 200)
        for path in ('/api/front-desk/tasks/missing', '/api/front-desk/tasks/missing/report'):
            self.assertEqual((await self.client.get(path)).status_code, 404)
        paths = [r.path for r in routes.router.routes]
        self.assertLess(paths.index('/api/front-desk/suggestions'), paths.index('/api/front-desk/tasks/{task_id}'))

    async def test_suggestion_actions(self):
        response = await self.client.post('/api/front-desk/tasks', json={"text": "Write an outline", "send_id": "api-later-1", "save_for_later": True})
        sid = response.json()["suggestion"]["id"]
        start = await self.client.post('/api/front-desk/suggestions/' + sid + '/start', json={})
        self.assertEqual(start.status_code, 200, start.text)
        self.h.threads.append(start.json()["thread_id"])
        await self.h.idle()
        repeat = await self.client.post('/api/front-desk/suggestions/' + sid + '/start', json={})
        self.assertEqual(start.json()["id"], repeat.json()["id"])
        self.assertEqual((await self.client.post('/api/front-desk/suggestions/missing/hide', json={})).status_code, 404)

    async def test_bounds_extra_fields_and_owner_scoping(self):
        for body in ({"text": "", "send_id": "a"}, {"text": "x" * 4001, "send_id": "long-enough"},
                     {"text": "x", "send_id": "long-enough", "owner": OWNER},
                     {"text": "x", "send_id": "long-enough", "kind": "unknown"},
                     {"text": "x", "send_id": "long-enough", "kind": "make"},
                     {"text": "  ", "send_id": "long-enough"}):
            self.assertEqual((await self.client.post('/api/front-desk/tasks', json=body)).status_code, 422, body)
        self.assertEqual((await self.client.get('/api/front-desk/work?resolved=2')).status_code, 422)
        app.dependency_overrides[require_admin] = lambda: "another-person"
        try:
            self.assertEqual((await self.client.get('/api/front-desk/work')).status_code, 404)
            self.assertEqual((await self.client.get('/api/front-desk/suggestions')).status_code, 404)
        finally:
            app.dependency_overrides[require_admin] = lambda: OWNER


if __name__ == '__main__':
    unittest.main()
