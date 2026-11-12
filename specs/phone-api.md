# Phone API (the desktop side of the Kairos iPhone app)

Last updated: 2026-11-12, branch `feature/phone-api` (not on `dev`; 2.3.0 is frozen)

The contract both sides build to is `docs/PHONE-API.md` in the `kairos-ios` repository. This note says what the
desktop built to it, every security choice and why, and each place the desktop differs from the contract or the
push relay's shapes do not fit. Nothing here has been run against a real phone or the real relay yet (see the end).

## Scope

`core/phone_devices.py`, `core/try_limits.py`, `core/phone_push.py`, `core/middleware.py`, `core/mobile_activity.py`,
`routes/phone_app_routes.py`, `routes/ring_routes.py`, `routes/auth_routes.py`, `services/phone_home.py`,
`services/mobile_notifications.py`, `services/rings.py`, `static/js/iphonePairing.js`. Tests: `scripts/test_phone_api.py`,
and additions to `scripts/test_auth.py` and `scripts/test_account_isolation.py`.

`/api/phone` is also the prefix of the telephone connection (`routes/phone_routes.py`, Twilio and Telnyx). The two
share the prefix and nothing else.

## Routes

| Route | Who | What it does |
|---|---|---|
| `POST /api/phone/pair/start` | a signed-in browser session, never a phone token | Makes the account's pairing code: `{code, expires_at, address}`. Six digits, ten minutes, one use. A new code cancels the old one. `address` is the remote access address, or `null` while remote access is off. |
| `POST /api/phone/pair/claim` | nobody signed in | Trades a code for `{token, device_id, account, server}`. Wrong or expired: `400`. Too many tries: `429` and the code is cancelled. |
| `GET /api/phone/session` | any sign-in | `{account, device_id, server}`. `device_id` is `null` for a browser. |
| `GET /api/phone/devices` | any sign-in | The account's own paired phones; `current` marks the phone asking. |
| `DELETE /api/phone/devices/{id}` | any sign-in, own phones only | `204`. The token dies at once, its streams and websockets close, its push registration goes. Another account's phone: `404`. |
| `GET /api/phone/home` | any sign-in | `{usage, next_event, needs_you, running}` for the caller's account. |
| `POST /api/phone/push/register` | a paired phone, for itself | `204`. Stores the phone's Apple tokens. One registration per phone; sending again replaces it. |
| `DELETE /api/phone/push/register` | a paired phone, for itself | `204`. Removes it (and asks the relay to forget the phone). |
| `POST /api/phone/push/activity` | a paired phone, for itself | `204`. A Live Activity's push token for one of the caller's own chat runs. Someone else's run: `404`. |
| `GET`, `PUT /api/phone/push/relay` | an admin in a browser session | The push relay's address (a setting of the whole install). Not in the contract: it is the desktop's own settings route. |
| `GET /api/rings/{ring_id}` | any sign-in, own rings only | `{id, agent_id, bot_name, status, seconds_left}`; status is `ringing`, `answered`, `declined` or `expired`. Never the reason for the call. |
| `POST /api/auth/login` | (changed) | Wrong tries are now limited; see "Sign-in try limit". |

Every other route takes the phone's token unchanged: `Authorization: Bearer kph_...` in place of the session cookie.

## How a token signs in

`core/middleware.py` `get_current_user()` is the one place every route, stream and websocket asks "who is this".
It now reads a phone token before the session cookie. A valid token answers the account's user name and nothing
else, so everything after it (the account folder, ownership checks, `require_admin`, machine access) is exactly what
a browser session gets. There is no second code path and no stored "is admin" on the token: rights are read from
the account on every request, so demoting an account demotes its phones at that moment.

`AccountContextMiddleware` (the outermost layer) answers a request that carries a phone token itself in two cases,
before any route runs: `401 {"detail": "authentication required"}` when the token is unknown or removed, on every
`/api` path; and `403` when a valid token is aimed at a desktop-only route (below).

Streams and websockets opened with a token are registered with the same guard that ends a browser session's
connections (`_SessionGuard`), under `phone:<device id>`. Unpairing sets it at once (a websocket closes with code
4401, a stream ends); every connection is also re-checked every 15 seconds.

## Security decisions

Each is the stricter of the choices that were open.

1. **Only a hash is kept.** The token is `kph_` plus 256 random bits. `data/phone_devices.json` holds its SHA-256,
   never the token. Guessing is not a practical attack at that size, so wrong tokens are not counted (a count would
   let anyone lock a phone's address out).
2. **A token is bound to the user name and the account's folder id.** A deleted account's token never opens a later
   account that reuses the name.
3. **Header only.** The token is read from `Authorization` alone. Never a query string (addresses reach logs and
   history), never a cookie, never another header.
4. **A token is judged alone.** A request that shows a phone token is never also judged by a cookie beside it. A
   dead token with a live cookie is `401`, not that cookie's account.
5. **Accounts must be on.** With accounts off a token opens nothing and no code can be made.
6. **Codes live in memory only**, one per account, six digits, ten minutes, single use. A restart cancels them.
7. **Wrong codes, per address.** Five wrong codes from one address inside ten minutes: `429`, every waiting code is
   cancelled, and that address is refused (even with the right code, even for a new code) until its ten minutes
   pass. While locked its tries are not looked at, so they cannot wear down a new code. An IPv6 caller is counted by
   its /64. The address is the connection's own; forwarded-address headers from other machines are not trusted.
8. **Wrong codes, per code.** The phone sends only a code, no account name, so a wrong try cannot be pinned on one
   code. It counts against every waiting code, and a code is cancelled after five, from any addresses at all. A code
   therefore faces at most five guesses in a million, however many addresses the guesser has. The cost: someone who
   can reach the desktop can cancel a waiting code by guessing. The person makes a new one.
9. **A wrongly shaped code is a wrong try**, not a validation error that costs nothing. Spaces typed with the code
   are dropped first (the settings page shows it as "482 913").
10. **Codes are compared in constant time**, against every waiting code, with no early exit.
11. **Desktop-only routes.** A phone token never opens: `POST /api/phone/pair/start`, `/api/phone/push/relay`, all
    of `/api/auth/*` except `GET /api/auth/status`, all of `/api/remote/*`, `/api/system/backup/*`,
    `/api/system/wipe` and `/api/system/wipe-kinds`. The reason for the first is that a stolen token must not be able
    to pair a second phone that survives the first being removed. The rest mint or manage sign-ins (passwords,
    two-step codes, users, the switcher), open or close the door itself, or export or erase the whole install. The
    list is `DESKTOP_ONLY` in `core/phone_devices.py`; `get_current_user()` enforces it too, so a route is refused
    even where the middleware is not mounted.
12. **What ends a token.** Unpairing it (from the phone or the desktop), a password change, an admin's password
    reset, a reset by emailed code, and deleting the account. The last four end every phone of the account. A
    password change is the moment to assume a sign-in was exposed, and browser sessions already end there.
13. **At most ten phones per account.**
14. **Requests from another site.** `pair/start`, removing a phone from a browser and setting the relay address
    refuse a request whose `Origin` or `Sec-Fetch-Site` says another site (the cookie is `SameSite=Lax` already).
15. **Nothing is logged.** No code path logs a token, a code, an Apple token or the relay secret, and tests check
    it. As a net under that, `core/logs.py` masks anything shaped like `kph_...` in every log line.
16. **Names a phone gives itself are cleaned** (control characters out, bounded) before they are stored or shown.
17. **Unknown user names cost a password check.** `verify_password` used to answer at once for a name that does not
    exist, which told a caller which names do. It now spends the same bcrypt check.
18. **Members.** Any signed-in account may pair its own phone through the routes. The settings section sits on the
    Remote Access page, which only admins see, so today a member has no screen to do it from. That is a gap in the
    UI, not a restriction in the routes; moving the section is a design decision left open.
19. **`pair/start` shows the remote address to whoever is signed in**, admin or not. They need it to pair, and they
    are already signed in to this Kairos.

## Sign-in try limit

`POST /api/auth/login` counts failures only, over ten minutes, in memory:

- five wrong tries from one address (IPv6 by /64), whatever names it tried;
- ten wrong tries for one user name from every address together. This second count never locks out this computer
  itself (loopback), so someone on the network cannot keep the owner out of their own desktop. Loopback is still
  held to the per-address count.

A locked caller gets `429` with `Retry-After` before the password is looked at, so a locked try can never be the
right guess and adds to neither count. A wrong two-step code counts. A missing one does not: the sign-in page
sends the password alone first and shows the code field on that answer. A right sign-in clears nothing, so holding
one valid account buys no guesses at another. A restart clears the counts.

Not changed here: session cookies are still not marked `Secure`, and the "current password" checks on
`/api/auth/password` and `/api/auth/account/switch-pin` (which need a live session) are not limited.

## Home at a glance

`usage`: each connected plan's fullest window, `{provider, percent, resets_at}`; a plan with no reading is left
out. `next_event`: the soonest event that has not ended, within fourteen days, from the same sources as the
Calendar page (local events, due notes, tab hooks, Google for admins), with a six-second limit so a slow Google
answer cannot stall a widget. `needs_you`: the Bots inbox's needs-you rows plus model chats stopped on a permission
prompt. `running`: the caller's chats with a turn in progress. A part that cannot be read is left empty (`[]`,
`null`, `0`) and logged; the read never fails as a whole.

## Push

The desktop holds no Apple key and never talks to Apple. A paired phone's registration is a row in the same
`devices` table and outbox Web Push uses (`core/mobile_activity.py`), so every notification kind, the preferences,
expiry, coalescing and every check at send time (still paired, the chat is the owner's, the ring is still ringing,
the permission is still waiting) apply to it unchanged. Only the last hop differs: `services/mobile_notifications.py`
posts to the Kairos push relay at the address in settings (`phone_push_relay_url`).

- **No relay address: nothing is queued for a phone and nothing is sent**, including the "forget this phone" calls.
- **Registration with the relay is lazy.** `push/register` only stores the tokens here. The first time a push is
  due, the desktop calls `POST /v1/installs` and keeps the `install_id` and the `secret`; the secret is encrypted
  with the install key (`core/secret_storage.py`), never logged, never returned by any route. New tokens are sent
  with a signed `PUT` before the next push. Unpairing, `DELETE push/register` and a `410` queue a signed `DELETE`,
  retried with backoff for up to a week, and only sent to the relay address currently in settings.
- **Signing** is the relay's: `X-Kairos-Timestamp` and `X-Kairos-Signature` = HMAC-SHA256 over
  `"<ts>\n<METHOD>\n<path>\n<sha256hex(body)>"`, keyed with the hex text of `sha256(secret)`.
- **The relay address** must be `https://host[:port]` with no path, sign-in, query or fragment (plain `http` only
  for this computer itself). Redirects are never followed and proxy settings are not used.
- **What the relay is told:** the phone's tokens once, then per push a kind and at most a name. Never a message, a
  chat title, a session id or the reason for a call.

| Desktop kind | Relay push |
|---|---|
| chat reply ready (`completed`) | alert `message` |
| chat needs a permission (`permission`) | alert `approval` |
| chat asks a question (`permission`, kind question) | alert `needs_you` |
| chat failed (`failed`) | alert `needs_you` |
| bot needs you (`bot_needs_you`) | alert `needs_you` |
| bot results (`bot_results`) | alert `done` |
| a bot rings (`bot_call`) | `ring` with `ring_id`, `expires_at`, `who`; once, not the browser's three |
| a ring ended (`bot_call_end`) | nothing yet (see below); the phone asks `GET /api/rings/{id}` |
| a chat run changes state | `activity` `update` or `end` to that Live Activity's own token |

`who` is the bot's name (looked up in the owner's own account) or "Kairos". A bot's push goes only to phones of the
account the bot belongs to.

### Built to the phone's native contract

The phone's side is `docs/coverage/native.md` in `kairos-ios` ("Push payload"). `core/phone_push.py` `message_for()`
builds each push in full to that contract, then keeps only the fields the relay accepts today (`RELAY_KINDS`,
`RELAY_FIELDS`). When the relay learns a field or a kind, it is added to those two constants and nothing else changes.

- **Live Activity content state** is the phone's `KairosActivityAttributes.ContentState`, every key it decodes:
  `{"phase", "step", "detail", "stage", "helpers", "startedAt", "muted"}`. Phase: running is `running`, waiting on a
  permission is `waiting`, completed is `done`, failed is `failed`, stopped or interrupted is `stopped`. `step` is
  one of five fixed phrases ("Working", "Waiting for you", "Done", "Couldn't finish", "Stopped"); `detail` is empty,
  `helpers` is empty, there is no `progress`: those would be the chat's own words. `startedAt` is seconds since
  2001-01-01, which is how ActivityKit reads a date. Updates go out on a change of phase, not per step or per word.
- **Which activities.** The desktop follows chat turns (the phone's `reply` kind). `push/activity` takes the
  phone's kind names (`reply`, `task`, `team`, `render`, `forge`, `call`, and `chat_run` from the contract's example)
  for an `activity_id` that is one of the caller's own chat turns; any other id answers `404`. Task, team, render,
  forge and call activities have nothing on the desktop that pushes their state yet.
- **Push-to-start.** The phone sends its push-to-start token as activity `push-to-start`, kind `start`. It is stored
  with the phone and not used: the desktop sends no `start` push. Open decisions: when a turn is long enough to start
  one, and what title and link may go to the relay in the activity's attributes.
- **The end of a ring** is built as a background push, `{"kind": "ring_end", "ring_id", "outcome"}`, never a call
  (VoIP) push, because every call push must show an incoming call. The relay has no background push, so `ring_end`
  is not in `RELAY_KINDS`: nothing is queued or sent for a phone today. The relay request shape is the desktop's
  proposal; the Apple payload the phone reads is `{"kind": "bot_call_end", "ring_id", "outcome"}` with outcome
  `answered`, `declined` or `missed`.
- **Alerts.** For each alert the desktop works out what the phone reads: its kind and category (`kairos.replyReady`,
  `workFailed`, `approval`, `question`, `workDone`), the link a tap opens (`kairos-agents://chat/<id>`, `bot/<id>`,
  `approval/<request>?bot=<id>`), `request_id`, `activity_id`, `thread_id` and the interruption level
  (`native_alert()`). None of it is sent: the relay writes the Apple payload itself from `what` and `who`.
- **Rings.** The phone reads `ring_id`, `agent_id`, `bot_name`, `expires_at`. The desktop builds all four; the relay
  takes `ring_id`, `expires_at` and `who`.

Relay answers: `200` sent; `401` forget the install and register again on the retry; `409`, `422` and other `4xx`
dropped; `410` drops the phone's push registration (for an activity push, only that activity's token); `429`, `5xx`
and no answer retry with backoff, at most five times.

## Where the desktop differs from PHONE-API.md

1. **Desktop-only routes** (decision 11). The contract says a token has "the same rights as that account's browser
   session, on every `/api` route". It does, except those routes, which answer `403`.
2. **`401` comes from the middleware on every `/api` path**, including ones that need no sign-in (`/api/health`),
   when the request carries an unknown or removed phone token. `pair/claim` is the one exception.
3. **A locked-out address stays locked for its ten minutes** even after a new code is made. The contract's message
   ("Make a new code on your desktop") stays as written; it is true for the per-code limit, and for the per-address
   limit the person also has to wait. `429` carries `Retry-After`.
4. **`next_event.starts_at` is a date (`YYYY-MM-DD`) when `all_day` is true**, and a UTC time otherwise.
5. **`GET /api/phone/session` answers a browser session too**, with `device_id: null`.
6. **`locale` is stored and not used.** The relay writes the sentence and has no locale.
7. **`push/activity` takes more kinds than the contract's example**: the phone's own (`reply`, `task`, `team`,
   `render`, `forge`, `call`), `chat_run`, and `start` with the id `push-to-start`. Except for `push-to-start`,
   `activity_id` must be a chat turn's id (`turnId` on the live stream) for a run the caller owns, else `404`.
8. **`server.version` is the full version string**, for example `2.3.0-beta.4`.

## Where the relay carries less than the phone asks for

The phone's contract (`native.md`) and the relay were written apart. These are the places they do not meet. Each is
a change to the relay or the phone, not to the desktop, which already builds the missing fields.

1. **A tap cannot open the exact chat or approval.** The phone reads `link`, `request_id`, `activity_id`,
   `activity_kind` and `kind` from an alert, and `aps.category`, `thread-id` and `interruption-level`. The relay's
   alert payload has a fixed title and sentence, a sound, and `kind` set to its own word (`message`, `needs_you`,
   `approval`, `done`). So an alert opens the app at Home, shows no Approve, Deny or Reply buttons, is never time
   sensitive and is not grouped by bot.
2. **The relay's four words are not the phone's kinds.** The phone has `replyReady`, `workDone`, `workFailed`,
   `approval`, `question` and eleven more (team, posted, spend, calendar, usage and so on). A failed chat goes out
   as `needs_you`, a question as `needs_you`, a test as `message`. The desktop has no source yet for the phone's
   other kinds (team updates, posts, spend, calendar reminders, the morning brief, Forge, usage).
3. **The call screen gets no bot id and the wrong key for the name.** The relay's call payload is
   `{kind, ring_id, expires_at, caller}`. The phone reads `agent_id` and `bot_name`, so it shows "A bot" and treats
   the caller as Kip.
4. **The end of a ring cannot be pushed.** The relay has no background push. Until it has, a phone's call screen
   for a ring answered elsewhere ends when the phone asks `GET /api/rings/{id}` or the ring's own time runs out.
5. **A ring needs a VoIP token.** A phone that registered none gets a `needs_you` alert instead of a call.
6. **Live Activity details.** The phone's content state has a step in the work's own words, a detail line, progress
   and helper chips. The desktop sends fixed words and leaves the rest empty, on purpose (the relay's own rule is "a
   phase name, a percentage"). Whether the person may opt in to more is a product decision; nothing reads the phone's
   "Show a preview" setting on the desktop.
7. **Push-to-start is not used** (see above), and the relay's `start` adds its own alert text, "<who> is working".
8. The relay accepts no locale, so alert text is English.
9. The relay limits 30 pushes a minute per phone. The desktop sends well under that, but does not count for itself.
10. `POST /v1/installs` is open and limited to 10 an hour per address; a desktop that keeps getting `401` would
    re-register on each retry. The desktop retries a push at most five times, so this is bounded.
11. The install id is part of the request address, so it appears in `httpx`'s request log lines. It is an
    identifier, not a secret: requests still need the signature.

## Not verified

- No real phone has paired, signed in, held a stream or a call. The Swift side has not been run against this.
- No real relay and no Apple delivery: the sender is tested against a local stand-in written from the relay's
  README (same routes, same signature check, the same refusals), not against the deployed Worker.
- The Live Activity content state was written from the phone's Swift source by reading it; no phone has decoded one.
- The settings section was looked at once, in the offline website demo with made-up answers for its routes (remote
  access on and off, a code showing, two phones listed). It has not been used against a real backend in the app window,
  and the Electron checks `test_changed.py` picks for the settings files (boot, g7, g8, a14-settings, app-shell,
  bots-connections, bots-onboarding, g1, mascot) were not run. Run them before this merges.
- The other sign-in routes were not given try limits: `/api/auth/reset-password` allows five guesses per emailed code
  and a new code every minute, and that is unchanged.
- Tailscale's real listener: the try limits were tested with addresses the test client supplies, not over the tailnet.
- No Cloudflare Tunnel exists yet. Behind any proxy every caller would share the proxy's address, and the
  per-address limits would need the proxy's forwarded address, trusted only from that proxy.
