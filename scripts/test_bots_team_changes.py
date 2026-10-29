import unittest
from unittest.mock import patch
from test_bots_departments import TeamsCase, teams, HTTPException, agent_service
from services import bot_team_changes as changes
from core.session_manager import session_manager


class TeamChangesTests(TeamsCase):
    def setUp(self):
        super().setUp()
        changes._path().unlink(missing_ok=True)
        self.chief, self.department = self.team()
        teams.set_chief(self.department["id"], self.chief["id"])
        self.worker = self.bot("Worker", section="Research")

    def proposal(self, fields=None, **kwargs):
        self.chief["approval_mode"] = "ask"
        return changes.propose(self.chief["id"], "set_up_team", [{"op": "update", "bot_id": self.worker["id"],
                               "fields": fields or {"role": "Researcher"}}], **kwargs)

    def test_fingerprint_apply_undo_and_stale_undo(self):
        receipt = self.proposal()
        self.assertEqual(receipt["id"], self.proposal()["id"])
        applied = changes.apply(receipt["id"], "local")
        self.assertEqual(self.worker["role"], "Researcher")
        changes.undo(applied["id"], "local")
        self.assertEqual(self.worker["role"], "")
        second = self.proposal({"role": "Analyst"})
        changes.apply(second["id"], "local")
        agent_service.update(self.worker["id"], role="Changed by person")
        with self.assertRaises(HTTPException):
            changes.undo(second["id"], "local")
        self.assertEqual(changes.get(second["id"])["state"], "applied")

    def test_stale_proposal_never_applies_and_builtin_refused(self):
        receipt = self.proposal()
        agent_service.update(self.worker["id"], role="Other")
        with self.assertRaises(HTTPException):
            changes.apply(receipt["id"], "local")
        self.assertEqual(changes.get(receipt["id"])["state"], "stale")
        self.worker["builtin"] = True
        with self.assertRaises(HTTPException):
            changes.propose(self.chief["id"], "bot_deletion", [{"op": "delete", "bot_id": self.worker["id"]}])

    def test_full_applies_at_once_below_full_holds(self):
        self.chief["approval_mode"] = "full"
        receipt = changes.propose(self.chief["id"], "set_up_team", [{"op": "update", "bot_id": self.worker["id"], "fields": {"role": "Full result"}}])
        self.assertEqual(receipt["state"], "applied")
        pending = self.proposal({"role": "Pending"})
        self.assertEqual(pending["state"], "proposed")
        self.assertEqual(self.worker["role"], "Full result")

    def test_undo_created_only_when_unused_and_creation_cap(self):
        self.chief["approval_mode"] = "ask"
        receipt = changes.propose(self.chief["id"], "set_up_team", [{"op": "create", "fields": {"name": "New specialist"}}])
        applied = changes.apply(receipt["id"], "local")
        created_id = applied["ops"][0]["created_bot_id"]
        changes.undo(applied["id"], "local")
        self.assertIsNone(agent_service.get(created_id))
        receipt = changes.propose(self.chief["id"], "set_up_team", [{"op": "create", "fields": {"name": "Used specialist"}}])
        applied = changes.apply(receipt["id"], "local")
        created_id = applied["ops"][0]["created_bot_id"]
        session = session_manager.create_session("Work", owner_user="local")
        agent_service.make_agent_chat(session["id"], agent_service.get(created_id))
        session_manager.append_message(session["id"], "user", "Do work")
        with self.assertRaises(HTTPException):
            changes.undo(applied["id"], "local")
        with self.assertRaises(HTTPException):
            changes.propose(self.chief["id"], "set_up_team", [{"op": "create", "fields": {"name": str(n)}} for n in range(9)])
        with patch.object(agent_service, "list_agents", return_value=[{}] * 100), self.assertRaises(HTTPException):
            changes.propose(self.chief["id"], "set_up_team", [{"op": "create", "fields": {"name": "Over cap"}}])

    def test_delete_waits_for_restore_hook_and_bulk_drift_is_per_bot(self):
        receipt = changes.propose(self.chief["id"], "bot_deletion", [{"op": "delete", "bot_id": self.worker["id"]}])
        with self.assertRaises(HTTPException):
            changes.apply(receipt["id"], "local")
        preview = changes.bulk_preview(self.department["id"], {"model_override": None}, "local")
        self.assertTrue(all(r["status"] == "unchanged" for r in preview["bots"]))
        preview = changes.bulk_preview(self.department["id"], {"approval_mode": "ask"}, "local")
        self.assertIn("will-change", {r["status"] for r in preview["bots"]})
        result = changes.bulk_apply(self.department["id"], {"approval_mode": "ask"}, {}, "local")
        self.assertTrue(all(r["status"] in ("unchanged", "skipped") for r in result["bots"]))


if __name__ == "__main__":
    unittest.main()
