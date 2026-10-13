import SwiftUI
import WebKit

@main
struct KairosMobileApp: App {
    @StateObject private var model = ActivityModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onAppear { model.setForeground(scenePhase == .active) }
                .onChange(of: scenePhase) { _, phase in model.setForeground(phase == .active) }
                .onOpenURL { model.openLink($0) }
        }
    }
}

private struct KairosWebView: UIViewRepresentable {
    let webView: KairosViewportWebView
    let safeAreaInsets: EdgeInsets
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        webView.setViewportInsets(uiView.window?.safeAreaInsets ??
            UIEdgeInsets(top: safeAreaInsets.top, left: safeAreaInsets.leading,
                         bottom: safeAreaInsets.bottom, right: safeAreaInsets.trailing))
    }
}

private struct ContentView: View {
    @ObservedObject var model: ActivityModel

    var body: some View {
        ZStack(alignment: .topTrailing) {
            GeometryReader { geometry in
                KairosWebView(webView: model.webView, safeAreaInsets: geometry.safeAreaInsets)
                    .ignoresSafeArea(.container)
            }
                // A failed first connection still has a route to change the server.
                if !model.signedIn {
                    Button { model.selectedTab = 2 } label: {
                        Image(systemName: "gearshape").frame(width: 44, height: 44)
                    }.background(KairosTheme.surface, in: Circle()).padding(.trailing, 12)
                        .padding(.top, 8).accessibilityLabel("Kairos connection settings")
                }
        }
            .background(KairosTheme.parchment)
            .sheet(isPresented: Binding(get: { model.selectedTab != 0 }, set: { if !$0 { model.selectedTab = 0 } })) {
                NativeControlsView(model: model)
            }
            .tint(KairosTheme.goldText)
            .preferredColorScheme(.light)
    }
}

private struct NativeControlsView: View {
    @ObservedObject var model: ActivityModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                    Section("Kairos server") {
                        TextField("HTTPS address", text: $model.serverText)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Button("Connect") { Task { await model.connect() } }
                        Text("Use your private HTTPS preview address. Keep Tailscale connected and the Kairos host running.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("Home Screen widgets") {
                        Toggle("Share model usage with widgets", isOn: Binding(get: { model.shareWidgetUsage },
                            set: { enabled in Task { await model.setWidgetSharing(enabled) } }))
                        Button("Sync usage now") { Task { await model.refreshWidgetUsage() } }.disabled(!model.shareWidgetUsage)
                        Text(model.widgetStatus).font(.footnote).foregroundStyle(KairosTheme.muted)
                        Text("Hold your Home Screen, tap Edit, then Add Widget, and search for Kairos. Choose shortcuts or usage in small, medium or large. Usage syncs while Kairos is open; widgets show the last reading and its time. Subscription allowances are shared across models. Prices and unreported limits aren't estimated.")
                            .font(.footnote).foregroundStyle(KairosTheme.muted)
                    }
                    Section("Live Activity") {
                        Toggle("Follow active chats", isOn: Binding(get: { model.followEnabled },
                            set: { enabled in Task { await model.setFollowEnabled(enabled) } }))
                        Text("Follows one chat at a time, newest first. Updates while this app is open. Locking your phone shows the last status; it becomes stale after 45 seconds.")
                            .font(.footnote).foregroundStyle(.secondary)
                        if let activity = model.followed {
                            Label(activity.content.state.label, systemImage: activity.content.state.symbol)
                            if !activity.attributes.isDemo {
                                Button("Open followed chat") { model.openChat(activity.attributes.sessionID) }
                            }
                            Button("Hide activity") { Task { await model.endFollowed() } }
                        }
                    }
                    Section("Active chats") {
                        if model.runs.isEmpty { Text("Start a chat in Kairos.").foregroundStyle(.secondary) }
                        ForEach(model.runs) { run in
                            VStack(alignment: .leading, spacing: 8) {
                                Label(run.content.label, systemImage: run.content.symbol)
                                Text(Date(timeIntervalSince1970: run.startedAt), style: .time).font(.caption)
                                HStack {
                                    Button("Follow") { Task { await model.follow(run) } }.buttonStyle(.bordered)
                                    Button("Open chat") { model.openChat(run.sessionID) }.buttonStyle(.bordered)
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                    Section("Layout demo · simulated") {
                        Button("Show demo activity") { Task { await model.startDemo() } }
                        if model.followed?.attributes.isDemo == true {
                            Button("Needs approval") { Task { await model.demoState("awaiting_permission") } }
                            Button("Working") { Task { await model.demoState("running") } }
                            Button("Reply ready") { Task { await model.demoState("completed") } }
                            Button("Work failed") { Task { await model.demoState("failed") } }
                        }
                        Text("Choose a state, then go to the Home Screen or lock your phone to inspect it. Demo buttons do not start work or grant permissions.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section {
                        Text(model.status).font(.footnote)
                        if let error = model.error { Text(error).foregroundStyle(.orange) }
                    }
            }
            .scrollContentBackground(.hidden)
            .background(KairosTheme.parchment)
            .navigationTitle("iPhone & widgets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .toolbarBackground(KairosTheme.parchment, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .tint(KairosTheme.goldText)
        }
    }
}
