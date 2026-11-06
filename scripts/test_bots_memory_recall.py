"""Bots Phase 2, unit U2: recall, About you and the recall routes (2026-10-29).

Real sessions, a real SQLite FTS5 index, an in-memory stand-in for unit U1's notebook. Run:
    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_memory_recall.py
"""
import os
import sys
import tempfile
import time
import unittest
from datetime import date, datetime
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-recall-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from bots_chat_harness import OWNER, Harness  # noqa: E402
from bots_memory_support import FakeNotebook  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import bot_recall_routes  # noqa: E402
from services import bot_memory_recall as recall, bot_profile, bot_threads, bot_turn_context as ctx  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(bot_recall_routes.router)
app.dependency_overrides[require_admin] = lambda: OWNER; app.dependency_overrides[require_user] = lambda: OWNER
web = TestClient(app)


def line(text):
    return ctx.format_entry(date(2026, 10, 1), "chat", text)


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.nb = FakeNotebook()
        ctx.set_notebook(self.nb)
        self.addCleanup(ctx.set_notebook, None)
        recall.rebuild()
        bot_profile.remove_owner(OWNER)
        self.addCleanup(bot_profile.remove_owner, OWNER)
        self.bot = self.h.bot("Scout")
        self.bid = self.bot["id"]
        self.scope = {"bot_id": self.bid, "owner": OWNER}

    def convo(self, lines, title="Chat", owner=OWNER, bot=None, opened_by="person", ts=None):
        session = bot_threads.create_thread(bot or self.bot, owner, title)
        self.h.threads.append(session["id"])
        if opened_by != "person":
            session_manager.set_thread(session["id"], opened_by=opened_by)
        for user, reply in lines:
            session_manager.append_message(session["id"], "user", user)
            session_manager.append_message(session["id"], "assistant", reply)
        return session["id"]

    def texts(self, found):
        return [r["text"] for r in found["results"]]


class SearchTests(Base):
    async def test_words_prefixes_and_stop_words(self):
        self.convo([("What is the status of the Henderson renovation budget?", "The Henderson budget is 40k.")], "Renovation")
        self.convo([("Plan a trip to Lisbon", "Sure, when?")], "Trip")
        found = recall.search(self.scope, q="hender")
        self.assertEqual(len(found["results"]), 2, "a prefix finds both the question and the answer")
        self.assertTrue(all("Henderson" in r["text"] for r in found["results"]))
        self.assertEqual(recall.terms("What did I say about the Henderson budget and the budget"), ["henderson", "budget"])
        with self.assertRaises(recall.RecallError):
            recall.search(self.scope, q="the and of")
        trip = recall.search(self.scope, q="lisbon trip")
        self.assertEqual(trip["results"][0]["title"], "Trip")
        self.assertTrue(trip["results"][0]["ref"], "a stable message reference comes with every result")

    async def test_other_bots_other_owners_and_routines_never_appear(self):
        other = self.h.bot("Other")
        self.convo([("Quartz is the secret word for my bot", "ok")])
        self.convo([("Quartz belongs to someone else", "ok")], owner="mallory")
        self.convo([("Quartz in the other bot", "ok")], bot=other)
        self.convo([("Quartz in a routine run", "ok")], opened_by="routine")
        self.convo([("Quartz in a handoff", "ok")], opened_by="handoff")
        found = recall.search(self.scope, q="quartz")
        self.assertEqual([t for t in self.texts(found) if t.startswith("Quartz")], ["Quartz is the secret word for my bot"])
        self.assertEqual(recall.search({"bot_id": self.bid, "owner": "mallory"}, q="quartz")["count"], 1)
        self.assertEqual(recall.search({"bot_id": other["id"], "owner": OWNER}, q="quartz")["count"], 1)

    async def test_date_filters_and_spans(self):
        sid = self.convo([("Old news about turnips", "ok")])
        from core import session_manager_store as store
        session = session_manager.get_session(sid)
        old = time.time() - 5 * 86400
        for row in session["messages"]:
            row["ts"] = old
        store.save_session(session)
        self.convo([("Fresh news about turnips", "ok")])
        recall.rebuild()
        self.assertEqual(self.texts(recall.search(self.scope, q="turnips", since="24h"))[:1], ["Fresh news about turnips"])
        self.assertEqual(recall.search(self.scope, q="turnips", since="24h")["count"], 1)
        self.assertEqual(recall.search(self.scope, q="turnips", until="3d")["count"], 1)
        self.assertEqual(recall.search(self.scope, q="turnips", since="2w")["count"], 2)
        self.assertEqual(recall.search(self.scope, since="today")["count"], 2, "a date alone lists the newest messages")
        day = datetime.fromtimestamp(old).strftime("%Y-%m-%d")
        self.assertEqual(recall.search(self.scope, q="turnips", since=day, until=day)["count"], 1)
        yesterday = recall.parse_bound("yesterday", time.time())
        self.assertLess(yesterday, recall.parse_bound("today", time.time()))
        with self.assertRaises(recall.RecallError):
            recall.search(self.scope, q="turnips", since="last tuesday")

    async def test_topic_files_are_searched_but_index_archive_and_logs_are_not(self):
        self.nb.put(self.bid, ctx.INDEX, line("Zebra stripes in the index"))
        self.nb.put(self.bid, ctx.ARCHIVE, line("Zebra in the archive"))
        self.nb.put(self.bid, "memory/log/2026-10-28.md", "- 10:00 · tidy · zebra log line")
        self.nb.put(self.bid, "memory/animals.md", "---\ntitle: animals\n---\n" + line("Zebra is the favourite animal") + "\n")
        found = recall.search(self.scope, q="zebra")
        self.assertEqual([(r["kind"], r["source"]) for r in found["results"]], [("memory", "animals")])
        self.assertEqual(recall.search(self.scope, q="zebra", kind="conversations")["count"], 0)
        self.assertEqual(recall.search(self.scope, q="zebra", kind="memory")["count"], 1)

    async def test_an_index_that_is_deleted_comes_back(self):
        self.convo([("Remember the walrus", "ok")])
        self.assertEqual(recall.search(self.scope, q="walrus")["count"], 1)
        recall.rebuild()
        os.remove(recall.db_file())
        self.assertEqual(recall.search(self.scope, q="walrus")["count"], 1)

    async def test_forgotten_passages_leave_every_result(self):
        self.convo([("The Henderson deal is big", "ok"), ("Unrelated lunch plans", "fine")])
        self.assertEqual(recall.search(self.scope, q="henderson")["count"], 1)
        bot_profile.forget(OWNER, "Henderson")
        self.assertEqual(recall.search(self.scope, q="henderson")["count"], 0)
        self.assertEqual(recall.search(self.scope, q="lunch")["count"], 1)

    async def test_limit_is_bounded(self):
        self.convo([(f"Pineapple thought number {n}", "ok") for n in range(30)])
        self.assertEqual(recall.search(self.scope, q="pineapple", limit=999)["count"], recall.SEARCH_MAX)
        self.assertEqual(recall.search(self.scope, q="pineapple")["count"], recall.SEARCH_DEFAULT)

    async def test_an_edited_conversation_is_reindexed(self):
        sid = self.convo([("The apricot plan", "ok")])
        self.assertEqual(recall.search(self.scope, q="apricot")["count"], 1)
        session_manager.append_message(sid, "user", "Also the quince plan")
        self.assertEqual(recall.search(self.scope, q="quince")["count"], 1)
        session_manager.delete_session(sid)
        self.assertEqual(recall.search(self.scope, q="apricot")["count"], 0, "a deleted conversation leaves the index")


class TurnRecallTests(Base):
    async def test_the_turn_gets_four_and_four_within_the_limit_and_never_the_current_thread(self):
        for n in range(6):
            self.nb.put(self.bid, f"memory/t{n}.md", "---\ntitle: t\n---\n" + line(f"Marmalade fact {n} about oranges") + "\n")
        for n in range(6):
            self.convo([(f"Marmalade chat number {n} with oranges " + "padding " * 20, "ok")], f"Chat {n}")
        current = self.convo([("Tell me about marmalade", "ok")], "Now")
        found = recall.for_turn({**self.scope, "session_id": current}, "Tell me about marmalade")
        kinds = [r["kind"] for r in found["found"]]
        self.assertEqual((kinds.count("memory"), kinds.count("conversation")), (4, 4))
        self.assertLessEqual(len(found["text"]), recall.TURN_CHARS)
        self.assertNotIn("Tell me about marmalade", found["text"], "the current message is never recalled")
        self.assertTrue(all(r["source"] != current for r in found["found"]))
        self.assertIn("message ", found["text"], "each passage names its conversation and a message reference")

    async def test_the_prepared_turn_marks_recall_as_untrusted_and_skips_ineligible_turns(self):
        self.convo([("The marmalade recipe uses Seville oranges", "ok")], "Recipes")
        current = self.convo([("something else entirely", "ok")], "Now")
        scope = {**self.scope, "session_id": current}
        prepared = ctx.prepare(scope, "what was that marmalade recipe")
        self.assertIn("Seville oranges", prepared.context)
        self.assertIn("recall", prepared.taint)
        self.assertIn("UNTRUSTED", prepared.context)
        session_manager.set_thread(current, opened_by="routine")
        self.assertEqual(ctx.prepare(scope, "what was that marmalade recipe").recalled, [], "a routine run does no recall")
        session_manager.set_thread(current, opened_by="person")
        agent_service._agents[self.bid]["memory_enabled"] = False
        self.assertNotIn("Seville", ctx.prepare(scope, "what was that marmalade recipe").context)

    async def test_a_real_turn_carries_recall_but_does_not_save_it(self):
        self.convo([("The marmalade recipe uses Seville oranges", "ok")], "Recipes")
        sid = self.h.thread(self.bot, "Now")
        await self.h.send(sid, "what was that marmalade recipe [reply:Seville oranges]")
        await self.h.idle()
        self.assertIn("Seville oranges", self.h.prompts[0])
        user = [m for m in self.h.session(sid)["messages"] if m["role"] == "user"][0]
        self.assertEqual(user["content"], "what was that marmalade recipe [reply:Seville oranges]")
        self.assertNotIn("Seville", user.get("sent") or "")


class ReadMessageTests(Base):
    async def test_a_message_by_reference_capped_and_checked_again(self):
        sid = self.convo([("Short question about plums", "x" * 9000 + " plums")])
        found = recall.search(self.scope, q="plums")
        long = next(r for r in found["results"] if r["role"] == "assistant")
        got = recall.read_message(self.scope, long["ref"])
        self.assertEqual((len(got["text"]), got["truncated"]), (recall.READ_CAP, True))
        for bad in ({"bot_id": self.bid, "owner": "mallory"}, {"bot_id": self.h.bot("Other")["id"], "owner": OWNER}):
            with self.assertRaises(recall.RecallNotFound):
                recall.read_message(bad, long["ref"])
        with self.assertRaises(recall.RecallNotFound):
            recall.read_message(self.scope, "nonexistent")
        session_manager.set_thread(sid, opened_by="routine")
        with self.assertRaises(recall.RecallNotFound):
            recall.read_message(self.scope, long["ref"])

    async def test_topic_passages_can_be_read_and_forgotten_ones_cannot(self):
        self.nb.put(self.bid, "memory/fruit.md", "---\ntitle: fruit\n---\n" + line("Plums are purple") + "\n")
        ref = recall.search(self.scope, q="plums")["results"][0]["ref"]
        self.assertIn("Plums are purple", recall.read_message(self.scope, ref)["text"])
        self.convo([("Plums in a chat", "ok")])
        chat_ref = next(r["ref"] for r in recall.search(self.scope, q="plums", kind="conversations")["results"])
        bot_profile.forget(OWNER, "plums")
        with self.assertRaises(recall.RecallNotFound):
            recall.read_message(self.scope, chat_ref)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.owner = f"user-{time.time_ns()}"
        self.addCleanup(bot_profile.remove_owner, self.owner)

    def test_the_key_comes_from_the_identity(self):
        a, b = bot_profile.owner_key("alice"), bot_profile.owner_key("bob")
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith("p_"))
        with self.assertRaises(bot_profile.ProfileError):
            bot_profile.owner_key("")

    def test_about_text_is_checked_and_capped(self):
        first = bot_profile.get_about(self.owner)
        saved = bot_profile.put_about(self.owner, "I live in Lisbon.", first["hash"])
        with self.assertRaises(bot_profile.ProfileConflict):
            bot_profile.put_about(self.owner, "stale write", first["hash"])
        with self.assertRaises(bot_profile.ProfileTooLarge):
            bot_profile.put_about(self.owner, "x" * (bot_profile.ABOUT_LIMIT + 1), saved["hash"])
        self.assertEqual(bot_profile.put_about(self.owner, "x" * bot_profile.ABOUT_LIMIT, saved["hash"])["chars"], bot_profile.ABOUT_LIMIT)

    def test_learned_facts_are_dated_bounded_and_removal_is_remembered(self):
        fact = bot_profile.add_learned(self.owner, "Likes jazz", "Scout")
        self.assertIsNotNone(fact)
        self.assertIsNone(bot_profile.add_learned(self.owner, "likes   jazz!", "Other"), "the same fact, not twice")
        self.assertIn("learned by Scout", bot_profile.profile_context(self.owner))
        bot_profile.remove_learned(self.owner, fact)
        self.assertIsNone(bot_profile.add_learned(self.owner, "Likes jazz", "Scout"), "a removed fact is not learned again")
        with self.assertRaises(bot_profile.ProfileMissing):
            bot_profile.remove_learned(self.owner, fact)
        bot_profile.lift(self.owner, text="Likes jazz")
        self.assertIsNotNone(bot_profile.add_learned(self.owner, "Likes jazz", "Scout"))
        for n in range(bot_profile.MAX_LEARNED + 5):
            bot_profile.add_learned(self.owner, f"Distinct fact number {n}", "Scout")
        self.assertEqual(len(bot_profile.learned(self.owner)), bot_profile.MAX_LEARNED)

    def test_forget_terms_are_whole_words_of_three_letters_and_bounded(self):
        with self.assertRaises(bot_profile.ProfileError):
            bot_profile.forget(self.owner, "to")
        for n in range(bot_profile.MAX_FORGOTTEN + 3):
            bot_profile.forget(self.owner, f"term{n:04d}")
        self.assertEqual(len(bot_profile.forgotten_terms(self.owner)), bot_profile.MAX_FORGOTTEN)
        self.assertFalse(bot_profile.is_suppressed(self.owner, "nothing here"))

    def test_learned_facts_can_be_left_out(self):
        bot_profile.add_learned(self.owner, "Secretly likes opera", "Scout")
        self.assertNotIn("opera", bot_profile.profile_context(self.owner, include_learned=False))
        self.assertEqual(bot_profile.profile_context(None), "")


class RouteTests(Base):
    async def test_profile_routes(self):
        about = web.get("/api/bots/profile").json()
        put = web.put("/api/bots/profile", json={"text": "I am David.", "expected_hash": about["hash"]})
        self.assertEqual(put.status_code, 200, put.text)
        self.assertEqual(web.put("/api/bots/profile", json={"text": "late", "expected_hash": about["hash"]}).status_code, 409)
        self.assertEqual(web.put("/api/bots/profile", json={"text": "x", "expected_hash": put.json()["hash"], "owner": "mallory"}).status_code, 422)
        fact = bot_profile.add_learned(OWNER, "Likes jazz", "Scout")
        self.assertEqual([r["id"] for r in web.get("/api/bots/profile").json()["learned"]], [fact])
        self.assertEqual(web.post(f"/api/bots/profile/learned/{fact}/remove").status_code, 200)
        self.assertEqual(web.post(f"/api/bots/profile/learned/{fact}/remove").status_code, 404)
        bot_profile.remove_owner(OWNER)

    async def test_recall_routes_and_errors(self):
        self.convo([("Walnut thoughts for later", "Noted walnut")])
        found = web.get(f"/api/bots/{self.bid}/recall", params={"q": "walnut"}).json()
        self.assertEqual(found["count"], 2)
        ref = found["results"][0]["ref"]
        self.assertEqual(web.get(f"/api/bots/{self.bid}/recall/messages/{ref}").status_code, 200)
        self.assertEqual(web.get(f"/api/bots/{self.bid}/recall/messages/nope").status_code, 404)
        self.assertEqual(web.get(f"/api/bots/{self.bid}/recall").status_code, 400)
        self.assertEqual(web.get(f"/api/bots/{self.bid}/recall", params={"q": "walnut", "limit": 99}).status_code, 422)
        self.assertEqual(web.get("/api/bots/nobody/recall", params={"q": "walnut"}).status_code, 404)
        agent_service._agents[self.bid]["memory_enabled"] = False
        self.assertTrue(web.get(f"/api/bots/{self.bid}/recall", params={"q": "walnut"}).json()["disabled"])

    async def test_forget_route_and_activity(self):
        self.nb.put(self.bid, ctx.INDEX, line("Henderson likes email") + "\n" + line("Likes tea") + "\n")
        self.assertEqual(web.post(f"/api/bots/{self.bid}/memory/forget", json={"term": "ab"}).status_code, 400)
        self.assertEqual(web.post(f"/api/bots/{self.bid}/memory/forget", json={"term": "Henderson", "extra": 1}).status_code, 422)
        done = web.post(f"/api/bots/{self.bid}/memory/forget", json={"term": "Henderson"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json()["notebook_lines"], 1)
        self.assertNotIn("Henderson", self.nb.text(self.bid, ctx.INDEX))
        activity = web.get(f"/api/bots/{self.bid}/memory/activity").json()
        self.assertEqual(set(["memory_enabled", "upkeep", "report", "ideas", "pending_threads", "tidy_time"]) - set(activity), set())
        bot_profile.remove_owner(OWNER)


if __name__ == "__main__":
    unittest.main()
