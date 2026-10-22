// electron/launch-flags.js - how this launch was asked to start.
//
// --background (the Kairos CLI, 2026-10-22): start the backend and the tray
// with the window created but not shown. The CLI uses it when no Kairos is
// running, so a terminal can attach without a window popping up. The window
// still loads, because it is where a terminal's pairing prompt appears; that
// prompt brings it forward (static/js/cliPair.js). Pure, so
// scripts/test_cli_launch_flags.cjs can check it without Electron.

function wantsBackground(argv) {
  return (argv || []).includes("--background");
}

module.exports = { wantsBackground };
