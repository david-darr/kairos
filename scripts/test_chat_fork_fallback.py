"""A04 gap suite: Fork, model fallback (retry/continue with another model), rewind
ownership and concurrent-chat isolation, through the real session routes.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/test_chat_fork_fallback.py
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

fixture = tempfile.TemporaryDirectory(prefix="kairos-fork-test-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import attachments, middleware
from core.session_manager import session_manager
from routes import chat_routes, session_routes
from services import chat_service

app = FastAPI()
app.add_middleware(middleware.SecurityHeadersMiddleware)
app.include_router(chat_routes.router)
app.include_router(session_routes.router)
client = TestClient(app)
ENDPOINTS = {
    "a": {"id": "a", "name": "A", "kind": "claude_cli", "model": "m-a"},
    "b": {"id": "b", "name": "B", "kind": "codex_cli", "model": "m-b"},
    "text": {"id": "text", "name": "TextOnly", "kind": "local", "model": "t", "supports_images": False},
    "vision": {"id": "vision", "name": "Vision", "kind": "local", "model": "v", "supports_images": True},
}


def failed_turn(sid, endpoint_id="a", kind="model_error", content="", had_tools=False, attachments_=None, sent=None):
    extra = {"attachments": attachments_} if attachments_ is not None else {}
    if sent:
        extra["sent"] = sent
    session_manager.append_message(sid, "user", "please do it", extra=extra)
    session_manager.append_message(sid, "assistant", content, status="failed",
                                   extra={"failure_kind": kind, "failure_model_endpoint_id": endpoint_id,
                                          "failure_model_name": "A", "failure_had_tools": had_tools})


class ForkTests(unittest.TestCase):
    def setUp(self):
        self.sid = session_manager.create_session("Source chat")["id"]
        self.addCleanup(session_manager.delete_session, self.sid)
        for role, text in [("user", "q1"), ("assistant", "a1"), ("user", "q2"), ("assistant", "a2")]:
            session_manager.append_message(self.sid, role, text)
        session_manager.set_permission_mode(self.sid, "auto")
        session_manager.set_claude_session(self.sid, "cli-1", synced_through=4)
        session_manager.set_codex_thread_id(self.sid, "thread-1")

    def test_fork_copies_through_the_chosen_message_and_leaves_the_source_whole(self):
        with patch.object(chat_service, "close_session_brain", AsyncMock()):
            response = client.post(f"/api/sessions/{self.sid}/fork", json={"through_index": 1})
        self.assertEqual(response.status_code, 200, response.text)
        fork_id = response.json()["id"]
        self.addCleanup(session_manager.delete_session, fork_id)
        self.assertNotEqual(fork_id, self.sid)
        self.assertEqual(response.json()["title"], "Source chat (fork)")
        fork = session_manager.get_session(fork_id)
        self.assertEqual([m["content"] for m in fork["messages"]], ["q1", "a1"])
        self.assertEqual(fork["forked_from"], {"session_id": self.sid, "message_index": 1})
        # The source is untouched and still carries its provider threads.
        source = session_manager.get_session(self.sid)
        self.assertEqual([m["content"] for m in source["messages"]], ["q1", "a1", "q2", "a2"])
        self.assertEqual(source["claude_session_id"], "cli-1")
        self.assertEqual(source["codex_thread_id"], "thread-1")
        self.assertEqual(source["permission_mode"], "auto")

    def test_a_fork_never_inherits_provider_threads_or_automatic_approval(self):
        fork = session_manager.fork_session(self.sid, 3)
        self.addCleanup(session_manager.delete_session, fork["id"])
        stored = session_manager.get_session(fork["id"])
        self.assertIsNone(stored["claude_session_id"])
        self.assertIsNone(stored["codex_thread_id"])
        self.assertEqual(stored["claude_synced_through"], 0)
        self.assertEqual(stored["permission_mode"], "base")
        self.assertEqual(len(stored["messages"]), 4)

    def test_fork_edits_do_not_leak_back_to_the_source(self):
        fork = session_manager.fork_session(self.sid, 1)
        self.addCleanup(session_manager.delete_session, fork["id"])
        session_manager.append_message(fork["id"], "user", "only in the fork")
        self.assertEqual(len(session_manager.get_session(self.sid)["messages"]), 4)
        self.assertEqual(len(session_manager.get_session(fork["id"])["messages"]), 3)

    def test_bad_indexes_unknown_chats_and_busy_chats_are_refused(self):
        for bad in (-1, 4, 99):
            self.assertEqual(client.post(f"/api/sessions/{self.sid}/fork", json={"through_index": bad}).status_code, 400, bad)
        with self.assertRaises(ValueError):  # the manager rejects a boolean; the route's pydantic model coerces True to 1 first
            session_manager.fork_session(self.sid, True)
        self.assertEqual(client.post("/api/sessions/nope/fork", json={"through_index": 0}).status_code, 404)
        chat_service._busy.add(self.sid)
        try:
            self.assertEqual(client.post(f"/api/sessions/{self.sid}/fork", json={"through_index": 0}).status_code, 409)
        finally:
            chat_service._busy.discard(self.sid)
        ids = [s["id"] for s in session_manager.list_sessions() if s["title"] == "Source chat (fork)"]
        self.assertEqual(ids, [], "refused forks leave no chat behind")

    def test_a_fork_keeps_only_files_from_before_its_cutoff(self):
        now = time.time()
        session = session_manager.get_session(self.sid)
        before = {"id": "f-before", "origin": "generated", "created_at": now - 1000, "name": "early.md"}
        after = {"id": "f-after", "origin": "generated", "created_at": now + 1000, "name": "late.md"}
        session_manager.register_chat_file(self.sid, before)
        session_manager.register_chat_file(self.sid, after)
        fork = session_manager.fork_session(self.sid, 1)
        self.addCleanup(session_manager.delete_session, fork["id"])
        names = [f["name"] for f in session_manager.get_session(fork["id"]).get("chat_files", [])]
        self.assertNotIn("late.md", names, "a later turn's file does not appear in the earlier fork")


class FallbackTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch("core.model_endpoints.get_endpoint", side_effect=lambda key: ENDPOINTS.get(key))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.sid = session_manager.create_session("Fallback chat")["id"]
        self.addCleanup(session_manager.delete_session, self.sid)
        session_manager.append_message(self.sid, "user", "earlier")
        session_manager.append_message(self.sid, "assistant", "earlier answer")

    def post(self, index, endpoint):
        with patch.object(chat_service, "close_session_brain", AsyncMock()) as closed:
            response = client.post(f"/api/sessions/{self.sid}/fallback",
                                   json={"failed_index": index, "model_endpoint_id": endpoint})
        return response, closed

    def messages(self):
        return session_manager.get_session(self.sid)["messages"]

    def test_an_empty_failed_turn_is_removed_and_the_chat_moves_to_the_new_model_once(self):
        failed_turn(self.sid)
        response, closed = self.post(3, "b")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "model_endpoint_id": "b"})
        closed.assert_awaited_once_with(self.sid)
        # Only the failed user+assistant pair is gone; the client resends the saved user text.
        self.assertEqual([m["content"] for m in self.messages()], ["earlier", "earlier answer"])
        self.assertEqual(session_manager.get_session(self.sid)["model_endpoint_id"], "b")
        # A duplicate click cannot delete more history: the failure is gone.
        again, _ = self.post(3, "b")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(len(self.messages()), 2)

    def test_partial_or_tool_failures_must_switch_and_continue_not_retry(self):
        failed_turn(self.sid, content="partial words")
        response, _ = self.post(3, "b")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Switch models and continue", response.json()["detail"])
        self.assertEqual(len(self.messages()), 4, "the partial attempt stays in the chat")

    def test_tool_activity_alone_also_blocks_a_silent_retry(self):
        failed_turn(self.sid, had_tools=True)
        self.assertEqual(self.post(3, "b")[0].status_code, 409)
        self.assertEqual(len(self.messages()), 4)

    def test_same_model_unknown_model_stale_index_and_non_failures_are_refused_without_edits(self):
        failed_turn(self.sid)
        self.assertEqual(self.post(3, "a")[0].status_code, 400, "must be a different model")
        self.assertEqual(self.post(3, "ghost")[0].status_code, 400, "unknown model")
        self.assertEqual(self.post(2, "b")[0].status_code, 409, "index must be the last message")
        self.assertEqual(self.post(9, "b")[0].status_code, 409)
        self.assertEqual(len(self.messages()), 4, "nothing was cut by a refused request")
        self.assertEqual(client.post("/api/sessions/nope/fallback", json={"failed_index": 1, "model_endpoint_id": "b"}).status_code, 404)

    def test_only_model_errors_and_rate_limits_are_eligible(self):
        failed_turn(self.sid, kind="request_error")
        self.assertEqual(self.post(3, "b")[0].status_code, 409)
        self.assertEqual(len(self.messages()), 4)

    def test_a_busy_chat_refuses_fallback(self):
        failed_turn(self.sid)
        chat_service._busy.add(self.sid)
        try:
            self.assertEqual(self.post(3, "b")[0].status_code, 409)
        finally:
            chat_service._busy.discard(self.sid)
        self.assertEqual(len(self.messages()), 4)

    def test_lost_attachments_block_the_retry_instead_of_dropping_them(self):
        failed_turn(self.sid, sent="[Attached file(s)]\nreport.pdf\nplease do it")
        response, _ = self.post(3, "b")
        self.assertEqual(response.status_code, 409)
        self.assertIn("attachments cannot be restored", response.json()["detail"])
        self.assertEqual(len(self.messages()), 4)

    def test_a_missing_staged_attachment_is_named_and_blocks_the_retry(self):
        failed_turn(self.sid, attachments_=[{"id": "gone-id", "name": "x.txt"}])
        with patch.object(attachments, "staged_file_info", return_value=None):
            response, _ = self.post(3, "b")
        self.assertEqual(response.status_code, 409)
        self.assertIn("no longer available", response.json()["detail"])

    def test_a_present_staged_attachment_allows_the_retry(self):
        failed_turn(self.sid, attachments_=[{"id": "kept-id", "name": "x.txt"}])
        with patch.object(attachments, "staged_file_info", return_value=("/x/kept-id_x.txt", "x.txt")):
            response, _ = self.post(3, "b")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.messages()), 2)

    def test_an_image_message_cannot_fall_back_to_a_text_only_model(self):
        failed_turn(self.sid)
        stored = session_manager.get_session(self.sid)
        session_manager.rewind(self.sid, 2)
        session_manager.append_message(self.sid, "user", "look", extra={"image_attachment_ids": ["img1"]})
        session_manager.append_message(self.sid, "assistant", "", status="failed",
                                       extra={"failure_kind": "model_error", "failure_model_endpoint_id": "a",
                                              "failure_model_name": "A", "failure_had_tools": False})
        refused, _ = self.post(3, "text")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(len(self.messages()), 4)
        with patch.object(attachments, "staged_file_info", return_value=None):
            accepted, _ = self.post(3, "vision")
        self.assertEqual(accepted.status_code, 200, accepted.text)

    def test_a_fallback_into_a_compacted_stretch_drops_the_fold_it_reaches(self):
        # Seamless compaction (2026-11-07): a fold the person never saw must not block a retry.
        failed_turn(self.sid)
        session_manager.compact_session(self.sid, 3, "the earlier exchange and the question")
        response, _ = self.post(3, "b")
        self.assertEqual(response.status_code, 200, response.text)
        session = session_manager.get_session(self.sid)
        self.assertEqual([m["content"] for m in session["messages"]], ["earlier", "earlier answer"])
        self.assertEqual(session.get("compactions") or [], [])


class ConcurrentChatIsolation(unittest.TestCase):
    def test_two_chats_keep_their_own_model_mode_and_messages(self):
        with patch("core.model_endpoints.get_endpoint", side_effect=lambda key: ENDPOINTS.get(key)):
            one = session_manager.create_session("one")["id"]
            two = session_manager.create_session("two")["id"]
            self.addCleanup(session_manager.delete_session, one)
            self.addCleanup(session_manager.delete_session, two)
            session_manager.set_model_endpoint(one, "a")
            session_manager.set_model_endpoint(two, "b")
            session_manager.set_permission_mode(one, "auto")
            session_manager.append_message(one, "user", "only one")
            session_manager.append_message(two, "user", "only two")
            chat_service._busy.add(one)
            try:
                # A running reply in one chat does not block the other.
                other = client.post(f"/api/sessions/{two}/fork", json={"through_index": 0})
                self.assertEqual(other.status_code, 200, other.text)
                self.addCleanup(session_manager.delete_session, other.json()["id"])
                self.assertEqual(client.post(f"/api/sessions/{one}/fork", json={"through_index": 0}).status_code, 409)
            finally:
                chat_service._busy.discard(one)
            first, second = session_manager.get_session(one), session_manager.get_session(two)
            self.assertEqual((first["model_endpoint_id"], second["model_endpoint_id"]), ("a", "b"))
            self.assertEqual((first["permission_mode"], second.get("permission_mode", "base")), ("auto", "base"))
            self.assertEqual([m["content"] for m in first["messages"]], ["only one"])
            self.assertEqual([m["content"] for m in second["messages"]], ["only two"])


if __name__ == "__main__":
    unittest.main()
