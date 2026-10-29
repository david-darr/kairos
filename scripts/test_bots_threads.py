"""Bots redesign, Phase 0 unit U1: a bot's threads, folders and main thread (2026-10-28).

Spec: Kairos Projects/Agents Redesign/phase-0-design.md, sections 2.2 and 2.4.
Throwaway data folder, stand-in models. Run: python scripts/test_bots_threads.py
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-threads-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.middleware import require_admin, require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import agent_routes, session_routes  # noqa: E402
from services import bot_record, bot_threads, chat_live  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(agent_routes.router)
app.include_router(session_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)

API = {"id": "api1", "kind": "api", "model": "m"}
CLAUDE = {"id": "claude", "kind": "claude_cli"}


class ThreadTestCase(unittest.TestCase):
    def setUp(self):
        roster = patch.dict(agent_service._agents, {}, clear=True)
        roster.start()
        self.addCleanup(roster.stop)
        lists = patch("core.model_endpoints.list_endpoints", return_value=[CLAUDE, API])
        lists.start()
        self.addCleanup(lists.stop)
        gets = patch("core.model_endpoints.get_endpoint", side_effect=lambda i: {"claude": CLAUDE, "api1": API}.get(i))
        gets.start()
        self.addCleanup(gets.stop)
        self.bot = agent_service.create("Scout", role="Watches postings")
        self.other = agent_service.create("Archivist")
        self.made = []

    def session_for(self, agent, title="Chat", **thread):
        """A pre-Phase-0 style bot chat: attached to the bot, no thread record."""
        time.sleep(0.02)
        session = session_manager.create_session(title, owner_user="david")
        self.made.append(session["id"])
        self.addCleanup(lambda sid=session["id"]: session_manager.get_session(sid) and session_manager.delete_session(sid))
        session_manager.set_agent(session["id"], agent["id"], "frozen prompt")
        session_manager.set_model_endpoint(session["id"], "claude")
        if thread:
            session_manager.set_thread(session["id"], **thread)
        return session["id"]

    def thread_of(self, session_id):
        return bot_threads.thread_view(session_manager.get_session(session_id))

    def url(self, agent=None, tail=""):
        return f"/api/agents/{(agent or self.bot)['id']}/threads{tail}"


class HeaderAndStorageTests(ThreadTestCase):
    def test_the_listing_header_carries_the_thread_record(self):
        plain = session_manager.create_session("Plain")
        self.addCleanup(session_manager.delete_session, plain["id"])
        sid = self.session_for(self.bot)
        self.assertIsNone(session_manager.list_sessions(agent_id=self.bot["id"])[0]["thread"])
        session_manager.set_thread(sid, pinned=True, folder_id="f1")
        header = web.get(f"/api/sessions?agent_id={self.bot['id']}").json()[0]
        self.assertEqual(header["thread"], {"pinned": True, "folder_id": "f1"})
        self.assertEqual(bot_threads.thread_view(header)["archived_at"], None, "defaults fill the rest on read")
        self.assertEqual(set(bot_threads.thread_view(header)), set(bot_threads.THREAD_DEFAULTS))
        listed = {h["id"]: h for h in session_manager.list_sessions(include_agents=True)}
        self.assertIsNone(listed[plain["id"]]["thread"])

    def test_set_thread_changes_metadata_only(self):
        sid = self.session_for(self.bot)
        session_manager.append_message(sid, "user", "hello")
        before = session_manager.get_session(sid)
        session_manager.set_thread(sid, main=True)
        session_manager.set_thread(sid, pinned=True)
        after = session_manager.get_session(sid)
        self.assertEqual(after["thread"], {"main": True, "pinned": True}, "fields merge")
        self.assertEqual((after["messages"], after["updated_at"]), (before["messages"], before["updated_at"]))

    def test_release_agent_chats_clears_the_thread_record(self):
        sid = self.session_for(self.bot, main=True, pinned=True)
        self.assertEqual(session_manager.release_agent_chats(self.bot["id"]), 1)
        session = session_manager.get_session(sid)
        self.assertNotIn("thread", session)
        self.assertIsNone(session["agent_id"])
        self.assertIsNone(session_manager.list_sessions(include_agents=True)[0]["thread"])

    def test_deleting_a_bot_releases_its_threads(self):
        sid = self.session_for(self.bot, main=True)
        self.assertEqual(web.delete(f"/api/agents/{self.bot['id']}").status_code, 200)
        self.assertNotIn("thread", session_manager.get_session(sid))


class MainThreadTests(ThreadTestCase):
    def test_the_oldest_unarchived_conversation_becomes_main(self):
        oldest_archived = self.session_for(self.bot, "Archived", archived_at=time.time())
        oldest = self.session_for(self.bot, "Oldest")
        newest = self.session_for(self.bot, "Newest")
        self.assertEqual(bot_threads.ensure_main_threads(self.bot["id"]), {self.bot["id"]: oldest})
        self.assertTrue(self.thread_of(oldest)["main"])
        self.assertFalse(self.thread_of(oldest_archived)["main"])
        self.assertFalse(self.thread_of(newest)["main"])

    def test_it_is_idempotent_and_leaves_an_existing_main_alone(self):
        first = self.session_for(self.bot, "First")
        second = self.session_for(self.bot, "Second", main=True)
        bot_threads.ensure_main_threads()
        bot_threads.ensure_main_threads()
        self.assertEqual(bot_threads.ensure_main_threads(self.bot["id"])[self.bot["id"]], second)
        self.assertFalse(self.thread_of(first)["main"])

    def test_several_flags_heal_to_the_oldest(self):
        first = self.session_for(self.bot, "First", main=True)
        second = self.session_for(self.bot, "Second", main=True)
        bot_threads.ensure_main_threads()
        self.assertEqual((self.thread_of(first)["main"], self.thread_of(second)["main"]), (True, False))

    def test_a_coordination_thread_is_never_the_main(self):
        alone = session_manager.create_session("Coordination")
        self.addCleanup(session_manager.delete_session, alone["id"])
        session_manager.set_agent(alone["id"], self.bot["id"], "p", unattended=True)
        mine = self.session_for(self.bot, "Mine")
        bot_threads.ensure_main_threads(self.bot["id"])
        self.assertTrue(self.thread_of(mine)["main"])
        self.assertFalse(self.thread_of(alone["id"])["main"])

    def test_bots_with_no_chats_get_one_on_first_chat(self):
        self.assertEqual(bot_threads.ensure_main_threads(self.other["id"]), {self.other["id"]: None})
        made = web.post(self.url(self.other)).json()
        self.assertTrue(made["thread"]["main"])
        again = web.post(self.url(self.other)).json()
        self.assertFalse(again["thread"]["main"])
        self.assertEqual(web.get(self.url(self.other)).json()["main_id"], made["id"])

    def test_make_agent_chat_marks_main_only_for_an_attended_chat(self):
        lone = session_manager.create_session("Alone")
        self.addCleanup(session_manager.delete_session, lone["id"])
        agent_service.make_agent_chat(lone["id"], self.bot, attended=False)
        self.assertIsNone(session_manager.get_session(lone["id"]).get("thread"))
        chat = session_manager.create_session("Chat")
        self.addCleanup(session_manager.delete_session, chat["id"])
        agent_service.make_agent_chat(chat["id"], self.bot)
        self.assertTrue(session_manager.get_session(chat["id"])["thread"]["main"])
        second = session_manager.create_session("Second")
        self.addCleanup(session_manager.delete_session, second["id"])
        agent_service.make_agent_chat(second["id"], self.bot)
        self.assertNotIn("thread", session_manager.get_session(second["id"]))


class ThreadCrudTests(ThreadTestCase):
    def test_create_list_and_the_session_shape(self):
        first = web.post(self.url(), json={"title": "Plan the week"})
        self.assertEqual(first.status_code, 200, first.text)
        body = first.json()
        self.assertEqual(body["agent_id"], self.bot["id"])
        self.assertEqual(body["title"], "Plan the week")
        self.assertEqual(body["model_endpoint_id"], "claude")
        self.assertTrue(body["agent_prompt"].startswith("[You are Scout"))
        self.assertEqual(body["thread"]["main"], True)
        self.assertEqual((body["thread"]["opened_by"], body["thread"]["title_source"]), ("person", "person"))
        second = web.post(self.url()).json()
        self.assertEqual(second["title"], "New Chat")
        self.assertEqual((second["thread"]["main"], second["thread"]["title_source"]), (False, "machine"))
        for sid in (body["id"], second["id"]):
            self.addCleanup(session_manager.delete_session, sid)
        listed = web.get(self.url()).json()
        self.assertEqual(listed["main_id"], body["id"])
        self.assertEqual({t["id"] for t in listed["threads"]}, {body["id"], second["id"]})
        row = next(t for t in listed["threads"] if t["id"] == body["id"])
        self.assertEqual(set(row), {"id", "title", "created_at", "updated_at", "message_count", "model_endpoint_id",
                                    "model_override", "model_effort", "follows_bot_model", "thread", "status", "preview"})
        self.assertEqual((row["status"], row["follows_bot_model"], row["message_count"]), ("idle", True, 0))

    def test_a_working_thread_says_so_and_previews_its_last_message(self):
        sid = self.session_for(self.bot)
        session_manager.append_message(sid, "user", "hello there")
        session_manager.append_message(sid, "assistant", "Two roles found.")
        with patch.dict(chat_live._runs, {sid: {"status": "processing"}}):
            row = web.get(self.url()).json()["threads"][0]
        self.assertEqual((row["status"], row["preview"], row["message_count"]), ("working", "Two roles found.", 2))
        self.assertEqual(web.get(self.url()).json()["threads"][0]["status"], "idle")

    def test_creating_needs_a_model_and_checks_folder_and_approval(self):
        self.assertEqual(web.post(self.url(), json={"folder_id": "nope"}).status_code, 400)
        refused = web.post(self.url(), json={"approval_mode": "ask"})
        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertEqual(web.post(self.url(), json={"approval_mode": "bogus"}).status_code, 400)
        self.assertEqual(web.post(self.url(), json={"title": "x" * 201}).status_code, 400)
        self.assertEqual(session_manager.list_sessions(agent_id=self.bot["id"]), [], "nothing is made on a refusal")
        with patch.object(agent_service, "chat_endpoint", return_value=None):
            self.assertEqual(web.post(self.url()).status_code, 400)
        folder = web.post(f"/api/agents/{self.bot['id']}/folders", json={"name": "Work"}).json()
        made = web.post(self.url(), json={"folder_id": folder["id"], "approval_mode": "full"}).json()
        self.addCleanup(session_manager.delete_session, made["id"])
        self.assertEqual((made["thread"]["folder_id"], made["thread"]["approval_mode"]), (folder["id"], "full"))
        self.assertEqual(web.post("/api/agents/nobody/threads").status_code, 404)

    def test_every_thread_route_checks_the_bot_owns_the_thread(self):
        mine = self.session_for(self.bot)
        theirs = self.session_for(self.other)
        plain = session_manager.create_session("Plain chat")
        self.addCleanup(session_manager.delete_session, plain["id"])
        for sid in (theirs, plain["id"], "nope"):
            with self.subTest(sid=sid):
                self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"pinned": True}).status_code, 404)
        gone = web.post(self.url(tail="/delete"), json={"thread_ids": [theirs, plain["id"], mine]}).json()
        self.assertEqual((gone["missing"], gone["deleted"], gone["kept"]), ([theirs, plain["id"]], [], [mine]))
        self.assertIsNotNone(session_manager.get_session(theirs))
        self.assertIsNotNone(session_manager.get_session(plain["id"]))
        listed = {t["id"] for t in web.get(self.url()).json()["threads"]}
        self.assertEqual(listed, {mine})

    def test_patch_changes_each_field(self):
        sid = self.session_for(self.bot)
        other = self.session_for(self.bot, "Other")
        main = self.session_for(self.bot, "Main", main=True)
        folder = web.post(f"/api/agents/{self.bot['id']}/folders", json={"name": "Work", "emoji": "W"}).json()
        done = web.patch(self.url(tail=f"/{sid}"), json={"pinned": True, "unread": True, "folder_id": folder["id"],
                                                         "title": "  A   new   title "})
        self.assertEqual(done.status_code, 200, done.text)
        row = done.json()
        self.assertEqual(row["title"], "A new title")
        self.assertEqual((row["thread"]["pinned"], row["thread"]["unread"], row["thread"]["folder_id"],
                          row["thread"]["title_source"]), (True, True, folder["id"], "person"))
        self.assertEqual(session_manager.get_session(sid)["title"], "A new title")
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"folder_id": None}).json()["thread"]["folder_id"], None)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"folder_id": "nope"}).status_code, 400)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"place": "computer"}).json()["thread"]["place"], "computer")
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"place": "moon"}).status_code, 400)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"place": None}).json()["thread"]["place"], None)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"approval_mode": "full"}).json()["thread"]["approval_mode"], "full")
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"approval_mode": "edits"}).status_code, 409)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"approval_mode": "yolo"}).status_code, 400)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"approval_mode": None}).json()["thread"]["approval_mode"], None)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"title": ""}).status_code, 400)
        archived = web.patch(self.url(tail=f"/{other}"), json={"archived": True}).json()
        self.assertIsInstance(archived["thread"]["archived_at"], float)
        self.assertEqual(web.patch(self.url(tail=f"/{other}"), json={"archived": False}).json()["thread"]["archived_at"], None)
        refused = web.patch(self.url(tail=f"/{main}"), json={"archived": True})
        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={}).status_code, 200)

    def test_archived_threads_are_hidden_unless_asked_for(self):
        shown = self.session_for(self.bot, "Shown")
        hidden = self.session_for(self.bot, "Hidden")
        web.patch(self.url(tail=f"/{hidden}"), json={"archived": True})
        self.assertEqual({t["id"] for t in web.get(self.url()).json()["threads"]}, {shown})
        self.assertEqual({t["id"] for t in web.get(self.url() + "?include_archived=1").json()["threads"]}, {shown, hidden})

    def test_snooze_values(self):
        sid = self.session_for(self.bot)
        for value, expected in (("activity", 0), ("stop", None), (1893456000, 1893456000.0), (0, 0.0)):
            with self.subTest(value=value):
                got = web.patch(self.url(tail=f"/{sid}"), json={"snooze": value}).json()["thread"]["snoozed_until"]
                self.assertEqual(got, expected)
        for value in ("later", -5):
            self.assertEqual(web.patch(self.url(tail=f"/{sid}"), json={"snooze": value}).status_code, 400, value)
        morning = time.mktime((2026, 10, 28, 9, 0, 0, 0, 0, -1))
        evening = time.mktime((2026, 10, 28, 19, 30, 0, 0, 0, -1))
        self.assertEqual(time.localtime(bot_threads.snooze_until("tonight", morning))[2:5], (28, 18, 0))
        self.assertEqual(time.localtime(bot_threads.snooze_until("tonight", evening))[2:5], (29, 18, 0))
        self.assertEqual(time.localtime(bot_threads.snooze_until("tomorrow", evening))[2:5], (29, 8, 0))
        web.patch(self.url(tail=f"/{sid}"), json={"snooze": "tonight"})
        self.assertGreater(self.thread_of(sid)["snoozed_until"], time.time())


class FolderTests(ThreadTestCase):
    def folders(self, tail="", **kw):
        return f"/api/agents/{self.bot['id']}/folders{tail}"

    def test_folders_live_on_the_bot_and_keep_the_revision(self):
        revision = agent_service.get(self.bot["id"])["revision"]
        work = web.post(self.folders(), json={"name": " Work  stuff ", "emoji": "W"}).json()
        home = web.post(self.folders(), json={"name": "Home"}).json()
        self.assertEqual((work["name"], work["emoji"], work["order"], home["order"], home["emoji"]), ("Work stuff", "W", 0, 1, ""))
        self.assertEqual([f["id"] for f in agent_service.get(self.bot["id"])["folders"]], [work["id"], home["id"]])
        self.assertEqual(agent_service.get(self.bot["id"])["revision"], revision)
        renamed = web.patch(self.folders(f"/{home['id']}"), json={"name": "House", "emoji": "H"}).json()
        self.assertEqual((renamed["name"], renamed["emoji"]), ("House", "H"))
        self.assertEqual(web.patch(self.folders(f"/{home['id']}"), json={"name": ""}).status_code, 400)
        self.assertEqual(web.patch(self.folders("/nope"), json={"name": "x"}).status_code, 404)
        ordered = web.put(self.folders("/order"), json={"ids": [home["id"]]}).json()["folders"]
        self.assertEqual([f["id"] for f in ordered], [home["id"], work["id"]])
        self.assertEqual(web.put(self.folders("/order"), json={"ids": ["nope"]}).status_code, 400)
        self.assertEqual(web.put(self.folders("/order"), json={"ids": [work["id"], work["id"]]}).status_code, 400)

    def test_folder_limits(self):
        self.assertEqual(web.post(self.folders(), json={"name": "x" * 81}).status_code, 400)
        self.assertEqual(web.post(self.folders(), json={"name": "ok", "emoji": "123456789"}).status_code, 400)
        self.assertEqual(web.post(self.folders(), json={"name": "  "}).status_code, 400)
        with patch.object(bot_record, "MAX_FOLDERS", 2):
            self.assertEqual(web.post(self.folders(), json={"name": "a"}).status_code, 200)
            self.assertEqual(web.post(self.folders(), json={"name": "b"}).status_code, 200)
            self.assertEqual(web.post(self.folders(), json={"name": "c"}).status_code, 409)
        self.assertEqual(web.post("/api/agents/nobody/folders", json={"name": "a"}).status_code, 404)

    def test_deleting_a_folder_returns_its_threads_to_the_main_list(self):
        folder = web.post(self.folders(), json={"name": "Work"}).json()
        inside = self.session_for(self.bot, folder_id=folder["id"])
        outside = self.session_for(self.bot, folder_id="elsewhere")
        done = web.delete(self.folders(f"/{folder['id']}")).json()
        self.assertEqual(done, {"ok": True, "cleared": 1})
        self.assertIsNone(self.thread_of(inside)["folder_id"])
        self.assertEqual(self.thread_of(outside)["folder_id"], "elsewhere")
        self.assertEqual(agent_service.get(self.bot["id"])["folders"], [])
        self.assertEqual(web.delete(self.folders(f"/{folder['id']}")).status_code, 404)


class BulkDeleteTests(ThreadTestCase):
    def test_the_answer_lists_deleted_busy_and_missing(self):
        a, b, c = (self.session_for(self.bot, name) for name in "ABC")
        with patch.dict(chat_live._runs, {b: {"status": "processing"}}):
            gone = web.post(self.url(tail="/delete"), json={"thread_ids": [a, b, "ghost", a]}).json()
        self.assertEqual(gone, {"deleted": [a], "busy": [b], "missing": ["ghost"], "kept": []})
        self.assertIsNone(session_manager.get_session(a))
        self.assertIsNotNone(session_manager.get_session(b))
        self.assertIsNotNone(session_manager.get_session(c))

    def test_a_claimed_session_is_busy_too(self):
        from services import chat_service
        a, b, keeper = (self.session_for(self.bot, name) for name in ("A", "B", "Keeper"))
        chat_service.claim_session(a)
        try:
            gone = web.post(self.url(tail="/delete"), json={"thread_ids": [a, b]}).json()
        finally:
            chat_service.release_session(a)
        self.assertEqual((gone["deleted"], gone["busy"]), ([b], [a]))
        self.assertIsNotNone(session_manager.get_session(keeper))

    def test_the_bot_keeps_one_thread(self):
        a = self.session_for(self.bot, "A")
        b = self.session_for(self.bot, "B", main=True)
        c = self.session_for(self.bot, "C")
        gone = web.post(self.url(tail="/delete"), json={"thread_ids": [a, b, c]}).json()
        self.assertEqual((sorted(gone["deleted"]), gone["kept"]), (sorted([a, c]), [b]), "the main stays")
        self.assertEqual([t["id"] for t in web.get(self.url()).json()["threads"]], [b])
        single = web.post(self.url(tail="/delete"), json={"thread_ids": [b]}).json()
        self.assertEqual((single["deleted"], single["kept"]), ([], [b]))

    def test_deleting_the_main_promotes_the_oldest_remaining(self):
        main = self.session_for(self.bot, "Main", main=True)
        older = self.session_for(self.bot, "Next")
        newer = self.session_for(self.bot, "Newer")
        web.post(self.url(tail="/delete"), json={"thread_ids": [main]})
        self.assertTrue(self.thread_of(older)["main"])
        self.assertFalse(self.thread_of(newer)["main"])

    def test_the_batch_is_bounded(self):
        self.assertEqual(web.post(self.url(tail="/delete"), json={"thread_ids": []}).status_code, 422)
        self.assertEqual(web.post(self.url(tail="/delete"), json={"thread_ids": ["x"] * 201}).status_code, 422)
        self.assertEqual(web.post(self.url(tail="/delete"), json={"thread_ids": ["x"] * 200}).status_code, 200)


class FollowModelTests(ThreadTestCase):
    def test_follows_bot_model_is_derived_not_stored(self):
        agent_service.update(self.bot["id"], endpoint_id="api1", model_override="m-big")
        bot = agent_service.get(self.bot["id"])
        make = lambda **kw: {"model_endpoint_id": "api1", "model_override": None, "model_effort": None, **kw}  # noqa: E731
        self.assertTrue(bot_threads.follows_bot_model(make(), bot), "unset version is inherited at the turn")
        self.assertTrue(bot_threads.follows_bot_model(make(model_override="m-big"), bot))
        self.assertFalse(bot_threads.follows_bot_model(make(model_override="m-small"), bot))
        self.assertFalse(bot_threads.follows_bot_model(make(model_effort="high"), bot))
        self.assertFalse(bot_threads.follows_bot_model(make(model_endpoint_id="claude"), bot))
        self.assertFalse(bot_threads.follows_bot_model(make(model_endpoint_id=None), bot))
        plain = agent_service.create("Plain")
        self.assertTrue(bot_threads.follows_bot_model({"model_endpoint_id": "claude"}, plain),
                        "no model of its own: the first Claude connection")

    def test_switch_them_too_moves_only_threads_that_differ_and_reports_busy_ones(self):
        agent_service.update(self.bot["id"], endpoint_id="api1")
        following = self.session_for(self.bot, "Follows")
        session_manager.set_model_endpoint(following, "api1")
        drifted = self.session_for(self.bot, "Drifted")
        pinned = self.session_for(self.bot, "Pinned")
        session_manager.set_model_endpoint(pinned, "api1", "m-other")
        busy = self.session_for(self.bot, "Busy")
        listed = {t["id"]: t["follows_bot_model"] for t in web.get(self.url()).json()["threads"]}
        self.assertEqual(listed, {following: True, drifted: False, pinned: False, busy: False})
        with patch.dict(chat_live._runs, {busy: {"status": "processing"}}):
            done = web.post(self.url(tail="/follow-model")).json()
        self.assertEqual((sorted(done["updated"]), done["busy"]), (sorted([drifted, pinned]), [busy]))
        for sid in (drifted, pinned):
            session = session_manager.get_session(sid)
            self.assertEqual((session["model_endpoint_id"], session["model_override"], session["model_effort"]), ("api1", None, None))
        self.assertEqual(session_manager.get_session(busy)["model_endpoint_id"], "claude")
        self.assertEqual(web.post(self.url(tail="/follow-model")).json(), {"updated": [busy], "busy": []},
                         "once its turn is over the last one follows too, and nothing else differs")
        self.assertEqual(web.post(self.url(tail="/follow-model")).json()["updated"], [])
        with patch.object(agent_service, "chat_endpoint", return_value=None):
            self.assertEqual(web.post(self.url(tail="/follow-model")).status_code, 400)


if __name__ == "__main__":
    unittest.main()
