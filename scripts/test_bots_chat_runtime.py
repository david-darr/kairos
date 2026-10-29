"""Bots redesign, Phase 1 unit U1: acceptance, queue, slots, Stop and steer (2026-10-29).

Real session transactions and real turn handling with a scripted model
(scripts/bots_chat_harness.py). Throwaway data folder.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_chat_runtime.py
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-runtime-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402

from bots_chat_harness import OWNER, Harness  # noqa: E402
from core import bot_chat_store as store, bot_message_tree as tree, session_manager_store as sstore  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import bot_chat_routes, chat_routes  # noqa: E402
from services import bot_chat_service as service, chat_live, chat_service  # noqa: E402

app = FastAPI()
app.include_router(bot_chat_routes.router)
app.include_router(chat_routes.router)
app.dependency_overrides[require_user] = lambda: OWNER
app.dependency_overrides[require_admin] = lambda: OWNER


class RuntimeCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Scout", thread_limit=3)
        self.sid = self.h.thread(self.bot)

    def followups(self, sid=None):
        with sstore.transaction() as conn:
            rows = conn.execute("SELECT id, state, send_id, message_id FROM bot_followups WHERE session_id=? ORDER BY sequence",
                                (sid or self.sid,)).fetchall()
        return [dict(r) for r in rows]

    def user_rows(self, sid=None):
        return [m for m in self.h.session(sid or self.sid)["messages"] if m["role"] == "user"]


class AcceptanceTests(RuntimeCase):
    async def test_a_send_is_saved_before_the_reply_and_links_the_tree(self):
        result = await self.h.send(self.sid, "hello [reply:hi there]")
        self.assertTrue(result["accepted"] and not result["queued"])
        saved = self.user_rows()
        self.assertEqual([m["content"] for m in saved], ["hello [reply:hi there]"], "saved at admission")
        self.assertEqual(result["message_id"], saved[0]["bot_message_id"])
        await self.h.idle()
        path = self.h.path(self.sid)
        self.assertEqual([m["role"] for m in path], ["user", "assistant"])
        self.assertEqual(path[1]["parent_id"], path[0]["bot_message_id"])
        self.assertEqual(path[1]["content"], "hi there")
        self.assertEqual(self.h.leaf(self.sid), path[1]["bot_message_id"])
        self.assertTrue(self.h.session(self.sid)["thread"]["unread"])
        self.assertEqual(len(self.h.prompts), 1, "the saved message was not appended twice")

    async def test_a_retry_with_the_same_send_id_returns_the_first_result(self):
        first = await self.h.send(self.sid, "once", send_id="send-id-one", leaf=None)
        again = await service.send(OWNER, self.sid, {"send_id": "send-id-one", "text": "once",
                                                    "expected_leaf_id": self.h.leaf(self.sid)})
        self.assertTrue(again["replayed"])
        self.assertEqual((again["turn_id"], again["message_id"]), (first["turn_id"], first["message_id"]))
        await self.h.idle()
        self.assertEqual(len(self.user_rows()), 1)
        self.assertEqual(len(self.h.prompts), 1, "no second turn")

    async def test_simultaneous_duplicate_sends_run_once(self):
        leaf = self.h.leaf(self.sid)
        body = {"send_id": "same-send-id", "text": "double tap", "expected_leaf_id": leaf}
        results = await asyncio.gather(service.send(OWNER, self.sid, body), service.send(OWNER, self.sid, dict(body)))
        await self.h.idle()
        self.assertEqual(len(self.user_rows()), 1)
        self.assertEqual(results[0]["message_id"], results[1]["message_id"])
        self.assertEqual(sum(bool(r.get("replayed")) for r in results), 1)

    async def test_a_reused_send_id_with_a_different_message_is_a_conflict(self):
        await self.h.send(self.sid, "first", send_id="reused-id-1", leaf=None)
        await self.h.idle()
        with self.assertRaises(store.Conflict):
            await self.h.send(self.sid, "something else", send_id="reused-id-1")

    async def test_a_stale_leaf_is_refused_and_saves_nothing(self):
        await self.h.send(self.sid, "one")
        await self.h.idle()
        before = len(self.user_rows())
        with self.assertRaises(store.Conflict):
            await self.h.send(self.sid, "two", leaf="not-the-leaf")
        self.assertEqual(len(self.user_rows()), before)

    async def test_a_queued_send_retry_returns_the_queue_entry(self):
        await self.h.send(self.sid, "work [hold]")
        await self.h.held()
        first = await self.h.send(self.sid, "later", send_id="queued-send-1")
        again = await self.h.send(self.sid, "later", send_id="queued-send-1")
        self.assertTrue(first["queued"] and again["replayed"])
        self.assertEqual(first["queue_id"], again["queue_id"])
        self.assertEqual(len(self.h.queue(self.sid)["items"]), 1)
        self.h.release()
        await self.h.idle()

    async def test_failure_and_text_validation(self):
        with self.assertRaises(ValueError):
            await self.h.send(self.sid, "   ")
        with self.assertRaises(ValueError):
            await self.h.send(self.sid, "x", mode="bogus")


class QueueTests(RuntimeCase):
    async def test_a_busy_thread_queues_and_the_server_drains_it_in_order(self):
        await self.h.send(self.sid, "first [hold] [reply:one]")
        await self.h.held()
        a = await self.h.send(self.sid, "second [reply:two]")
        b = await self.h.send(self.sid, "third [reply:three]")
        self.assertEqual((a["reason"], b["reason"]), ("busy", "busy"))
        queue = self.h.queue(self.sid)
        self.assertEqual([i["text"] for i in queue["items"]], ["second [reply:two]", "third [reply:three]"])
        self.assertEqual([m["content"] for m in self.user_rows()], ["first [hold] [reply:one]"], "queued text is not in the transcript yet")
        self.h.release()
        await self.h.idle()
        self.assertEqual(self.h.queue(self.sid)["items"], [])
        users = [m["content"] for m in self.user_rows()]
        self.assertEqual(users[1], "second [reply:two]\n\nthird [reply:three]", "compatible messages are one turn")
        self.assertEqual(len(self.h.prompts), 2)
        states = {f["send_id"]: f["state"] for f in self.followups()}
        self.assertEqual(set(states.values()), {"consumed"})
        self.assertEqual({a["send_id"], b["send_id"]} <= set(states), True, "each keeps its own receipt")

    async def test_messages_far_apart_do_not_coalesce(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        await self.h.send(self.sid, "early")
        await self.h.send(self.sid, "late")
        with sstore.transaction() as conn:
            conn.execute("UPDATE bot_followups SET created_at = created_at - 300 WHERE send_id IN "
                         "(SELECT send_id FROM bot_followups WHERE state='pending' ORDER BY sequence LIMIT 1)")
        self.h.release()
        await self.h.idle()
        self.assertEqual([m["content"] for m in self.user_rows()][1:], ["early", "late"])

    async def test_spoken_messages_are_never_merged_with_typed_ones(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        await self.h.send(self.sid, "typed")
        await self.h.send(self.sid, "spoken line", mode="spoken")
        self.h.release()
        await self.h.idle()
        self.assertEqual([m["content"] for m in self.user_rows()][1:], ["typed", "spoken line"])

    async def test_edit_returns_the_payload_and_delete_leaves_a_tombstone(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        a = await self.h.send(self.sid, "keep me")
        b = await self.h.send(self.sid, "drop me")
        taken = service.queue_edit(OWNER, self.sid, a["queue_id"])
        self.assertEqual(taken["draft"]["text"], "keep me")
        self.assertEqual([i["text"] for i in taken["items"]], ["drop me"])
        gone = service.queue_cancel(OWNER, self.sid, b["queue_id"])
        self.assertEqual(gone["items"], [])
        self.assertEqual(set(gone["consumed_queue_ids"]), {a["queue_id"], b["queue_id"]}, "tombstones stop a late retry")
        with self.assertRaises(store.Conflict):
            service.queue_cancel(OWNER, self.sid, b["queue_id"])
        self.h.release()
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 1, "nothing queued ran")

    async def test_the_queue_revision_moves_on_every_change(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        r0 = self.h.queue(self.sid)["revision"]
        a = await self.h.send(self.sid, "x")
        r1 = self.h.queue(self.sid)["revision"]
        service.queue_cancel(OWNER, self.sid, a["queue_id"])
        r2 = self.h.queue(self.sid)["revision"]
        self.assertTrue(r0 < r1 < r2)
        self.h.release()
        await self.h.idle()

    async def test_the_tombstone_list_keeps_the_newest_sixty_four(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        for number in range(70):
            queued = await self.h.send(self.sid, f"m{number}")
            service.queue_cancel(OWNER, self.sid, queued["queue_id"])
        self.assertEqual(len(self.h.queue(self.sid)["consumed_queue_ids"]), 64)
        with sstore.transaction() as conn:
            kept = conn.execute("SELECT COUNT(*) FROM bot_followups WHERE session_id=? AND state='cancelled'", (self.sid,)).fetchone()[0]
        self.assertEqual(kept, 64)
        self.h.release()
        await self.h.idle()

    async def test_queue_rows_follow_their_owner(self):
        await self.h.send(self.sid, "run [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "mine")
        self.assertEqual(store.queue("someone-else", self.sid)["items"], [])
        with self.assertRaises(KeyError):
            store.change("someone-else", self.sid, queued["queue_id"], "cancelled")
        self.h.release()
        await self.h.idle()


class SlotTests(RuntimeCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.bot = self.h.bot("Limited", thread_limit=2)
        self.a, self.b, self.c = (self.h.thread(self.bot, name) for name in "ABC")

    async def test_threads_over_the_limit_queue_with_a_capacity_reason(self):
        one = await self.h.send(self.a, "a [hold]")
        two = await self.h.send(self.b, "b [hold]")
        three = await self.h.send(self.c, "c [reply:third]")
        self.assertEqual((one["queued"], two["queued"], three["queued"], three["reason"]), (False, False, True, "capacity"))
        await self.h.held(2)
        self.assertEqual(len(chat_live.running_threads(self.bot["id"])), 2)
        self.h.release()
        await self.h.idle()
        self.assertEqual(self.h.texts(self.c)[-1], ("assistant", "third"), "the overflow ran after a slot freed")

    async def test_simultaneous_sends_cannot_exceed_the_limit(self):
        results = await asyncio.gather(*(self.h.send(sid, f"go [hold]") for sid in (self.a, self.b, self.c)))
        started = [r for r in results if not r["queued"]]
        self.assertEqual(len(started), 2)
        self.assertEqual([r["reason"] for r in results if r["queued"]], ["capacity"])
        await self.h.held(2)
        self.assertEqual(len(chat_live.running_threads(self.bot["id"])), 2)
        self.h.release()
        await self.h.idle()

    async def test_the_oldest_waiting_thread_goes_first(self):
        await self.h.send(self.a, "a [hold]")
        await self.h.send(self.b, "b [hold]")
        await self.h.held(2)
        self.h.replies.extend(["x", "y"])
        order = []
        original = service._launch

        def spy(owner, sid, bot, payload, index, generation, context):
            order.append(sid)
            return original(owner, sid, bot, payload, index, generation, context)

        c = await self.h.send(self.c, "c queued first")
        extra = self.h.thread(self.bot, "D")
        d = await self.h.send(extra, "d queued second")
        self.assertEqual((c["reason"], d["reason"]), ("capacity", "capacity"))
        service._launch = spy
        try:
            self.h.release(0)  # one slot frees
            for _ in range(200):
                if order:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(order[0], self.c, "FIFO: the earlier queued thread is not starved")
        finally:
            service._launch = original
        self.h.release()
        await self.h.idle()

    async def test_other_bots_do_not_share_slots(self):
        other = self.h.bot("Other", thread_limit=1)
        osid = self.h.thread(other)
        await self.h.send(self.a, "a [hold]")
        await self.h.send(self.b, "b [hold]")
        result = await self.h.send(osid, "other [reply:fine]")
        self.assertFalse(result["queued"])
        self.h.release()
        await self.h.idle()

    async def test_a_second_message_in_a_working_thread_does_not_take_a_slot(self):
        await self.h.send(self.a, "a [hold]")
        queued = await self.h.send(self.a, "more")
        self.assertEqual(queued["reason"], "busy")
        third = await self.h.send(self.b, "b [reply:ok b]")
        self.assertFalse(third["queued"], "the busy thread counts once")
        self.h.release()
        await self.h.idle()


class StopTests(RuntimeCase):
    async def test_stop_keeps_the_partial_reply_pauses_the_queue_and_leaves_one_quiet_row(self):
        first = await self.h.send(self.sid, "long [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "next thing")
        self.assertEqual(service.interrupt(OWNER, self.sid, first["turn_id"])["outcome"], "stopping")
        self.assertEqual(service.interrupt(OWNER, self.sid, first["turn_id"])["outcome"], "stopping", "a repeat is harmless")
        await self.h.idle()
        path = self.h.path(self.sid)
        stopped = [m for m in path if m.get("kind") == "stopped"]
        self.assertEqual(len(stopped), 1)
        self.assertEqual(stopped[0]["content"], "You stopped this.")
        self.assertTrue(stopped[0]["display_only"])
        self.assertEqual(path[-2]["status"], "interrupted", "the partial reply is saved")
        queue = self.h.queue(self.sid)
        self.assertTrue(queue["paused"])
        self.assertEqual([i["id"] for i in queue["items"]], [queued["queue_id"]], "queued work waits")
        self.assertEqual(len(self.h.prompts), 1, "nothing started by itself")
        self.assertEqual(service.interrupt(OWNER, self.sid, first["turn_id"])["outcome"], "already-stopped")
        resumed = await service.queue_resume(OWNER, self.sid)
        self.assertEqual(resumed["resumed"], 0)
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 2, "Resume released the pause and the queue ran")
        self.assertFalse(self.h.queue(self.sid)["paused"])

    async def test_a_late_stop_cannot_reach_the_next_turn(self):
        one = await self.h.send(self.sid, "one [reply:done one]")
        await self.h.idle()
        two = await self.h.send(self.sid, "two [hold]")
        await self.h.held()
        self.assertEqual(service.interrupt(OWNER, self.sid, one["turn_id"])["outcome"], "already-stopped")
        self.assertEqual(chat_live.current_turn(self.sid)["status"], "processing")
        self.assertFalse(chat_live.stop(self.sid, one["turn_id"]), "the runtime guards it too")
        self.assertFalse(self.h.queue(self.sid)["paused"])
        self.h.release()
        await self.h.idle()
        self.assertIn(self.h.path(self.sid)[-1]["status"], (None, "complete"))

    async def test_old_cleanup_never_touches_a_newer_generation(self):
        one = await self.h.send(self.sid, "one [reply:a]")
        await self.h.idle()
        old_run = {"turnId": one["turn_id"], "status": "stopped", "_stop_reason": "person", "_agent_id": self.bot["id"],
                   "_owner": OWNER, "runId": None}
        await self.h.send(self.sid, "two [hold]")
        await self.h.held()
        before = len(self.h.session(self.sid)["messages"])
        service.turn_ended(self.sid, old_run)
        self.assertEqual(len(self.h.session(self.sid)["messages"]), before, "no stop row from the old turn")
        self.assertFalse(self.h.queue(self.sid)["paused"])
        self.h.release()
        await self.h.idle()

    async def test_a_message_sent_while_a_stop_is_finishing_queues_cleanly(self):
        first = await self.h.send(self.sid, "long [hold]")
        await self.h.held()
        service.interrupt(OWNER, self.sid, first["turn_id"])
        later = await self.h.send(self.sid, "right after", leaf=None) if False else None
        late = None
        try:
            late = await self.h.send(self.sid, "right after")
        except store.Conflict:
            late = None
        await self.h.idle()
        rows = self.user_rows()
        self.assertEqual(rows[0]["content"], "long [hold]")
        self.assertEqual(len([m for m in self.h.path(self.sid) if m.get("kind") == "stopped"]), 1)
        if late and late["queued"]:
            self.assertEqual(self.h.queue(self.sid)["items"][0]["text"], "right after")

    async def test_failure_pauses_the_queue_but_keeps_the_rows(self):
        await self.h.send(self.sid, "break [hold] [fail]")
        await self.h.held()
        queued = await self.h.send(self.sid, "after")
        self.h.release()
        await self.h.idle()
        queue = self.h.queue(self.sid)
        self.assertTrue(queue["paused"])
        self.assertEqual([i["id"] for i in queue["items"]], [queued["queue_id"]])
        self.assertEqual(self.h.path(self.sid)[-1]["status"], "failed")
        self.assertTrue(any(e["type"] == "bot.turn_failed" for e in self.h.events))

    async def test_events_name_the_lifecycle_without_message_text(self):
        await self.h.send(self.sid, "secret words [reply:fine]")
        await self.h.idle()
        kinds = [e["type"] for e in self.h.events]
        self.assertIn("bot.runtime", kinds)
        self.assertIn("bot.turn_done", kinds)
        phases = [e["phase"] for e in self.h.events if e["type"] == "bot.runtime"]
        self.assertEqual(phases, ["started", "ended"])
        self.assertNotIn("secret words", repr(self.h.events))


class SteerTests(RuntimeCase):
    async def test_steer_interrupts_then_sends_the_steering_text(self):
        first = await self.h.send(self.sid, "work [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "actually do this [reply:steered]")
        queue = self.h.queue(self.sid)
        result = await service.queue_steer(OWNER, self.sid, queued["queue_id"],
                                           {"turn_id": first["turn_id"], "queue_revision": queue["revision"]})
        self.assertTrue(result["steered"])
        self.assertEqual(result["consumed_ids"], [queued["queue_id"]])
        await self.h.idle()
        path = self.h.path(self.sid)
        self.assertEqual([m for m in path if m.get("kind") == "stopped"], [], "a steer is not a Stop")
        self.assertEqual(path[-1]["content"], "steered")
        self.assertEqual(path[-3]["status"], "interrupted", "the interrupted reply stays as context")
        self.assertFalse(self.h.queue(self.sid)["paused"])
        self.assertEqual(self.h.queue(self.sid)["items"], [])

    async def test_steer_with_a_stale_revision_or_turn_is_refused(self):
        first = await self.h.send(self.sid, "work [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "later")
        revision = self.h.queue(self.sid)["revision"]
        with self.assertRaises(HTTPException) as caught:
            await service.queue_steer(OWNER, self.sid, queued["queue_id"], {"turn_id": first["turn_id"], "queue_revision": revision - 1})
        self.assertEqual(caught.exception.status_code, 409)
        blocked = await service.queue_steer(OWNER, self.sid, queued["queue_id"], {"turn_id": "other-turn", "queue_revision": revision})
        self.assertEqual(blocked, {"steered": False, "blocked": "turn-changed"})
        self.assertEqual(chat_live.current_turn(self.sid)["status"], "processing", "nothing was stopped")
        self.h.release()
        await self.h.idle()

    async def test_steer_takes_exactly_the_requested_head_group(self):
        first = await self.h.send(self.sid, "work [hold]")
        await self.h.held()
        a = await self.h.send(self.sid, "one")
        b = await self.h.send(self.sid, "two")
        c = await self.h.send(self.sid, "three")
        revision = self.h.queue(self.sid)["revision"]
        not_head = await service.queue_steer(OWNER, self.sid, b["queue_id"], {"turn_id": first["turn_id"], "queue_revision": revision})
        self.assertEqual(not_head["blocked"], "not-first")
        result = await service.queue_steer(OWNER, self.sid, a["queue_id"], {
            "turn_id": first["turn_id"], "queue_revision": revision, "group_ids": [a["queue_id"], b["queue_id"]]})
        self.assertEqual(result["consumed_ids"], [a["queue_id"], b["queue_id"]])
        await self.h.idle()
        users = [m["content"] for m in self.user_rows()]
        self.assertEqual(users[1], "one\n\ntwo")
        self.assertEqual(users[2], "three", "the rest drained after")

    async def test_steer_on_an_idle_paused_thread_releases_the_pause(self):
        first = await self.h.send(self.sid, "work [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "go on [reply:resumed]")
        service.interrupt(OWNER, self.sid, first["turn_id"])
        await self.h.idle()
        queue = self.h.queue(self.sid)
        self.assertTrue(queue["paused"])
        result = await service.queue_steer(OWNER, self.sid, queued["queue_id"], {"turn_id": None, "queue_revision": queue["revision"]})
        self.assertTrue(result["steered"])
        await self.h.idle()
        self.assertEqual(self.h.path(self.sid)[-1]["content"], "resumed")
        self.assertFalse(self.h.queue(self.sid)["paused"])


class RestartTests(RuntimeCase):
    def accept_without_running(self, text, *, answered=False):
        """What a crash leaves: a saved message and a dispatching row, no live turn."""
        leaf = self.h.leaf(self.sid)
        payload = {"send_id": uuid.uuid4().hex, "text": text, "expected_leaf_id": leaf, "attachment_ids": [],
                   "reply_to_id": None, "citations": [], "references": [], "mode": None}
        result = store.accept(OWNER, self.sid, payload, None, "dead-generation")
        if answered:
            session_manager.append_message(self.sid, "assistant", "I did it")
        return result

    async def test_unresolved_work_becomes_an_interrupted_row_and_is_not_replayed(self):
        result = self.accept_without_running("half done")
        self.assertEqual(store.recover(self.sid, None), 1)
        rows = self.followups()
        self.assertEqual(rows[0]["state"], "interrupted")
        view = self.h.queue(self.sid)
        self.assertTrue(view["paused"])
        self.assertEqual(self.h.prompts, [], "never automatically replayed")
        self.assertTrue(view["items"][0]["resumes_message"])

    async def test_answered_work_is_consumed_not_requeued(self):
        self.accept_without_running("finished", answered=True)
        store.recover(self.sid, None)
        self.assertEqual(self.followups()[0]["state"], "consumed")
        self.assertFalse(self.h.queue(self.sid)["paused"])

    async def test_a_live_turn_is_left_alone(self):
        first = await self.h.send(self.sid, "running [hold]")
        await self.h.held()
        self.assertEqual(service.recover(self.sid), 0)
        self.assertEqual(self.followups()[0]["state"], "dispatching")
        self.h.release()
        await self.h.idle()

    async def test_resume_runs_the_saved_message_without_a_second_copy(self):
        result = self.accept_without_running("redo me [reply:redone]")
        service.recover(self.sid)
        before = len(self.user_rows())
        resumed = await service.queue_resume(OWNER, self.sid)
        self.assertEqual(resumed["resumed"], 1)
        await self.h.idle()
        self.assertEqual(len(self.user_rows()), before, "no duplicate user message")
        self.assertEqual(self.h.path(self.sid)[-1]["content"], "redone")
        self.assertEqual(self.h.path(self.sid)[-2]["bot_message_id"], result["message_id"])
        self.assertEqual(self.followups()[0]["state"], "consumed")

    async def test_startup_recovers_every_thread_and_starts_waiting_queues(self):
        self.accept_without_running("stuck")
        other = self.h.thread(self.bot, "Other")
        leaf = self.h.leaf(other)
        store.accept(OWNER, other, {"send_id": "waiting-send-1", "text": "waiting [reply:started]", "expected_leaf_id": leaf,
                                    "attachment_ids": [], "reply_to_id": None, "citations": [], "references": [], "mode": None},
                     "capacity", "unused")
        report = await service.startup()
        self.assertEqual(report["recovered"], 1)
        await self.h.idle()
        self.assertEqual(self.h.texts(other)[-1], ("assistant", "started"))
        self.assertEqual(self.h.queue(self.sid)["items"][0]["state"], "interrupted")


class IsolationTests(RuntimeCase):
    async def test_another_person_gets_not_found(self):
        with self.assertRaises(HTTPException) as caught:
            service.state("mallory", self.sid)
        self.assertEqual(caught.exception.status_code, 404)

    async def test_a_plain_chat_is_not_a_bot_conversation(self):
        plain = session_manager.create_session("Plain", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, plain["id"])
        with self.assertRaises(HTTPException) as caught:
            service.state(OWNER, plain["id"])
        self.assertEqual(caught.exception.status_code, 404)

    async def test_a_bot_that_no_longer_exists_is_not_found(self):
        ghost = session_manager.create_session("Ghost", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, ghost["id"])
        session_manager.set_agent(ghost["id"], "no-such-bot", "prompt")
        with self.assertRaises(HTTPException):
            service.state(OWNER, ghost["id"])


class HttpTests(RuntimeCase):
    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_send_state_messages_and_queue_over_http(self):
        async with self.client() as web:
            state = (await web.get(f"/api/bot-chat/{self.sid}/state")).json()
            self.assertEqual(state["bot_id"], self.bot["id"])
            self.assertEqual(state["capabilities"]["steer"], "interrupt")
            self.assertEqual(state["model"]["label"], "Fake model")
            body = {"send_id": "http-send-001", "text": "hello [reply:hi]", "expected_leaf_id": state["active_leaf_id"]}
            sent = await web.post(f"/api/bot-chat/{self.sid}/send", json=body)
            self.assertEqual(sent.status_code, 202)
            self.assertTrue(sent.json()["turn_id"])
            self.assertEqual((await web.post(f"/api/bot-chat/{self.sid}/send", json=body)).json()["replayed"], True)
            await self.h.idle()
            page = (await web.get(f"/api/bot-chat/{self.sid}/messages")).json()
            self.assertEqual([m["role"] for m in page["messages"]], ["user", "assistant"])
            self.assertNotIn("tool_rounds", page["messages"][1])
            self.assertEqual(page["total"], 2)
            queue = (await web.get(f"/api/bot-chat/{self.sid}/queue")).json()
            self.assertEqual(queue["items"], [])

    async def test_bodies_are_bounded_and_reject_extra_fields(self):
        async with self.client() as web:
            bad = {"send_id": "http-send-002", "text": "x", "expected_leaf_id": None, "owner": "mallory"}
            self.assertEqual((await web.post(f"/api/bot-chat/{self.sid}/send", json=bad)).status_code, 422)
            short = {"send_id": "abc", "text": "x", "expected_leaf_id": None}
            self.assertEqual((await web.post(f"/api/bot-chat/{self.sid}/send", json=short)).status_code, 422)

    async def test_unknown_foreign_and_non_bot_targets_are_404_and_stale_state_is_409(self):
        plain = session_manager.create_session("Plain", owner_user=OWNER)
        self.addCleanup(session_manager.delete_session, plain["id"])
        async with self.client() as web:
            self.assertEqual((await web.get("/api/bot-chat/nope/state")).status_code, 404)
            self.assertEqual((await web.get(f"/api/bot-chat/{plain['id']}/state")).status_code, 404)
            body = {"send_id": "http-send-003", "text": "x", "expected_leaf_id": "stale-leaf"}
            self.assertEqual((await web.post(f"/api/bot-chat/{self.sid}/send", json=body)).status_code, 409)

    async def test_search_and_presence_are_not_read_as_session_ids(self):
        async with self.client() as web:
            self.assertEqual((await web.get("/api/bot-chat/search", params={"q": "zzz"})).status_code, 200)
            self.assertEqual((await web.post("/api/bot-chat/presence", json={"timezone": "UTC"})).status_code, 200)

    async def test_stop_over_http_is_a_noop_for_a_finished_turn(self):
        async with self.client() as web:
            first = await self.h.send(self.sid, "quick [reply:ok]")
            await self.h.idle()
            result = await web.post(f"/api/bot-chat/{self.sid}/interrupt", json={"turn_id": first["turn_id"]})
            self.assertEqual((result.status_code, result.json()["outcome"]), (200, "already-stopped"))

    async def test_a_legacy_live_send_to_a_bot_goes_through_admission(self):
        from unittest.mock import patch
        admin = patch.object(chat_routes.auth_manager, "is_admin", return_value=True)
        admin.start()
        self.addCleanup(admin.stop)
        async with self.client() as web:
            first = await web.post("/api/chat/live", json={"session_id": self.sid, "message": "legacy [hold]"})
            self.assertEqual(first.status_code, 200)
            self.assertTrue(first.json()["turn_id"])
            await self.h.held()
            second = await web.post("/api/chat/live", json={"session_id": self.sid, "message": "queued legacy"})
            self.assertTrue(second.json()["queued"])
            self.assertEqual(second.json()["reason"], "busy")
            stale = await web.post("/api/chat/live/stop", json={"session_id": self.sid, "turn_id": "old-turn"})
            self.assertEqual(stale.json(), {"stopping": False})
            self.assertEqual(chat_live.current_turn(self.sid)["status"], "processing")
            right = await web.post("/api/chat/live/stop", json={"session_id": self.sid, "turn_id": first.json()["turn_id"]})
            self.assertTrue(right.json()["stopping"])
            await self.h.idle()

    async def test_the_old_rewind_route_is_refused_for_a_bot(self):
        from routes import session_routes
        local = FastAPI()
        local.include_router(session_routes.router)
        local.dependency_overrides[require_user] = lambda: OWNER
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=local), base_url="http://test") as web:
            result = await web.post(f"/api/sessions/{self.sid}/rewind", json={"keep": 0})
            self.assertEqual(result.status_code, 409)


if __name__ == "__main__":
    unittest.main()
