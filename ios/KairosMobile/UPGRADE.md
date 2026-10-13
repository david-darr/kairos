# Status-bar spacing and easier swipes

For an existing full-screen/widgets installation, replace **App/KairosMobileApp.swift** and **App/ActivityModel.swift**, then press **Cmd+R**. No project, signing, App Group, widget or Live Activity configuration changes are needed. The app now shares physical safe-area insets with the web UI after navigation and rotation, hides the outer web scroll indicators, and lets Kairos handle sidebar gestures without native Back competing. The web preview supplies the status-bar blur and layout/gesture refinements. Swift compilation and device verification remain pending on macOS.

# Full-screen Kairos + iOS widgets

This is an updated source project. It replaces the prototype's permanent Chat / Activity / Setup tabs with full-screen Kairos. Open the sidebar, then **iPhone & widgets** for connection settings, Live Activities, demos and widget sharing. The web preview's redesign loads from your existing server.

## Camera and microphone update

The mobile composer now offers **+ → Take a photo**, alongside Attach files and Open Mic. The web layout fixes load from the server. To enable camera/microphone prompts in an already-installed native build, replace `App/Info.plist` in your existing project with this revision and press **⌘R**. Keep your existing project, signing team and bundle identifiers. Only the app plist changes for this update; the widget plist and App Groups are unchanged. The permission descriptions explain camera capture and sending audio to your configured Kairos server for transcription. Actual capture, upload and microphone permissions still require an iPhone check.

## Upgrade in Xcode

Keep a copy of your currently working project. This upgrade adds files, resource membership and App Group entitlements, so the old three-file replacement instructions no longer apply.

1. Unzip this package and open its `KairosMobile.xcodeproj` on your Mac.
2. Click the blue project icon, select **KairosMobile** under TARGETS, and open **Signing & Capabilities**. Select your team and check Automatically manage signing. Use the same Bundle Identifier you used in your working project to upgrade its installed app.
3. Select **KairosLiveActivity**, choose the same team and set its identifier to your app identifier plus `.liveactivity`.
4. To sync usage: in **Build Settings**, select **All**, search `KAIROS_APP_GROUP`, and set it to a unique group such as `group.com.david.kairos`. Set exactly the same value for both targets, Debug and Release. Under **Signing & Capabilities**, add **App Groups** if needed and register/select that same group for both targets. App Groups availability depends on your Apple team/membership. See [Apple's guide](https://developer.apple.com/documentation/xcode/configuring-app-groups).
5. Choose your iPhone and the **KairosMobile** scheme, then press **⌘R**. Sign in if needed. The bottom tabs are gone immediately in this build; iOS's status bar, Dynamic Island and Home indicator remain.
6. In Kairos's sidebar choose **iPhone & widgets**, turn on **Share model usage with widgets**, then **Sync usage now**. Return to the Home Screen, hold empty space, choose **Edit → Add Widget** (or the + button on older iOS), search **Kairos**, and choose **Kairos shortcuts** or **Model usage** in small, medium or large. Shortcuts also have circular/rectangular Lock Screen sizes.

## If Xcode says your Personal Team doesn't support App Groups

You can still test full-screen Kairos, Live Activities and the shortcut widgets. In **both targets → Build Settings → All**, clear **Code Signing Entitlements** and `KAIROS_APP_GROUP` for Debug and Release; remove the App Groups capability if Xcode added it. Usage widgets will say to open/sync instead of displaying a fabricated reading.

Optional Terminal setup before opening Xcode, from the unzipped project folder:

```sh
# Set the identifiers and usage-sharing group, then select/register the group in Xcode:
python3 configure_signing.py --bundle-id com.david.kairos --app-group group.com.david.kairos

# Or build without App Groups (shortcut widgets remain available):
python3 configure_signing.py --bundle-id com.david.kairos --without-app-groups
```

Do not rerun `generate_project.py` after configuring signing; it restores the sample identifiers and capabilities. Use your existing unique identifier rather than the example above.

## What the widgets report

- Claude/Codex CLI connections: provider-reported allowance percentages and reset times when available. These are account allowances shared across models, not separate quotas for each model. Refresh errors keep old readings visibly labeled.
- API/local connections: Kairos's recorded token totals. Unreported quota limits and prices aren't guessed.
- Only a signed-in Kairos administrator can read host account usage, matching the existing backend permissions.
- Usage sharing is opt-in. Widget storage contains bounded model names and readings, never login cookies, API keys, chat titles or responses. Sign-out, account switching, changing servers and disabling sharing clear the snapshot when the app observes them.
- The app syncs at most every five minutes while open, plus manual Sync. Widgets display a timestamp and last-reading state after fifteen minutes; WidgetKit controls refresh scheduling. They aren't live background meters.
- New chat opens a fresh composer without submitting anything or creating a run. Medium/large shortcuts also open Home, Library, Notes, Calendar, Tasks and native controls.
- Dynamic Island appearance stays intact. APNs updates while the app is suspended are still a separate integration.

## Verification

Run `./verify-on-mac.sh` or build in Xcode to compile both targets. This source package was checked on Windows for project references, JavaScript usage/account isolation and the existing ActivityKit status protocol. Swift compilation, widget sizing and device behavior require your Mac/iPhone and have not been verified here.
