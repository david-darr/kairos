"""Live computer limits and person browser navigation without Docker or DNS."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-computer-limits-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import computer, permissions
from services import bot_workbench as state


class LimitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 100
        self.manager = computer.ComputerManager(clock=lambda: self.now)
        self.stopped = []
        async def stop(owner):
            self.stopped.append(owner)
            self.manager._computers.pop(owner, None)
        self.manager._stop = stop
        async def start(owner, **kwargs): return computer.Computer(owner, None, owner, last_action=self.now)
        self.manager._start = AsyncMock(side_effect=start)
        state.set_computer_settings(2, 10)

    async def asyncTearDown(self):
        await self.manager.close_all()

    async def test_bounds_live_idle_and_eviction_protection(self):
        for cap, idle in ((0, 10), (9, 10), (True, 10), (2, 4), (2, 1441)):
            with self.assertRaises(ValueError): state.set_computer_settings(cap, idle)
        for field in ("taken_over", "waiting_model", "recording"):
            self.manager._computers.clear()
            protected = await self.manager._get("chat:protected")
            setattr(protected, field, True)
            self.now += 1
            await self.manager._get("chat:idle")
            self.now += 1
            await self.manager._get("chat:new")
            self.assertIn("chat:protected", self.manager._computers)
            self.assertNotIn("chat:idle", self.manager._computers)
        self.now += 301
        state.set_computer_settings(1, 5)
        await self.manager._close_idle()
        self.assertEqual(list(self.manager._computers), ["chat:protected"])
        self.manager._computers["chat:protected"].recording = False
        await self.manager._close_idle()
        self.assertFalse(self.manager.running())

    async def test_fifo_queue_position_cancellation_and_release(self):
        state.set_computer_settings(1, 5)
        c = await self.manager._get("chat:held")
        c.taken_over = True
        first = asyncio.create_task(self.manager._get("chat:first"))
        second = asyncio.create_task(self.manager._get("chat:second"))
        try:
            await asyncio.sleep(0.02)
            self.assertEqual(self.manager.wait_position("chat:first"), 1)
            self.assertEqual(self.manager.wait_position("chat:second"), 2)
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
            self.assertEqual(self.manager.wait_position("chat:second"), 1)
            c.taken_over = False
            result = await asyncio.wait_for(second, 2)
            self.assertEqual(result.owner, "chat:second")
        finally:
            first.cancel(); second.cancel()
            await asyncio.gather(first, second, return_exceptions=True)
        self.assertEqual(self.manager._waiters, [])

    async def test_person_navigation_approves_host_and_refuses_private(self):
        c = await self.manager._get("agent:nonexistent")
        c.taken_over = True
        self.manager._send = AsyncMock(return_value={"url": "https://example.com", "title": "Page"})
        public = [(2, 1, 6, '', ('93.184.216.34', 443))]
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", AsyncMock(return_value=public)), patch.object(computer.permissions, "decide", AsyncMock(return_value=permissions.Decision("allow"))) as approve:
            await self.manager.person_input(c.owner, "navigate", {"url": "https://example.com"})
            self.assertEqual(approve.await_args.kwargs["target"], "example.com")
            self.assertEqual(self.manager._send.await_args.args[1], "person_navigate")
            self.assertEqual(c.url, "https://example.com")
            for url in ("file:///private", "javascript:alert(1)", "http://localhost", "http://service.local", "https://user:secret@example.com"):
                with self.assertRaises(ValueError): await self.manager.person_input(c.owner, "navigate", {"url": url})
        with patch.object(loop, "getaddrinfo", AsyncMock(return_value=[(2, 1, 6, '', ('10.0.0.1', 443))])):
            with self.assertRaisesRegex(ValueError, "Private"):
                await self.manager.person_input(c.owner, "navigate", {"url": "https://private.example"})
        c.taken_over = False
        with self.assertRaisesRegex(ValueError, "take over"):
            await self.manager.person_input(c.owner, "reload", {})


if __name__ == "__main__": unittest.main()
