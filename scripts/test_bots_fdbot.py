"""Phase 5 U1: once-only lifecycle, real stores, admin routes and card ownership."""
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory

_DATA = TestDataDirectory("kairos-fdbot-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_admin, require_user
from core.session_manager import session_manager
from core import session_manager_store as store
from routes import agent_routes, front_desk_routes
from services import front_desk, front_desk_cards as cards, bot_record
from services.agent_service import agent_service
from services.task_service import task_service
REAL_CONNECTIONS = front_desk.connections

app = FastAPI()
app.include_router(front_desk_routes.router)
app.include_router(agent_routes.router)
app.dependency_overrides[require_admin] = lambda: "david"; app.dependency_overrides[require_user] = lambda: "david"
web = TestClient(app)


class FrontDeskCase(unittest.TestCase):
    def setUp(self):
        self.state_file = Path(_DATA.name) / (self.id().split(".")[-1] + ".json")
        for p in (patch.object(front_desk, "STATE_FILE", self.state_file),
                  patch.dict(agent_service._agents, {}, clear=True),
                  patch.dict(task_service._tasks, {}, clear=True),
                  patch("core.model_endpoints.list_endpoints", return_value=[]),
                  patch("services.front_desk.connections", return_value={"mail": False, "calendar": False, "forge_projects": 0}),
                  patch("services.bot_attention.legacy_owner", return_value="david")):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.clean_sessions)

    def clean_sessions(self):
        for header in session_manager.list_sessions(include_agents=True):
            session_manager.delete_session(header["id"])

    def test_seed_once_twice_and_concurrently(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            agents = list(pool.map(lambda _: front_desk.ensure(), range(8)))
        self.assertEqual(len({a["id"] for a in agents}), 1)
        bot = agents[0]
        self.assertEqual((bot["name"], bot["role"], bot["builtin"], bot["order"], bot["daily_run_cap"], bot["approval_mode"]),
                         ("Kip", "Assistant", "front_desk", -1, 100, "edits"))
        self.assertEqual(bot["outbound"], bot_record.new_defaults()["outbound"])
        self.assertEqual(len(session_manager.list_sessions(agent_id=bot["id"])), 1)
        sid = front_desk.main_thread_id()
        session = session_manager.get_session(sid)
        self.assertEqual(session["owner_user"], "david")
        self.assertEqual([m["fd_kind"] for m in session["messages"]], ["welcome", "reach"])
        self.assertEqual(len(session["messages"][0]["fd_data"]["examples"]), 3, "the welcome offers things to try")
        self.assertEqual(len(front_desk.read_state()["morning"]), 3)
        self.assertTrue(front_desk.read_state()["welcome_posted"])

    def test_seed_uses_first_claude_connection(self):
        with patch("core.model_endpoints.list_endpoints", return_value=[
                {"id": "api", "kind": "openai"}, {"id": "claude-one", "kind": "claude_cli"},
                {"id": "claude-two", "kind": "claude_cli"}]):
            bot = front_desk.ensure()
            self.assertEqual(session_manager.get_session(front_desk.main_thread_id())["model_endpoint_id"], "claude-one")
            self.assertEqual(agent_service.chat_endpoint(bot), "claude-one")

    def test_no_recreation_or_read_side_effect_after_stamp(self):
        bot = front_desk.ensure()
        stamp = front_desk.read_state()["seeded_at"]
        agent_service._agents.pop(bot["id"])
        self.assertIsNone(front_desk.ensure())
        self.assertIsNone(front_desk.bot_id())
        self.assertEqual(front_desk.main_thread_id(), "")
        self.assertIsNone(web.get("/api/front-desk/state").json()["bot_id"])
        self.assertEqual(len(agent_service.list_agents()), 0)
        restored = web.post("/api/front-desk/ensure", json={}).json()
        self.assertNotEqual(restored["bot_id"], bot["id"])
        self.assertEqual(front_desk.read_state()["seeded_at"], stamp)
        self.assertEqual(web.post("/api/front-desk/ensure").json()["bot_id"], restored["bot_id"])

    def test_recover_interrupted_stamp_and_intro(self):
        bot = front_desk.ensure()
        self.state_file.unlink()
        self.assertEqual(front_desk.ensure()["id"], bot["id"])
        self.assertEqual(len(agent_service.list_agents()), 1)
        self.assertEqual(len(session_manager.get_session(front_desk.main_thread_id())["messages"]), 2)

    def test_an_earlier_kip_becomes_the_team_lead_once(self):
        # 2026-11-02: Kip asks before anything leaves Kairos, hands work to teammates without asking, and greets
        # once with what it can do now. A Kip the person set back to Full afterwards stays at Full.
        from services import bot_peers
        bot = front_desk.ensure()
        agent_service.mutate_bot(bot["id"], lambda a: a.update(approval_mode="full", soul=front_desk._FIRST_SOUL, blurb=front_desk.LEGACY_BLURBS[0], role="Front desk"))
        front_desk.update_state({"lead_v1": False, "welcome_v2": False})
        front_desk.ensure()
        moved = agent_service.get(bot["id"])
        self.assertEqual((moved["approval_mode"], moved["soul"], moved["blurb"], moved["role"]), ("edits", front_desk.FRONT_DESK_SOUL, front_desk.FRONT_DESK_BLURB, "Assistant"))
        self.assertFalse(bot_peers.state()["approve_peer_comms"][bot["id"]])
        kinds = [m.get("fd_kind") for m in session_manager.get_session(front_desk.main_thread_id())["messages"]]
        self.assertEqual(kinds.count("welcome"), 2, "one greeting, plus one saying what Kip does now")
        agent_service.mutate_bot(bot["id"], lambda a: a.update(approval_mode="full"))
        front_desk.ensure()
        self.assertEqual(agent_service.get(bot["id"])["approval_mode"], "full", "the migration runs once")

    def test_corrupt_stamp_fails_closed(self):
        self.state_file.write_text("{bad json", encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            front_desk.ensure()
        self.assertEqual(agent_service.list_agents(), [])

    def test_state_defaults_and_other_units_fields_survive(self):
        front_desk.update_state({"morning": {"on": False}, "last_presence_at": 12})
        self.assertEqual(front_desk.read_state()["morning"], {"on": False, "time": "08:00", "zone": "UTC"})
        front_desk.ensure()
        self.assertEqual(front_desk.read_state()["last_presence_at"], 12)
        self.assertFalse(front_desk.read_state()["morning"]["on"])

    def test_front_desk_folder_is_covered_by_backup(self):
        from core import backup
        with patch.object(front_desk, "STATE_FILE", Path(_DATA.name) / "front_desk" / "state.json"):
            front_desk.ensure()
            with patch.object(backup, "_vaults_inside", return_value=set()):
                names = {relative for _, relative in backup._files(_DATA.name)}
            self.assertIn("front_desk/state.json", names)

    def test_peers_archive_restore_and_delete_409(self):
        bot = front_desk.ensure()
        one = agent_service.create("Planner")
        two = agent_service.create("Writer")
        agent_service.update(two["id"], hidden=True)
        front_desk.sync_peers()
        self.assertEqual(bot["peers"], [one["id"]])
        routine = task_service.create_task("Check", "Read", "interval", interval_seconds=900, agent_id=bot["id"])
        original = dict(routine)
        self.assertEqual(web.delete(f"/api/agents/{bot['id']}").status_code, 409)
        self.assertEqual(web.patch(f"/api/agents/{bot['id']}", json={"hidden": True}).status_code, 200)
        front_desk.ensure()
        self.assertTrue(bot["hidden"])
        self.assertEqual(task_service.get_task(routine["id"]), original)
        agent_service.update(bot["id"], hidden=False)
        agent_service.update(two["id"], hidden=False)
        agent_service.update(one["id"], hidden=True)
        front_desk.sync_peers()
        self.assertEqual(bot["peers"], [two["id"]])

    def test_name_collision_order_and_personal_changes_survive(self):
        agent_service.create("Kip")
        bot = front_desk.ensure()
        self.assertEqual(bot["name"], "Kip, front desk")
        self.assertEqual(sorted(agent_service.list_agents(), key=bot_record.sort_key)[0]["id"], bot["id"])
        agent_service.update(bot["id"], name="My helper", daily_run_cap=12)
        agent_service.reorder([a["id"] for a in reversed(agent_service.list_agents())])
        snapshot = dict(bot)
        front_desk.ensure()
        self.assertEqual(dict(bot), snapshot)

    def test_soul_and_scripted_routing_rubric(self):
        soul = front_desk.FRONT_DESK_SOUL
        self.assertLess(len(soul.encode()), 24000)
        self.assertNotIn(chr(0x2014), soul)
        for banned in ("openmausbot", "mausbot", "openduet", "duet"):
            self.assertNotIn(banned, soul.lower())
        for ask, expected in [("named bot", "fd_route"), ("existing conversation", "fd_find_chat"),
                              ("code work", "fd_forge_propose"), ("larger work", "fd_start_task"),
                              ("keep or read", "fd_make"), ("one question", "fd_chips")]:
            with self.subTest(ask=ask):
                self.assertIn(ask, soul)
                self.assertIn(expected, soul)

    def test_routes_admin_and_extra_fields(self):
        for route in front_desk_routes.router.routes:
            self.assertIn(require_user, [d.call for d in route.dependant.dependencies])
        self.assertEqual(web.post("/api/front-desk/ensure", json={"owner": "other"}).status_code, 422)
        front_desk.ensure()
        hidden = agent_service.create("Hidden")
        agent_service.update(hidden["id"], hidden=True)
        self.assertNotIn(hidden["id"], [a["id"] for a in web.get("/api/front-desk/roster").json()])
        self.assertEqual(web.get("/api/front-desk/state").json()["needs_input_count"], 0)

    def test_live_connections(self):
        with patch("services.email_service.email_service.list_accounts", return_value=[{"id": "mail"}]), \
             patch("core.google_workspace.status", return_value={"calendar_connected": True}), \
             patch("services.forge_projects.forge_projects.list", return_value=[{"id": "p"}]):
            # Call the real function despite the setup stand-in.
            self.assertEqual(REAL_CONNECTIONS(), {"mail": True, "calendar": True, "forge_projects": 1})

    def test_cards_idempotent_and_server_only(self):
        front_desk.ensure()
        sid = front_desk.main_thread_id()
        first = cards.post_card(sid, "task_link", {"task_id": "t"}, key="task:t")
        self.assertEqual(cards.post_card(sid, "task_link", {"task_id": "other"}, key="task:t"), first)
        updated = cards.update_card(sid, "task:t", {"fd_status": "done", "fd_data": {"task_id": "t"}})
        self.assertEqual(updated["fd_status"], "done")
        for fields in ({"role": "user"}, {"fd_server": False}, {"content": "edit"}, {"fd_kind": "forge"}):
            with self.assertRaises(ValueError):
                cards.update_card(sid, "task:t", fields)
        with self.assertRaises(ValueError):
            cards.post_card(sid, "forge", {}, key="task:t")
        index = session_manager.append_message(sid, "assistant", "", extra={"type": "fd_card", "fd_key": "fake",
                                                "fd_kind": "task_link", "fd_data": {"task_id": "fake"}})
        with self.assertRaises(KeyError):
            cards.update_card(sid, "fake", {"fd_status": "done"})
        self.assertIsNone(store.get_message(sid, index).get("fd_server"))

    def test_notification_once(self):
        front_desk.ensure()
        with patch("core.mobile_activity.enqueue_bot") as push:
            cards.post_card(front_desk.main_thread_id(), "checkin", {"at": 1, "summary": "One new idea"}, key="notify")
            for _ in range(2):
                cards.post_card(front_desk.main_thread_id(), "checkin", {"at": 1, "summary": "One new idea"}, key="notify", notify=True)
            self.assertEqual(push.call_count, 1)

    def test_cards_publish_full_owner_filtered_frames(self):
        front_desk.ensure()
        sid = front_desk.main_thread_id()
        with patch("services.chat_live.broadcast_owner") as publish:
            cards.post_card(sid, "task_link", {"task_id": "t"}, key="frame")
            cards.post_card(sid, "task_link", {"task_id": "t"}, key="frame")
            cards.update_card(sid, "frame", {"fd_status": "done"})
        self.assertEqual(publish.call_count, 2)
        first, second = [call.args[0] for call in publish.call_args_list]
        self.assertEqual(first["type"], "bot.fd_card")
        self.assertEqual(first["sessionId"], sid)
        self.assertEqual(second["message"]["fd_status"], "done")

    def test_shared_wire_samples_through_real_store(self):
        source = (Path(__file__).parent / "fixtures" / "bots-fdbot-backend.cjs").read_text(encoding="utf-8")
        samples = json.loads(source.split("const CARD_SAMPLES = JSON.parse(String.raw`", 1)[1].split("`);", 1)[0])
        front_desk.ensure()
        self.assertEqual(set(samples), cards.KINDS)
        for kind, data in samples.items():
            message = cards.post_card(front_desk.main_thread_id(), kind, data, key=f"wire:{kind}")
            self.assertEqual(message["fd_data"], data, kind)
            self.assertTrue(message["fd_server"])

    def test_brief_caps_order_and_safe_links(self):
        value = cards.clean_data("brief", {"date_label": "Today", "greeting": "Hi", "sections": [
            {"id": "ideas", "label": "Ideas", "rows": []}, {"id": "needs", "label": "Needs you", "rows": [
                {"id": str(i), "text": "hello", "actions": [{"kind": "open_url", "arg": url}]}
                for i, url in enumerate(["https://ok.example/path", "https://u:p@bad.example", "javascript:alert(1)",
                                         "http://bad.example", "https://ok.example/\npath", "https://[broken", "https://last.example"])]}]})
        self.assertEqual([s["id"] for s in value["sections"]], ["needs", "ideas"])
        self.assertEqual(len(value["sections"][0]["rows"]), 6)
        self.assertEqual(value["sections"][0]["more"], 1)
        self.assertEqual(sum(len(r["actions"]) for r in value["sections"][0]["rows"]), 1)
        self.assertNotIn("join_url", cards.clean_data("prep", {"title": "Meet", "when_label": "Now", "lines": [], "join_url": "javascript:bad"}))


if __name__ == "__main__":
    unittest.main()
