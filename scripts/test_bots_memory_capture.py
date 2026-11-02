"""Bots Phase 2, unit U2: capture, organize, tidy, dream and forget (2026-10-29).

A fake clock (every function takes `now`) and a scripted side-job model against an in-memory stand-in for unit
U1's notebook. Run:
    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_memory_capture.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-memcap-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import OWNER, Harness  # noqa: E402
from bots_memory_support import FakeNotebook, ScriptedModel  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import (bot_memory_capture as capture, bot_memory_dream as dream, bot_memory_upkeep as upkeep,  # noqa: E402
                      bot_profile, bot_side_jobs, bot_turn_context as ctx)
from services.agent_service import agent_service  # noqa: E402

NOW = time.time()
TODAY = ctx.owner_today(NOW)


def line(text, day=None, source="chat", until=None):
    return ctx.format_entry(day or date(2026, 10, 1), source, text, until)


def items(*rows):
    return json.dumps({"items": list(rows)})


def item(text, evidence=None, kind="fact", confidence=0.9, **extra):
    return {"text": text, "kind": kind, "evidence": evidence if evidence is not None else text, "confidence": confidence,
            "until": None, "about_user": False, "topic": None, "aliases": [], **extra}


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.nb = FakeNotebook()
        ctx.set_notebook(self.nb)
        self.addCleanup(ctx.set_notebook, None)
        bot_profile.remove_owner(OWNER)
        self.addCleanup(bot_profile.remove_owner, OWNER)
        self.model = ScriptedModel().install()
        self.addCleanup(self.model.remove)
        self.bot = self.h.bot("Scout")
        self.bid = self.bot["id"]
        agent_service._agents[self.bid]["memory_upkeep"] = True
        self.nb.put(self.bid, ctx.INDEX, "# Notes\n")

    def convo(self, lines, title="Chat", owner=OWNER, bot=None, opened_by="person"):
        bot = bot or self.bot
        session = __import__("services.bot_threads", fromlist=["x"]).create_thread(bot, owner, title)
        self.h.threads.append(session["id"])
        if opened_by != "person":
            session_manager.set_thread(session["id"], opened_by=opened_by)
        for user, reply in lines:
            session_manager.append_message(session["id"], "user", user)
            session_manager.append_message(session["id"], "assistant", reply)
        return session["id"]

    def note(self, sid, when=NOW, bot=None):
        session = session_manager.get_session(sid)
        rows = session["messages"]
        pairs = [(rows[i], rows[i + 1]) for i in range(0, len(rows) - 1, 2)]
        for user, reply in pairs:
            capture.note_turn((bot or self.bot)["id"], sid, owner=OWNER, user_text=user["content"], reply_text=reply["content"],
                              user_ref={"id": user["bot_message_id"]}, reply_ref={"id": reply["bot_message_id"]},
                              run_id="r", now=when)

    def index(self):
        return self.nb.text(self.bid, ctx.INDEX)


class PendingBufferTests(Base):
    async def test_quiet_time_six_turns_and_coalescing(self):
        a = self.convo([("I am moving to Lisbon in March for work.", "Great.")], "A")
        b = self.convo([("My sister Ana visits every August without fail.", "Nice.")], "B")
        self.note(a, NOW)
        self.note(b, NOW + 100)
        self.assertEqual(capture.due_threads(self.bid, NOW + 299), [])
        self.assertEqual(capture.due_threads(self.bid, NOW + 300), [a], "B is not quiet yet")
        self.assertEqual(sorted(capture.due_threads(self.bid, NOW + 385)), sorted([a, b]), "B is within 15 seconds of quiet")
        c = self.convo([(f"Message number {i} that is long enough to count.", "ok") for i in range(6)], "C")
        self.note(c, NOW + 500)
        self.assertIn(c, capture.due_threads(self.bid, NOW + 501), "six turns do not wait for quiet")

    async def test_the_buffer_is_bounded_and_survives_a_restart(self):
        sids = [self.convo([(f"Distinct long enough message {i} about plans.", "ok")], f"T{i}") for i in range(52)]
        for number, sid in enumerate(sids):
            self.note(sid, NOW + number)
        self.assertEqual(len(capture.pending(self.bid)), capture.MAX_THREADS)
        self.assertNotIn(sids[0], capture.pending(self.bid), "the oldest thread falls out first")
        busy = self.convo([(f"Another long enough message {i} about plans.", "ok") for i in range(9)], "Busy")
        self.note(busy, NOW + 99)
        self.assertEqual(len(capture.pending(self.bid)[busy]["turns"]), capture.MAX_TURNS)
        data = json.loads(Path(capture.STATE_FILE).read_text("utf-8"))
        self.assertIn(busy, data["bots"][self.bid]["threads"], "kept on disk, not only in memory")

    async def test_trivial_exchanges_cost_nothing(self):
        sid = self.convo([("ok thanks", "You are welcome and have a lovely day.")])
        self.note(sid)
        self.assertEqual(capture.pending(self.bid), {})
        self.assertTrue(capture.trivial("short"))
        self.assertFalse(capture.trivial("a message that is longer than twenty four bytes"))


class CaptureTests(Base):
    async def run_capture(self, *answers, when=NOW + 400):
        self.model.answers.extend(answers)
        return await capture.run_bot(self.bid, when)

    async def test_items_are_filed_with_stable_grammar_topics_and_profile_facts(self):
        sid = self.convo([("I prefer short answers and I use a standing desk at work. My name is David Darr.", "Understood.")])
        self.note(sid)
        report = await self.run_capture(items(
            item("Prefers short answers", "I prefer short answers", "preference"),
            item("Uses a standing desk", "I use a standing desk at work", topic="workspace", aliases=["desk"]),
            item("Name is David Darr", "My name is David Darr", about_user=True)))
        self.assertEqual((report["saved"], report["profile"], report["deferred"]), (2, 1, 0))
        self.assertIn(f"- {TODAY.isoformat()} · from chat · Prefers short answers", self.index())
        topic = self.nb.text(self.bid, "memory/workspace.md")
        self.assertTrue(topic.startswith("---\ntitle: workspace"))
        self.assertIn("Uses a standing desk", topic)
        self.assertEqual([r["text"] for r in bot_profile.learned(OWNER)], ["Name is David Darr"])
        self.assertEqual({t["actor"] for t in self.nb.transactions}, {"capture"})
        self.assertEqual(capture.pending(self.bid), {}, "the pending reference is cleared")
        self.assertEqual(self.model.requests[0][0], "claude_cli")

    async def test_evidence_gates(self):
        sid = self.convo([("Do I like jazz? Suppose I moved to Paris. I really enjoy hiking on weekends. Keep it brief.", "Okay.")])
        self.note(sid)
        report = await self.run_capture(items(
            item("Likes jazz", "Do I like jazz?"),                         # inside a question
            item("Lives in Paris", "I moved to Paris"),                    # hypothetical sentence
            item("Enjoys hiking", "I really enjoy hiking on weekends"),    # verbatim, plain statement
            item("Enjoys sailing", "I love sailing"),                      # not said at all
            item("Likes brevity", "Keep it brief", "preference", confidence=0.5),
            item("Decided to answer briefly", "n/a", "decision"),          # decisions need no verbatim evidence
            item("Odd kind", "x", "gossip")))
        self.assertEqual(report["saved"], 2)
        text = self.index()
        self.assertIn("Enjoys hiking", text)
        self.assertIn("Decided to answer briefly", text)
        for refused in ("jazz", "Paris", "sailing", "brevity", "Odd kind"):
            self.assertNotIn(refused, text)
        self.assertEqual(report["rejected"], {"no evidence": 3, "low confidence": 1, "malformed": 1})

    async def test_forgotten_facts_and_known_notes_are_not_filed_again(self):
        self.nb.put(self.bid, ctx.INDEX, "# Notes\n" + line("Likes hiking") + "\n")
        bot_profile.forget(OWNER, "Henderson")
        sid = self.convo([("The Henderson project is due Friday. I like hiking a lot.", "ok")])
        self.note(sid)
        report = await self.run_capture(items(
            item("The Henderson project is due Friday", "The Henderson project is due Friday"),
            item("Likes hiking", "I like hiking a lot")))
        self.assertEqual(report["saved"], 0)
        self.assertEqual(report["rejected"], {"forgotten": 1, "already known": 1})
        self.assertNotIn("Henderson", self.index())

    async def test_a_restart_never_captures_the_same_turns_twice(self):
        sid = self.convo([("I am allergic to penicillin and always carry a card.", "Noted.")])
        self.note(sid)
        await self.run_capture(items(item("Allergic to penicillin", "I am allergic to penicillin")))
        self.assertEqual(len(self.model.requests), 1)
        self.note(sid)   # the same message references arrive again after a restart
        self.assertEqual(await self.run_capture(items(item("Allergic to penicillin", "I am allergic to penicillin"))), None)
        self.assertEqual(len(self.model.requests), 1, "no second model call")
        self.assertEqual(self.index().count("penicillin"), 1)

    async def test_limits_eight_per_conversation_sixteen_per_batch(self):
        sentence = " ".join(f"I like thing{n}." for n in range(20))
        a, b, c = (self.convo([(sentence, "ok")], t) for t in "ABC")
        for sid in (a, b, c):
            self.note(sid)
        many = items(*[item(f"Likes thing{n}", f"I like thing{n}") for n in range(20)])
        distinct = lambda start: items(*[item(f"Likes thing{n}", f"I like thing{n}") for n in range(start, start + 20)])
        report = await self.run_capture(many, distinct(0), distinct(0))
        self.assertLessEqual(report["saved"], capture.PER_BATCH)
        self.assertEqual(report["saved"], 16, "eight from the first conversation, eight new ones from the second, none after")
        self.assertEqual(len(self.nb.text(self.bid, ctx.INDEX).splitlines()), 17)

    async def test_safety_facts_stay_in_the_index_and_make_room_never_evicts_them(self):
        full = "".join(line(f"Filler {i}", day=date(2026, 1, 1) + timedelta(days=i % 200)) + "\n" for i in range(150))
        full += line("Severe peanut allergy", day=date(2020, 1, 1)) + "\n" + "Hand-written reminder\n" * 50
        self.nb.put(self.bid, ctx.INDEX, full)
        sid = self.convo([("I take medication every morning at eight o'clock sharp.", "ok")])
        self.note(sid)
        report = await self.run_capture(items(item("Takes medication every morning", "I take medication every morning",
                                                    topic="health")))
        self.assertEqual(report["saved"], 1)
        self.assertIn("Takes medication every morning", self.index(), "a health fact is core even with a topic")
        self.assertEqual(self.nb.text(self.bid, "memory/health.md"), "")
        self.assertIn("Severe peanut allergy", self.index())
        self.assertEqual(self.index().count("Hand-written reminder"), 50)
        self.assertLessEqual(len(self.index().splitlines()), ctx.NOTEBOOK_MAX_LINES)
        self.assertIn("Archived", self.nb.text(self.bid, ctx.ARCHIVE))

    async def test_a_full_index_of_protected_text_defers_instead_of_evicting(self):
        self.nb.put(self.bid, ctx.INDEX, "".join(line(f"Allergy note {i}") + "\n" for i in range(200)))
        before = self.index()
        sid = self.convo([("I like green tea in the afternoon every day.", "ok")])
        self.note(sid)
        report = await self.run_capture(items(item("Likes green tea", "I like green tea in the afternoon")))
        self.assertEqual((report["saved"], report["deferred"]), (0, 1))
        self.assertEqual(self.index(), before, "the unchanged document is returned")

    async def test_a_conflicting_edit_is_retried_not_overwritten(self):
        sid = self.convo([("I like green tea in the afternoon every day.", "ok")])
        self.note(sid)
        self.nb.fail_next_conflict = 1
        report = await self.run_capture(items(item("Likes green tea", "I like green tea in the afternoon")))
        self.assertEqual(report["saved"], 1)

    async def test_no_model_means_a_clear_note_and_the_buffer_is_kept(self):
        sid = self.convo([("I like green tea in the afternoon every day.", "ok")])
        self.note(sid)
        with patch.object(bot_side_jobs, "engines_for", return_value=[]):
            report = await capture.run_bot(self.bid, NOW + 400)
        self.assertIn("No model", report["note"])
        self.assertIn(sid, capture.pending(self.bid))

    async def test_only_owner_conversations_are_read(self):
        sid = self.convo([("I like green tea in the afternoon every day.", "ok")], opened_by="routine")
        self.note(sid)
        self.assertEqual(await self.run_capture(items(item("x" * 10, "y"))), None)
        self.assertEqual(self.model.requests, [])

    async def test_organize_moves_detail_but_never_protected_facts(self):
        rows = [line(f"Detail number {i}") for i in range(130)] + [line("Peanut allergy")] + [line(f"More {i}") for i in range(30)]
        self.nb.put(self.bid, ctx.INDEX, "\n".join(rows) + "\n")
        moves = json.dumps({"moves": [{"id": 130, "topic": "health"}, {"id": 0, "topic": "details", "aliases": ["d"]},
                                      {"id": 1, "topic": "bad topic!"}, {"id": 999, "topic": "details"}]})
        self.model.answers.append(moves)
        out = await capture.organize(self.bid, NOW)
        self.assertEqual(out["organized"], 1, "the allergy row was never a candidate; bad topic and id refused")
        self.assertNotIn("Detail number 0\n", self.index())
        self.assertIn("Detail number 0", self.nb.text(self.bid, "memory/details.md"))
        self.assertIn("Peanut allergy", self.index())
        self.nb.put(self.bid, ctx.INDEX, "# small\n")
        self.assertEqual((await capture.organize(self.bid, NOW))["organized"], 0, "a small index is left alone")


class TidyTests(Base):
    async def test_deterministic_pass_archives_expired_and_keeps_the_newest_duplicate(self):
        old = date(2026, 9, 1)
        self.nb.put(self.bid, ctx.INDEX, "\n".join([
            "# Notes", line("Expired thing", until=date(2026, 10, 2)), line("Likes tea", day=old), line("likes TEA!", day=date(2026, 10, 5)),
            "- 2026-08-01 (until 2026-08-30): legacy expired", "hand-written", ""]))
        report = await upkeep.tidy(self.bid, NOW)
        self.assertEqual((report["expired"], report["duplicates"]), (2, 1))
        text = self.index()
        self.assertIn("likes TEA!", text)
        self.assertNotIn("Likes tea\n", text)
        self.assertNotIn("Expired thing", text)
        self.assertIn("hand-written", text)
        archive = self.nb.text(self.bid, ctx.ARCHIVE)
        self.assertIn("Expired thing", archive)
        self.assertIn("legacy expired", archive)
        self.assertEqual({t["actor"] for t in self.nb.transactions}, {"upkeep"})

    async def test_it_runs_once_a_day_and_not_while_the_bot_is_busy(self):
        self.assertIsNotNone(await upkeep.tidy(self.bid, NOW))
        self.assertIsNone(await upkeep.tidy(self.bid, NOW + 60))
        self.assertIsNotNone(await upkeep.tidy(self.bid, NOW + 86400 * 1.5))
        self.assertIsNotNone(await upkeep.tidy(self.bid, NOW + 60, force=True))
        agent_service._agents[self.bid]["memory_upkeep"] = False
        self.assertIsNone(await upkeep.tidy(self.bid, NOW + 86400 * 3, force=True), "upkeep off means no tidy")

    async def test_contradictions_need_five_notes_and_strike_not_delete(self):
        rows = [line("Lives in Berlin", day=date(2026, 3, 1)), line("Lives in Lisbon", day=date(2026, 9, 1))] + \
               [line(f"Fact {i}", day=date(2026, 5, 1) + timedelta(days=i)) for i in range(5)]
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + "\n".join(rows) + "\n")
        self.model.answers.append('{"pairs": [{"keep": 2, "drop": 1}, {"keep": 1, "drop": 2}, {"keep": 3, "drop": 3}]}')
        report = await upkeep.tidy(self.bid, NOW)
        self.assertEqual((report["superseded"], report["contradictionsChecked"]), (1, 1))
        text = self.index()
        self.assertIn("- ~~2026-03-01 · from chat · Lives in Berlin~~ · superseded " + TODAY.isoformat(), text)
        self.assertIn("Lives in Lisbon", text)
        self.assertEqual(text.count("superseded"), 1, "the older cannot beat the newer, and a note cannot beat itself")
        self.assertNotIn("Berlin", ctx.visible_lines(text, TODAY), "struck notes leave the prompt but not the file")

    async def test_four_notes_make_no_model_call_and_the_budget_is_a_fifth(self):
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + "\n".join(line(f"Fact {i}") for i in range(4)) + "\n")
        await upkeep.tidy(self.bid, NOW)
        self.assertEqual(self.model.requests, [])
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + "\n".join(line(f"Fact {i}", day=date(2026, 1, 1) + timedelta(days=i)) for i in range(10)) + "\n")
        pairs = [{"keep": 9, "drop": n} for n in range(1, 9)]
        self.model.answers.append(json.dumps({"pairs": pairs}))
        report = await upkeep.tidy(self.bid, NOW + 86400 * 2)
        self.assertEqual(report["superseded"], 2, "20% of ten live notes")

    async def test_topic_checks_rotate_with_four_model_checks_at_most(self):
        enough = "\n".join(line(f"Fact {i}", day=date(2026, 1, 1) + timedelta(days=i)) for i in range(6)) + "\n"
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + enough)
        for name in "abcdef":
            self.nb.put(self.bid, f"memory/{name}.md", "---\ntitle: x\n---\n" + enough)
        self.model.answers.extend(['{"pairs": []}'] * 12)
        first = await upkeep.tidy(self.bid, NOW, force=True)
        self.assertEqual(len(self.model.requests), 4)
        self.assertEqual((first["contradictionsChecked"], first["topicChecks"]), (1, 3))
        seen_first = [r[1] for r in self.model.requests]
        second = await upkeep.tidy(self.bid, NOW + 5, force=True)
        self.assertEqual(len(self.model.requests), 8)
        self.assertEqual(second["topicChecks"], 3)
        self.assertNotEqual(self.model.requests[4][1], seen_first[1], "the next run starts at a different topic")

    async def test_the_deadline_stops_a_slow_model_with_a_note(self):
        enough = "\n".join(line(f"Fact {i}") for i in range(6)) + "\n"
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + enough)

        async def slow(prompt):
            await asyncio.sleep(5)
            return "{}"
        self.model.answers.append(slow)
        with patch.object(upkeep, "CHECK_DEADLINE", 0.1):
            report = await upkeep.tidy(self.bid, NOW)
        self.assertIn("time limit", report["note"])

    async def test_without_a_model_only_the_deterministic_steps_run_and_it_says_so(self):
        with patch.object(bot_side_jobs, "engines_for", return_value=[]):
            report = await upkeep.tidy(self.bid, NOW)
        self.assertIn("No model can run", report["note"])

    async def test_each_run_appends_one_redacted_line_to_the_daily_log_once(self):
        report = await upkeep.tidy(self.bid, NOW)
        path = f"memory/log/{datetime.fromtimestamp(NOW).date().isoformat()}.md"
        log = self.nb.text(self.bid, path)
        self.assertEqual(log.count("run " + report["run_id"]), 1)
        self.assertFalse(upkeep.log_outcome(self.bid, report["run_id"], "again", NOW))
        upkeep.log_outcome(self.bid, "run-two", "password=abcdefghijklmnopqrstuvwxyz1234 sk-abcdefghijklmnopqrstuvwxyz123456", NOW)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz1234", self.nb.text(self.bid, path))
        self.assertEqual(self.nb.text(self.bid, path).count("\n- "), 2)

    async def test_the_tick_starts_the_daily_tidy_only_after_the_tidy_time(self):
        upkeep.set_settings_provider(lambda: {"tidy_time": "03:00", "capture_quiet_seconds": 300})
        self.addCleanup(upkeep.set_settings_provider, None)
        # Wall-clock moments, not midnight plus seconds: on a daylight-saving
        # day that sum lands an hour off (2026-11-01 has 25 hours, so +3h01m
        # was 02:01). 01:00 exists once on every day, unlike 02:00-02:59.
        day = datetime.fromtimestamp(NOW).replace(hour=0, minute=0, second=0, microsecond=0)
        at = lambda hour, minute: day.replace(hour=hour, minute=minute).timestamp()
        upkeep._memory["last_check"] = 0
        early = await upkeep.tick(at(1, 0))
        self.assertEqual(early["tidy"], [])
        late = await upkeep.tick(at(3, 1))
        self.assertEqual(late["tidy"], [self.bid])
        await upkeep.settle()
        self.assertEqual(upkeep.bot_state(self.bid)["last_tidy_day"], day.date().isoformat())
        again = await upkeep.tick(at(3, 2))
        self.assertEqual(again["tidy"], [], "checked every ten minutes, and once per day")
        self.assertEqual(upkeep.settings()["tidy_time"], "03:00")


class ForgetTests(Base):
    async def test_forget_removes_whole_word_matches_everywhere_and_remembers(self):
        self.nb.put(self.bid, ctx.INDEX, "# Notes\n" + "\n".join([line("The Henderson deal closes soon"), line("Hendersonville is a town"),
                                                                 line("Likes tea")]) + "\n")
        self.nb.put(self.bid, "memory/work.md", "---\ntitle: work\n---\n" + line("henderson prefers email") + "\n")
        self.nb.put(self.bid, ctx.ARCHIVE, "# Archive\n" + line("Old Henderson note") + "\n")
        bot_profile.put_about(OWNER, "I like cats.\nMy boss is Henderson.\n", bot_profile.get_about(OWNER)["hash"])
        bot_profile.add_learned(OWNER, "Works with Henderson", "Scout")
        result = upkeep.forget(self.bid, OWNER, "Henderson")
        self.assertEqual((result["notebook_lines"], result["learned_facts"], result["about_lines"]), (3, 1, 1))
        self.assertIn("Hendersonville is a town", self.index(), "a whole-word match only")
        self.assertNotIn("The Henderson deal", self.index())
        self.assertIn("title: work", self.nb.text(self.bid, "memory/work.md"))
        self.assertTrue(bot_profile.is_suppressed(OWNER, "henderson called"))
        self.assertEqual(bot_profile.get_about(OWNER)["text"], "I like cats.\n")
        with self.assertRaises(ValueError):
            upkeep.forget(self.bid, OWNER, "ab")
        self.assertEqual({t["actor"] for t in self.nb.transactions}, {"person"})

    async def test_capture_cannot_lift_a_suppression_but_the_owner_can(self):
        bot_profile.forget(OWNER, "Henderson")
        self.assertIsNone(bot_profile.add_learned(OWNER, "Henderson likes email", "Scout"))
        sid = self.convo([("Henderson likes email and I answer him every day.", "ok")])
        self.note(sid)
        report = await capture.run_bot(self.bid, NOW + 400) if self.model.answers.append(
            items(item("Henderson likes email", "Henderson likes email and I answer him"))) is None else None
        self.assertEqual(report["saved"], 0)
        bot_profile.lift(OWNER, term="Henderson")
        self.assertFalse(bot_profile.is_suppressed(OWNER, "Henderson likes email"))

    async def test_detecting_a_direct_request(self):
        self.assertEqual(upkeep.detect_forget("forget Henderson"), "Henderson")
        self.assertEqual(upkeep.detect_forget("Please forget about the Henderson deal."), "the Henderson deal")
        self.assertIsNone(upkeep.detect_forget("forget it"), "under three letters of substance... 'it' is too short")
        self.assertIsNone(upkeep.detect_forget("I will never forget how kind you were to me yesterday"))
        self.assertIsNone(upkeep.detect_forget("forget the long story about my trip to the mountains last week"))


class DreamTests(Base):
    def two(self, bot=None, extra=()):
        a = self.convo([("I always plan my week on Sunday evenings.", "ok")], "A", bot=bot)
        b = self.convo([("Sunday evening is when I plan the week ahead.", "ok")], "B", bot=bot)
        return a, b

    def answer(self, **parts):
        return json.dumps({"learned": [], "outdated": [], "ideas": [], **parts})

    async def test_it_needs_two_conversations(self):
        self.convo([("Only one conversation about planning here.", "ok")])
        self.assertIsNone(dream.eligible(self.bid, NOW))
        self.assertIsNone(await dream.run_bot(self.bid, NOW))

    async def test_accepted_patterns_outdated_notes_and_ideas(self):
        self.two()
        self.nb.put(self.bid, ctx.INDEX, "# N\n" + "\n".join(line(f"Old note {i}") for i in range(8)) + "\n")
        learned = lambda text, conv, conf=0.8: {"text": text, "conversations": conv, "confidence": conf, "topic": None}
        self.model.answers.append(self.answer(
            learned=[learned("Plans the week on Sunday evening", ["C1", "C2"]), learned("One-off", ["C1"]),
                     learned("Low confidence", ["C1", "C2"], 0.6), learned("Invented evidence", ["C1", "C9"])],
            outdated=[1, 2, 3, 4, 5, 6, 7, 99, True],
            ideas=[{"title": f"Idea {n}", "text": "Do a thing", "kind": "routine"} for n in range(5)]))
        report = await dream.run_bot(self.bid, NOW)
        self.assertEqual((report["patterns"], report["outdated"], report["ideas"]), (1, 5, 3))
        text = self.index()
        self.assertIn("from dream · Plans the week", text)
        self.assertEqual(text.count("superseded"), 5)
        self.assertEqual([i["title"] for i in dream.ideas(self.bid, NOW)], ["Idea 0", "Idea 1", "Idea 2"])
        self.assertEqual(dream.ideas(self.bid, NOW + 24 * 3600 + 1), [], "ideas expire after 24 hours")
        self.assertEqual(self.model.requests[0][3], 180)

    async def test_it_reads_only_the_owners_lines_within_the_byte_limits(self):
        a = self.convo([("OWNERLINE " + "x" * 6000, "BOTLINE should never be read")], "A")
        self.convo([("second OWNERLINE chat", "BOTLINE")], "B")
        self.model.answers.append(self.answer())
        await dream.run_bot(self.bid, NOW)
        prompt = self.model.requests[0][1]
        self.assertNotIn("BOTLINE", prompt)
        chats = dream._conversations(self.bid, NOW - 86400)[OWNER]
        self.assertTrue(all(len(t.encode()) <= dream.PER_CONVERSATION_BYTES for _, t in chats))
        self.assertLessEqual(sum(len(t.encode()) for _, t in chats), dream.TOTAL_BYTES)
        del a

    async def test_one_eligible_bot_a_day_in_turn(self):
        other = self.h.bot("Other")
        agent_service._agents[other["id"]]["memory_upkeep"] = True
        self.nb.put(other["id"], ctx.INDEX, "# N\n")
        self.two()
        self.two(bot=other)
        ids = [self.bid, other["id"]]
        self.model.answers.extend([self.answer(), self.answer()])
        first = dream.pick(NOW, ids)
        self.assertTrue(dream.eligible_today(NOW, ids))
        await dream.run_daily(NOW, ids)
        self.assertFalse(dream.eligible_today(NOW + 60, ids), "one dream a day")
        second = dream.pick(NOW + 86400, ids)
        self.assertNotEqual(first, second, "the other bot gets the next turn")
        self.assertEqual(len(self.model.requests), 1)

    async def test_a_failed_dream_does_not_spend_the_bots_turn(self):
        self.two()
        self.model.answers.append(RuntimeError("boom"))
        report = await dream.run_bot(self.bid, NOW)
        self.assertIn("tomorrow", report["note"])
        self.assertIsNone(dream.state(self.bid)["last_run"])

    async def test_nothing_is_created_from_an_idea(self):
        self.two()
        self.model.answers.append(self.answer(ideas=[{"title": "Weekly plan", "text": "Make a Sunday routine", "kind": "routine"}]))
        from services.task_service import task_service
        before = len(task_service.list_tasks()) if hasattr(task_service, "list_tasks") else 0
        await dream.run_bot(self.bid, NOW)
        after = len(task_service.list_tasks()) if hasattr(task_service, "list_tasks") else 0
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
