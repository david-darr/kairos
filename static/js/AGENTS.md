# static/js/

The UI. Plain ES modules served as they are, with no build step. `app.js` boots
the shell; `api.js` holds the fetch helpers and `el()`; `views/` has one module
per tab (`views/chat.js`, `views/settings.js`, `views/tool-store.js` and so on).

## Where things are (by name prefix)

- `chat*`: the chat surface; `chatStream.js` mirrors live turns from the
  server, `chatActivity.js` draws the activity chip.
- `mobile*` and `phone*`: the phone layout. `redesign*`: the desktop redesign.
- `bots*` and `views/botsHome.js`, `views/botsShell.js`: the Bots mode (2026-10-28):
  `appModes.js` holds the three modes; `botsUi.js` the row kit; `static/css/bots.css` its tokens.
- `forge*`, `agent*`, `vault*`, `design*`, `call*`, `notch*`, `swarm*`: one
  feature each.
- `browserPane.js`: the side browser. In the desktop app its page is a native
  view drawn above the HTML, so anything shown over it must hide it.
- `vendor/`: third-party bundles, built by `scripts/build-chat-vendor.cjs` and
  `scripts/build-forge-vendor.cjs`. Do not edit by hand.

## Rules

- After any change here, run `scripts/build_site_demo.py`; the website demo is
  generated from these files.
- Follow `specs/frontend-style.md`; colours and type come from the shared
  tokens in `static/css`.
- UI checks run against the mocked backend `demo/fixtures.js`.
