"""Bots redesign, Phase 3 unit U5: bot-made automation changes with Undo (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 8 (U5) and 9.
The real tools through the registry, the real task and trigger services, the real routes,
a throwaway data folder. Run: python -B -X utf8 scripts/test_bots_automation_changes.py
"""
import dataclasses
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-changes-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import bot_automation_tools as tools  # noqa: E402
from core import tool_registry  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from core.secret_storage import decrypt  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import bot_automation_change_routes  # noqa: E402
from services import bot_automation_changes as changes  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402
from services.trigger_service import trigger_service  # noqa: E402

app = FastAPI()
app.include_router(bot_automation_change_routes.router)
USER = {"name": "david"}
app.dependency_overrides[require_admin] = lambda: USER["name"]
API = {"id": "api1", "kind": "api", "model": "m"}
CLAUDE = {"id": "claude", "kind": "claude_cli"}


@dataclasses.dataclass(frozen=True)
class Ctx(tool_registry.ToolContext):
    """The registry owner adds a trusted invocation id to ToolContext; tests carry one the same way."""
    invocation_id: Optional[str] = None


class Crash(BaseException):
    """A process dying: not an error the code under test may catch."""


def future(days=2):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + days * 86400))


class ChangeCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        USER["name"] = "david"
        for patcher in (patch.dict(agent_service._agents, {}, clear=True),
                        patch("core.model_endpoints.list_endpoints", return_value=[CLAUDE, API]),
                        patch("core.model_endpoints.get_endpoint", side_effect=lambda i: {"claude": CLAUDE, "api1": API}.get(i))):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.path = os.path.join(_DATA.name, f"changes-{time.time_ns()}.json")
        self.store = changes.reset_for_test(self.path)
        changes.set_backend("routine", None)
        # These fault injections exercise the legacy backend's write boundaries.
        changes.set_backend("routine", changes.TaskRoutineBackend())
        self.addCleanup(lambda: changes.set_backend("routine", None))
        changes.set_backend("trigger", None)
        self.bot = agent_service.create("Scout", role="Watches postings")
        self.other_bot = agent_service.create("Archivist")
        self.session = self.make_session(self.bot)
        self.addCleanup(self.cleanup_work)

    def cleanup_work(self):
        for task_id in list(task_service._tasks):
            task_service.delete_task(task_id)
        for trigger in list(trigger_service.triggers()):
            trigger_service.delete(trigger["id"])

    def make_session(self, bot, owner="david", **flags):
        session = session_manager.create_session("Chat", owner_user=owner)
        session_manager.set_agent(session["id"], bot["id"], "frozen prompt", unattended=bool(flags.get("unattended")))
        self.addCleanup(lambda sid=session["id"]: session_manager.get_session(sid) and session_manager.delete_session(sid))
        return session["id"]

    def ctx(self, bot=None, session=None, taint=None, **extra):
        return Ctx(session_id=session or self.session, agent_id=(bot or self.bot)["id"],
                                         is_admin=True, turn_taint=taint, **extra)

    async def call(self, name, args, **kw):
        return await tool_registry.call(name, args, self.ctx(**kw), "claude")

    def routine_args(self, **extra):
        return {"name": "Morning brief", "instructions": "Summarize my inbox.",
                "schedule": {"kind": "daily", "time": "08:00", "time_zone": "America/New_York"}, **extra}

    def receipts(self):
        return self.store.list_receipts("david")

    def routines(self):
        return [t for t in task_service.list_tasks() if t.get("agent_id") == self.bot["id"]]


class Registration(ChangeCase):
    def test_the_five_tools_register_once_for_bots_only(self):
        added = tools.register_tools()
        self.assertEqual(sorted(tools.register_tools()), [], "a second call adds nothing")
        names = {"schedule_routine", "manage_routine", "create_trigger", "manage_trigger", "trigger_info"}
        self.assertTrue(names.issuperset(added))
        self.assertTrue(names.issubset({s.name for s in tool_registry.specs("claude", is_admin=True, agent=True)}))
        self.assertFalse(names & {s.name for s in tool_registry.specs("claude", is_admin=True, agent=False)})
        for spec in tool_registry._REGISTRY.values():
            if spec.name in names:
                self.assertNotIn("—", spec.description)
        effects = {s.name: s.effect for s in tool_registry._REGISTRY.values() if s.name in names}
        self.assertEqual(effects["trigger_info"], "read")
        self.assertEqual(effects["schedule_routine"], "write")


class RoutineChanges(ChangeCase):
    def setUp(self):
        super().setUp()
        tools.register_tools()

    async def test_schedule_routine_applies_at_once_with_a_receipt(self):
        text = await self.call("schedule_routine", self.routine_args())
        self.assertTrue(text.startswith('Added routine "Morning brief": every day at 08:00 (America/New_York).'), text)
        task, = self.routines()
        self.assertEqual((task["agent_id"], task["owner_user"], task["schedule_kind"], task["run_time"], task["enabled"]),
                         (self.bot["id"], "david", "daily", "08:00", True))
        receipt, = self.receipts()
        self.assertEqual((receipt["state"], receipt["action"], receipt["thread_id"], receipt["undoable"]),
                         ("applied", "create", self.session, True))
        self.assertIn("Undo", text)
        self.assertTrue(any(row["label"] == "name" and row["after"] == "Morning brief" for row in receipt["details"]))
        self.assertNotIn("before", receipt)

    async def test_the_owner_and_bot_come_from_the_turn_never_the_arguments(self):
        text = await self.call("schedule_routine", self.routine_args(agent_id=self.other_bot["id"], owner_user="mallory"))
        self.assertTrue(text.startswith("Not run: Unknown routine setting: agent_id, owner_user"), text)
        self.assertEqual(task_service.list_tasks(), [])
        await self.call("schedule_routine", self.routine_args())
        self.assertEqual(self.routines()[0]["agent_id"], self.bot["id"])
        self.assertEqual(self.routines()[0]["owner_user"], "david")

    async def test_attachments_and_owner_only_settings_are_refused(self):
        for field in ("attachments", "results_thread_id", "source_thread_id", "run_on_startup"):
            text = await self.call("schedule_routine", self.routine_args(**{field: ["x"]}))
            self.assertTrue(text.startswith("Not run:") and "routine editor" in text, (field, text))
        self.assertEqual(task_service.list_tasks(), [])
        self.assertEqual(self.receipts(), [])

    async def test_a_retry_with_the_same_invocation_applies_once(self):
        first = await self.call("schedule_routine", self.routine_args(), invocation_id="inv-1")
        second = await self.call("schedule_routine", self.routine_args(), invocation_id="inv-1")
        self.assertEqual(len(self.routines()), 1)
        self.assertIn("already applied", second)
        self.assertEqual(first.split("Receipt ")[1].split(".")[0], second.split("Receipt ")[1].split(".")[0])
        # A new request for the same name later is a duplicate, not a second routine.
        third = await self.call("schedule_routine", self.routine_args(), invocation_id="inv-2")
        self.assertTrue(third.startswith("Not run:") and "already exists" in third, third)
        self.assertEqual(len(self.routines()), 1)

    async def test_undo_a_create_removes_it_and_a_second_undo_is_a_no_op(self):
        await self.call("schedule_routine", self.routine_args())
        receipt, = self.receipts()
        done = self.store.undo(receipt["id"], "david")
        self.assertEqual(done["state"], "undone")
        self.assertEqual(self.routines(), [])
        again = self.store.undo(receipt["id"], "david")
        self.assertTrue(again["already_undone"])
        self.assertEqual(self.routines(), [])

    async def test_update_then_undo_restores_the_old_settings(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        text = await self.call("manage_routine", {"action": "update", "routine_id": task_id, "settings": {
            "name": "Evening brief", "schedule": {"kind": "daily", "time": "18:30", "time_zone": "America/New_York",
                                                    "weekdays": [0, 1, 2, 3, 4]}}})
        self.assertTrue(text.startswith('Changed routine "Evening brief"'), text)
        task = task_service.get_task(task_id)
        self.assertEqual((task["name"], task["run_time"], task["weekdays"]), ("Evening brief", "18:30", [0, 1, 2, 3, 4]))
        receipt = [r for r in self.receipts() if r["action"] == "update"][0]
        labels = {row["label"]: (row["before"], row["after"]) for row in receipt["details"]}
        self.assertEqual(labels["name"], ("Morning brief", "Evening brief"))
        self.store.undo(receipt["id"], "david")
        task = task_service.get_task(task_id)
        self.assertEqual((task["name"], task["run_time"], task.get("weekdays")), ("Morning brief", "08:00", None))
        self.assertTrue(task["next_run_at"])

    async def test_a_stale_undo_refuses_and_changes_nothing(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        await self.call("manage_routine", {"action": "update", "routine_id": task_id, "settings": {"name": "Renamed by bot"}})
        receipt = [r for r in self.receipts() if r["action"] == "update"][0]
        task_service.update_task(task_id, name="Renamed by the person")  # a later edit
        with self.assertRaises(changes.ChangeRefused) as raised:
            self.store.undo(receipt["id"], "david")
        self.assertEqual(raised.exception.code, "stale")
        self.assertEqual(task_service.get_task(task_id)["name"], "Renamed by the person")
        again = self.store.get(receipt["id"], "david")
        self.assertEqual(again["state"], "applied", "the receipt stays for another try")
        self.assertIn("changed", self.store._receipts[receipt["id"]]["last_undo_error"])

    async def test_undoing_the_create_after_a_later_edit_refuses(self):
        await self.call("schedule_routine", self.routine_args())
        receipt, = self.receipts()
        task_service.update_task(self.routines()[0]["id"], prompt="Something else now")
        with self.assertRaises(changes.ChangeRefused) as raised:
            self.store.undo(receipt["id"], "david")
        self.assertEqual(raised.exception.code, "stale")
        self.assertEqual(len(self.routines()), 1)

    async def test_pause_and_resume_and_their_undo(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        self.assertTrue((await self.call("manage_routine", {"action": "pause", "routine_id": task_id})).startswith("Paused"))
        self.assertFalse(task_service.get_task(task_id)["enabled"])
        again = await self.call("manage_routine", {"action": "pause", "routine_id": task_id})
        self.assertIn("already paused", again)
        pause = [r for r in self.receipts() if r["action"] == "pause"][0]
        self.store.undo(pause["id"], "david")
        self.assertTrue(task_service.get_task(task_id)["enabled"])
        await self.call("manage_routine", {"action": "pause", "routine_id": task_id})
        self.assertTrue((await self.call("manage_routine", {"action": "resume", "routine_id": task_id})).startswith("Resumed"))
        self.assertTrue(task_service.get_task(task_id)["enabled"])

    async def test_delete_keeps_a_tombstone_and_undo_restores_the_same_routine(self):
        await self.call("schedule_routine", self.routine_args())
        before = dict(self.routines()[0])
        text = await self.call("manage_routine", {"action": "delete", "routine_id": before["id"]})
        self.assertTrue(text.startswith("Deleted"))
        self.assertIsNone(task_service.get_task(before["id"]))
        receipt = [r for r in self.receipts() if r["action"] == "delete"][0]
        self.store.undo(receipt["id"], "david")
        back = task_service.get_task(before["id"])
        self.assertEqual((back["name"], back["prompt"], back["run_time"], back["owner_user"], back["agent_id"]),
                         (before["name"], before["prompt"], before["run_time"], "david", self.bot["id"]))
        self.assertTrue(back["next_run_at"])

    async def test_undoing_a_delete_never_overwrites_something_new(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        await self.call("manage_routine", {"action": "delete", "routine_id": task_id})
        receipt = [r for r in self.receipts() if r["action"] == "delete"][0]
        task_service._tasks[task_id] = {"id": task_id, "name": "Squatter", "schedule_kind": "daily", "agent_id": self.bot["id"],
                                        "enabled": True, "prompt": "x", "run_time": "01:00", "created_at": time.time()}
        with self.assertRaises(changes.ChangeRefused):
            self.store.undo(receipt["id"], "david")
        self.assertEqual(task_service.get_task(task_id)["name"], "Squatter")

    async def test_the_undo_window_closes(self):
        await self.call("schedule_routine", self.routine_args())
        receipt, = self.receipts()
        self.store._receipts[receipt["id"]]["undo_expires_at"] = time.time() - 1
        self.assertFalse(self.store.get(receipt["id"], "david")["undoable"])
        with self.assertRaises(changes.ChangeRefused) as raised:
            self.store.undo(receipt["id"], "david")
        self.assertEqual(raised.exception.code, "expired")

    async def test_a_failed_inverse_leaves_the_receipt_for_another_try(self):
        await self.call("schedule_routine", self.routine_args())
        receipt, = self.receipts()
        with patch.object(changes.TaskRoutineBackend, "delete", side_effect=OSError("disk is full")):
            with self.assertRaises(changes.ChangeRefused):
                self.store.undo(receipt["id"], "david")
        self.assertEqual(self.store.get(receipt["id"], "david")["state"], "applied")
        self.assertEqual(self.store.undo(receipt["id"], "david")["state"], "undone")

    async def test_a_bot_manages_only_its_own_routines(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        other_session = self.make_session(self.other_bot)
        for args in ({"action": "pause"}, {"action": "delete"}, {"action": "update", "settings": {"name": "Mine now"}}):
            text = await self.call("manage_routine", {**args, "routine_id": task_id}, bot=self.other_bot, session=other_session)
            self.assertEqual(text, "Not run: No routine of yours has that id.", args)
        self.assertEqual(task_service.get_task(task_id)["name"], "Morning brief")
        listing = await self.call("manage_routine", {"action": "list"}, bot=self.other_bot, session=other_session)
        self.assertEqual(listing, "You have no routines.")

    async def test_another_persons_session_cannot_reach_it(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        mallory = self.make_session(self.bot, owner="mallory")
        text = await self.call("manage_routine", {"action": "delete", "routine_id": task_id}, session=mallory)
        self.assertTrue(text.startswith("Not run:"), text)
        self.assertIsNotNone(task_service.get_task(task_id))
        with self.assertRaises(changes.ChangeRefused) as raised:
            self.store.undo(self.receipts()[0]["id"], "mallory")
        self.assertEqual(raised.exception.status, 404)

    async def test_a_conversation_of_another_bot_is_refused(self):
        text = await self.call("schedule_routine", self.routine_args(), bot=self.other_bot)
        self.assertEqual(text, "Not run: This conversation belongs to another bot.")

    async def test_an_unattended_run_may_only_pause(self):
        quiet = self.make_session(self.bot, unattended=True)
        text = await self.call("schedule_routine", self.routine_args(), session=quiet)
        self.assertTrue(text.startswith("Not run: This run started without the person"), text)
        self.assertEqual(task_service.list_tasks(), [])
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        for action in ("delete", "resume"):
            self.assertTrue((await self.call("manage_routine", {"action": action, "routine_id": task_id}, session=quiet)).startswith("Not run:"))
        self.assertTrue((await self.call("manage_routine", {"action": "pause", "routine_id": task_id}, session=quiet)).startswith("Paused"))

    async def test_a_turn_that_read_outside_content_is_flagged(self):
        taint = TurnTaint()
        taint.mark("web page")
        text = await self.call("schedule_routine", self.routine_args(), taint=taint)
        self.assertIn("read outside content", text)
        self.assertTrue(self.receipts()[0]["tainted"])

    async def test_bad_schedules_are_refused_with_a_reason(self):
        cases = [
            ({"kind": "once", "at": "2020-01-01T09:00:00+00:00"}, "already passed"),
            ({"kind": "daily", "time": "25:00"}, "HH:MM"),
            ({"kind": "daily", "time": "08:00", "time_zone": "Mars/Base"}, "IANA"),
            ({"kind": "daily", "time": "08:00", "weekdays": [7]}, "weekdays"),
            ({"kind": "interval", "every_minutes": 4}, "5 to 1440"),
            ({"kind": "interval", "every_minutes": 60, "window": {"start": "22:00", "end": "06:00"}}, "two routines"),
            ({"kind": "interval", "every_minutes": 120, "window": {"start": "09:00", "end": "10:00"}}, "one interval"),
            ({"kind": "cron", "expression": "* * * *", "time_zone": "UTC"}, "five fields"),
            ({"kind": "cron", "expression": "0 9 * * 1", "time_zone": None}, "time_zone"),
            ({"kind": "cron", "expression": "0 0 1 */2 * *", "time_zone": "UTC"}, "five fields"),
            ({"kind": "weekly"}, "once, daily"),
        ]
        for schedule, expected in cases:
            text = await self.call("schedule_routine", self.routine_args(schedule=schedule))
            self.assertTrue(text.startswith("Not run:") and expected in text, (schedule, text))
        self.assertEqual(task_service.list_tasks(), [])

    async def test_a_future_once_routine_and_an_interval_one_work(self):
        self.assertTrue((await self.call("schedule_routine", self.routine_args(
            name="Remind me", schedule={"kind": "once", "at": future()}))).startswith("Added"))
        self.assertTrue((await self.call("schedule_routine", self.routine_args(
            name="Check often", schedule={"kind": "interval", "every_minutes": 30}))).startswith("Added"))
        kinds = sorted(t["schedule_kind"] for t in self.routines())
        self.assertEqual(kinds, ["interval", "once"])

    async def test_what_the_task_service_cannot_do_is_refused_clearly(self):
        cron = await self.call("schedule_routine", self.routine_args(
            schedule={"kind": "cron", "expression": "0 9 * * 1", "time_zone": "UTC"}))
        self.assertIn("full routines engine", cron)
        overlap = await self.call("schedule_routine", self.routine_args(overlap="queue"))
        self.assertIn("full routines engine", overlap)
        self.assertEqual(task_service.list_tasks(), [])
        failed = [r for r in self.store._receipts.values() if r["state"] == "failed"]
        self.assertEqual(len(failed), 2)

    async def test_an_engine_backend_takes_over_when_installed(self):
        class Engine(changes.TaskRoutineBackend):
            created = []

            def create(self, owner, bot_id, spec, application_id):
                self.created.append(spec["schedule"]["kind"])
                return super().create(owner, bot_id, {**spec, "schedule": {"kind": "daily", "time": "07:00", "time_zone": None}}, application_id)
        changes.set_backend("routine", Engine())
        self.addCleanup(changes.set_backend, "routine", None)
        text = await self.call("schedule_routine", self.routine_args(
            schedule={"kind": "cron", "expression": "0 7 * * *", "time_zone": "UTC"}))
        self.assertTrue(text.startswith("Added"), text)
        self.assertEqual(Engine.created, ["cron"])

    async def test_a_bot_cannot_collect_unlimited_routines_or_changes(self):
        with patch.object(changes, "MAX_ROUTINES_PER_BOT", 2):
            await self.call("schedule_routine", self.routine_args(name="One"))
            await self.call("schedule_routine", self.routine_args(name="Two"))
            text = await self.call("schedule_routine", self.routine_args(name="Three"))
            self.assertIn("already has 2", text)
        with patch.object(changes, "MAX_CHANGES_PER_HOUR", 2):
            text = await self.call("manage_routine", {"action": "pause", "routine_id": self.routines()[0]["id"]})
            self.assertIn("changed a lot", text)

    async def test_list_shows_the_bots_routines(self):
        await self.call("schedule_routine", self.routine_args())
        rows = json.loads(await self.call("manage_routine", {"action": "list"}))["routines"]
        self.assertEqual([(r["name"], r["enabled"], r["when"]) for r in rows],
                         [("Morning brief", True, "every day at 08:00 (America/New_York)")])


class CrashRecovery(ChangeCase):
    def setUp(self):
        super().setUp()
        tools.register_tools()

    async def test_a_crash_after_the_target_write_finishes_the_receipt_without_a_second_routine(self):
        with patch.object(changes.ChangeStore, "_finish", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("schedule_routine", self.routine_args())
        self.assertEqual(len(self.routines()), 1, "the write landed")
        pending, = self.store._receipts.values()
        self.assertEqual(pending["state"], "pending")
        restarted = changes.reset_for_test(self.path)
        done = restarted.reconcile()
        self.assertEqual([r["state"] for r in done], ["applied"])
        self.assertEqual(len(self.routines()), 1, "still one routine")
        self.assertEqual(done[0]["target_id"], self.routines()[0]["id"])
        # And Undo works from the reconciled receipt.
        restarted.undo(done[0]["id"], "david")
        self.assertEqual(self.routines(), [])

    async def test_a_crash_before_the_write_fails_the_receipt_and_creates_nothing(self):
        with patch.object(changes.TaskRoutineBackend, "create", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("schedule_routine", self.routine_args())
        self.assertEqual(self.routines(), [])
        restarted = changes.reset_for_test(self.path)
        done = restarted.reconcile()
        self.assertEqual([r["state"] for r in done], ["failed"])
        self.assertEqual(self.routines(), [])
        self.assertTrue((await self.call("schedule_routine", self.routine_args())).startswith("Added"))

    async def test_a_crash_between_create_and_its_tag_is_still_one_routine_on_retry(self):
        service = task_service
        real = service._save_tasks
        calls = {"n": 0}

        def crash_on_tag():
            calls["n"] += 1
            real()
            if calls["n"] == 2:  # create_task's own save, then the tag's
                raise Crash()
        with patch.object(service, "_save_tasks", crash_on_tag):
            with self.assertRaises(Crash):
                await self.call("schedule_routine", self.routine_args(), invocation_id="inv-9")
        self.assertEqual(len(self.routines()), 1)
        restarted = changes.reset_for_test(self.path)
        self.assertEqual([r["state"] for r in restarted.reconcile()], ["applied"])
        again = await self.call("schedule_routine", self.routine_args(), invocation_id="inv-9")
        self.assertIn("already applied", again)
        self.assertEqual(len(self.routines()), 1)

    async def test_a_crash_after_an_update_finishes_from_the_target_state(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        with patch.object(changes.ChangeStore, "_finish", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("manage_routine", {"action": "update", "routine_id": task_id, "settings": {"name": "Brief 2"}})
        restarted = changes.reset_for_test(self.path)
        states = [r["state"] for r in restarted.reconcile()]
        self.assertEqual(states, ["applied"])
        receipt = [r for r in restarted.list_receipts("david") if r["action"] == "update"][0]
        restarted.undo(receipt["id"], "david")
        self.assertEqual(task_service.get_task(task_id)["name"], "Morning brief")

    async def test_a_crash_before_an_update_lands_fails_the_receipt(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        with patch.object(changes.TaskRoutineBackend, "update", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("manage_routine", {"action": "update", "routine_id": task_id, "settings": {"name": "Brief 2"}})
        restarted = changes.reset_for_test(self.path)
        self.assertEqual([r["state"] for r in restarted.reconcile()], ["failed"])
        self.assertEqual(task_service.get_task(task_id)["name"], "Morning brief")

    async def test_a_crash_after_a_delete_keeps_the_tombstone(self):
        await self.call("schedule_routine", self.routine_args())
        task_id = self.routines()[0]["id"]
        with patch.object(changes.ChangeStore, "_finish", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("manage_routine", {"action": "delete", "routine_id": task_id})
        restarted = changes.reset_for_test(self.path)
        done = restarted.reconcile()
        self.assertEqual([r["state"] for r in done], ["applied"])
        restarted.undo(done[0]["id"], "david")
        self.assertEqual(task_service.get_task(task_id)["name"], "Morning brief")

    async def test_looking_up_a_pending_receipt_reconciles_it(self):
        with patch.object(changes.ChangeStore, "_finish", side_effect=Crash()):
            with self.assertRaises(Crash):
                await self.call("schedule_routine", self.routine_args())
        receipt, = self.store._receipts.values()
        self.assertEqual(self.store.undo(receipt["id"], "david")["state"], "undone")
        self.assertEqual(self.routines(), [])


class TriggerChanges(ChangeCase):
    def setUp(self):
        super().setUp()
        tools.register_tools()

    def triggers(self):
        return [t for t in trigger_service.triggers() if t.get("agent_id") == self.bot["id"]]

    async def test_create_trigger_never_reveals_the_address_or_secret(self):
        text = await self.call("create_trigger", {"name": "Repo pushes", "instructions": "Review the push.",
                                                  "events": ["push"], "conditions": [{"path": "ref", "equals": "refs/heads/main"}]})
        trigger, = self.triggers()
        secret = decrypt(trigger["secret"])
        self.assertTrue(text.startswith('Added webhook trigger "Repo pushes"'), text)
        self.assertNotIn(secret, text)
        self.assertNotIn("/api/triggers", text)
        self.assertFalse(trigger["auto_run"], "it waits for the person's OK")
        receipt, = self.receipts()
        blob = json.dumps(receipt) + Path(self.path).read_text(encoding="utf-8")
        self.assertNotIn(secret, blob)
        self.assertNotIn("/api/triggers/", blob)
        info = await self.call("trigger_info", {})
        self.assertNotIn(secret, info)
        self.assertNotIn("/api/triggers", info)
        self.assertEqual(json.loads(info)["triggers"][0]["events"], ["push"])

    async def test_a_bot_cannot_turn_on_run_straight_away_or_ask_for_the_address(self):
        for field in ("auto_run", "secret", "address"):
            text = await self.call("create_trigger", {"name": "X", "instructions": "y", field: True})
            self.assertTrue(text.startswith("Not run: Unknown trigger setting"), text)
        self.assertEqual(self.triggers(), [])

    async def test_pause_update_and_undo(self):
        await self.call("create_trigger", {"name": "Repo pushes", "instructions": "Review the push."})
        trigger_id = self.triggers()[0]["id"]
        await self.call("manage_trigger", {"action": "pause", "trigger_id": trigger_id})
        self.assertFalse(trigger_service.get(trigger_id)["enabled"])
        await self.call("manage_trigger", {"action": "update", "trigger_id": trigger_id, "settings": {"events": ["push", "tag"]}})
        self.assertEqual(trigger_service.get(trigger_id)["events"], ["push", "tag"])
        update = [r for r in self.receipts() if r["action"] == "update"][0]
        self.store.undo(update["id"], "david")
        self.assertEqual(trigger_service.get(trigger_id)["events"], [])
        pause = [r for r in self.receipts() if r["action"] == "pause"][0]
        self.store.undo(pause["id"], "david")
        self.assertTrue(trigger_service.get(trigger_id)["enabled"])

    async def test_delete_and_undo_keep_the_same_address_secret(self):
        await self.call("create_trigger", {"name": "Repo pushes", "instructions": "Review the push."})
        trigger = dict(self.triggers()[0])
        secret = decrypt(trigger["secret"])
        await self.call("manage_trigger", {"action": "delete", "trigger_id": trigger["id"]})
        self.assertIsNone(trigger_service.get(trigger["id"]))
        receipt = [r for r in self.receipts() if r["action"] == "delete"][0]
        self.assertNotIn(secret, json.dumps(receipt))
        self.store.undo(receipt["id"], "david")
        back = trigger_service.get(trigger["id"])
        self.assertEqual(decrypt(back["secret"]), secret, "the same address keeps working")
        self.assertEqual(back["name"], "Repo pushes")

    async def test_triggers_are_the_bots_own(self):
        await self.call("create_trigger", {"name": "Repo pushes", "instructions": "Review the push."})
        trigger_id = self.triggers()[0]["id"]
        other_session = self.make_session(self.other_bot)
        text = await self.call("manage_trigger", {"action": "delete", "trigger_id": trigger_id}, bot=self.other_bot, session=other_session)
        self.assertEqual(text, "Not run: No trigger of yours has that id.")
        self.assertEqual((await self.call("trigger_info", {"trigger_id": trigger_id}, bot=self.other_bot, session=other_session))[:8], "Not run:")
        self.assertIsNotNone(trigger_service.get(trigger_id))

    async def test_app_events_say_plainly_when_they_are_not_there(self):
        with patch.dict(sys.modules, {"services.bot_app_triggers": None}):
            text = await self.call("create_trigger", {"name": "New mail", "instructions": "Triage it.", "source": "app"})
        self.assertTrue(text.startswith("Not run:") and "not available" in text, text)


class Routes(ChangeCase):
    def setUp(self):
        super().setUp()
        tools.register_tools()

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_list_get_and_undo_over_http(self):
        await self.call("schedule_routine", self.routine_args())
        async with self.client() as web:
            listed = (await web.get("/api/bot-automation-changes", params={"bot_id": self.bot["id"]})).json()["changes"]
            self.assertEqual(len(listed), 1)
            self.assertNotIn("application_id", listed[0])
            self.assertNotIn("before", listed[0])
            receipt_id = listed[0]["id"]
            self.assertEqual((await web.get(f"/api/bot-automation-changes/{receipt_id}")).status_code, 200)
            undone = await web.post(f"/api/bot-automation-changes/{receipt_id}/undo")
            self.assertEqual((undone.status_code, undone.json()["state"]), (200, "undone"))
            repeat = await web.post(f"/api/bot-automation-changes/{receipt_id}/undo")
            self.assertEqual((repeat.status_code, repeat.json()["already_undone"]), (200, True))

    async def test_stale_undo_is_a_409_with_a_code_and_another_owner_gets_404(self):
        await self.call("schedule_routine", self.routine_args())
        receipt_id = self.receipts()[0]["id"]
        task_service.update_task(self.routines()[0]["id"], name="Edited by hand")
        task_service._tasks[self.routines()[0]["id"]]["prompt"] = "different"
        async with self.client() as web:
            stale = await web.post(f"/api/bot-automation-changes/{receipt_id}/undo")
            self.assertEqual((stale.status_code, stale.json()["code"]), (409, "stale"))
            USER["name"] = "mallory"
            self.assertEqual((await web.get(f"/api/bot-automation-changes/{receipt_id}")).status_code, 404)
            self.assertEqual((await web.post(f"/api/bot-automation-changes/{receipt_id}/undo")).status_code, 404)
            self.assertEqual((await web.get("/api/bot-automation-changes")).json()["changes"], [])
            USER["name"] = "david"
        self.assertEqual(len(self.routines()), 1)


if __name__ == "__main__":
    unittest.main()
