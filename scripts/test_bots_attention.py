"""Bots Phase 1 unit U5: the inbox, retained notifications and the attention routes (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-1-design.md, sections 3.4 and 5.3.
Throwaway data folder, stand-in sources. Run: python scripts/test_bots_attention.py
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-attention-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_attention_store as store  # noqa: E402
from core import permissions  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import agent_routes, bot_attention_routes  # noqa: E402
from services import bot_attention, bot_push  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402

CURRENT = {"user": "david"}
app = FastAPI()
app.include_router(bot_attention_routes.router)
app.include_router(agent_routes.router)  # the older /api/agents/inbox that Updates reads
app.dependency_overrides[require_admin] = lambda: CURRENT["user"]
web = TestClient(app)
BASE = "/api/bot-attention"


class AttentionCase(unittest.TestCase):
    def setUp(self):
        CURRENT["user"] = "david"
        for patcher in (patch.dict(agent_service._agents, {}, clear=True), patch.object(agent_service, "_inbox", []),
                        patch.dict(task_service._tasks, {}, clear=True),
                        patch("core.auth.auth_manager.is_admin", return_value=True)):
            patcher.start()
            self.addCleanup(patcher.stop)
        with store.database() as db:
            for table in ("receipts", "notifications", "inbox_state", "observations"):
                db.execute(f"DELETE FROM {table}")
        self.bot = agent_service.create("Scout", role="Watches postings")
        self.bot["owner_user"] = "david"
        self.session = session_manager.create_session("Main", owner_user="david")["id"]
        session_manager.set_agent(self.session, self.bot["id"], "frozen")
        session_manager.set_thread(self.session, main=True)
        self.addCleanup(lambda: session_manager.get_session(self.session) and session_manager.delete_session(self.session))

    def question(self, title="Which slot?", **extra):
        item = agent_service.add_item(self.bot["id"], "question", title, "Pick one", **extra)
        item["session_id"] = self.session
        return item

    def card(self, status="review", name="Shortlist"):
        card = {"id": "card" + str(len(task_service._tasks)), "name": name, "agent_id": self.bot["id"], "schedule_kind": "card",
                "status": status, "created_at": time.time(), "updated_at": time.time(), "comments": [], "owner_user": "david"}
        task_service._tasks[card["id"]] = card
        return card

    def row(self, ident):
        return next((r for r in web.get(f"{BASE}/inbox").json()["rows"] if r["id"] == ident), None)


class InboxProjection(AttentionCase):
    def test_sources_become_rows_with_stable_ids_actions_and_exact_target(self):
        item, card = self.question(), self.card()
        data = web.get(f"{BASE}/inbox").json()
        by_id = {r["id"]: r for r in data["rows"]}
        question, review = by_id["item:" + item["id"]], by_id["review:" + card["id"]]
        self.assertEqual((question["kind"], question["bucket"], question["actions"]), ("question", "needs-you", ["reply", "close"]))
        self.assertEqual(review["actions"], ["approve", "reply", "open"])
        self.assertEqual(question["target"], {"tab": "botsShell", "agentId": self.bot["id"], "sessionId": self.session})
        self.assertEqual(data["counts"]["needs-you"], 2)
        self.assertEqual(data["count"], 2)
        self.assertEqual(web.get(f"{BASE}/inbox").json()["rows"][0]["id"], data["rows"][0]["id"], "ids are stable across reads")

    def test_reports_are_news_and_do_not_count_as_needs_you(self):
        agent_service.add_item(self.bot["id"], "report", "Weekly roundup", "All quiet")
        data = web.get(f"{BASE}/inbox").json()
        self.assertEqual([r["bucket"] for r in data["rows"]], ["news"])
        self.assertEqual(data["count"], 0)
        self.assertEqual(web.get(f"{BASE}/needs-you").json()["rows"], [])

    def test_legacy_inbox_endpoint_is_untouched(self):
        from routes import agent_routes
        self.assertIn("/api/agents/inbox", {route.path for route in agent_routes.router.routes})

    def test_owner_isolation(self):
        self.question()
        other = agent_service.create("Theirs")
        other["owner_user"] = "sam"
        agent_service.add_item(other["id"], "question", "Sam's private question")
        CURRENT["user"] = "sam"
        rows = web.get(f"{BASE}/inbox").json()["rows"]
        self.assertEqual([r["subject"] for r in rows], ["Sam's private question"])
        self.assertEqual(web.get(f"{BASE}/bots/{self.bot['id']}/activity").status_code, 404)
        self.assertEqual(web.get(f"{BASE}/threads/{self.session}/events").status_code, 404)
        self.assertEqual(web.post(f"{BASE}/inbox/item:{self.bot['id']}/read").status_code, 404)
        CURRENT["user"] = "david"
        self.assertEqual(len(web.get(f"{BASE}/inbox").json()["rows"]), 1)

    def test_live_permission_is_projected_and_answerable_once(self):
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        request = permissions.Request(id="perm1", surface="chat:" + self.session, tool="run_command", target="ls",
                                      arguments={}, title="Run a command", description="List the folder",
                                      choices=permissions._default_choices("run_command", "ls"))
        request.answer = loop.create_future()
        permissions._pending["perm1"] = request
        self.addCleanup(permissions._pending.pop, "perm1", None)
        row = self.row("permission:perm1")
        self.assertEqual((row["kind"], row["actions"]), ("approval", ["allow", "deny"]))
        answered = web.post(f"{BASE}/inbox/permission:perm1/respond", json={"action": "allow", "expected_revision": row["revision"]})
        self.assertEqual(answered.status_code, 200, answered.text)
        self.assertTrue(request.answer.done())
        self.assertIsNone(self.row("permission:perm1"), "an answered request leaves the live projection")
        again = web.post(f"{BASE}/inbox/permission:perm1/respond", json={"action": "allow", "expected_revision": row["revision"]})
        self.assertIn(again.status_code, (404, 409), "a second answer is unavailable, never a silent success")


class ReadVersusDone(AttentionCase):
    def test_read_keeps_it_open_and_done_never_approves(self):
        card = self.card()
        ident = "review:" + card["id"]
        self.assertEqual(web.post(f"{BASE}/inbox/{ident}/read").status_code, 200)
        row = self.row(ident)
        self.assertEqual((row["read"], row["done"], row["bucket"]), (True, False, "needs-you"))
        self.assertEqual(web.post(f"{BASE}/inbox/{ident}/done").status_code, 200)
        row = self.row(ident)
        self.assertEqual((row["done"], row["bucket"]), (True, "done"))
        self.assertEqual(task_service.get_task(card["id"])["status"], "review", "Done does not approve the work")
        web.post(f"{BASE}/inbox/{ident}/reopen")
        self.assertEqual(self.row(ident)["bucket"], "needs-you")

    def test_unknown_item_is_404(self):
        self.assertEqual(web.post(f"{BASE}/inbox/item:nope/done").status_code, 404)

    def test_done_reports_and_results_leave_the_updates_list(self):
        # Updates, the sidebar badge, Home and the notch read /api/agents/inbox.
        report = agent_service.add_item(self.bot["id"], "report", "Weekly roundup", "All quiet")
        question, card = self.question(), self.card()
        old = agent_service.add_item(self.bot["id"], "report", "Last quarter", "Old news")
        old["created_at"] = time.time() - 31 * 86400
        legacy = lambda: web.get("/api/agents/inbox").json()
        data = legacy()
        self.assertEqual(sorted(i["id"] for i in data["items"]), sorted([report["id"], question["id"]]), "reports past 30 days follow the Bots Inbox")
        self.assertEqual(data["count"], 3)
        for ident in ("item:" + report["id"], "review:" + card["id"]):
            self.assertEqual(web.post(f"{BASE}/inbox/{ident}/done").status_code, 200)
        data = legacy()
        self.assertEqual([i["id"] for i in data["items"]], [question["id"]], "a question stays until it is answered")
        self.assertEqual((data["reviews"], data["count"]), ([], 1))
        self.assertEqual(agent_service.get_item(report["id"])["status"], "open", "Done files the report; it answers nothing")
        web.post(f"{BASE}/inbox/item:{report['id']}/reopen")
        self.assertIn(report["id"], [i["id"] for i in legacy()["items"]], "moving it back to the inbox brings it back")


class Responding(AttentionCase):
    def respond(self, ident, **body):
        return web.post(f"{BASE}/inbox/{ident}/respond", json=body)

    def test_reply_answers_the_question_and_marks_it_read(self):
        item = self.question()
        ident = "item:" + item["id"]
        reply = self.respond(ident, action="reply", text="Tuesday", expected_revision=self.row(ident)["revision"])
        self.assertEqual(reply.status_code, 200, reply.text)
        stored = agent_service.get_item(item["id"])
        self.assertEqual((stored["status"], stored["answer"]), ("answered", "Tuesday"))
        row = self.row(ident)
        self.assertEqual((row["status"], row["bucket"], row["read"]), ("resolved", "done", True))

    def test_stale_revision_is_refused_and_changes_nothing(self):
        item = self.question()
        ident = "item:" + item["id"]
        old = self.row(ident)["revision"]
        item["title"] = "Edited since you looked"
        stale = self.respond(ident, action="reply", text="Tuesday", expected_revision=old)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(agent_service.get_item(item["id"])["status"], "open")

    def test_already_answered_is_unavailable(self):
        item = self.question()
        ident = "item:" + item["id"]
        revision = self.row(ident)["revision"]
        agent_service.resolve(item["id"], "answered", "elsewhere")
        self.assertEqual(self.respond(ident, action="reply", text="x", expected_revision=revision).status_code, 409)

    def test_failed_delivery_reopens_the_item(self):
        item = self.question()
        ident = "item:" + item["id"]
        revision = self.row(ident)["revision"]

        def broken(item_id, choice, text=""):
            agent_service.resolve(item_id, "answered", text)
            raise ValueError("the team is unavailable right now")

        with patch.object(agent_service, "answer_item", side_effect=broken):
            failed = self.respond(ident, action="reply", text="Tuesday", expected_revision=revision)
        self.assertEqual(failed.status_code, 409)
        reopened = agent_service.get_item(item["id"])
        self.assertEqual((reopened["status"], reopened["answer"]), ("open", None))
        self.assertEqual(self.row(ident)["bucket"], "needs-you", "a failed answer is still waiting on you")
        self.assertFalse(self.row(ident)["done"])

    def test_close_dismisses_a_question_and_approve_moves_a_review(self):
        item, card = self.question(), self.card()
        for ident, action in (("item:" + item["id"], "close"), ("review:" + card["id"], "approve")):
            self.assertEqual(self.respond(ident, action=action, expected_revision=self.row(ident)["revision"]).status_code, 200)
        self.assertEqual(agent_service.get_item(item["id"])["status"], "dismissed")
        self.assertEqual(task_service.get_task(card["id"])["status"], "done")

    def test_actions_not_offered_are_refused(self):
        report = agent_service.add_item(self.bot["id"], "report", "Roundup", "Quiet week")
        ident = "item:" + report["id"]
        revision = self.row(ident)["revision"]
        self.assertEqual(self.respond(ident, action="close", expected_revision=revision).status_code, 409)
        self.assertEqual(self.respond(ident, action="open", expected_revision=revision).status_code, 409)
        self.assertEqual(self.respond(ident, action="reply", text="  ", expected_revision=revision).status_code, 409)

    def test_extra_fields_are_rejected(self):
        item = self.question()
        bad = self.respond("item:" + item["id"], action="reply", text="x", expected_revision="r", owner="sam")
        self.assertEqual(bad.status_code, 422)


class Notifications(AttentionCase):
    def event(self, kind="agent.inbox", **extra):
        return {"type": kind, "ts": time.time(), "message": "m", "agent_id": self.bot["id"], **extra}

    def test_source_id_dedupes_per_person(self):
        self.assertIsNotNone(store.publish("david", "item:a", {"kind": "question", "agent_id": "x", "title": "t"}))
        self.assertIsNone(store.publish("david", "item:a", {"kind": "question", "agent_id": "x", "title": "t"}))
        self.assertEqual(len(store.notifications("david")), 1)
        self.assertEqual(len(store.notifications("sam")), 0, "feeds are per person")

    def test_only_the_newest_500_are_kept_but_receipts_outlive_them(self):
        base = time.time() - 1000
        for n in range(520):
            store.publish("david", f"item:{n}", {"kind": "done", "agent_id": "x", "title": str(n), "at": base + n})
        rows = store.notifications("david")
        self.assertEqual(len(rows), 500)
        self.assertEqual(rows[0]["title"], "519")
        self.assertNotIn("0", {r["title"] for r in rows})
        self.assertIsNone(store.publish("david", "item:0", {"kind": "done", "agent_id": "x", "title": "0"}),
                          "a pruned source never alerts a second time")

    def test_question_event_creates_one_row_and_one_device_alert(self):
        item = self.question()
        sent = bot_attention.ingest_event(self.event(item_id=item["id"], item_kind="question", session_id=self.session))
        self.assertEqual([(r["kind"], r["owner"]) for r in sent], [("question", "david")])
        self.assertEqual(bot_attention.ingest_event(self.event(item_id=item["id"], session_id=self.session)), [], "a repeat is a no-op")
        feed = web.get(f"{BASE}/notifications").json()
        self.assertEqual(len(feed["rows"]), 1)
        self.assertEqual(feed["rows"][0]["target"]["sessionId"], self.session)
        self.assertEqual(feed["unread"], 1)

    def test_a_bot_with_notifications_off_keeps_its_feed_but_sends_no_alert(self):
        item = self.question()
        self.bot["notifications"] = False
        self.assertEqual(bot_attention.ingest_event(self.event(item_id=item["id"], session_id=self.session)), [])
        self.assertEqual(len(web.get(f"{BASE}/notifications").json()["rows"]), 1)

    def test_runtime_and_terminal_events_for_one_turn_share_one_receipt(self):
        first = bot_attention.ingest_event(self.event("bot.runtime", session_id=self.session, turn_id="t1",
                                                      data={"type": "turn.completed", "turn_id": "t1"}))
        second = bot_attention.ingest_event(self.event("bot.turn.completed", session_id=self.session, turn_id="t1"))
        self.assertEqual((len(first), second), (1, []))
        failed = bot_attention.ingest_event(self.event("bot.turn.failed", session_id=self.session, turn_id="t2"))
        self.assertEqual(failed[0]["kind"], "turn-failed")

    def test_events_for_another_persons_conversation_or_a_missing_bot_are_ignored(self):
        foreign = session_manager.create_session("Theirs", owner_user="sam")["id"]
        self.addCleanup(session_manager.delete_session, foreign)
        session_manager.set_agent(foreign, self.bot["id"], "frozen")
        with patch("core.auth.auth_manager.is_admin", side_effect=lambda user: user == "sam"):
            self.assertEqual(bot_attention.ingest_event(self.event("bot.turn.completed", session_id=foreign, turn_id="t9")), [])
        self.assertEqual(bot_attention.ingest_event({"type": "bot.turn.completed", "agent_id": "ghost", "turn_id": "t"}), [])

    def test_projection_rebuild_is_idempotent_and_labelled_backlog(self):
        self.question("One")
        self.card()
        first = web.get(f"{BASE}/notifications").json()["rows"]
        second = web.get(f"{BASE}/notifications").json()["rows"]
        self.assertEqual(sorted(r["id"] for r in first), sorted(r["id"] for r in second))
        self.assertEqual(len(first), 2)
        self.assertTrue(all(r["backlog"] for r in first), "old waiting items are backlog, not new alerts")
        self.assertEqual(sorted(r["kind"] for r in first), ["approval", "question"])

    def test_read_pin_and_read_all(self):
        self.question("A")
        self.question("B")
        rows = web.get(f"{BASE}/notifications").json()["rows"]
        self.assertEqual(web.post(f"{BASE}/notifications/{rows[0]['id']}/read").status_code, 200)
        self.assertEqual(web.post(f"{BASE}/notifications/{rows[1]['id']}/pin", json={"pinned": True}).status_code, 200)
        data = web.get(f"{BASE}/notifications").json()
        self.assertEqual(data["unread"], 1)
        self.assertTrue(data["rows"][0]["pinned"], "pinned rows lead the feed")
        self.assertEqual(web.post(f"{BASE}/notifications/nope/read").status_code, 404)
        web.post(f"{BASE}/notifications/read-all")
        self.assertEqual(web.get(f"{BASE}/notifications").json()["unread"], 0)

    def test_reading_the_inbox_item_reads_its_notification(self):
        item = self.question()
        web.get(f"{BASE}/notifications")
        web.post(f"{BASE}/inbox/item:{item['id']}/read")
        self.assertEqual(web.get(f"{BASE}/notifications").json()["unread"], 0)

    def test_visiting_a_thread_reads_only_the_messages_reached(self):
        for mid in ("m1", "m2"):
            store.publish("david", "turn:" + mid, {"kind": "done", "agent_id": self.bot["id"], "title": mid,
                                                   "target": {"sessionId": self.session, "messageId": mid}})
        web.post(f"{BASE}/threads/{self.session}/read", json={"message_id": "m1", "ancestry": ["m1"]})
        self.assertEqual({r["title"]: r["read"] for r in store.notifications("david")}, {"m1": True, "m2": False})

    def test_deleted_bot_rows_do_not_leak(self):
        item = self.question()
        bot_attention.ingest_event(self.event(item_id=item["id"], session_id=self.session))
        agent_service._agents.pop(self.bot["id"])
        self.assertEqual(web.get(f"{BASE}/notifications").json()["rows"], [])


class DevicePush(AttentionCase):
    def test_bus_event_feeds_attention_and_queues_one_push_unless_muted(self):
        item = self.question()
        event = {"type": "agent.inbox", "ts": time.time(), "message": "m", "agent_id": self.bot["id"],
                 "item_id": item["id"], "item_kind": "question", "session_id": self.session}
        with patch("core.mobile_activity.enqueue_bot") as enqueue:
            bot_push.on_event(event)
        enqueue.assert_called_once()
        self.assertEqual(enqueue.call_args.args[:2], ("bot_needs_you", self.bot["id"]))
        self.assertEqual(len(store.notifications("david")), 1)
        self.bot["notifications"] = False
        with patch("core.mobile_activity.enqueue_bot") as enqueue:
            bot_push.on_event({**event, "ts": time.time() + 1, "item_id": self.question("Another")["id"]})
        enqueue.assert_not_called()

    def test_start_is_idempotent(self):
        from core import events
        before = len(events._subscribers)
        bot_push.start()
        bot_push.start()
        self.assertLessEqual(len(events._subscribers) - before, 1)


if __name__ == "__main__":
    unittest.main()
