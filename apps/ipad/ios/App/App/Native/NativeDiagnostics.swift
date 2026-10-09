import Foundation
import UIKit
import OSLog

/// Only structural events enter this log. Never supply filenames, track metadata,
/// callback URLs, client identifiers, tokens, or raw errors.
@MainActor
final class NativeDiagnostics {
    private let logger = Logger(subsystem: "dev.nostalgify.ipad", category: "Playback")
    private var events: [[String: Any]] = []
    private let limit = 300

    func record(_ event: String, requestId: String? = nil, command: String? = nil,
                durationMs: Double? = nil, code: String? = nil) {
        var entry: [String: Any] = ["time": ISO8601DateFormatter().string(from: Date()),
                                    "event": label(event)]
        // A caller cannot accidentally put a URL or user text in a request ID.
        if let value = requestId.flatMap(UUID.init(uuidString:)) { entry["requestId"] = value.uuidString }
        if let value = command, Self.commands.contains(value) { entry["command"] = value }
        if let value = durationMs, value.isFinite { entry["durationMs"] = max(0, value) }
        if let value = code { entry["code"] = label(value) }
        events.append(entry)
        if events.count > limit { events.removeFirst(events.count - limit) }
        let safeEvent = entry["event"] as? String ?? "event"
        let safeCode = entry["code"] as? String ?? "ok"
        let safeID = entry["requestId"] as? String ?? "none"
        let milliseconds = entry["durationMs"] as? Double ?? 0
        logger.info("event=\(safeEvent, privacy: .public) code=\(safeCode, privacy: .public) request=\(safeID, privacy: .public) duration_ms=\(milliseconds, privacy: .public)")
    }

    private func label(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
        guard value.count <= 64, value.unicodeScalars.allSatisfy(allowed.contains) else { return "redacted" }
        return value
    }

    func snapshot() -> [String: Any] {
        ["version": 1, "environment": [
            "osVersion": UIDevice.current.systemVersion,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        ], "events": events]
    }

    func exportURL(webEvents: [[String: Any]] = []) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Nostalgify-diagnostics.json")
        var value = snapshot()
        value["webEvents"] = webEvents.suffix(150).map { input -> [String: Any] in
            let event = input["event"] as? String ?? "redacted"
            var output: [String: Any] = ["event": Self.webEvents.contains(event) ? event : "redacted"]
            if let id = (input["requestId"] as? String).flatMap(UUID.init(uuidString:)) { output["requestId"] = id.uuidString }
            if let duration = input["durationMs"] as? Double, duration.isFinite { output["durationMs"] = max(0, duration) }
            if let time = input["time"] as? String, ISO8601DateFormatter().date(from: time) != nil { output["time"] = time }
            if let code = input["code"] as? String { output["code"] = Self.webCodes.contains(code) ? code : "redacted" }
            return output
        }
        try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
            .write(to: url, options: .atomic)
        return url
    }

    static let commands: Set<String> = ["play", "playOrFallback", "pause", "playpause", "stop", "seek", "volume",
        "next", "previous", "shuffle", "repeat", "playShelf", "provider", "eject", "logout"]
    private static let webEvents: Set<String> = ["getState", "getPreferences", "setPreferences", "command",
        "configureSpotify", "connectSpotify", "disconnectSpotify", "listAudio", "importAudio", "removeAudio",
        "getDiagnostics", "exportDiagnostics", "failure", "web_error", "listener_unavailable"]
    private static let webCodes: Set<String> = ["timeout", "native_unavailable", "native_error", "unsupported",
        "invalid_link", "skin_storage_unavailable", "skin_preference_failed", "javascript_error",
        "unhandled_promise", "startup_failed"]
}
