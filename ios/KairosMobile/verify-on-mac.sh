#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
plutil -lint App/Info.plist Widget/Info.plist App/Widgets.entitlements Widget/Widgets.entitlements KairosMobile.xcodeproj/project.pbxproj
xcodebuild -list -project KairosMobile.xcodeproj
# Compile both targets without requiring a developer team or phone provisioning.
xcodebuild -project KairosMobile.xcodeproj -scheme KairosMobile \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build CODE_SIGNING_ALLOWED=NO build
echo 'Simulator compilation passed. Select your signing team in both targets to run on an iPhone.'
