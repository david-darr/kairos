r"""Notch gaps (A15): who may drive the notch's routes, ownership of answers, and answer latency.

- Folder drops are admin-only; a member or anonymous caller is refused, with real auth.
- A member cannot answer a request that belongs to another person's chat, nor mark it dropped.
- The owner's answer is applied once; the route time from ask to decision is measured (p50/p95).

Run: .venv\Scripts\python.exe -B -X utf8 scripts\test_notch_gaps.py
"""
import asyncio
import os
import statistics
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
environment = tempfile.TemporaryDirectory(prefix="kairos-notch-gaps-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx
from fastapi import FastAPI

from core import middleware, notch_folders, permissions, session_manager_store as store
from core.auth import auth_manager, SESSION_COOKIE_NAME
from core.session_manager import session_manager
from routes import notch_routes, permission_routes


def tearDownModule():
    store.close()
    environment.cleanup()


class NotchAccessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password", is_admin=True)
        auth_manager.create_user("member", "member-password")
        self.files = tempfile.TemporaryDirectory(dir=environment.name)
        self.rules = patch.object(permissions, "PERMISSIONS_FILE", os.path.join(self.files.name, "permissions.json"))
        self.rules.start()
        self.auth = patch.object(middleware, "auth_enabled", return_value=True)
        self.auth.start()
        permissions._session_rules.clear(); permissions._channels.clear(); permissions._pending.clear()
        notch_folders._grants.clear()
        self.app = FastAPI()
        self.app.include_router(notch_routes.router)
        self.app.include_router(permission_routes.router)
        self.folder = os.path.join(self.files.name, "project"); os.makedirs(self.folder)
        self.boss_chat = session_manager.create_session("Boss chat", owner_user="boss")["id"]
        self.member_chat = session_manager.create_session("Member chat", owner_user="member")["id"]

    async def asyncTearDown(self):
        self.auth.stop(); self.rules.stop()
        store.delete_all_sessions()
        self.files.cleanup()

    def client(self, user=None):
        cookies = {SESSION_COOKIE_NAME: auth_manager.create_session(user)} if user else None
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://notch", cookies=cookies)

    async def test_folder_drop_is_admin_only(self):
        body = {"session_id": self.member_chat, "path": self.folder}
        async with self.client() as anon:
            self.assertEqual((await anon.post("/api/notch/folder", json=body)).status_code, 401)
        async with self.client("member") as member:
            self.assertEqual((await member.post("/api/notch/folder", json=body)).status_code, 403)
        self.assertFalse(permissions._pending, "a refused drop asks nothing")

    async def test_dropped_files_mark_only_chats_the_caller_owns(self):
        async with self.client() as anon:
            self.assertEqual((await anon.post("/api/notch/dropped", json={"session_id": self.member_chat})).status_code, 401)
        async with self.client("member") as member:
            self.assertEqual((await member.post("/api/notch/dropped", json={"session_id": self.boss_chat})).status_code, 404)
            self.assertEqual((await member.post("/api/notch/dropped", json={"session_id": self.member_chat})).status_code, 200)

    async def test_a_member_cannot_answer_someone_elses_chat_request(self):
        surface = f"chat:{self.boss_chat}"
        queue = permissions.open_channel(surface)
        decision = asyncio.create_task(permissions.decide(surface=surface, tool="Bash", arguments={"command": "ls"}, timeout=5))
        request = await asyncio.wait_for(queue.get(), 5)
        async with self.client("member") as member:
            self.assertEqual((await member.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})).status_code, 404)
        self.assertFalse(decision.done(), "the stranger's answer decided nothing")
        async with self.client("boss") as boss:
            self.assertEqual((await boss.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})).status_code, 200)
        self.assertEqual((await decision).behavior, "allow")

    async def test_answer_latency_from_ask_to_decision(self):
        surface = f"chat:{self.boss_chat}"
        times = []
        async with self.client("boss") as boss:
            for i in range(60):
                queue = permissions.open_channel(surface)
                decision = asyncio.create_task(permissions.decide(surface=surface, tool="Bash", arguments={"command": f"echo {i}"}, timeout=5))
                request = await asyncio.wait_for(queue.get(), 5)
                started = time.perf_counter()
                response = await boss.post(f"/api/permissions/{request['id']}/answer", json={"choice": "reject"})
                await decision
                times.append((time.perf_counter() - started) * 1000)
                self.assertEqual(response.status_code, 200)
                permissions.close_channel(surface)
        times.sort()
        p50, p95 = statistics.median(times), times[int(len(times) * .95) - 1]
        print(f"\nANSWER route+decision latency over {len(times)}: p50 {p50:.1f} ms, p95 {p95:.1f} ms")
        self.assertLess(p95, 250, "an answer reaches the waiting turn within 250 ms")


if __name__ == "__main__":
    unittest.main()
