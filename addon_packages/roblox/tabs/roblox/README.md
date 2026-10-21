# Roblox workspace

Optional Roblox Development Tool Store add-on with a companion `roblox_studio` tool. It runs native
Roblox Studio on the computer hosting Kairos. Each Kairos user owns their
account connection, project metadata and chats. Native Studio control is
administrator-only on a shared installation.

## Setup

1. In Tool Store, install the Roblox Development add-on and open its workspace.
2. Install current Roblox Studio on the Kairos host computer. In Studio,
   open Assistant > Manage MCP Servers and enable Studio as MCP server.
3. For account sign-in, register a Roblox OAuth app. In the tab's administrator
   setup, save its client ID and exact registered callback URL, ending in
   `/api/tab-roblox/oauth/callback`. Enable `openid`, `profile`, `universe:read`.
   Use PKCE for a public desktop client, without a bundled client secret.
   A secret may be configured for a separately registered confidential client.
   Roblox registration/review is external to this implementation.
4. Connect the Roblox account. Load public creations and explicitly authorized
   experiences. Other private, archived or group places can be linked by their
   universe and place IDs. Sign-in is not proof of edit permissions in Studio;
   Studio authenticates independently.
5. Create an experiment, link a cloud game, or upload a local `.rbxl`/`.rbxlx`.
   Open it in Studio, refresh the window list, and connect its matching window.
   Projects appear first on the home screen; account/OAuth setup is under
   Account & setup. The project view keeps chat beside inspector tabs for
   Connection, Brief, Style, Assets, Files and Activity.
6. For existing games, save a matching place copy in Studio and upload it before
   enabling AI edits. For a new experiment, use the disposable unpublished
   baseplate created by Open in Studio.
7. Choose a model in the project chat. Describe the game and attach model
   reference images, UI mockups, screenshots or supporting files. The composer
   accepts file selection, pasted images and drag-and-drop. Image references
   require a model configured to accept images. Roblox assets and 3D mesh
   imports depend on the installed Studio tools; an attached image is design
   evidence, not an automatically imported model.

## Recovery and constraints

- Source snapshots precede Edit-mode script/world mutations. Playtest controls
  and runtime actions do not need an Edit DataModel snapshot, so Stop remains
  usable during a playtest. Tool access still checks the selected window.
- Source snapshots are JSON envelopes containing Studio's script-source dump.
  They do not roll back terrain, models, properties, or external side effects.
  Download the saved place copy to recover a whole place, and reopen it in Studio.
- Save work using Studio's normal save controls. Kairos does not silently
  publish or save over a cloud place. Downloadable uploaded place copies are
  recovery files, not automatic exports of the current unsaved Studio state.
- Native tool schemas are read from the installed Studio server. Unsupported
  tools remain unavailable. Upload and autonomous subagent tools are excluded.
- Local projects carry a project marker that must match the selected window.
  Cloud targets must match the project's place ID. One window can belong to
  only one linked project at a time. Finish/Stop the current chat before
  changing the connection or uploaded recovery file.
- Pairing upgrades legacy root-only markers to a ReplicatedStorage folder so
  identity survives Play. Stop Play manually and reconnect once for an older
  project. Pairing rechecks identity inside the marker update itself. Every
  call checks exact identity across Edit/Server/Client; unavailable or nil
  responses never count as proof and foreign markers always refuse access.
- Open in Roblox Studio first searches for an existing verified window. It
  returns that window for explicit connection, refuses ambiguous matches,
  and does not open a replacement blank experiment after work has started.
  Upload a saved place copy before reopening a previously opened experiment
  whose original window is no longer available.
- The connection bar checks actual native state at entry, after turns and
  every ten seconds while idle. Busy checks do not interrupt a running call.
  Reconnecting preserves the composer draft and staged references. Probe
  failures and native text errors are recorded, rather than shown as success.
- Tool discovery is compact by default; `roblox_studio action=tools name=...`
  returns one full schema. Codex can pass complex Luau arguments through
  `--arguments_file` with a UTF-8 JSON file, avoiding nested Windows quoting.
- Data lives outside the application under `tab-data/roblox/`; credentials are
  encrypted separately from project files. Account tokens never enter prompts.
- Knowledge guides are vendored from the MIT-licensed MSayib/roblox-dev-skill;
  the bundled skill retains its license and exact upstream commit/checksums.

## Personal style and creative tools

Each project captures its verified Roblox account ID at creation, or `local`
when no account is connected. Style presets are private to that Kairos owner
and Roblox account. The project panel supports confirmed UI/model defaults,
tentative suggestions with quoted evidence, locks, edits, forgetting, revision
restore, learning controls and project-only overrides. Confirmed style context
is refreshed for every project-chat turn. Explicit lines such as
`Remember my UI colors: warm sunset` save a preference directly. Other durable
preferences are suggestions until the owner accepts them. Generated outputs
and attached references do not silently become standing preferences.

Tool Store includes private **Blender** and **Higgsfield** connection cards.
Select them using **Creative tools** in a chat or Forge conversation, or in
the bot profile's Access section. Roblox project chats use the same selection.
An ownerless bot chat can inherit only its platform-bound bot's explicitly
assigned connection; another user's owned chat cannot inherit it.

- Blender uses the downloadable Kairos add-on, a bearer-authenticated loopback
  connection, and the actual saved .blend file. The native add-on is not a
  Python sandbox. Each approved Python execution first saves a checkpoint;
  a failed or cancelled save prevents execution. Pairing and native control
  require an administrator. No packages, community installers or telemetry
  are installed automatically.
- Higgsfield uses the official MCP endpoint and OAuth. Sign in from the host
  computer for its local callback. Eligible subscription/credits are external.
  Changed tool schemas are held for explicit review. A web unlimited benefit
  does not imply free MCP generations.
- Potentially paid requests and Blender Python require fresh approval even
  under Auto. Complete request arguments are visible. Unattended requests
  deny when there is no approval surface. Failed/interrupted operations keep
  an uncertain-request guard; the owner checks native/provider history and
  clears it in Tool Store before another identical attempt. No automatic retry.
- `roblox_assets` records source, creator/license, exported project file,
  specifications and reported import/verification state. A reference image
  or exported model is not an imported Roblox asset. Unsupported upload/import
  steps remain explicit manual handoffs through Studio.

The Roblox add-on installs `roblox-dev-skill`, `roblox-ui-design` and
`roblox-asset-pipeline`. Install the independent Blender and Higgsfield add-ons
to get their respective connection and creation skill. Neither is required for
Roblox. Disable/remove add-ons in Tool Store; saved projects/styles/connections
and edited skills remain available after reinstall.

## Automated checks

`python scripts/test_creative_tools.py` checks private account selection,
style isolation/evidence/locks/history, OAuth round trip, full approval text,
schema review, uncertainty guards, provenance paths and native checkpoint rules.

`python scripts/test_roblox.py` checks ownership, OAuth state/PKCE lifecycle,
encrypted tokens, partial game discovery, target checks, edit authorization,
recovery, image results, playtest Stop, and supporting-reference confinement.
`node scripts/run-electron-test.cjs scripts/roblox-smoke.cjs` runs the real renderer and composer in isolated
Electron fixtures at desktop and phone widths. Real account authorization and
native Studio tool calls require the corresponding live setup above.
