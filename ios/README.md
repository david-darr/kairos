# Kairos Mobile — native development deferred

Decision recorded on 2026-10-12: pause native iPhone development and public distribution while David uses a free Xcode Personal Team. Preserve the implementation and upgrade history in this repository so work can resume later. The mobile web redesign, Home Screen notifications and server-managed chat remain part of the host release scope.

## Preserved implementation

`KairosMobile/` is the authoritative latest source, incorporating the full-screen shell, themed Dynamic Island and Lock Screen views, shortcut and model-usage widgets, camera/microphone permission descriptions, and native safe-area handling. It includes the Xcode project, shared scheme, signing helpers, checks and installation instructions.

The dated ZIP files alongside this README preserve the packages previously provided for testing:

- `kairos-ios-live-activity-prototype-20261012.zip`: original native prototype.
- `kairos-ios-mobile-redesign-20261012.zip`: themed Live Activity revision.
- `kairos-ios-fullscreen-widgets-20261012.zip`: full-screen shell and widgets.
- `kairos-ios-camera-microphone-update-20261012.zip`: camera/microphone plist patch.
- `kairos-ios-safe-area-swipes-20261012.zip`: native safe-area patch.

These ZIPs are historical snapshots or partial patches. Use `KairosMobile/` for future development rather than restoring an older ZIP over it. Keep the entire `ios/` directory and `specs/mobile-activity.md` in the commit/merge with the mobile host changes; native distribution remains deferred.

Application runtime data remains in the existing private data profile. Signing keys, credentials, provisioning profiles, private chat data and APNs secrets do not belong in this directory. Mac-local signing changes and Xcode user settings remain local.

## Current state

David reports the redesigned native UI and Dynamic Island work on his iPhone. The Windows checks validate project structure and JavaScript protocols; they do not compile Swift. Native status updates currently require the app to be foregrounded. Native APNs notifications and suspended-app Live Activity updates are unimplemented. Usage widgets show the last shared reading; App Group setup is required for sharing, with a Personal Team fallback documented in [KairosMobile/UPGRADE.md](KairosMobile/UPGRADE.md).

The native prototype still prefills the private preview host. Public onboarding must replace this default before distribution. No TestFlight/App Store release is being prepared during this pause. The web app does not gain Dynamic Island or native widgets from a host update.

## Resume checklist

1. Enroll in the Apple Developer Program when ready for TestFlight/App Store distribution; choose permanent app, extension and App Group identifiers.
2. Replace the private preview default with first-launch connection setup for each user's own host.
3. Implement native notification enrollment, per-activity push token registration and host-side APNs delivery for suspended-app updates.
4. Build on macOS and verify both targets, device layouts, sign-out/account changes, widgets, permission links and locked-phone delivery.
5. Prepare reviewer access, privacy/support information and TestFlight distribution before public release.

Apple documents Personal Team testing and distribution membership requirements in its [developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account).
