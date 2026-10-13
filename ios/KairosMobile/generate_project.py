"""Generate the checked-in Xcode project using only Python's standard library.
Run from any directory: python3 ios/KairosMobile/generate_project.py
No XcodeGen, Swift package downloads, certificates, or host profile required.
"""
import hashlib
import plistlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def quoted(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def generate():
    objects = []

    def add(name, body):
        objects.append(f"\t\t{ident(name)} = {{ {body} }};")
        return ident(name)

    def settings(values):
        return " ".join(f"{key} = {quoted(value)};" for key, value in values.items())

    app_sources = ["App/KairosMobileApp.swift", "App/ActivityModel.swift", "Shared/ChatActivityAttributes.swift", "Shared/WidgetSnapshot.swift"]
    widget_sources = ["Widget/ChatLiveActivity.swift", "Widget/KairosWidgets.swift", "Shared/ChatActivityAttributes.swift", "Shared/WidgetSnapshot.swift"]
    refs = []
    for path in sorted(set(app_sources + widget_sources + ["App/ActivityProbe.js", "App/WidgetProbe.js", "App/Info.plist", "Widget/Info.plist", "App/Widgets.entitlements", "Widget/Widgets.entitlements"])):
        filetype = "sourcecode.swift" if path.endswith("swift") else "text.plist.entitlements" if path.endswith("entitlements") else "text.plist.xml" if path.endswith("plist") else "sourcecode.javascript"
        refs.append(add(path, f"isa = PBXFileReference; lastKnownFileType = {filetype}; path = {quoted(path)}; sourceTree = \"<group>\";"))

    for name, extension, filetype in [("KairosMobile", "app", "wrapper.application"), ("KairosLiveActivity", "appex", "wrapper.app-extension")]:
        add(name + "Product", f"isa = PBXFileReference; explicitFileType = {filetype}; includeInIndex = 0; path = {name}.{extension}; sourceTree = BUILT_PRODUCTS_DIR;")

    for target, sources in [("App", app_sources), ("Widget", widget_sources)]:
        builds = []
        for path in sources:
            builds.append(add(target + path, f"isa = PBXBuildFile; fileRef = {ident(path)};"))
        add(target + "Sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({','.join(builds)},); runOnlyForDeploymentPostprocessing = 0;")
        add(target + "Frameworks", "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
        resource = ""
        if target == "App":
            resource = ','.join(add(path + "Resource", f"isa = PBXBuildFile; fileRef = {ident(path)};") for path in ["App/ActivityProbe.js", "App/WidgetProbe.js"]) + ","
        add(target + "Resources", f"isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({resource}); runOnlyForDeploymentPostprocessing = 0;")

    add("EmbedWidget", f"isa = PBXBuildFile; fileRef = {ident('KairosLiveActivityProduct')}; settings = {{ ATTRIBUTES = (RemoveHeadersOnCopy,); }};")
    add("EmbedPhase", f"isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = \"\"; dstSubfolderSpec = 13; files = ({ident('EmbedWidget')},); name = \"Embed App Extensions\"; runOnlyForDeploymentPostprocessing = 0;")
    add("WidgetProxy", f"isa = PBXContainerItemProxy; containerPortal = {ident('Project')}; proxyType = 1; remoteGlobalIDString = {ident('WidgetTarget')}; remoteInfo = KairosLiveActivity;")
    add("WidgetDependency", f"isa = PBXTargetDependency; target = {ident('WidgetTarget')}; targetProxy = {ident('WidgetProxy')};")
    add("Products", f"isa = PBXGroup; children = ({ident('KairosMobileProduct')},{ident('KairosLiveActivityProduct')},); name = Products; sourceTree = \"<group>\";")
    add("MainGroup", f"isa = PBXGroup; children = ({','.join(refs)},{ident('Products')},); sourceTree = \"<group>\";")

    common = {"IPHONEOS_DEPLOYMENT_TARGET": "17.0", "SDKROOT": "iphoneos", "SWIFT_VERSION": "5.0",
              "CLANG_ENABLE_MODULES": "YES", "CLANG_ENABLE_OBJC_ARC": "YES", "ENABLE_USER_SCRIPT_SANDBOXING": "YES"}
    target_common = {"CODE_SIGN_STYLE": "Automatic", "CURRENT_PROJECT_VERSION": "2", "MARKETING_VERSION": "0.2.0",
                     "KAIROS_APP_GROUP": "group.dev.kairos.mobileprototype",
                     "TARGETED_DEVICE_FAMILY": "1", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
                     "SUPPORTS_MACCATALYST": "NO", "SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD": "NO",
                     "GENERATE_INFOPLIST_FILE": "NO", "PRODUCT_NAME": "$(TARGET_NAME)",
                     "LD_RUNPATH_SEARCH_PATHS": "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"}
    for scope in ["Project", "App", "Widget"]:
        for mode in ["Debug", "Release"]:
            values = dict(common if scope == "Project" else target_common)
            if scope == "Project":
                values.update({"SWIFT_OPTIMIZATION_LEVEL": "-Onone" if mode == "Debug" else "-O",
                               "DEBUG_INFORMATION_FORMAT": "dwarf" if mode == "Debug" else "dwarf-with-dsym"})
                if mode == "Debug":
                    values["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG $(inherited)"
            else:
                values["INFOPLIST_FILE"] = f"{scope}/Info.plist"
                values["CODE_SIGN_ENTITLEMENTS"] = f"{scope}/Widgets.entitlements"
                values["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.kairos.mobileprototype" + (".liveactivity" if scope == "Widget" else "")
                if scope == "Widget":
                    values.update({"APPLICATION_EXTENSION_API_ONLY": "YES", "SKIP_INSTALL": "YES"})
            add(scope + mode, f"isa = XCBuildConfiguration; buildSettings = {{ {settings(values)} }}; name = {mode};")
        add(scope + "Configs", f"isa = XCConfigurationList; buildConfigurations = ({ident(scope+'Debug')},{ident(scope+'Release')},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")

    for scope, product, producttype in [("App", "KairosMobile", "application"), ("Widget", "KairosLiveActivity", "app-extension")]:
        phases = [ident(scope + s) for s in ["Sources", "Frameworks", "Resources"]]
        if scope == "App":
            phases.append(ident("EmbedPhase"))
        dep = ident("WidgetDependency") + "," if scope == "App" else ""
        add(scope + "Target", f"isa = PBXNativeTarget; buildConfigurationList = {ident(scope+'Configs')}; buildPhases = ({','.join(phases)},); buildRules = (); dependencies = ({dep}); name = {product}; productName = {product}; productReference = {ident(product+'Product')}; productType = \"com.apple.product-type.{producttype}\";")

    add("Project", f"isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; TargetAttributes = {{ {ident('AppTarget')} = {{ CreatedOnToolsVersion = 16.0; }}; {ident('WidgetTarget')} = {{ CreatedOnToolsVersion = 16.0; }}; }}; }}; buildConfigurationList = {ident('ProjectConfigs')}; compatibilityVersion = \"Xcode 14.0\"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base,); mainGroup = {ident('MainGroup')}; productRefGroup = {ident('Products')}; projectDirPath = \"\"; projectRoot = \"\"; targets = ({ident('AppTarget')},{ident('WidgetTarget')},);")
    project = ROOT / "KairosMobile.xcodeproj"
    project.mkdir(exist_ok=True)
    (project / "project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {ident('Project')};\n}}\n", encoding="utf-8")

    basic = {"CFBundleDevelopmentRegion": "en", "CFBundleExecutable": "$(EXECUTABLE_NAME)",
             "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)", "CFBundleInfoDictionaryVersion": "6.0",
             "CFBundleName": "$(PRODUCT_NAME)", "CFBundleShortVersionString": "$(MARKETING_VERSION)",
             "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)", "NSSupportsLiveActivities": True,
             "KairosAppGroup": "$(KAIROS_APP_GROUP)"}
    app = {**basic, "CFBundleDisplayName": "Kairos Mobile", "CFBundlePackageType": "APPL",
           "LSRequiresIPhoneOS": True, "UILaunchScreen": {},
           "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False,
                                          "UISceneConfigurations": {}},
           "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
           "CFBundleURLTypes": [{"CFBundleURLName": "dev.kairos.mobileprototype", "CFBundleURLSchemes": ["kairos-mobile"]}]}
    widget = {**basic, "CFBundleDisplayName": "Kairos Activity", "CFBundlePackageType": "XPC!",
              "NSExtension": {"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"}}
    for folder, value in [("App", app), ("Widget", widget)]:
        (ROOT / folder / "Info.plist").write_bytes(plistlib.dumps(value))
        (ROOT / folder / "Widgets.entitlements").write_bytes(plistlib.dumps({
            "com.apple.security.application-groups": ["$(KAIROS_APP_GROUP)"]
        }))

    scheme = project / "xcshareddata" / "xcschemes"
    scheme.mkdir(parents=True, exist_ok=True)
    reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident("AppTarget")}" BuildableName="KairosMobile.app" BlueprintName="KairosMobile" ReferencedContainer="container:KairosMobile.xcodeproj"/>'
    (scheme / "KairosMobile.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"/>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''', encoding="utf-8")
    print("Generated KairosMobile.xcodeproj (iPhone, iOS 17+, app + WidgetKit extension)")


if __name__ == "__main__":
    generate()
