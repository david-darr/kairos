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
        inner = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(2)"},
                                               surface=f"chat:{sid}")
        self.assertEqual((inner.action, inner.source), ("allow", "outer"))
        again = bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(2)"},
                                               surface=f"chat:{sid}")
        self.assertEqual(again.action, "ask", "an outer approval was used twice")
        bot_policy.mark_inflight(outer, source="person")
        bot_policy.clear_inflight(bot)   # the call finished
        self.assertEqual(bot_policy.authorize_operation(bot_id=bot, tool="run_code", arguments={"code": "print(2)"},
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


if __name__ == "__main__":
    unittest.main()
