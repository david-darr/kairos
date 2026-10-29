"""Bots redesign, Phase 4 unit U2: rooms, their store and rules (2026-10-29).

Throwaway data folder, scripted model. Run:
.venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_rooms.py
"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-rooms-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException  # noqa: E402

from bots_chat_harness import OWNER, Harness  # noqa: E402
from core import bot_rooms_store as store  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import bot_room_events as feed, bot_room_guard, bot_room_turns as turns, bot_rooms as rooms, bot_threads  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20


def refused(testcase, status, fn, *args, **kwargs):
    with testcase.assertRaises(HTTPException) as caught:
        fn(*args, **kwargs)
    testcase.assertEqual(caught.exception.status_code, status, caught.exception.detail)
    return caught.exception


class RoomCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        feed.reset()
        bot_room_guard.reset()
        turns.reset()
        self.addCleanup(turns.reset)
        self.a, self.b = self.h.bot("Ada"), self.h.bot("Bo")

    def room(self, **extra):
        made = rooms.create(OWNER, extra.pop("name", "Planning"), bot_ids=[self.a["id"], self.b["id"]], setup_done=True, **extra)
        self.addCleanup(lambda: store.get_room(made["id"]) and store.delete_room(made["id"]))
        return made


class CrudTests(RoomCase):
    def test_create_defaults_and_shape(self):
        made = self.room(context="Q4", description="Plans")
        self.assertEqual([m["name"] for m in made["members"]], ["Ada", "Bo"])
        self.assertEqual(made["default_responder"], {"kind": "mentions"})  # no side-job engine in this build
        self.assertEqual(made["turn_timeout_minutes"], 5)
        self.assertEqual(len(made["threads"]), 1)
        self.assertEqual(made["setup_state"], "done")
        pending = rooms.create(OWNER, "Pending", bot_ids=[self.a["id"]])
        self.addCleanup(store.delete_room, pending["id"])
        self.assertEqual(pending["setup_state"], "pending")

    def test_limits_and_validation(self):
        ids = [self.a["id"]]
        refused(self, 422, rooms.create, OWNER, "", bot_ids=ids)
        refused(self, 422, rooms.create, OWNER, "x" * 101, bot_ids=ids)
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, context="c" * 61)
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, description="d" * 121)
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, turn_timeout_minutes=0)
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, turn_timeout_minutes=1441)
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=[])
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=["nobody"])
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, default_responder={"kind": "member", "bot_id": self.b["id"]})
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, default_responder={"kind": "nonsense"})
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, cwd=os.path.join(_DATA.name, "missing-folder"))
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=ids, cwd=os.path.abspath(os.sep))  # a filesystem root is not a folder to work in

    def test_working_folder_is_vetted_and_reaches_new_and_existing_seats(self):
        folder = Path(_DATA.name) / "work"
        folder.mkdir(exist_ok=True)
        made = self.room(cwd=str(folder))
        self.assertEqual(made["cwd"], os.path.realpath(folder))
        seat = rooms.ensure_seat(made["id"], self.a["id"])
        self.assertEqual(session_manager.get_session(seat)["workspace_dir"], os.path.realpath(folder))
        other = Path(_DATA.name) / "other"
        other.mkdir(exist_ok=True)
        rooms.update(OWNER, made["id"], {"cwd": str(other)})
        self.assertEqual(session_manager.get_session(seat)["workspace_dir"], os.path.realpath(other))
        refused(self, 422, rooms.update, OWNER, made["id"], {"cwd": str(Path(_DATA.name) / "nope")})
        self.assertIsNone(rooms.update(OWNER, made["id"], {"cwd": None})["cwd"])
        self.assertIsNone(session_manager.get_session(seat)["workspace_dir"])
        setup = rooms.create(OWNER, "Setup folder", bot_ids=[self.a["id"]])
        self.addCleanup(store.delete_room, setup["id"])
        self.assertEqual(rooms.setup(OWNER, setup["id"], "complete", cwd=str(folder))["cwd"], os.path.realpath(folder))

    def test_hidden_bots_cannot_join(self):
        agent_service._agents[self.b["id"]]["hidden"] = True
        refused(self, 422, rooms.create, OWNER, "ok", bot_ids=[self.b["id"]])

    def test_update_fields_revision_and_responder_cleanup(self):
        made = self.room()
        changed = rooms.update(OWNER, made["id"], {"name": "Roadmap", "bulletin": "Be brief",
                                                   "default_responder": {"kind": "member", "bot_id": self.b["id"]}})
        self.assertEqual((changed["name"], changed["bulletin"]), ("Roadmap", "Be brief"))
        self.assertEqual(changed["revision"], made["revision"] + 1)
        refused(self, 409, rooms.update, OWNER, made["id"], {"name": "Stale"}, made["revision"])
        left = rooms.update(OWNER, made["id"], {"member_ids": [self.a["id"]]})
        self.assertEqual([m["bot_id"] for m in left["members"]], [self.a["id"]])
        self.assertEqual(left["default_responder"], {"kind": "mentions"})  # the lead left, so the default fell back
        refused(self, 422, rooms.update, OWNER, made["id"], {"member_ids": []})

    def test_owner_isolation_and_missing(self):
        made = self.room()
        refused(self, 404, rooms.get, made["id"], "someone-else")
        refused(self, 404, rooms.get, "nope", OWNER)
        refused(self, 404, rooms.update, "someone-else", made["id"], {"name": "x"})

    def test_member_changes_refused_while_working(self):
        made = self.room()
        turns._WAITING[(made["id"], self.a["id"])] = 1
        refused(self, 409, rooms.update, OWNER, made["id"], {"member_ids": [self.a["id"]]})
        turns._WAITING.clear()
        rooms.update(OWNER, made["id"], {"member_ids": [self.a["id"]]})

    def test_delete_refused_while_working_and_cleans_up(self):
        made = self.room()
        seat = rooms.ensure_seat(made["id"], self.a["id"])
        self.assertIsNotNone(session_manager.get_session(seat))
        turns._WORKERS[(made["id"], made["threads"][0]["id"])] = SimpleNamespace(done=lambda: False, cancel=lambda: None)
        refused(self, 409, rooms.delete, OWNER, made["id"])
        turns._WORKERS.clear()
        self.assertEqual(rooms.delete(OWNER, made["id"])["deleted"], True)
        self.assertIsNone(store.get_room(made["id"]))
        self.assertIsNone(session_manager.get_session(seat))
        self.assertEqual(store.messages(made["id"]), [])

    def test_a_deleted_bot_leaves_and_an_empty_room_archives(self):
        made = self.room()
        rooms.bot_deleted(self.b["id"])
        self.assertEqual([m["bot_id"] for m in store.members(made["id"])], [self.a["id"]])
        rooms.bot_deleted(self.a["id"])
        self.assertTrue(store.get_room(made["id"])["archived_at"])
        self.assertEqual(rooms.can_speak(self.a["id"], made["id"]).ok, False)


class SetupAndVerdictTests(RoomCase):
    def test_setup_flow_and_can_speak(self):
        made = rooms.create(OWNER, "Fresh", bot_ids=[self.a["id"], self.b["id"]])
        self.addCleanup(store.delete_room, made["id"])
        self.assertEqual(rooms.can_speak(self.a["id"], made["id"]).reason, "That room has not finished setup yet.")
        done = rooms.setup(OWNER, made["id"], "complete", bulletin="Keep it short",
                           default_responder={"kind": "member", "bot_id": self.a["id"]})
        self.assertEqual((done["setup_state"], done["bulletin"]), ("done", "Keep it short"))
        self.assertTrue(rooms.can_speak(self.a["id"], made["id"]))
        self.assertFalse(rooms.can_speak("outsider", made["id"]))
        self.assertFalse(rooms.can_speak(self.a["id"], "no-room"))
        skipped = rooms.create(OWNER, "Skip", bot_ids=[self.a["id"]])
        self.addCleanup(store.delete_room, skipped["id"])
        self.assertEqual(rooms.setup(OWNER, skipped["id"], "skip")["setup_state"], "skipped")
        refused(self, 422, rooms.setup, OWNER, skipped["id"], "explode")

    def test_disclosure_is_empty(self):
        self.assertEqual(rooms.disclosure(), "")


class ThreadAndMessageTests(RoomCase):
    def test_threads_keep_one_and_bulk_is_bounded(self):
        made = self.room()
        first = made["threads"][0]["id"]
        second = rooms.create_thread(OWNER, made["id"], "Second")
        self.assertEqual(rooms.rename_thread(OWNER, made["id"], second["id"], "Renamed")["title"], "Renamed")
        self.assertEqual(rooms.delete_threads(OWNER, made["id"], [first, second["id"]])["deleted"], [first])  # one stays
        self.assertEqual(len(store.threads(made["id"])), 1)
        refused(self, 422, rooms.delete_threads, OWNER, made["id"], [])
        refused(self, 422, rooms.delete_threads, OWNER, made["id"], [str(n) for n in range(501)])
        refused(self, 404, rooms.thread_or_404, made["id"], "nope")

    def test_messages_page_and_around(self):
        made = self.room()
        thread = made["threads"][0]["id"]
        ids = [rooms.add_row(made["id"], thread, "person", f"line {n}", send_id=f"send-{n:04d}")[0]["id"] for n in range(30)]
        page = rooms.messages(OWNER, made["id"], limit=10)
        self.assertEqual([m["text"] for m in page["messages"]], [f"line {n}" for n in range(20, 30)])
        self.assertTrue(page["has_more"])
        older = rooms.messages(OWNER, made["id"], limit=10, before=page["messages"][0]["seq"])
        self.assertEqual(older["messages"][-1]["text"], "line 19")
        around = rooms.messages(OWNER, made["id"], limit=6, around=ids[15])
        texts = [m["text"] for m in around["messages"]]
        self.assertIn("line 15", texts)
        self.assertEqual(len(texts), 6)
        self.assertEqual(rooms.messages(OWNER, made["id"], limit=9999)["messages"].__len__(), 30)
        refused(self, 404, rooms.messages, OWNER, made["id"], around="nope")

    def test_sequence_has_no_gaps_and_send_id_is_idempotent(self):
        made = self.room()
        thread = made["threads"][0]["id"]
        one, created = rooms.add_row(made["id"], thread, "person", "hi", send_id="send-0001")
        again, created_again = rooms.add_row(made["id"], thread, "person", "hi", send_id="send-0001")
        self.assertEqual((created, created_again, one["id"] == again["id"]), (True, False, True))
        two, _ = rooms.add_row(made["id"], thread, "bot", "yo", bot_id=self.a["id"])
        self.assertEqual((one["seq"], two["seq"]), (1, 2))

    def test_unread_counts_bot_messages_until_read(self):
        made = self.room()
        thread = made["threads"][0]["id"]
        rooms.add_row(made["id"], thread, "bot", "a", bot_id=self.a["id"])
        rooms.add_row(made["id"], thread, "bot", "b", bot_id=self.b["id"])
        self.assertEqual(rooms.public(store.get_room(made["id"]))["unread"], 2)
        self.assertEqual(rooms.mark_read(OWNER, made["id"])["unread"], 0)


class SeatTests(RoomCase):
    def test_seat_is_an_unattended_room_session_hidden_from_the_bot(self):
        made = self.room()
        before = bot_threads.list_threads(self.a)["threads"]
        seat = rooms.ensure_seat(made["id"], self.a["id"])
        self.assertEqual(rooms.ensure_seat(made["id"], self.a["id"]), seat)  # lazy and stable
        session = session_manager.get_session(seat)
        self.assertEqual(session["thread"]["opened_by"], "room")
        self.assertTrue(session.get("agent_unattended"))
        self.assertEqual(session["agent_id"], self.a["id"])
        self.assertEqual(bot_threads.list_threads(self.a)["threads"], before)
        self.assertIsNone(bot_threads.ensure_main_threads(self.a["id"])[self.a["id"]])  # a seat is never the main thread
        self.assertEqual(store.room_for_seat(seat), (made["id"], self.a["id"]))

    def test_each_member_gets_its_own_seat(self):
        made = self.room()
        self.assertNotEqual(rooms.ensure_seat(made["id"], self.a["id"]), rooms.ensure_seat(made["id"], self.b["id"]))


class WebhookAndReportTests(RoomCase):
    def test_webhook_post_order_and_images(self):
        made = self.room()
        ok = rooms.post_webhook(made["id"], self.a["id"], "build finished", images=[PNG])
        self.assertEqual((ok["kind"], ok["role"], ok["bot_id"]), ("webhook_post", "bot", self.a["id"]))
        self.assertEqual(ok["meta"]["images"][0]["type"], "png")
        self.assertEqual(rooms.public(store.get_room(made["id"]))["unread"], 1)
        refused(self, 400, rooms.post_webhook, made["id"], self.a["id"], "")
        refused(self, 400, rooms.post_webhook, made["id"], self.a["id"], "x", images=[b"not an image"])
        refused(self, 413, rooms.post_webhook, made["id"], self.a["id"], "x" * 20_001)
        refused(self, 413, rooms.post_webhook, made["id"], self.a["id"], "x", images=[PNG] * 5)
        refused(self, 404, rooms.post_webhook, "nope", self.a["id"], "x")
        outsider = self.h.bot("Outsider")
        refused(self, 403, rooms.post_webhook, made["id"], outsider["id"], "x")
        refused(self, 409, rooms.post_webhook, made["id"], self.a["id"], "x", voice_note=True)
        # a bad payload is refused before the room is even looked up
        refused(self, 400, rooms.post_webhook, "nope", self.a["id"], "x", images=[b"bad"])

    def test_post_report_lands_as_a_card_from_the_assignee(self):
        made = self.room()
        thread = made["threads"][0]["id"]
        assignment = {"id": "as1", "requester": {"kind": "room", "room_id": made["id"], "thread_id": thread},
                      "assignee_bot_id": self.b["id"], "status": "completed", "outcome": "done", "title": "Pull numbers",
                      "result": "Revenue is up.", "evidence": {"tools": 2}}
        self.assertTrue(rooms.post_report(assignment))
        row = store.messages(made["id"], thread)[-1]
        self.assertEqual((row["kind"], row["bot_id"]), ("card", self.b["id"]))
        self.assertIn("Revenue is up.", row["text"])
        outsider = self.h.bot("Outsider")
        self.assertFalse(rooms.post_report({**assignment, "assignee_bot_id": outsider["id"]}))
        self.assertFalse(rooms.post_report({**assignment, "requester": {"kind": "chat"}}))


class ConnectTests(RoomCase):
    async def test_connect_registers_the_room_sink_and_the_delete_hook_once(self):
        from types import ModuleType
        from unittest.mock import patch
        sinks, hooks = {}, []
        fake = ModuleType("services.bot_assignments")
        fake.register_sink = lambda kind, fn: sinks.__setitem__(kind, fn)
        import services
        rooms._connected = False
        self.addCleanup(setattr, rooms, "_connected", False)
        with patch.dict(sys.modules, {"services.bot_assignments": fake}), patch.object(services, "bot_assignments", fake, create=True),                 patch.object(agent_service, "on_delete", hooks.append, create=True):
            rooms.connect()
            rooms.connect()
        self.assertEqual(sinks, {"room": rooms.post_report})
        self.assertEqual(hooks, [rooms.bot_deleted])

    async def test_startup_interrupts_running_turns_and_resumes_the_queue(self):
        made = self.room()
        thread = made["threads"][0]["id"]
        store.turn_start(made["id"], thread, self.a["id"], hop=0, origin="person", attended=True, deadline=None)
        result = await rooms.startup()
        self.assertEqual(result["interrupted"], 1)
        self.assertEqual(store.turns(made["id"])[0]["outcome"], "interrupted")


class StoreTests(unittest.TestCase):
    def test_restart_marks_running_turns_interrupted(self):
        room = store.create_room("o", "R", default_responder={"kind": "mentions"}, member_ids=["x"])
        self.addCleanup(store.delete_room, room["id"])
        thread = store.threads(room["id"])[0]["id"]
        turn = store.turn_start(room["id"], thread, "x", hop=0, origin="person", attended=True, deadline=None)
        self.assertEqual(store.interrupt_running(), 1)
        ended = store.turn_get(turn["id"])
        self.assertEqual((ended["status"], ended["outcome"]), ("ended", "interrupted"))

    def test_queue_states_and_pruning(self):
        room = store.create_room("o", "R", default_responder={"kind": "mentions"}, member_ids=["x"])
        self.addCleanup(store.delete_room, room["id"])
        thread = store.threads(room["id"])[0]["id"]
        rows = [store.queue_add(room["id"], thread, {"text": str(n)}, f"s{n}") for n in range(3)]
        self.assertEqual([r["sequence"] for r in rows], [1, 2, 3])
        store.queue_mark([rows[0]["id"]], "dispatching")
        self.assertEqual(len(store.queue_list(room["id"], thread)), 3)
        store.queue_mark([rows[0]["id"]], "consumed")
        self.assertEqual(len(store.queue_list(room["id"], thread)), 2)
        self.assertEqual(store.queue_mark([rows[1]["id"]], "cancelled", only_from=("consumed",)), 0)


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_replay_gap_and_reset(self):
        feed.reset()
        for n in range(3):
            feed.publish("room.message", "r1", {"n": n}, "me")
        queue, hello = feed.subscribe("me", 1)
        self.assertFalse(hello["reset"])
        self.assertEqual([queue.get_nowait()["data"]["n"], queue.get_nowait()["data"]["n"]], [1, 2])
        _, ahead = feed.subscribe("me", 99)  # newer than the server knows: a restart
        self.assertTrue(ahead["reset"])
        feed.unsubscribe(queue)

    async def test_ring_buffer_is_bounded_and_owner_filtered(self):
        feed.reset()
        for n in range(feed.MAX_FRAMES + 20):
            feed.publish("room.chunk", "r1", {"n": n}, "me")
        self.assertEqual(len(feed._FRAMES), feed.MAX_FRAMES)
        _, stale = feed.subscribe("me", 1)
        self.assertTrue(stale["reset"])
        feed.publish("room", "r2", {}, "other")
        queue, _ = feed.subscribe("me", feed.cursor() - 1)
        self.assertTrue(queue.empty())
        live, _ = feed.subscribe("me")
        feed.publish("room", "r3", {}, "me")
        feed.publish("room", "r4", {}, "other")
        self.assertEqual(live.get_nowait()["room_id"], "r3")
        self.assertTrue(live.empty())
        feed.unsubscribe(live)

    async def test_sse_format(self):
        feed.reset()
        frame = feed.publish("room.message", "r1", {"x": 1}, "me")
        text = feed.sse(frame)
        self.assertTrue(text.startswith(f"id: {frame['id']}\nevent: room.message\ndata: "))
        self.assertTrue(text.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()
