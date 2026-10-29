"""Assignment admission and recovery, using real isolated bot records and cards."""
import asyncio
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="kairos-assignments-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from core import bot_assignments as a, runs, tool_registry, permissions
from core.session_manager import session_manager
from services.agent_service import agent_service
from services import agent_handoff
from services.task_service import task_service


class AssignmentsTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(fixture.name) / uuid.uuid4().hex
        self.directory.mkdir()
        self.path_patch = patch.object(a, "PATH", self.directory / "assignments.sqlite3")
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)
        self.bots = [agent_service.create("Bot " + uuid.uuid4().hex[:8]) for _ in range(7)]
        self.addCleanup(self.cleanup)
        self.sid = session_manager.create_session(owner_user="owner")["id"]
        agent_service.make_agent_chat(self.sid, self.bots[0])
        self.req = {"kind": "bot", "bot_id": self.bots[0]["id"], "session_id": self.sid, "run_id": "turn-one"}

    def cleanup(self):
        for bot in self.bots:
            task_service.delete_agent_work(bot["id"])
            if agent_service.get(bot["id"]):
                agent_service.delete(bot["id"])

    def node(self, brief="Check the file", **kw):
        return a.admit(self.req, self.bots[1]["id"], brief, **kw)

    def test_fingerprint_idempotence_and_duplicate_rework(self):
        n = self.node()
        self.assertEqual(self.node()["id"], n["id"])
        self.req["run_id"] = "new-turn"
        with self.assertRaisesRegex(a.Refused, "Duplicate"):
            self.node()
        with self.assertRaisesRegex(a.Refused, "Duplicate"):
            self.node(rework=True)
        a.settle(n["id"], result="An observed result")
        self.assertNotEqual(self.node(rework=True)["id"], n["id"])

    def test_depth_ancestor_and_wrong_parent(self):
        parent = self.node()
        source = 1
        for depth in range(2, 5):
            req = {**self.req, "bot_id": self.bots[source]["id"], "run_id": f"turn-{depth}"}
            with self.assertRaisesRegex(a.Refused, "cycle"):
                a.admit(req, self.bots[0]["id"], f"Back {depth}", parent_id=parent["id"])
            parent = a.admit(req, self.bots[source + 1]["id"], f"Level {depth}", parent_id=parent["id"])
            self.assertEqual(parent["depth"], depth)
            source += 1
        with self.assertRaisesRegex(a.Refused, "4 hops"):
            a.admit({**self.req, "bot_id": self.bots[4]["id"]}, self.bots[5]["id"], "Too deep", parent_id=parent["id"])
        with self.assertRaisesRegex(a.Refused, "cannot delegate"):
            a.admit(self.req, self.bots[6]["id"], "Foreign parent", parent_id=parent["id"])

    def test_all_admission_refusals(self):
        for options in ({"mode": "other"}, {"origin": "api"}, {"destination": "elsewhere"},
                        {"mode": "consult", "reply": "none"}, {"brief": ""}, {"title": "x" * 81},
                        {"reason": "x" * 201}, {"done_when": "x" * 1001}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                brief = options.get("brief", "Valid brief")
                self.node(brief, **{k: v for k, v in options.items() if k != "brief"})
        with self.assertRaisesRegex(a.Refused, "not found"):
            self.node(parent_id="missing")
        with self.assertRaisesRegex(a.Refused, "cycle"):
            a.admit(self.req, self.bots[0]["id"], "Self")
        agent_service.update(self.bots[1]["id"], hidden=True)
        with self.assertRaisesRegex(a.Refused, "unavailable"):
            self.node()
        agent_service.update(self.bots[1]["id"], hidden=False)
        agent_service.update(self.bots[0]["id"], peers=[])
        with self.assertRaisesRegex(ValueError, "Peers"):
            self.node()

    def test_per_turn_cap_across_roots(self):
        for i in range(5):
            self.node(f"Work {i}")
        with self.assertRaisesRegex(a.Refused, "5 assignments"):
            self.node("Sixth")

    def test_request_execution_wake_budgets_renew_only_on_progress(self):
        n = self.node(now=0)
        child_req = {**self.req, "bot_id": self.bots[1]["id"], "run_id": "child"}
        for field, limit in (("requests", 64), ("executions", 96)):
            with a._db() as db:
                db.execute(f"UPDATE budgets SET {field}=? WHERE root_id=?", (limit, n["root_id"]))
            with self.assertRaisesRegex(a.Refused, "budget"):
                a.admit(child_req, self.bots[2]["id"], field, parent_id=n["id"])
            self.assertTrue(a.progress(n["id"], field, now=10))
            self.assertFalse(a.progress(n["id"], field, now=20))
        for _ in range(48):
            self.assertTrue(a.consume_wake(n["root_id"]))
        self.assertFalse(a.consume_wake(n["root_id"]))
        a.progress(n["id"], "new artifact", now=30)
        self.assertTrue(a.consume_wake(n["root_id"]))

    def test_event_replay_terminal_invariant_and_idempotent_settle(self):
        n = self.node()
        a.update(n["id"], status="running")
        a.update(n["id"], status="needs_input", question="Which file?")
        a.settle(n["id"], result="file.txt checked")
        before = a.events(n["id"])
        a.settle(n["id"], result="Duplicate callback")
        self.assertEqual(a.events(n["id"]), before)
        self.assertEqual(before[-1]["detail"], a.get(n["id"]))
        self.assertEqual(a.get(n["id"])["outcome"], "done")
        with self.assertRaisesRegex(ValueError, "outcome"):
            a.update(self.node("Other")["id"], status="failed")

    def test_expiry_stall_parking_revalidation_pruning(self):
        n = self.node(now=0)
        a.tick(now=86401, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["outcome"], "expired")
        n = self.node("Running", now=0)
        a.update(n["id"], status="running", now=1)
        a.tick(now=1202, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["outcome"], "stalled")
        n = self.node("Waiting input", now=0)
        a.update(n["id"], status="needs_input", now=0)
        a.tick(now=15000, parked=lambda n: True, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["status"], "needs_input")
        a.tick(now=15001, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["outcome"], "expired")
        n = self.node("Reach closed", now=0)
        agent_service.update(self.bots[0]["id"], peers=[])
        a.tick(now=1)
        self.assertEqual(a.get(n["id"])["outcome"], "refused")
        a.tick(now=40 * 86400, reachable=lambda n: True)
        self.assertEqual(a.tree(), [])

    def test_whole_tree_stall_and_parent_resume(self):
        n = self.node(now=0)
        c = a.admit({**self.req, "bot_id": self.bots[1]["id"], "run_id": "c"}, self.bots[2]["id"], "child", parent_id=n["id"], now=0)
        a.update(n["id"], status="waiting", now=0)
        a.settle(c["id"], "provider_error", now=10)
        a.tick(now=11, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["status"], "resume")
        a.tick(now=15000, reachable=lambda n: True)
        self.assertEqual(a.get(n["id"])["outcome"], "stalled")

    def test_restart_outward_never_reruns_one_safe_rerun_and_child_cut(self):
        n = self.node(now=0)
        a.update(n["id"], status="running", now=0)
        a.reconcile_startup(now=1, read_evidence=lambda n: {"outward_actions": []})
        self.assertEqual(a.get(n["id"])["restart_marker"], "rerun")
        a.update(n["id"], status="running", now=2)
        a.reconcile_startup(now=3, read_evidence=lambda n: {"outward_actions": []})
        self.assertEqual(a.get(n["id"])["outcome"], "interrupted")
        n = self.node("Outward", now=0)
        a.update(n["id"], status="running", now=0)
        a.reconcile_startup(now=1, read_evidence=lambda n: {"outward_actions": [{"tool": "send_mail"}]})
        self.assertEqual(a.get(n["id"])["status"], "failed")
        self.assertEqual(a.get(n["id"])["restarts"], 0)
        n = self.node("Parent", now=0)
        a.admit({**self.req, "bot_id": self.bots[1]["id"], "run_id": "c"}, self.bots[2]["id"], "child", parent_id=n["id"], now=0)
        a.update(n["id"], status="running", now=0)
        a.reconcile_startup(now=1, read_evidence=lambda n: {})
        self.assertEqual(a.get(n["id"])["status"], "waiting")

    def test_continuation_guard_and_harness_evidence(self):
        n = self.node()
        a.continuation(n["id"])
        self.assertEqual(a.continuation(n["id"])["outcome"], "loop")
        n = self.node("Errors")
        for i in range(3):
            value = a.continuation(n["id"], marker=f"file:{i}", error="same failure")
        self.assertEqual(value["outcome"], "loop")
        with patch("core.session_manager_store.run_events", return_value=[
            {"kind": "tool_started", "name": "Bash", "detail": "git -C repo push origin main"},
            {"kind": "tool_finished", "name": "Bash", "ok": False, "detail": "permission denied"}]):
            proof = a.evidence("run")
        self.assertTrue(proof["outward_actions"])
        self.assertEqual(proof["errors"], ["permission denied"])

    def test_sink_retry_and_single_delivery(self):
        n = self.node()
        a.settle(n["id"], result="Done")
        delivered = []
        def sink(node): delivered.append(node["id"])
        remove = a.register_sink("bot", sink)
        self.addCleanup(remove)
        a.tick(); a.tick()
        self.assertEqual(delivered, [n["id"]])

    def test_real_cards_modes_fields_and_cancellation(self):
        kwargs = dict(session_id=self.sid, run_id="actual", reason="Check evidence", done_when="Tests pass")
        reply = agent_handoff.assign(self.bots[0]["id"], self.bots[1]["id"], "Run the checks", **kwargs)
        self.assertIn("Assigned", reply)
        n = a.tree()[0]
        card = task_service.get_task(n["card_id"])
        self.assertEqual(card["done_when"], "Tests pass")
        self.assertEqual(session_manager.get_session(n["work_session_id"])["thread"]["opened_by"], "handoff")
        self.assertIn("UNTRUSTED", card["prompt"])
        a.cancel(n["id"])
        self.assertEqual(card["status"], "blocked")
        self.assertIn("Notified", agent_handoff.assign(self.bots[0]["id"], self.bots[2]["id"], "FYI", mode="notify", **kwargs))
        self.assertEqual(len(task_service.list_tasks()), 1)
        self.assertIn("Assigned", agent_handoff.assign(self.bots[0]["id"], self.bots[2]["id"], "Which approach?", mode="consult", **kwargs))

    def test_tool_broker_denial_and_same_turn_status_refusal(self):
        ctx = tool_registry.ToolContext(agent_id=self.bots[0]["id"], session_id=self.sid, assignment_run_id="t")
        with patch.object(permissions, "decide", new=AsyncMock(return_value=permissions.Decision("deny", "Denied"))):
            reply = asyncio.run(tool_registry.call("coordinate_bots", {"bot_ids": [self.bots[1]["id"]], "message": "Work"}, ctx, tool_registry.CLAUDE))
        self.assertIn("Not run", reply)
        self.assertFalse(a.tree())
        n = self.node()
        same = tool_registry.ToolContext(agent_id=self.bots[0]["id"], session_id=self.sid, assignment_run_id="turn-one")
        reply = asyncio.run(tool_registry.call("assignment_status", {"ids": [n["id"]], "timeout": 0}, same, tool_registry.CLAUDE))
        self.assertIn("End this turn", reply)


if __name__ == "__main__":
    unittest.main()
