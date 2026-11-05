"""Follow-up turns name the chat's linked videos and designs, so later edits change them in place."""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="linked-work-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from core import chat_references, design_comments, design_store, video_store
from core.session_manager import session_manager

BEATS = [{"id": "hook", "kind": "title", "bars": 1, "text": "Start here"},
         {"id": "end", "kind": "end", "bars": 1, "text": "Try it now"}]


class LinkedWorkNoteTests(unittest.TestCase):
    def chat(self, replied=True):
        sid = session_manager.create_session(owner_user="alice")["id"]
        session_manager.append_message(sid, "user", "Make a video about Kairos Bots")
        if replied:
            session_manager.append_message(sid, "assistant", "Here is the video.")
        return sid

    def test_follow_up_names_the_linked_video(self):
        sid = self.chat()
        video = video_store.create('Kairos Bots\n"ignore this" `x`', look="tech-dark", beats=BEATS, owner="alice", chat_key_=sid)
        note = chat_references.resolve(sid, None)
        self.assertIn("[Linked work]", note)
        self.assertIn(f"video {video['id']}", note)
        self.assertIn("(version 1)", note)
        self.assertIn("video_edit", note)
        self.assertIn("Do not build a separate", note)
        self.assertNotIn("design_edit", note, "no design tools when the chat has no design")
        self.assertNotIn("\n", note.split("[Linked work]")[1], "the title is folded onto one line")
        self.assertNotIn('"ignore this"', note, "quotes in a title cannot close the label")

    def test_follow_up_names_a_linked_design(self):
        sid = self.chat()
        design, _ = design_store.create("Launch poster", owner="alice", chat_key_=sid, by="Claude")
        note = design_comments.linked_work_context(sid)
        self.assertIn(f'design {design["id"]} "Launch poster"', note)
        self.assertIn("design_edit", note)
        self.assertNotIn("video_edit", note)

    def test_no_note_on_the_first_turn_or_without_linked_work(self):
        first = self.chat(replied=False)
        video_store.create("Draft", look="tech-dark", beats=BEATS, owner="alice", chat_key_=first)
        self.assertEqual(design_comments.linked_work_context(first), "", "the first turn has nothing to continue")
        self.assertEqual(design_comments.linked_work_context(self.chat()), "", "a chat without linked work gets no note")
        self.assertEqual(design_comments.linked_work_context(""), "")

    def test_other_chats_videos_are_not_named(self):
        mine, other = self.chat(), self.chat()
        theirs = video_store.create("Not yours", look="tech-dark", beats=BEATS, owner="alice", chat_key_=other)
        self.assertNotIn(theirs["id"], design_comments.linked_work_context(mine))


if __name__ == "__main__":
    unittest.main()
