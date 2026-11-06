"""Shared stand-ins for the routine suites (test_bots_routines.py,
test_bots_routine_recovery.py): a throwaway data folder, a fake model, bots,
and a way to wait for background routine workers. Import this first: it sets
JARVIS_DATA_DIR before any app module loads.
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="jarvis-routines-test-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
os.environ.pop("NO_COLOR", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import accounts, bot_routine_checks, bot_routine_runner as runner, runs, task_scheduler  # noqa: E402
from services import bot_limit_resets, bot_routines  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402


def iso(offset_seconds: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


class FakeBrain:
    """A stand-in model. `script` is the replies in order (a string, or an
    exception to raise); `gate`, when set, holds a reply until released.
    `contexts` records the routine context each turn ran inside."""
    script: list = []
    prompts: list = []
    contexts: list = []
    started = 0
    gate: "asyncio.Event | None" = None

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        cls = FakeBrain
        cls.started += 1
        cls.prompts.append(prompt)
        cls.contexts.append(runner.current_run())
        step = cls.script.pop(0) if cls.script else "All done."
        if cls.gate is not None:
            await cls.gate.wait()
        if isinstance(step, BaseException):
            raise step
        yield runs.text(step)
        yield runs.result(True)

    @classmethod
    def reset(cls):
        cls.script, cls.prompts, cls.contexts, cls.started, cls.gate = [], [], [], 0, None


class RoutineCase(unittest.IsolatedAsyncioTestCase):
    """A bot, a fake model, no boot hold, and clean-up of everything made."""

    async def asyncSetUp(self):
        FakeBrain.reset()
        self.bots, self.threads = [], []
        self.bot = self.make_bot()
        for target, attribute, value in (
                (task_scheduler, "_task_brain", lambda task: FakeBrain()),
                (task_scheduler, "task_endpoint_id", lambda task: "ep-test"),
                ("core.token_usage.record_usage", None, lambda *a, **k: None)):
            p = patch(target, value) if attribute is None else patch.object(target, attribute, value)
            p.start()
            self.addCleanup(p.stop)
        endpoint = patch.object(agent_service, "chat_endpoint", lambda agent: "ep-test")
        endpoint.start()
        self.addCleanup(endpoint.stop)
        windows = patch.object(bot_limit_resets, "_overlay", lambda force_provider=None: {"providers": [], "models": []})
        windows.start()
        self.addCleanup(windows.stop)
        bot_limit_resets.clear_cache()
        bot_routine_checks.reset_boot(0)
        bot_routine_checks.unregister(kind="mail")
        bot_routine_checks.unregister(kind="calendar")
        bot_routine_checks.unregister(kind="runs")
        bot_routine_checks.unregister(sink="brief")
        runner._inflight.clear()
        runner._active.clear()
        runner._started_up.add(accounts.effective_account())
        self.addCleanup(self._clean)

    def make_bot(self, name=None):
        agent = agent_service.create(name or f"Routine Bot {len(self.bots)}-{time.time_ns() % 100000}")
        self.bots.append(agent["id"])
        return agent

    def _clean(self):
        for task in list(task_service.list_tasks()):
            if task.get("agent_id") in self.bots:
                task_service.delete_task(task["id"])
        for bot_id in self.bots:
            try:
                agent_service.delete(bot_id)
            except Exception:
                pass
        task_scheduler._lanes.clear()

    def routine(self, name="Morning check", schedule=None, **extra):
        schedule = schedule or {"kind": "daily", "time": "09:00", "time_zone": "UTC"}
        task = bot_routines.create_for_owner("local", self.bot["id"], {
            "name": name, "instructions": f"Do the {name}.", "schedule": schedule, **extra})
        return task_service.get_task(task["id"])

    def make_due(self, task_id, seconds_ago=1):
        task = task_service.get_task(task_id)
        task["next_run_at"] = iso(-seconds_ago)
        schedule = (task.get("routine") or {}).get("schedule") or {}
        if schedule.get("kind") == "interval":
            schedule["anchor_at"] = task["next_run_at"]  # keep the due time on the cadence grid
        task_service._save_tasks()
        return task

    async def settle(self, task_id=None):
        """Until background routine workers are done."""
        for _ in range(600):
            busy = bool(runner._inflight) or (task_id and task_scheduler.run_in_progress(task_id))
            if not busy:
                await asyncio.sleep(0.02)
                if not runner._inflight and not (task_id and task_scheduler.run_in_progress(task_id)):
                    return
            await asyncio.sleep(0.01)
        raise AssertionError("routine workers never finished")

    async def until(self, condition, seconds=15):
        for _ in range(int(seconds * 50)):
            if condition():
                return
            await asyncio.sleep(0.02)
        raise AssertionError("the condition never became true")

    async def tick(self, now=None, task_id=None):
        await runner.tick(now)
        await self.settle(task_id)

    def runs_of(self, task_id):
        return task_service.list_runs(task_id)
