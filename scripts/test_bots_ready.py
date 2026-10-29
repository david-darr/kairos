"""Ready-made bots (Agents 3.0 Phase 0, unit U4): the shape of static/data/bots-ready.json.

What these prove: every persona has the fields the gallery and the new-bot dialog read, only
those fields (a persona changes identity, notes and routines, never model, approval, computer
or app access), ids and names are unique, the soul fits the 24,000-byte limit, the routines and
notes pass the same rules the server applies, the look is one of Kip's, the copy has no
em-dashes, and none of the OpenMausBot product or persona names appear.
No app or browser is started.
Run: python scripts/test_bots_ready.py
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
READY = ROOT / "static" / "data" / "bots-ready.json"

PERSONA_KEYS = {"id", "category", "name", "role", "blurb", "try_asking", "soul", "look", "memory_seed", "routines"}
REQUIRED = ("id", "category", "name", "role", "blurb", "try_asking", "soul", "look")
ROUTINE_KEYS = {"name", "prompt", "schedule_kind", "run_time", "interval_seconds", "report_when", "time_zone", "weekdays"}
SEED_SECTIONS = {"About this work", "Preferences", "Corrections", "Notes"}
COLORS = {"d9b260", "b9d2e3", "e8c39e", "d99a92", "b5c7a5", "cdbfd9"}
SHAPES = {"round", "squircle", "tall"}
ACCESSORIES = {"none", "laurel", "spectacles", "quill", "rays", "scarf"}
# Keys that would let a persona grant itself something; none may appear anywhere in a persona.
FORBIDDEN_KEYS = {"model", "endpoint_id", "model_override", "model_effort", "approval", "approval_mode", "computer", "place",
                  "integration_ids", "connector_scopes", "tool_scope", "always_allow", "outbound", "peers", "enabled",
                  "daily_run_cap", "fallback", "visibility", "builtin"}
# The product and the names of its ready-made personas (openmausbot-report.md 2.1 F3, plus the product's
# own name and the sibling project's). Kairos writes its own.
PRODUCT_NAMES = ["openmausbot", "openmaus", "omb", "maus", "openduet"]   # whole words, anywhere in a persona
PERSONA_NAMES = ["scout", "quill", "sigma", "atlas", "sage", "echo", "lens", "coach", "fern", "minutes", "dev", "watch"]  # a persona's own name or id
SOUL_LIMIT_BYTES = 24000
SEED_LIMIT_CHARS = 8000


def load() -> dict:
    return json.loads(READY.read_text(encoding="utf-8"))


def walk_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_keys(item)


def words(text: str) -> set:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


class ReadyBotsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load()
        cls.bots = cls.data["bots"]

    def test_the_file_has_categories_and_a_useful_number_of_bots(self):
        self.assertEqual(self.data["version"], 1)
        self.assertTrue(5 <= len(self.data["categories"]) <= 8)
        self.assertEqual(len(self.bots), 15, "the Phase 0 gallery has fifteen original personas")
        for category in self.data["categories"]:
            self.assertEqual(set(category), {"id", "label"})
            self.assertTrue(category["label"].strip())

    def test_every_persona_has_job_blurb_soul_and_a_line_to_try(self):
        for bot in self.bots:
            for key in REQUIRED:
                self.assertTrue(bot.get(key), f"{bot.get('id')}: {key} is missing or empty")
            for key in ("name", "role", "blurb", "try_asking", "soul"):
                self.assertIsInstance(bot[key], str, f"{bot['id']}.{key}")
                self.assertEqual(bot[key], bot[key].strip(), f"{bot['id']}.{key} has stray spaces")
            self.assertLessEqual(len(bot["name"]), 40)
            self.assertLessEqual(len(bot["role"]), 200)
            self.assertLessEqual(len(bot["blurb"]), 4000)
            self.assertGreater(len(bot["try_asking"]), 10)

    def test_only_allowed_fields_and_no_grants(self):
        for bot in self.bots:
            self.assertFalse(set(bot) - PERSONA_KEYS, f"{bot['id']}: unexpected {sorted(set(bot) - PERSONA_KEYS)}")
            self.assertFalse(set(walk_keys(bot)) & FORBIDDEN_KEYS, f"{bot['id']}: carries {sorted(set(walk_keys(bot)) & FORBIDDEN_KEYS)}")

    def test_ids_and_names_are_unique_and_categories_exist(self):
        ids = [b["id"] for b in self.bots]
        names = [b["name"].lower() for b in self.bots]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(names), len(set(names)))
        known = {c["id"] for c in self.data["categories"]}
        for bot in self.bots:
            self.assertRegex(bot["id"], r"^[a-z][a-z0-9-]{1,38}$")
            self.assertIn(bot["category"], known, bot["id"])
        self.assertEqual({b["category"] for b in self.bots}, known, "every category has a bot")

    def test_the_soul_fits_the_limit(self):
        for bot in self.bots:
            size = len(bot["soul"].encode("utf-8"))
            self.assertLessEqual(size, SOUL_LIMIT_BYTES, f"{bot['id']}: soul is {size} bytes")
            self.assertGreater(size, 80, f"{bot['id']}: soul is too thin to help")

    def test_the_look_is_one_of_kips(self):
        for bot in self.bots:
            look = bot["look"]
            self.assertEqual(set(look), {"color", "shape", "acc"}, bot["id"])
            self.assertIn(look["color"], COLORS, bot["id"])
            self.assertIn(look["shape"], SHAPES, bot["id"])
            self.assertIn(look["acc"], ACCESSORIES, bot["id"])
        self.assertGreaterEqual(len({b["look"]["color"] for b in self.bots}), 4, "the gallery uses the pastels")

    def test_memory_notes_pass_the_servers_rules(self):
        for bot in self.bots:
            notes = bot.get("memory_seed", [])
            total = 0
            for note in notes:
                self.assertEqual(set(note), {"section", "text"}, bot["id"])
                self.assertIn(note["section"], SEED_SECTIONS, bot["id"])
                self.assertTrue(note["text"].strip())
                total += len(" ".join(note["text"].split()))
            self.assertLessEqual(total, SEED_LIMIT_CHARS, bot["id"])

    def test_routines_pass_the_servers_rules(self):
        for bot in self.bots:
            routines = bot.get("routines", [])
            self.assertLessEqual(len(routines), 10, bot["id"])
            for r in routines:
                self.assertFalse(set(r) - ROUTINE_KEYS, f"{bot['id']}: {sorted(set(r) - ROUTINE_KEYS)}")
                self.assertTrue(1 <= len(r["name"]) <= 200)
                self.assertTrue(1 <= len(r["prompt"]) <= 8000)
                if r["schedule_kind"] == "daily":
                    match = re.fullmatch(r"(\d{1,2}):(\d{2})", r["run_time"])
                    self.assertTrue(match and int(match[1]) <= 23 and int(match[2]) <= 59, f"{bot['id']}: run_time")
                    self.assertNotIn("interval_seconds", r)
                else:
                    self.assertEqual(r["schedule_kind"], "interval", bot["id"])
                    self.assertGreaterEqual(r["interval_seconds"], 60)
                    self.assertNotIn("run_time", r)
                self.assertIn(r.get("report_when", "notable"), ("always", "notable"))
                if "weekdays" in r:
                    self.assertEqual(r["schedule_kind"], "daily")
                    self.assertTrue(all(isinstance(d, int) and 0 <= d <= 6 for d in r["weekdays"]))

    def test_no_em_dashes_in_the_copy(self):
        text = READY.read_text(encoding="utf-8")
        self.assertNotIn("—", text, "no em-dashes in published copy")

    def test_none_of_the_banned_product_or_persona_names_appear(self):
        for bot in self.bots:
            blob = json.dumps(bot, ensure_ascii=False).lower()
            self.assertEqual([n for n in PRODUCT_NAMES if n in words(blob)], [], f"{bot['id']} names the product")
            own = words(bot["name"]) | words(bot["id"])
            self.assertEqual([n for n in PERSONA_NAMES if n in own], [], f"{bot['id']} reuses a persona name")

    def test_copy_reads_as_plain_prose(self):
        for bot in self.bots:
            for key in ("blurb", "soul"):
                self.assertNotRegex(bot[key], r"[–]", f"{bot['id']}.{key}: use a comma or a full stop")
            self.assertTrue(bot["blurb"].rstrip().endswith((".", "?")), f"{bot['id']}: blurb is a sentence")
            self.assertTrue(bot["soul"].rstrip().endswith("."), f"{bot['id']}: soul is a sentence")


if __name__ == "__main__":
    unittest.main(verbosity=2)
    sys.exit(0)
