import unittest
from test_bots_departments import TeamsCase, teams, bot_chief, HTTPException


class ChiefTests(TeamsCase):
    def test_authority_is_membership_never_reach(self):
        chief, team = self.team()
        peer = self.bot("Teammate", section="Research")
        outside = self.bot("Outside", section="Operations")
        teams.set_chief(team["id"], chief["id"])
        self.assertTrue(bot_chief.authorize(chief["id"], "edit", peer["id"]))
        chief["peers"] = [outside["id"]]
        with self.assertRaises(HTTPException):
            bot_chief.authorize(chief["id"], "edit", outside["id"])
        teams.set_chief(team["id"], chief["id"], [teams.team_of(outside["id"])["id"]])
        self.assertTrue(bot_chief.authorize(chief["id"], "edit", outside["id"]))

    def test_caps_and_fallback(self):
        chief, team = self.team()
        peer = self.bot("Teammate", section="Research")
        teams.set_chief(team["id"], chief["id"])
        for action, limit in bot_chief.LIMITS.items():
            bot_chief.reserve(chief["id"], "turn", action, limit)
            with self.assertRaises(HTTPException):
                bot_chief.reserve(chief["id"], "turn", action)
        self.assertEqual(bot_chief.chief_for(peer["id"]), chief["id"])
        teams.set_chief(team["id"], None)
        bot_chief.register_fallback(lambda bot_id: chief["id"])
        self.addCleanup(lambda: bot_chief.register_fallback(None))
        self.assertEqual(bot_chief.chief_for(peer["id"]), chief["id"])
        self.assertIsNone(bot_chief.chief_for(chief["id"]))


if __name__ == "__main__":
    unittest.main()
