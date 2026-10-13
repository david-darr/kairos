# Mobile chat activity and notifications

Status: Home Screen notifications and server-managed chat implemented in the Forge worktree. David confirmed phone preview and the native redesign/Dynamic Island work on his iPhone. Native development and public distribution are deferred while using a free Personal Team; source and upgrade archives are preserved under `ios/`. APNs background updates remain unimplemented. Automated Swift compilation and full release acceptance remain pending.
Date: 2026-10-12.

## Intended experience

A person starts a chat, locks their phone or switches apps, and the work continues on the Kairos host. The phone shows meaningful progress, alerts when attention is needed, and opens the exact chat when tapped. This applies to ordinary Chats and Forge chats.

| Run state | In-app activity | Notification | iPhone Live Activity |
| --- | --- | --- | --- |
| Running | Chat label, elapsed time, bounded phase | None by default | Working; elapsed time; bounded phase |
| Awaiting permission | Needs your approval; request expiry | Permission needed; tap to review | Needs approval; open chat |
| Completed | Reply ready | Reply ready; tap to open | Completed, then end activity |
| Failed | Work failed; retry context | Work failed; tap to inspect | Failed, then end activity |
| Stopped | Stopped by user | None by default | End activity |

Use phases such as Working, Using tools, and Writing response only when supported by actual events. Do not invent percent completion. Chat titles and content previews are opt-in; the default lock-screen text is generic. Review permissions inside the authenticated app, with the command, target, scope, and expiry visible.

## Current evidence from Kairos

- `routes/chat_routes.py:140`: POST `/api/chat/stream` iterates the model turn directly inside the HTTP streaming response.
- `services/chat_service.py:527`: `_stream_message` owns execution. Its cancellation path saves a partial answer, calls `brain.cancel()`, records a stopped run, and closes the brain. Browser disconnection can therefore interrupt execution; switching between Kairos views alone is handled by the existing client registry.
- `services/chat_service.py:619`: permission delivery uses an in-memory channel. Stream cleanup closes it at line 672 and denies requests still waiting.
- `static/js/chatStream.js:14`: active UI state lives in a browser module Map; it is not a reconnectable server activity feed.
- `static/js/floatingProgress.js`: existing floating cards provide a useful presentation surface for shared server activity state.
- `core/runs.py` and `routes/run_routes.py`: run history and events already exist. Reuse their identifiers and event semantics; the full timeline is admin-only and should not be exposed by a mobile summary API.
- `specs/auth-security.md`: phone access is through authenticated HTTPS Remote Access using Tailscale. Continue using that access model.
- No push subscription, notification service worker, or native iOS target was found in this worktree.

These are direct source observations, not additional REA findings. The earlier Empryo REA evidence is partial static analysis and does not establish Apple platform capabilities.

## Delivery platforms

### Home Screen web app

Add a web app manifest, install icons, a service worker, explicit notification enrollment, Web Push subscription management, and badge updates. On iOS, Web Push is available to Home Screen web apps from iOS 16.4 and permission must follow a user interaction. An ordinary Safari tab is not this installation path. This delivers completion and permission alerts; it does not provide ActivityKit Live Activities.

### iOS companion app

Reuse Kairos's existing web interface inside a small iOS shell, with native authentication/session integration and a SwiftUI WidgetKit extension for Live Activities. ActivityKit controls the activity lifecycle; APNs delivers state changes while the app is backgrounded. The shell needs a restricted navigation and message bridge rather than exposing native functionality to arbitrary pages. Initial activity creation should happen while the person starts work in the foreground; remote push-to-start can be added separately where supported.

Live Activities are an additional display channel. Completion and permission notifications remain available when Live Activities are disabled, unavailable, dismissed, stale, or ended by the system. iOS controls delivery and presentation; do not promise a persistent island or token-by-token updates.

## Build sequence

1. **Independent execution and reconnection.** Add a server run coordinator around the existing chat service. Starting a turn returns a run ID; authenticated clients attach to a replayable event stream and can fetch a current snapshot. Losing a subscriber does not cancel a run. An explicit, authorized Stop cancels it. Keep one active turn per chat and idempotent start requests. Preserve transcript, checkpoints, provider cancellation, helper shutdown, and run accounting. On host restart mark interrupted runs truthfully; do not replay side-effecting tools automatically.
2. **Shared activity and permission lifecycle.** Publish owner-scoped summaries with run ID, session ID, revision, phase, start/update timestamps, pending request IDs/expiry, and terminal outcome. Derive them on the server. Permission channels belong to the active run, not a connected browser. Reconnection retrieves live pending requests; expired requests show as expired and never authorize work. Retain existing permission timeout semantics until explicitly designed otherwise. Enforce ownership/admin access in reads, subscriptions, Stop, and permission answers; authentication alone is insufficient. Handle overlapping requests and activity changes by monotonic revision.
3. **Background alerts for the web app.** Add per-user, per-device enrollment and preferences. Publish permission, completion, and failure events from the server even with no browser attached. Use a persistent delivery outbox with bounded retries, event deduplication, expiry, token removal, and logout/account removal handling. Deep links resolve the authenticated chat and current permission state rather than executing an approval. Badge counts come from outstanding attention items. Do not cache private API responses in the service worker.
4. **Native iPhone Live Activities.** Add the iOS target and WidgetKit extension; register and rotate ActivityKit tokens separately from ordinary notification tokens. Send APNs updates for bounded phase changes and terminal states. Throttle routine updates, prioritize attention events, set stale/end timestamps, and tolerate delivery delays and out-of-order updates. Support compact, minimal, expanded, and Lock Screen presentations. Multiple concurrent chats get explicit selection/aggregation rules. Build and sign through macOS/Xcode and validate on physical devices.

The host must remain awake and connected to run work and send alerts. Push delivery goes outbound to the platform provider; a push alert is not proof that the phone can currently reach the private Kairos server. Opening/reviewing a chat still requires Remote Access connectivity.

## Required verification

- Lock the phone or terminate its UI while a turn is running: the host finishes, records one reply, and sends the expected completion alert.
- Disconnect/reconnect during tool execution: reattach without repeating the prompt or side effects; explicit Stop still cancels and preserves the partial transcript.
- Receive a permission request while locked: tap through to the exact authenticated chat; Allow once/Reject affects only the current valid request. Timeout, logout, cancellation, duplicate taps, and already-answered requests cannot grant permission.
- Two devices and concurrent chats: revisions and IDs prevent duplicate alerts, incorrect deep links, and cross-user data exposure.
- Delivery failure, revoked enrollment, expired tokens, host restart, and delayed completion after a permission alert: truthful activity state, bounded retries, and no stuck badge/activity.
- Physical iPhone: Home Screen installation, notification permission, Focus behavior, disabled Live Activities, Dynamic Island layouts where supported, stale state, and final dismissal.

## Platform evidence

- WebKit, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Apple, Displaying live data with Live Activities: https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
- Apple, Starting and updating Live Activities with ActivityKit push notifications: https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications

## Release decision and implementation

David chose notifications first on 2026-10-12, then requested Dynamic Island testing after the HTTPS phone preview worked. He confirmed access to a Mac with Xcode and later confirmed he uses a free Personal Team. Native development/distribution is now deferred, with the latest Xcode source and all delivered upgrade packages retained in `ios/`; see `ios/README.md` for the resume checklist. Mobile web improvements remain in the host release scope. The iPhone model/iOS are still unknown.

- `services/chat_runs.py` owns asynchronous turns independently of SSE subscribers. The session is reserved before scheduling; a stable client request ID makes retried starts idempotent. The existing chat service still owns model execution, transcript persistence, checkpoints, helper cancellation and usage accounting. Its canonical run ID also identifies mobile activity.
- `core/mobile_activity.py` stores snapshots, the last 1,000 events per run, per-account device enrollment and a deduplicated notification outbox in `DATA_DIR/mobile_activity.db`. Snapshots carry current text and bounded tool projections, while permission snapshots query the live request registry. On boot unfinished runs become interrupted; kept partial text is added to the transcript without replaying tools. Activity history is retained for seven days and pruned at startup.
- `/api/chat/stream` remains the start-and-subscribe surface used by the UI. `/api/chat/runs` starts or lists runs; `/api/chat/runs/{id}` gives a snapshot, `/events` attaches to a current snapshot then ordered events, and `/stop` explicitly cancels execution. Subscriber loss is harmless. Reconnection replaces the browser projection instead of appending duplicate tokens. Authentication and session/run ownership apply to new reads, stops and permission answers; long-lived subscribers also recheck authentication. Active turns are restored on app boot.
- `services/mobile_notifications.py` sends encrypted Web Push from a persistent outbox, even without an attached browser. Completion, failure and permission alerts use generic lock-screen text and an authenticated `/?chat=SESSION_ID` deep link. Requests retain the existing 120-second default expiry. Notification clicks never approve tools. Permission resolution clears queued alerts and removes live permission cards across subscribers. Stopped work has no default alert.
- `core/web_push.py` implements single-record RFC 8291 encryption and RFC 8292 VAPID with the already shipped `cryptography` package; `httpx` sends delivery requests. Provider hosts are explicitly allowed for Apple, Google, Mozilla and Windows. No redirects, cookies or environment proxies are used. A stable per-install signing key is generated locally. `KAIROS_PUSH_CONTACT` can override the VAPID contact URI; otherwise enrollment uses the host's HTTPS URL. Signing keys and browser endpoints remain in private application data and are not logged or exposed as UI settings.
- The outbox retries network failures, 408, 429 and 5xx responses up to five attempts, respects bounded numeric Retry-After, expires alerts, and removes subscriptions on 404/410. Disabling a category invalidates its queued alerts. Enrollment is scoped to account plus the login session hash; logout/account deletion removes devices and queued alerts, and the sender checks session validity before delivery. Expired logins require reenrollment after sign-in. At most ten devices may enroll per account.
- `static/manifest.webmanifest`, install icons and `/sw.js` support Home Screen installation and background notifications. The worker caches no pages or API data. `Settings → Notifications` explains HTTPS/Home Screen requirements, enrolls through an explicit user gesture, offers completion/failure/permission switches, a device test, and removal of earlier enrollments. Notifications open ordinary or Forge chats through existing authenticated navigation.

## Validation of this implementation

- `python scripts/test_mobile_activity.py`: 13 isolated backend/protocol checks pass, including the published RFC 8291 encryption vector, signature verification, disconnect/reconnect, idempotency, Stop, permission timeout/duplicate answers, owner checks, outbox retries/revocation, category disable, device test delivery and restart recovery. No live model or external push endpoint is used.
- `node --experimental-vm-modules scripts/mobile-notification-checks.cjs`: browser protocol checks pass for reconnection without duplicate text, lost start acceptance, server Stop, active-run restore, expired sign-in, private notification contents, safe links, existing-window reuse and iOS user-gesture ordering.
- Existing chat suite: 175 of 179 pass with test port fixed to 8420 and inherited directory permissions for Windows fixtures. The four remaining failures are subprocess-dependent MCP/shell fixtures reporting Windows access denied. The prior streaming failure assertion was updated for the new explicit failed terminal event.
- Python compilation, JavaScript syntax and whitespace checks pass. The hidden Electron renderer launch fails at Windows Mojo/network sandbox permissions before rendering; visual checks remain pending.

## Physical-phone acceptance and rollout

After this build is running on the Kairos host, open its existing HTTPS Remote Access address on the phone. On iPhone/iPad (iOS/iPadOS 16.4+), add Kairos to the Home Screen and open that icon. In Settings → Notifications, choose Enable notifications and accept the OS prompt. Send a test notification, then run a chat and lock the phone. Verify reply-ready and permission notifications, exact-chat navigation, Stop, expiry and two-device behavior. Test permission prompts early enough to answer within 120 seconds. Repeat while Focus is enabled and while Remote Access is disconnected.

The host must remain running, awake and online. Closing/restarting the host interrupts execution; background execution survives losing the phone browser, not losing the host. This pass covers chat turns (including Forge chat turns); unrelated Forge Git/app-launch approval streams and scheduled-task notifications retain their existing behavior. Badges and native Live Activities are not included in this release. Real Apple/Google/Mozilla delivery and physical-device behavior have not yet been verified.

## Native iPhone test prototype (2026-10-12)

`ios/KairosMobile` contains a SwiftUI iPhone shell, the existing authenticated Kairos interface in WKWebView, shared ActivityKit attributes, and a WidgetKit Live Activity extension. Deployment target is iOS 17; Dynamic Island requires a supported iPhone, while other compatible iPhones get the Lock Screen card. The checked-in Xcode project needs no dependency generator or third-party package. Both targets must be signed with the same team on David's Mac.

This is a **foreground-connected prototype**, not the full locked-phone delivery implementation. The native shell calls the existing owner-checked run routes from WebKit's isolated client content world, projecting only IDs, bounded states, revisions and timestamps into Swift. The primary interface remains the web app; no page-visible native message/approval bridge is installed. Top-level navigation is restricted to the chosen HTTPS origin and TLS validation is unchanged. Server/account changes end the current display. Exact-chat links never answer permission requests.

The person opts in to following active chats. Only one activity is followed at once; newest unseen active work is chosen when the prior run ends, or a run is selected explicitly. While foregrounded, the shell polls every three seconds and updates on state changes plus a 15-second freshness heartbeat. Terminal outcomes are fetched by run ID after the run leaves the active list. Transient connection failures retain the last known state; the widget becomes stale after 45 seconds. A short chat that finishes between polling intervals may never start an activity. Native background polling is not claimed or enabled.

The labeled layout demo has manual Working, Needs approval, Reply ready and Failed states. It does not execute work. `pushType` is nil and no Push Notifications entitlement/APNs private key is included. Actual completion/approval updates while iOS suspends the app require the separate per-activity token registry and APNs sender described in build step 4. Existing Home Screen Web Push remains the background alert path; the WKWebView shell does not enroll for Web Push.

Validation on Windows: 14 isolated JavaScript protocol checks pass (private projections, live permissions, terminal lookup, auth expiry, inaccessible runs, origin restriction, malformed summaries and connection failures); Xcode project structure, both plists and the shared scheme pass structural checks. Swift compilation/signing and widget/device UI checks require macOS/Xcode and have not run. A `verify-on-mac.sh` script compiles both targets for the Simulator without signing. Source package includes detailed install/test instructions and can be transferred to the Mac.
