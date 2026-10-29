"""Bots redesign, Phase 3 unit U5: durable approval and question cards (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 5.3 and 8 (U5).
Real broker calls (core/permissions.py), the real routes over an in-process ASGI client,
a throwaway data folder. Run: python -B -X utf8 scripts/test_bots_cards.py
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-cards-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import permissions  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import bot_card_routes  # noqa: E402
from services import bot_cards  # noqa: E402

app = FastAPI()
app.include_router(bot_card_routes.router)
USER = {"name": "david"}
app.dependency_overrides[require_admin] = lambda: USER["name"]


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


class CardCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        USER["name"] = "david"
        self.path = os.path.join(_DATA.name, f"cards-{time.time_ns()}.json")
        self.store = bot_cards.reset_for_test(self.path)
        self.surface = f"chat:sess-{time.time_ns()}"
        permissions.open_channel(self.surface)
        self.addCleanup(permissions.close_channel, self.surface)
        session = session_manager.create_session("Cards", owner_user="david")
        self.thread = session["id"]
        self.addCleanup(lambda: session_manager.get_session(self.thread) and session_manager.delete_session(self.thread))

    async def ask_permission(self, **extra):
        """A real broker request waiting on the person; returns (task, payload)."""
        arguments = extra.pop("arguments", {"command": "git status"})
        task = asyncio.create_task(permissions.decide(surface=self.surface, tool="Bash", arguments=arguments,
                                                      title="Run a command", description="Check the repo.", **extra))
        payload = await self.next_payload()
        self.addCleanup(lambda: task.cancel())
        return task, payload

    async def next_payload(self):
        """The next request the broker put on the surface (skipping its close notes)."""
        queue = permissions._channels[self.surface]
        while True:
            packet = await asyncio.wait_for(queue.get(), 2)
            if "kind" in packet:
                return packet

    def card_for(self, payload, generation=0):
        return self.store.open_from_payload(payload, owner="david", bot_id="bot1", thread_id=self.thread,
                                            run_id="run1", generation=generation)

    async def ask_questions(self, questions):
        task = asyncio.create_task(permissions.ask(surface=self.surface, tool="ask_user", questions=questions))
        payload = await self.next_payload()
        self.addCleanup(lambda: task.cancel())
        return task, payload


class ApprovalCards(CardCase):
    async def test_allow_once_settles_the_card_and_the_request(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        self.assertEqual((card["kind"], card["status"], card["waiting"]), ("approval", "pending", True))
        self.assertEqual(card["details"]["tool"], "Bash")
        result = self.store.respond(card["id"], "david", action="allow", remember="once")
        self.assertTrue(result["ok"])
        self.assertEqual(result["card"]["status"], "allowed")
        decision = await asyncio.wait_for(task, 2)
        self.assertEqual(decision.behavior, "allow")
        self.assertEqual(result["card"]["outcome"]["scope"], "once")

    async def test_deny_stops_the_action(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        result = self.store.respond(card["id"], "david", action="deny")
        self.assertEqual(result["card"]["status"], "denied")
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "deny")

    async def test_always_allow_saves_only_the_displayed_scope(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        labels = [c["label"] for c in card["choices"]]
        self.assertIn("Always allow git status", labels)
        result = self.store.respond(card["id"], "david", action="allow", remember="always")
        self.assertEqual(result["card"]["outcome"]["scope"], "forever")
        decision = await asyncio.wait_for(task, 2)
        self.assertEqual(decision.rule["content"], "git status")
        self.addCleanup(permissions.revoke, decision.rule["id"])

    async def test_a_remember_choice_that_was_not_offered_is_refused(self):
        task, payload = await self.ask_permission(arguments={"note": "no target here"})
        card = self.card_for(payload)
        self.assertEqual([c["scope"] for c in card["choices"] if c["behavior"] == "allow"], ["once"])
        with self.assertRaises(bot_cards.CardError):
            self.store.respond(card["id"], "david", action="allow", remember="always")
        self.assertEqual(self.store.get(card["id"], "david")["status"], "pending", "a bad answer leaves the card open")
        task.cancel()

    async def test_an_answer_cannot_pick_a_choice_that_was_not_shown(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        with self.assertRaises(bot_cards.CardError):
            self.store.respond(card["id"], "david", action="allow", choice_id="everything")
        reject = next(c for c in card["choices"] if c["behavior"] == "deny")
        with self.assertRaises(bot_cards.CardError):
            self.store.respond(card["id"], "david", action="allow", choice_id=reject["id"])
        task.cancel()

    async def test_a_second_answer_is_refused_once_settled(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        self.store.respond(card["id"], "david", action="deny")
        with self.assertRaises(bot_cards.CardConflict):
            self.store.respond(card["id"], "david", action="allow")
        await asyncio.wait_for(task, 2)

    async def test_a_racing_answer_is_refused_while_the_first_is_delivering(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        seen = []
        real = permissions.answer

        def answer_and_race(request_id, choice_id, user):
            try:
                self.store.respond(card["id"], "david", action="deny")
            except bot_cards.CardConflict as conflict:
                seen.append(str(conflict))
            return real(request_id, choice_id, user)
        with patch.object(permissions, "answer", answer_and_race):
            result = self.store.respond(card["id"], "david", action="allow")
        self.assertEqual(result["card"]["status"], "allowed")
        self.assertEqual(seen, ["Another answer is already being delivered."])
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "allow")

    async def test_a_failed_delivery_reopens_the_card(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        with patch.object(permissions, "answer", return_value=False):
            with self.assertRaises(bot_cards.CardError):
                self.store.respond(card["id"], "david", action="allow")
        self.assertEqual(self.store.get(card["id"], "david")["status"], "pending")
        result = self.store.respond(card["id"], "david", action="allow")
        self.assertEqual(result["card"]["status"], "allowed")
        await asyncio.wait_for(task, 2)

    async def test_a_request_the_broker_dropped_settles_unavailable(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        permissions.close_channel(self.surface)  # the window closed: the broker denies it
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "deny")
        with self.assertRaises(bot_cards.CardConflict):
            self.store.respond(card["id"], "david", action="allow")
        settled = self.store.get(card["id"], "david")
        self.assertIn(settled["status"], ("unavailable", "cancelled"))
        self.assertIn("did not run", settled["outcome"]["reason"])

    async def test_an_old_generation_cannot_be_answered_and_its_request_is_denied(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload, generation=1)
        settled = self.store.set_generation(self.thread, 2)
        self.assertEqual([c["id"] for c in settled], [card["id"]])
        self.assertEqual(self.store.get(card["id"], "david")["status"], "unavailable")
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "deny", "the live request cannot run later")
        with self.assertRaises(bot_cards.CardConflict):
            self.store.respond(card["id"], "david", action="allow")

    async def test_respond_on_a_stale_generation_settles_instead_of_delivering(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload, generation=1)
        self.store._generation[self.thread] = 2
        result = self.store.respond(card["id"], "david", action="allow")
        self.assertFalse(result["ok"])
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "deny")

    async def test_stopping_a_turn_cancels_its_execution_cards(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        closed = self.store.close_thread(self.thread)
        self.assertEqual(closed[0]["status"], "cancelled")
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "deny")
        self.assertEqual(self.store.get(card["id"], "david")["status"], "cancelled")

    async def test_a_restart_settles_pending_cards_unavailable_and_never_replays(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        again = bot_cards.reset_for_test(self.path)  # a new process: no provider handles
        row = again.get(card["id"], "david")
        self.assertEqual(row["status"], "unavailable")
        self.assertIn("did not run", row["outcome"]["reason"])
        with self.assertRaises(bot_cards.CardConflict):
            again.respond(card["id"], "david", action="allow")
        self.assertFalse(task.done(), "the old request was not answered by the card")
        task.cancel()

    async def test_the_live_request_id_is_never_stored(self):
        task, payload = await self.ask_permission()
        self.card_for(payload)
        text = Path(self.path).read_text(encoding="utf-8")
        self.assertNotIn(payload["id"], text)
        task.cancel()

    async def test_the_same_request_opens_one_card(self):
        task, payload = await self.ask_permission()
        first, second = self.card_for(payload), self.card_for(payload)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.list_cards("david", thread_id=self.thread)), 1)
        task.cancel()

    async def test_changed_details_make_an_old_review_stale(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        updated = self.store.update_details(card["id"], {"summary": "A different command now."})
        self.assertEqual(updated["revision"], 2)
        with self.assertRaises(bot_cards.CardConflict):
            self.store.respond(card["id"], "david", action="allow", reviewed_revision=1)
        self.assertTrue(self.store.respond(card["id"], "david", action="allow", reviewed_revision=2)["ok"])
        await asyncio.wait_for(task, 2)

    async def test_an_expired_card_settles_when_read(self):
        card = self.store.open_card(owner="david", bot_id="bot1", thread_id=self.thread, kind="approval", title="Old",
                                    choices=[{"id": "once", "label": "Allow once", "behavior": "allow", "scope": "once"},
                                             {"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"}],
                                    expires_at=time.time() - 1)
        self.assertEqual(self.store.get(card["id"], "david")["status"], "expired")

    async def test_the_decision_is_in_the_audit_without_the_secret(self):
        task, payload = await self.ask_permission(arguments={"command": "curl -H 'Authorization: Bearer abcdefgh12345678' x"})
        card = self.card_for(payload)
        self.assertNotIn("abcdefgh12345678", str(card["details"]))
        self.store.respond(card["id"], "david", action="deny")
        entry = [e for e in permissions.audit() if e.get("source") == "bot_card" and e.get("card_id") == card["id"]]
        self.assertEqual(entry[-1]["decision"], "card_denied")
        await asyncio.wait_for(task, 2)


class QuestionCards(CardCase):
    async def test_answered_by_question_id_reaches_the_broker(self):
        task, payload = await self.ask_questions([
            {"question": "Which day?", "header": "Day", "options": [{"label": "Mon"}, {"label": "Tue"}]},
            {"question": "Which topics?", "multiSelect": True, "options": [{"label": "A"}, {"label": "B"}]}])
        card = self.card_for(payload)
        self.assertEqual([q["id"] for q in card["questions"]], ["q1", "q2"])
        result = self.store.respond(card["id"], "david", action="answer", answers={"q1": "Tue", "q2": ["A", "B"]})
        self.assertEqual(result["card"]["status"], "answered")
        outcome = await asyncio.wait_for(task, 2)
        self.assertEqual(outcome.status, "answered")
        self.assertEqual(outcome.answers, {"Which day?": "Tue", "Which topics?": ["A", "B"]})

    async def test_legacy_text_keyed_answers_still_work(self):
        task, payload = await self.ask_questions([{"question": "Proceed?", "options": [{"label": "Yes"}]}])
        card = self.card_for(payload)
        self.store.respond(card["id"], "david", action="answer", answers={"Proceed?": "Yes"})
        self.assertEqual((await asyncio.wait_for(task, 2)).answers, {"Proceed?": "Yes"})

    async def test_skip_and_a_free_text_answer(self):
        task, payload = await self.ask_questions([{"question": "Anything else?", "options": []}])
        card = self.card_for(payload)
        self.assertEqual(self.store.respond(card["id"], "david", action="skip")["card"]["status"], "skipped")
        self.assertEqual((await asyncio.wait_for(task, 2)).status, "skipped")
        task2, payload2 = await self.ask_questions([{"question": "Anything else?", "options": []}])
        card2 = self.card_for(payload2)
        self.store.respond(card2["id"], "david", action="answer", answers={"q1": "Call me at noon"})
        self.assertEqual((await asyncio.wait_for(task2, 2)).answers, {"Anything else?": "Call me at noon"})

    async def test_a_bad_answer_keeps_the_card_open(self):
        task, payload = await self.ask_questions([{"question": "Which?", "options": [{"label": "A"}]}])
        card = self.card_for(payload)
        for bad in ({}, {"q1": ""}, {"q1": "x" * 2001}, {"q9": "A"}, {"q1": ["A"]}):
            with self.assertRaises(bot_cards.CardError, msg=str(bad)[:30]):
                self.store.respond(card["id"], "david", action="answer", answers=bad)
        self.assertEqual(self.store.get(card["id"], "david")["status"], "pending")
        task.cancel()

    async def test_a_question_the_provider_lost_settles_unavailable(self):
        task, payload = await self.ask_questions([{"question": "Which?", "options": [{"label": "A"}]}])
        card = self.card_for(payload)
        permissions.close_channel(self.surface)
        await asyncio.wait_for(task, 2)
        with self.assertRaises(bot_cards.CardConflict):
            self.store.respond(card["id"], "david", action="answer", answers={"q1": "A"})
        self.assertIn(self.store.get(card["id"], "david")["status"], ("unavailable", "cancelled"))

    def test_six_questions_twelve_options_and_the_bounds(self):
        six = [{"question": f"Question {i}?", "options": [{"label": f"o{j}"} for j in range(12)]} for i in range(6)]
        questions, problem = bot_cards.normalize_questions(six)
        self.assertEqual((len(questions), problem), (6, ""))
        self.assertEqual(bot_cards.normalize_questions(six + [{"question": "7?"}])[0], None)
        too_many = [{"question": "Q?", "options": [{"label": f"o{j}"} for j in range(13)]}]
        self.assertIsNone(bot_cards.normalize_questions(too_many)[0])
        self.assertIsNone(bot_cards.normalize_questions([{"question": "Q?", "options": [{"label": "x" * 121}]}])[0])
        self.assertIsNotNone(bot_cards.normalize_questions([{"question": "Q?", "options": [{"label": "x" * 120, "description": "d" * 400}]}])[0])
        self.assertIsNone(bot_cards.normalize_questions([{"question": "Q?", "options": [{"label": "x", "description": "d" * 401}]}])[0])
        self.assertIsNone(bot_cards.normalize_questions([{"question": "Same?"}, {"question": "Same?"}])[0])
        self.assertIsNone(bot_cards.normalize_questions([{"question": "A?", "id": "a"}, {"question": "B?", "id": "a"}])[0])
        _, answers_problem = bot_cards.check_answers(questions, {f"q{i}": "o1" for i in range(1, 7)})
        self.assertEqual(answers_problem, "")
        ok, _ = bot_cards.check_answers(questions, {f"q{i}": "y" * 2000 for i in range(1, 7)})
        self.assertIsNotNone(ok, "a custom answer may use the full 2,000 characters")

    async def test_a_persistent_question_survives_a_restart_and_resumes_as_a_new_turn(self):
        card = self.store.open_card(owner="david", bot_id="bot1", thread_id=self.thread, kind="question", title="Later",
                                    questions=[{"question": "Which report?", "options": [{"label": "Weekly"}]}], persistent=True)
        again = bot_cards.reset_for_test(self.path)
        self.assertEqual(again.get(card["id"], "david")["status"], "pending")
        result = again.respond(card["id"], "david", action="answer", answers={"q1": "Weekly"})
        self.assertTrue(result["resume"]["as_new_turn"])
        self.assertIn("Which report?: Weekly", result["resume"]["text"])
        self.assertEqual(result["card"]["status"], "answered")


class TypedCards(CardCase):
    def test_a_credential_card_keeps_secrets_out(self):
        card = self.store.open_card(owner="david", bot_id="bot1", thread_id=self.thread, kind="credential",
                                    title="Add the Gmail password", details={
                                        "summary": "Open Settings and paste the key there. token=abcd1234efgh5678",
                                        "lines": [{"label": "Where", "value": "Settings > Connections"},
                                                  {"label": "api_key", "value": "sk-live-1234567890abcdef1234"}]})
        text = str(card["details"])
        self.assertNotIn("abcd1234efgh5678", text)
        self.assertNotIn("sk-live", text)
        self.assertIn("Settings > Connections", text)

    def test_typed_cards_resume_through_the_owning_handler(self):
        card = self.store.open_card(owner="david", bot_id="bot1", thread_id=self.thread, kind="connector",
                                    title="Connect Gmail", resume={"connector": "gmail"})
        with self.assertRaises(bot_cards.CardConflict):
            self.store.resume_card(card["id"], "david", "done")  # nothing registered yet
        calls = []
        self.store.register_resume_handler("connector", lambda c, outcome: calls.append((c["resume"], outcome)) or
                                           {"status": "answered", "message": "Gmail is connected."})
        result = self.store.resume_card(card["id"], "david", "done")
        self.assertEqual((calls, result["card"]["status"], result["message"]),
                         ([({"connector": "gmail"}, "done")], "answered", "Gmail is connected."))
        with self.assertRaises(bot_cards.CardConflict):
            self.store.resume_card(card["id"], "david", "done")

    def test_a_failing_resume_reopens_the_card(self):
        card = self.store.open_card(owner="david", bot_id="bot1", thread_id=self.thread, kind="signin", title="Sign in")

        def boom(c, outcome):
            raise RuntimeError("sign-in page unreachable")
        self.store.register_resume_handler("signin", boom)
        with self.assertRaises(bot_cards.CardError):
            self.store.resume_card(card["id"], "david", "done")
        self.assertEqual(self.store.get(card["id"], "david")["status"], "pending")
        self.assertEqual(self.store.resume_card(card["id"], "david", "skipped")["card"]["status"], "skipped")

    def test_an_approval_has_no_resume_handler(self):
        with self.assertRaises(bot_cards.CardError):
            self.store.register_resume_handler("approval", lambda c, o: {})


class Ownership(CardCase):
    async def test_another_person_sees_and_answers_nothing(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        with self.assertRaises(bot_cards.CardNotFound):
            self.store.respond(card["id"], "mallory", action="allow")
        self.assertEqual(self.store.list_cards("mallory"), [])
        task.cancel()

    async def test_routes_hide_other_owners_cards_and_threads(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        async with client() as web:
            listed = (await web.get("/api/bot-cards", params={"thread_id": self.thread})).json()
            self.assertEqual([c["id"] for c in listed["cards"]], [card["id"]])
            self.assertEqual(listed["pending"], 1)
            USER["name"] = "mallory"
            self.assertEqual((await web.get("/api/bot-cards", params={"thread_id": self.thread})).status_code, 404)
            self.assertEqual((await web.get("/api/bot-cards")).json()["cards"], [])
            self.assertEqual((await web.post(f"/api/bot-cards/{card['id']}/respond", json={"action": "allow"})).status_code, 404)
            USER["name"] = "david"
        task.cancel()

    async def test_the_respond_route_settles_once_and_a_reload_shows_it(self):
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        async with client() as web:
            first = await web.post(f"/api/bot-cards/{card['id']}/respond", json={"action": "allow", "remember": "once"})
            self.assertEqual((first.status_code, first.json()["card"]["status"]), (200, "allowed"))
            self.assertNotIn("request_id", first.json())
            second = await web.post(f"/api/bot-cards/{card['id']}/respond", json={"action": "deny"})
            self.assertEqual(second.status_code, 409)
            self.assertEqual(second.json()["card"]["status"], "allowed")
            bot_cards.reset_for_test(self.path)  # reload
            listed = (await web.get("/api/bot-cards", params={"thread_id": self.thread, "status": "allowed"})).json()
            self.assertEqual([c["status"] for c in listed["cards"]], ["allowed"])
        self.assertEqual((await asyncio.wait_for(task, 2)).behavior, "allow")

    async def test_route_bodies_forbid_extra_fields_and_bad_answers(self):
        task, payload = await self.ask_questions([{"question": "Which?", "options": [{"label": "A"}]}])
        card = self.card_for(payload)
        async with client() as web:
            url = f"/api/bot-cards/{card['id']}/respond"
            self.assertEqual((await web.post(url, json={"action": "answer", "answers": {"q1": "A"}, "owner": "x"})).status_code, 422)
            self.assertEqual((await web.post(url, json={"action": "root"})).status_code, 422)
            self.assertEqual((await web.post(url, json={"action": "answer", "answers": {"q1": "x" * 2001}})).status_code, 422)
            self.assertEqual((await web.post(url, json={"action": "answer", "answers": {"q1": "B"}})).status_code, 200,
                             "a typed answer is allowed when the question accepts one")
        await asyncio.wait_for(task, 2)

    async def test_listeners_hear_open_and_settle(self):
        events = []
        self.store.add_listener(lambda packet: events.append((packet["event"], packet["card"]["status"])))
        task, payload = await self.ask_permission()
        card = self.card_for(payload)
        self.store.respond(card["id"], "david", action="deny")
        self.assertEqual(events, [("opened", "pending"), ("settled", "denied")])
        await asyncio.wait_for(task, 2)


if __name__ == "__main__":
    unittest.main()
