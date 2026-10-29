"""Bots redesign, Phase 4 unit U2: holds and mentions in a room (2026-10-29).

The parser table plus the hold state. Run:
.venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_room_holds.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-room-holds-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import OWNER, Harness  # noqa: E402
from core import bot_rooms_store as store  # noqa: E402
from services import bot_room_events as feed, bot_room_holds as holds, bot_room_turns as turns, bot_rooms as rooms  # noqa: E402

MEMBERS = [{"bot_id": "a1", "name": "Scout"}, {"bot_id": "b2", "name": "Scout Two"}, {"bot_id": "c3", "name": "Nova"}]


def want(text):
    result = holds.intent(text, MEMBERS)
    return result["hold"], result["release"]


class ParserTable(unittest.TestCase):
    def test_hold_table(self):
        cases = [
            ("@Nova stop", (["c3"], [])),
            ("@Nova, please halt for now", (["c3"], [])),
            ("pause @Nova", (["c3"], [])),
            ("@nova STOP", (["c3"], [])),
            ("@everyone pause", (["a1", "b2", "c3"], [])),
            ("@Scout Two stop", (["b2"], [])),  # the longer name wins over "@Scout"
            ("@Scout stop. @Nova keep going", (["a1"], [])),  # the stop word belongs to its own sentence
            ("@Scout stop and @Nova stop", (["a1", "c3"], [])),
            ("stop", ([], [])),  # no mention: not a hold here, it is a person Stop for the room
            ("@Nova don't stop", ([], [])),
            ("@Nova no need to pause", ([], [])),
            ("@Nova never halt", ([], [])),
            ("@Nova stopwatch results please", ([], [])),
            ("hello @Nova how are you", ([], [])),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(want(text), expected)

    def test_release_table(self):
        cases = [
            ("@Nova resume", ([], ["c3"])),
            ("@Nova, you can carry on", ([], ["c3"])),
            ("@everyone resume", ([], ["a1", "b2", "c3"])),
            ("@Nova", ([], ["c3"])),  # a bare mention lets a member back in
            ("@Nova!", ([], ["c3"])),
            ("@Scout Two", ([], ["b2"])),
            ("@Nova @Scout", ([], ["a1", "c3"])),
            ("@Scout stop. @Scout resume", ([], ["a1"])),  # the last word wins
            ("@Scout resume. @Scout stop", (["a1"], [])),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(want(text), expected)

    def test_quoted_lines_code_and_pasted_text_are_ignored(self):
        cases = [
            "> @Nova stop\nthanks",
            "The log says `@Nova stop` and nothing else",
            "```\n@Nova pause\n```",
            "```\n@Nova pause",  # an unclosed fence still hides the rest
            "> @everyone pause\n> @Nova stop",
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertEqual(want(text), ([], []))
        self.assertEqual(want("> quoted\n@Nova stop"), (["c3"], []))

    def test_find_mentions(self):
        found = holds.find_mentions("hi @scout-two and @NOVA, also @you and @everyone, @ghost, mail a@nova.com", MEMBERS)
        self.assertEqual(found["ids"], ["b2", "c3"])
        self.assertTrue(found["you"] and found["everyone"])
        self.assertEqual(found["unknown"], ["ghost"])
        self.assertEqual(holds.find_mentions("@scoutish", MEMBERS)["ids"], [])  # not a prefix match
        self.assertEqual(holds.find_mentions("@ScoutTwo", MEMBERS)["ids"], ["b2"])
        self.assertEqual(holds.find_mentions("`@Nova`", MEMBERS)["ids"], [])
        self.assertEqual(holds.find_mentions("@allen", MEMBERS)["everyone"], False)

    def test_person_stop_words(self):
        for text in ("stop", "Stop!", "stop all", " STOP EVERYTHING. ", "halt", "please stop", "stop it"):
            self.assertTrue(holds.is_person_stop(text), text)
        for text in ("don't stop", "stop the build tomorrow", "@Nova stop", "bus stop", "`stop`", "> stop"):
            self.assertFalse(holds.is_person_stop(text), text)


class HoldStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        feed.reset()
        turns.reset()
        self.addCleanup(turns.reset)
        self.a, self.b = self.h.bot("Ada"), self.h.bot("Bo")
        self.room = rooms.create(OWNER, "R", bot_ids=[self.a["id"], self.b["id"]], setup_done=True)
        self.addCleanup(store.delete_room, self.room["id"])
        self.thread = self.room["threads"][0]["id"]

    def message(self, text):
        return rooms.add_row(self.room["id"], self.thread, "person", text)[0]

    async def test_hold_release_and_frames(self):
        queue, _ = feed.subscribe(OWNER)
        self.assertTrue(holds.hold(self.room["id"], self.a["id"], OWNER, interrupt=False))
        self.assertFalse(holds.hold(self.room["id"], self.a["id"], OWNER, interrupt=False))  # already held
        self.assertEqual(holds.held_ids(self.room["id"]), [self.a["id"]])
        self.assertTrue(holds.release(self.room["id"], self.a["id"], OWNER))
        self.assertFalse(holds.release(self.room["id"], self.a["id"], OWNER))
        frames = [queue.get_nowait() for _ in range(queue.qsize())]
        self.assertEqual([(f["type"], f["data"]["held"]) for f in frames if f["type"] == "room.hold"], [("room.hold", True), ("room.hold", False)])
        feed.unsubscribe(queue)

    async def test_twenty_messages_are_remembered_the_oldest_drop_off(self):
        holds.hold(self.room["id"], self.a["id"], OWNER, interrupt=False)
        for n in range(25):
            holds.record_addressed(self.room["id"], self.a["id"], self.message(f"for you {n}"))
        kept = store.member(self.room["id"], self.a["id"])["held_for"]
        self.assertEqual(len(kept), holds.MAX_HELD_MESSAGES)
        self.assertEqual(kept[0]["text"], "for you 5")
        holds.release(self.room["id"], self.a["id"], OWNER)
        block = holds.take_released_block(self.room["id"], self.a["id"])
        self.assertIn("for you 24", block)
        self.assertIn("UNTRUSTED", block)  # what was said to the member is data, fenced
        self.assertEqual(holds.take_released_block(self.room["id"], self.a["id"]), "")  # handed over once

    async def test_a_message_to_a_free_member_is_not_remembered_and_dms_do_not_apply(self):
        holds.record_addressed(self.room["id"], self.b["id"], self.message("hi"))
        self.assertEqual(store.member(self.room["id"], self.b["id"])["held_for"], [])

    async def test_apply_person_message_holds_and_records(self):
        message = self.message("@Ada stop")
        result = holds.apply_person_message(self.room["id"], "@Ada stop", message, OWNER)
        self.assertEqual(result["held"], [self.a["id"]])
        again = holds.apply_person_message(self.room["id"], "@Ada are you there", self.message("@Ada are you there"), OWNER)
        self.assertEqual(again["addressed_held"], [self.a["id"]])
        everyone = holds.apply_person_message(self.room["id"], "@everyone status", self.message("@everyone status"), OWNER)
        self.assertEqual(everyone["addressed_held"], [self.a["id"]])
        self.assertEqual(len(store.member(self.room["id"], self.a["id"])["held_for"]), 2)


if __name__ == "__main__":
    unittest.main()
