"""Pronunciations (Settings > Speech > More options): a word and how to say it, per account, applied before misaki.

Run: python scripts/test_pronunciations.py   (needs misaki and spaCy's small English model, as Kokoro does)
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-pronunciations-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import accounts, kokoro_g2p, pronunciations  # noqa: E402
from core.middleware import require_user  # noqa: E402
from routes import voice_engine_routes  # noqa: E402

HAVE_MISAKI = not kokoro_g2p.missing()


class Case(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.account = "pr" + os.urandom(3).hex()
        self.token = accounts.set_current(self.account)

    def tearDown(self):
        accounts.reset_current(self.token)


class RespellTests(Case):
    def test_a_respelling_becomes_phonemes_with_the_stress_on_the_capitals(self):
        self.assertEqual(pronunciations.respell("shi-VAWN"), "ʃivˈɔn")
        self.assertEqual(pronunciations.respell("kai-ROSS"), "kAɹˈɑs")
        self.assertEqual(pronunciations.respell("nwen"), "nwˈɛn", "no capitals: the first syllable is stressed")
        for bad in ("", "shi--", "ʃi-VAWN", "x" * 3 + "1"):
            with self.subTest(bad=bad), self.assertRaises(pronunciations.PronunciationError):
                pronunciations.respell(bad)

    def test_save_checks_each_line_and_typed_phonemes_win(self):
        saved = pronunciations.save([{"word": "Siobhan", "say": "shi-VAWN"}, {"word": "Kairos", "say": "kai-ROSS", "phonemes": "kˈIɹOs"},
                                     {"word": "", "say": "", "phonemes": ""}])
        self.assertEqual([(i["word"], i["phonemes"]) for i in saved], [("Siobhan", "ʃivˈɔn"), ("Kairos", "kˈIɹOs")])
        self.assertTrue(saved[1]["typed"])
        for bad, why in (([{"word": "two words", "say": "x"}], "not one word"), ([{"word": "Ana", "say": "AH-na"}, {"word": "ana", "say": "a"}], "twice"),
                         ([{"word": "Ana", "say": ""}], "how to say"), ([{"word": "Ana", "phonemes": "ʃi☃"}], "cannot say")):
            with self.subTest(why=why), self.assertRaisesRegex(pronunciations.PronunciationError, why):
                pronunciations.save(bad)
        self.assertEqual(len(pronunciations.items()), 2, "a refused list leaves the saved one alone")

    def test_each_account_has_its_own_list(self):
        pronunciations.save([{"word": "Saoirse", "say": "SEER-sha"}])
        self.assertTrue(pronunciations.lookup("SAOIRSE"))
        with accounts.as_account("other" + os.urandom(2).hex()):
            self.assertIsNone(pronunciations.lookup("Saoirse"))


@unittest.skipUnless(HAVE_MISAKI, "misaki is not installed")
class KokoroTests(Case):
    def test_a_listed_word_is_said_its_listed_way_before_misaki(self):
        before = kokoro_g2p.phonemize("Kairos and Nguyen are here.")
        pronunciations.save([{"word": "Kairos", "say": "kai-ROSS"}, {"word": "Nguyen", "say": "NWEN"}])
        after = kokoro_g2p.phonemize("Kairos and Nguyen are here.")
        self.assertNotEqual(before, after)
        self.assertTrue(after.startswith("kAɹˈɑs "), after)
        self.assertIn("nwˈɛn", after)
        self.assertEqual(kokoro_g2p.phonemize("kairos.", lexicon=False), before.split(" ")[0] + ".", "lexicon=False reads it as misaki does")

    def test_a_broken_list_never_costs_the_sentence(self):
        def broken(word, british):
            raise RuntimeError("disk gone")
        with patch.object(kokoro_g2p, "LEXICON", broken):
            self.assertTrue(kokoro_g2p.phonemize("Hello there."))


class RouteTests(Case):
    async def test_save_and_list_through_the_route(self):
        app = FastAPI()
        app.include_router(voice_engine_routes.router)
        app.dependency_overrides[require_user] = lambda: "david"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual((await client.get("/api/voice-engines/pronunciations")).json(), {"items": []}, "nothing is seeded")
            saved = await client.put("/api/voice-engines/pronunciations", json={"items": [{"word": "Siobhan", "say": "shi-VAWN"}]})
            self.assertEqual(saved.json()["items"][0]["phonemes"], "ʃivˈɔn")
            bad = await client.put("/api/voice-engines/pronunciations", json={"items": [{"word": "a b", "say": "x"}]})
            self.assertEqual(bad.status_code, 422)
            self.assertEqual(len((await client.get("/api/voice-engines/pronunciations")).json()["items"]), 1)


if __name__ == "__main__":
    unittest.main()
