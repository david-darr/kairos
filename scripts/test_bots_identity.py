"""Bots Phase 1, unit U2: identity fields, soul limits, self proposals (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-1-design.md, sections 3.1, 5.2 and 8 (U2).
Runs against a throwaway data folder; no model is called. Run:
    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_identity.py
"""
import asyncio
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-identity-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import tool_registry  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import agent_routes  # noqa: E402
from services import bot_record  # noqa: E402
from services.agent_service import SOUL_LIMIT_BYTES, agent_service, identity_block  # noqa: E402

app = FastAPI()
app.include_router(agent_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)

_COUNTER = [0]


def make_bot(**fields):
    _COUNTER[0] += 1
    return agent_service.create(f"Identity bot {_COUNTER[0]}", role="Tests things", **fields)


class IdentityFieldTests(unittest.TestCase):
    def setUp(self):
        self.bot = make_bot()
        self.addCleanup(lambda: agent_service.get(self.bot["id"]) and agent_service.delete(self.bot["id"]))

    def patch(self, **body):
        return web.patch(f"/api/agents/{self.bot['id']}", json=body)

    def test_a_new_bot_has_every_default_and_the_upgrade_is_idempotent(self):
        agent = agent_service.get(self.bot["id"])
        self.assertEqual((agent["reply_style"], agent["notifications"], agent["speak_replies"], agent["voice_id"],
                          agent["call_mode"], agent["skill_selection"], agent["avatar_image"],
                          agent["mascot_expression"]),
                         ("default", True, False, None, "turns", {"mode": "all", "disabled": []}, None, None))
        record = copy.deepcopy(agent)
        before = copy.deepcopy(record)
        self.assertFalse(bot_record.upgrade(record), "an upgraded record is already current")
        self.assertEqual(record, before)
        old = {k: v for k, v in agent.items() if k not in ("reply_style", "notifications", "skill_selection")}
        self.assertTrue(bot_record.upgrade(old))
        self.assertEqual((old["reply_style"], old["notifications"]), ("default", True))
        self.assertFalse(bot_record.upgrade(old))

    def test_each_field_saves_and_is_checked(self):
        ok = self.patch(reply_style="conversational", notifications=False, speak_replies=True, call_mode="turns",
                        voice_id="voice:one", mascot_expression="thinking",
                        skill_selection={"mode": "all", "disabled": ["a-skill", "a-skill", "b"]})
        self.assertEqual(ok.status_code, 200, ok.text)
        body = ok.json()
        self.assertEqual((body["reply_style"], body["notifications"], body["speak_replies"], body["voice_id"]),
                         ("conversational", False, True, "voice:one"))
        self.assertEqual(body["skill_selection"], {"mode": "all", "disabled": ["a-skill", "b"]})
        for bad in ({"reply_style": "shouting"}, {"notifications": "yes"}, {"speak_replies": 1},
                    {"call_mode": "video"}, {"voice_id": "bad voice!"}, {"mascot_expression": "angry"},
                    {"skill_selection": {"mode": "only", "disabled": []}},
                    {"skill_selection": {"mode": "all", "disabled": ["x"] * 3 + [123]}},
                    {"avatar_image": {"asset_id": "nope", "shape": "circle", "zoom": 1, "focus_x": 0, "focus_y": 0}},
                    {"avatar_image": {"asset_id": "a" * 32, "shape": "triangle", "zoom": 1, "focus_x": 0, "focus_y": 0}},
                    {"avatar_image": {"asset_id": "a" * 32, "shape": "circle", "zoom": 4, "focus_x": 0, "focus_y": 0}},
                    {"avatar_image": {"asset_id": "a" * 32, "shape": "circle", "zoom": 1, "focus_x": 2, "focus_y": 0}}):
            self.assertIn(self.patch(**bad).status_code, (400, 422), bad)

    def test_a_foreign_avatar_asset_is_refused(self):
        other = make_bot()
        self.addCleanup(lambda: agent_service.delete(other["id"]))
        from services import bot_avatar_service as avatars
        from PIL import Image
        import io
        buffer = io.BytesIO()
        Image.new("RGB", (8, 8), (10, 20, 30)).save(buffer, "PNG")
        staged = avatars.store(avatars.bot_scope(other["id"]), buffer.getvalue())
        framing = {"asset_id": staged["asset_id"], "shape": "circle", "zoom": 1, "focus_x": 0.5, "focus_y": 0.5}
        response = self.patch(avatar_image=framing)
        self.assertEqual(response.status_code, 400)
        self.assertIn("does not belong", response.json()["detail"])

    def test_soul_limit_counts_utf8_bytes_and_leaves_the_stored_text_alone(self):
        self.assertEqual(self.patch(soul="a" * SOUL_LIMIT_BYTES).status_code, 200)
        self.assertEqual(self.patch(soul="a" * SOUL_LIMIT_BYTES + "b").status_code, 400)
        # Each of these is two bytes, so half the limit plus one is over.
        self.assertEqual(self.patch(soul="é" * (SOUL_LIMIT_BYTES // 2 + 1)).status_code, 400)
        self.assertEqual(len(agent_service.get(self.bot["id"])["soul"]), SOUL_LIMIT_BYTES)
        report = web.get(f"/api/agents/{self.bot['id']}/soul").json()
        self.assertEqual((report["bytes"], report["limit"]), (SOUL_LIMIT_BYTES, SOUL_LIMIT_BYTES))

    def test_expected_revision_rejects_a_stale_client(self):
        revision = agent_service.get(self.bot["id"])["revision"]
        self.assertEqual(self.patch(role="One", expected_revision=revision).status_code, 200)
        stale = self.patch(role="Two", expected_revision=revision)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(agent_service.get(self.bot["id"])["role"], "One")
        self.assertEqual(self.patch(role="Three").status_code, 200, "clients that send no revision are unchanged")

    def test_the_default_prompt_bytes_do_not_move_with_the_new_preferences(self):
        agent = agent_service.get(self.bot["id"])
        base = identity_block(agent, "", chat=True)
        self.patch(reply_style="conversational", notifications=False, speak_replies=True, voice_id="v",
                   mascot_expression="idle")
        changed = identity_block(agent_service.get(self.bot["id"]), "", chat=True)
        self.assertEqual(base, changed)
        snapshot = agent_service.prompt_snapshot(self.bot["id"])
        self.assertEqual(snapshot["text"], identity_block(agent_service.get(self.bot["id"]),
                                                          agent_service.read_memory(self.bot["id"]), chat=True))
        self.assertEqual(snapshot["revision"], agent_service.get(self.bot["id"])["revision"])

    def test_creation_duplicate_and_presets_carry_preferences_but_no_grants(self):
        created = web.post("/api/agents/configured", json={"profile": {
            "name": "Preference bot", "reply_style": "conversational", "notifications": False,
            "avatar_image": None}})
        self.assertEqual(created.status_code, 200, created.text)
        agent = created.json()["agent"]
        self.addCleanup(lambda: agent_service.delete(agent["id"]))
        self.assertEqual((agent["reply_style"], agent["notifications"]), ("conversational", False))
        twin = web.post(f"/api/agents/{agent['id']}/duplicate", json={}).json()
        self.addCleanup(lambda: agent_service.delete(twin["id"]))
        self.assertEqual((twin["reply_style"], twin["notifications"]), ("conversational", False))
        preset = bot_record.preset_from_agent(agent_service.get(agent["id"]))
        for key in ("reply_style", "notifications", "avatar_image", "tool_scope", "approval_mode"):
            self.assertNotIn(key, preset)
        for key in ("avatar_image", "tool_scope", "connector_scopes", "approval_mode", "always_allow"):
            self.assertNotIn(key, bot_record.DEFAULT_FIELDS)


class ProposalTests(unittest.TestCase):
    """The bot changing itself (Phase 1 5.2): identity and validated model fields only."""

    def setUp(self):
        from core.session_manager import session_manager
        self.bot = make_bot()
        self.chat = session_manager.create_session("Own chat")
        agent_service.make_agent_chat(self.chat["id"], agent_service.get(self.bot["id"]))
        self.sessions = session_manager

        def cleanup():
            session_manager.delete_session(self.chat["id"])
            if agent_service.get(self.bot["id"]):
                agent_service.delete(self.bot["id"])
        self.addCleanup(cleanup)

    def call(self, name, args, session_id=None):
        ctx = tool_registry.ToolContext(agent_id=self.bot["id"], session_id=session_id)
        return asyncio.run(tool_registry.call(name, args, ctx, tool_registry.OPENAI))

    def test_the_tools_are_registered_once_for_agents_and_need_the_bots_own_chat(self):
        for name in ("agent_propose_profile", "agent_propose_model", "agent_profile_undo"):
            spec = tool_registry._REGISTRY[name]
            self.assertTrue(spec.agent_only)
            self.assertEqual(spec.effect, tool_registry.WRITE)
            self.assertNotIn(f"mcp__hive_mind__{name}", tool_registry.claude_preapproved(agent=True))
        self.assertIn("only works in your own chat",
                      self.call("agent_propose_profile", {"changes": {"role": "x"}, "reason": "y"}))
        self.assertNotEqual(agent_service.get(self.bot["id"])["role"], "x")

    def test_a_profile_proposal_applies_with_a_diff_history_and_a_stale_safe_undo(self):
        text = self.call("agent_propose_profile", {"changes": {"role": "Finds roles", "blurb": "Scout"},
                                                   "reason": "You asked me to."}, self.chat["id"])
        self.assertIn("Applied", text)
        agent = agent_service.get(self.bot["id"])
        self.assertEqual((agent["role"], agent["blurb"]), ("Finds roles", "Scout"))
        receipt = agent["profile_proposals"][-1]
        self.assertEqual(receipt["before"]["role"], "Tests things")
        rows = agent_service.profile_history(self.bot["id"])["rows"]
        self.assertTrue(any(r["actor"] == "bot" and r["receipt_id"] == receipt["id"] and r["field"] == "role"
                            for r in rows))
        self.assertIn("Undone", self.call("agent_profile_undo", {"receipt_id": receipt["id"]}, self.chat["id"]))
        self.assertEqual(agent_service.get(self.bot["id"])["role"], "Tests things")
        self.assertEqual(agent_service.get(self.bot["id"])["profile_proposals"][-1]["state"], "undone")
        self.assertIn("Not undone", self.call("agent_profile_undo", {"receipt_id": receipt["id"]}, self.chat["id"]))

    def test_undo_is_refused_after_a_later_edit_and_keeps_that_edit(self):
        agent_service.propose_profile(self.bot["id"], {"role": "First"}, "Because.")
        receipt = agent_service.get(self.bot["id"])["profile_proposals"][-1]
        agent_service.update(self.bot["id"], blurb="Hand edit")
        with self.assertRaises(bot_record.BotConflict):
            agent_service.undo_profile_proposal(self.bot["id"], receipt["id"], receipt["revision"])
        response = web.post(f"/api/agents/{self.bot['id']}/proposals/{receipt['id']}/undo",
                            json={"expected_revision": receipt["revision"]})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(agent_service.get(self.bot["id"])["role"], "First")
        self.assertEqual(agent_service.get(self.bot["id"])["blurb"], "Hand edit")

    def test_the_route_undo_works_at_the_receipts_revision(self):
        agent_service.propose_profile(self.bot["id"], {"name": "Renamed bot"}, "Because.")
        receipt = agent_service.get(self.bot["id"])["profile_proposals"][-1]
        response = web.post(f"/api/agents/{self.bot['id']}/proposals/{receipt['id']}/undo",
                            json={"expected_revision": receipt["revision"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["agent"]["name"], self.bot["name"])
        self.assertEqual(web.post(f"/api/agents/{self.bot['id']}/proposals/nope/undo",
                                  json={"expected_revision": 1}).status_code, 404)

    def test_a_proposal_cannot_widen_reach_or_skip_a_reason(self):
        for changes in ({"approval_mode": "full"}, {"tool_scope": {"allow": ["native:x"], "deny": []}},
                        {"peers": []}, {"integration_ids": None}, {"deliver_to_channel": "x"},
                        {"daily_run_cap": 200}, {"always_allow": ["native:x"]}, {"enabled": True}, {}):
            with self.assertRaises(ValueError, msg=str(changes)):
                agent_service.propose_profile(self.bot["id"], changes, "Because.")
        with self.assertRaises(ValueError):
            agent_service.propose_profile(self.bot["id"], {"role": "x"}, "  ")
        with self.assertRaises(ValueError):
            agent_service.propose_profile(self.bot["id"], {"role": "x"}, "y" * 501)
        with self.assertRaises(ValueError):
            agent_service.propose_profile(self.bot["id"], {"role": "x"}, "Because.", kind="model")
        self.assertEqual(agent_service.get(self.bot["id"])["role"], "Tests things")

    def test_a_model_proposal_is_validated_like_the_persons_own_choice(self):
        with self.assertRaises(ValueError):
            agent_service.propose_profile(self.bot["id"], {"model_override": "gpt-whatever"}, "Because.",
                                          kind="model")
        self.assertEqual(agent_service.get(self.bot["id"]).get("model_override"), self.bot.get("model_override"))
        self.assertIn("Not applied", self.call("agent_propose_model",
                                               {"changes": {"endpoint_id": "no-such"}, "reason": "Because."},
                                               self.chat["id"]))


if __name__ == "__main__":
    unittest.main()
