# electron/

The desktop shell. It starts the backend, owns the windows and tray, and gives
the page a narrow bridge.

## Where things are

- `main.js`: windows, tray, the backend process, updates, and one
  single-instance lock per instance.
- `instance.js`: named instances (`--instance=<name>`), each with its own data
  folder, lock and port.
- `preload.js`: the only bridge the page gets (`window.jarvis`); the page never
  has Node.
- `browser.js`: the native side browser; `safeUrl` is the one gate for every
  address it loads.
- `chat-windows.js`, `forgePreview.js`, `designRender.js`, `launch-flags.js`,
  `desktop-log.js`, and the `screen-grab-*` files (Quick Entry and capture).
- Packaging: `afterPack.js`, `installer.nsh`, `package.json`.

## Rules

- Tests start their own named instance with a temp profile and their own
  ports. Never drive the installed app or a person's own instance.
- Electron test runs take `data/electron.lock` one at a time; see
  `scripts/AGENTS.md`.
