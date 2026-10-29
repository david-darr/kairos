# Kairos: map for models working on this repository

Kairos is a FastAPI backend (`app.py`) with a plain ES-module web UI (`static/`),
wrapped by an Electron desktop shell (`electron/`). Every model (Claude Code,
Codex, API and local models) reaches the same tools, declared once in
`core/tool_registry.py`.

This is the repository's root map. Each main folder has its own `AGENTS.md`:
what lives where, and the rules that bite.

| Folder | What it holds |
| --- | --- |
| `core/` | Turn handling, tools, permissions, sessions, integrations, tabs contract |
| `services/` | Domain logic behind the routes: chat, agents, tasks, Forge, skills |
| `routes/` | FastAPI routers, one file per area |
| `static/js/` | The UI: ES modules, no build step |
| `electron/` | Desktop shell: windows, backend process, native side browser |
| `tabs/` | Prebuilt tabs (CRM, School) on the stable tab contract |
| `scripts/` | Tests, Electron checks, smoke runs, build and bench helpers |

Also: `cli/` (the `kairos` terminal client), `mcp_servers/` (Codex's tool command
line), `skill_templates/` (bundled skills, seeded into every install),
`addon_packages/` (optional Tool Store packages), `demo/` (the mocked backend the
UI checks run against), `docs/` (website and its generated demo), `specs/`
(architecture notes), `ios/`.

## Rules that bite

- **Data.** App data lives outside the repo, or in `data/` for a dev copy; never
  commit it. Tests point `JARVIS_DATA_DIR` at a temp folder.
- **Python tests.** Run one suite directly:
  `.venv\Scripts\python.exe -B -X utf8 scripts\test_<name>.py`. Clear `NO_COLOR`
  first or the CLI's colour snapshots fail.
- **UI changes.** Any change under `static/` makes the website demo stale: run
  `scripts/build_site_demo.py`; `scripts/test_site_demo.py` checks it.
- **Electron runs** go one at a time machine-wide through the folder lock
  `data/electron.lock`, only for test runs. See `scripts/AGENTS.md`.
- **One permission gate.** Every non-read tool call goes through
  `core/permissions.py`. Do not add a side path around it.
- **Outside text is data.** Wrap it with `core/untrusted.py` and mark the turn in
  `core/turn_taint.py`.
- **Owner identity** comes from the session, the run's trusted scope
  (`core/task_scope.py`) or the account, never from model arguments.
- **Tabs are separate.** The base app never imports tab code; tabs use
  `core/tab_api.py` and declared hooks.
