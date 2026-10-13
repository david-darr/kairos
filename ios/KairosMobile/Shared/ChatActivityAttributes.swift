import ActivityKit
import Foundation
import SwiftUI

enum KairosTheme {
    static let parchment = Color(red: 243 / 255, green: 234 / 255, blue: 219 / 255)
    static let surface = Color(red: 251 / 255, green: 246 / 255, blue: 238 / 255)
    static let ink = Color(red: 58 / 255, green: 42 / 255, blue: 32 / 255)
    static let muted = Color(red: 107 / 255, green: 86 / 255, blue: 70 / 255)
    static let gold = Color(red: 184 / 255, green: 137 / 255, blue: 59 / 255)
    static let goldText = Color(red: 131 / 255, green: 96 / 255, blue: 31 / 255)
    static let goldHighlight = Color(red: 217 / 255, green: 178 / 255, blue: 96 / 255)

    static func status(_ state: String, onIsland: Bool = false) -> Color {
        switch state {
        case "awaiting_permission": return onIsland ? goldHighlight : goldText
        case "completed": return onIsland ? Color(red: 0.65, green: 0.78, blue: 0.60) : Color(red: 0.31, green: 0.43, blue: 0.29)
        case "failed", "interrupted": return onIsland ? Color(red: 0.90, green: 0.63, blue: 0.58) : Color(red: 0.66, green: 0.26, blue: 0.18)
        default: return onIsland ? goldHighlight : muted
        }
    }
}

// Geometry matches static/js/brand.js: an open ring with one gilded point.
struct KairosRing: View {
    var ink: Color = KairosTheme.ink
    var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height)
            ZStack {
                Path { path in
                    path.addArc(center: CGPoint(x: side * 0.5, y: side * 0.5), radius: side * 0.30,
                                startAngle: .degrees(-20), endAngle: .degrees(290), clockwise: false)
                }.stroke(ink, style: StrokeStyle(lineWidth: side * 0.055, lineCap: .round))
                Circle().fill(KairosTheme.gold)
                    .frame(width: side * 0.11, height: side * 0.11)
                    .position(x: side * 0.7121, y: side * 0.2879)
            }.frame(width: side, height: side)
        }.accessibilityHidden(true)
    }
}

// Compiled into both targets. No chat titles, text, or tool arguments on the Lock Screen.
struct ChatActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var state: String
        var startedAt: Double

        var label: String {
            switch state {
            case "awaiting_permission": return "Needs approval"
            case "completed": return "Reply ready"
            case "failed": return "Work failed"
            case "interrupted": return "Interrupted"
            case "stopped": return "Stopped"
            default: return "Working"
            }
        }

        var symbol: String {
            switch state {
            case "awaiting_permission": return "hand.raised.fill"
            case "completed": return "checkmark.circle.fill"
            case "failed", "interrupted": return "exclamationmark.triangle.fill"
            case "stopped": return "stop.circle.fill"
            default: return "sparkles"
            }
        }

        var terminal: Bool { ["completed", "failed", "stopped", "interrupted"].contains(state) }
    }

    var runID: String
    var sessionID: String
    var serverOrigin: String
    var accountID: String
    var isDemo: Bool

    var link: URL? {
        var parts = URLComponents()
        parts.scheme = "kairos-mobile"
        parts.host = isDemo ? "demo" : "chat"
        parts.queryItems = [URLQueryItem(name: "session", value: sessionID),
                            URLQueryItem(name: "origin", value: serverOrigin)]
        return parts.url
    }
}
