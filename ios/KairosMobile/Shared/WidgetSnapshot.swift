import Foundation

struct WidgetWindow: Codable, Hashable {
    let name: String
    let usedPercent: Double
    let resetsAt: Double?
}

struct WidgetModelReading: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let scope: String
    let windows: [WidgetWindow]
    let totalTokens: Double?
    let stale: Bool
}

struct WidgetSnapshot: Codable {
    let updatedAt: Double
    let status: String
    let models: [WidgetModelReading]
    static var empty: Self { .init(updatedAt: 0, status: "Open Kairos to sync usage", models: []) }
    var outdated: Bool { updatedAt == 0 || Date().timeIntervalSince1970 - updatedAt > 900 }
}

enum WidgetSnapshotStore {
    // Both targets resolve this from the same Xcode build setting. No cookies or keys are shared.
    static var group: String { Bundle.main.object(forInfoDictionaryKey: "KairosAppGroup") as? String ?? "" }
    static var defaults: UserDefaults? {
        guard !group.isEmpty, FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil else { return nil }
        return UserDefaults(suiteName: group)
    }
    static func read() -> WidgetSnapshot {
        guard let data = defaults?.data(forKey: "usageSnapshot"),
              let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else { return .empty }
        return snapshot
    }
    static func write(_ snapshot: WidgetSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults?.set(data, forKey: "usageSnapshot")
    }
    static func clear() { defaults?.removeObject(forKey: "usageSnapshot") }
}
