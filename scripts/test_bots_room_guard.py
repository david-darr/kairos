r"""Bots redesign, Phase 4 unit U2: the room posting guard (2026-10-29).

A fake clock (the `now=` argument), so nothing sleeps. Run:
.venv\Scripts\python.exe -B -X utf8 scripts\test_bots_room_guard.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-room-guard-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import bot_rooms_store as store  # noqa: E402
from services import bot_room_guard as guard  # noqa: E402

T0 = 1_000_000.0


class GuardTests(unittest.TestCase):
    def setUp(self):
        guard.reset()
        self.room = f"room-{self.id().split('.')[-1]}"
        self.addCleanup(self.forget)

    def forget(self):
        with store.transaction() as conn:
            conn.execute("DELETE FROM room_posts WHERE room_id=?", (self.room,))

    def post(self, bot, text, at, **kwargs):
        return guard.check(self.room, bot, text, now=T0 + at, **kwargs)

    def test_a_first_post_goes_through(self):
        self.assertTrue(self.post("A", "hello", 0))

    def test_duplicate_within_a_minute_is_refused_after_that_it_is_fine(self):
        self.assertTrue(self.post("A", "Build is green", 0))
        refused = self.post("A", "  build   IS green ", 30)
        self.assertEqual(refused.reason, "duplicate")
        guard.note_person(self.room, T0 + 40)
        self.assertTrue(self.post("A", "Build is green", 61))
        self.assertTrue(self.post("B", "Build is green", 62))  # another bot saying the same is not a duplicate

    def test_rate_limit_is_ten_a_minute_per_bot(self):
        for n in range(10):
            guard.note_person(self.room, T0 + n)  # keep the escalate rule out of the way
            self.assertTrue(self.post("A", f"update {n}", n), n)
        guard.note_person(self.room, T0 + 10.5)
        self.assertEqual(self.post("A", "update 11", 11).reason, "rate")
        self.assertTrue(self.post("B", "me too", 11))
        guard.note_person(self.room, T0 + 70)
        self.assertTrue(self.post("A", "update 12", 71))

    def test_ring_trips_a_five_minute_breaker(self):
        self.assertTrue(self.post("A", "B, over to you", 0, targets=["B"]))
        self.assertTrue(self.post("B", "C, over to you", 10, targets=["C"]))
        tripped = self.post("C", "A, over to you", 20, targets=["A"])
        self.assertEqual(tripped.reason, "ring")
        self.assertEqual(self.post("D", "anything", 100).reason, "breaker")
        self.assertEqual(self.post("A", "anything", 319).reason, "breaker")
        guard.reset()
        self.assertTrue(self.post("A", "anything else", 321))

    def test_a_ring_is_forgotten_after_two_minutes_and_a_person_clears_the_breaker(self):
        self.assertTrue(self.post("A", "to B", 0, targets=["B"]))
        self.assertTrue(self.post("B", "to C", 10, targets=["C"]))
        guard.note_person(self.room, T0 + 11)
        self.assertTrue(self.post("C", "to A, much later", 200, targets=["A"]))  # the first two links are older than 120 s
        guard.note_person(self.room, T0 + 399)
        self.assertTrue(self.post("A", "to B", 400, targets=["B"]))
        self.assertTrue(self.post("B", "to C", 401, targets=["C"]))
        self.assertEqual(self.post("C", "to A", 402, targets=["A"]).reason, "ring")
        guard.note_person(self.room, T0 + 403)
        self.assertTrue(self.post("A", "person is back", 404))

    def test_two_way_back_and_forth_is_not_a_ring(self):
        self.assertTrue(self.post("A", "B, question", 0, targets=["B"]))
        self.assertTrue(self.post("B", "A, answer", 5, targets=["A"]))  # the escalate rule handles this one next

    def test_escalate_after_two_unanswered_bot_posts_until_a_person_speaks(self):
        self.assertTrue(self.post("A", "one", 0))
        self.assertTrue(self.post("B", "two", 10))
        self.assertEqual(self.post("C", "three", 20).reason, "escalate")
        guard.note_person(self.room, T0 + 25)
        self.assertTrue(self.post("C", "three", 30))
        self.assertTrue(self.post("A", "four", 31))
        self.assertEqual(self.post("B", "five", 32).reason, "escalate")
        self.assertTrue(self.post("B", "five", 400))  # five minutes later the window has passed

    def test_three_posts_per_turn(self):
        for n in range(3):
            guard.note_person(self.room, T0 + n)
            self.assertTrue(self.post("A", f"post {n}", n, turn_id="turn-1", per_turn=True))
        guard.note_person(self.room, T0 + 4)
        refused = self.post("A", "post 4", 4, turn_id="turn-1", per_turn=True)
        self.assertEqual(refused.reason, "turn")
        self.assertTrue(self.post("A", "a new turn", 5, turn_id="turn-2", per_turn=True))
        guard.end_turn("turn-1")
        self.assertTrue(self.post("A", "ended turn counts reset", 6, turn_id="turn-1", per_turn=True))

    def test_a_refused_post_is_not_recorded(self):
        self.assertTrue(self.post("A", "one", 0))
        self.assertEqual(self.post("A", "one", 1).reason, "duplicate")
        self.assertEqual(len(store.posts_since(self.room, T0 - 1)), 1)

    def test_the_breaker_survives_in_memory_but_posts_survive_a_restart_in_the_store(self):
        self.assertTrue(self.post("A", "kept", 0))
        guard.reset()  # as if the process restarted: the ring buffer is in the store
        self.assertEqual(self.post("A", "kept", 5).reason, "duplicate")

    def test_verdict_is_truthy_only_when_ok(self):
        self.assertTrue(guard.Verdict(True))
        self.assertFalse(guard.Verdict(False, "x", "why"))


if __name__ == "__main__":
    unittest.main()
