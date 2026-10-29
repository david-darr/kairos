"""Room UI assets and authored copy. No browser or backend is started."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ['views/botsRoom.js', 'botsRoomPanel.js', 'botsRoomMembers.js', 'botsNewRoom.js',
         'botsRoomModel.js', 'botsRoomStream.js', 'botsTeamChips.js', 'botsGoalCard.js']


class RoomStaticTests(unittest.TestCase):
    def test_assets_and_local_imports(self):
        for name in FILES:
            path = ROOT / 'static/js' / name
            self.assertTrue(path.is_file(), name)
            for target in re.findall(r"(?:from\s*|import\s*)['\"]([^'\"]+)['\"]", path.read_text(encoding='utf-8')):
                if target.startswith('.'):
                    self.assertTrue((path.parent / target).is_file(), f'{name}: {target}')
        self.assertTrue((ROOT / 'static/css/bots-rooms.css').is_file())

    def test_tokens_and_scope(self):
        css = (ROOT / 'static/css/bots-rooms.css').read_text(encoding='utf-8')
        self.assertNotRegex(css, r'#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d')
        for token in re.findall(r'var\((--[\w-]+)', css):
            self.assertTrue(token.startswith('--bots-'), token)
            self.assertIn(token + ':', (ROOT / 'static/css/bots.css').read_text(encoding='utf-8'))
        for line in css.splitlines():
            if '{' in line and not line.lstrip().startswith(('@', '/*')):
                self.assertIn('[data-app-mode="bots"]', line)

    def test_copy_and_icons(self):
        icons = (ROOT / 'static/js/botsIcons.js').read_text(encoding='utf-8')
        for name in FILES:
            text = (ROOT / 'static/js' / name).read_text(encoding='utf-8')
            self.assertNotRegex(text.lower(), r'openmausbot|mausbot|openduet|\bduet\b|passing it along|routed by')
            self.assertNotIn('\u2014', text)
            for icon in re.findall(r"icon\(['\"]([^'\"]+)", text):
                self.assertIn(f"'{icon}'", icons)

    def test_view_and_goal_feed_contract(self):
        view = (ROOT / 'static/js/views/botsRoom.js').read_text(encoding='utf-8')
        self.assertIn('export function render(', view)
        self.assertIn('export async function mountRoom(', view)
        self.assertIn("'room.goal'", (ROOT / 'static/js/botsRoomStream.js').read_text(encoding='utf-8'))
        check = (ROOT / 'scripts/bots-room-ui-checks.cjs').read_text(encoding='utf-8')
        self.assertIn('isolateBotsCheck', check)
        self.assertIn('finally', check)


if __name__ == '__main__':
    unittest.main()
