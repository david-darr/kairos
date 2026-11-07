# core/

The engine: how a turn runs, which tools a model gets, what is allowed, and
where state lives. Routes and services call into it; it never imports `tabs/`.

## Where things are

- **Turns (one brain per provider):** `brain.py` (Claude Agent SDK),
  `codex_brain.py`, `external_brain.py` (API and local models),
  `antigravity_brain.py`; `providers/` holds the wire clients. What every model
  is told first: `system_prompt.py`.
- **Tools:** `tool_registry.py` declares every model tool once, for all
  providers. `tool_search.py` is the search bridge for tools not listed directly;
  `tool_access.py` issues Codex's per-turn tool tokens; `hive_mind_server.py`
  serves the tools to Claude; `memory_tools.py` holds the shared-memory tools.
- **Safety:** `permissions.py` (the one approval gate), `turn_taint.py` and
  `untrusted.py` (outside content), `middleware.py` and `auth.py` (accounts),
  `task_scope.py` (trusted owner of a background run), `workspace.py`,
  `secret_storage.py`, and the contained runtimes `sandbox.py` and `computer.py`.
- **Sessions and runs:** `session_manager.py` over `session_manager_store.py`
  (SQLite), `runs.py`, `chat_tasks.py`, `file_checkpoints.py`. Usage read from the runs:
  `session_usage.py` (one chat's sums, the context pill's meter), `model_stats.py` (each
  model's speed and reliability over recent days), `run_cost.py` (each run's cost and its status),
  `model_prices.py` (the bundled dated price snapshot), `price_feeds.py` (public price lists, daily),
  `context_breakdown.py` (what fills a local or API chat's window, by part).
- **Integrations:** `integrations.py`, `mcp_client.py`, `mcp_bridge.py`,
  `mcp_oauth.py`, `connectors/`, `channels/`, `email_send.py`,
  `google_workspace.py`, `dav_client.py`.
- **Tabs contract:** `tab_api.py` (stable, versioned), `tab_hooks.py`,
  `tab_folders.py`, `tab_install.py`, `tab_checks.py`, `custom_tabs.py`,
  `home_cards.py`.
- **Background work:** `task_scheduler.py`, `helpers.py`, `swarm/`, `events.py`,
  `outbox.py`.
- **Models:** `model_endpoints.py`, `model_catalog.py`, `model_discovery.py`,
  `ollama_client.py`, `llamacpp_engine.py`, `claude_cli.py`, `codex_cli.py`.
- **Design canvas:** the `design_*.py` files. **Computer use:** `computer*.py`.
- **Storage:** `settings.py`, `constants.py`, `atomic_io.py`, `vault.py`,
  `backup.py`, `system_admin.py`.

## Rules

- A new model tool is one `register(...)` in `tool_registry.py`. Mark it
  `core=True` only if most chats need it: small and deferred tool lists show
  only core tools, and the rest are found through the search bridge.
- Never let a tool argument choose whose data is read or written; use
  `task_scope.py` or the session's owner.
- Tool results that carry outside text are wrapped and taint the turn.
- Tests: `scripts/test_tools.py`, `scripts/test_chat.py`,
  `scripts/test_permissions.py`, `scripts/test_owner_isolation.py`.

## Bots redesign, Phases 1 to 3

- `bot_app_event_adapters.py`, `bot_app_events.py`, `bot_attention_store.py`, `bot_automation_tools.py`, `bot_chat_store.py`.
- `bot_codex_transport.py`, `bot_event_receipts.py`, `bot_held_secrets.py`, `bot_message_tree.py`, `bot_outbound.py`.
- `bot_policy.py`, `bot_routine_checks.py`, `bot_routine_runner.py`, `bot_schedules.py`, `bot_tool_catalog.py`.
- `bot_tool_results.py`.

Bots Phases 4-6 (teams, front desk, workbench, data, usage, lifecycle, voice, onboarding):
- `bot_assignments.py`, `bot_chief_tools.py`, `bot_delegation_tools.py`, `bot_loop_guard.py`, `bot_room_tools.py`.
- `bot_rooms_store.py`, `bot_team_tools.py`, `front_desk_checks.py`, `front_desk_tick.py`, `front_desk_tools.py`.
- `front_desk_watch_adapter.py`.
