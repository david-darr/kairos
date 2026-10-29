# services/

Domain logic behind the routes. Routes stay thin and call these; these call
`core/`.

## Where things are

- **Chat:** `chat_service.py` (one live brain per session), `chat_live.py`
  (server-owned turns, broadcast to every open client), `chat_background.py`,
  `chat_summary.py`, `background_tasks.py`.
- **Agents:** `agent_service.py`, `agent_handoff.py`, `agent_calls.py`,
  `agent_memory_upkeep.py`, `swarm_service.py`. Bots mode (2026-10-28): `bot_record.py`
  (fields, upgrade, defaults, presets, configured create), `bot_threads.py` (thread
  fields on sessions), `bot_names.py`.
- **Scheduled work:** `task_service.py` (tasks and board cards),
  `trigger_service.py` (webhooks), `hook_service.py` (lifecycle hooks).
- **Forge:** `forge_sessions.py`, `forge_projects.py`, `forge_git.py`,
  `forge_session_git.py`, `forge_apps.py`, `forge_terminals.py`,
  `forge_project_files.py`.
- **Skills and the store:** `skills_service.py` (seeds `skill_templates/`),
  `skill_curator.py`, `skills_guard.py`, `skill_linter.py`, `store_catalog.py`,
  `store_publish.py`, `remote_skill_source.py`.
- **Personal data:** `notes_service.py`, `calendar_service.py`,
  `email_service.py`, `documents_service.py`, `home_week.py`.
- **Models and devices:** `model_setup.py`, `cookbook_service.py`,
  `mobile_notifications.py`, `bot_push.py`, `github_account.py`.

## Rules

- Every read of per-person data is scoped to its owner.
- Live turn state belongs to `chat_live.py`; the UI only mirrors it.
- Forge never runs a shell for git; it uses the fixed recipes in `forge_git.py`.

## Bots redesign, Phases 1 to 3

- `bot_app_adapters.py`, `bot_app_triggers.py`, `bot_attention.py`, `bot_automation_changes.py`, `bot_avatar_service.py`.
- `bot_cards.py`, `bot_chat_service.py`, `bot_connection_catalog.py`, `bot_connections.py`, `bot_goal_runs.py`.
- `bot_grants.py`, `bot_highlevel.py`, `bot_keys.py`, `bot_limit_resets.py`, `bot_logins.py`.
- `bot_mcp_config.py`, `bot_memory.py`, `bot_memory_capture.py`, `bot_memory_dream.py`, `bot_memory_entries.py`.
- `bot_memory_journal.py`, `bot_memory_recall.py`, `bot_memory_store.py`, `bot_memory_upkeep.py`, `bot_onepassword.py`.
- `bot_profile.py`, `bot_profile_history.py`, `bot_resource_fields.py`, `bot_routines.py`, `bot_setup_import.py`.
- `bot_side_jobs.py`, `bot_skill_import.py`, `bot_skill_learning.py`, `bot_skill_library.py`, `bot_skill_review.py`.
- `bot_skill_sharing.py`, `bot_skills.py`, `bot_turn_context.py`, `bot_x_research.py`.
