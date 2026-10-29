"""Aggregators load installed siblings, without hiding broken dependencies."""
import importlib
import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="kairos-team-imports-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from core import tool_registry, bot_team_tools
from routes import bot_teams_routes


class IntegrationTests(unittest.TestCase):
    def test_all_installed_modules_are_loaded(self):
        for aggregator in (bot_team_tools, bot_teams_routes):
            for name in aggregator.MODULES:
                if importlib.util.find_spec(name) is not None:
                    self.assertIn(name, aggregator.LOADED)
        for name in ("coordinate_bots", "list_peers", "assignment_status", "agent_assign"):
            self.assertIn(name, tool_registry._REGISTRY)
        def flatten(routes):
            # Included routers are kept nested; walk into them for the real paths.
            for route in routes:
                if hasattr(route, "original_router"):
                    yield from flatten(route.original_router.routes)
                else:
                    yield route
        self.assertTrue(any(r.path == "/api/bot-peers/{bot_id}/reach" for r in flatten(bot_teams_routes.router.routes)))

    def test_nested_missing_dependency_is_never_suppressed(self):
        real = importlib.import_module
        def broken(name, *args, **kwargs):
            if name == "core.bot_room_tools":
                raise ModuleNotFoundError("missing sibling dependency", name="nested_dependency")
            return real(name, *args, **kwargs)
        with patch("importlib.import_module", side_effect=broken):
            with self.assertRaises(ModuleNotFoundError):
                importlib.reload(bot_team_tools)
        importlib.reload(bot_team_tools)


if __name__ == "__main__":
    unittest.main()
