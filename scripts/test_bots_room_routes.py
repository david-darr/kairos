"""Bots redesign, Phase 4 unit U2: the /api/bot-rooms routes (2026-10-29).

Status codes, bounded bodies, owner isolation and the live feed's replay. No model runs here: the
rooms answer only when mentioned, and nothing is mentioned. Run:
.venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_room_routes.py
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-room-routes-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_rooms_store as store  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes import bot_room_routes, trigger_routes  # noqa: E402
from services import bot_room_events as feed, bot_room_turns as turns  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.trigger_service import trigger_service  # noqa: E402

CURRENT = {"user": "david"}
app = FastAPI()
app.include_router(bot_room_routes.router)
app.include_router(trigger_routes.router)
app.dependency_overrides[require_admin] = lambda: CURRENT["user"]
BASE = "/api/bot-rooms"


class RouteCase(unittest.TestCase):
    def setUp(self):
        CURRENT["user"] = "david"
        feed.reset()
        turns.reset()
        patcher = patch.dict(agent_service._agents, {}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.web = TestClient(app)
        self.web.__enter__()
        self.addCleanup(self.web.__exit__, None, None, None)
        self.a = agent_service.create("Ada", role="Tests")
        self.b = agent_service.create("Bo", role="Tests")

    def make(self, **extra):
        body = {"name": "Plan", "bot_ids": [self.a["id"], self.b["id"]], "setup_done": True, **extra}
        response = self.web.post(BASE, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        room = response.json()
        self.addCleanup(lambda: store.get_room(room["id"]) and store.delete_room(room["id"]))
        return room


class CrudRoutes(RouteCase):
    def test_create_get_list_patch_delete(self):
        room = self.make(description="d")
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}").json()["name"], "Plan")
        self.assertEqual([r["id"] for r in self.web.get(BASE).json()["rooms"]], [room["id"]])
        patched = self.web.patch(f"{BASE}/{room['id']}", json={"name": "Roadmap", "expected_revision": room["revision"]})
        self.assertEqual(patched.json()["name"], "Roadmap")
        self.assertEqual(self.web.patch(f"{BASE}/{room['id']}", json={"name": "x", "expected_revision": room["revision"]}).status_code, 409)
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}").json()["deleted"], True)
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}").status_code, 404)

    def test_bodies_are_bounded_and_unknown_fields_refused(self):
        ids = [self.a["id"]]
        self.assertEqual(self.web.post(BASE, json={"name": "x", "bot_ids": ids, "owner": "someone"}).status_code, 422)
        self.assertEqual(self.web.post(BASE, json={"name": "", "bot_ids": ids}).status_code, 422)
        self.assertEqual(self.web.post(BASE, json={"name": "x", "bot_ids": []}).status_code, 422)
        self.assertEqual(self.web.post(BASE, json={"name": "x", "bot_ids": ids, "turn_timeout_minutes": 1441}).status_code, 422)
        self.assertEqual(self.web.post(BASE, json={"name": "x" * 101, "bot_ids": ids}).status_code, 422)
        self.assertEqual(self.web.post(BASE, json={"name": "x", "bot_ids": ["ghost"]}).status_code, 422)
        room = self.make()
        self.assertEqual(self.web.patch(f"{BASE}/{room['id']}", json={"seat_session_id": "x"}).status_code, 422)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/messages", json={"text": "hi", "send_id": "short"}).status_code, 422)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/holds", json={"bot_id": self.a["id"]}).status_code, 422)

    def test_another_persons_room_is_a_404_everywhere(self):
        room = self.make()
        CURRENT["user"] = "mallory"
        thread = room["threads"][0]["id"]
        checks = [("get", f"{BASE}/{room['id']}", None), ("patch", f"{BASE}/{room['id']}", {"name": "x"}),
                  ("delete", f"{BASE}/{room['id']}", None), ("get", f"{BASE}/{room['id']}/messages", None),
                  ("post", f"{BASE}/{room['id']}/messages", {"text": "hi", "send_id": "send-00000001"}),
                  ("post", f"{BASE}/{room['id']}/stop", {}), ("get", f"{BASE}/{room['id']}/queue", None),
                  ("get", f"{BASE}/{room['id']}/threads", None), ("post", f"{BASE}/{room['id']}/threads", {"title": "x"}),
                  ("post", f"{BASE}/{room['id']}/holds", {"bot_id": self.a["id"], "held": True}),
                  ("post", f"{BASE}/{room['id']}/setup", {"action": "skip"}),
                  ("get", f"{BASE}/{room['id']}/threads/{thread}/goal", None)]
        for method, url, body in checks:
            with self.subTest(url=url, method=method):
                response = getattr(self.web, method)(url, **({"json": body} if body is not None else {}))
                self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(self.web.get(BASE).json()["rooms"], [])

    def test_setup_route_and_pending_send_guard(self):
        pending = self.web.post(BASE, json={"name": "New", "bot_ids": [self.a["id"]]}).json()
        self.addCleanup(store.delete_room, pending["id"])
        send = {"text": "hi", "send_id": "send-00000001"}
        self.assertEqual(self.web.post(f"{BASE}/{pending['id']}/messages", json=send).status_code, 409)
        done = self.web.post(f"{BASE}/{pending['id']}/setup", json={"action": "complete", "bulletin": "Be kind"})
        self.assertEqual((done.json()["setup_state"], done.json()["bulletin"]), ("done", "Be kind"))
        self.assertEqual(self.web.post(f"{BASE}/{pending['id']}/setup", json={"action": "explode"}).status_code, 422)


class MessageRoutes(RouteCase):
    def test_send_is_202_and_idempotent_and_paging_works(self):
        room = self.make()
        send = {"text": "just thinking out loud", "send_id": "send-00000001"}
        first = self.web.post(f"{BASE}/{room['id']}/messages", json=send)
        self.assertEqual(first.status_code, 202)
        self.assertFalse(first.json()["queued"])
        again = self.web.post(f"{BASE}/{room['id']}/messages", json=send)
        self.assertTrue(again.json()["replayed"])
        self.assertEqual(first.json()["message"]["id"], again.json()["message"]["id"])
        listing = self.web.get(f"{BASE}/{room['id']}/messages?limit=5").json()
        self.assertEqual(listing["messages"][0]["text"], "just thinking out loud")
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}/messages?thread_id=nope").status_code, 404)
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}/messages?around=nope").status_code, 404)
        around = self.web.get(f"{BASE}/{room['id']}/messages?around={first.json()['message']['id']}").json()
        self.assertEqual(len(around["messages"]) >= 1, True)

    def test_hold_stop_and_queue_routes(self):
        room = self.make()
        held = self.web.post(f"{BASE}/{room['id']}/holds", json={"bot_id": self.a["id"], "held": True}).json()
        self.assertTrue(held["changed"])
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}").json()["members"][0]["held"], True)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/holds", json={"bot_id": "ghost", "held": True}).status_code, 404)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/stop", json={}).json()["stopped"], [])
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/stop", json={"bot_id": "ghost"}).status_code, 404)
        thread = room["threads"][0]["id"]
        row = store.queue_add(room["id"], thread, {"text": "waiting", "message_id": "m1"}, "send-q-1")
        listing = self.web.get(f"{BASE}/{room['id']}/queue").json()["items"]
        self.assertEqual([(i["id"], i["position"]) for i in listing], [(row["id"], 1)])
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}/queue/{row['id']}").json()["cancelled"], True)
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}/queue/{row['id']}").status_code, 409)
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}/queue/nope").status_code, 404)

    def test_thread_routes(self):
        room = self.make()
        made = self.web.post(f"{BASE}/{room['id']}/threads", json={"title": "Side"}).json()
        names = [t["title"] for t in self.web.get(f"{BASE}/{room['id']}/threads").json()["threads"]]
        self.assertEqual(names, ["", "Side"])
        self.assertEqual(self.web.patch(f"{BASE}/{room['id']}/threads/{made['id']}", json={"title": "Renamed"}).json()["title"], "Renamed")
        self.assertEqual(self.web.patch(f"{BASE}/{room['id']}/threads/nope", json={"title": "x"}).status_code, 404)
        both = [room["threads"][0]["id"], made["id"]]
        self.assertEqual(len(self.web.post(f"{BASE}/{room['id']}/threads/delete", json={"thread_ids": both}).json()["deleted"]), 1)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/threads/delete", json={"thread_ids": []}).status_code, 422)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/threads/delete",
                                       json={"thread_ids": [str(n) for n in range(501)]}).status_code, 422)
        last = store.threads(room["id"])[0]["id"]
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}/threads/{last}").json()["deleted"], [])  # the last one stays

    def test_read_marks_unread_clear(self):
        room = self.make()
        from services import bot_rooms
        bot_rooms.add_row(room["id"], room["threads"][0]["id"], "bot", "hello", bot_id=self.a["id"])
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}").json()["unread"], 1)
        self.assertEqual(self.web.post(f"{BASE}/{room['id']}/read", json={}).json()["unread"], 0)


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20


class WebhookPostRoutes(RouteCase):
    def hook(self, room, bot, **extra):
        trigger, secret = trigger_service.create("Build hook", action="post", room_id=room["id"], bot_id=bot["id"], **extra)
        self.addCleanup(lambda: trigger_service.get(trigger["id"]) and trigger_service.delete(trigger["id"]))
        return trigger, secret

    def fire(self, trigger, secret, payload, delivery):
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        return self.web.post(f"/api/triggers/{trigger['id']}", content=body,
                             headers={"X-JARVIS-Signature": signature, "X-Request-ID": delivery})

    def test_a_signed_webhook_posts_one_bot_row_with_images(self):
        room = self.make()
        trigger, secret = self.hook(room, self.a)
        sent = self.fire(trigger, secret, {"text": "Build is green", "images": [base64.b64encode(PNG).decode()]}, "d-1")
        self.assertEqual(sent.status_code, 202, sent.text)
        row = store.messages(room["id"])[-1]
        self.assertEqual((row["kind"], row["role"], row["bot_id"], row["text"]), ("webhook_post", "bot", self.a["id"], "Build is green"))
        self.assertEqual(row["meta"]["images"][0]["type"], "png")
        self.assertEqual(self.web.get(f"{BASE}/{room['id']}").json()["unread"], 1)
        self.assertEqual(len(store.queue_list(room["id"])), 0)  # a post starts no turn

    def test_refusals_keep_their_codes_and_clean_up(self):
        room = self.make()
        trigger, secret = self.hook(room, self.a)
        self.assertEqual(self.fire(trigger, secret, {"text": "x", "voice_note": True}, "d-2").status_code, 409)
        self.assertEqual(self.fire(trigger, secret, {"text": "x", "images": ["!!not base64!!"]}, "d-3").status_code, 400)
        self.assertEqual(self.fire(trigger, secret, {"text": "x", "images": [base64.b64encode(b"nope").decode()]}, "d-4").status_code, 400)
        many = [base64.b64encode(PNG).decode()] * 5
        self.assertEqual(self.fire(trigger, secret, {"text": "x", "images": many}, "d-5").status_code, 413)
        self.assertEqual(self.fire(trigger, secret, {"text": "x" * 20_001}, "d-6").status_code, 413)
        self.assertEqual(store.messages(room["id"]), [])
        folder = Path(_DATA.name) / "bot-room-files" / room["id"]
        self.assertFalse(folder.exists() and any(folder.iterdir()), "no staged file is left behind")
        wrong = hmac.new(b"wrong", b"{}", hashlib.sha256).hexdigest()
        bad = self.web.post(f"/api/triggers/{trigger['id']}", content=b"{}", headers={"X-JARVIS-Signature": "sha256=" + wrong})
        self.assertEqual(bad.status_code, 403)

    def test_a_post_trigger_needs_a_real_room_and_a_member_and_dies_with_the_room(self):
        room = self.make()
        with self.assertRaises(ValueError):
            trigger_service.create("x", action="post", room_id="nope", bot_id=self.a["id"])
        outsider = agent_service.create("Cy", role="Tests")
        with self.assertRaises(ValueError):
            trigger_service.create("x", action="post", room_id=room["id"], bot_id=outsider["id"])
        trigger, secret = self.hook(room, self.a)
        self.assertEqual(self.web.delete(f"{BASE}/{room['id']}").status_code, 200)
        self.assertFalse(trigger_service.get(trigger["id"])["enabled"])
        self.assertEqual(self.fire(trigger, secret, {"text": "x"}, "d-9").status_code, 404)  # a disabled trigger is not found


class EventRoute(unittest.IsolatedAsyncioTestCase):
    async def test_events_replay_from_last_event_id_and_say_when_it_cannot(self):
        feed.reset()
        for n in range(3):
            feed.publish("room.message", "r1", {"n": n}, "david")

        class Request:
            headers = {"last-event-id": "1"}
            calls = 0

            async def is_disconnected(self):
                Request.calls += 1
                return Request.calls > 3

        response = await bot_room_routes.events(Request(), None, "david")
        chunks = []
        async for piece in response.body_iterator:
            chunks.append(piece)
        text = "".join(chunks)
        self.assertIn('event: hello\ndata: {"cursor": 3, "reset": false}', text)
        self.assertIn("id: 2\nevent: room.message", text)
        self.assertIn("id: 3\nevent: room.message", text)
        self.assertNotIn("id: 1\n", text)

        class Ahead(Request):
            headers = {"last-event-id": "999"}
        Request.calls = 0
        response = await bot_room_routes.events(Ahead(), None, "david")
        first = await response.body_iterator.__anext__()
        self.assertIn('"reset": true', first)
        await response.body_iterator.aclose()


if __name__ == "__main__":
    unittest.main()
