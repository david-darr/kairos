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

## Bots redesign, Phases 1 to 3

- `test_bots_activity.py`, `test_bots_app_events.py`, `test_bots_approvals.cjs`, `test_bots_approvals.py`, `test_bots_attention.py`.
- `test_bots_attention_model.cjs`, `test_bots_automation_calendar.cjs`, `test_bots_automation_changes.py`, `test_bots_automation_model.cjs`, `test_bots_automations_static.py`.
- `test_bots_avatar.py`, `test_bots_avatar_editor.cjs`, `test_bots_cards.cjs`, `test_bots_cards.py`, `test_bots_chat_contract.py`.
- `test_bots_chat_runtime.py`, `test_bots_composer.cjs`, `test_bots_connection_adapters.py`, `test_bots_connections.cjs`, `test_bots_connections.py`.
- `test_bots_create_model.cjs`, `test_bots_drafts.cjs`, `test_bots_events_contract.cjs`, `test_bots_experience_routes.py`, `test_bots_fixtures.cjs`.
- `test_bots_goal_runs.py`, `test_bots_grants.cjs`, `test_bots_grants.py`, `test_bots_grants_runtime.py`, `test_bots_identity.py`.
- `test_bots_inbox.cjs`, `test_bots_logins.py`, `test_bots_look.cjs`, `test_bots_look.py`, `test_bots_mcp_config.py`.
- `test_bots_mcp_paste.cjs`, `test_bots_mcp_proxy.py`, `test_bots_memory.cjs`, `test_bots_memory.py`, `test_bots_memory_activity.cjs`.
- `test_bots_memory_capture.py`, `test_bots_memory_journal.py`, `test_bots_memory_migration.py`, `test_bots_memory_recall.py`, `test_bots_memory_runtime.py`.
- `test_bots_message_tree.py`, `test_bots_migration.py`, `test_bots_mode.cjs`, `test_bots_navigation.cjs`, `test_bots_outbound.py`.
- `test_bots_panel_sections.cjs`, `test_bots_patch_queue.cjs`, `test_bots_profile_history.py`, `test_bots_provider_approvals.py`, `test_bots_rail.cjs`.
- `test_bots_ready.py`, `test_bots_record.py`, `test_bots_routine_contract.cjs`, `test_bots_routine_recovery.py`, `test_bots_routines.py`.
- `test_bots_runtime_fixtures.cjs`, `test_bots_schedules.py`, `test_bots_shell_static.py`, `test_bots_sidebar_model.cjs`, `test_bots_skill_import.py`.
- `test_bots_skill_learning.py`, `test_bots_skills.cjs`, `test_bots_skills.py`, `test_bots_streaming.cjs`, `test_bots_streaming.py`.
- `test_bots_threads.py`, `test_bots_transcript.cjs`, `test_bots_webhooks.py`, `bots-approvals-checks.cjs`, `bots-attention-checks.cjs`.
- `bots-automations-checks.cjs`, `bots-cards-checks.cjs`, `bots-chat-checks.cjs`, `bots-connections-checks.cjs`, `bots-create-checks.cjs`.
- `bots-data-checks.cjs`, `bots-events-checks.cjs`, `bots-grants-checks.cjs`, `bots-identity-checks.cjs`, `bots-look-checks.cjs`.
- `bots-memory-checks.cjs`, `bots-memory-runtime-checks.cjs`, `bots-navigation-checks.cjs`, `bots-routines-checks.cjs`, `bots-runtime-checks.cjs`.
- `bots-shell-checks.cjs`, `bots-skills-checks.cjs`, `bots-stream-checks.cjs`, `bots_memory_support.py`, `bots_routine_test_support.py`.
- `bots_chat_harness.py`, `fixtures/bots-approvals-backend.cjs`, `fixtures/bots-attention-backend.cjs`, `fixtures/bots-automations-backend.cjs`, `fixtures/bots-cards-backend.cjs`.
- `fixtures/bots-chat-backend.cjs`, `fixtures/bots-connections-backend.cjs`, `fixtures/bots-core-backend.cjs`, `fixtures/bots-events-backend.cjs`, `fixtures/bots-grants-backend.cjs`.
- `fixtures/bots-identity-backend.cjs`, `fixtures/bots-memory-backend.cjs`, `fixtures/bots-memory-runtime-backend.cjs`, `fixtures/bots-navigation-backend.cjs`, `fixtures/bots-routines-backend.cjs`.
- `fixtures/bots-runtime-backend.cjs`, `fixtures/bots-skills-backend.cjs`.
