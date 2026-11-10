"""GET /api/bot-pulse: the Bots sidebar's one poll (routes/bot_pulse_routes.py). 100-bot scale test, 2026-11-10:
the sidebar re-fetched the bot list, automations and team map every 10 s, 2.5 MB a minute at 100 bots."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory  # noqa: E402

_DATA = TestDataDirectory("kairos-bot-pulse-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.middleware import require_admin, require_user  # noqa: E402
from routes import agent_routes, bot_pulse_routes, bot_team_routes, task_routes  # noqa: E402
from services import bot_routines  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(bot_pulse_routes.router)
app.include_router(bot_team_routes.router)
app.include_router(task_routes.router)
app.include_router(agent_routes.router)
app.dependency_overrides[require_user] = lambda: "local"
app.dependency_overrides[require_admin] = lambda: "local"
web = TestClient(app)
WHOLE = {"agents": "/api/agents", "conversations": "/api/agents/conversations", "team": "/api/bot-team/map",
         "automations": "/api/bot-automations"}


class PulseTests(unittest.TestCase):
    def setUp(self):
        p = patch("services.bot_attention.legacy_owner", return_value="local")
        p.start()
        self.addCleanup(p.stop)
        self.bots = [agent_service.create(f"Pulse Bot {n}")["id"] for n in range(3)]
        bot_routines.create_for_owner("local", self.bots[0], {"name": "Morning", "instructions": "Check.",
                                                              "schedule": {"kind": "daily", "time": "09:00"}})
        self.addCleanup(self.clean)

    def clean(self):
        for bot_id in self.bots:
            try:
                agent_service.delete(bot_id)
            except Exception:
                pass

    def pulse(self, held=None):
        reply = web.get("/api/bot-pulse", params=held or {})
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def test_a_first_read_gets_every_list_exactly_as_its_own_route_gives_it(self):
        first = self.pulse()
        for part, path in WHOLE.items():
            self.assertEqual(first[part], web.get(path).json(), part)
            self.assertIsInstance(first["versions"][part], str)
        self.assertIsInstance(first["needs_you"], int)

    def test_an_idle_poll_carries_only_versions_and_counts(self):
        first = self.pulse()
        idle = self.pulse(first["versions"])
        self.assertEqual(idle["versions"], first["versions"], "nothing changed: the versions are stable")
        self.assertEqual(set(idle), {"versions", "needs_you"}, "no list comes back when none changed")
        self.assertLess(len(web.get("/api/bot-pulse", params=first["versions"]).content), 400)

    def test_a_change_brings_back_only_the_list_that_changed(self):
        first = self.pulse()
        agent_service.create("Pulse Bot new", role="Newcomer")
        self.bots.append(next(a["id"] for a in agent_service.list_agents() if a["name"] == "Pulse Bot new"))
        after = self.pulse(first["versions"])
        self.assertNotEqual(after["versions"]["agents"], first["versions"]["agents"])
        self.assertIn("Pulse Bot new", [a["name"] for a in after["agents"]])
        self.assertNotIn("automations", after, "the automations did not change")

    def test_only_reads_just_the_lists_asked_for(self):
        first = self.pulse({"only": "agents"})
        self.assertEqual(set(first), {"versions", "agents"})
        self.assertEqual(set(first["versions"]), {"agents"})
        idle = self.pulse({"only": "agents", "agents": first["versions"]["agents"]})
        self.assertEqual(set(idle), {"versions"})

    def test_a_list_that_cannot_be_read_is_left_out_and_the_rest_still_come(self):
        real = bot_pulse_routes._read

        async def broken(part, user):
            if part == "team":
                raise RuntimeError("store unreadable")
            return await real(part, user)
        with patch.object(bot_pulse_routes, "_read", broken), self.assertLogs("routes.bot_pulse_routes", "ERROR"):
            reply = self.pulse()
        self.assertIsNone(reply["versions"]["team"])
        self.assertNotIn("team", reply)
        self.assertIn("agents", reply)


if __name__ == "__main__":
    unittest.main()
