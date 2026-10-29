"""Bots redesign, Phase 6 wiring: computer help (2026-10-29).

The request_help tool is registered for bots only and raises one help request from the bot's own identity; a typed
reply in that conversation settles it ("answer in chat"); a reply elsewhere leaves it open.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_help_wiring.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-help-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import Harness  # noqa: E402
from core import tool_registry  # noqa: E402
from services import bot_help  # noqa: E402


class HelpWiringTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Browser")
        self.sid = self.h.thread(self.bot)
        self.other = self.h.thread(self.bot, title="Other")
        patcher = patch("core.computer.manager.hand_back", create=True)
        patcher.start(); self.addCleanup(patcher.stop)

    def test_registered_for_bots_only(self):
        spec = tool_registry._REGISTRY["request_help"]
        self.assertTrue(spec.agent_only)
        self.assertEqual(spec.effect, tool_registry.WRITE)

    async def test_the_tool_raises_from_the_bots_own_identity(self):
        ctx = tool_registry.ToolContext(agent_id=self.bot["id"], session_id=self.sid, is_admin=True)
        with patch("core.permissions.gate_bot_call", new=AsyncMock(return_value=_allow())):
            text = await tool_registry.call("request_help", {"reason": "Sign in please", "site": "example.com"}, ctx, tool_registry.OPENAI)
        self.assertIn("sign in to example.com", text)
        item = bot_help.current(self.bot["id"])
        self.assertEqual((item["type"], item["site"], item["thread_id"]), ("sign_in", "example.com", self.sid))
        with patch("core.permissions.gate_bot_call", new=AsyncMock(return_value=_allow())):
            refused = await tool_registry.call("request_help", {"reason": "x", "site": "evil.com/path"}, ctx, tool_registry.OPENAI)
        self.assertTrue(refused.startswith("Not run:"), refused)

    async def test_a_reply_here_settles_it_and_a_reply_elsewhere_does_not(self):
        bot_help.raise_help(self.bot["id"], "Take over please", None, self.sid)
        await self.h.send(self.other, "unrelated")
        await self.h.idle()
        self.assertIsNotNone(bot_help.current(self.bot["id"]), "a reply in another conversation leaves it open")
        await self.h.send(self.sid, "done, carry on")
        await self.h.idle()
        self.assertIsNone(bot_help.current(self.bot["id"]), "a reply in its conversation answers it")


def _allow():
    from core.permissions import Decision
    return Decision("allow", "")


if __name__ == "__main__":
    unittest.main()
