"""A02: the terminal's Kip follows each turn's real status (no backend).
Run: python scripts/test_g1_cli_kip_states.py
Two turns in one transcript never share a mark, and a stopped or finished turn
does not keep the working mark."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_kairos_cli as base  # noqa: E402  (also puts cli/ on sys.path)
from kairos_cli import mascot  # noqa: E402
from kairos_cli.model import ReplyItem  # noqa: E402


def head_of(app, item):
    lines = app.reply_lines(item, 100)[0]
    return "".join(fragment[1] for fragment in lines[0])


class CliKipStates(unittest.TestCase):
    def marks(self, state):
        manifest = mascot.load_manifest()
        return set(manifest["spinner"][mascot.STATE_MAP.get(state, state)])

    def reply(self, status):
        item = ReplyItem(turn_id=status, ts=1_700_000_000)
        if status != "processing":
            item.feed("Answer.\n")
            item.finish(status)
        return item

    def test_each_status_draws_its_own_mark(self):
        app = base.make_app()
        want = {"processing": "thinking", "done": "success", "failed": "error", "stopped": "idle"}
        for status, state in want.items():
            head = head_of(app, self.reply(status))
            mark = head.strip().split()[0]
            self.assertIn(mark, self.marks(state), (status, head))
        # The working mark and the finished marks are different glyph sets, so
        # finishing, failing or stopping cannot leave the working mark behind.
        working = self.marks("thinking")
        for status in ("done", "failed", "stopped"):
            self.assertFalse(working & self.marks(want[status]), status)

    def test_waiting_on_a_prompt_shows_needs_you(self):
        app = base.make_app()
        item = self.reply("processing")
        view = base.open_view(app, [item])
        view.modal = {"kind": "question"}
        mark = head_of(app, item).strip().split()[0]
        self.assertIn(mark, self.marks("needs"))

    def test_two_turns_keep_their_own_marks(self):
        app = base.make_app()
        running, finished = self.reply("processing"), self.reply("done")
        base.open_view(app, [running, finished])
        first, second = (head_of(app, item).strip().split()[0] for item in (running, finished))
        self.assertIn(first, self.marks("thinking"))
        self.assertIn(second, self.marks("success"))
        finished.status = "processing"
        self.assertIn(head_of(app, finished).strip().split()[0], self.marks("thinking"))
        running.finish("stopped")
        self.assertIn(head_of(app, running).strip().split()[0], self.marks("idle"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
