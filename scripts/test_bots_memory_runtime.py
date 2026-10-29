"""Bots Phase 2, unit U2: turn preparation, completion, side jobs and the scheduler tick (2026-10-29).

Real chat turns (scripts/bots_chat_harness.py) against an in-memory stand-in for unit U1's notebook
(scripts/bots_memory_support.py). No model is called. Run:
    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_memory_runtime.py
"""
import asyncio
import os
import sys
import tempfile
import time
import types
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-memrun-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import CLAUDE, OWNER, Harness  # noqa: E402
from bots_memory_support import FakeNotebook, ScriptedModel  # noqa: E402
from core import runs  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import (bot_memory_capture as capture, bot_memory_upkeep as upkeep, bot_profile, bot_side_jobs,  # noqa: E402
                      bot_turn_context as ctx, chat_live, chat_service)
from services.agent_service import agent_service  # noqa: E402

TODAY = date.today()


def line(text, day="2026-10-01", source="chat", until=None):
    return ctx.format_entry(date.fromisoformat(day), source, text, date.fromisoformat(until) if until else None)


class EntryTests(unittest.TestCase):
    def test_new_legacy_superseded_and_expiry_grammars(self):
        new = ctx.parse_entry("- 2026-10-01 · from chat · Likes tea · until 2026-12-01")
        self.assertEqual((new.text, new.source, new.until), ("Likes tea", "chat", date(2026, 12, 1)))
        old = ctx.parse_entry("- 2026-09-30 (until 2026-10-02): Old style note")
        self.assertEqual((old.text, old.until, old.legacy), ("Old style note", date(2026, 10, 2), True))
        struck = ctx.parse_entry("- ~~2026-10-01 · from chat · Likes tea~~ · superseded 2026-10-05")
        self.assertEqual((struck.text, struck.superseded), ("Likes tea", date(2026, 10, 5)))
        self.assertIsNone(ctx.parse_entry("## Heading"))
        self.assertIsNone(ctx.parse_entry("hand written line"))
        self.assertTrue(ctx.is_expired(new, date(2026, 12, 1)), "an until date at or before today is expired")
        self.assertFalse(ctx.is_expired(new, date(2026, 11, 30)))
        self.assertEqual(ctx.parse_entry(ctx.strike(new, date(2026, 11, 1))).superseded, date(2026, 11, 1))

    def test_clip_respects_lines_bytes_and_utf8(self):
        many = "".join(f"- line {i}\n" for i in range(300))
        clipped = ctx.clip_index(many)
        self.assertEqual((clipped["loaded_lines"], clipped["stored_lines"], clipped["clipped"]), (200, 300, True))
        wide = "".join("é" * 99 + "\n" for _ in range(190))   # 199 bytes a line: the byte limit comes first
        clipped = ctx.clip_index(wide)
        self.assertLessEqual(clipped["loaded_bytes"], ctx.NOTEBOOK_MAX_BYTES)
        self.assertLess(clipped["loaded_lines"], 190)
        self.assertEqual(clipped["text"].encode().decode(), clipped["text"])
        huge = ctx.clip_index("é" * 30000)
        self.assertLessEqual(huge["loaded_bytes"], ctx.NOTEBOOK_MAX_BYTES)
        self.assertEqual(ctx.clip_index("")["loaded_lines"], 0)

    def test_the_prompt_hides_expired_and_superseded_not_the_file(self):
        text = "\n".join([line("Kept"), line("Gone", until="2026-10-02"), "- ~~2026-10-01 · from chat · Old~~ · superseded 2026-10-03",
                          "- 2026-09-01 (until 2026-09-30): legacy gone", "hand text"]) + "\n"
        shown = ctx.visible_lines(text, date(2026, 10, 29))
        self.assertIn("Kept", shown)
        self.assertIn("hand text", shown)
        for hidden in ("Gone", "Old", "legacy gone"):
            self.assertNotIn(hidden, shown)

    def test_protected_facts(self):
        self.assertTrue(ctx.is_protected("She has a peanut allergy"))
        self.assertTrue(ctx.is_protected("takes medication at night"))
        self.assertFalse(ctx.is_protected("Likes jazz"))


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.nb = FakeNotebook()
        ctx.set_notebook(self.nb)
        self.addCleanup(ctx.set_notebook, None)
        ctx.forget_seen()
        bot_profile.remove_owner(OWNER)
        self.addCleanup(bot_profile.remove_owner, OWNER)
        self.bot = self.h.bot("Scout")
        self.bid = self.bot["id"]
        self.sid = self.h.thread(self.bot)
        self.nb.put(self.bid, ctx.INDEX, "# Notes\n" + line("Prefers tea over coffee") + "\n")

    def prompts_with(self, text):
        return [p for p in self.h.prompts if text in p]


class TurnPreparationTests(Base):
    async def test_a_streamed_turn_gets_the_notebook_and_it_is_not_saved_as_the_message(self):
        await self.h.send(self.sid, "hello there [reply:hi]")
        await self.h.idle()
        prompt = self.h.prompts[0]
        self.assertIn("Prefers tea over coffee", prompt)
        self.assertIn("hello there", prompt)
        self.assertLess(prompt.index("Prefers tea"), prompt.index("hello there"), "resources come before the message")
        self.assertIn("UNTRUSTED", prompt, "the notebook is fenced as data")
        user = [m for m in self.h.session(self.sid)["messages"] if m["role"] == "user"][0]
        self.assertEqual(user["content"], "hello there [reply:hi]")
        self.assertNotIn("Prefers tea", user.get("sent") or "")
        self.assertNotIn("Prefers tea", sum(([m["content"]] for m in self.h.session(self.sid)["messages"]), [""])[0])

    async def test_a_second_turn_sees_a_changed_notebook_and_an_unchanged_one_is_not_resent(self):
        await self.h.send(self.sid, "one [reply:a]")
        await self.h.idle()
        await self.h.send(self.sid, "two [reply:b]")
        await self.h.idle()
        self.assertNotIn("Prefers tea", self.h.prompts[1], "a brain that keeps its own history already read it")
        self.nb.put(self.bid, ctx.INDEX, self.nb.text(self.bid, ctx.INDEX) + line("Moved to Lisbon") + "\n")
        await self.h.send(self.sid, "three [reply:c]")
        await self.h.idle()
        self.assertIn("Moved to Lisbon", self.h.prompts[2])

    async def test_a_stateless_model_gets_the_notebook_every_turn(self):
        api = {"id": "claude", "name": "Api", "kind": "api"}
        with patch.object(chat_service, "_resolve_endpoint", return_value=api):
            await self.h.send(self.sid, "one [reply:a]")
            await self.h.idle()
            await self.h.send(self.sid, "two [reply:b]")
            await self.h.idle()
        self.assertEqual(len(self.prompts_with("Prefers tea")), 2)

    async def test_the_non_streamed_path_gets_the_same_context(self):
        reply = await chat_service.send_message(self.sid, "plain turn [reply:plain ok]")
        self.assertEqual(reply, "plain ok")
        self.assertIn("Prefers tea over coffee", self.h.prompts[-1])
        self.assertIn(("begin", self.bid, self.sid), self.nb.calls)
        self.assertEqual(self.nb.calls[-1][0], "end")
        self.assertEqual(self.nb.calls[-1][-1], "done")

    async def test_memory_off_means_no_notebook_no_recall_and_no_capture(self):
        agent_service._agents[self.bid]["memory_enabled"] = False
        agent_service._agents[self.bid]["memory_upkeep"] = True
        await self.h.send(self.sid, "tell me something long enough to matter [reply:ok then]")
        await self.h.idle()
        self.assertNotIn("Prefers tea", self.h.prompts[0])
        self.assertEqual([c for c in self.nb.calls if c[0] == "begin"], [])
        self.assertEqual(capture.pending(self.bid), {})

    async def test_image_parts_survive_the_context(self):
        prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": self.sid}, "see this")
        parts = [{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}]
        self.assertIs(ctx.apply(prepared, parts), parts, "a message of parts is left to the caller untouched")
        self.assertIn("Prefers tea", ctx.apply(prepared, "see this"))

    async def test_background_runs_get_core_context_but_no_recall(self):
        with patch("services.bot_memory_recall.for_turn", side_effect=AssertionError("recall must not run")):
            prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": None}, "anything about tea",
                                   kind="background")
        self.assertIn("Prefers tea over coffee", prepared.context)
        self.assertEqual(prepared.recalled, [])

    async def test_an_old_chat_loses_its_frozen_notes_without_touching_messages(self):
        agent_service.write_memory(self.bid, "# Scout's notes\n\n## Notes\n- 2026-10-01: Frozen legacy note\n")
        session = session_manager.get_session(self.sid)
        legacy = session["agent_prompt"] + "\n\n<agent_notes>\nFrozen legacy note\n</agent_notes>"
        session_manager.set_agent(self.sid, self.bid, legacy)
        await self.h.send(self.sid, "hello [reply:hi]")
        await self.h.idle()
        after = session_manager.get_session(self.sid)
        self.assertNotIn("agent_notes", after["agent_prompt"])
        self.assertEqual([m["content"] for m in after["messages"] if m["role"] == "user"], ["hello [reply:hi]"])
        self.assertEqual(ctx.identity_text(self.bid, self.sid), after["agent_prompt"])

    async def test_the_context_clips_a_large_index_and_says_so(self):
        self.nb.put(self.bid, ctx.INDEX, "".join(line(f"Note number {i}") + "\n" for i in range(250)))
        prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": self.sid}, "x")
        self.assertIn("Note number 199", prepared.context)
        self.assertNotIn("Note number 200", prepared.context)
        self.assertEqual((prepared.capacity["loaded_lines"], prepared.capacity["stored_lines"]), (200, 250))
        self.assertIn("first 200 of 250 lines", prepared.context)

    async def test_expired_notes_never_reach_the_model(self):
        self.nb.put(self.bid, ctx.INDEX, line("Fresh") + "\n" + line("Stale", until="2026-10-02") + "\n")
        prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": self.sid}, "x", now=time.time())
        self.assertIn("Fresh", prepared.context)
        self.assertNotIn("Stale", prepared.context)

    async def test_about_you_is_read_for_the_authenticated_owner_only(self):
        bot_profile.put_about(OWNER, "I am David and I live in Lisbon.", bot_profile.get_about(OWNER)["hash"])
        bot_profile.put_about("someone-else", "SECRET OTHER PERSON", bot_profile.get_about("someone-else")["hash"])
        prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": self.sid}, "x")
        self.assertIn("live in Lisbon", prepared.context)
        self.assertNotIn("SECRET OTHER PERSON", prepared.context)

    async def test_skills_index_marks_the_turn_tainted_and_cached_brains_are_tainted_too(self):
        fake = types.SimpleNamespace(prompt_index=lambda scope, taint=None: (taint.mark("bot skills"), "Skills index text")[1])
        with patch.dict(sys.modules, {"services.bot_skills": fake}):
            prepared = ctx.prepare({"bot_id": self.bid, "owner": OWNER, "session_id": self.sid}, "x")
        self.assertIn("Skills index text", prepared.context)
        self.assertIn("bot skills", prepared.taint)


class CompletionTests(Base):
    async def test_end_turn_runs_after_a_failure_and_after_a_stop(self):
        await self.h.send(self.sid, "break it [fail]")
        await self.h.idle()
        self.assertEqual(self.nb.calls[-1][-1], "failed")
        sid2 = self.h.thread(self.bot)
        await self.h.send(sid2, "work [hold]")
        await self.h.held()
        chat_live.stop(sid2)
        await self.h.idle()
        ends = [c for c in self.nb.calls if c[0] == "end" and c[2] == sid2]
        self.assertEqual([c[-1] for c in ends], ["stopped"])

    async def test_a_finished_turn_is_noted_for_capture_only_when_upkeep_is_on_and_not_trivial(self):
        await self.h.send(self.sid, "My daughter Mira is allergic to peanuts, remember that. [reply:Noted, thank you.]")
        await self.h.idle()
        self.assertEqual(capture.pending(self.bid), {}, "upkeep is off by default")
        agent_service._agents[self.bid]["memory_upkeep"] = True
        await self.h.send(self.sid, "thanks [reply:ok]")
        await self.h.idle()
        self.assertEqual(capture.pending(self.bid), {}, "a trivial exchange costs nothing")
        await self.h.send(self.sid, "I am moving to Lisbon in March and need flights. [reply:Sure.]")
        await self.h.idle()
        pending = capture.pending(self.bid)
        self.assertEqual(list(pending), [self.sid])
        self.assertEqual(len(pending[self.sid]["turns"]), 1)
        self.assertEqual(pending[self.sid]["owner"], OWNER)

    async def test_routine_handoff_and_unattended_threads_are_not_captured(self):
        agent_service._agents[self.bid]["memory_upkeep"] = True
        session_manager.set_thread(self.sid, opened_by="handoff")
        await self.h.send(self.sid, "A long enough message about something important. [reply:fine]")
        await self.h.idle()
        self.assertEqual(capture.pending(self.bid), {})


class SkillObserverTests(unittest.TestCase):
    def test_a_run_counts_once_and_only_for_an_owner_chat(self):
        seen = []
        fake = types.SimpleNamespace(observe_tool_step=lambda scope, thread, steps: seen.append((scope["bot_id"], thread, steps)) or {"due": False})
        h = types.SimpleNamespace()
        bot = agent_service.create("Observer", role="x")
        session = session_manager.create_session("t", owner_user=OWNER)
        session_manager.set_agent(session["id"], bot["id"], "p")
        context = runs.RunContext("chat", session_id=session["id"], agent_id=bot["id"])
        tally = runs.Tally()
        tally.tool_calls = 3
        with patch.dict(sys.modules, {"services.bot_skills": fake}):
            runs.record(context, tally, "finished")
            runs.record(context, tally, "finished")
            task = runs.RunContext("task", session_id=session["id"], agent_id=bot["id"])
            runs.record(task, tally, "finished")
        self.assertEqual(seen, [(bot["id"], session["id"], 3)], "same run id once; a task run is not a chat")
        agent_service.delete(bot["id"])
        session_manager.delete_session(session["id"])
        del h


class SideJobTests(Base):
    async def test_claude_side_jobs_are_isolated_and_tool_free(self):
        options = bot_side_jobs.claude_options("C:/empty", "model-x", "system words")
        self.assertEqual(options.tools, [])
        self.assertEqual(options.mcp_servers, {})
        self.assertEqual(options.allowed_tools, [])
        self.assertEqual(options.setting_sources, [])
        self.assertEqual(options.cwd, "C:/empty")
        self.assertEqual(options.max_turns, 1)
        denied = await options.can_use_tool("Bash", {}, None)
        self.assertEqual(type(denied).__name__, "PermissionResultDeny")

    async def test_api_side_jobs_send_no_tools(self):
        api = {"id": "claude", "name": "Api", "kind": "api", "model": "m"}
        run = AsyncMock(return_value="answer")
        with patch.object(agent_service, "chat_endpoint", return_value="claude"), \
                patch("core.model_endpoints.get_endpoint", return_value=api), \
                patch("core.model_endpoints.resolve_runtime", return_value=("http://x", "m", None, None)), \
                patch("core.providers.openai_compatible.run_turn", run):
            result = await bot_side_jobs.generate(self.bid, "question", job="capture")
        self.assertEqual(result.text, "answer")
        self.assertEqual(run.call_args.kwargs["tools"], [])

    async def test_codex_cannot_run_side_jobs_so_the_helper_does_when_allowed(self):
        codex = {"id": "cx", "name": "Codex", "kind": "codex_cli"}
        helper = {"id": "hp", "name": "Helper", "kind": "local", "model": "tiny"}
        model = ScriptedModel(["fine"]).install()
        self.addCleanup(model.remove)
        with patch.object(agent_service, "chat_endpoint", return_value="cx"), \
                patch("core.model_endpoints.get_endpoint", side_effect=lambda i: codex if i == "cx" else None), \
                patch("core.helpers.helper_endpoint", return_value=helper):
            result = await bot_side_jobs.generate(self.bid, "q", job="dream")
            self.assertTrue(result.helper)
            self.assertEqual(model.requests[0][0], "local")
            self.assertEqual(model.requests[0][3], 180, "dream gets 180 seconds")
            agent_service._agents[self.bid]["helper_model"] = False
            with self.assertRaises(bot_side_jobs.SideJobUnavailable):
                await bot_side_jobs.generate(self.bid, "q", job="capture")
            self.assertFalse(bot_side_jobs.available(self.bid))

    async def test_usage_goes_to_the_run_ledger_and_the_connection_totals(self):
        model = ScriptedModel(["fine"]).install()
        self.addCleanup(model.remove)
        with patch("core.token_usage.record_usage") as record:
            result = await bot_side_jobs.generate(self.bid, "q", job="capture")
        self.assertEqual(model.requests[0][3], 60)
        self.assertEqual(result.usage.total_tokens, 15)
        record.assert_called_once()
        from core import session_manager_store as store
        rows = store.find_runs(agent_id=self.bid)
        self.assertTrue(any(r["id"] == result.run_id and r["surface"] == "detached" and r["outcome"] == "finished" for r in rows))

    async def test_credentials_are_scrubbed_before_a_prompt_leaves(self):
        model = ScriptedModel(["fine"]).install()
        self.addCleanup(model.remove)
        await bot_side_jobs.generate(self.bid, "my password=hunter2secret and sk-abcdefghijklmnopqrstuvwxyz123456", job="capture")
        self.assertNotIn("hunter2secret", model.requests[0][1])

    async def test_failure_is_raised_and_recorded(self):
        model = ScriptedModel([RuntimeError("boom")]).install()
        self.addCleanup(model.remove)
        with self.assertRaises(RuntimeError):
            await bot_side_jobs.generate(self.bid, "q", job="capture")


class TickTests(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        agent_service._agents[self.bid]["memory_upkeep"] = True
        self.addCleanup(lambda: asyncio.get_event_loop().run_until_complete(upkeep.shutdown()) if False else None)

    async def test_the_tick_returns_at_once_and_shutdown_keeps_pending_turns(self):
        gate = asyncio.Event()

        async def slow(prompt):
            await gate.wait()
            return '{"items": []}'
        model = ScriptedModel([slow]).install()
        self.addCleanup(model.remove)
        now = time.time()
        await self.h.send(self.sid, "I am moving to Lisbon in March and need flights. [reply:Sure.]")
        await self.h.idle()
        started = time.monotonic()
        result = await upkeep.tick(now + 1000)
        self.assertLess(time.monotonic() - started, 0.5, "the tick never waits on a model")
        self.assertEqual(result["capture"], [self.bid])
        await asyncio.sleep(0.05)
        self.assertEqual(len(model.requests), 1)
        await upkeep.shutdown()
        self.assertEqual(list(capture.pending(self.bid)), [self.sid], "an interrupted capture is retried after restart")
        gate.set()

    async def test_a_second_tick_does_not_start_a_second_job_for_the_same_bot(self):
        gate = asyncio.Event()

        async def slow(prompt):
            await gate.wait()
            return '{"items": []}'
        model = ScriptedModel([slow]).install()
        self.addCleanup(model.remove)
        await self.h.send(self.sid, "I am moving to Lisbon in March and need flights. [reply:Sure.]")
        await self.h.idle()
        first = await upkeep.tick(time.time() + 1000)
        second = await upkeep.tick(time.time() + 1001)
        self.assertEqual((first["capture"], second["capture"]), ([self.bid], []))
        gate.set()
        await upkeep.settle()


class ReviewAndRemovalTests(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        agent_service._agents[self.bid]["memory_upkeep"] = True

    async def test_a_due_skill_review_runs_on_the_side_job_engine_without_tools(self):
        await self.h.send(self.sid, "Please do some real work for me today. [reply:Done.]")
        await self.h.idle()
        seen = []

        def run_review(scope, thread_id, *, runner, transcript, thread_approval=None):
            seen.append((scope["bot_id"], thread_id, transcript, thread_approval, runner("review this")))
            return {"state": "done"}
        fake = types.SimpleNamespace(due_threads=lambda scope, now=None: [self.sid], run_review=run_review)
        model = ScriptedModel(["a review answer"]).install()
        self.addCleanup(model.remove)
        with patch.dict(sys.modules, {"services.bot_skill_review": fake}):
            started = await upkeep.tick(time.time())
            self.assertEqual(started["review"], [self.bid])
            await upkeep.settle()
        self.assertEqual(len(seen), 1)
        bot_id, thread_id, transcript, approval, answer = seen[0]
        self.assertEqual((bot_id, thread_id, answer), (self.bid, self.sid, "a review answer"))
        self.assertIn("real work for me", transcript)
        self.assertEqual(model.requests[0][3], 180, "a review gets 180 seconds")

    async def test_removing_a_bot_clears_its_pending_work_and_recall_but_not_the_person(self):
        await self.h.send(self.sid, "I am moving to Lisbon in March and need flights. [reply:Sure.]")
        await self.h.idle()
        bot_profile.add_learned(OWNER, "Likes jazz", "Scout")
        from services import bot_memory_recall
        bot_memory_recall.search({"bot_id": self.bid, "owner": OWNER}, q="lisbon")
        self.assertNotEqual(capture.pending(self.bid), {})
        ctx.remove_bot(self.bid)
        self.assertEqual(capture.pending(self.bid), {})
        self.assertEqual(upkeep.bot_state(self.bid)["last_tidy_day"], None)
        self.assertEqual(bot_memory_recall.search({"bot_id": self.bid, "owner": OWNER}, q="lisbon", refresh=False)["count"], 0)
        self.assertEqual([r["text"] for r in bot_profile.learned(OWNER)], ["Likes jazz"], "About you belongs to the person")


class ScopeTests(unittest.TestCase):
    def test_owner_comes_from_the_session(self):
        bot = agent_service.create("Scoped", role="x")
        session = session_manager.create_session("t", owner_user="alice")
        session_manager.set_agent(session["id"], bot["id"], "p")
        scope = ctx.scope_for_session(session["id"])
        self.assertEqual((scope["bot_id"], scope["owner"]), (bot["id"], "alice"))
        plain = session_manager.create_session("plain")
        self.assertIsNone(ctx.scope_for_session(plain["id"]))
        agent_service.delete(bot["id"])
        for s in (session, plain):
            session_manager.delete_session(s["id"])

    def test_invalidate_marks_every_session_for_reset_once(self):
        bot = agent_service.create("Reset", role="x")
        session = session_manager.create_session("t", owner_user="alice")
        session_manager.set_agent(session["id"], bot["id"], "p")
        ctx._SEEN[session["id"]] = "digest"
        self.assertEqual(ctx.invalidate_bot(bot["id"]), [session["id"]])
        self.assertNotIn(session["id"], ctx._SEEN)
        self.assertTrue(ctx.take_reset(session["id"]))
        self.assertFalse(ctx.take_reset(session["id"]))
        agent_service.delete(bot["id"])
        session_manager.delete_session(session["id"])


if __name__ == "__main__":
    unittest.main()
