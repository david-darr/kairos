# scripts/

Tests, Electron checks and helpers. Every suite runs on its own, with temp data
(`test_data_support.py`).

## Kinds of file

- `test_*.py`: backend and API suites. Run one directly:
  `.venv\Scripts\python.exe -B -X utf8 scripts\test_<name>.py`.
- `test_*.cjs`: Node suites for UI logic; some need
  `node --experimental-vm-modules`.
- `*-checks.cjs`: Electron UI checks run by `ui-smoke.cjs` against the mocked
  backend `demo/fixtures.js`. Most run only behind their own `--<area>-only` flag.
- `*smoke*.cjs`: standalone Electron smoke runs, such as `chat-smoke.cjs`.
- Bots checks load by name: `bots-<name>-checks.cjs` runs behind
  `--bots-<name>-only` (and in the full run); every `fixtures/bots-*-backend.cjs`
  answers routes before `demo/fixtures.js` while `demoState.botsLive` is set.
- Helpers: `run-electron-test.cjs`, `build_site_demo.py`, `dev_instance.py`,
  the `bench_*` and `*_audit.py` measurement scripts, and `fixtures/`.

## Rules

- One Electron run at a time machine-wide: create the folder
  `data/electron.lock` (wait if it exists), run, remove it only if you created
  it. The lock is for test runs, never for a window a person opened.
- The full `ui-smoke.cjs` takes about 17 minutes; run a flag instead while
  working, and the full run before merging.
- Clear `NO_COLOR` before CLI suites: its colour snapshots fail with it set.
- Keep a failing test that shows a real app bug; fix the test only when the
  test is wrong.
