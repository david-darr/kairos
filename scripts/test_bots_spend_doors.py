"""Bots redesign, Phase 6 wiring: the monthly spend cap refuses at both admission doors (2026-10-29).

A person's send (services/bot_chat_service.send) answers 409 with X-Reason spend_cap; background work
(services/agent_service.run) raises AdmissionDenied with the cap text. Under the cap both go ahead.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_spend_doors.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-spend-doors-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException  # noqa: E402
from bots_chat_harness import Harness  # noqa: E402
from services import bot_spend  # noqa: E402
from services.agent_service import AdmissionDenied, agent_service  # noqa: E402

CAPPED = {"monthly_usd": 1.0, "warn_percent": 80, "month": "2026-10", "spent_usd": 2.0, "capped": True, "near_cap": True,
          "unknown_cost_runs": 0}
UNDER = {**CAPPED, "spent_usd": 0.1, "capped": False, "near_cap": False}


class SpendDoorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Spender")
        self.sid = self.h.thread(self.bot)

    async def test_a_capped_month_refuses_a_send(self):
        with patch.object(bot_spend, "budget", return_value=CAPPED):
            with self.assertRaises(HTTPException) as refused:
                await self.h.send(self.sid, "one more thing")
        self.assertEqual(refused.exception.status_code, 409)
        self.assertEqual(refused.exception.headers.get("X-Reason"), "spend_cap")
        self.assertEqual(refused.exception.detail, bot_spend.CAP_TEXT)
        self.assertFalse([row for row in self.h.path(self.sid) if row.get("role") == "user"], "nothing was added")

    async def test_a_capped_month_refuses_background_work(self):
        with patch.object(bot_spend, "budget", return_value=CAPPED):
            with self.assertRaises(AdmissionDenied) as refused:
                with agent_service.run(self.bot["id"]):
                    self.fail("the run must not start")
        self.assertEqual(str(refused.exception), bot_spend.CAP_TEXT)

    async def test_under_the_cap_both_doors_admit(self):
        with patch.object(bot_spend, "budget", return_value=UNDER):
            with agent_service.run(self.bot["id"]):
                pass
            await self.h.send(self.sid, "go ahead")
            await self.h.idle()
        self.assertTrue([row for row in self.h.path(self.sid) if row.get("role") == "user"])


if __name__ == "__main__":
    unittest.main()
