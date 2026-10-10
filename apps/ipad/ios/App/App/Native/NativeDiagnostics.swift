import Foundation
import UIKit
import OSLog

/// Only structural events enter this log. Never supply filenames, track metadata,
/// callback URLs, client identifiers, tokens, or raw errors.
@MainActor
final class NativeDiagnostics {
    private let logger = Logger(subsystem: "dev.nostalgify.ipad", category: "Playback")
    private let signposter = OSSignposter(subsystem: "dev.nostalgify.ipad", category: "Playback")
    private var commandIntervals: [UUID: OSSignpostIntervalState] = [:]
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
        signpostCommand(event: safeEvent, requestId: safeID, command: entry["command"] as? String)
    }

    /// Instruments intervals cover native queue wait and command execution.
    /// Only a generated UUID and a fixed command name enter signpost metadata.
    private func signpostCommand(event: String, requestId: String, command: String?) {
        guard let id = UUID(uuidString: requestId) else { return }
        if event == "command.started", let command {
            guard commandIntervals[id] == nil, commandIntervals.count < 64 else { return }
            commandIntervals[id] = signposter.beginInterval("Playback command", id: signposter.makeSignpostID(),
                "request=\(requestId, privacy: .public) command=\(command, privacy: .public)")
        } else if event == "command.completed" || event == "command.failed",
                  let interval = commandIntervals.removeValue(forKey: id) {
            signposter.endInterval("Playback command", interval)
        }
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
        let webTime = ISO8601DateFormatter()
        webTime.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        value["webEvents"] = webEvents.suffix(150).map { input -> [String: Any] in
            let event = input["event"] as? String ?? "redacted"
            var output: [String: Any] = ["event": Self.webEvents.contains(event) ? event : "redacted"]
            if let id = (input["requestId"] as? String).flatMap(UUID.init(uuidString:)) { output["requestId"] = id.uuidString }
            if let duration = input["durationMs"] as? Double, duration.isFinite { output["durationMs"] = max(0, duration) }
            if let time = input["time"] as? String,
               let date = webTime.date(from: time) ?? ISO8601DateFormatter().date(from: time) {
                output["time"] = webTime.string(from: date)
            }
            if let code = input["code"] as? String { output["code"] = Self.webCodes.contains(code) ? code : "redacted" }
            if event == "web_error" { output.merge(Self.sanitizedWebError(input)) { _, new in new } }
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
        "unhandled_promise", "startup_failed", "resize_observer_loop", "spotify_configuration", "spotify_redirect", "spotify_not_installed",
        "spotify_disconnected", "spotify_state_unavailable", "spotify_pause_unconfirmed", "spotify_command_timeout",
        "spotify_command_failed", "spotify_restricted", "spotify_uri", "spotify_token_storage", "unsupported_command",
        "unsupported_audio", "import_failed", "not_found", "library_write_failed", "empty_library", "no_track",
        "audio_session_failed", "queue_boundary", "dialog_busy", "invalid_preferences", "preferences_too_large", "invalid_argument"]

    /// Structural browser error locations are useful; raw messages, stacks and
    /// URLs can contain user data and must never cross into exported reports.
    static func sanitizedWebError(_ input: [String: Any]) -> [String: Any] {
        let codes: Set<String> = ["javascript_error", "unhandled_promise", "startup_failed", "resize_observer_loop"]
        let classes: Set<String> = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "DOMException", "ResizeObserver", "Unknown"]
        let code = input["code"] as? String ?? "unexpected"
        var result: [String: Any] = ["code": codes.contains(code) ? code : "unexpected"]
        if let value = input["errorClass"] as? String, classes.contains(value) { result["errorClass"] = value }
        if let value = input["source"] as? String, ["app.js", "unknown"].contains(value) { result["source"] = value }
        for key in ["line", "column"] {
            if let number = input[key] as? NSNumber {
                let value = number.doubleValue
                if value.isFinite, value >= 0, value <= Double(Int32.max), value.rounded(.towardZero) == value {
                    result[key] = Int(value)
                }
            }
        }
        return result
    }
}
