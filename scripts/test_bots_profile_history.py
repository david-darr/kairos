"""Bots Phase 1, unit U2: the profile history, rollback and SOUL.md races (2026-10-29).

Spec: phase-1-design.md 3.4 and 5.2. Throwaway data folder, no model.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_profile_history.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-history-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.middleware import require_admin, require_user  # noqa: E402
from routes import agent_routes  # noqa: E402
from services import bot_profile_history as history  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(agent_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)
_COUNTER = [0]


class HistoryTests(unittest.TestCase):
    def setUp(self):
        _COUNTER[0] += 1
        self.bot = agent_service.create(f"History bot {_COUNTER[0]}", role="Original job")
        self.id = self.bot["id"]
        self.addCleanup(lambda: agent_service.get(self.id) and agent_service.delete(self.id))

    def rows(self, **query):
        return web.get(f"/api/agents/{self.id}/history", params=query).json()["rows"]

    def soul_file(self):
        return agent_service.read_soul(self.id)["file_text"]

    def test_every_change_is_a_row_with_actor_field_and_revision_newest_first(self):
        agent_service.update(self.id, role="Second job")
        agent_service.update(self.id, blurb="About me")
        rows = self.rows()
        self.assertEqual([r["field"] for r in rows[:2]], ["blurb", "role"])
        for row in rows:
            self.assertEqual(row["actor"], "user")
            self.assertIsInstance(row["revision"], int)
            self.assertTrue(row["id"] and row["ts"] and row["summary"])
        revisions = [r["revision"] for r in rows]
        self.assertEqual(revisions, sorted(revisions, reverse=True))
        self.assertEqual(rows[1]["before"], "Original job")
        self.assertEqual(rows[1]["after"], "Second job")

    def test_a_no_op_and_a_non_profile_change_write_nothing_misleading(self):
        agent_service.update(self.id, role="Original job")
        self.assertEqual(self.rows(), [])
        agent_service.update(self.id, hidden=False)
        self.assertEqual(self.rows(), [])

    def test_a_soul_row_hides_its_text_in_the_listing_but_keeps_it_for_rollback(self):
        agent_service.update(self.id, soul="Be brief.")
        agent_service.update(self.id, soul="Be thorough.")
        row = self.rows()[0]
        self.assertEqual(row["field"], "soul")
        self.assertNotIn("before", row)
        self.assertNotIn("after", row)
        full = history.rows(agent_service, self.id, 10, True)[0]
        self.assertEqual((full["before"], full["after"]), ("Be brief.", "Be thorough."))

    def test_soul_rollback_needs_the_exact_revision_and_file(self):
        agent_service.update(self.id, soul="Version one")
        agent_service.update(self.id, soul="Version two")
        row = next(r for r in self.rows() if r["field"] == "soul")
        revision = agent_service.get(self.id)["revision"]
        stale = web.post(f"/api/agents/{self.id}/history/{row['id']}/rollback",
                         json={"expected_revision": revision - 1, "expected_file_text": self.soul_file()})
        self.assertEqual(stale.status_code, 409)
        wrong = web.post(f"/api/agents/{self.id}/history/{row['id']}/rollback",
                         json={"expected_revision": revision, "expected_file_text": "not the file"})
        self.assertEqual(wrong.status_code, 409)
        self.assertEqual(agent_service.get(self.id)["soul"], "Version two")
        done = web.post(f"/api/agents/{self.id}/history/{row['id']}/rollback",
                        json={"expected_revision": revision, "expected_file_text": self.soul_file()})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(agent_service.get(self.id)["soul"], "Version one")
        self.assertEqual(self.soul_file(), "Version one")
        self.assertEqual(self.rows()[0]["field"], "soul", "the rollback is itself a row")

    def test_only_soul_rows_offer_rollback_and_unknown_rows_are_404(self):
        agent_service.update(self.id, role="Changed")
        role_row = next(r for r in self.rows() if r["field"] == "role")
        body = {"expected_revision": agent_service.get(self.id)["revision"], "expected_file_text": self.soul_file()}
        self.assertEqual(web.post(f"/api/agents/{self.id}/history/{role_row['id']}/rollback", json=body).status_code, 400)
        self.assertEqual(web.post(f"/api/agents/{self.id}/history/nope/rollback", json=body).status_code, 404)

    def test_a_hand_edit_applies_as_a_file_row_and_can_be_discarded_only_against_what_was_seen(self):
        agent_service.update(self.id, soul="Stored text")
        path = Path(agent_service._soul_path(self.id))
        path.write_bytes(b"Hand edited")
        seen = agent_service.read_soul(self.id)
        self.assertFalse(seen["in_sync"])
        stale = web.post(f"/api/agents/{self.id}/soul/discard-file",
                         json={"expected_file_text": "something else", "expected_revision": seen["revision"]})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(path.read_bytes(), b"Hand edited", "a failed discard leaves the file")
        ok = web.post(f"/api/agents/{self.id}/soul/discard-file",
                      json={"expected_file_text": "Hand edited", "expected_revision": seen["revision"]})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(ok.json()["in_sync"])
        self.assertEqual(path.read_bytes(), b"Stored text")
        path.write_bytes(b"Hand edited again")
        again = agent_service.read_soul(self.id)
        web.post(f"/api/agents/{self.id}/soul/apply",
                 json={"expected_file_text": "Hand edited again", "expected_revision": again["revision"]})
        row = history.rows(agent_service, self.id, 5, True)[0]
        self.assertEqual((row["actor"], row["after"]), ("file", "Hand edited again"))

    def test_apply_refuses_when_the_file_moved_after_it_was_read(self):
        agent_service.update(self.id, soul="Stored")
        path = Path(agent_service._soul_path(self.id))
        path.write_bytes(b"First edit")
        seen = agent_service.read_soul(self.id)
        path.write_bytes(b"Second edit")
        response = web.post(f"/api/agents/{self.id}/soul/apply",
                            json={"expected_file_text": seen["file_text"], "expected_revision": seen["revision"]})
        self.assertGreaterEqual(response.status_code, 400)
        self.assertEqual(agent_service.get(self.id)["soul"], "Stored")

    def test_a_torn_final_line_is_skipped_and_new_rows_still_append(self):
        agent_service.update(self.id, role="Kept")
        with history.path_for(agent_service, self.id).open("ab") as stream:
            stream.write(b'{"id": "cut off')
        self.assertEqual([r["after"] for r in self.rows()], ["Kept"])
        agent_service.update(self.id, blurb="After the tear")
        fields = [r["field"] for r in self.rows()]
        self.assertIn("blurb", fields)
        self.assertIn("role", fields)

    def test_the_default_is_100_rows_and_the_ceiling_500(self):
        for index in range(110):
            agent_service.update(self.id, blurb=f"Blurb {index}")
        self.assertEqual(len(web.get(f"/api/agents/{self.id}/history").json()["rows"]), 100)
        self.assertEqual(len(self.rows(limit=500)), 110)
        self.assertEqual(web.get(f"/api/agents/{self.id}/history", params={"limit": 501}).status_code, 400)
        self.assertEqual(web.get(f"/api/agents/{self.id}/history", params={"limit": 0}).status_code, 400)

    def test_retention_keeps_the_newest_500_whole_rows(self):
        for index in range(520):
            agent_service.update(self.id, blurb=f"Blurb {index}")
        rows = self.rows(limit=500)
        self.assertEqual(len(rows), 500)
        self.assertEqual(rows[0]["after"], "Blurb 519")
        raw = history.path_for(agent_service, self.id).read_bytes().splitlines()
        self.assertLessEqual(len(raw), 500)
        for line in raw:
            json.loads(line)

    def test_history_lives_beside_soul_md_and_goes_when_the_bot_does(self):
        agent_service.update(self.id, role="Anything")
        path = history.path_for(agent_service, self.id)
        self.assertEqual(path.parent, Path(agent_service._soul_path(self.id)).parent)
        self.assertTrue(path.exists())
        agent_service.delete(self.id)
        self.assertFalse(path.exists())

    def test_history_of_an_unknown_bot_is_404(self):
        self.assertEqual(web.get("/api/agents/missing/history").status_code, 404)

    def test_an_unknown_actor_is_refused(self):
        with self.assertRaises(ValueError):
            history.append(agent_service, self.id, {}, {"role": "x"}, 1, actor="stranger")


if __name__ == "__main__":
    unittest.main()
