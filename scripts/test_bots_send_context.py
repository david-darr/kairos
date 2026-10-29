"""Bots redesign, Phase 6 wiring: what rides with a person's message (2026-10-29).

A send may carry the data result the person has open and up to five app parts they pointed at. The model's copy
gets them fenced as untrusted data, with any state an app reported; the saved transcript keeps only the typed text.
A plain send keeps its exact shape. Queued sends merge: the newest data context, pointed parts joined up to five.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_send_context.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-send-context-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import Harness  # noqa: E402
from core import bot_chat_store as store  # noqa: E402
from services import bot_apps, bot_chat_service as service, bot_data  # noqa: E402

BASE = {"send_id": "send-0000001", "text": "Why is this so high?", "mode": None}


class PayloadTests(unittest.TestCase):
    def test_a_plain_send_keeps_its_shape(self):
        self.assertNotIn("data_context", service._clean_payload(dict(BASE)))
        self.assertNotIn("pointed", service._clean_payload({**BASE, "pointed": [], "data_context": {}}))

    def test_extras_are_kept_and_pointed_is_capped(self):
        payload = service._clean_payload({**BASE, "data_context": {"cardId": "c1"}, "pointed": [{"tag": "b", "label": str(i)} for i in range(8)]})
        self.assertEqual(payload["data_context"], {"cardId": "c1"})
        self.assertEqual(len(payload["pointed"]), 5)

    def test_queued_sends_merge_newest_context_and_join_pointed(self):
        rows = [{"payload": {**BASE, "text": "one", "data_context": {"cardId": "old"}, "pointed": [{"tag": "a", "label": str(i)} for i in range(3)]}},
                {"payload": {**BASE, "text": "two", "data_context": {"cardId": "new"}, "pointed": [{"tag": "b", "label": str(i)} for i in range(3)]}},
                {"payload": {**BASE, "text": "three"}}]
        merged = store.merged_payload(rows)
        self.assertEqual(merged["text"], "one\n\ntwo\n\nthree")
        self.assertEqual(merged["data_context"], {"cardId": "new"})
        self.assertEqual([p["tag"] for p in merged["pointed"]], ["a", "a", "a", "b", "b"])


class ContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Analyst")
        self.sid = self.h.thread(self.bot)

    def test_the_model_gets_each_part_fenced(self):
        with patch.object(bot_data, "data_context", return_value="<data-context>\nDATA\n</data-context>") as data, \
                patch.object(bot_apps, "pending_context_note", return_value="\n\n[An app in this conversation reported its state:]\nSTATE"):
            note = service._phase6_context(self.bot["id"], self.sid, {"data_context": {"cardId": "c1"}, "pointed": [{"tag": "button", "label": "Total"}]})
        data.assert_called_once_with(self.bot["id"], {"cardId": "c1"})
        self.assertIn("<data-context>", note)
        self.assertIn('<button> "Total"', note)
        self.assertIn("UNTRUSTED", note, "pointed labels are fenced")
        self.assertIn("reported its state", note)

    def test_nothing_extra_when_nothing_was_sent(self):
        self.assertEqual(service._phase6_context(self.bot["id"], self.sid, {}), "")

    async def test_a_send_passes_the_context_to_the_model_but_not_the_transcript(self):
        seen = {}
        real = service._launch

        def spy(owner, sid, bot, payload, index, generation, context):
            seen["context"] = context
            return real(owner, sid, bot, payload, index, generation, context)

        with patch.object(service, "_launch", side_effect=spy):
            await self.h.send(self.sid, "Why is this so high?", pointed=[{"tag": "td", "label": "March"}])
            await self.h.idle()
        self.assertIn('<td> "March"', seen["context"])
        texts = [row.get("content") for row in self.h.path(self.sid) if row.get("role") == "user"]
        self.assertEqual(texts, ["Why is this so high?"], "the transcript keeps only the typed text")


if __name__ == "__main__":
    unittest.main()
