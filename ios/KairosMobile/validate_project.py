"""Structural checks, not a substitute for an Xcode build."""
import plistlib
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
text = (ROOT / "KairosMobile.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
definitions = re.findall(r"^\s*([A-F0-9]{24}) = \{", text, re.M)
assert len(definitions) == len(set(definitions)), "Duplicate object identifiers"
references = set(re.findall(r"\b[A-F0-9]{24}\b", text))
assert references <= set(definitions), f"Unresolved project objects: {references - set(definitions)}"
assert text.count("isa = PBXNativeTarget;") == 2
for file in re.findall(r'lastKnownFileType = [^;]+; path = "([^"]+)";', text):
    assert (ROOT / file).is_file(), file
for folder in ["App", "Widget"]:
    info = plistlib.loads((ROOT / folder / "Info.plist").read_bytes())
    assert info["NSSupportsLiveActivities"] is True
    assert "NSAppTransportSecurity" not in info
app = plistlib.loads((ROOT / "App/Info.plist").read_bytes())
assert app["CFBundleURLTypes"][0]["CFBundleURLSchemes"] == ["kairos-mobile"]
assert app["UIApplicationSceneManifest"]["UIApplicationSupportsMultipleScenes"] is False
widget = plistlib.loads((ROOT / "Widget/Info.plist").read_bytes())
assert widget["NSExtension"]["NSExtensionPointIdentifier"] == "com.apple.widgetkit-extension"
scheme = ET.parse(ROOT / "KairosMobile.xcodeproj/xcshareddata/xcschemes/KairosMobile.xcscheme")
for buildable in scheme.findall(".//BuildableReference"):
    assert buildable.attrib["BlueprintIdentifier"] in references
for folder in ['App', 'Widget']:
    entitlements = plistlib.loads((ROOT / folder / 'Widgets.entitlements').read_bytes())
    assert entitlements == {'com.apple.security.application-groups': ['$(KAIROS_APP_GROUP)']}
    assert 'aps-environment' not in entitlements
    assert plistlib.loads((ROOT / folder / 'Info.plist').read_bytes())['KairosAppGroup'] == '$(KAIROS_APP_GROUP)'
assert 'IPHONEOS_DEPLOYMENT_TARGET = "17.0";' in text
assert 'TARGETED_DEVICE_FAMILY = "1";' in text
print(f"Project structure passed ({len(definitions)} objects, 2 targets, plists, scheme, resource references).")
print("Swift compilation and physical iPhone verification require Xcode on macOS.")
