# Kairos iPhone app — full screen and widgets

**Native development and public distribution deferred (2026-10-12).** Preserve this project and the dated upgrade archives in the repository. David is currently using a free Personal Team and has confirmed the native design works on his iPhone. See [../README.md](../README.md) for the preservation decision and resume checklist. The mobile web release can proceed separately.

**Start with [UPGRADE.md](UPGRADE.md)** for this revision. The bottom Chat / Activity / Setup tabs have been replaced by full-screen Kairos. Connection settings, Live Activities and widget controls now live in the web sidebar's **iPhone & widgets** entry. Includes small/medium/large shortcut and usage widgets. Usage sharing requires matching App Groups in both targets; a Personal Team fallback supports shortcuts without usage sharing.

The original ActivityKit prototype details below still apply to foreground status and APNs limits. References to Chat/Activity/Setup tabs now mean the main app and its sidebar controls. Use the full updated Xcode project; replacing only three Swift files is insufficient for this revision.

Source-only test build, 2026-10-12. Native SwiftUI shell + WKWebView + ActivityKit/WidgetKit extension. No third-party iOS dependencies. The Xcode project is included; no generator needs installing.

## Install on your Mac

1. Unzip the package, then open `KairosMobile.xcodeproj` in Xcode 16 or newer. Use an Xcode version that supports your phone's installed iOS.
2. Select the project in the navigator. Under **Signing & Capabilities**, select your Apple team and **Automatically manage signing** for **both** `KairosMobile` and `KairosLiveActivity` targets.
3. If the sample identifiers are unavailable, change the app's Bundle Identifier to something unique (for example `com.yourname.kairosprototype`), then set the extension to that exact prefix plus `.liveactivity`.
4. Connect your iPhone, enable Developer Mode if Xcode requests it, choose your phone as the run destination, and run the **KairosMobile** scheme. Minimum iOS: **17.0**. This prototype is iPhone-only.
5. Open **Chat** and sign in with your existing Kairos account. The prefilled address is `https://desktop-f50h13p.tail3ee769.ts.net:8433`. Use **Setup → Connect** to change it. Connect Tailscale to the same network as the preview host.

Signing happens entirely on your Mac. This package has no signing team, credentials, certificates, APNs keys, or copied Kairos data. A Personal Team can be used for local testing without Push Notifications or App Groups (see UPGRADE.md); Xcode may require periodic reinstall. Native background push is a separate step requiring the appropriate Apple Developer membership and configuration.

## Test the layout first

This design revision uses the Kairos ring and gilded point, a parchment Lock Screen card, and warm accents on the black Dynamic Island. Status icons distinguish working, approval, completion and errors; stale status says Open to refresh. The Activity and Setup screens use the same warm palette.

See **UPGRADE.md** for installing this revision, selecting your signing team and configuring App Groups.

The web preview also supports a right swipe starting a little inside the left edge for the main menu, a right swipe on the chat title for history, and a left swipe to close either drawer. The outer edge remains reserved for Safari Back. Chat tools in the header contains Files, Generated documents and Summary when available. Refresh the web page to load that revision.

1. Open **Activity → Show demo activity**. This is explicitly simulated and does not start a chat.
2. Go to the Home Screen. On an iPhone with Dynamic Island, inspect the compact view and press and hold the island to expand. Lock the phone to inspect the Lock Screen card. Other compatible iPhones show the Lock Screen presentation.
3. Return to the app, choose **Needs approval**, and inspect again. Repeat with **Working**, **Reply ready**, and **Work failed**. No demo button approves a real request.
4. Completed/failed activities end and may remain on the Lock Screen for up to 60 seconds; iOS controls island visibility and dismissal. **Hide activity** removes the current display.

## Test a real chat

1. Turn on **Activity → Follow active chats**.
2. Start a chat in **Chat**. While the app is foregrounded, it polls the existing authenticated run APIs every three seconds. It follows one chat at a time, choosing the newest unseen active chat when the current activity ends. **Follow** selects a different run explicitly.
3. Observe **Working → Needs approval → Working → Reply ready**, or failure/stop/interruption. For an approval, tap the activity or **Open followed chat** and review it inside Kairos. The activity never authorizes commands.
4. Tap through from the island or Lock Screen and verify the exact chat opens. Switching servers or losing sign-in ends the current display. System-dismissed activities are not automatically recreated during this app session.
5. Disconnect Tailscale while foregrounded, wait 45 seconds, and check that the widget says **Open to refresh**. Reconnect and confirm it resumes without starting another chat.

## Important limit of this build

This build **does not send or receive native APNs updates**. A real chat keeps running on the Kairos host after the phone locks, but the native app cannot keep polling once iOS suspends it. The island shows the last known state and becomes stale after 45 seconds. Reopening the app fetches the current outcome. The elapsed-time display is rendered by iOS and does not mean a background status fetch occurred.

Use the already installed Kairos Home Screen app for Web Push completion/approval alerts. Web Push enrollment is not implemented in this WKWebView shell. A successful layout demo or foreground update is not a successful locked-phone completion/approval test.

For that next test, add Push Notifications to the app target under a suitable developer team, request per-activity tokens with `pushType: .token`, register/rotate those tokens against owner-scoped runs on the host, and implement APNs liveactivity delivery with a persistent outbox. Ordinary notification tokens and Live Activity tokens are distinct. Do not put an APNs private key in the iPhone app or this source package.

## Connection and privacy

- Native polling runs in WebKit's isolated client content world, uses the existing HTTP-only login session, and is limited to the configured HTTPS origin. There is no page-visible native command/approval bridge. Off-origin navigations are blocked in this prototype; external auth, attachments and previews may need separate handling later.
- Native status projections contain only run/session IDs, bounded states, revisions and timestamps. Chat titles, drafts, responses and tool arguments are not rendered on the Lock Screen or Dynamic Island.
- Changing servers requires **Setup → Connect**. A widget link from a different configured server is ignored. Links only open chats; they cannot answer permissions.
- TLS certificate validation is unchanged. There are no HTTP exceptions or certificate bypasses. Native background modes are not requested.
- Removing an activity does not stop the chat. Use Kairos's existing Stop button to stop host work.

## Verification

Project generation, plist/scheme structure, resource/target references and JavaScript protocol checks were verified on Windows. **Swift compilation, signing, widget rendering and physical iPhone behavior have not been verified** here. Run the included `verify-on-mac.sh` in Terminal on your Mac before device installation, or build directly in Xcode. Share any build error for correction.

The checked-in project can be reproduced with `python3 generate_project.py`. The checks can be run with `python3 validate_project.py` and `node Tests/activity-probe-checks.cjs` (Node is optional for device installation).

Apple references:
- https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
- https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- https://developer.apple.com/help/account/basics/about-your-developer-account
