"""Kairos CLI full-screen view in a real ConPTY (A18, group g11): terminal restore on
exit and after a dead backend, resize, Unicode, NO_COLOR. Same fixture backend as
test_kairos_cli_live. Run (TERM=xterm-256color, NO_COLOR unset):
    python scripts/test_kairos_cli_g11_tty.py
test_bug_* assert behaviour the CLI does not have yet (see report).
"""
import os
import re
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_kairos_cli_live as L  # noqa: E402
import scripts.test_kairos_cli_g11 as G  # noqa: E402

ROOT = G.ROOT


def setUpModule():
    L.setUpModule()


def tearDownModule():
    for _ in range(10):  # Windows can hold the backend's log a moment after the kill
        try:
            L.tearDownModule()
            return
        except PermissionError:
            time.sleep(1)


@unittest.skipUnless(sys.platform == "win32", "ConPTY harness")
class Interactive(L.InteractiveLive):
    def start(self, extra=(), env_extra=None, port=None):
        try:
            from winpty import PtyProcess
        except ImportError:
            self.skipTest("pywinpty is not installed")
        sys.path.insert(0, str(ROOT / "scripts"))
        from kairos_cli_vt import Screen
        self.Screen = Screen
        self.approver = L.approve_next("allow")
        env = {**os.environ, "PYTHONPATH": str(ROOT / "cli"), "PYTHONIOENCODING": "utf-8", "WT_SESSION": "test",
               **(env_extra or {})}
        self.process = PtyProcess.spawn(
            [sys.executable, "-X", "utf8", "-m", "kairos_cli", "--port", str(port or L.BACKEND.port),
             "--no-start", "--model", "Scripted", "--no-motion", *extra],
            dimensions=(self.ROWS, self.COLS), env=env, cwd=str(ROOT))
        self.chunks = []
        threading.Thread(target=self._read, daemon=True).start()
        self.addCleanup(self.stop)

    def raw(self):
        return "".join(self.chunks)

    @staticmethod
    def restored(raw):
        """The last alternate-screen, cursor and mouse-mode switches leave the terminal as found."""
        alt_on, alt_off = raw.rfind("\x1b[?1049h"), raw.rfind("\x1b[?1049l")
        hide, show = raw.rfind("\x1b[?25l"), raw.rfind("\x1b[?25h")
        mouse = [m.group(2) for m in re.finditer(r"\x1b\[\?(1000|1002|1003|1006)([hl])", raw)]
        return alt_on >= 0 and alt_off > alt_on and show > hide and (not mouse or mouse[-1] == "l")

    def wait_exit(self, seconds=10):
        deadline = time.time() + seconds
        while time.time() < deadline and self.process.isalive():
            time.sleep(0.1)
        return not self.process.isalive()

    def test_exit_restores_the_terminal_and_exits_zero(self):
        self.start()
        self.wait_for("Projects")
        t = time.time()
        self.send("\x04", 0.1)
        self.assertTrue(self.wait_exit(), "ctrl+d did not leave")
        print(f"[bench] cli ctrl+d to process exit {time.time() - t:.2f}s")
        self.assertEqual(self.process.exitstatus, 0)
        time.sleep(0.5)
        self.assertTrue(self.restored(self.raw()), "alt screen / cursor / mouse mode not restored")
        self.assertFalse(self.screen().alternate, "still on the alternate screen after exit")

    def test_unicode_round_trips(self):
        self.start()
        self.wait_for("Projects")
        self.send("héllo 日本語 ü\r", 0.5)
        self.wait_for("You said: h", seconds=30)
        screen = self.screen().text()
        reply = screen[screen.index("You said: h"):].splitlines()[0]
        self.assertIn("llo", reply)
        self.assertIn("日本語", reply, reply)

    def test_no_color_draws_no_colour_codes(self):
        self.start(env_extra={"NO_COLOR": "1"})
        self.wait_for("Projects")
        self.send("hello\r", 0.3)
        self.wait_for("You said: hello", seconds=30)
        colour = re.findall(r"\x1b\[[0-9;]*(?:3[0-7]|4[0-7]|9[0-7]|38;[25]|48;[25])[0-9;]*m", self.raw())
        self.assertEqual(colour[:3], [], "NO_COLOR output still carries colour codes")

    def test_resize_keeps_the_view_working(self):
        self.start()
        self.wait_for("Projects")
        for rows, cols in ((24, 70), (12, 40), (45, 160)):
            self.process.setwinsize(rows, cols)
            time.sleep(1.2)
            self.assertTrue(self.process.isalive(), f"crashed resizing to {cols}x{rows}")
        self.send("hello\r", 0.3)
        self.wait_for("You said: hello", seconds=30)
        self.assertNotIn("Traceback", self.raw())

    def test_bug_dead_backend_is_shown_and_ctrl_d_still_leaves_cleanly(self):
        helper = G.Restart()
        b = helper.start_backend()
        saved = L.BACKEND
        L.BACKEND = b
        try:
            self.start(port=b.port)
            self.wait_for("Projects")
            helper.kill(b)
            time.sleep(4)
            text = self.screen().text().lower()
            shown = any(w in text for w in ("reconnect", "offline", "lost", "disconnected", "not reachable"))
            self.send("\x04", 0.1)
            self.assertTrue(self.wait_exit(15), "ctrl+d does not leave after the backend died")
            self.assertTrue(self.restored(self.raw()))
            self.assertTrue(shown, "the full-screen view never says the connection is down:\n" + text[-800:])
        finally:
            L.BACKEND = saved
            if b.process.poll() is None:
                helper.kill(b)
            b.log.close()
            for _ in range(10):
                try:
                    L.remove_tree(b.data)
                    break
                except PermissionError:
                    time.sleep(1)


for _n in [n for n in dir(L.InteractiveLive) if n.startswith("test_") and n not in vars(Interactive)]:
    setattr(Interactive, _n, None)

if __name__ == "__main__":
    unittest.main()
