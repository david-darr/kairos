"""A signed-in member must not read, change, run or stop another person's work.

A19 / "no cross-owner reads/mutations/runs/stops for chats, agents, teams,
tasks, files, designs, Google, tab data, Forge", checked through the real app's
HTTP routes with real session cookies (never a mocked user). Alice owns the
objects; Bob is a second non-admin member; an anonymous client has no cookie;
Boss is an admin. Since Multi-Account group 3 (2026-11-06) every account has its own chats and the admin
cannot read another account's (decision D2), so Boss is refused like Bob.

Teams (test_swarm_api.test_foreign_system_all_surfaces_not_found), Google
accounts (test_google_accounts) and tab data (test_tabs, test_tab_boundaries)
have their own two-user suites; this file covers the surfaces that had none.
Forge and Agents are admin-only routers, swept here through the app schema so
a new route is covered without editing the list.

A refusal is any of 401/403/404. Every probe also checks the owner's object is
unchanged afterwards, because a 200 that renamed it is the failure we hunt.

    .venv\\Scripts\\python.exe scripts\\test_owner_isolation.py
"""
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tempfile

_DATA = tempfile.TemporaryDirectory(prefix="g7-owner-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

from fastapi.testclient import TestClient
from starlette.routing import compile_path

from app import app
from core.auth import SESSION_COOKIE_NAME, auth_manager

logging.disable(logging.CRITICAL)
REFUSED = (401, 403, 404)


def client(user):
    c = TestClient(app)
    if user:
        c.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session(user))
    return c


class OwnerIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("alice", "alice-password-1")
        auth_manager.create_user("bob", "bob-password-1")
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        cls.alice, cls.bob, cls.anon, cls.boss = client("alice"), client("bob"), client(None), client("boss")
        cls.work = Path(tempfile.mkdtemp(prefix="g7-work-", dir=_DATA.name))

    def as_owner(self, name):
        """Direct store calls in a test run with no request: say whose account they work in."""
        from core import accounts
        return accounts.as_account(auth_manager.account_id(name))

    def refused(self, label, response):
        self.assertIn(response.status_code, REFUSED, f"{label} -> {response.status_code} {response.text[:120]}")

    # -- chats -------------------------------------------------------------

    def new_chat(self):
        made = self.alice.post("/api/sessions", json={"title": "alice private"})
        self.assertEqual(made.status_code, 200, made.text)
        return made.json()["id"]

    def test_chat_reads_are_owner_scoped(self):
        sid = self.new_chat()
        listing = [s["id"] for s in self.bob.get("/api/sessions").json()]
        self.assertNotIn(sid, listing, "Bob's chat list must not contain Alice's chat")
        self.assertIn(sid, [s["id"] for s in self.alice.get("/api/sessions").json()])
        self.assertNotIn(sid, [s["id"] for s in self.boss.get("/api/sessions").json()],
                         "an admin cannot read another account's chats (D2)")
        for path in (f"/api/sessions/{sid}", f"/api/sessions/{sid}/context", f"/api/chat/background/{sid}"):
            with self.subTest(path=path):
                self.refused("bob GET " + path, self.bob.get(path))
                self.refused("anon GET " + path, self.anon.get(path))

    def test_chat_mutations_are_owner_scoped(self):
        sid = self.new_chat()
        before = self.alice.get(f"/api/sessions/{sid}").json()
        probes = [
            ("patch", f"/api/sessions/{sid}", {"title": "pwned"}),
            ("post", f"/api/sessions/{sid}/star", {"starred": True}),
            ("post", f"/api/sessions/{sid}/model", {}),  # resets the chat to the default model
            ("post", f"/api/sessions/{sid}/messages", {"role": "user", "content": "injected"}),
            ("post", f"/api/sessions/{sid}/rewind", {"keep": 0}),
            ("post", f"/api/sessions/{sid}/fork", {"through_index": 0}),
            ("post", f"/api/sessions/{sid}/project", {"project_id": None}),
            ("post", f"/api/sessions/{sid}/integrations", {"enabled_integration_ids": []}),
            ("post", f"/api/sessions/{sid}/open-mic", {"active": True}),
            ("post", f"/api/sessions/{sid}/fallback", {"model_endpoint_id": "nope", "failed_index": 0}),
            ("post", f"/api/sessions/{sid}/permission-mode", {"mode": "auto"}),
        ]
        for method, path, body in probes:
            with self.subTest(method=method, path=path):
                self.refused(f"bob {method} {path}", getattr(self.bob, method)(path, json=body))
                self.refused(f"anon {method} {path}", getattr(self.anon, method)(path, json=body))
        after = self.alice.get(f"/api/sessions/{sid}").json()
        for key in ("title", "starred", "model_endpoint_id", "messages"):
            self.assertEqual(after.get(key), before.get(key), f"Alice's chat {key} changed after Bob's attempts")
        with self.subTest("delete"):
            self.refused("bob DELETE chat", self.bob.delete(f"/api/sessions/{sid}"))
            self.refused("anon DELETE chat", self.anon.delete(f"/api/sessions/{sid}"))
            self.assertEqual(self.alice.get(f"/api/sessions/{sid}").status_code, 200)

    def test_a_chats_computer_is_refused_to_other_people(self):
        sid = self.new_chat()
        for method, path in (("get", f"/api/computer/chat:{sid}/steps"), ("get", f"/api/computer/chat:{sid}/frames"),
                             ("post", f"/api/computer/chat:{sid}/stop"), ("post", f"/api/computer/chat:{sid}/takeover")):
            with self.subTest(path=path):
                self.refused("bob " + path, getattr(self.bob, method)(path))
                self.refused("anon " + path, getattr(self.anon, method)(path))

    # -- files ---------------------------------------------------------------

    def test_a_chats_files_are_readable_only_by_its_owner(self):
        from core import chat_files
        from core.session_manager import session_manager
        sid = self.new_chat()
        (self.work / "secret.txt").write_text("alice-only-contents", encoding="utf-8")
        with self.as_owner("alice"):
            chat_files.record_local(sid, str(self.work), "secret.txt", "created")
            entry = chat_files.list_for_session(sid)[0]
        url = f"/chat-files/{entry['id']}"
        mine = self.alice.get("/api/chat/artifacts/content", params={"session_id": sid, "url": url})
        self.assertEqual((mine.status_code, mine.text), (200, "alice-only-contents"), "the owner can read it")
        self.refused("an admin lists Alice's chat files", self.boss.get("/api/chat/files", params={"session_id": sid}))
        with self.subTest("per-chat list"):
            theirs = self.bob.get("/api/chat/files", params={"session_id": sid})
            self.refused("bob lists Alice's chat files", theirs)
        with self.subTest("library"):
            library = self.bob.get("/api/chat/files/library")
            self.assertNotIn(sid, str(library.json() if library.status_code == 200 else ""),
                             "Bob's file library must not contain Alice's chat files")
        for path in ("/api/chat/artifacts/content", "/api/chat/artifacts", "/api/chat/artifacts/office"):
            with self.subTest(path=path):
                got = self.bob.get(path, params={"session_id": sid, "url": url})
                self.refused("bob " + path, got)
                self.assertNotIn("alice-only-contents", got.text)
                self.refused("anon " + path, self.anon.get(path, params={"session_id": sid, "url": url}))
        with self.as_owner("alice"):
            session_manager.delete_session(sid)

    # -- reference picker, swarm memory, chat status/summary (batch 2) -------

    def test_the_reference_picker_lists_only_the_askers_own_chats_and_chat_files(self):
        from core import chat_files
        from core.session_manager import session_manager
        sid = self.new_chat()  # titled "alice private"
        (self.work / "picker.txt").write_text("x", encoding="utf-8")
        with self.as_owner("alice"):
            chat_files.record_local(sid, str(self.work), "picker.txt", "created")

        def kinds(c, kind):
            got = c.get("/api/chat/references", params={"q": "picker" if kind == "file" else "alice private", "kind": kind})
            self.assertEqual(got.status_code, 200, got.text)
            return got.json()
        self.assertEqual(kinds(self.bob, "chat"), [], "a member never sees another member's chat in the picker")
        self.assertEqual(kinds(self.bob, "file"), [], "nor their chat files")
        self.assertIn(sid, [r["id"] for r in kinds(self.alice, "chat")], "the owner finds the chat")
        self.assertTrue(kinds(self.alice, "file"), "the owner finds the chat file")
        self.assertNotIn(sid, [r["id"] for r in kinds(self.boss, "chat")], "an admin cannot see another account's chat (D2)")
        self.assertEqual(kinds(self.boss, "file"), [], "nor its chat files")
        with self.as_owner("alice"):
            session_manager.delete_session(sid)

    def test_the_reference_picker_searches_message_text_only_in_the_askers_own_chats(self):
        from core.session_manager import session_manager
        sid = self.new_chat()
        self.assertEqual(self.alice.post(f"/api/sessions/{sid}/messages", json={"role": "user", "content": "zebracorn budget decision"}).status_code, 200)
        probe = {"q": "zebracorn", "kind": "chat"}
        self.assertEqual(self.bob.get("/api/chat/references", params=probe).json(), [], "member: another member's message text is not searchable")
        self.assertIn(sid, [r["id"] for r in self.alice.get("/api/chat/references", params=probe).json()])
        self.assertNotIn(sid, [r["id"] for r in self.boss.get("/api/chat/references", params=probe).json()])
        with self.as_owner("alice"):
            session_manager.delete_session(sid)

    def test_swarm_memory_chat_search_and_read_are_scoped_to_the_owner(self):
        from core.session_manager import session_manager
        from core.swarm.memory import SwarmMemory
        sid = self.new_chat()
        self.assertEqual(self.alice.post(f"/api/sessions/{sid}/messages", json={"role": "user", "content": "quokkaberry launch plan"}).status_code, 200)
        settings = {"sources": ["sessions"]}
        ids = {n: auth_manager.account_id(n) for n in ("alice", "bob", "boss")}
        bobs = SwarmMemory(settings, owner_user="bob", account=ids["bob"])
        self.assertEqual(bobs.search("quokkaberry"), [], "a member's company cannot find another member's chat")
        with self.assertRaises(ValueError):
            bobs.read("session:" + sid)
        mine = SwarmMemory(settings, owner_user="alice", account=ids["alice"])
        self.assertEqual([r["ref"] for r in mine.search("quokkaberry")], ["session:" + sid])
        self.assertIn("quokkaberry", mine.read("session:" + sid))
        self.assertEqual(SwarmMemory(settings, owner_user=None, account=ids["boss"]).search("quokkaberry"), [],
                         "an admin's company searches the admin's own account only (D2)")
        from services.swarm_service import SwarmService
        self.assertIsNone(SwarmService._memory_owner_scope("boss"), "an admin owner searches every chat")
        self.assertEqual(SwarmService._memory_owner_scope("bob"), "bob")
        with self.as_owner("alice"):
            session_manager.delete_session(sid)

    def test_chat_status_and_summary_are_owner_scoped(self):
        from core.session_manager import session_manager
        sid = self.new_chat()
        for label, c, ok in (("owner", self.alice, True), ("admin", self.boss, False), ("member", self.bob, False), ("anonymous", self.anon, False)):
            with self.subTest(label=label):
                status = c.get("/api/chat/status", params={"session_id": sid})
                summary = c.get("/api/chat/summary", params={"session_id": sid})
                regenerate = c.post("/api/chat/summary", json={"session_id": sid})
                if ok:
                    self.assertEqual((status.status_code, summary.status_code), (200, 200))
                else:
                    self.refused(f"{label} status", status)
                    self.refused(f"{label} summary", summary)
                    self.refused(f"{label} POST summary", regenerate)
        with self.as_owner("alice"):
            session_manager.delete_session(sid)

    # -- tasks ---------------------------------------------------------------

    def test_tasks_are_owner_scoped_for_reads_and_for_every_mutation(self):
        made = self.alice.post("/api/tasks", json={"name": "alice task", "prompt": "p", "schedule_kind": "once",
                                                   "run_at": "2031-01-01T00:00:00"})
        self.assertEqual(made.status_code, 200, made.text)
        tid = made.json()["id"]
        self.assertNotIn(tid, [t["id"] for t in self.bob.get("/api/tasks").json()])
        for path in (f"/api/tasks/{tid}", f"/api/tasks/{tid}/runs"):
            self.refused("bob GET " + path, self.bob.get(path))
        # A run must never start a model turn here: the scheduler is replaced
        # so an accepted request shows up as a recorded call, not a paid run.
        with patch("routes.task_routes.task_scheduler.start_run", new=AsyncMock(return_value=True)) as run, \
                patch("routes.task_routes.task_scheduler.stop_run", return_value=True) as stop:
            for method, path, body in (("patch", f"/api/tasks/{tid}", {"name": "pwned"}),
                                       ("post", f"/api/tasks/{tid}/status", {"status": "done"}),
                                       ("post", f"/api/tasks/{tid}/run", {}),
                                       ("post", f"/api/tasks/{tid}/stop", {}),
                                       ("delete", f"/api/tasks/{tid}", None)):
                with self.subTest(method=method, path=path):
                    kwargs = {} if body is None else {"json": body}
                    self.refused(f"bob {method} {path}", getattr(self.bob, method)(path, **kwargs))
                    self.refused(f"anon {method} {path}", getattr(self.anon, method)(path, **kwargs))
            with self.subTest("nothing started or stopped"):
                self.assertEqual((run.call_count, stop.call_count), (0, 0), "Bob's request reached the scheduler")
        survivor = self.alice.get(f"/api/tasks/{tid}")
        self.assertEqual(survivor.status_code, 200, "Alice's task was deleted by Bob")
        self.assertEqual(survivor.json()["name"], "alice task", "Alice's task was renamed by Bob")

    # -- designs ---------------------------------------------------------------

    def test_designs_are_owner_scoped(self):
        did = self.alice.post("/api/designs", json={"title": "alice design"}).json()["id"]
        self.assertNotIn(did, [d["id"] for d in self.bob.get("/api/designs").json()])
        for method, path, body in (("get", "", None), ("patch", "", {"title": "pwned"}), ("get", "/versions", None),
                                   ("get", "/comments", None), ("post", "/duplicate", {}), ("post", "/undo", {}),
                                   ("post", "/export", {"format": "html"}), ("get", "/boards/screen-1/html", None),
                                   ("get", "/boards/screen-1/thumb", None), ("delete", "", None)):
            with self.subTest(method=method, path=path):
                kwargs = {} if body is None else {"json": body}
                self.refused(f"bob {method} design{path}", getattr(self.bob, method)(f"/api/designs/{did}{path}", **kwargs))
                self.refused(f"anon {method} design{path}", getattr(self.anon, method)(f"/api/designs/{did}{path}", **kwargs))
        kept = self.alice.get(f"/api/designs/{did}")
        self.assertEqual((kept.status_code, kept.json()["title"]), (200, "alice design"))
        self.assertEqual(self.boss.get(f"/api/designs/{did}").status_code, 200, "an admin may open any design")

    # -- admin-only routers --------------------------------------------------

    def routes_under(self, prefix):
        found = []
        for template, item in app.openapi()["paths"].items():
            if template.startswith(prefix):
                for method in item:
                    found.append((method.upper(), template))
        return found

    def sweep(self, prefix, allow=()):
        routes = self.routes_under(prefix)
        self.assertGreater(len(routes), 5, f"no routes found under {prefix}; the sweep would be empty")
        for method, template in routes:
            if (method, template) in allow:
                continue
            path = compile_path(template)[0] and __import__("re").sub(r"\{[^}]+\}", "probe-id", template)
            with self.subTest(method=method, route=template):
                for who, c in (("member", self.bob), ("anonymous", self.anon)):
                    got = c.request(method, path, json=None if method == "GET" else {})
                    self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")

    def test_forge_is_refused_to_members_on_every_route(self):
        self.sweep("/api/forge")

    def test_agents_refuse_members_on_every_change_route(self):
        # Reading the list is member-visible by design (agents tab); every
        # route that creates, edits, deletes or directs an agent is admin-only.
        allow = {(m, t) for m, t in self.routes_under("/api/agents") if m == "GET" and t in ("/api/agents",)}
        allow |= {("POST", "/api/agents/conversations/{kind}/{ident}"), ("POST", "/api/agents/inbox/{item_id}/answer")}
        self.sweep("/api/agents", allow)


if __name__ == "__main__":
    unittest.main()
