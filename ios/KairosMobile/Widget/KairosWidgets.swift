import SwiftUI
import WidgetKit

private let newChatURL = URL(string: "kairos-mobile://launch?action=newchat")!
private func launchURL(_ action: String) -> URL { URL(string: "kairos-mobile://launch?action=\(action)")! }

struct KairosWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct KairosUsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> KairosWidgetEntry { .init(date: .now, snapshot: .empty) }
    func getSnapshot(in context: Context, completion: @escaping (KairosWidgetEntry) -> Void) {
        completion(.init(date: .now, snapshot: WidgetSnapshotStore.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<KairosWidgetEntry>) -> Void) {
        completion(Timeline(entries: [.init(date: .now, snapshot: WidgetSnapshotStore.read())],
                            policy: .after(Date().addingTimeInterval(900))))
    }
}

private struct WidgetHeading: View {
    let subtitle: String
    var body: some View {
        HStack(spacing: 6) {
            KairosRing().frame(width: 24, height: 24)
            Text("KAIROS").font(.system(size: 11, weight: .semibold)).tracking(2)
            Spacer(minLength: 0)
            Text(subtitle).font(.caption2).foregroundStyle(KairosTheme.muted)
        }.foregroundStyle(KairosTheme.ink)
    }
}

private struct UsageRow: View {
    let model: WidgetModelReading
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(model.name).font(.system(size: compact ? 13 : 14, weight: .semibold)).lineLimit(1)
            if model.windows.isEmpty {
                Text(model.totalTokens.map { "\(Int(min($0, Double(Int.max / 2))).formatted()) tokens" } ?? "Limits unavailable")
                    .font(.caption).foregroundStyle(KairosTheme.muted)
            } else {
                ForEach(Array(model.windows.prefix(2)), id: \.name) { window in
                    HStack(spacing: 6) {
                        Text(window.name).font(.caption2)
                        ProgressView(value: window.usedPercent, total: 100).tint(KairosTheme.goldText)
                        Text("\(Int(window.usedPercent))% used").font(.caption2).monospacedDigit()
                    }
                    if !compact, let reset = window.resetsAt {
                        HStack(spacing: 3) {
                            Text("Resets")
                            Text(Date(timeIntervalSince1970: reset), style: .relative)
                        }.font(.caption2).foregroundStyle(KairosTheme.muted)
                    }
                }
            }
            if !compact { Text(model.scope + (model.stale ? " · last reading" : "")).font(.system(size: 10)).foregroundStyle(KairosTheme.muted).lineLimit(1) }
        }.foregroundStyle(KairosTheme.ink)
    }
}

struct KairosUsageWidget: Widget {
    let kind = "KairosUsage"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KairosUsageProvider()) { entry in
            KairosUsageView(entry: entry)
                .containerBackground(KairosTheme.parchment, for: .widget)
                .widgetURL(launchURL("home"))
                .privacySensitive()
        }.configurationDisplayName("Model usage")
            .description("Reported account allowances, reset times and recorded model tokens.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct KairosUsageView: View {
    let entry: KairosWidgetEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 8 : 10) {
            WidgetHeading(subtitle: "Usage")
            if entry.snapshot.models.isEmpty {
                Text("Your models").font(.system(.title3, design: .serif))
                Text(entry.snapshot.status).font(.caption).foregroundStyle(KairosTheme.muted)
            } else if family == .systemMedium {
                HStack(alignment: .top, spacing: 18) {
                    ForEach(Array(entry.snapshot.models.prefix(2))) { model in UsageRow(model: model, compact: true).frame(maxWidth: .infinity, alignment: .leading) }
                }
            } else {
                ForEach(Array(entry.snapshot.models.prefix(family == .systemSmall ? 1 : 3))) { model in
                    UsageRow(model: model, compact: family == .systemSmall)
                }
            }
            Spacer(minLength: 0)
            if family == .systemSmall, let model = entry.snapshot.models.first {
                Text(model.windows.isEmpty ? "Recorded · no quota" : "Account allowance")
                    .font(.system(size: 9)).foregroundStyle(KairosTheme.muted)
            }
            if entry.snapshot.updatedAt > 0 {
                HStack(spacing: 3) {
                    Text(entry.snapshot.outdated || entry.snapshot.models.contains(where: { $0.stale }) ? "Last reading" : "Synced")
                    Text(Date(timeIntervalSince1970: entry.snapshot.updatedAt), style: .time)
                }.font(.system(size: 10)).foregroundStyle(KairosTheme.muted)
            }
        }
    }
}

struct KairosQuickActionsWidget: Widget {
    let kind = "KairosQuickActions"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KairosUsageProvider()) { _ in
            KairosQuickActionsView().containerBackground(KairosTheme.parchment, for: .widget).widgetURL(newChatURL)
        }.configurationDisplayName("Kairos shortcuts")
            .description("Start a new chat or open your workspace.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
    }
}

private struct KairosQuickActionsView: View {
    @Environment(\.widgetFamily) private var family
    private func action(_ title: String, _ icon: String, _ route: String) -> some View {
        Link(destination: launchURL(route)) {
            HStack(spacing: 8) {
                Image(systemName: icon).frame(width: 20)
                Text(title).font(.system(size: 13, weight: .medium))
                Spacer(minLength: 0)
            }.foregroundStyle(KairosTheme.ink).padding(10)
                .background(KairosTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        }
    }
    var body: some View {
        if family == .accessoryCircular {
            Image(systemName: "plus.bubble").font(.title2)
        } else if family == .accessoryRectangular {
            Label("New Kairos chat", systemImage: "plus.bubble").font(.headline)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                WidgetHeading(subtitle: "")
                if family == .systemSmall {
                    Image(systemName: "plus.bubble").font(.title).foregroundStyle(KairosTheme.goldText)
                    Text("New chat").font(.system(.title3, design: .serif)).foregroundStyle(KairosTheme.ink)
                    Spacer(minLength: 0)
                    Text("A little space to think.").font(.caption2).foregroundStyle(KairosTheme.muted)
                } else {
                    HStack(spacing: 10) { action("New chat", "plus.bubble", "newchat"); action("Home", "house", "home") }
                    HStack(spacing: 10) { action("Library", "books.vertical", "library"); action("Notes", "note.text", "notes") }
                    if family == .systemLarge {
                        HStack(spacing: 10) { action("Calendar", "calendar", "calendar"); action("Tasks", "checklist", "tasks") }
                        action("iPhone & widgets", "gearshape", "controls")
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}
