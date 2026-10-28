"""Kairos CLI full-screen view in a real ConPTY (A18 crash restore): what the terminal
looks like after the running TUI hits an uncaught exception, Ctrl+C, and Ctrl+Break.
The crash is forced from outside: scripts/kairos_cli_crash_launcher.py patches one TUI
method and then runs the real kairos_cli main(); no cli/ file is touched.
    python scripts/test_kairos_cli_g18_crash.py
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
import scripts.test_kairos_cli_g11_tty as T  # noqa: E402
from scripts import test_kairos_cli_live as L  # noqa: E402

ROOT = T.ROOT
LAUNCHER = str(ROOT / "scripts" / "kairos_cli_crash_launcher.py")
setUpModule, tearDownModule = T.setUpModule, T.tearDownModule

# What the CLI (prompt_toolkit, VT output on ConPTY) switches on, and the switch that undoes it.
PAIRS = {"1049": "alternate screen", "2004": "bracketed paste", "1000": "mouse press/release",
         "1003": "mouse any-motion", "1006": "SGR mouse", "1015": "urxvt mouse"}


def last_switches(raw):
    state = {}
    for m in re.finditer(r"\x1b\[\?(\d+)([hl])", raw):
        state[m.group(1)] = m.group(2)
    return state


@unittest.skipUnless(sys.platform == "win32", "ConPTY harness")
class Crash(T.Interactive):
    def launch(self, mode):
        try:
            from winpty import PtyProcess
        except ImportError:
            self.skipTest("pywinpty is not installed")
        sys.path.insert(0, str(ROOT / "scripts"))
        from kairos_cli_vt import Screen
        self.Screen = Screen
        self.approver = L.approve_next("allow")
        env = {**os.environ, "PYTHONPATH": str(ROOT / "cli"), "PYTHONIOENCODING": "utf-8", "WT_SESSION": "test"}
        self.process = PtyProcess.spawn(
            [sys.executable, "-X", "utf8", LAUNCHER, mode, "--", "--port", str(L.BACKEND.port),
             "--no-start", "--model", "Scripted", "--no-motion"],
            dimensions=(self.ROWS, self.COLS), env=env, cwd=str(ROOT))
        self.chunks = []
        threading.Thread(target=self._read, daemon=True).start()
        self.addCleanup(self.stop)
        self.wait_for("Projects")
        self.assertEqual(last_switches(self.raw()).get("1049"), "h", "the view is not on the alternate screen")

    def assert_terminal_restored(self, raw, what, paste=True):
        state = last_switches(raw)
        self.assertEqual(state.get("1049"), "l", f"{what}: still on the alternate screen")
        for code in ("1000", "1003", "1006", "1015") + (("2004",) if paste else ()):
            self.assertEqual(state.get(code), "l", f"{what}: {PAIRS[code]} (?{code}) was enabled and never disabled")
        self.assertGreater(raw.rfind("\x1b[?25h"), raw.rfind("\x1b[?25l"), f"{what}: cursor left hidden")

    def modes(self):
        m = re.search(r"MODES before=(-?\d+) after=(-?\d+) code=(\S+)", self.raw())
        self.assertTrue(m, "launcher did not print the console modes:\n" + self.raw()[-600:])
        return int(m.group(1)), int(m.group(2)), m.group(3)

    def test_every_switch_the_view_turns_on_has_a_matching_off(self):
        # What the clean exit path undoes: the baseline for the crash cases below.
        self.launch("none")
        on = last_switches(self.raw())
        for code in PAIRS:
            self.assertEqual(on.get(code), "h", f"?{code} ({PAIRS[code]}) is not enabled while the view runs")
        self.send("\x04", 0.1)
        self.assertTrue(self.wait_exit())
        time.sleep(0.5)
        self.assert_terminal_restored(self.raw(), "clean exit")
        before, after, code = self.modes()
        self.assertEqual((before, code), (after, "0"), "raw / console input mode not restored on exit")

    def test_ctrl_c_leaves_cleanly_and_restores_everything(self):
        self.launch("none")
        self.send("\x03", 0.1)
        self.assertTrue(self.wait_exit(), "ctrl+c did not leave an idle view")
        self.assertEqual(self.process.exitstatus, 0)
        time.sleep(0.5)
        self.assert_terminal_restored(self.raw(), "ctrl+c")
        before, after, _ = self.modes()
        self.assertEqual(before, after, "console input mode differs after ctrl+c")
        self.assertNotIn("Traceback", self.raw())

    def test_uncaught_exception_out_of_the_app_restores_and_exits_nonzero(self):
        # app.exit(exception=...) is how an error inside the running view reaches main().
        self.launch("exit-raise")
        self.send("\x1b[5~", 0.3)
        self.assertTrue(self.wait_exit(), "the view hung after an uncaught exception")
        self.assertEqual(self.process.exitstatus, 1)
        time.sleep(0.5)
        raw = self.raw()
        self.assert_terminal_restored(raw, "uncaught exception")
        self.assertIn("RuntimeError: forced crash out of the app", raw, "no readable error was printed")
        screen = self.screen()
        self.assertFalse(screen.alternate, "the error was drawn on the alternate screen")
        self.assertIn("RuntimeError: forced crash out of the app", screen.text())
        before, after, _ = self.modes()
        self.assertEqual(before, after, "console input mode not restored after the crash")

    def test_exception_in_a_key_handler_leaves_the_alt_screen_to_show_it_then_recovers(self):
        self.launch("key-raise")
        self.send("\x1b[5~", 2)
        text = self.screen().text()
        self.assertIn("forced key handler crash", text, "the error is not readable on screen")
        self.assertIn("Press ENTER to continue", text)
        self.assert_terminal_restored(self.raw(), "while the key-handler error is shown", paste=False)
        self.assertFalse(self.screen().alternate)
        self.assertTrue(self.process.isalive(), "the view died instead of reporting the error")
        self.send("\r", 1.5)
        self.assertEqual(last_switches(self.raw()).get("1049"), "h", "the view did not come back after Enter")
        self.send("\x04", 0.1)
        self.assertTrue(self.wait_exit(), "ctrl+d does not leave after the error was dismissed")
        self.assertEqual(self.process.exitstatus, 0)
        time.sleep(0.5)
        self.assert_terminal_restored(self.raw(), "exit after a handled key error")
        before, after, _ = self.modes()
        self.assertEqual(before, after)

    def test_exception_while_drawing_shows_the_error_with_the_terminal_restored(self):
        self.launch("render-raise")
        self.send("\x1b[5~", 2)
        self.assertIn("forced render crash", self.screen().text(), "a drawing error is not readable on screen")
        self.assertFalse(self.screen().alternate, "a drawing error is hidden behind the alternate screen")
        self.assert_terminal_restored(self.raw(), "while the drawing error is shown", paste=False)

    def test_bug_ctrl_break_restores_the_terminal(self):
        # Ctrl+Break reaches the whole console and kills Python with its default handler;
        # the CLI installs none (no `signal` use in cli/kairos_cli), so nothing is undone.
        self.launch("sigbreak")
        deadline = time.time() + 20
        while time.time() < deadline and self.process.isalive():
            time.sleep(0.2)
        self.assertFalse(self.process.isalive(), "ctrl+break did not end the process")
        time.sleep(0.5)
        raw = self.raw()
        self.assertIn("LAUNCHER: sending CTRL_BREAK", raw)
        self.assert_terminal_restored(raw, "ctrl+break")


for _n in [n for n in dir(T.Interactive) if n.startswith("test_") and n not in vars(Crash)]:
    setattr(Crash, _n, None)

if __name__ == "__main__":
    unittest.main()
