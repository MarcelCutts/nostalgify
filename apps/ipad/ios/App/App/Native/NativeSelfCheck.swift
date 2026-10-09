import Foundation
import WebKit

#if DEBUG
/// Explicit simulator/debug opt-in. Account-free native audio and WebView checks.
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

    /// Native completion is bounded even if page startup or a JS Promise stalls.
    @MainActor
    private final class WebViewProbe {
        var continuation: CheckedContinuation<Void, Error>?
        var timeout: Task<Void, Never>?

        func complete(_ result: Result<Any, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            timeout?.cancel()
            timeout = nil
            if case .success(let raw) = result, let value = raw as? [String: Any], value["passed"] as? Bool == true {
                continuation.resume()
            } else {
                continuation.resume(throwing: NativeFailure(code: "selfcheck_webview_bridge", message: "The bundled player or native bridge did not become ready."))
            }
        }
    }

    private static func checkWebView(_ provider: @MainActor () -> WKWebView?) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while provider() == nil, ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let webView = provider() else {
            throw NativeFailure(code: "selfcheck_webview_bridge", message: "The bundled WebView was unavailable.")
        }
        let remaining = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        let javascript = """
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const host = window.nostalgify;
          const player = document.querySelector('#app #webamp #main-window');
          if (host && player && window.Capacitor?.getPlatform() === 'ios' && !host.debug) {
            try {
              const state = await host.getState();
              return { passed: ['spotify', 'local'].includes(state.provider) &&
                ['playing', 'paused', 'stopped'].includes(state.state) &&
                Number.isSafeInteger(state.sequence) };
            } catch (_) { return { passed: false }; }
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { passed: false };
        """
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let probe = WebViewProbe()
            probe.continuation = continuation
            probe.timeout = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                probe.complete(.failure(NativeFailure(code: "selfcheck_webview_timeout", message: "The bundled player did not respond.")))
            }
            webView.callAsyncJavaScript(javascript, arguments: ["timeoutMs": remaining * 1000], in: nil, contentWorld: .page) { result in
                Task { @MainActor in probe.complete(result) }
            }
        }
    }

    static func run(webView: @MainActor () -> WKWebView?) async {
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
            try await checkWebView(webView)
            result = ["passed": true, "checks": ["import", "distinct-identities", "native-queue", "persistence", "webview-bridge"],
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
