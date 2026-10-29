"""Recovery parity, API-only cache upkeep and run-event retention."""
import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_data_support import TestDataDirectory
_data = TestDataDirectory("kairos-recovery-")
os.environ["JARVIS_DATA_DIR"] = _data.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from core import runs, session_manager_store as store
from core.session_manager import session_manager
from services import bot_fallback, bot_keep_warm, bot_sweeps, bot_usage, chat_service


class FallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_order_dedup_five_cap_and_quiet_line(self):
        calls, switched = [], []
        async def attempt(selection):
            calls.append(selection["endpoint_id"])
            if selection["endpoint_id"] != "two": raise ConnectionRefusedError()
            yield runs.text("answer")
        events = [i async for i in bot_fallback.run(attempt, {"endpoint_id": "one"},
                  [{"endpoint_id": "one"}, {"endpoint_id": "two"}], on_switch=switched.append)]
        self.assertEqual(calls, ["one", "two"])
        self.assertEqual(len(switched), 1)
        self.assertEqual(events[0].data["text"], "answer")
        calls.clear()
        with self.assertRaises(ConnectionRefusedError):
            _ = [i async for i in bot_fallback.run(attempt, {"endpoint_id": "one"},
                  [{"endpoint_id": str(n)} for n in range(10)])]
        self.assertEqual(len(calls), 6)

    async def test_started_turn_and_uncertain_failure_never_replayed(self):
        for event in (runs.text("partial"), runs.tool_started("a", "send", {}), runs.usage_event({"input_tokens": 1})):
            calls = []
            async def started(selection):
                calls.append(selection)
                yield event
                raise ConnectionRefusedError()
            with self.assertRaises(ConnectionRefusedError):
                _ = [i async for i in bot_fallback.run(started, {"endpoint_id": "one"}, [{"endpoint_id": "two"}])]
            self.assertEqual(len(calls), 1)
        self.assertFalse(bot_fallback.recoverable(httpx.ReadTimeout("unknown submission")))
        self.assertFalse(bot_fallback.recoverable(RuntimeError("429 in arbitrary text")))

    async def test_streamed_and_plain_chat_parity_and_actual_ledger_model(self):
        primary = dict(id="primary", kind="api", model="primary-model", name="Primary")
        backup = dict(id="backup", kind="api", model="backup-model", name="Backup")
        bot = {"id": "recovery-bot", "fallback": [{"endpoint_id": "backup"}]}
        class Brain:
            model = "backup-model"
            last_usage = {"input_tokens": 10, "output_tokens": 2}
            async def connect(self): pass
            async def disconnect(self): pass
            async def events(self, prompt, stream=True):
                yield runs.text("worked")
                yield runs.usage_event(self.last_usage)
                yield runs.result(True)
        for streamed in (False, True):
            session = session_manager.create_session("Recovery", owner_user="alice")
            sid = session["id"]
            session_manager.set_agent(sid, bot["id"], "You are a bot")
            session_manager.set_model_endpoint(sid, primary["id"])
            with patch("services.agent_service.agent_service.get", return_value=bot), \
                 patch.object(chat_service, "_refresh_bot_prompt", new=AsyncMock()), \
                 patch.object(chat_service, "_resolve_endpoint", return_value=primary), \
                 patch.object(chat_service, "_get_brain", side_effect=ConnectionRefusedError()), \
                 patch.object(chat_service, "_build_brain", return_value=Brain()), \
                 patch("core.model_endpoints.get_endpoint", side_effect=lambda ident: backup if ident == "backup" else primary):
                if streamed:
                    text = "".join([c async for c in chat_service.stream_message(sid, "go", is_admin=True) if isinstance(c, str)])
                else: text = await chat_service.send_message(sid, "go", is_admin=True)
            self.assertEqual(text, "worked")
            saved = session_manager.get_session(sid)
            self.assertEqual(saved["model_endpoint_id"], "primary")
            reply = saved["messages"][-1]
            self.assertEqual(reply["recovery"]["line"], "Answered by Backup.")
            self.assertEqual(store.get_run(reply["run_id"])["endpoint_id"], "backup")
        await asyncio.to_thread(bot_usage.drain)

    async def test_keep_warm_eligibility_clock_three_and_busy(self):
        usage = runs.Usage(cache_write_tokens=100)
        bot = dict(id="warm-bot", cache_keep_warm="on")
        endpoint = dict(id="api", kind="api")
        for kind in ("local", "claude_cli", "codex_cli"):
            self.assertFalse(bot_keep_warm.eligible(bot, {"kind": kind}, usage))
        self.assertFalse(bot_keep_warm.eligible({**bot, "cache_keep_warm": "follow"}, endpoint, usage))
        self.assertFalse(bot_keep_warm.eligible(bot, endpoint, runs.Usage()))
        bot_keep_warm._idle.clear(); bot_keep_warm.start()
        bot_keep_warm.observe(bot, "warm-thread", endpoint, SimpleNamespace(_messages=[], tools=[], model="m"), usage, now=0)
        ping = AsyncMock()
        with patch("services.bot_spend.budget", return_value={"near_cap": False}):
            await bot_keep_warm.tick(269, ping=ping, busy=lambda *a: False)
            self.assertEqual(ping.call_count, 0)
            await bot_keep_warm.tick(270, ping=ping, busy=lambda *a: True)
            self.assertEqual(ping.call_count, 0)
            for at in (270, 540, 810, 1080):
                await bot_keep_warm.tick(at, ping=ping, busy=lambda *a: False)
                await asyncio.sleep(0)
            self.assertEqual(ping.call_count, 3)
        bot_keep_warm.stop()


class SweepTests(unittest.TestCase):
    def test_days_and_size_keep_run_totals_and_ledger(self):
        now = time.time()
        for index, at in enumerate((now - 40 * 86400, now - 2)):
            context = runs.RunContext("task", agent_id="sweep-bot", started_at=at)
            tally = runs.Tally()
            tally.step("checkpoint", detail="x")
            tally.timeline[0]["at"] = at
            runs.record(context, tally, "finished")
        ledger = list(bot_usage.rows(now - 50 * 86400, now + 1))
        result = bot_sweeps.sweep(now)
        self.assertGreaterEqual(result["expired"], 1)
        self.assertEqual(len(list(bot_usage.rows(now - 50 * 86400, now + 1))), len(ledger))
        with store.transaction() as db:
            db.execute("INSERT INTO run_events VALUES ('large',0,?,'checkpoint',NULL,NULL,?,NULL)", (now, "x" * 300000))
        bot_usage.update_settings(event_size_cap_mb=.25)
        self.assertGreater(bot_sweeps.sweep(now)["trimmed"], 0)
        self.assertTrue(store.list_runs())


if __name__ == "__main__": unittest.main()
