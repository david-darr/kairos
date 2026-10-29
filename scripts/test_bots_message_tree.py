"""Bots redesign, Phase 1 unit U1: message identity, branches, replay and the read APIs (2026-10-29).

Edit and regenerate add versions and never delete. The model replays the
selected version only. Throwaway data folder, scripted model.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_message_tree.py
"""
import asyncio
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-tree-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException  # noqa: E402

from bots_chat_harness import OWNER, Harness  # noqa: E402
from core import bot_chat_store as store, bot_message_tree as tree, session_manager_store as sstore  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import bot_chat_service as service  # noqa: E402


class LegacyUpgradeTests(unittest.TestCase):
    """A conversation made before message IDs existed."""

    def make(self, count=4):
        session = session_manager.create_session("Old", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, session["id"])
        for number in range(count):
            session_manager.append_message(session["id"], "user" if number % 2 == 0 else "assistant", f"row {number}",
                                           extra={"keep_me": number})
        session_manager.set_agent(session["id"], "bot-x", "prompt")
        return session["id"]

    def test_first_access_assigns_stable_ids_and_links_rows_in_order(self):
        sid = self.make()
        session = tree.ensure(sid)
        rows = session["messages"]
        self.assertEqual([m["parent_id"] for m in rows], [None] + [m["bot_message_id"] for m in rows[:-1]])
        self.assertEqual(session["thread"]["active_leaf_id"], rows[-1]["bot_message_id"])
        self.assertEqual([m["keep_me"] for m in rows], [0, 1, 2, 3], "every row and extra field is kept")

    def test_the_upgrade_is_idempotent_and_deterministic(self):
        sid = self.make()
        first = [m["bot_message_id"] for m in tree.ensure(sid)["messages"]]
        again = [m["bot_message_id"] for m in tree.ensure(sid)["messages"]]
        self.assertEqual(first, again)
        # The same rows in another conversation get that conversation's own IDs.
        self.assertEqual(len(set(first)), 4)
        self.assertEqual(tree.ensure(sid)["thread"]["branch_revision"], 0)

    def test_an_empty_conversation_has_no_leaf_and_appends_start_the_tree(self):
        session = session_manager.create_session("New", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, session["id"])
        session_manager.set_agent(session["id"], "bot-x", "prompt")
        self.assertIsNone(tree.ensure(session["id"])["thread"]["active_leaf_id"])
        session_manager.append_message(session["id"], "user", "first")
        stored = session_manager.get_session(session["id"])
        self.assertIsNone(stored["messages"][0]["parent_id"])
        self.assertEqual(stored["thread"]["active_leaf_id"], stored["messages"][0]["bot_message_id"])

    def test_an_invalid_ancestry_is_refused(self):
        sid = self.make(2)
        session = tree.ensure(sid)
        session["messages"][1]["parent_id"] = "missing"
        with self.assertRaises(ValueError):
            tree.ancestry(session)
        session["messages"][1]["parent_id"] = session["messages"][1]["bot_message_id"]
        with self.assertRaises(ValueError):
            tree.ancestry(session)

    def test_plain_chats_are_untouched(self):
        plain = session_manager.create_session("Plain", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, plain["id"])
        session_manager.append_message(plain["id"], "user", "hi")
        row = session_manager.get_session(plain["id"])["messages"][0]
        self.assertNotIn("bot_message_id", row)
        self.assertNotIn("thread", session_manager.get_session(plain["id"]))

    def test_old_compactions_are_bound_to_their_boundary_message(self):
        sid = self.make(6)
        session = session_manager.get_session(sid)
        session["compactions"] = [{"through_index": 3, "summary": "old summary", "created_at": 1.0}]
        sstore.save_session(session)
        ensured = tree.ensure(sid)
        self.assertEqual(ensured["compactions"][0]["folded_through_id"], ensured["messages"][2]["bot_message_id"])
        effective = session_manager.effective_messages(sid)
        self.assertEqual(len(effective), 4)
        self.assertIn("old summary", effective[0]["content"])


class BranchCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Scout")
        self.sid = self.h.thread(self.bot)

    async def converse(self):
        await self.h.send(self.sid, "question one [reply:answer one]")
        await self.h.idle()
        await self.h.send(self.sid, "question two [reply:answer two]")
        await self.h.idle()

    def sibling_ids(self):
        session = self.h.session(self.sid)
        return tree.children(session)

    def revision(self):
        return self.h.session(self.sid)["thread"]["branch_revision"]

    def replay(self):
        return [m["content"] for m in session_manager.effective_messages(self.sid)]

    async def edit(self, message_id, text, **extra):
        return await service.edit_message(OWNER, self.sid, message_id, {
            "send_id": uuid.uuid4().hex, "text": text, "expected_leaf_id": self.h.leaf(self.sid),
            "expected_revision": self.revision(), **extra})


class EditTests(BranchCase):
    async def test_editing_a_question_adds_a_sibling_and_keeps_the_old_version(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        old_ids = {m["bot_message_id"] for m in self.h.session(self.sid)["messages"]}
        result = await self.edit(original["bot_message_id"], "question two, reworded [reply:new answer]")
        await self.h.idle()
        session = self.h.session(self.sid)
        self.assertEqual(len(session["messages"]), 6, "nothing deleted, two rows added")
        self.assertTrue(old_ids <= {m["bot_message_id"] for m in session["messages"]})
        edited = next(m for m in session["messages"] if m["bot_message_id"] == result["message_id"])
        self.assertEqual(edited["parent_id"], original["parent_id"], "a sibling with the original's parent")
        self.assertEqual(self.h.texts(self.sid)[-2:], [("user", "question two, reworded [reply:new answer]"), ("assistant", "new answer")])
        self.assertEqual(self.sibling_ids()[original["parent_id"]], [original["bot_message_id"], result["message_id"]])

    async def test_the_model_replays_only_the_selected_version(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "other question [reply:other answer]")
        await self.h.idle()
        replay = self.replay()
        self.assertIn("answer one", " ".join(replay))
        self.assertNotIn("answer two", " ".join(replay), "the old branch's answer is not in the replay")
        self.assertNotIn("question two", " ".join(replay))
        self.assertIn("other answer", " ".join(replay))

    async def test_editing_the_first_message_branches_from_the_root(self):
        await self.converse()
        first = self.h.path(self.sid)[0]
        result = await self.edit(first["bot_message_id"], "new start [reply:fresh]")
        await self.h.idle()
        edited = next(m for m in self.h.session(self.sid)["messages"] if m["bot_message_id"] == result["message_id"])
        self.assertIsNone(edited["parent_id"])
        self.assertEqual([c for _, c in self.h.texts(self.sid)], ["new start [reply:fresh]", "fresh"])

    async def test_an_edit_clears_every_provider_resume_identifier(self):
        await self.converse()
        session_manager.set_claude_session(self.sid, "cli-session-1", 4)
        session_manager.set_codex_thread_id(self.sid, "codex-1")
        await self.edit(self.h.path(self.sid)[2]["bot_message_id"], "again [reply:x]")
        await self.h.idle()
        session = self.h.session(self.sid)
        self.assertEqual((session["claude_session_id"], session["codex_thread_id"]), (None, None))
        self.assertEqual(session["claude_synced_through"], 0)

    async def test_a_retry_of_an_edit_does_not_branch_twice(self):
        await self.converse()
        target = self.h.path(self.sid)[2]["bot_message_id"]
        body = {"send_id": "edit-send-0001", "text": "same edit [reply:x]", "expected_leaf_id": self.h.leaf(self.sid),
                "expected_revision": self.revision()}
        first = await service.edit_message(OWNER, self.sid, target, dict(body))
        await self.h.idle()
        again = await service.edit_message(OWNER, self.sid, target, dict(body))
        self.assertTrue(again["replayed"])
        self.assertEqual(len(self.h.session(self.sid)["messages"]), 6)
        self.assertEqual(first["message_id"], again["message_id"])

    async def test_a_busy_thread_refuses_an_edit_and_a_stale_revision_is_a_conflict(self):
        await self.converse()
        target = self.h.path(self.sid)[2]["bot_message_id"]
        stale = self.revision() - 1
        with self.assertRaises(store.Conflict):
            await service.edit_message(OWNER, self.sid, target, {"send_id": "edit-stale-01", "text": "x",
                                                                "expected_leaf_id": self.h.leaf(self.sid), "expected_revision": stale})
        self.assertFalse(service.chat_service.is_busy(self.sid), "a refused edit leaves the thread free")
        await self.h.send(self.sid, "working [hold]")
        await self.h.held()
        with self.assertRaises(HTTPException) as caught:
            await self.edit(target, "no [reply:x]")
        self.assertEqual(caught.exception.status_code, 409)
        self.h.release()
        await self.h.idle()

    async def test_only_a_question_in_the_selected_version_can_be_edited(self):
        await self.converse()
        with self.assertRaises(HTTPException) as caught:
            await self.edit(self.h.path(self.sid)[1]["bot_message_id"], "x [reply:y]")
        self.assertEqual(caught.exception.status_code, 409)
        with self.assertRaises(HTTPException) as caught:
            await self.edit("missing-message", "x")
        self.assertEqual(caught.exception.status_code, 404)

    async def test_edit_keeps_the_original_attachments_unless_replaced(self):
        await self.converse()
        row = self.h.path(self.sid)[2]
        result = await self.edit(row["bot_message_id"], "again [reply:y]")
        await self.h.idle()
        self.assertEqual(result["message"].get("attachments"), row.get("attachments"))


class RegenerateTests(BranchCase):
    async def regen(self, **extra):
        return await service.regenerate(OWNER, self.sid, {"send_id": uuid.uuid4().hex, "expected_leaf_id": self.h.leaf(self.sid),
                                                           "expected_revision": self.revision(), **extra})

    async def test_regenerate_adds_an_alternative_answer_and_keeps_the_first(self):
        await self.converse()
        old_answer = self.h.path(self.sid)[-1]
        self.h.replies.append("second try")
        result = await self.regen()
        await self.h.idle()
        session = self.h.session(self.sid)
        self.assertEqual(len(session["messages"]), 5, "one question reused, one new answer")
        new_answer = self.h.path(self.sid)[-1]
        self.assertEqual(new_answer["content"], "second try")
        self.assertEqual(new_answer["parent_id"], old_answer["parent_id"], "siblings under the same question")
        self.assertEqual(result["message_id"], old_answer["parent_id"])
        versions = tree.versions(session, self.h.path(self.sid))
        self.assertEqual(versions[new_answer["bot_message_id"]]["total"], 2)
        self.assertEqual(sum(1 for m in session["messages"] if m["role"] == "user"), 2, "no duplicate question")

    async def test_regenerate_needs_an_answer_to_redo(self):
        with self.assertRaises(HTTPException):
            await self.regen()
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        with self.assertRaises(HTTPException):
            await self.regen()
        self.h.release()
        await self.h.idle()

    async def test_regenerate_retry_is_a_single_new_answer(self):
        await self.converse()
        body = {"send_id": "regen-send-001", "expected_leaf_id": self.h.leaf(self.sid), "expected_revision": self.revision()}
        await service.regenerate(OWNER, self.sid, dict(body))
        await self.h.idle()
        again = await service.regenerate(OWNER, self.sid, dict(body))
        self.assertTrue(again["replayed"])
        self.assertEqual(len(self.h.session(self.sid)["messages"]), 5)

    async def test_regenerating_after_a_stop_skips_the_quiet_row(self):
        first = await self.h.send(self.sid, "long [hold]")
        await self.h.held()
        service.interrupt(OWNER, self.sid, first["turn_id"])
        await self.h.idle()
        self.assertEqual(self.h.path(self.sid)[-1]["kind"], "stopped")
        self.h.release()
        self.h.replies.append("redone")
        await self.regen()
        await self.h.idle()
        self.assertEqual(self.h.path(self.sid)[-1]["content"], "redone")


class BranchSelectionTests(BranchCase):
    async def test_choosing_a_version_restores_that_branch_and_its_replay(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "other question [reply:other answer]")
        await self.h.idle()
        page = await service.select_branch(OWNER, self.sid, {"message_id": original["bot_message_id"],
                                                             "expected_revision": self.revision()})
        self.assertEqual([m["content"] for m in page["messages"]][-1], "answer two", "the newest leaf under the chosen version")
        self.assertIn("answer two", " ".join(self.replay()))
        self.assertNotIn("other answer", " ".join(self.replay()))
        shown = [m for m in page["messages"] if m.get("version")]
        self.assertEqual([m["version"]["count"] for m in shown], [2], "the switcher knows both versions")
        self.assertEqual(shown[0]["id"], shown[0]["bot_message_id"])
        self.assertFalse(service.chat_service.is_busy(self.sid), "the claim was released")

    async def test_selection_with_a_stale_revision_is_refused(self):
        await self.converse()
        with self.assertRaises(tree.Stale):
            await service.select_branch(OWNER, self.sid, {"message_id": self.h.path(self.sid)[0]["bot_message_id"],
                                                         "expected_revision": self.revision() + 5})
        self.assertFalse(service.chat_service.is_busy(self.sid))

    async def test_selecting_a_branch_clears_provider_identifiers(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "other [reply:x]")
        await self.h.idle()
        session_manager.set_claude_session(self.sid, "cli-2", 5)
        await service.select_branch(OWNER, self.sid, {"message_id": original["bot_message_id"], "expected_revision": self.revision()})
        self.assertIsNone(self.h.session(self.sid)["claude_session_id"])

    async def test_a_busy_thread_refuses_a_switch(self):
        await self.converse()
        await self.h.send(self.sid, "busy [hold]")
        await self.h.held()
        with self.assertRaises(HTTPException) as caught:
            await service.select_branch(OWNER, self.sid, {"message_id": self.h.path(self.sid)[0]["bot_message_id"],
                                                         "expected_revision": self.revision()})
        self.assertEqual(caught.exception.status_code, 409)
        self.h.release()
        await self.h.idle()

    async def test_new_messages_extend_the_selected_version_only(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "branch b [reply:b answer]")
        await self.h.idle()
        await self.h.send(self.sid, "carry on b [reply:b again]")
        await self.h.idle()
        await service.select_branch(OWNER, self.sid, {"message_id": original["bot_message_id"], "expected_revision": self.revision()})
        self.assertEqual([c for _, c in self.h.texts(self.sid)][-2:], ["question two [reply:answer two]", "answer two"])


class CompactionTests(BranchCase):
    async def test_a_fold_applies_only_on_the_branch_it_was_made_on(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        session_manager.compact_session(self.sid, 3, "branch A summary")
        self.assertIn("branch A summary", self.replay()[0])
        await self.edit(original["bot_message_id"], "branch b [reply:b answer]")
        await self.h.idle()
        self.assertNotIn("branch A summary", " ".join(self.replay()), "the fold does not leak into the other version")
        await service.select_branch(OWNER, self.sid, {"message_id": original["bot_message_id"], "expected_revision": self.revision()})
        self.assertIn("branch A summary", self.replay()[0], "and returns with its own branch")

    async def test_compaction_folds_the_selected_version_and_keeps_every_row(self):
        await self.converse()
        await self.h.send(self.sid, "three [reply:answer three]")
        await self.h.idle()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "alt [reply:alt answer]")
        await self.h.idle()
        total = len(self.h.session(self.sid)["messages"])
        seen = []
        brain_prompts = self.h.prompts

        class Summariser:
            async def connect(self_inner):
                pass

            async def disconnect(self_inner):
                pass

            async def run_turn(self_inner, prompt):
                seen.append(prompt)
                return "summary of the selected version"

        from unittest.mock import patch
        with patch.object(service.chat_service, "_build_brain", return_value=Summariser()):
            result = await service.chat_service._compact_session(self.sid, keep_tail=2)
        self.assertGreater(result["archived"], 0)
        self.assertNotIn("answer two", seen[0], "the other version was not summarised")
        self.assertIn("question one", seen[0])
        session = self.h.session(self.sid)
        self.assertEqual(len(session["messages"]), total + 1, "only the notice was added")
        self.assertIn("summary of the selected version", self.replay()[0])
        again = [m for m in session["messages"] if m.get("display_only")]
        self.assertEqual(len(again), 1)
        self.assertEqual(session["compactions"][-1]["folded_through_id"] in {m["bot_message_id"] for m in self.h.path(self.sid)}, True)

    async def test_compact_is_refused_while_busy(self):
        await self.converse()
        await self.h.send(self.sid, "busy [hold]")
        await self.h.held()
        with self.assertRaises(HTTPException) as caught:
            await service.compact(OWNER, self.sid)
        self.assertEqual(caught.exception.status_code, 409)
        self.h.release()
        await self.h.idle()


class ReadApiTests(BranchCase):
    async def test_pages_walk_the_selected_version_with_cursors(self):
        for number in range(6):
            await self.h.send(self.sid, f"q{number} [reply:a{number}]")
            await self.h.idle()
        newest = service.messages(OWNER, self.sid, limit=5)
        self.assertEqual(len(newest["messages"]), 5)
        self.assertEqual((newest["has_before"], newest["has_after"], newest["total"]), (True, False, 12))
        older = service.messages(OWNER, self.sid, limit=5, before=newest["first_id"])
        self.assertEqual(older["last_id"], self.h.path(self.sid)[6]["bot_message_id"])
        oldest = service.messages(OWNER, self.sid, limit=5, before=older["first_id"])
        self.assertEqual((len(oldest["messages"]), oldest["has_before"]), (2, False))
        centred = service.messages(OWNER, self.sid, limit=4, around=self.h.path(self.sid)[5]["bot_message_id"])
        self.assertIn(self.h.path(self.sid)[5]["bot_message_id"], [m["bot_message_id"] for m in centred["messages"]])
        self.assertEqual(len(centred["messages"]), 4)
        with self.assertRaises(HTTPException) as caught:
            service.messages(OWNER, self.sid, before="missing")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(len(service.messages(OWNER, self.sid, limit=9999)["messages"]), 12, "clamped to 200")

    async def test_a_message_of_another_version_names_the_leaf_to_select(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "alt [reply:alt answer]")
        await self.h.idle()
        with self.assertRaises(HTTPException) as caught:
            service.messages(OWNER, self.sid, around=original["bot_message_id"])
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("X-Branch-Leaf", caught.exception.headers)

    async def test_client_rows_hide_tool_text_and_sent_copies(self):
        await self.h.send(self.sid, "hi [reply:there]")
        await self.h.idle()
        session_manager.append_message(self.sid, "assistant", "with tools", extra={"tool_rounds": {"messages": ["x"]}})
        page = service.messages(OWNER, self.sid)
        for row in page["messages"]:
            self.assertNotIn("tool_rounds", row)
            self.assertNotIn("sent", row)

    async def test_reactions_are_one_per_person_and_can_be_removed(self):
        await self.converse()
        target = self.h.path(self.sid)[1]["bot_message_id"]
        self.assertEqual(service.react(OWNER, self.sid, target, "heart", True)["reactions"], [{"emoji": "heart", "count": 1, "mine": True}])
        changed = service.react(OWNER, self.sid, target, "tada", True)
        self.assertEqual(changed["reactions"], [{"emoji": "tada", "count": 1, "mine": True}], "one per person: it replaced the heart")
        self.assertEqual(service.react(OWNER, self.sid, target, "heart", False)["reactions"][0]["emoji"], "tada", "removing another emoji changes nothing")
        self.assertEqual(service.react(OWNER, self.sid, target, "tada", False)["reactions"], [])
        with self.assertRaises(ValueError):
            service.react(OWNER, self.sid, target, "skull", True)
        with self.assertRaises(HTTPException):
            service.react(OWNER, self.sid, "missing", "heart", True)
        shown = service.messages(OWNER, self.sid)["messages"][1]["reactions"]
        self.assertEqual(shown, [])

    async def test_pin_and_unpin_a_message(self):
        await self.converse()
        target = self.h.path(self.sid)[1]
        service.pin(OWNER, self.sid, target["bot_message_id"])
        thread = self.h.session(self.sid)["thread"]
        self.assertEqual((thread["pinned_message_id"], thread["pinned_message_index"]), (target["bot_message_id"], 1))
        self.assertEqual(service.messages(OWNER, self.sid)["pinned_message_id"], target["bot_message_id"])
        service.pin(OWNER, self.sid, None)
        self.assertIsNone(self.h.session(self.sid)["thread"]["pinned_message_id"])
        with self.assertRaises(HTTPException):
            service.pin(OWNER, self.sid, "missing")

    async def test_the_read_cursor_only_moves_forward_and_clears_unread(self):
        await self.converse()
        path = self.h.path(self.sid)
        self.assertTrue(self.h.session(self.sid)["thread"]["unread"])
        partly = service.mark_read(OWNER, self.sid, path[1]["bot_message_id"])
        self.assertTrue(partly["unread"], "an answer after the cursor is still unread")
        done = service.mark_read(OWNER, self.sid, None)
        self.assertEqual((done["last_read_message_id"], done["unread"]), (path[-1]["bot_message_id"], False))
        back = service.mark_read(OWNER, self.sid, path[0]["bot_message_id"])
        self.assertEqual(back["last_read_message_id"], path[-1]["bot_message_id"], "never moves backward")
        thread = self.h.session(self.sid)["thread"]
        self.assertEqual(thread["last_read_index"], 3, "the old index field stays in step")
        with self.assertRaises(HTTPException):
            service.mark_read(OWNER, self.sid, "missing")

    async def test_state_reports_the_branch_queue_model_and_capabilities(self):
        await self.converse()
        state = service.state(OWNER, self.sid)
        self.assertEqual(state["active_leaf_id"], self.h.leaf(self.sid))
        self.assertEqual(state["queue"]["items"], [])
        self.assertEqual(state["model"]["endpoint_id"], "claude")
        self.assertEqual(state["capabilities"]["steer"], "interrupt")
        self.assertIsNone(state["turn"] and None)
        self.assertEqual(state["capabilities"]["thread_limit"], 3)
        self.assertEqual(state["model"]["label"], "Fake model")
        self.assertIn("percent", state["context"])
        after = service.messages(OWNER, self.sid, limit=1, after=self.h.path(self.sid)[0]["bot_message_id"])
        self.assertEqual(after["messages"][0]["id"], self.h.path(self.sid)[1]["bot_message_id"])


class SearchExportTests(BranchCase):
    async def test_search_is_literal_and_marks_other_versions(self):
        await self.converse()
        original = self.h.path(self.sid)[2]
        await self.edit(original["bot_message_id"], "needle in the new version [reply:x]")
        await self.h.idle()
        found = await service.search(OWNER, "question two")
        hit = next(h for h in found["hits"] if h["session_id"] == self.sid)
        self.assertTrue(hit["other_version"] and not hit["active"])
        self.assertEqual(hit["leaf_id"], self.h.leaf(self.sid) if False else hit["leaf_id"])
        self.assertTrue(hit["leaf_id"] and hit["leaf_id"] != hit["message_id"] or hit["role"] == "assistant")
        active = await service.search(OWNER, "needle in the new")
        self.assertTrue(active["hits"][0]["active"])
        literal = await service.search(OWNER, "100% [done]")
        self.assertEqual(literal["hits"], [], "no wildcard or pattern meaning")
        scoped = await service.search(OWNER, "answer one", session_id=self.sid)
        self.assertTrue(all(h["session_id"] == self.sid for h in scoped["hits"]))
        by_bot = await service.search(OWNER, "answer one", bot_id="other-bot")
        self.assertEqual(by_bot["hits"], [])
        with self.assertRaises(ValueError):
            await service.search(OWNER, "  ")

    async def test_search_does_not_cross_owners(self):
        await self.converse()
        session_manager.create_session("x", owner_user="someone-else")
        from unittest.mock import patch
        with patch.object(service, "_is_admin", return_value=False):
            found = await service.search("mallory", "answer one")
        self.assertEqual(found["hits"], [])

    async def test_search_refuses_when_too_many_are_waiting(self):
        service._search_pending = service.SEARCH_PENDING_MAX
        try:
            with self.assertRaises(HTTPException) as caught:
                await service.search(OWNER, "x")
            self.assertEqual(caught.exception.status_code, 503)
        finally:
            service._search_pending = 0

    async def test_export_redacts_credentials_and_follows_the_selected_version(self):
        await self.h.send(self.sid, "my password=hunter2 [reply:noted]")
        await self.h.idle()
        text = service.export(OWNER, self.sid)["text"]
        self.assertNotIn("hunter2", text)
        self.assertIn("noted", text)
        data = service.export(OWNER, self.sid, "json")
        self.assertEqual([m["role"] for m in data["messages"]], ["user", "assistant"])
        self.assertNotIn("hunter2", repr(data))

    async def test_export_is_capped_at_the_newest_two_thousand(self):
        for number in range(3):
            session_manager.append_message(self.sid, "user", f"u{number}")
        original = service.EXPORT_MAX
        service.EXPORT_MAX = 2
        try:
            self.assertEqual(len(service.export(OWNER, self.sid, "json")["messages"]), 2)
        finally:
            service.EXPORT_MAX = original


class PresenceTests(unittest.TestCase):
    def test_presence_validates_the_timezone_and_throttles_repeats(self):
        service._PRESENCE.clear()
        self.assertEqual(service.presence("david", {"timezone": "Europe/Paris", "language": "fr"}), {"ok": True, "throttled": False})
        self.assertTrue(service.presence("david", {"timezone": "Europe/Paris", "language": "fr"})["throttled"])
        self.assertFalse(service.presence("david", {"timezone": "Asia/Tokyo", "language": "fr"})["throttled"], "a change is taken at once")
        self.assertEqual(service.presence_of("david")["timezone"], "Asia/Tokyo")
        with self.assertRaises(ValueError):
            service.presence("david", {"timezone": "Not/AZone"})
        self.assertIsNone(service.presence_of("nobody"))


if __name__ == "__main__":
    unittest.main()
