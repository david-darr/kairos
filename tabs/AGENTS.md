# tabs/

Prebuilt tabs that ship with Kairos: `crm/` and `school/`. People install or
build more as folder tabs at runtime.

## What a tab is

One folder: `tab.json` (metadata and declared hooks), `routes.py` (its router),
and optionally `service.py`, `hooks.py`, `view.js` and `view.css`. It talks to
Kairos only through `core/tab_api.py`, and keeps its data under
`data/tab-data/<slug>/` at runtime.

The how-to is the bundled skill `skill_templates/build-custom-tab/SKILL.md`.
The CRM tab's own design and guarantees are in `crm/README.md`.

## Rules

- No base-app module imports tab code; the app calls declared hooks.
- Tab code imports only `core/tab_api.py` from Kairos.
- Data is per account: `data_dir` is `tab-data/<slug>/` in the current account. Old-format tabs (`tabs/routes|services|views` in the data folder) read fixed paths, so they open only in the first admin's account unless their routes module sets `TAB_PER_ACCOUNT = True` (core/custom_tabs.py).
- Tests: `scripts/test_crm.py`, `scripts/test_tabs.py`.
