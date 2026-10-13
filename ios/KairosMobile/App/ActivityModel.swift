import ActivityKit
import Combine
import Foundation
import WebKit
import WidgetKit
import UIKit

// Geometry from SwiftUI is authoritative for the full-screen web surface.
// Keep it across navigation; viewport-fit alone can report zero in WKWebView.
@MainActor
final class KairosViewportWebView: WKWebView {
    private var viewportInsets = UIEdgeInsets.zero
    private let viewportScriptPrefix = "// Kairos native viewport\n"

    override func layoutSubviews() {
        super.layoutSubviews()
        // UIWindow insets exclude the software keyboard; SwiftUI resizes the
        // web surface for it, so adding its height here would count it twice.
        if let window { setViewportInsets(window.safeAreaInsets) }
    }

    func setViewportInsets(_ insets: UIEdgeInsets) {
        guard viewportInsets != insets else { return }
        viewportInsets = insets
        // Preserve other user scripts and restore measurements in each new
        // document, alongside the navigation delegate's didFinish sync.
        let controller = configuration.userContentController
        let others = controller.userScripts.filter { !$0.source.hasPrefix(viewportScriptPrefix) }
        controller.removeAllUserScripts()
        others.forEach { controller.addUserScript($0) }
        controller.addUserScript(WKUserScript(source: viewportScriptPrefix + viewportScript,
                                              injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        syncViewportInsets()
    }

    private var viewportScript: String {
        let values: [(String, CGFloat)] = [("top", viewportInsets.top), ("right", viewportInsets.right),
                                           ("bottom", viewportInsets.bottom), ("left", viewportInsets.left)]
        let statements = values.map { side, value in
            "s.setProperty('--native-safe-\(side)', '\(max(0, value))px');"
        }.joined()
        return "(() => { const s = document.documentElement?.style; if (s) { \(statements) } })()"
    }

    func syncViewportInsets() {
        evaluateJavaScript(viewportScript, completionHandler: nil)
    }
}

struct RunSummary: Decodable, Identifiable {
    let id: String
    let sessionID: String
    let state: String
    let startedAt: Double
    let revision: Int

    var content: ChatActivityAttributes.ContentState {
        .init(state: state, startedAt: startedAt)
    }
}

private struct ProbeResult: Decodable {
    let signedIn: Bool
    let account: String?
    let runs: [RunSummary]
    let selected: RunSummary?
    let missing: Bool?
}

@MainActor
final class ActivityModel: NSObject, ObservableObject, WKNavigationDelegate {
    static let preview = "https://desktop-f50h13p.tail3ee769.ts.net:8433"
    @Published var serverText: String
    @Published private(set) var serverURL: URL
    @Published private(set) var runs: [RunSummary] = []
    @Published private(set) var status = "Sign in to Kairos."
    @Published private(set) var error: String?
    @Published private(set) var followEnabled = false
    @Published private(set) var followed: Activity<ChatActivityAttributes>?
    @Published var selectedTab = 0
    @Published var shareWidgetUsage = UserDefaults.standard.bool(forKey: "shareWidgetUsage")
    @Published private(set) var widgetStatus = "Enable sharing to show model usage on your Home Screen."
    @Published private(set) var signedIn = false
    let webView: KairosViewportWebView
    private var account: String?
    private var pollTask: Task<Void, Never>?
    private var foreground = false
    private var generation = 0
    private var seen = Set<String>()
    private var lastUpdate = Date.distantPast
    private var lastRevision = -1
    private let probe: String
    private let widgetProbe: String
    private var lastWidgetSync = Date.distantPast
    private var widgetSyncing = false

    override init() {
        let saved = UserDefaults.standard.string(forKey: "serverOrigin") ?? Self.preview
        let url = Self.validOrigin(saved) ?? URL(string: Self.preview)!
        serverURL = url
        serverText = url.absoluteString
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "KairosMobile/0.2"
        webView = KairosViewportWebView(frame: .zero, configuration: config)
        if let resource = Bundle.main.url(forResource: "ActivityProbe", withExtension: "js"),
           let body = try? String(contentsOf: resource, encoding: .utf8) {
            probe = body
        } else { probe = "throw new Error('Activity probe is missing.');" }
        if let resource = Bundle.main.url(forResource: "WidgetProbe", withExtension: "js"),
           let body = try? String(contentsOf: resource, encoding: .utf8) { widgetProbe = body }
        else { widgetProbe = "throw new Error('Widget probe is missing.');" }
        super.init()
        WidgetSnapshotStore.clear()
        WidgetCenter.shared.reloadTimelines(ofKind: "KairosUsage")
        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Web content owns drawer swipes; native Back otherwise competes with it.
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 243/255, green: 234/255, blue: 219/255, alpha: 1)
        // Live Activities can outlive the app process. Reconcile one activity on next foreground.
        followed = Activity<ChatActivityAttributes>.activities.first {
            $0.attributes.serverOrigin == url.absoluteString && !$0.attributes.isDemo &&
            ($0.activityState == .active || $0.activityState == .stale)
        }
        followEnabled = followed != nil
        webView.load(URLRequest(url: url))
    }

    static func validOrigin(_ text: String) -> URL? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", parts.port == nil || (1...65535).contains(parts.port!) else { return nil }
        parts.scheme = "https"
        parts.host = host.lowercased()
        parts.path = ""
        if parts.port == 443 { parts.port = nil }
        return parts.url
    }

    private func sameOrigin(_ url: URL) -> Bool {
        url.scheme == "https" && url.host?.lowercased() == serverURL.host?.lowercased() &&
        (url.port ?? 443) == (serverURL.port ?? 443)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "kairos-mobile", url.host == "controls",
           action.sourceFrame.isMainFrame, let source = action.sourceFrame.request.url, sameOrigin(source) {
            selectedTab = 1
            decisionHandler(.cancel)
            return
        }
        guard let url = action.request.url, sameOrigin(url) else {
            if action.targetFrame?.isMainFrame != false { error = "This link is outside your configured Kairos server." }
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame == nil {
            webView.load(action.request)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.webView.syncViewportInsets()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.error = "Could not connect. Check Tailscale and the Kairos preview server."
    }

    func setForeground(_ active: Bool) {
        foreground = active
        generation += 1
        pollTask?.cancel()
        pollTask = nil
        if active { startPolling() }
    }

    private func startPolling() {
        let epoch = generation
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.foreground, self.generation == epoch else { return }
                await self.poll(epoch: epoch)
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    private func poll(epoch: Int) async {
        guard let page = webView.url, sameOrigin(page), !webView.isLoading else { return }
        let selectedID = followed?.attributes.isDemo == false ? followed?.attributes.runID : nil
        do {
            let value = try await webView.callAsyncJavaScript(probe,
                arguments: ["expectedOrigin": serverURL.absoluteString, "selectedID": selectedID ?? ""],
                in: nil, contentWorld: .defaultClient)
            guard foreground, generation == epoch, !Task.isCancelled else { return }
            guard let text = value as? String else { throw ProbeError.invalid }
            let result = try JSONDecoder().decode(ProbeResult.self, from: Data(text.utf8))
            error = nil
            if !result.signedIn {
                signedIn = false
                runs = []
                account = nil
                clearWidgetUsage()
                status = "Sign in to Kairos."
                await endFollowed()
                return
            }
            if let account, account != result.account {
                clearWidgetUsage()
                await endFollowed()
                seen.removeAll()
            }
            account = result.account
            signedIn = true
            if shareWidgetUsage, Date().timeIntervalSince(lastWidgetSync) >= 300 {
                Task { await self.refreshWidgetUsage() }
            }
            runs = result.runs.sorted { $0.startedAt > $1.startedAt }
            status = "Connected · foreground updates only"
            if let activity = followed, !activity.attributes.isDemo,
               activity.attributes.accountID != result.account {
                await endFollowed()
            }
            if let activity = followed, !activity.attributes.isDemo {
                if activity.activityState == .dismissed || activity.activityState == .ended {
                    seen.insert(activity.attributes.runID)
                    followed = nil
                } else if result.missing == true {
                    await endFollowed()
                } else if let summary = result.selected, summary.id == activity.attributes.runID,
                          summary.sessionID == activity.attributes.sessionID, summary.revision >= lastRevision {
                    await update(summary)
                }
            }
            guard foreground, generation == epoch, !Task.isCancelled else { return }
            if followEnabled, followed == nil, let next = runs.first(where: { !seen.contains($0.id) }) {
                await follow(next)
            }
        } catch {
            guard foreground, generation == epoch, !Task.isCancelled else { return }
            self.error = "Activity connection unavailable. Check Tailscale, sign-in, and the preview build."
            status = "Waiting to reconnect"
            // The existing activity becomes stale instead of falsely reporting completion.
        }
    }

    func setFollowEnabled(_ enabled: Bool) async {
        followEnabled = enabled
        if !enabled { await endFollowed() }
        else { seen.removeAll() }
    }

    func follow(_ run: RunSummary) async {
        guard !run.content.terminal else { return }
        guard let account, foreground else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            error = "Enable Live Activities for Kairos Mobile in iPhone Settings."
            followEnabled = false
            return
        }
        await endFollowed()
        guard foreground, self.account == account else { return }
        do {
            followed = try Activity.request(attributes: ChatActivityAttributes(runID: run.id,
                sessionID: run.sessionID, serverOrigin: serverURL.absoluteString, accountID: account, isDemo: false),
                content: ActivityContent(state: run.content, staleDate: Date().addingTimeInterval(45)),
                pushType: nil)
            seen.insert(run.id)
            lastRevision = run.revision
            lastUpdate = .now
        } catch {
            followEnabled = false
            self.error = "Could not start a Live Activity: \(error.localizedDescription)"
        }
    }

    private func update(_ run: RunSummary) async {
        guard let activity = followed else { return }
        let content = ActivityContent(state: run.content, staleDate: run.content.terminal ? nil : Date().addingTimeInterval(45))
        if run.content.terminal {
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60)))
            followed = nil
        } else if activity.content.state.state != run.state || Date().timeIntervalSince(lastUpdate) >= 15 {
            await activity.update(content)
            lastUpdate = .now
        }
        lastRevision = run.revision
        objectWillChange.send()
    }

    func endFollowed() async {
        if let activity = followed {
            // Hiding the display never stops the host's chat.
            seen.insert(activity.attributes.runID)
            followed = nil
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        lastRevision = -1
    }

    func connect() async {
        guard let url = Self.validOrigin(serverText) else {
            error = "Enter an HTTPS server address without a path, login, or query."
            return
        }
        setForeground(false)
        await endFollowed()
        // Also remove lingering terminal/demo displays from the previous server.
        for activity in Activity<ChatActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        serverURL = url
        serverText = url.absoluteString
        UserDefaults.standard.set(url.absoluteString, forKey: "serverOrigin")
        runs = []
        account = nil
        signedIn = false
        clearWidgetUsage()
        seen.removeAll()
        followEnabled = false
        error = nil
        webView.load(URLRequest(url: url))
        selectedTab = 0
        setForeground(true)
    }

    func startDemo() async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            error = "Enable Live Activities in iPhone Settings."
            return
        }
        followEnabled = false
        await endFollowed()
        do {
            followed = try Activity.request(attributes: ChatActivityAttributes(runID: UUID().uuidString,
                sessionID: "demo", serverOrigin: serverURL.absoluteString, accountID: "demo", isDemo: true),
                content: ActivityContent(state: .init(state: "running", startedAt: Date().timeIntervalSince1970),
                                         staleDate: Date().addingTimeInterval(45)), pushType: nil)
        } catch { self.error = "Demo failed: \(error.localizedDescription)" }
    }

    func demoState(_ state: String) async {
        guard let activity = followed, activity.attributes.isDemo else { return }
        let content = ActivityContent(state: ChatActivityAttributes.ContentState(state: state,
            startedAt: activity.content.state.startedAt), staleDate: Date().addingTimeInterval(45))
        if content.state.terminal {
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60)))
            followed = nil
        } else { await activity.update(content) }
        objectWillChange.send()
    }

    func openLink(_ url: URL) {
        guard url.scheme == "kairos-mobile" else { return }
        if url.host == "launch", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let action = parts.queryItems?.first(where: { $0.name == "action" })?.value {
            launch(action)
            return
        }
        if url.host == "demo" { selectedTab = 1; return }
        guard url.host == "chat", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let session = parts.queryItems?.first(where: { $0.name == "session" })?.value,
              session.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              parts.queryItems?.first(where: { $0.name == "origin" })?.value == serverURL.absoluteString else { return }
        openChat(session)
    }

    func openChat(_ sessionID: String) {
        var parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "chat", value: sessionID)]
        if let url = parts.url { webView.load(URLRequest(url: url)); selectedTab = 0 }
    }

    func launch(_ action: String) {
        if action == "controls" { selectedTab = 1; return }
        guard ["newchat", "home", "library", "notes", "calendar", "tasks"].contains(action) else { return }
        selectedTab = 0
        // Preserve the launch across sign-in. The web app consumes it after authentication.
        var parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: action == "newchat" ? "newchat" : "view", value: action == "newchat" ? "1" : action)]
        if let url = parts.url { webView.load(URLRequest(url: url)) }
    }

    func setWidgetSharing(_ enabled: Bool) async {
        shareWidgetUsage = enabled
        UserDefaults.standard.set(enabled, forKey: "shareWidgetUsage")
        if enabled { await refreshWidgetUsage() }
        else { clearWidgetUsage(); widgetStatus = "Usage sharing is off." }
    }

    private func clearWidgetUsage() {
        let hadSnapshot = WidgetSnapshotStore.defaults?.data(forKey: "usageSnapshot") != nil
        WidgetSnapshotStore.clear()
        lastWidgetSync = .distantPast
        if hadSnapshot { WidgetCenter.shared.reloadTimelines(ofKind: "KairosUsage") }
    }

    func refreshWidgetUsage() async {
        guard shareWidgetUsage, foreground, !widgetSyncing, !webView.isLoading,
              let page = webView.url, sameOrigin(page) else { return }
        guard WidgetSnapshotStore.defaults != nil else {
            widgetStatus = "Configure the same App Group for both Xcode targets to share usage. Shortcuts work without it."
            return
        }
        guard let expectedAccount = account else { return }
        let epoch = generation
        widgetSyncing = true
        defer { widgetSyncing = false }
        lastWidgetSync = .now
        do {
            let value = try await webView.callAsyncJavaScript(widgetProbe,
                arguments: ["expectedOrigin": serverURL.absoluteString, "expectedAccount": expectedAccount], in: nil, contentWorld: .defaultClient)
            guard shareWidgetUsage, foreground, generation == epoch, account == expectedAccount else { return }
            guard let text = value as? String else { throw ProbeError.invalid }
            let snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(text.utf8))
            WidgetSnapshotStore.write(snapshot)
            widgetStatus = snapshot.status
            WidgetCenter.shared.reloadTimelines(ofKind: "KairosUsage")
        } catch {
            guard generation == epoch else { return }
            widgetStatus = "Couldn't sync. Widgets keep their last reading and its timestamp."
        }
    }

    private enum ProbeError: Error { case invalid }
}
