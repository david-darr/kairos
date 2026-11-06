"""Cards in rooms (services/bot_widgets.py, 2026-10-31): a card a bot shows during a room turn lands in the room's
transcript, and the person's answer goes back into the room addressed to that bot. Throwaway data folder."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-room-widgets-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_rooms_store as store  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import bot_room_routes  # noqa: E402
from services import bot_rooms, bot_widgets as widgets  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.bot_widgets import WidgetError  # noqa: E402


def card():
    return {"type": "card", "title": "Pick a day", "children": [
        {"type": "Select", "id": "day", "label": "Day", "options": ["Mon", "Tue"]}],
        "confirm": {"label": "Book it", "ref": "confirm"}, "cancel": {"label": "Never mind", "ref": "cancel"}}


def run(coro):
    return asyncio.run(coro)


class RoomCards(unittest.TestCase):
    def setUp(self):
        self.ada = agent_service.create("Ada", endpoint_id=None)
        self.bo = agent_service.create("Bo", endpoint_id=None)
        self.owner = "david"
        self.room = bot_rooms.create(self.owner, "Launch", bot_ids=[self.ada["id"], self.bo["id"]], setup_done=True)
        self.seat = bot_rooms.ensure_seat(self.room["id"], self.bo["id"])
        self.sent = []

    def tearDown(self):
        bot_rooms.delete(self.owner, self.room["id"])
        for ident in list(agent_service._agents):
            agent_service.delete(ident)

    def sender(self, room_id, thread_id, text, send_id, mode, owner, reply_to_id):
        self.sent.append({"room": room_id, "thread": thread_id, "text": text, "send_id": send_id, "owner": owner, "reply_to": reply_to_id})
        return {"message": {"id": "m-" + send_id}}

    def press(self, shown, ref="confirm", send_id="send-0001", values=None, rev=None):
        body = {"message_id": shown["message_id"], "ref": ref, "rev": rev or shown["rev"], "values": values or {"day": "Tue"}, "send_id": send_id}
        return run(widgets.press_room(self.owner, self.room["id"], body, sender=self.sender))

    def card_row(self, message_id):
        return store.get_message(self.room["id"], message_id)

    def test_a_card_from_a_room_turn_is_posted_into_the_room(self):
        shown = widgets.show(self.seat, self.bo["id"], card())
        self.assertEqual(shown["room_id"], self.room["id"])
        row = self.card_row(shown["message_id"])
        self.assertEqual((row["role"], row["kind"], row["bot_id"], row["text"]), ("bot", "widget", self.bo["id"], "Pick a day"))
        self.assertEqual(row["meta"]["widget"]["rev"], 1)
        self.assertIsNone(row["meta"]["widget"]["settled"])
        self.assertEqual(row["thread_id"], bot_rooms.thread_or_404(self.room["id"], None)["id"])

    def test_the_bot_can_update_its_own_card_but_not_another_bots(self):
        shown = widgets.show(self.seat, self.bo["id"], card())
        updated = widgets.update(self.seat, shown["message_id"], {**card(), "title": "Pick a new day"})
        self.assertEqual(updated["rev"], 2)
        self.assertEqual(self.card_row(shown["message_id"])["meta"]["widget"]["doc"]["title"], "Pick a new day")
        other = bot_rooms.ensure_seat(self.room["id"], self.ada["id"])
        with self.assertRaises(WidgetError) as caught:
            widgets.update(other, shown["message_id"], card())
        self.assertEqual(caught.exception.status, 404)

    def test_a_press_answers_the_bot_in_the_room_and_settles_the_card(self):
        shown = widgets.show(self.seat, self.bo["id"], card())
        result = self.press(shown)
        self.assertEqual(len(self.sent), 1)
        sent = self.sent[0]
        self.assertTrue(sent["text"].startswith('@Bo I answered the card "Pick a day": Book it.'), sent["text"])
        self.assertIn("Day: Tue", sent["text"])
        self.assertEqual((sent["reply_to"], sent["owner"], sent["send_id"]), (shown["message_id"], self.owner, "send-0001"))
        settled = self.card_row(shown["message_id"])["meta"]["widget"]["settled"]
        self.assertEqual((settled["ref"], settled["label"]), ("confirm", "Book it"))
        self.assertNotIn("pending", settled)
        self.assertEqual(self.press(shown), result, "a retry with the same send id is the same answer")
        self.assertEqual(len(self.sent), 1, "and sends nothing twice")
        with self.assertRaises(WidgetError) as caught:
            self.press(shown, send_id="send-0002")
        self.assertEqual(caught.exception.status, 409, "a second answer is refused")

    def test_bad_presses_are_refused_and_leave_the_card_open(self):
        shown = widgets.show(self.seat, self.bo["id"], card())
        for kwargs, status in (({"rev": 9}, 409), ({"ref": "nope"}, 400), ({"values": {"day": "Fri"}}, 400)):
            with self.assertRaises(WidgetError) as caught:
                self.press(shown, **kwargs)
            self.assertEqual(caught.exception.status, status)
        self.assertIsNone(self.card_row(shown["message_id"])["meta"]["widget"]["settled"])
        with self.assertRaises(Exception):
            run(widgets.press_room("someone-else", self.room["id"], {"message_id": shown["message_id"], "ref": "confirm", "rev": 1, "values": {}, "send_id": "send-0003"}, sender=self.sender))

    def test_a_failed_send_reopens_the_card(self):
        shown = widgets.show(self.seat, self.bo["id"], card())

        def broken(*args):
            raise RuntimeError("down")
        with self.assertRaises(RuntimeError):
            run(widgets.press_room(self.owner, self.room["id"], {"message_id": shown["message_id"], "ref": "confirm", "rev": 1,
                                                                 "values": {"day": "Mon"}, "send_id": "send-0004"}, sender=broken))
        self.assertIsNone(self.card_row(shown["message_id"])["meta"]["widget"]["settled"])

    def test_the_route(self):
        shown = widgets.show(self.seat, self.bo["id"], card())
        app = FastAPI(); app.include_router(bot_room_routes.router); app.dependency_overrides[require_admin] = lambda: self.owner; app.dependency_overrides[require_user] = lambda: self.owner
        client = TestClient(app)
        bad = client.post(f"/api/bot-rooms/{self.room['id']}/widgets/press", json={"message_id": shown["message_id"], "ref": "confirm", "rev": 7, "values": {}, "send_id": "send-0005"})
        self.assertEqual(bad.status_code, 409)
        good = client.post(f"/api/bot-rooms/{self.room['id']}/widgets/press", json={"message_id": shown["message_id"], "ref": "cancel", "rev": 1, "values": {}, "send_id": "send-0006"})
        self.assertEqual(good.status_code, 200, good.text)
        answers = [m for m in store.messages(self.room["id"]) if m["role"] == "person" and m["reply_to_id"] == shown["message_id"]]
        self.assertEqual(len(answers), 1, "the answer is one person's message in the room, replying to the card")
        row = answers[0]
        self.assertTrue(row["text"].startswith("@Bo I answered the card"))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        store.close()
        _DATA.cleanup()
