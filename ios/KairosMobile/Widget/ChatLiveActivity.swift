import ActivityKit
import SwiftUI
import WidgetKit

@main
struct KairosWidgetBundle: WidgetBundle {
    var body: some Widget {
        ChatLiveActivity()
        KairosQuickActionsWidget()
        KairosUsageWidget()
    }
}

struct ChatLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ChatActivityAttributes.self) { context in
            HStack(alignment: .top, spacing: 12) {
                KairosRing().frame(width: 44, height: 44)
                    .background(KairosTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(KairosTheme.gold.opacity(0.4), lineWidth: 1))
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(context.attributes.isDemo ? "KAIROS · DEMO" : "KAIROS")
                            .font(.system(size: 11, weight: .semibold, design: .rounded)).tracking(2)
                            .foregroundStyle(KairosTheme.muted)
                        Spacer(minLength: 8)
                        timer(context).foregroundStyle(KairosTheme.muted)
                    }
                    Label(label(context), systemImage: symbol(context))
                        .font(.system(.headline, design: .rounded))
                        .foregroundStyle(KairosTheme.status(context.state.state))
                    Text(hint(context)).font(.caption).foregroundStyle(KairosTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
            .activityBackgroundTint(KairosTheme.parchment)
            .activitySystemActionForegroundColor(KairosTheme.ink)
            .foregroundStyle(KairosTheme.ink)
            .widgetURL(context.attributes.link)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        KairosRing(ink: KairosTheme.parchment).frame(width: 30, height: 30)
                        Text(context.attributes.isDemo ? "KAIROS · DEMO" : "KAIROS")
                            .font(.system(size: 10, weight: .medium, design: .rounded)).tracking(1.4)
                            .foregroundStyle(KairosTheme.parchment)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    timer(context).foregroundStyle(KairosTheme.goldHighlight).padding(.top, 7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 9) {
                        Rectangle().fill(KairosTheme.gold.opacity(0.45)).frame(height: 1)
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Label(label(context), systemImage: symbol(context))
                                    .font(.headline).foregroundStyle(KairosTheme.status(context.state.state, onIsland: true))
                                Text(hint(context)).font(.caption).foregroundStyle(KairosTheme.parchment.opacity(0.8))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right").font(.caption.weight(.semibold))
                                .foregroundStyle(KairosTheme.goldHighlight)
                        }
                    }.padding(.horizontal, 4).padding(.bottom, 5)
                }
            } compactLeading: {
                KairosRing(ink: KairosTheme.parchment).frame(width: 24, height: 24)
            } compactTrailing: {
                Image(systemName: symbol(context))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(KairosTheme.status(context.state.state, onIsland: true))
                    .accessibilityLabel(label(context))
            } minimal: {
                Image(systemName: symbol(context))
                    .foregroundStyle(KairosTheme.status(context.state.state, onIsland: true))
                    .accessibilityLabel("Kairos: " + label(context))
            }
            .widgetURL(context.attributes.link)
            .keylineTint(KairosTheme.gold)
        }
    }

    private func label(_ context: ActivityViewContext<ChatActivityAttributes>) -> String {
        context.isStale && !context.state.terminal ? "Open to refresh" : context.state.label
    }

    private func symbol(_ context: ActivityViewContext<ChatActivityAttributes>) -> String {
        context.isStale && !context.state.terminal ? "arrow.clockwise" : context.state.symbol
    }

    private func hint(_ context: ActivityViewContext<ChatActivityAttributes>) -> String {
        if context.isStale && !context.state.terminal { return "Tap to reconnect with your workspace." }
        switch context.state.state {
        case "awaiting_permission": return "Your attention is needed. Tap to review."
        case "completed": return "Ready when you are. Tap to open the chat."
        case "failed", "interrupted": return "Tap to review what happened."
        case "stopped": return "Tap to return to the chat."
        default: return "Working in your workspace. Tap to open."
        }
    }

    @ViewBuilder
    private func timer(_ context: ActivityViewContext<ChatActivityAttributes>) -> some View {
        // Elapsed time is hidden when status is stale or work is awaiting approval.
        if !context.state.terminal && !context.isStale && context.state.state != "awaiting_permission" {
            Text(Date(timeIntervalSince1970: context.state.startedAt), style: .timer)
                .monospacedDigit().font(.caption).frame(maxWidth: 64, alignment: .trailing)
        }
    }
}
