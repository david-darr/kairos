"""Bots mode look foundation (Agents 3.0 Phase 0, unit U2): contrast and motion.

What these prove: the person's chat bubble, coloured from the bot's Kip body
pastel, reads at WCAG AA (4.5:1) with Kairos ink on each of the six pastels;
text on an accent, danger or success fill reads; every `data-bot-color` rule
points at its own pastel token; and the Bots stylesheets switch their motion off
under prefers-reduced-motion. No app or browser is started.
Run: python scripts/test_bots_look.py
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_kairos_theme as theme  # reuses its token and contrast helpers  # noqa: E402

CSS = theme.STATIC / "css"
KEYS = ["d9b260", "b9d2e3", "e8c39e", "d99a92", "b5c7a5", "cdbfd9"]


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def top_level_parts(selector: str) -> list:
    """Split a selector list at the commas outside parentheses (:is(a, b) stays whole)."""
    parts, depth, current = [], 0, ""
    for ch in selector:
        depth += (ch == "(") - (ch == ")")
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    return parts + [current]


class BotsLookTests(unittest.TestCase):
    def test_the_six_pastels_are_the_agent_colours(self):
        table = theme.tokens()
        found = sorted(n[len("--m-body-"):] for n in table if n.startswith("--m-body-"))
        self.assertEqual(found, sorted(KEYS))

    def test_user_bubble_text_reads_on_every_pastel(self):
        table = theme.tokens()
        ink = theme.resolve("--k-ink", table)
        low = []
        for key in KEYS:
            value = theme.ratio(ink, theme.resolve(f"--m-body-{key}", table))
            if value < 4.5:
                low.append(f"--k-ink on --m-body-{key}: {value:.2f}")
        self.assertEqual(low, [], "bubble-user ink below WCAG AA (4.5:1)")

    def test_the_fallback_bubble_and_bot_bubble_read(self):
        table = theme.tokens()
        for ground in ("--surface-2",):
            for text in ("--text", "--k-ink"):
                self.assertGreaterEqual(theme.ratio(theme.resolve(text, table), theme.resolve(ground, table)), 4.5, f"{text} on {ground}")

    def test_the_bubble_ink_is_the_brand_ink_not_a_themed_text(self):
        # The pastels stay fixed across Appearance, so the ink on them must too.
        css = strip_comments((CSS / "bots.css").read_text(encoding="utf-8"))
        self.assertRegex(css, r"--bots-bubble-user-ink:\s*var\(--k-ink\)")

    def test_text_on_accent_danger_and_success_fills_reads(self):
        table = theme.tokens()
        ink_on_fill = theme.resolve("--bg-panel-solid", table)  # --bots-accent-ink, -danger-ink, -success-ink
        low = []
        for fill in ("--accent", "--danger", "--success"):
            value = theme.ratio(ink_on_fill, theme.resolve(fill, table))
            if value < 4.5:
                low.append(f"surface on {fill}: {value:.2f}")
        self.assertEqual(low, [])

    def test_every_bot_colour_rule_points_at_its_own_pastel(self):
        css = strip_comments((CSS / "bots.css").read_text(encoding="utf-8"))
        rules = dict(re.findall(r'\[data-bot-color="([0-9a-f]{6})"\]\s*\{([^}]*)\}', css))
        self.assertEqual(sorted(rules), sorted(KEYS))
        for key, body in rules.items():
            self.assertIn(f"--bots-bubble-user: var(--m-body-{key})", body)
            self.assertIn(f"--bots-bot-color: var(--m-body-{key})", body)

    def test_motion_stops_under_reduced_motion(self):
        for name, needle in (("bots-kip.css", "animation: none"), ("bots.css", "animation: none")):
            css = strip_comments((CSS / name).read_text(encoding="utf-8"))
            blocks = re.findall(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*)\}\s*$", css, flags=re.S)
            self.assertTrue(blocks, f"{name} has no prefers-reduced-motion block")
            self.assertIn(needle, blocks[-1], name)
            self.assertIn("transition: none", blocks[-1], name)

    def test_the_reduced_motion_blocks_reach_every_animated_node(self):
        # bots.css animates entrances on many classes: its block switches off all
        # descendants of Bots mode. bots-kip.css names the wrapper and its beats.
        sheets = {"bots.css": '[data-app-mode="bots"] *', "bots-kip.css": ".bots-kip[data-beat]"}
        for name, reach in sheets.items():
            css = strip_comments((CSS / name).read_text(encoding="utf-8"))
            reduced = re.search(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*)\}\s*$", css, flags=re.S).group(1)
            self.assertIn(reach, reduced, name)

    def test_the_bots_sheets_are_scoped_to_bots_mode(self):
        for name in ("bots.css", "bots-kip.css"):
            css = strip_comments((CSS / name).read_text(encoding="utf-8"))
            css = re.sub(r"@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", "", css)
            css = re.sub(r"@font-face\s*\{[^}]*\}", "", css)
            css = re.sub(r"@media[^{]*\{", "", css)  # look at the rules inside a media block, not its header
            selectors = re.findall(r"(?:^|[};])\s*([^{};@][^{};]*)\{", css)
            self.assertTrue(selectors)
            for selector in selectors:
                for part in top_level_parts(selector):
                    self.assertIn('data-app-mode="bots"', part, f"{name}: unscoped selector {part.strip()!r}")


if __name__ == "__main__":
    unittest.main()
