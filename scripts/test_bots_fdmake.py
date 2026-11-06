"""Phase 5 U4: Make reads real session and design stores in an owned temp folder."""
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_data_support import TestDataDirectory

_DATA = TestDataDirectory("bots-fdmake-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
os.environ.pop("NO_COLOR", None)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.atomic_io import write_json_atomic
from core import design_store, session_manager_store as store
from core.session_manager import session_manager
from core.middleware import require_admin, require_user
from routes.front_desk_make_routes import router
from services import front_desk_make as make


class MakeTests(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.bot = "fd-" + str(time.time_ns())
        self.home = self.session(self.bot, "david")
        self.task = self.session(self.bot, "david")
        self.other = self.session("other-bot", "david")
        self.private = self.session(self.bot, "someone-else")
        self.patch_bot = patch.object(make, "_bot_id", return_value=self.bot)
        self.patch_bot.start(); self.addCleanup(self.patch_bot.stop)
        self.patch_state = patch.object(make, "_task_state", return_value="working")
        self.patch_state.start(); self.addCleanup(self.patch_state.stop)
        self.write_tasks([])

    def session(self, bot, owner):
        session = session_manager.create_session("Probe", owner_user=owner)
        session["agent_id"] = bot
        return store.save_session(session)

    def design(self, sid, fmt="app", owner="david", created=None):
        import secrets
        did = secrets.token_hex(6)
        data = {"id": did, "owner": owner, "title": "Test design", "chat_ids": [sid],
                "boards": {"one": {"title": "One", "order": 0, "format": fmt}},
                "created": created if created is not None else self.now + 1, "updated": self.now + 2}
        write_json_atomic(str(Path(design_store.designs_dir(), did, "design.json")), data)
        return data

    def write_tasks(self, tasks):
        write_json_atomic(str(Path(_DATA.name, "front_desk", "tasks.json")), tasks)

    def task_row(self, task_id="t", **fields):
        return {"id": task_id, "thread_id": self.task["id"], "title": "Make something", "make_kind": "design",
                "created_at": self.now, **fields}

    def test_designs_linked_to_front_desk_and_owner_only(self):
        wanted = self.design(self.home["id"])
        self.design(self.other["id"])
        self.design(self.private["id"])
        self.design(self.home["id"], owner="someone-else")
        rows = make.list_make(user="david")["items"]
        self.assertEqual([i["id"] for i in rows], ["design:" + wanted["id"]])
        self.assertEqual(rows[0]["open"], {"tab": "design", "id": wanted["id"], "session_id": self.home["id"]})
        self.assertIn("/boards/one/thumb", rows[0]["thumb_url"])
        self.assertFalse(any(key.startswith("_") for key in rows[0]))
        self.assertEqual(make.list_make(user="")["items"], [])

    def test_shared_designs_respect_explicit_visibility(self):
        design = self.design(self.home["id"], owner="someone-else")
        design["visible_to"] = ["david"]
        write_json_atomic(str(Path(design_store.designs_dir(), design["id"], "design.json")), design)
        self.assertEqual(len(make.list_make(user="david")["items"]), 1)

    def test_filter_uses_board_format_and_legacy_frames(self):
        for fmt, kind in [("app", "design"), ("slides", "slides"), ("website", "website")]:
            design = self.design(self.home["id"], fmt)
            rows = make.list_make(user="david", kind=kind)["items"]
            self.assertEqual(rows[0]["id"], "design:" + design["id"])
            self.assertEqual(rows[0]["kind"], kind)
        self.assertEqual(make.design_kind({"boards": {"a": {"frame": "slide"}}}), "slides")
        self.assertEqual(make.design_kind({"boards": {"a": {"format": "slides"}, "b": {"format": "website"}}}), "design")
        with self.assertRaises(ValueError):
            make.list_make(user="david", kind="unknown")

    def test_only_published_files_from_task_sessions(self):
        self.write_tasks([self.task_row()])
        for session in (self.task, self.home, self.other):
            session["artifact_urls"] = [f"/generated-files/{session['id']}_report.pdf"]
            session["messages"] = [{"role": "assistant", "content": session["artifact_urls"][0], "ts": self.now + 1}]
            store.save_session(session)
        files = make.list_make(user="david", kind="files")["items"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["open"]["session_id"], self.task["id"])
        self.assertEqual(files[0]["title"], "report.pdf")

    def test_file_urls_are_local_published_assets_and_deduped(self):
        self.write_tasks([self.task_row(make_kind="files")])
        self.task["artifact_urls"] = ["/generated-files/report.pdf", "/generated-files/report.pdf", "https://evil/x", "/generated-files/%2e%2e", "/generated-files/../secret", "/generated-files/%2fsecret", "/generated-files/report.pdf?q=x"]
        self.task["artifacts"] = [{"url": "/generated-files/other.txt", "created_at": self.now + 1}]
        store.save_session(self.task)
        result = make.list_make(user="david")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["making"], [])

    def test_one_new_output_pairs_with_one_task_before_filtering(self):
        self.write_tasks([self.task_row("one"), self.task_row("two")])
        self.design(self.task["id"])
        result = make.list_make(user="david")
        self.assertEqual([t["id"] for t in result["making"]], ["two"])
        self.assertEqual(make.list_make(user="david", kind="slides")["making"], [])
        self.assertEqual([t["id"] for t in make.list_make(user="david", kind="design")["making"]], ["two"])

    def test_old_design_and_unrelated_thread_do_not_clear_making(self):
        self.write_tasks([self.task_row()])
        self.design(self.task["id"], created=self.now - 10)
        self.design(self.home["id"])
        self.assertEqual(len(make.list_make(user="david")["making"]), 1)
        self.patch_state.stop()
        with patch.object(make, "_task_state", return_value="failed"):
            self.assertEqual(make.list_make(user="david")["making"], [])

    def test_missing_siblings_fall_back_without_creating_anything(self):
        self.patch_bot.stop()
        with patch.dict(sys.modules, {"services.front_desk": None}):
            self.assertEqual(make.list_make(user="david"), {"items": [], "making": []})
            self.assertFalse(Path(_DATA.name, "front_desk", "state.json").exists())

    def test_route_is_admin_only_and_validates_filter(self):
        app = FastAPI(); app.include_router(router)
        with TestClient(app) as client:
            self.assertIn(client.get("/api/front-desk/make").status_code, (401, 403))
            app.dependency_overrides[require_admin] = lambda: "david"; app.dependency_overrides[require_user] = lambda: "david"
            self.assertEqual(client.get("/api/front-desk/make").status_code, 200)
            self.assertEqual(client.get("/api/front-desk/make?kind=slides").json(), {"items": [], "making": []})
            self.assertEqual(client.get("/api/front-desk/make?kind=bad").status_code, 422)
            self.assertEqual(client.post("/api/front-desk/make", json={}).status_code, 405)


if __name__ == "__main__":
    unittest.main()
