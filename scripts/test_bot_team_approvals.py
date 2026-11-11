"""Bot team approvals (2026-11-11): a team's own work goes ahead, everything that leaves Kairos still asks, and a
teammate's delegated run carries its real owner and asks the person instead of failing with nobody to ask.

Drives core/permissions.py decide() and core/bot_policy.py with real bots, teams and sessions; only the person's
window is a stand-in. Run: python scripts/test_bot_team_approvals.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bots_approvals_harness import (ApprovalCase, asyncio, bot_policy, make_bot, make_thread, permissions,  # noqa: E402
                                    agent_service, session_manager, set_mode, patch, tool_registry, unittest)

from core import bot_content_studio_tools  # noqa: E402,F401  (registers the content_studio_* tools)
from services import bot_attention, bot_departments  # noqa: E402
from services.content_studio import team as studio_team  # noqa: E402


class TeamCase(ApprovalCase):
    def setUp(self):
        super().setUp()
        self.user = bot_attention.legacy_owner()
        self.roles = {}
        patcher = patch.object(studio_team, "role_of", lambda store, bot_id: self.roles.get(bot_id))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.teams = []

    def tearDown(self):
        for team in self.teams:
            try:
                bot_departments.delete(team, self.user)
            except Exception:
                pass
        super().tearDown()

    def team(self, name, bots, **meta):
        made = bot_departments.create(f"{name} {time.time_ns()}", bots, self.user)
        self.teams.append(made["id"])
        if meta:
            bot_departments.set_meta(made["id"], self.user, **meta)
        return made

    def outcome(self, bot, tool, args=None, **kw):
        return bot_policy.authorize_operation(bot_id=bot, tool=tool, arguments=args or {}, **kw)


class TeamInternal(TeamCase):
    async def test_content_team_record_keeping_goes_ahead_at_ask_and_is_logged(self):
        bot = make_bot("Researcher")
        set_mode(bot, "ask")
        self.roles[bot] = "researcher"
        sid = make_thread(bot)
        for tool in ("content_studio_add_topic", "content_studio_save_format", "content_studio_propose_port",
                     "content_studio_watch", "content_studio_submit_post", "content_studio_send_report"):
            decision = await self.decide(bot, sid, tool, {"niche_id": 1, "title": "x", "source": "y"}, timeout=1)
            self.assertEqual(decision.behavior, "allow", tool)
        rows = bot_policy.decisions(None, bot_id=bot)
        self.assertTrue(rows and all(r["source"] == "team" for r in rows))

    async def test_tainted_turns_still_keep_records_without_a_prompt(self):
        bot = make_bot("Producer")
        set_mode(bot, "ask")
        self.roles[bot] = "producer"
        sid = make_thread(bot)
        decision = await self.decide(bot, sid, "content_studio_watch", {"notify": True}, force_prompt=True, timeout=1)
        self.assertEqual(decision.behavior, "allow")

    async def test_posting_preparing_and_platform_reads_still_ask(self):
        bot = make_bot("Publisher")
        set_mode(bot, "ask")
        self.roles[bot] = "publisher"
        sid = make_thread(bot)
        for tool in sorted(bot_policy.CONTENT_STUDIO_ASKS):
            outcome = self.outcome(bot, tool, {"post_id": 1}, surface=f"chat:{sid}")
            self.assertEqual(outcome.action, "ask", tool)
            denied = await self.decide(bot, sid, tool, {"post_id": 1}, timeout=1)
            self.assertEqual(denied.behavior, "deny", tool)
            self.assertIn("cannot ask", denied.reason)

    async def test_lookalikes_and_other_routes_ask(self):
        bot = make_bot("Lookalike")
        set_mode(bot, "ask")
        self.roles[bot] = "researcher"
        sid = make_thread(bot)
        for tool in ("content_studio_add_topics", "Content_Studio_Add_Topic", "content_studio_add_topic_and_post",
                     "mcp__other__content_studio_add_topic", "xcontent_studio_add_topic"):
            self.assertEqual(self.outcome(bot, tool, {}, surface=f"chat:{sid}").action, "ask", tool)
        through_mcp = self.outcome(bot, "content_studio_add_topic", {}, surface=f"chat:{sid}",
                                   mcp=("someone-elses-server", "content_studio_add_topic"))
        self.assertEqual(through_mcp.action, "ask")

    async def test_a_bot_off_the_team_asks(self):
        bot = make_bot("Outsider")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        self.assertEqual(self.outcome(bot, "content_studio_add_topic", {}, surface=f"chat:{sid}").action, "ask")

    def test_every_content_studio_tool_is_a_conscious_choice(self):
        names = {n for n in tool_registry._REGISTRY if n.startswith("content_studio_")}
        writes = {n for n in names if tool_registry._REGISTRY[n].effect != "read"}
        self.assertFalse(writes - bot_policy.CONTENT_STUDIO_INTERNAL_TOOLS - bot_policy.CONTENT_STUDIO_ASKS,
                         "a new content_studio_* tool must be added to CONTENT_STUDIO_INTERNAL_TOOLS or CONTENT_STUDIO_ASKS")
        self.assertFalse(bot_policy.CONTENT_STUDIO_INTERNAL_TOOLS & bot_policy.CONTENT_STUDIO_ASKS)
        self.assertTrue(bot_policy.CONTENT_STUDIO_INTERNAL_TOOLS <= names)

    async def test_a_template_can_declare_internal_tools_and_dangerous_ones_are_refused(self):
        for name in ("send_email", "Bash", "Write", "post_to_room", "coordinate_bots", "content_studio_publish_youtube",
                     "message_me", "create_bot", "no_such_tool", "../x", 7):
            self.assertIsNotNone(bot_policy.internal_tool_problem(name), name)
        with self.assertRaises(ValueError):
            bot_departments.clean_internal_tools(["agent_remember", "send_email"])
        allowed = "agent_remember"
        self.assertIsNone(bot_policy.internal_tool_problem(allowed))
        a, outsider = make_bot("Declared"), make_bot("NotDeclared")
        set_mode(a, "ask")
        set_mode(outsider, "ask")
        self.team("Notes", [a], internal_tools=[allowed])
        self.assertEqual(self.outcome(a, allowed, {"section": "Notes", "text": "x"}, surface=f"chat:{make_thread(a)}").source, "team")
        self.assertEqual(self.outcome(outsider, allowed, {"section": "Notes", "text": "x"},
                                      surface=f"chat:{make_thread(outsider)}").action, "ask")

    async def test_asking_the_person_needs_no_approval(self):
        bot = make_bot("Asker")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        decision = await self.decide(bot, sid, "agent_ask", {"question": "Which niche?"}, timeout=1)
        self.assertEqual(decision.behavior, "allow")


class HandsOffAndPause(TeamCase):
    async def test_pause_team_holds_its_bots_to_reading(self):
        bot = make_bot("Held")
        set_mode(bot, "full")
        crew = self.team("Held team", [bot])
        sid = make_thread(bot)
        bot_departments.set_flags(crew["id"], self.user, paused=True)
        held = self.outcome(bot, "Write", {"file_path": "x.txt"}, surface=f"chat:{sid}")
        self.assertEqual((held.action, held.source), ("deny", "team-paused"))
        self.assertEqual(self.outcome(bot, "Read", {"file_path": "x.txt"}, surface=f"chat:{sid}").action, "allow")
        self.assertEqual(self.outcome(bot, "agent_ask", {"question": "?"}, surface=f"chat:{sid}").action, "allow")
        bot_departments.set_flags(crew["id"], self.user, paused=False)
        self.assertEqual(self.outcome(bot, "Write", {"file_path": "x.txt"}, surface=f"chat:{sid}").action, "allow")

    async def test_hands_off_lets_only_the_publisher_post_and_only_while_on(self):
        from services.content_studio import studio
        pub, writer = make_bot("Pub"), make_bot("Writer")
        for bot in (pub, writer):
            set_mode(bot, "ask")
        self.roles[pub], self.roles[writer] = "publisher", "script_writer"
        sid = make_thread(pub)
        self.assertEqual(self.outcome(pub, "content_studio_publish_youtube", {"post_id": 1}, surface=f"chat:{sid}").action, "ask")
        with patch.object(studio, "settings", return_value={"hands_off": True, "team_paused": False}):
            self.assertEqual(self.outcome(pub, "content_studio_publish_youtube", {"post_id": 1}, surface=f"chat:{sid}").source, "team")
            self.assertEqual(self.outcome(writer, "content_studio_publish_youtube", {"post_id": 1},
                                          surface=f"chat:{make_thread(writer)}").action, "ask")
            self.assertEqual(self.outcome(pub, "content_studio_prepare_post", {"post_id": 1}, surface=f"chat:{sid}").action, "ask")
        with patch.object(studio, "settings", return_value={"hands_off": True, "team_paused": True}):
            self.assertEqual(self.outcome(pub, "content_studio_publish_youtube", {"post_id": 1}, surface=f"chat:{sid}").action, "ask")


class Handoffs(TeamCase):
    async def test_teammates_hand_off_without_review_and_outsiders_still_ask(self):
        producer, researcher, stranger = make_bot("P"), make_bot("R"), make_bot("S")
        for bot in (producer, researcher, stranger):
            set_mode(bot, "ask")
        self.team("Crew", [producer, researcher])
        sid = make_thread(producer)
        inside = self.outcome(producer, "coordinate_bots", {"bot_ids": [researcher], "message": "Find topics"},
                              surface=f"chat:{sid}", force_prompt=True, explicit_review=True)
        self.assertEqual((inside.action, inside.source), ("allow", "team"))
        inner = self.outcome(producer, "coordinate_bots", {"bot_id": researcher, "kind": "peer_approval"},
                             surface=f"agent:{producer}")
        self.assertEqual(inner.action, "allow")
        outside = self.outcome(producer, "coordinate_bots", {"bot_ids": [stranger], "message": "Hi"},
                               surface=f"chat:{sid}", force_prompt=True, explicit_review=True)
        self.assertEqual((outside.action, outside.source), ("ask", "explicit-review"))
        mixed = self.outcome(producer, "coordinate_bots", {"bot_ids": [researcher, stranger], "message": "Hi"},
                             surface=f"chat:{sid}")
        self.assertEqual(mixed.action, "ask")
        named = self.outcome(producer, "agent_assign", {"agent": agent_service.get(researcher)["name"], "work": "x"},
                             surface=f"chat:{sid}")
        self.assertEqual(named.action, "allow")

    async def test_the_delegation_tool_skips_the_peer_prompt_inside_the_team(self):
        producer, researcher = make_bot("P2"), make_bot("R2")
        set_mode(producer, "ask")
        set_mode(researcher, "ask")
        self.team("Crew2", [producer, researcher])
        sid = make_thread(producer)
        from core.turn_taint import TurnTaint
        taint = TurnTaint()
        taint.mark("content studio pipeline")
        ctx = tool_registry.ToolContext(session_id=sid, agent_id=producer, turn_taint=taint, assignment_run_id="turn-1")
        reply = await tool_registry.call("coordinate_bots", {"bot_ids": [researcher], "message": "Find two topics"},
                                         ctx, tool_registry.CLAUDE)
        self.assertIn("Assigned", reply)
        self.assertFalse(permissions._pending)


class Delegated(TeamCase):
    def work_thread(self, bot, owner="david-darr"):
        session = session_manager.create_session("work", owner_user=owner)
        session_manager.set_agent(session["id"], bot, "")
        return session["id"]

    async def test_a_delegated_run_carries_the_real_owner_and_its_thread(self):
        bot = make_bot("Delegated")
        set_mode(bot, "ask")
        work = self.work_thread(bot)
        with bot_policy.routing_asks(f"agent:{bot}", {"bot_id": bot, "thread_id": work, "owner": "david-darr"}):
            outcome = self.outcome(bot, "Write", {"file_path": "x.txt"}, surface=f"agent:{bot}")
        self.assertEqual((outcome.owner, outcome.thread_id, outcome.action), ("david-darr", work, "ask"))
        self.assertNotEqual(outcome.owner, "local")
        without = self.outcome(bot, "Write", {"file_path": "x.txt"}, surface=f"agent:{bot}")
        self.assertIsNone(without.route)

    async def test_nobody_to_ask_now_routes_a_card_to_the_person(self):
        cards = self.fake_cards()
        bot = make_bot("Routed")
        set_mode(bot, "ask")
        work = self.work_thread(bot)
        with bot_policy.routing_asks(f"agent:{bot}", {"bot_id": bot, "thread_id": work, "owner": "david-darr"}):
            task = asyncio.create_task(permissions.decide(surface=f"agent:{bot}", tool="Write", arguments={"file_path": "x.txt"},
                                                          agent_id=bot, is_admin=True))
            for _ in range(100):
                if permissions._pending:
                    break
                await asyncio.sleep(0.02)
            request = next(iter(permissions._pending.values()))
            self.assertEqual(request.surface, f"chat:{work}")
            self.assertEqual(cards.opened[0][1]["thread_id"], work)
            self.assertEqual(cards.opened[0][1]["owner"], "david-darr")
            self.assertIn({"surface": f"chat:{work}"}["surface"], [r.surface for r in permissions._pending.values()])
            permissions.answer(request.id, "once", "david-darr")
            self.assertEqual((await task).behavior, "allow")
        rows = bot_policy.decisions("david-darr", bot_id=bot)
        self.assertEqual(rows[0]["source"], "asked")

    async def test_a_step_that_truly_cannot_ask_says_why_and_how_to_fix_it_once(self):
        bot = make_bot("Stranded")
        set_mode(bot, "ask")
        before = len(agent_service.inbox(bot, status=None))
        first = await permissions.decide(surface=f"agent:{bot}", tool="Write", arguments={"file_path": "x"}, agent_id=bot,
                                         is_admin=True)
        second = await permissions.decide(surface=f"agent:{bot}", tool="Write", arguments={"file_path": "y"}, agent_id=bot,
                                          is_admin=True)
        self.assertEqual(first.behavior, "deny")
        self.assertIn("cannot ask", first.reason)
        self.assertIn("Fix:", first.reason)
        self.assertIn("Fix:", second.reason)
        reports = [i for i in agent_service.inbox(bot, status=None) if i["kind"] == "report"]
        self.assertEqual(len(reports) - before, 1)
        self.assertIn("could not ask you", reports[0]["title"])

    async def test_the_owner_comes_from_the_delegating_thread_for_a_card(self):
        from core import task_scope
        owner_thread = session_manager.create_session("source", owner_user="david-darr")["id"]
        card = {"id": "c1", "agent_id": "x", "requester": {"kind": "bot", "session_id": owner_thread}}
        with patch("core.auth.auth_enabled", return_value=True):
            self.assertEqual(task_scope.owner_for(card), "david-darr")


class Prompts(TeamCase):
    async def test_allow_for_this_team_covers_teammates_and_nobody_else(self):
        a, b, outsider = make_bot("A"), make_bot("B"), make_bot("C")
        for bot in (a, b, outsider):
            set_mode(bot, "ask")
        crew = self.team("Desk", [a, b])
        sid = make_thread(a)
        task, payload = await self.asked(f"chat:{sid}", tool="agent_remember", arguments={"section": "Notes", "text": "x"},
                                         agent_id=a, is_admin=True)
        team_choice = next(c for c in payload["choices"] if c["id"] == "team")
        self.assertIn(crew["name"], team_choice["label"])
        self.assertTrue(permissions.answer(payload["id"], "team", "local"))
        self.assertEqual((await task).behavior, "allow")
        self.assertEqual((await self.decide(b, make_thread(b), "agent_remember", {"section": "Notes", "text": "y"},
                                            timeout=1)).behavior, "allow")
        self.assertEqual((await self.decide(outsider, make_thread(outsider), "agent_remember", {"section": "Notes", "text": "y"},
                                            timeout=1)).behavior, "deny")
        self.assertNotIn("agent_remember", permissions.standing_grants())
        ordinary = session_manager.create_session()["id"]
        self.assertIsNone(permissions.stored_decision(f"chat:{ordinary}", "agent_remember", None))

    async def test_sends_never_offer_allow_for_the_team(self):
        a, b = make_bot("Sender"), make_bot("Mate")
        set_mode(a, "ask")
        self.team("Senders", [a, b])
        sid = make_thread(a)
        task, payload = await self.asked(f"chat:{sid}", tool="send_email", arguments={"to": "x@example.com"},
                                         agent_id=a, is_admin=True)
        self.assertNotIn("team", [c["id"] for c in payload["choices"]])
        permissions.answer(payload["id"], "reject", "local")
        await task

    async def test_simultaneous_requests_from_one_run_share_one_card(self):
        bot = make_bot("Batch")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        queue = permissions.open_channel(f"chat:{sid}")
        args = {"file_path": "notes/a.txt"}
        first = asyncio.create_task(permissions.decide(surface=f"chat:{sid}", tool="Write", arguments=args, agent_id=bot,
                                                       is_admin=True))
        payload = await asyncio.wait_for(queue.get(), timeout=5)
        second = asyncio.create_task(permissions.decide(surface=f"chat:{sid}", tool="Write", arguments=args, agent_id=bot,
                                                        is_admin=True))
        await asyncio.sleep(0.1)
        self.assertTrue(queue.empty(), "the second request opened its own card")
        permissions.answer(payload["id"], "once", "local")
        self.assertEqual([(await first).behavior, (await second).behavior], ["allow", "allow"])


class ReviewFindings(TeamCase):
    """The independent review of 2026-11-11, kept fixed."""

    async def test_batching_never_shares_an_approval_between_different_calls(self):
        bot = make_bot("NoShare")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        queue = permissions.open_channel(f"chat:{sid}")
        cases = ((("Bash", {"command": "rm -rf build"}), ("Bash", {"command": "rm -rf /important"})),
                 (("Write", {"file_path": "notes/a.txt"}), ("Write", {"file_path": "notes/b.txt"})),
                 (("Bash", {"command": "ls"}), ("Bash", {"command": "ls"})),
                 (("send_email", {"to": "a@example.com"}), ("send_email", {"to": "a@example.com"})))
        for first_call, second_call in cases:
            first = asyncio.create_task(permissions.decide(surface=f"chat:{sid}", tool=first_call[0], arguments=first_call[1],
                                                           agent_id=bot, is_admin=True))
            one = await asyncio.wait_for(queue.get(), timeout=5)
            second = asyncio.create_task(permissions.decide(surface=f"chat:{sid}", tool=second_call[0], arguments=second_call[1],
                                                            agent_id=bot, is_admin=True))
            two = await asyncio.wait_for(queue.get(), timeout=5)
            self.assertNotEqual(one["id"], two["id"], first_call)
            permissions.answer(one["id"], "once", "local")
            permissions.answer(two["id"], "reject", "local")
            self.assertEqual([(await first).behavior, (await second).behavior], ["allow", "deny"], first_call)
            while not queue.empty():
                queue.get_nowait()

    async def test_a_multi_action_tool_is_declared_by_its_safe_actions_and_checked_per_call(self):
        self.assertIn("delete", bot_policy.internal_tool_problem("design_boards"))
        self.assertIsNone(bot_policy.internal_tool_problem("design_boards.rename"))
        self.assertIsNotNone(bot_policy.internal_tool_problem("design_boards.delete"))
        self.assertIsNotNone(bot_policy.internal_tool_problem("design_boards.nonsense"))
        with self.assertRaises(ValueError):
            bot_departments.clean_internal_tools(["design_boards"])
        bot = make_bot("Boards")
        set_mode(bot, "ask")
        self.team("Design desk", [bot], internal_tools=["design_boards.rename"])
        sid = make_thread(bot)
        self.assertEqual(self.outcome(bot, "design_boards", {"action": "rename", "name": "x"}, surface=f"chat:{sid}").source, "team")
        for action in ("delete", "move", "delete_note"):
            self.assertEqual(self.outcome(bot, "design_boards", {"action": action}, surface=f"chat:{sid}").action, "ask", action)

    async def test_a_declared_tool_whose_call_turns_out_unsafe_still_asks(self):
        bot = make_bot("Notes2")
        set_mode(bot, "ask")
        crew = self.team("Notes2", [bot])
        # A record written before the per-operation check (or by hand) holding a whole multi-action tool.
        data = bot_departments._read()
        next(d for d in data["departments"] if d["id"] == crew["id"])["internal_tools"] = ["design_boards", "manage_routine"]
        bot_departments.save(bot_departments.registry_path(), data)
        sid = make_thread(bot)
        self.assertEqual(self.outcome(bot, "design_boards", {"action": "delete"}, surface=f"chat:{sid}").action, "ask")
        self.assertEqual(self.outcome(bot, "manage_routine", {"action": "delete"}, surface=f"chat:{sid}").action, "ask")

    async def test_allow_for_the_team_covers_only_the_approved_operation(self):
        a, b = make_bot("Renamer"), make_bot("Mate2")
        for bot in (a, b):
            set_mode(bot, "ask")
        self.team("Boards team", [a, b])
        sid = make_thread(a)
        task, payload = await self.asked(f"chat:{sid}", tool="design_boards", arguments={"action": "rename", "name": "x"},
                                         agent_id=a, is_admin=True)
        self.assertTrue(permissions.answer(payload["id"], "team", "local"))
        self.assertEqual((await task).behavior, "allow")
        mate = make_thread(b)
        self.assertEqual((await self.decide(b, mate, "design_boards", {"action": "rename", "name": "y"}, timeout=1)).behavior, "allow")
        for action in ("delete", "move"):
            self.assertEqual((await self.decide(b, mate, "design_boards", {"action": action}, timeout=1)).behavior, "deny", action)
        task, payload = await self.asked(f"chat:{sid}", tool="design_boards", arguments={"action": "delete"}, agent_id=a, is_admin=True)
        self.assertNotIn("team", [c["id"] for c in payload["choices"]])
        permissions.answer(payload["id"], "reject", "local")
        await task
        # An old team grant with no operation kind covers nothing.
        data = permissions._load()
        data["rules"].append({"id": "old", "tool": "manage_routine", "content": None, "behavior": "allow", "scope": "forever",
                              "team_id": bot_departments.team_of(a)["id"]})
        permissions._save(data)
        self.assertIsNone(permissions.stored_decision(f"chat:{mate}", "manage_routine", None, True, b, {"action": "delete"}))


class SecondReview(TeamCase):
    """Codex's re-review of 2026-11-11, kept fixed."""

    async def test_an_outer_approval_covers_only_its_own_handler_once(self):
        bot = make_bot("Outer")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        ready, checked = asyncio.Event(), {}

        async def parallel_native_call():   # started before the approval, like a native Bash beside a long run_code
            await ready.wait()
            checked["bash"] = bot_policy.authorize_operation(bot_id=bot, tool="Bash", arguments={"command": "rm -rf /x"},
                                                             surface=f"chat:{sid}")
        other = asyncio.create_task(parallel_native_call())
        await asyncio.sleep(0)
        outer = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"},
                                               surface=f"chat:{sid}", outer=True)
        bot_policy.mark_inflight(outer, source="person")   # the person allowed run_code
        ready.set()
        await other
        self.assertEqual(checked["bash"].action, "ask", "a parallel call used the run_code approval")
        inner = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"},
                                               surface=f"chat:{sid}")
        self.assertEqual((inner.action, inner.source), ("allow", "outer"))
        again = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"},
                                               surface=f"chat:{sid}")
        self.assertEqual(again.action, "ask", "an outer approval was used twice")
        bot_policy.mark_inflight(outer, source="person")
        bot_policy.clear_inflight(bot)   # the call finished
        self.assertEqual(bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"},
                                                        surface=f"chat:{sid}").action, "ask")

    async def test_pausing_a_team_cancels_what_it_waits_on_and_voids_late_answers(self):
        bot = make_bot("Waiting")
        set_mode(bot, "ask")
        crew = self.team("Pausable", [bot])
        sid = make_thread(bot)
        task, payload = await self.asked(f"chat:{sid}", tool="Write", arguments={"file_path": "a.txt"}, agent_id=bot, is_admin=True)
        bot_departments.set_flags(crew["id"], self.user, paused=True)
        decision = await asyncio.wait_for(task, timeout=5)
        self.assertEqual(decision.behavior, "deny")
        self.assertIn("paused", decision.reason)
        outcome = self.outcome(bot, "Write", {"file_path": "a.txt"}, surface=f"chat:{sid}")
        self.assertIn("paused", bot_policy.live_denial(bot, sid, outcome))
        read = self.outcome(bot, "Read", {"file_path": "a.txt"}, surface=f"chat:{sid}")
        self.assertIsNone(bot_policy.live_denial(bot, sid, read))
        bot_departments.set_flags(crew["id"], self.user, paused=False)
        self.assertIsNone(bot_policy.live_denial(bot, sid, outcome))


class ThirdReview(TeamCase):
    """Codex's third review of 2026-11-11, kept fixed."""

    async def test_a_task_started_after_the_approval_cannot_use_it(self):
        bot = make_bot("Child")
        set_mode(bot, "ask")
        sid = make_thread(bot)
        outer = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"},
                                               surface=f"chat:{sid}", outer=True)
        bot_policy.mark_inflight(outer, source="person")

        async def child(tool, args):   # inherits the context, but is another task
            return bot_policy.authorize_operation(bot_id=bot, tool=tool, arguments=args, surface=f"chat:{sid}")
        for tool, args in (("Bash", {"command": "rm -rf /x"}), ("run_code", {"code": "print(1)"})):
            self.assertEqual((await asyncio.create_task(child(tool, args))).action, "ask", tool)
        other = bot_policy.authorize_operation(bot_id=bot, tool="Bash", arguments={"command": "ls"}, surface=f"chat:{sid}")
        self.assertEqual(other.action, "ask", "a different tool with other arguments, in the same task")
        own = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(1)"}, surface=f"chat:{sid}")
        self.assertEqual((own.action, own.source), ("allow", "outer"))

    async def test_waiting_work_rechecks_pause_and_the_bot_before_it_starts(self):
        from unittest.mock import AsyncMock
        import httpx
        from core import google_workspace as google, sandbox
        bot = make_bot("Launcher")
        set_mode(bot, "full")
        crew = self.team("Launchers", [bot])
        sid = make_thread(bot)
        outer = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "x"}, surface=f"chat:{sid}", outer=True)
        bot_policy.mark_inflight(outer)
        self.assertIsNone(bot_policy.still_allowed())
        bot_departments.set_flags(crew["id"], self.user, paused=True)   # paused while the call waited
        self.assertIn("paused", bot_policy.still_allowed())
        launched = AsyncMock(side_effect=AssertionError("launched after the pause"))
        with patch.object(sandbox, "available", AsyncMock(return_value=(True, ""))), \
                patch.object(sandbox.asyncio, "create_subprocess_exec", launched):
            with self.assertRaises(sandbox.SandboxUnavailable):
                await sandbox.run("echo hi")
        sent = AsyncMock(side_effect=AssertionError("sent after the pause"))
        with patch.object(google, "_token", AsyncMock(return_value="t")), patch.object(httpx.AsyncClient, "request", sent):
            for method, path in (("POST", "/users/me/messages/send"), ("DELETE", "/files/abc")):
                with self.assertRaises(google.GoogleError):
                    await google.request("gmail" if method == "POST" else "drive", method, path, body={}, account="a")
        bot_departments.set_flags(crew["id"], self.user, paused=False)
        agent_service.delete(bot)
        self.assertIn("no longer exists", bot_policy.still_allowed())


class FourthReview(TeamCase):
    """Codex's fourth review of 2026-11-11, kept fixed."""

    async def test_the_inner_check_needs_the_same_tool_and_the_same_arguments(self):
        bot = make_bot("Inner")
        set_mode(bot, "ask")
        sid = make_thread(bot)

        def check(tool, args):
            return bot_policy.authorize_operation(bot_id=bot, tool=tool, arguments=args, surface=f"chat:{sid}")

        def approve(tool, args):
            outer = bot_policy.authorize_operation(bot_id=bot, tool=tool, arguments=args, surface=f"chat:{sid}", outer=True)
            bot_policy.mark_inflight(outer, source="person")
        drive = {"action": "delete", "file_id": "f1"}
        approve("google_drive", drive)
        self.assertEqual(check("google_drive_delete", {"action": "delete", "file_id": "OTHER"}).action, "ask")
        self.assertEqual(check("Bash", drive).action, "ask")
        self.assertEqual(check("google_drive_delete", drive).source, "outer")   # google_chat_tools' own per-action check
        code = {"code": "print(1)"}
        approve("run_code", code)
        self.assertEqual(check("run_code_internet", {"command": "print(1)"}).action, "ask")  # internet asks on its own
        approve("run_code", code)
        self.assertEqual(check("run_code", code).source, "outer")

    async def test_unknown_spend_under_a_cap_holds_sends_deletions_and_commands_only(self):
        from services import bot_spend
        bot = make_bot("Spender")
        set_mode(bot, "full")
        sid = make_thread(bot)
        bot_spend._held.clear()
        bot_policy._spend_alerted.clear()
        before = len([i for i in agent_service.inbox(bot, status=None) if i["kind"] == "report"])
        with patch.object(bot_spend, "budget", return_value={"spend_unknown": True}):
            for tool, args in (("Bash", {"command": "ls"}), ("send_email", {"to": "a@example.com"}),
                               ("google_drive", {"action": "delete", "file_id": "f"})):
                held = self.outcome(bot, tool, args, surface=f"chat:{sid}")
                self.assertEqual((held.action, held.source), ("deny", "spend-unknown"), tool)
            for tool, args in (("Read", {"file_path": "a"}), ("Write", {"file_path": "a"}), ("message_me", {"message": "hi"})):
                self.assertEqual(self.outcome(bot, tool, args, surface=f"chat:{sid}").action, "allow", tool)
        reports = [i for i in agent_service.inbox(bot, status=None) if i["kind"] == "report"]
        self.assertEqual(len(reports) - before, 1, "one alert, not one per step")
        bot_spend._held.clear()
        with patch.object(bot_spend, "budget", return_value={"spend_unknown": False}):
            self.assertEqual(self.outcome(bot, "Bash", {"command": "ls"}, surface=f"chat:{sid}").action, "allow")
        bot_spend._held.clear()
        from services import bot_usage
        rows = [{"cost_usd": None}, {"cost_usd": 1.0}]
        with patch.object(bot_usage, "settings", return_value={"budget": {"monthly_usd": 50, "warn_percent": 80}}), \
                patch.object(bot_usage, "rows", return_value=rows):
            self.assertTrue(bot_spend.budget()["spend_unknown"])
        with patch.object(bot_usage, "settings", return_value={"budget": {"monthly_usd": None, "warn_percent": 80}}), \
                patch.object(bot_usage, "rows", return_value=rows):
            self.assertFalse(bot_spend.budget()["spend_unknown"], "no cap set: unchanged")

    async def test_the_pause_recheck_holds_without_an_outer_approval(self):
        bot = make_bot("Saved")
        crew = self.team("Saved rules", [bot])
        self.assertIsNone(bot_policy.still_allowed())
        with bot_policy.bot_call(bot):
            self.assertIsNone(bot_policy.still_allowed())
            bot_departments.set_flags(crew["id"], self.user, paused=True)
            self.assertIn("paused", bot_policy.still_allowed())
        bot_departments.set_flags(crew["id"], self.user, paused=False)

    def test_a_google_batch_is_judged_by_what_it_contains(self):
        for requests in ([{"deleteSheet": {"sheetId": 1}}], [{"addSheet": {}}, {"deleteRange": {}}], ["junk"],
                         [{"deleteItem": {"location": {"index": 0}}}]):
            op = bot_policy.classify("google_sheets", {"action": "batch", "requests": requests})
            self.assertEqual(op.kind, bot_policy.DESTRUCTIVE, requests)
        self.assertEqual(bot_policy.classify("google_sheets", {"action": "batch", "requests": [{"addSheet": {}}]}).kind,
                         bot_policy.EDIT)


class FifthReview(TeamCase):
    """Codex's fifth review of 2026-11-11: the last check before an outward action reads everything fresh."""

    def test_the_last_check_reads_spend_fresh_for_risky_steps_only(self):
        from services import bot_spend
        bot = make_bot("Fresh")
        bot_spend._held.clear()
        with patch.object(bot_spend, "budget", return_value={"spend_unknown": False}):
            self.assertIsNone(bot_spend.spend_hold())   # the admission cache now says "no hold"
        with patch.object(bot_spend, "budget", return_value={"spend_unknown": True}):
            self.assertIsNone(bot_spend.spend_hold(), "the admission fast path may use its cache")
            for kind in (bot_policy.OUTBOUND, bot_policy.DESTRUCTIVE, bot_policy.EXECUTE, bot_policy.OPAQUE):
                self.assertIn("not fully known", bot_policy.still_allowed(kind, bot_id=bot), kind)
            self.assertIsNone(bot_policy.still_allowed(bot_policy.EDIT, bot_id=bot))
            self.assertIsNone(bot_policy.still_allowed(None, bot_id=bot))
        bot_spend._held.clear()

    def test_smtp_checks_right_before_sendmail_and_a_refused_send_is_dropped_and_reported(self):
        from unittest.mock import MagicMock
        from core import email_send
        from services import email_service as email_module
        bot = make_bot("Mailer")
        crew = self.team("Mailers", [bot])
        smtp = MagicMock()
        service = email_module.email_service
        with patch.object(service, "get_account", return_value={"email": "me@example.com", "password_encrypted": "x",
                                                                 "smtp_security": "ssl", "smtp_host": "h", "smtp_port": 465}), \
                patch.object(email_module, "decrypt", return_value="pw"), \
                patch.object(email_module.smtplib, "SMTP_SSL", return_value=smtp), \
                patch.object(email_send, "accounts", return_value=[{"id": "acc", "via": "Email tab", "email": "me@example.com"}]):
            message = {"via": "Email tab", "account_id": "acc", "from": "me@example.com", "to": ["a@example.com"], "cc": [],
                       "subject": "Hello", "body": "Hi", "in_reply_to": None}
            with bot_policy.bot_call(bot):
                asyncio.run(email_send.send(message, "local"))
                self.assertEqual(smtp.sendmail.call_count, 1)
                bot_departments.set_flags(crew["id"], self.user, paused=True)   # paused while it connected
                before = len([i for i in agent_service.inbox(bot, status=None) if i["kind"] == "report"])
                with self.assertRaises(ValueError) as caught:
                    asyncio.run(email_send.send(message, "local"))
            self.assertIn("Not sent", str(caught.exception))
            self.assertEqual(smtp.sendmail.call_count, 1, "sent after the pause")
            self.assertEqual(smtp.login.call_count, 2)
            reports = [i for i in agent_service.inbox(bot, status=None) if i["kind"] == "report"]
            self.assertEqual(len(reports) - before, 1)
        bot_departments.set_flags(crew["id"], self.user, paused=False)

    def test_a_call_to_someone_else_rechecks_before_it_is_placed(self):
        from unittest.mock import AsyncMock, MagicMock
        from services import outbound_calls as calls
        bot = make_bot("Caller")
        crew = self.team("Callers", [bot])
        bot_departments.set_flags(crew["id"], self.user, paused=True)
        record = {"enabled": True, "others_enabled": True, "caller_name": "David", "provider": "twilio", "number": "+15550000000"}
        provider = MagicMock()
        provider.place_call = AsyncMock(side_effect=AssertionError("placed after the pause"))
        with patch.object(calls.connection, "get", return_value=record), patch.object(calls.connection, "calls_ready", return_value=True), \
                patch.object(calls, "check_number", return_value="+15551112222"), patch.object(calls, "_hour", return_value=12), \
                patch.object(calls, "sweep"), patch.object(calls, "_load", return_value={"blocked": [], "calls": []}), \
                patch.object(calls.phone_calls, "bot_for", return_value={"id": bot, "name": "Caller"}), \
                patch.object(calls, "voice_problem", AsyncMock(return_value="")), \
                patch.object(calls.phone_calls, "provider_for", return_value=provider):
            with self.assertRaises(calls.CallRefused) as caught:
                asyncio.run(calls.place("acct", bot, "+15551112222", "Luigi", "dinner", "table for two", "inv1"))
        self.assertIn("paused", str(caught.exception))
        bot_departments.set_flags(crew["id"], self.user, paused=False)


class SixthReview(TeamCase):
    """Codex's sixth review of 2026-11-11: the cap itself holds at the last check, and Google's own kinds of change."""

    def test_the_last_check_holds_risky_steps_at_the_cap(self):
        from services import bot_spend
        bot = make_bot("Capped")
        bot_spend._held.clear()
        with patch.object(bot_spend, "budget", return_value={"capped": True, "spend_unknown": False}):
            for kind in (bot_policy.OUTBOUND, bot_policy.DESTRUCTIVE, bot_policy.EXECUTE, bot_policy.OPAQUE):
                self.assertIn("cap is reached", bot_policy.still_allowed(kind, bot_id=bot), kind)
            self.assertIsNone(bot_policy.still_allowed(bot_policy.EDIT, bot_id=bot))
        with patch.object(bot_spend, "budget", return_value={"capped": False, "spend_unknown": False}):
            self.assertIsNone(bot_policy.still_allowed(bot_policy.OUTBOUND, bot_id=bot))
        bot_spend._held.clear()

    def test_google_changes_are_judged_by_what_they_do(self):
        from core import google_workspace as google
        cases = [("drive", "DELETE", "/files/f", None, bot_policy.DESTRUCTIVE),
                 ("drive", "PATCH", "/files/f", {"trashed": True}, bot_policy.DESTRUCTIVE),
                 ("drive", "PATCH", "/files/f", {"trashed": False}, None),
                 ("sheets", "POST", "/spreadsheets/s:batchUpdate", {"requests": [{"deleteSheet": {"sheetId": 1}}]}, bot_policy.DESTRUCTIVE),
                 ("sheets", "POST", "/spreadsheets/s:batchUpdate", {"requests": [{"addSheet": {}}]}, None),
                 ("forms", "POST", "/forms/f:batchUpdate", {"requests": [{"deleteItem": {}}]}, bot_policy.DESTRUCTIVE),
                 ("forms", "POST", "/forms/f:setPublishSettings", {"publishSettings": {}}, bot_policy.OUTBOUND),
                 ("gmail", "POST", "/users/me/messages/send", {"raw": "x"}, bot_policy.OUTBOUND)]
        for api, method, path, body, expected in cases:
            self.assertEqual(google.request_kind(api, method, path, body), expected, (api, method, path, body))

    async def test_a_capped_bot_cannot_trash_a_drive_file_at_the_last_check(self):
        from unittest.mock import AsyncMock
        import httpx
        from core import google_workspace as google
        from services import bot_spend
        bot = make_bot("Trasher")
        bot_spend._held.clear()
        sent = AsyncMock(side_effect=AssertionError("trashed at the cap"))
        with patch.object(bot_spend, "budget", return_value={"capped": True}), patch.object(google, "_token", AsyncMock(return_value="t")), \
                patch.object(httpx.AsyncClient, "request", sent), bot_policy.bot_call(bot):
            with self.assertRaises(google.GoogleError):
                await google.request("drive", "PATCH", "/files/abc", body={"trashed": True}, account="a")
        bot_spend._held.clear()


class SeventhReview(TeamCase):
    """Codex's seventh review of 2026-11-11: a Google change is risky unless it is a listed safe edit."""

    def test_google_changes_are_risky_unless_listed_safe(self):
        from core import google_workspace as google
        D, O = bot_policy.DESTRUCTIVE, bot_policy.OUTBOUND
        risky = [("sheets", "POST", "/spreadsheets/s/values/A1:B2:clear", {}, None, D),
                 ("sheets", "POST", "/spreadsheets/s/values:batchClear", {"ranges": ["A1"]}, None, D),
                 ("drive", "POST", "/files/f/permissions", {"type": "user", "role": "reader"}, {"sendNotificationEmail": "true"}, O),
                 ("drive", "PATCH", "/files/f/permissions/p1", {"role": "writer"}, None, O),
                 ("drive", "DELETE", "/files/f/permissions/p1", None, None, D),
                 ("drive", "POST", "/files/f/watch", {}, None, O),                      # an endpoint not on the list
                 ("someapi", "PUT", "/anything", {}, None, O),
                 ("calendar", "POST", "/calendars/primary/events", {"summary": "x", "attendees": [{"email": "a@b.c"}]}, None, O),
                 ("calendar", "PATCH", "/calendars/primary/events/e1", {"summary": "y"}, {"sendUpdates": "all"}, O),
                 ("drive", "PATCH", "/files/f", {"name": "x", "copyRequiresWriterPermission": True}, None, O)]
        safe = [("drive", "PATCH", "/files/f", {"name": "Renamed"}, None),
                ("drive", "PATCH", "/files/f", {}, {"addParents": "p2", "removeParents": "p1"}),
                ("drive", "PATCH", "/files/f", {"trashed": False}, None),
                ("drive", "POST", "/files/f/copy", {"name": "Copy"}, None),
                ("sheets", "PUT", "/spreadsheets/s/values/A1:B2", {"values": [[1]]}, {"valueInputOption": "USER_ENTERED"}),
                ("sheets", "POST", "/spreadsheets/s/values/A1:append", {"values": [[1]]}, None),
                ("sheets", "POST", "/spreadsheets/s:batchUpdate", {"requests": [{"addSheet": {}}]}, None),
                ("forms", "POST", "/forms/f:batchUpdate", {"requests": [{"createItem": {}}]}, None),
                ("calendar", "POST", "/calendars/primary/events", {"summary": "Focus time"}, None),
                ("calendar", "PATCH", "/calendars/primary/events/e1", {"summary": "Moved"}, {"sendUpdates": "none"})]
        for api, method, path, body, params, expected in risky:
            self.assertEqual(google.request_kind(api, method, path, body, params), expected, (api, method, path))
        for api, method, path, body, params in safe:
            self.assertIsNone(google.request_kind(api, method, path, body, params), (api, method, path))

    async def test_a_capped_bot_cannot_share_or_clear_at_the_last_check(self):
        from unittest.mock import AsyncMock
        import httpx
        from core import google_workspace as google
        from services import bot_spend
        bot = make_bot("Sharer")
        bot_spend._held.clear()
        sent = AsyncMock(side_effect=AssertionError("sent at the cap"))
        with patch.object(bot_spend, "budget", return_value={"capped": True}), patch.object(google, "_token", AsyncMock(return_value="t")), \
                patch.object(httpx.AsyncClient, "request", sent), bot_policy.bot_call(bot):
            for api, path, body in (("drive", "/files/abc/permissions", {"type": "user", "role": "reader"}),
                                    ("sheets", "/spreadsheets/s/values/A1:B2:clear", {})):
                with self.assertRaises(google.GoogleError):
                    await google.request(api, "POST", path, body=body, account="a")
        bot_spend._held.clear()


if __name__ == "__main__":
    unittest.main()
