"""Test-only launcher for test_kairos_cli_g18_crash: runs the real kairos CLI main() after
patching one TUI method (no cli/ file is edited) so the running full-screen view genuinely
fails. Usage: python kairos_cli_crash_launcher.py <mode> -- <kairos args>
Modes: key-raise (a key handler raises), exit-raise (app.exit(exception=...) from a key),
render-raise (drawing raises after PgUp), sigbreak (CTRL_BREAK delivered to the console after F1),
none. Prints MODES before/after: the stdin console mode around the whole run."""
import ctypes
import os
import sys
import threading
import time

mode = sys.argv[1]
sys.argv = [sys.argv[0]] + sys.argv[sys.argv.index("--") + 1:]


def console_mode():
    handle = ctypes.windll.kernel32.GetStdHandle(-10)
    value = ctypes.c_uint32()
    return value.value if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(value)) else -1


from kairos_cli import tui  # noqa: E402
from kairos_cli.main import main  # noqa: E402

if mode == "key-raise":
    def boom(self, lines):
        raise RuntimeError("forced key handler crash")
    tui.KairosApp.scroll = boom
elif mode == "exit-raise":
    def boom(self, lines):
        self.app.exit(exception=RuntimeError("forced crash out of the app"))
    tui.KairosApp.scroll = boom
elif mode == "render-raise":
    armed = []

    def arm(self, lines):
        armed.append(1)
        self.invalidate()
    tui.KairosApp.scroll = arm
    import prompt_toolkit.layout.containers as containers
    real = containers.Window.write_to_screen

    def bad(self, *a, **k):
        if armed:
            raise RuntimeError("forced render crash")
        return real(self, *a, **k)
    containers.Window.write_to_screen = bad
elif mode == "sigbreak":
    def fire():
        time.sleep(6)
        print("LAUNCHER: sending CTRL_BREAK", file=sys.stderr, flush=True)
        ctypes.windll.kernel32.GenerateConsoleCtrlEvent(1, 0)
    threading.Thread(target=fire, daemon=True).start()

before = console_mode()
code = None
try:
    code = main()
except SystemExit as exit_:
    code = exit_.code
finally:
    sys.stdout.write(f"\nMODES before={before} after={console_mode()} code={code}\n")
    sys.stdout.flush()
sys.exit(code)
