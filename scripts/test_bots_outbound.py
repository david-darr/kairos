"""Bots redesign, Phase 3 unit U1: the daily send allowance (2026-10-29).

The ledger is a real SQLite file raced by real threads and independent turns. Run:
python scripts/test_bots_outbound.py
"""
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bots_approvals_harness import (ApprovalCase, agent_service, asyncio, bot_outbound, bot_policy, make_bot,  # noqa: E402
                                    make_thread, permissions, set_mode)

NOON_UTC = 1793275200.0     # 2026-10-29 12:00 UTC


class Ledger(ApprovalCase):
    def test_a_unit_is_taken_once_per_invocation_and_the_cap_holds(self):
        taken = [bot_outbound.reserve("local", "b1", f"i{n}", 3, now=NOON_UTC, zone="UTC") for n in range(5)]
        self.assertEqual([t["ok"] for t in taken], [True, True, True, False, False])
        again = bot_outbound.reserve("local", "b1", "i0", 3, now=NOON_UTC, zone="UTC")
        self.assertTrue(again["ok"] and again["reused"], "a retry reuses its unit")
        self.assertEqual(bot_outbound.usage("local", "b1", 3, zone="UTC", now=NOON_UTC)["used"], 3)
        self.assertEqual(bot_outbound.usage("local", "b2", 3, zone="UTC", now=NOON_UTC)["used"], 0)
        self.assertEqual(bot_outbound.usage("other", "b1", 3, zone="UTC", now=NOON_UTC)["used"], 0)

    def test_the_last_unit_goes_to_exactly_one_of_many_racing_threads(self):
        results, gate = [], threading.Barrier(16)

        def go(index):
            gate.wait()
            results.append(bot_outbound.reserve("local", "race", f"turn-{index}", 5, now=NOON_UTC, zone="UTC")["ok"])
        threads = [threading.Thread(target=go, args=(i,)) for i in range(16)]
        for item in threads:
            item.start()
        for item in threads:
            item.join()
        self.assertEqual(results.count(True), 5)
        self.assertEqual(bot_outbound.usage("local", "race", 5, zone="UTC", now=NOON_UTC)["used"], 5)

    def test_a_send_that_never_left_gives_its_unit_back_but_an_uncertain_one_does_not(self):
        for n in range(2):
            bot_outbound.reserve("local", "b", f"i{n}", 2, now=NOON_UTC, zone="UTC")
        self.assertFalse(bot_outbound.reserve("local", "b", "i2", 2, now=NOON_UTC, zone="UTC")["ok"])
        self.assertTrue(bot_outbound.finalize("local", "b", "i0", bot_outbound.RELEASED))
        self.assertTrue(bot_outbound.finalize("local", "b", "i1", bot_outbound.UNCERTAIN))
        self.assertTrue(bot_outbound.reserve("local", "b", "i2", 2, now=NOON_UTC, zone="UTC")["ok"])
        self.assertFalse(bot_outbound.reserve("local", "b", "i3", 2, now=NOON_UTC, zone="UTC")["ok"])
        self.assertFalse(bot_outbound.finalize("local", "b", "i1", bot_outbound.RELEASED), "settled units stay settled")
        # a released unit taken again by the same retry costs one unit again
        bot_outbound.finalize("local", "b", "i2", bot_outbound.RELEASED)
        self.assertTrue(bot_outbound.reserve("local", "b", "i0", 2, now=NOON_UTC, zone="UTC")["ok"])

    def test_the_day_is_the_owners_and_a_zone_change_cannot_reset_a_used_allowance(self):
        # 2026-10-29 12:00 UTC is still the 29th in Los Angeles, and already the 30th in Auckland
        bot_outbound.reserve("local", "z", "a", 1, now=NOON_UTC, zone="America/Los_Angeles")
        self.assertEqual(bot_outbound.usage("local", "z", 1, zone="America/Los_Angeles", now=NOON_UTC)["date"], "2026-10-29")
        self.assertEqual(bot_outbound.usage("local", "z", 1, zone="Pacific/Auckland", now=NOON_UTC)["date"], "2026-10-30")
        flipped = bot_outbound.reserve("local", "z", "b", 1, now=NOON_UTC, zone="Pacific/Auckland")
        self.assertFalse(flipped["ok"], "moving to a zone where it is already tomorrow frees nothing")
        # the next local midnight in the original zone does reset it
        later = NOON_UTC + 20 * 3600
        self.assertTrue(bot_outbound.reserve("local", "z", "c", 1, now=later, zone="America/Los_Angeles")["ok"])

    def test_midnight_is_the_reset_boundary(self):
        usage = bot_outbound.usage("local", "m", 25, zone="UTC", now=NOON_UTC)
        self.assertEqual(usage["resets_at"], NOON_UTC + 12 * 3600)
        self.assertEqual(usage["remaining"], 25)

    def test_an_unknown_zone_falls_back_to_utc_and_results_settle_by_what_the_tool_said(self):
        self.assertEqual(bot_outbound.local_date("Not/AZone", NOON_UTC), "2026-10-29")
        self.assertEqual(bot_outbound.outcome_for("Sent."), "committed")
        self.assertEqual(bot_outbound.outcome_for("Not sent: no account"), "released")
        self.assertEqual(bot_outbound.outcome_for("Not run: nobody answered"), "released")
        self.assertEqual(bot_outbound.outcome_for("Tool error: timeout"), "uncertain")


class Gate(ApprovalCase):
    def bot_with_allowance(self, cap, policy="allow", mode="ask"):
        bot = make_bot("Sender")
        agent_service.update(bot, outbound={"policy": policy, "daily_cap": cap}, approval_mode="ask")
        if mode != "ask":
            set_mode(bot, mode)
        return bot, make_thread(bot)

    async def test_below_full_a_send_draws_on_the_allowance_then_asks(self):
        bot, sid = self.bot_with_allowance(2)
        first = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "t1"})
        second = await self.decide(bot, sid, "send_email", {"to": "b"}, bot_context={"invocation_id": "t2"})
        self.assertEqual((first.behavior, second.behavior), ("allow", "allow"))
        self.assertEqual(first.invocation_id, "t1")
        third = await self.decide(bot, sid, "send_email", {"to": "c"}, bot_context={"invocation_id": "t3"}, timeout=1)
        self.assertEqual(third.behavior, "deny")
        self.assertEqual(bot_policy.decisions("local", bot_id=bot)[0]["source"], "nobody-to-ask")
        view = bot_outbound.usage("local", bot, 2)
        self.assertEqual((view["used"], view["remaining"]), (2, 0))

    async def test_the_exhausted_allowance_asks_the_person_and_a_person_approved_send_costs_nothing(self):
        bot, sid = self.bot_with_allowance(1)
        await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "t1"})
        task, payload = await self.asked(f"chat:{sid}", tool="send_email", arguments={"to": "b"}, agent_id=bot,
                                         is_admin=True, bot_context={"invocation_id": "t2"})
        self.assertIn("used up", payload["description"])
        self.assertEqual([c["id"] for c in payload["choices"]], ["once", "reject"])
        permissions.answer(payload["id"], "once", "local")
        self.assertEqual((await task).behavior, "allow")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 1)

    async def test_policy_ask_always_asks_and_full_bypasses_the_allowance(self):
        bot, sid = self.bot_with_allowance(5, policy="ask")
        denied = await self.decide(bot, sid, "send_email", {"to": "a"}, timeout=1)
        self.assertEqual(denied.behavior, "deny")
        self.assertEqual(bot_outbound.usage("local", bot, 5)["used"], 0)
        full, fsid = self.bot_with_allowance(1, policy="allow", mode="full")
        for n in range(4):
            decision = await self.decide(full, fsid, "send_email", {"to": "a"}, bot_context={"invocation_id": f"f{n}"})
            self.assertEqual(decision.behavior, "allow")
        self.assertEqual(bot_outbound.usage("local", full, 1)["used"], 0, "Full never draws on the allowance")

    async def test_simultaneous_independent_turns_cannot_both_take_the_last_unit(self):
        bot, _ = self.bot_with_allowance(1)
        threads = [make_thread(bot) for _ in range(6)]
        results = await asyncio.gather(*[
            self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": f"turn{n}"}, timeout=1)
            for n, sid in enumerate(threads)])
        self.assertEqual([r.behavior for r in results].count("allow"), 1)

    async def test_a_retry_with_the_same_invocation_does_not_charge_twice(self):
        bot, sid = self.bot_with_allowance(2)
        for _ in range(3):
            decision = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "same"})
            self.assertEqual(decision.behavior, "allow")
        self.assertEqual(bot_outbound.usage("local", bot, 2)["used"], 1)

    async def test_finishing_a_call_settles_its_unit_from_what_the_tool_returned(self):
        bot, sid = self.bot_with_allowance(1)
        decision = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "t1"})
        permissions.finish_bot_call(decision, bot, "Not sent: the account is signed out")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 0, "it never left, so the unit is back")
        decision = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "t2"})
        permissions.finish_bot_call(decision, bot, "Sent.")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 1)
        again = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "t3"}, timeout=1)
        self.assertEqual(again.behavior, "deny")

    async def test_drafts_are_not_sends_and_unknown_sends_ask(self):
        bot, sid = self.bot_with_allowance(1, mode="edits")
        for n in range(3):
            self.assertEqual((await self.decide(bot, sid, "create_draft", {})).behavior, "allow")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 0)
        unknown = await self.decide(bot, sid, "frobnicate_widgets", {}, timeout=1)
        self.assertEqual(unknown.behavior, "deny")

    async def test_a_routine_draws_on_the_same_allowance_as_its_chats(self):
        bot, sid = self.bot_with_allowance(1)
        self.with_run({"routine_id": "r", "run_id": "run", "bot_id": bot, "owner": "local", "access": "normal",
                       "unattended": True, "trigger": "schedule"})
        first = await self.decide(bot, sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "routine-1"})
        self.assertEqual(first.behavior, "allow")
        self.with_run(None)
        second = await self.decide(bot, sid, "send_email", {"to": "b"}, bot_context={"invocation_id": "chat-1"}, timeout=1)
        self.assertEqual(second.behavior, "deny")

    async def test_the_gate_for_registry_calls_asks_and_settles(self):
        from core import tool_registry
        from bots_approvals_harness import ctx_for
        bot, sid = self.bot_with_allowance(1)
        ctx = ctx_for(bot, sid, invocation_id="reg-1")
        read = await permissions.gate_bot_call(ctx, "list_contacts", {})
        self.assertEqual(read.behavior, "allow")
        sent = await permissions.gate_bot_call(ctx, "send_email", {"to": "a"})
        self.assertEqual((sent.behavior, sent.invocation_id), ("allow", "reg-1"))
        permissions.finish_bot_call(sent, bot, "Sent.")
        after = await permissions.gate_bot_call(ctx_for(bot, sid, invocation_id="reg-2"), "send_email", {"to": "a"})
        self.assertEqual(after.behavior, "deny")
        other = await permissions.gate_bot_call(tool_registry.ToolContext(session_id=None, is_admin=True), "send_email", {})
        self.assertEqual(other.behavior, "allow", "an ordinary chat is not gated here")


if __name__ == "__main__":
    unittest.main(verbosity=1)
