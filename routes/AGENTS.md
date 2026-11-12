# routes/

FastAPI routers, one file per area, mounted by `app.py`. Keep them thin: check
access, validate input, call `services/` or `core/`.

## Where things are

Chat: `chat_routes.py`, `session_routes.py`, `background_task_routes.py`,
`run_routes.py`. Agents and work: `agent_routes.py`, `task_routes.py`,
`trigger_routes.py`, `hook_routes.py`, `swarm_routes.py`. Forge:
`forge_routes.py`, `checkpoint_routes.py`. Skills and store: `skills_routes.py`,
`store_routes.py`, `addon_routes.py`. Integrations: `integrations_routes.py`,
`connector_routes.py`, `channels_routes.py`, `google_routes.py`,
`email_routes.py`. Models: `model_routes.py`, `model_setup_routes.py`,
`cookbook_routes.py`. Accounts and settings: `auth_routes.py`,
`settings_routes.py`, `permission_routes.py`, `system_routes.py`,
`remote_routes.py`. Tools for Codex: `tool_routes.py`. The Kairos iPhone app:
`phone_app_routes.py` (pairing, session, paired phones, home, native push;
`specs/phone-api.md`). It shares the `/api/phone` prefix with the telephone
connection, `phone_routes.py`, and nothing else.

## Rules

- Access comes from the dependencies in `core/middleware.py`: a signed-in user,
  or an admin for admin surfaces.
- A route that reads or changes per-person records checks that the caller owns
  them; an admin flag alone is not ownership.
- New request bodies are pydantic models with bounds; never trust a client path.

## Bots redesign, Phases 1 to 3

- `bot_access_routes.py`, `bot_approval_routes.py`, `bot_attention_routes.py`, `bot_automation_change_routes.py`, `bot_card_routes.py`.
- `bot_chat_routes.py`, `bot_connections_routes.py`, `bot_event_routes.py`, `bot_memory_routes.py`, `bot_recall_routes.py`.
- `bot_resources_routes.py`, `bot_routine_routes.py`, `bot_skills_routes.py`.

Bots Phases 4-6 (teams, front desk, workbench, data, usage, lifecycle, voice, onboarding):
- `bot_data_routes.py`, `bot_department_routes.py`, `bot_lifecycle_routes.py`, `bot_onboarding_routes.py`, `bot_peer_routes.py`.
- `bot_room_routes.py`, `bot_team_routes.py`, `bot_teams_routes.py`, `bot_usage_routes.py`, `bot_voice_routes.py`.
- `bot_widget_routes.py`, `bot_workbench_routes.py`, `front_desk_make_routes.py`, `front_desk_routes.py`, `front_desk_watch_routes.py`.
- `front_desk_work_routes.py`.
