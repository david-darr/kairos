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
`remote_routes.py`. Tools for Codex: `tool_routes.py`.

## Rules

- Access comes from the dependencies in `core/middleware.py`: a signed-in user,
  or an admin for admin surfaces.
- A route that reads or changes per-person records checks that the caller owns
  them; an admin flag alone is not ownership.
- New request bodies are pydantic models with bounds; never trust a client path.
