import Foundation
import CoreFoundation

struct NativeFailure: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

enum PlaybackValue {
    static func finite(_ value: Double, fallback: Double = 0) -> Double {
        value.isFinite ? value : fallback
    }

    static func position(_ value: Double, duration: Double) -> Double {
        min(max(0, finite(value)), max(0, finite(duration)))
    }

    static func volume(_ value: Double) -> Double { min(100, max(0, finite(value))) }

    static func number(_ argument: Any?) throws -> Double {
        guard let number = argument as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
            throw NativeFailure(code: "invalid_argument", message: "This control requires a finite number.")
        }
        return number.doubleValue
    }
}

struct LocalAudioRecord: Codable, Equatable {
    let id: String
    let filename: String
    let name: String
    let artist: String
    let album: String
    let duration: Double

    var isSafe: Bool {
        UUID(uuidString: id) != nil && filename.hasPrefix(id + ".") &&
            !filename.contains("/") && !filename.contains("\\") &&
            duration.isFinite && duration > 0
    }

    var snapshot: [String: Any] {
        ["id": id, "uri": "local:" + id, "name": name, "artist": artist,
         "album": album, "duration": duration, "artworkUrl": ""]
    }
}

struct LocalQueue {
    private(set) var ids: [String] = []
    private(set) var index: Int = 0
    var current: String? { ids.indices.contains(index) ? ids[index] : nil }

    mutating func reset(_ identifiers: [String], startingAt identifier: String?, shuffled: Bool) {
        var unique: [String] = []
        for id in identifiers where !unique.contains(id) { unique.append(id) }
        if shuffled {
            // The selected track starts the shuffled queue. Starting at its
            // random position would omit preceding tracks when repeat is off.
            let selected = identifier.flatMap { unique.contains($0) ? $0 : nil }
            if let selected { unique.removeAll { $0 == selected } }
            unique.shuffle()
            if let selected { unique.insert(selected, at: 0) }
            index = 0
        } else {
            index = identifier.flatMap { unique.firstIndex(of: $0) } ?? 0
        }
        ids = unique
    }

    @discardableResult
    mutating func advance(by step: Int, wrapping: Bool) -> Bool {
        guard !ids.isEmpty else { return false }
        let candidate = index + step
        if ids.indices.contains(candidate) { index = candidate; return true }
        guard wrapping else { return false }
        index = ((candidate % ids.count) + ids.count) % ids.count
        return true
    }
}
