import Foundation

#if DEBUG
/// Explicit simulator/debug opt-in. No Spotify credentials and no JS involvement.
@MainActor
enum NativeSelfCheck {
    static func fixture(at url: URL, seconds: Double = 0.6) throws {
        let sampleRate: UInt32 = 22_050
        let samples = Int(Double(sampleRate) * seconds)
        var data = Data()
        func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        ascii("RIFF"); number(UInt32(36 + samples * 2)); ascii("WAVEfmt ")
        number(UInt32(16)); number(UInt16(1)); number(UInt16(1)); number(sampleRate)
        number(sampleRate * 2); number(UInt16(2)); number(UInt16(16))
        ascii("data"); number(UInt32(samples * 2))
        for i in 0..<samples {
            let signal = sin(Double(i) * 2 * .pi * 440 / Double(sampleRate)) * 0.03
            number(Int16(signal * Double(Int16.max)))
        }
        try data.write(to: url, options: .atomic)
    }

    static func run() async {
        let diagnostics = NativePlayback.shared.diagnostics
        diagnostics.record("selfcheck.started")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("native-selfcheck-" + UUID().uuidString, isDirectory: true)
        var result: [String: Any] = ["passed": false, "checks": []]
        var service: LocalAudioService?
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let source = folder.appendingPathComponent("fixture.wav")
            try fixture(at: source)
            let local = LocalAudioService(diagnostics: diagnostics, directory: folder.appendingPathComponent("library"))
            service = local
            let first = try await local.importFiles([source])
            let second = try await local.importFiles([source])
            guard let a = first.items.first, let b = second.items.first, a.id != b.id else {
                throw NativeFailure(code: "selfcheck_identity", message: "Imported identities are not distinct.")
            }
            try local.setActive(true)
            try await local.command("volume", arg: 0)
            try await local.command("playShelf", arg: "local:" + a.id)
            // AVPlayer's end observer owns queue advancement, with no JavaScript timer.
            try await Task.sleep(nanoseconds: 3_000_000_000)
            let snapshot = local.snapshot()
            let track = snapshot["track"] as? [String: Any]
            guard track?["id"] as? String == b.id, snapshot["state"] as? String == "stopped" else {
                throw NativeFailure(code: "selfcheck_queue", message: "Native queue did not finish both fixtures.")
            }
            try local.setActive(false)
            let reloaded = LocalAudioService(diagnostics: diagnostics, directory: folder.appendingPathComponent("library"))
            guard reloaded.library.map(\.id) == [a.id, b.id] else {
                throw NativeFailure(code: "selfcheck_persistence", message: "Library identities did not persist.")
            }
            result = ["passed": true, "checks": ["import", "distinct-identities", "native-queue", "persistence"],
                      "libraryCount": 2, "provider": "local", "state": "stopped"]
            diagnostics.record("selfcheck.passed")
        } catch {
            let code = (error as? NativeFailure)?.code ?? "selfcheck_failed"
            result["code"] = code
            diagnostics.record("selfcheck.failed", code: code)
        }
        try? service?.setActive(false)
        service = nil
        try? FileManager.default.removeItem(at: folder)
        result["diagnostics"] = diagnostics.snapshot()
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("native-selfcheck.json")
        try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: output, options: .atomic)
    }
}
#endif
