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
- The full `ui-smoke.cjs` takes about 20 minutes. While working, run
  `node scripts/run-electron-test.cjs ui-smoke --changed`: it runs only the
  checks for the files this branch changed (`ui-smoke-areas.cjs`; `--list`
  shows the areas, `--dry` prints the plan). It falls back to the full run
  when a shared or unmapped screen file changed, and names it: map new screen
  files to an area there. Run the full suite once before merging.
- `run-electron-test.cjs` takes the lock above itself (in the main checkout,
  so every worktree shares it); don't take it again around it.
- Clear `NO_COLOR` before CLI suites: its colour snapshots fail with it set.
- Keep a failing test that shows a real app bug; fix the test only when the
  test is wrong.

## Which tests to run

- `test_changed.py` runs only what a change touches (`--list` shows the pick);
  `--full` is the release gate. Its `STALE` lists name checks skipped because
  they fail on unchanged `dev`; keep them empty.

## Bots (Phases 1 to 6)

- Suites are named by area: `test_bots_<area>.py` and `test_bots_<area>.cjs`,
  Electron checks `bots-<area>-checks.cjs`, and each check's in-memory backend
  `fixtures/bots-<area>-backend.cjs`. List them with `ls scripts/*bots*`.
- Shared helpers: `bots-check-support.cjs` (isolates a check's fixture store and
  page preferences), `bots_chat_harness.py`, `bots_memory_support.py`,
  `bots_routine_test_support.py`.
- `fixtures/legacy-agents-v2/` is an Agents 2.0 data folder written by v2.2.0,
  for `test_bots_legacy_upgrade.py`.
