"""Browser partitions and cookie metadata, using only local fixture databases."""
import asyncio
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-profiles-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import computer
from services import bot_browser_profiles as profiles, bot_workbench as state
from services.agent_service import agent_service


class ProfileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot = agent_service.create("Profile test")
        state.save_state({"profiles": [], "help": {}})

    async def asyncTearDown(self):
        agent_service.delete(self.bot["id"])

    async def test_own_opt_in_guest_and_confinement(self):
        self.assertIsNone(profiles.resolve(self.bot))
        own = {**self.bot, "keep_signed_in": True}
        self.assertEqual(profiles.resolve(own), (computer.profiles_dir() / self.bot["id"]).resolve())
        self.assertIsNone(profiles.resolve({**own, "browser_profile": "guest"}))
        for bad in ("../bad", "a" * 10 + "/../outside", "shared:../bad", "shared:" + "a" * 12):
            with self.assertRaises(ValueError):
                profiles.resolve({**own, "id": bad}) if not bad.startswith("shared:") else profiles.resolve({**own, "browser_profile": bad})
        outside = Path(_DATA.name) / "outside"
        outside.mkdir(exist_ok=True)
        with patch.object(computer, "PROFILES", outside):
            self.assertTrue(profiles.resolve(own).is_relative_to(outside))
        with patch.object(computer, "PROFILES", Path(_DATA.name).parent):
            with self.assertRaises(ValueError): profiles.resolve(own)

    async def test_profile_cap_used_by_running_delete_and_reset(self):
        first = profiles.create("Shared work")
        for i in range(19): profiles.create(f"Profile {i}")
        with self.assertRaises(ValueError): profiles.create("Overflow")
        self.assertEqual(profiles.rename(first["id"], "Renamed")["name"], "Renamed")
        agent_service.update(self.bot["id"], browser_profile="shared:" + first["id"])
        self.assertEqual(profiles.resolve(agent_service.get(self.bot["id"])).name, "shared-" + first["id"])
        with patch.object(computer.manager, "is_running", return_value=True):
            with self.assertRaises(ValueError): profiles.delete(first["id"])
        profiles.delete(first["id"])
        self.assertEqual(agent_service.get(self.bot["id"])["browser_profile"], "own")
        with self.assertRaises(KeyError): profiles.delete(first["id"])

    async def test_cookie_host_only_listing_and_exact_sign_out(self):
        own = {**self.bot, "keep_signed_in": True}
        target = profiles.resolve(own) / "Default/Network/Cookies"
        target.parent.mkdir(parents=True)
        with sqlite3.connect(target) as db:
            db.execute("CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)")
            db.executemany("INSERT INTO cookies VALUES (?, 'sid', 'secret-never-return', X'1234')",
                           [(".example.com",), ("example.com",), ("sub.example.com",), ("other.example",)])
        self.assertEqual(profiles.sites(own), ["example.com", "other.example", "sub.example.com"])
        self.assertNotIn("secret", str(profiles.sites(own)))
        with patch.object(computer.manager, "_stop", AsyncMock()) as stop:
            self.assertIsNone(await profiles.sign_out(own, "example.com"))
            stop.assert_awaited_once_with("agent:" + self.bot["id"])
        self.assertEqual(profiles.sites(own), ["other.example", "sub.example.com"])
        with sqlite3.connect(target) as db:
            self.assertEqual(db.execute("SELECT value FROM cookies WHERE host_key = 'other.example'").fetchone()[0], "secret-never-return")
        with self.assertRaises(ValueError): await profiles.sign_out(own, "example.com' OR 1=1")

    async def test_shared_signout_stops_all_profile_writers(self):
        shared = profiles.create("Shared")
        other = agent_service.create("Other profile test")
        try:
            for bot in (self.bot, other): agent_service.update(bot["id"], browser_profile="shared:" + shared["id"])
            with patch.object(computer.manager, "_stop", AsyncMock()) as stop:
                await profiles.sign_out(agent_service.get(self.bot["id"]), "example.com")
                self.assertEqual({c.args[0] for c in stop.await_args_list}, {"agent:" + self.bot["id"], "agent:" + other["id"]})
        finally: agent_service.delete(other["id"])


if __name__ == "__main__": unittest.main()
