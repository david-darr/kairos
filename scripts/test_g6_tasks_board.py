"""Part 2, group g6, area A12 (Tasks, board, triggers, durable work): the gaps
the existing suites (test_durable_work, test_triggers, test_lifecycle,
test_runs) leave open. Everything runs through the real routes and the real
task service with stand-in models and channels; nothing is spent or sent.

Tests named test_BUG_* assert the behaviour the checklist asks for. They FAIL
today and the failure is the bug report (see groups/g6-report.md); do not
"fix" them by loosening the assertion.

Run: python -B -X utf8 scripts/test_g6_tasks_board.py
"""
import asyncio
import json
from contextlib import asynccontextmanager
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_durable_work import Base, SlowBrain, ago, app, started, task_module, task_scheduler  # noqa: E402  (sets the temp data dir)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import outbox, runs, session_manager_store as store  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import task_routes, trigger_routes  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402
from services.trigger_service import trigger_service  # noqa: E402
from services import trigger_service as trigger_module  # noqa: E402

REAL_TASK_BRAIN = task_scheduler._task_brain  # Base.setUp swaps in a stand-in

USER = {"name": "alice"}
ADMINS = {"admin"}


def client_for_users() -> TestClient:
    web = FastAPI()
    web.include_router(task_routes.router)
    web.dependency_overrides[require_user] = lambda: USER["name"]
    return TestClient(web)


class Routes(Base):
    def setUp(self):
        super().setUp()
        USER["name"] = "alice"
        p = patch.object(task_routes.auth_manager, "is_admin", lambda user: user in ADMINS)
        p.start()
        self.addCleanup(p.stop)
        self.web = client_for_users()

        @asynccontextmanager
        async def no_snapshot(source, workspace=None, **_):
            # Every run snapshots the vault and the repo twice (~1.5 s here);
            # see the EFFICIENCY finding. Not what these tests are about.
            yield
        p = patch("core.file_checkpoints.around_turn", no_snapshot)
        p.start()
        self.addCleanup(p.stop)

    def make(self, **body):
        body = {"name": "n", "prompt": "p", "schedule_kind": "interval", "interval_seconds": 3600, **body}
        response = self.web.post("/api/tasks", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.created.append(response.json()["id"])
        return response.json()

    def card_via_route(self, name="card", **body):
        return self.make(name=name, schedule_kind="card", interval_seconds=None, **body)

    def prompts(self):
        seen = []

        def brain_for(task):
            brain = SlowBrain()
            real = brain.events

            async def events(prompt, stream=True):
                seen.append((task["id"], prompt))
                async for e in real(prompt, stream):
                    yield e
            brain.events = events
            return brain
        return seen, patch.object(task_scheduler, "_task_brain", brain_for)


class Validation(Routes):
    """A12 item 1: create/schedule validation through the HTTP boundary."""

    def test_every_bad_schedule_is_a_400_and_stores_nothing(self):
        before = len(task_service.list_tasks())
        bad = [
            {"schedule_kind": "weekly"},
            {"schedule_kind": "interval", "interval_seconds": 0},
            {"schedule_kind": "interval", "interval_seconds": -5},
            {"schedule_kind": "interval", "interval_seconds": None},
            {"schedule_kind": "once"},
            {"schedule_kind": "daily"},
            {"schedule_kind": "daily", "run_time": "25:00"},
            {"schedule_kind": "daily", "run_time": "9am"},
            {"schedule_kind": "daily", "run_time": "09:00", "time_zone": "Mars/Base"},
            {"schedule_kind": "daily", "run_time": "09:00", "weekdays": []},
            {"schedule_kind": "daily", "run_time": "09:00", "weekdays": [7]},
            {"schedule_kind": "interval", "interval_seconds": 60, "weekdays": [1]},
            {"schedule_kind": "card", "time_zone": "UTC"},
            {"schedule_kind": "card", "status": "running"},
            {"schedule_kind": "card", "status": "done"},
            {"schedule_kind": "interval", "interval_seconds": 60, "status": "ready"},
            {"schedule_kind": "interval", "interval_seconds": 60, "depends_on": ["x"]},
            {"schedule_kind": "card", "depends_on": ["no-such-card"]},
            {"schedule_kind": "interval", "interval_seconds": 60, "endpoint_id": "no-such-model"},
        ]
        for body in bad:
            response = self.web.post("/api/tasks", json={"name": "n", "prompt": "p", **body})
            self.assertEqual(response.status_code, 400 if response.status_code != 422 else 422, (body, response.text))
            self.assertIn(response.status_code, (400, 422), body)
        self.assertEqual(len(task_service.list_tasks()), before)

    def test_edits_that_are_invalid_leave_the_task_as_it_was(self):
        task = self.make(schedule_kind="daily", interval_seconds=None, run_time="06:00", time_zone="America/New_York")
        was = json.dumps(task_service.get_task(task["id"]), sort_keys=True)
        for patch_body in ({"time_zone": "Nowhere/Land"}, {"weekdays": [9]}, {"depends_on": ["x"]}, {"endpoint_id": "ghost"}):
            self.assertEqual(self.web.patch(f"/api/tasks/{task['id']}", json=patch_body).status_code, 400, patch_body)
        self.assertEqual(json.dumps(task_service.get_task(task["id"]), sort_keys=True), was)
        self.assertEqual(self.web.patch("/api/tasks/ghost", json={"name": "x"}).status_code, 404)

    def test_pause_edit_enable_run_delete_round_trip(self):
        task = self.make(name="Brief", prompt="say hi")
        tid = task["id"]
        self.assertEqual(self.web.patch(f"/api/tasks/{tid}", json={"enabled": False, "name": "Morning", "prompt": "say hello"}).json()["enabled"], False)
        stored = task_service.get_task(tid)
        self.assertEqual((stored["name"], stored["prompt"], stored["enabled"]), ("Morning", "say hello", False))
        self.assertEqual(task_service.due_tasks(), [], "a paused task is never due")
        task_service.get_task(tid)["next_run_at"] = ago(10)
        self.assertNotIn(tid, [t["id"] for t in task_service.due_tasks()], "paused beats due")
        ran = self.web.post(f"/api/tasks/{tid}/run")
        self.assertEqual(ran.status_code, 200, "Run now works on a paused task")
        self.assertEqual((ran.json()["outcome"], ran.json()["source"], ran.json()["task_name"]), ("succeeded", "manual", "Morning"))
        self.assertFalse(task_service.get_task(tid)["enabled"], "Run now does not re-enable")
        self.assertEqual(self.web.delete(f"/api/tasks/{tid}").json(), {"ok": True})
        self.assertEqual(self.web.get(f"/api/tasks/{tid}").status_code, 404)
        self.assertEqual(self.web.get(f"/api/tasks/{tid}/runs").status_code, 404)
        self.assertEqual(self.web.post(f"/api/tasks/{tid}/run").status_code, 404)

    def test_builtin_automation_enable_is_idempotent_and_disable_keeps_history(self):
        USER["name"] = "admin"  # only an admin may pick a delivery channel
        listed = self.web.get("/api/tasks/builtin").json()
        self.assertTrue(listed and all(not b["enabled"] for b in listed))
        action = listed[0]["action_id"]
        first = self.web.post(f"/api/tasks/builtin/{action}/enable", json={"deliver_to_channel": "discord"}).json()
        self.created.append(first["id"])
        again = self.web.post(f"/api/tasks/builtin/{action}/enable").json()
        self.assertEqual(first["id"], again["id"], "a second Enable reuses the same task")
        self.assertEqual(self.web.post("/api/tasks/builtin/not-real/enable").status_code, 404)
        self.web.patch(f"/api/tasks/{first['id']}", json={"enabled": False})
        shown = {b["action_id"]: b for b in self.web.get("/api/tasks/builtin").json()}
        self.assertEqual((shown[action]["enabled"], shown[action]["task_id"], shown[action]["deliver_to_channel"]), (False, first["id"], "discord"))

    def test_BUG_a_one_shot_with_an_unreadable_time_is_refused_at_create(self):
        """A12 'validation': run_at is stored unparsed. An unreadable value
        makes task_service.is_due raise, and the scheduler's due scan runs
        for every task, so one bad row stops every scheduled task."""
        response = self.web.post("/api/tasks", json={"name": "bad", "prompt": "p", "schedule_kind": "once", "run_at": "tomorrow-ish"})
        if response.status_code == 200:
            self.created.append(response.json()["id"])
        self.assertEqual(response.status_code, 400, "an unparseable run_at must be a 400 (it is stored and poisons the due scan)")

    def test_BUG_one_unreadable_row_cannot_stop_other_tasks_from_running(self):
        good = self.task("good one")
        poisoned = task_service.create_task("poison", "p", "once", run_at="2026-10-28T09:00:00+00:00")
        self.created.append(poisoned["id"])
        poisoned["next_run_at"] = "garbage"  # what a hand-edited or imported file can hold
        task_service._save_tasks()

        async def go():
            await task_scheduler._tick()
            lane = task_scheduler.lane("schedule")
            if lane:
                await lane
        try:
            asyncio.run(go())
        except ValueError as exc:  # the tick itself raised
            self.fail(f"the scheduler tick died on one bad row: {exc}")
        self.assertTrue(task_service.list_runs(good["id"]), "the good due task still ran")


class Ownership(Routes):
    """A12 'preserve owner' + the multi-account rules: a task made by one
    person is not another person's to read, change, run or stop."""

    def test_tasks_are_listed_and_read_only_by_their_owner(self):
        mine = self.make(name="alice's")
        USER["name"] = "bob"
        self.assertEqual(self.web.get(f"/api/tasks/{mine['id']}").status_code, 404)
        self.assertNotIn(mine["id"], [t["id"] for t in self.web.get("/api/tasks").json()])
        self.assertEqual(self.web.get(f"/api/tasks/{mine['id']}/runs").status_code, 404)
        USER["name"] = "admin"
        self.assertIn(mine["id"], [t["id"] for t in self.web.get("/api/tasks").json()], "an admin sees everything")

    def test_the_owner_is_recorded_and_survives_edits_and_runs(self):
        task = self.make(name="mine")
        self.assertEqual(task["owner_user"], "alice")
        self.web.patch(f"/api/tasks/{task['id']}", json={"name": "renamed"})
        self.web.post(f"/api/tasks/{task['id']}/run")
        self.assertEqual(task_service.get_task(task["id"])["owner_user"], "alice")

    def test_BUG_another_user_cannot_change_run_stop_or_delete_my_task(self):
        mine = self.make(name="alice's", prompt="secret plan")
        card = self.card_via_route("alice's card")
        USER["name"] = "bob"
        attempts = {
            "PATCH task": self.web.patch(f"/api/tasks/{mine['id']}", json={"prompt": "exfiltrate"}).status_code,
            "POST run": self.web.post(f"/api/tasks/{mine['id']}/run").status_code,
            "POST stop": self.web.post(f"/api/tasks/{mine['id']}/stop").status_code,
            "POST card status": self.web.post(f"/api/tasks/{card['id']}/status", json={"status": "ready"}).status_code,
            "DELETE task": self.web.delete(f"/api/tasks/{mine['id']}").status_code,
        }
        wrongly_allowed = {k: v for k, v in attempts.items() if v not in (403, 404, 409)}
        # 409 (not running) for stop is acceptable only because nothing runs; the others must be refused outright.
        self.assertEqual({k: v for k, v in wrongly_allowed.items()}, {},
                         f"bob was able to: {sorted(wrongly_allowed)} on alice's work (visible_to is only applied on GET)")


class Board(Routes):
    """A12 item 2: board create/edit/move/dependencies/chaining/review/accept/retry/stop/results."""

    def test_columns_and_what_each_move_allows(self):
        card = self.card_via_route("a")
        self.assertEqual(card["status"], "backlog")
        status = lambda s, note=None: self.web.post(f"/api/tasks/{card['id']}/status", json={"status": s, "note": note})  # noqa: E731
        self.assertEqual(status("ready").status_code, 200)
        self.assertEqual(status("running").status_code, 400, "Running belongs to the dispatcher")
        self.assertEqual(status("nonsense").status_code, 400)
        self.assertEqual(status("review").status_code, 200)
        self.assertEqual(status("done").status_code, 200, "approve")
        self.assertEqual(self.web.post("/api/tasks/ghost/status", json={"status": "ready"}).status_code, 404)
        plain = self.make(name="not a card")
        self.assertEqual(self.web.post(f"/api/tasks/{plain['id']}/status", json={"status": "ready"}).status_code, 404, "a schedule is not a card")

    def test_dependencies_must_be_cards_and_may_not_loop(self):
        a, b, c = (self.card_via_route(n) for n in "abc")
        self.assertEqual(self.web.patch(f"/api/tasks/{b['id']}", json={"depends_on": [a["id"]]}).status_code, 200)
        self.assertEqual(self.web.patch(f"/api/tasks/{c['id']}", json={"depends_on": [b["id"]]}).status_code, 200)
        self.assertEqual(self.web.patch(f"/api/tasks/{a['id']}", json={"depends_on": [c["id"]]}).status_code, 400, "a -> c -> b -> a is a loop")
        self.assertEqual(self.web.patch(f"/api/tasks/{a['id']}", json={"depends_on": [a["id"]]}).status_code, 400, "itself")
        sched = self.make(name="sched")
        self.assertEqual(self.web.patch(f"/api/tasks/{a['id']}", json={"depends_on": [sched["id"]]}).status_code, 400, "a schedule is not a card")
        self.assertEqual(self.web.patch(f"/api/tasks/{sched['id']}", json={"depends_on": [a["id"]]}).status_code, 400)
        self.assertEqual(task_service.get_task(a["id"])["depends_on"], [])

    def test_chain_hands_results_forward_and_waits_for_approval(self):
        first = self.card_via_route("research", prompt="find facts")
        second = self.card_via_route("write", prompt="write it up", depends_on=[first["id"]], status="ready")
        self.web.post(f"/api/tasks/{first['id']}/status", json={"status": "ready"})
        seen, patcher = self.prompts()
        SlowBrain.reply = "FACTS: 42"
        with patcher:
            asyncio.run(task_scheduler.dispatch_cards())
            self.assertEqual(task_service.get_task(first["id"])["status"], "review")
            self.assertIsNone(task_service.next_card(), "the dependent waits while its input is only in Review")
            asyncio.run(task_scheduler.dispatch_cards())
            self.assertEqual(len(seen), 1, "dispatch did not start the waiting card")
            self.web.post(f"/api/tasks/{first['id']}/status", json={"status": "done"})
            SlowBrain.reply = "REPORT"
            asyncio.run(task_scheduler.dispatch_cards())
        self.assertEqual([tid for tid, _ in seen], [first["id"], second["id"]])
        chained = seen[1][1]
        self.assertIn("write it up", chained)
        self.assertIn("FACTS: 42", chained, "the earlier card's result reaches the next one")
        self.assertIn('"research"', chained)
        self.assertEqual(task_service.get_task(second["id"])["status"], "review")
        self.assertEqual(task_service.get_task(second["id"])["comments"][-1]["text"], "REPORT", "the result is on the card")

    def test_request_changes_reruns_with_feedback_and_the_previous_result(self):
        card = self.card_via_route("draft", prompt="draft a post", status="ready")
        seen, patcher = self.prompts()
        with patcher:
            SlowBrain.reply = "first draft"
            asyncio.run(task_scheduler.dispatch_cards())
            moved = self.web.post(f"/api/tasks/{card['id']}/status", json={"status": "ready", "note": "shorter please"})
            self.assertEqual(moved.json()["comments"][-1]["kind"], "feedback")
            SlowBrain.reply = "short draft"
            asyncio.run(task_scheduler.dispatch_cards())
        again = seen[1][1]
        self.assertIn("first draft", again)
        self.assertIn("shorter please", again)
        self.assertNotIn("shorter please", seen[0][1])
        stored = task_service.get_task(card["id"])
        self.assertEqual((stored["status"], stored["attempts"]), ("review", 2))
        runs_ = task_service.list_runs(card["id"])
        self.assertEqual([r["attempt"] for r in runs_], [2, 1], "history keeps each attempt")

    def test_failures_retry_twice_then_block_and_retry_restores_attempts(self):
        card = self.card_via_route("flaky", status="ready")

        class Boom(SlowBrain):
            async def events(self, prompt, stream=True):
                raise RuntimeError("model stopped")
                yield  # pragma: no cover

        with patch.object(task_scheduler, "_task_brain", lambda t: Boom()):
            statuses = []
            for _ in range(3):
                asyncio.run(task_scheduler.dispatch_cards())
                statuses.append(task_service.get_task(card["id"])["status"])
            self.assertEqual(statuses, ["ready", "ready", "blocked"], "one run plus two retries")
            asyncio.run(task_scheduler.dispatch_cards())
            self.assertEqual(task_service.get_task(card["id"])["attempts"], 3, "a blocked card is not retried by itself")
        stored = task_service.get_task(card["id"])
        self.assertIn("model stopped", stored["comments"][-1]["text"])
        self.assertEqual([r["outcome"] for r in task_service.list_runs(card["id"])], ["failed"] * 3)
        self.web.post(f"/api/tasks/{card['id']}/status", json={"status": "ready"})
        self.assertEqual(task_service.get_task(card["id"])["attempts"], 0, "Blocked -> Ready is a fresh retry")
        asyncio.run(task_scheduler.dispatch_cards())
        self.assertEqual(task_service.get_task(card["id"])["status"], "review")

    def test_running_card_cannot_be_moved_edited_into_a_loop_or_started_twice(self):
        card = self.card_via_route("long", status="ready")
        other = self.card_via_route("other")

        async def go():
            SlowBrain.gate = asyncio.Event()
            claimed = task_service.claim_next_card()
            run = asyncio.create_task(task_scheduler.start_run(claimed, "schedule"))
            await started()
            loop = asyncio.get_running_loop()
            post = lambda path, **kw: loop.run_in_executor(None, lambda: self.web.post(path, **kw))  # noqa: E731
            moved = await post(f"/api/tasks/{card['id']}/status", json={"status": "backlog"})
            again = await post(f"/api/tasks/{card['id']}/run")
            SlowBrain.gate.set()
            await run
            return moved, again
        moved, again = asyncio.run(go())
        self.assertEqual(moved.status_code, 400)
        self.assertEqual(again.status_code, 409)
        self.assertEqual(SlowBrain.started, 1)
        self.assertEqual(task_service.get_task(other["id"])["status"], "backlog")

    def test_deleting_a_card_unblocks_what_waited_on_it_and_keeps_other_history(self):
        a = self.card_via_route("a", status="ready")
        b = self.card_via_route("b", status="ready", depends_on=[a["id"]])
        self.assertIsNone(task_service.next_card(card_id=b["id"]), "b waits on a")
        asyncio.run(task_scheduler.start_run(task_service.get_task(a["id"]), "manual"))
        keep = len(task_service.list_runs(a["id"]))
        self.web.delete(f"/api/tasks/{a['id']}")
        self.assertEqual(task_service.get_task(b["id"])["depends_on"], [])
        self.assertEqual(task_service.next_card(card_id=b["id"])["id"], b["id"])
        self.assertEqual(task_service.list_runs(a["id"]), [], "deleting says the history goes with it")
        self.assertEqual(keep, 1)

    def test_model_owner_and_workspace_stay_on_card_and_run_record(self):
        endpoint = {"id": "ep-qwen", "name": "Qwen local", "kind": "openai_compat"}
        with patch("core.model_endpoints.get_endpoint", lambda eid: endpoint if eid == "ep-qwen" else None):
            card = self.card_via_route("on qwen", endpoint_id="ep-qwen", status="ready")
            self.assertEqual(card["owner_user"], "alice")
            asyncio.run(task_scheduler.dispatch_cards())
            run = task_service.list_runs(card["id"])[0]
            self.assertEqual((run["endpoint_id"], run["model"]), ("ep-qwen", "Qwen local"))
        # The model is removed later: history still names it, the card says why it cannot run.
        self.assertEqual(task_service.list_runs(card["id"])[0]["model"], "Qwen local")
        later = task_service.list_runs(card["id"])
        self.assertEqual(later[0]["endpoint_id"], "ep-qwen")
        stored = task_service.get_task(card["id"])
        self.assertEqual((stored["owner_user"], stored["endpoint_id"]), ("alice", "ep-qwen"))

    def test_a_removed_model_is_a_clear_failure_not_a_silent_swap_to_claude(self):
        card = self.card_via_route("orphan", status="ready")
        task_service.get_task(card["id"])["endpoint_id"] = "gone"
        with patch("core.model_endpoints.get_endpoint", lambda eid: None):
            with self.assertRaisesRegex(ValueError, "has been removed"):
                REAL_TASK_BRAIN(task_service.get_task(card["id"]))


class History(Routes):
    """A12 item 5: history/duration/model/run link survive stop, failure, delete, restart."""

    def test_history_is_exact_after_success_failure_stop_and_a_restart(self):
        task = self.make(name="mixed")
        tid = task["id"]

        class Boom(SlowBrain):
            async def events(self, prompt, stream=True):
                raise RuntimeError("provider down")
                yield  # pragma: no cover

        asyncio.run(task_scheduler.start_run(task_service.get_task(tid), "manual"))
        with patch.object(task_scheduler, "_task_brain", lambda t: Boom()):
            asyncio.run(task_scheduler.start_run(task_service.get_task(tid), "manual"))

        async def stopped():
            SlowBrain.gate = asyncio.Event()
            run = asyncio.create_task(task_scheduler.start_run(task_service.get_task(tid), "manual"))
            await started(2)  # the failing run never reaches the stand-in's counter
            task_scheduler.stop_run(tid)
            await run
        asyncio.run(stopped())
        before = task_service.list_runs(tid)
        self.assertEqual([r["outcome"] for r in before], ["stopped", "failed", "succeeded"])
        self.assertEqual(before[1]["error"], "provider down")
        self.assertEqual(before[2]["model"], "Claude")
        self.assertTrue(all(r["duration_seconds"] is not None and r["duration_seconds"] >= 0 for r in before))
        self.assertTrue(all(r["run_id"] for r in before), "every run links to its model timeline")
        self.assertEqual(len({r["run_id"] for r in before}), 3)
        reloaded = task_module.TaskService()
        after = reloaded.list_runs(tid)
        self.assertEqual([(r["id"], r["outcome"], r["duration_seconds"], r["run_id"], r["model"]) for r in after],
                         [(r["id"], r["outcome"], r["duration_seconds"], r["run_id"], r["model"]) for r in before],
                         "a restart reads back the same history")
        self.assertEqual(reloaded.recover_interrupted_runs(), [], "nothing finished is turned into 'lost'")
        self.assertEqual([r["outcome"] for r in reloaded.list_runs(tid)], ["stopped", "failed", "succeeded"])

    def test_history_is_capped_per_task_without_evicting_other_tasks(self):
        busy, quiet = self.make(name="busy"), self.make(name="quiet")
        asyncio.run(task_scheduler.start_run(task_service.get_task(quiet["id"]), "manual"))
        for _ in range(task_module.MAX_RUNS_PER_TASK + 8):
            asyncio.run(task_scheduler.start_run(task_service.get_task(busy["id"]), "manual"))
        self.assertEqual(len(task_service.list_runs(busy["id"])), task_module.MAX_RUNS_PER_TASK)
        self.assertEqual(len(task_service.list_runs(quiet["id"])), 1)
        self.assertEqual(len(json.loads(Path(task_module.runs_file()).read_text())), task_module.MAX_RUNS_PER_TASK + 1)

    def test_a_deleted_tasks_history_and_a_removed_models_name_do_not_leak_into_others(self):
        a, b = self.make(name="a"), self.make(name="b")
        for t in (a, b):
            asyncio.run(task_scheduler.start_run(task_service.get_task(t["id"]), "manual"))
        self.web.delete(f"/api/tasks/{a['id']}")
        self.assertEqual({r["task_id"] for r in task_service.list_runs()}, {b["id"]})
        self.assertEqual({r["task_id"] for r in task_module.TaskService().list_runs()}, {b["id"]}, "and on disk")


class Delivery(Routes):
    """A12 item 6: a delivery failure is not a task failure, and retries never duplicate."""

    def setUp(self):
        super().setUp()
        USER["name"] = "admin"  # only an admin may aim a task at a channel (routes/task_routes.py _check_channel)

    def test_delivery_failure_leaves_the_run_succeeded_with_a_retryable_delivery(self):
        task = self.make(name="brief", deliver_to_channel="discord")
        self.send_ok = False
        ran = self.web.post(f"/api/tasks/{task['id']}/run").json()
        self.assertEqual(ran["outcome"], "succeeded", "the task itself worked")
        self.assertIsNone(ran["error"])
        self.assertEqual(ran["output"], "done")
        self.assertEqual(ran["delivery"]["status"], "pending")
        self.assertEqual(ran["delivery"]["attempts"], 1)
        self.assertIn("did not accept", ran["delivery"]["last_error"])
        self.assertIsNone(ran["delivered"], "still being retried, not claimed delivered or failed")
        self.send_ok = True
        asyncio.run(outbox.send_due(time.time() + 61))
        landed = task_service.list_runs(task["id"])[0]
        self.assertEqual((landed["outcome"], landed["delivered"], landed["delivery"]["attempts"]), ("succeeded", True, 2))
        self.assertEqual(len(self.sent), 2)
        asyncio.run(outbox.send_due(time.time() + 3600))
        self.assertEqual(len(self.sent), 2, "a delivered message is never sent again")

    def test_a_failed_task_sends_nothing_and_says_failed(self):
        task = self.make(name="broken brief", deliver_to_channel="discord")

        class Boom(SlowBrain):
            async def events(self, prompt, stream=True):
                raise RuntimeError("no model")
                yield  # pragma: no cover

        with patch.object(task_scheduler, "_task_brain", lambda t: Boom()):
            ran = self.web.post(f"/api/tasks/{task['id']}/run").json()
        self.assertEqual((ran["outcome"], ran["delivery_id"], ran["delivered"]), ("failed", None, None))
        self.assertEqual(self.sent, [], "an error stays on the Tasks tab")

    def test_run_now_twice_and_a_scheduled_pass_queue_one_message(self):
        task = self.make(name="dedupe", deliver_to_channel="discord")
        self.web.post(f"/api/tasks/{task['id']}/run")
        asyncio.run(outbox.send_due())
        rows = store.connection().execute("SELECT COUNT(*) AS n FROM deliveries").fetchone()["n"]
        self.assertEqual(rows, 1)
        self.assertEqual(self.web.post(f"/api/tasks/deliveries/ghost/retry").status_code, 404)

    def test_retry_of_a_given_up_delivery_is_a_person_action_and_resends_once(self):
        task = self.make(name="given up", deliver_to_channel="discord")
        self.send_ok = False
        run = self.web.post(f"/api/tasks/{task['id']}/run").json()
        did = run["delivery_id"]
        with store.transaction() as conn:
            conn.execute("UPDATE deliveries SET created_at = created_at - ? WHERE id = ?", (outbox.GIVE_UP_SECONDS + 5, did))
        asyncio.run(outbox.send_due(time.time() + 7200))
        self.assertEqual(task_service.list_runs(task["id"])[0]["delivery"]["status"], "failed")
        self.assertEqual(task_service.list_runs(task["id"])[0]["delivered"], False)
        self.assertEqual(task_service.list_runs(task["id"])[0]["outcome"], "succeeded")
        self.send_ok = True
        sent_before = len(self.sent)
        again = self.web.post(f"/api/tasks/deliveries/{did}/retry")
        self.assertEqual(again.json()["status"], "delivered")
        self.assertEqual(len(self.sent), sent_before + 1)
        self.assertEqual(self.web.post(f"/api/tasks/deliveries/{did}/retry").status_code, 409)

    def test_BUG_a_task_cannot_be_pointed_at_a_channel_that_does_not_exist_or_is_not_the_users(self):
        """'Authorized channel delivery': the create/edit routes store any
        string as deliver_to_channel. A non-admin can aim a task's output at
        the admin's Discord DM ('discord') or any 'conn:' id."""
        USER["name"] = "bob"
        response = self.web.post("/api/tasks", json={"name": "leak", "prompt": "p", "schedule_kind": "interval",
                                                       "interval_seconds": 60, "deliver_to_channel": "discord"})
        if response.status_code == 200:
            self.created.append(response.json()["id"])
        self.assertIn(response.status_code, (400, 403), "a non-admin must not be able to deliver to the owner's Discord DM")
        USER["name"] = "admin"
        response = self.web.post("/api/tasks", json={"name": "typo", "prompt": "p", "schedule_kind": "interval",
                                                       "interval_seconds": 60, "deliver_to_channel": "no-such-channel"})
        if response.status_code == 200:
            self.created.append(response.json()["id"])
        self.assertEqual(response.status_code, 400, "an unknown channel id should be refused up front, not fail silently for a day")


class ConcurrencyAndRestart(Routes):
    """A12 item 4."""

    def test_N_simultaneous_run_now_requests_start_exactly_one_run(self):
        task = self.make(name="once only")

        async def go():
            # One event loop for the app and the callers, as under uvicorn
            # (TestClient gives every request its own loop and so its own lock).
            import httpx
            SlowBrain.gate = asyncio.Event()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.web.app), base_url="http://t") as http:
                calls = [asyncio.create_task(http.post(f"/api/tasks/{task['id']}/run")) for _ in range(6)]
                await started()
                await asyncio.sleep(0.2)
                SlowBrain.gate.set()
                return [r.status_code for r in await asyncio.gather(*calls)]
        codes = asyncio.run(go())
        self.assertEqual(sorted(codes), [200] + [409] * 5, codes)
        self.assertEqual((SlowBrain.started, SlowBrain.most_at_once), (1, 1))

    def test_a_schedule_tick_while_run_now_is_going_skips_the_occurrence_without_a_second_run(self):
        task = self.task("busy", due_seconds_ago=5)

        async def go():
            SlowBrain.gate = asyncio.Event()
            manual = asyncio.create_task(task_scheduler.start_run(task_service.get_task(task["id"]), "manual"))
            await started()
            await task_scheduler._tick()
            await task_scheduler.lane("schedule")
            SlowBrain.gate.set()
            await manual
        asyncio.run(go())
        self.assertEqual((SlowBrain.started, SlowBrain.most_at_once), (1, 1))
        notes = [r for r in task_service.list_runs(task["id"]) if r["outcome"] == "lost"]
        self.assertEqual(len(notes), 1, "one honest receipt for the covered occurrence")

    def test_a_run_cut_off_by_a_restart_is_lost_not_succeeded_and_reports_to_the_channel(self):
        task = self.task("cut off", due_seconds_ago=None, deliver_to_channel="discord")
        task_service.mark_started(task["id"], "manual")  # the process dies here
        reloaded = task_module.TaskService()
        with patch.object(task_scheduler, "task_service", reloaded):
            lost = reloaded.recover_interrupted_runs()
            self.assertEqual([t["id"] for t in lost], [task["id"]])
            task_scheduler._report_lost(lost[0])
        run = reloaded.list_runs(task["id"])[0]
        self.assertEqual(run["outcome"], "lost")
        self.assertIn("did not finish", run["error"])
        asyncio.run(outbox.send_due())
        self.assertTrue(any("cut off when Kairos closed" in text for _, text in self.sent))
        self.assertEqual(reloaded.recover_interrupted_runs(), [], "recovery is idempotent")


class TriggerApprovalStaleness(unittest.TestCase):
    """A12 item 3, the 'stale approvals' clause."""

    def setUp(self):
        for t in trigger_service.triggers():
            trigger_service.delete(t["id"])
        trigger_service._pending.clear()
        trigger_service._seen.clear()
        trigger_service._hits.clear()
        for a in agent_service.list_agents():
            agent_service.delete(a["id"])
        for t in task_service.list_tasks():
            task_service.delete_task(t["id"])
        self.bo = agent_service.create("Bo", role="Reviewer")
        web = FastAPI()
        web.include_router(trigger_routes.router)
        web.dependency_overrides[require_admin] = lambda: "admin"
        self.web = TestClient(web)
        self.run_task = AsyncMock()
        patch("core.task_scheduler._run_task", self.run_task).start()
        patch("core.channels.registry.send_to_channel", AsyncMock(return_value=True)).start()
        self.addCleanup(patch.stopall)

    def trigger(self, **fields):
        body = {"name": "T", "preset": "generic", "agent_id": self.bo["id"], **fields}
        r = self.web.post("/api/triggers", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def fire(self, trigger, payload, delivery):
        import hashlib
        import hmac
        body = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(trigger["secret"].encode(), body, hashlib.sha256).hexdigest()
        return self.web.post(trigger["path"], content=body, headers={"X-JARVIS-Signature": sig, "X-JARVIS-Delivery": delivery,
                                                                       "Content-Type": "application/json"})

    def test_a_pending_approval_for_a_card_that_moved_or_vanished_does_nothing(self):
        trig = self.trigger()
        self.fire(trig, {"type": "a"}, "d1")
        self.fire(trig, {"type": "b"}, "d2")
        first, second = trigger_service.pending()[::-1]
        task_service.set_card_status(first["card_id"], "ready")  # moved by hand on the board
        task_service.delete_task(second["card_id"])
        for pending in (first, second):
            answer = self.web.post(f"/api/triggers/pending/{pending['id']}", json={"approve": True})
            self.assertEqual(answer.status_code, 200)
            self.assertIn("already moved or removed", answer.json()["next"])
        self.assertEqual(trigger_service.pending(), [])

    def test_deleting_a_trigger_withdraws_its_pending_approvals_and_secret_rotation_voids_old_signatures(self):
        trig = self.trigger()
        self.fire(trig, {"type": "a"}, "d1")
        (pending,) = trigger_service.pending()
        self.web.delete(f"/api/triggers/{trig['id']}")
        self.assertEqual(self.web.post(f"/api/triggers/pending/{pending['id']}", json={"approve": True}).status_code, 404)
        again = self.trigger()
        self.web.post(f"/api/triggers/{again['id']}/secret")
        self.assertEqual(self.fire(again, {"type": "a"}, "d9").status_code, 403)

    def test_pending_approvals_survive_a_restart_and_a_duplicate_after_restart_is_noted(self):
        trig = self.trigger()
        self.fire(trig, {"type": "a"}, "same")
        reloaded = trigger_module.TriggerService()
        self.assertEqual([p["id"] for p in reloaded.pending()], [p["id"] for p in trigger_service.pending()])
        self.assertEqual(self.fire(trig, {"type": "a"}, "same").json()["status"], "duplicate")
        self.assertEqual(len(trigger_service.pending()), 1)

    def test_BUG_approving_a_task_run_after_its_trigger_was_switched_off_must_not_start_it(self):
        goal = task_service.create_task("Check", "look", "daily", run_time="09:00", agent_id=self.bo["id"])
        trig = self.trigger(action="task", task_id=goal["id"], agent_id=None)
        self.fire(trig, {"type": "a"}, "d1")
        (pending,) = trigger_service.pending()
        self.web.patch(f"/api/triggers/{trig['id']}", json={"enabled": False})  # the person turned the trigger off
        self.web.post(f"/api/triggers/pending/{pending['id']}", json={"approve": True})
        self.assertEqual(self.run_task.call_count, 0, "the trigger was switched off after the event; a stale OK still ran the task")

    def test_BUG_an_approval_nobody_answered_for_days_is_not_still_live(self):
        trig = self.trigger(action="task", task_id=task_service.create_task("Check", "look", "daily", run_time="09:00", agent_id=self.bo["id"])["id"], agent_id=None)
        self.fire(trig, {"type": "a"}, "d1")
        (pending,) = trigger_service.pending()
        pending["created_at"] -= 30 * 86400  # a month old
        self.web.post(f"/api/triggers/pending/{pending['id']}", json={"approve": True})
        self.assertEqual(self.run_task.call_count, 0, "a month-old event should have expired rather than run on 'approve'")


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()


if __name__ == "__main__":
    unittest.main()
