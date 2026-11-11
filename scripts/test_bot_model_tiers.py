"""Model tiers for team templates (David, 2026-11-11): each tier becomes a model from the connections this account
really has, the import preview shows and lets the person change it, an import never picks a provider the account has
not connected, and Suggest models only proposes until applied. Run: python scripts/test_bot_model_tiers.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="kairos-model-tiers-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import model_catalog, model_endpoints  # noqa: E402
from services import bot_model_tiers as tiers, bot_package, bot_departments, bot_attention  # noqa: E402
from services import studio_team_package as studio_team  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

CLAUDE = {"id": "c1", "kind": "claude_cli", "name": "Claude", "model": ""}
CODEX = {"id": "x1", "kind": "codex_cli", "name": "Codex", "model": ""}
AGY = {"id": "g1", "kind": "antigravity_cli", "name": "Antigravity", "model": ""}
API = {"id": "a1", "kind": "api", "name": "OpenRouter", "model": "some/model-70b"}
LOCAL = {"id": "l1", "kind": "local", "name": "Ollama", "model": "llama3"}
CODEX_MODELS = [
    {"id": "gpt-6", "display_name": "GPT-6", "supported_efforts": [{"effort": e} for e in ("low", "medium", "high")]},
    {"id": "gpt-6-mini", "display_name": "GPT-6 mini", "supported_efforts": [{"effort": e} for e in ("low", "medium")]},
]


ORIGINAL = model_catalog.list_models


class Resolution(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(model_catalog, "list_models", side_effect=lambda kind: CODEX_MODELS if kind == "codex_cli" else ORIGINAL(kind))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_claude_maps_strong_standard_light_to_opus_sonnet_haiku(self):
        got = {t: tiers.resolve(t, [CLAUDE]) for t in tiers.TIERS}
        self.assertEqual({t: g["model_override"] for t, g in got.items()},
                         {"strong": "claude-opus-5-5", "standard": "claude-sonnet-5-5", "light": "claude-haiku-5-5"})
        self.assertTrue(all(g["endpoint_id"] == "c1" and not g["note"] for g in got.values()))

    def test_codex_uses_its_mini_for_light_and_the_effort_for_the_rest(self):
        self.assertEqual(tiers.resolve("light", [CODEX])["model_override"], "gpt-6-mini")
        strong = tiers.resolve("strong", [CODEX])
        self.assertEqual((strong["model_override"], strong["model_effort"]), ("gpt-6", "high"))

    def test_antigravity_uses_argon_for_judgment_and_flash_for_routine(self):
        self.assertIn("argon", tiers.resolve("strong", [AGY])["model_override"])
        self.assertIn("flash", tiers.resolve("light", [AGY])["model_override"])

    def test_one_model_connections_fall_back_and_say_so(self):
        light = tiers.resolve("light", [API])
        self.assertEqual(light["endpoint_id"], "a1")
        self.assertIn("No light model is connected", light["note"])

    def test_the_default_provider_wins_and_another_connected_one_fills_a_gap(self):
        self.assertEqual(tiers.resolve("strong", [API, CLAUDE])["endpoint_id"], "c1")  # Claude is the new-bot default
        borrowed = tiers.resolve("light", [API, CODEX], prefer="a1")
        self.assertEqual(borrowed["endpoint_id"], "x1")
        self.assertIn("has no light model", borrowed["note"])

    def test_nothing_connected_picks_nothing(self):
        self.assertIsNone(tiers.resolve("strong", []))
        plan = tiers.plan([{"key": "bot-1", "name": "P", "model_tier": "strong"}], [])
        self.assertIn("Settings > Models", plan["rows"][0]["note"])
        self.assertFalse(plan["connected"])

    def test_never_an_unconnected_provider_for_any_set(self):
        sets = [[CLAUDE], [CODEX], [AGY], [API], [LOCAL], [API, LOCAL], [CODEX, AGY], [LOCAL, CLAUDE, API], [AGY, API, CODEX, CLAUDE]]
        for endpoints in sets:
            ids = {e["id"] for e in endpoints}
            for tier in tiers.TIERS:
                with self.subTest(endpoints=[e["id"] for e in endpoints], tier=tier):
                    self.assertIn(tiers.resolve(tier, endpoints)["endpoint_id"], ids)
            self.assertTrue({o["endpoint_id"] for o in tiers.options(endpoints)} <= ids)

    def test_the_cost_line_is_relative_and_plain(self):
        line = tiers.cost_line(["strong", "strong", "standard", "standard", "standard", "light", "light"])
        self.assertIn("% of running every bot on a strong model", line)
        self.assertNotIn("—", line)
        self.assertEqual(tiers.cost_line(["strong"]), "Estimated cost: the same as every bot on a strong model.")


class ImportAndSuggest(unittest.TestCase):
    def setUp(self):
        self.made = []
        self.endpoints = []

    def tearDown(self):
        for bot in agent_service.list_agents():
            agent_service.delete(bot["id"])
        for ident in self.endpoints:
            model_endpoints.delete_endpoint(ident)

    def connect(self, **kw):
        endpoint = model_endpoints.create_endpoint(**kw)
        self.endpoints.append(endpoint["id"])
        return endpoint

    def inspect(self):
        raw = json.dumps(studio_team.build()).encode()
        return bot_package.inspect(raw, owner_user=bot_attention.legacy_owner())

    def test_the_content_template_declares_a_tier_per_role(self):
        bots = {b["name"]: b["model_tier"] for b in studio_team.build()["bots"]}
        self.assertEqual(bots, {"Producer": "strong", "Researcher": "standard", "Evaluator": "standard",
                                "Script Writer": "strong", "Editor": "standard", "Publisher": "light", "Executor": "light"})

    def test_the_preview_shows_role_tier_and_model_and_the_import_uses_the_picks(self):
        claude = self.connect(name="Claude", kind="claude_cli")
        result = self.inspect()
        plan = result["preview"]["models"]
        self.assertEqual(len(plan["rows"]), 7)
        producer = next(r for r in plan["rows"] if r["name"] == "Producer")
        self.assertEqual((producer["tier"], producer["choice"]["model_override"]), ("strong", "claude-opus-5-5"))
        self.assertTrue(producer["role"])
        self.assertIn("Estimated cost", plan["cost"])
        haiku = next(o["value"] for o in plan["options"] if o["model_override"] == "claude-haiku-5-5")
        done = bot_package.import_(result["token"], {"bots": [b["key"] for b in studio_team.BOTS],
                                                    "sections": ["departments"], "models": {"bot-1": haiku}},
                                   owner_user=bot_attention.legacy_owner())
        by_name = {row["name"]: agent_service.get(row["id"]) for row in done["created"]}
        self.assertEqual(by_name["Producer"]["model_override"], "claude-haiku-5-5")  # the person's pick wins
        self.assertEqual(by_name["Script Writer"]["model_override"], "claude-opus-5-5")
        self.assertEqual(by_name["Publisher"]["model_override"], "claude-haiku-5-5")
        self.assertTrue(all(b["endpoint_id"] == claude["id"] for b in by_name.values()))
        team = bot_departments.team_of(by_name["Producer"]["id"])
        self.assertEqual(team["model_tiers"][by_name["Executor"]["id"]], "light")
        self.assertIn("content_studio_add_topic", team["internal_tools"])

    def test_an_import_refuses_a_connection_the_account_does_not_have(self):
        self.connect(name="Claude", kind="claude_cli")
        result = self.inspect()
        before = len(agent_service.list_agents())
        with self.assertRaises(ValueError):
            bot_package.import_(result["token"], {"bots": ["bot-1"], "sections": [], "models": {"bot-1": "notmine|claude-opus-5-5|"}},
                                owner_user=bot_attention.legacy_owner())
        self.assertEqual(len(agent_service.list_agents()), before)

    def test_suggest_models_only_proposes_until_applied(self):
        claude = self.connect(name="Claude", kind="claude_cli")
        from routes import bot_department_routes as routes
        user = bot_attention.legacy_owner()
        a = agent_service.create("Writer", endpoint_id=claude["id"], model_override="claude-sonnet-5-5")
        b = agent_service.create("Clerk", endpoint_id=claude["id"], model_override="claude-sonnet-5-5")
        team = bot_departments.create("Desk", [a["id"], b["id"]], user)
        bot_departments.set_meta(team["id"], user, model_tiers={a["id"]: "strong", b["id"]: "light"})
        proposal = routes.model_suggestion(team["id"], user)
        rows = {r["name"]: r for r in proposal["rows"]}
        self.assertEqual(rows["Writer"]["choice"]["model_override"], "claude-opus-5-5")
        self.assertEqual(agent_service.get(a["id"])["model_override"], "claude-sonnet-5-5")  # nothing changed yet
        body = routes.ApplyModels(models={a["id"]: {"endpoint_id": claude["id"], "model_override": "claude-opus-5-5"}})
        routes.apply_models(team["id"], body, user)
        self.assertEqual(agent_service.get(a["id"])["model_override"], "claude-opus-5-5")
        self.assertEqual(agent_service.get(b["id"])["model_override"], "claude-sonnet-5-5")  # not picked, not touched
        with self.assertRaises(Exception):
            routes.apply_models(team["id"], routes.ApplyModels(models={a["id"]: {"endpoint_id": "elsewhere"}}), user)
        bot_departments.delete(team["id"], user)


if __name__ == "__main__":
    unittest.main()
