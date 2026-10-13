"""Configure this source package before opening Xcode; no credentials required.
python3 configure_signing.py --bundle-id com.yourname.kairos --app-group group.com.yourname.kairos
Personal Team fallback: python3 configure_signing.py --bundle-id com.yourname.kairos --without-app-groups
Xcode still handles team selection, registration, signing and device installation.
"""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bundle-id', required=True)
group = parser.add_mutually_exclusive_group(required=True)
group.add_argument('--app-group')
group.add_argument('--without-app-groups', action='store_true')
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', args.bundle_id):
    parser.error('Use a reverse-domain bundle identifier, such as com.david.kairos')
if args.app_group and not re.fullmatch(r'group\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', args.app_group):
    parser.error('Use a group identifier, such as group.com.david.kairos')
project = Path(__file__).resolve().parent / 'KairosMobile.xcodeproj/project.pbxproj'
text = project.read_text(encoding='utf-8')
text = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = "([^"]+)";',
              lambda match: f'PRODUCT_BUNDLE_IDENTIFIER = "{args.bundle_id}{".liveactivity" if match[1].endswith(".liveactivity") else ""}";', text)
text = re.sub(r'KAIROS_APP_GROUP = "[^"]*";', f'KAIROS_APP_GROUP = "{args.app_group or ""}";', text)
def configure_line(match):
    line = match[0]
    if 'CODE_SIGN_ENTITLEMENTS' not in line:
        return line
    scope = 'Widget' if 'INFOPLIST_FILE = "Widget/Info.plist"' in line else 'App'
    entitlement = '' if args.without_app_groups else f'{scope}/Widgets.entitlements'
    return re.sub(r'CODE_SIGN_ENTITLEMENTS = "[^"]*";', f'CODE_SIGN_ENTITLEMENTS = "{entitlement}";', line)

text = re.sub(r'^.*isa = XCBuildConfiguration;.*$', configure_line, text, flags=re.M)
project.write_text(text, encoding='utf-8')
print('Configured identifiers. Select your signing team for both targets in Xcode.')
if args.without_app_groups:
    print('App Groups disabled. Full-screen Kairos, Live Activities and shortcut widgets work; usage sharing is unavailable.')
else:
    print('Enable and register the same App Group for both targets in Signing & Capabilities:', args.app_group)
