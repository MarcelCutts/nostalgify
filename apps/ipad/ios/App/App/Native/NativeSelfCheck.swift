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
        var continuation: CheckedContinuation<[String: Any], Error>?
        var timeout: Task<Void, Never>?
        var evaluation: Task<Void, Never>?
        var phase = "readiness"
        var retries = 0

        func complete(_ result: Result<Any, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            timeout?.cancel()
            timeout = nil
            evaluation?.cancel()
            evaluation = nil
            if case .success(let raw) = result, let value = raw as? [String: Any] {
                let codes: Set<String> = ["selfcheck_webview_bridge", "selfcheck_webview_error", "selfcheck_webview_banner", "selfcheck_webview_timeout"]
                let code = value["code"] as? String ?? ""
                var safe: [String: Any] = ["passed": value["passed"] as? Bool == true,
                    "errorBannerVisible": value["errorBannerVisible"] as? Bool == true,
                    "webErrors": (value["webErrors"] as? [[String: Any]] ?? []).suffix(20).map(NativeDiagnostics.sanitizedWebError),
                    "phase": phase, "evaluationRetries": retries]
                if codes.contains(code) { safe["code"] = code }
                continuation.resume(returning: safe)
            } else {
                continuation.resume(throwing: NativeFailure(code: "selfcheck_webview_bridge", message: "The bundled player or native bridge did not become ready."))
            }
        }
    }

    static func checkWebView(_ provider: @MainActor () -> WKWebView?) async throws -> [String: Any] {
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while provider() == nil, ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let webView = provider() else {
            throw NativeFailure(code: "selfcheck_webview_bridge", message: "The bundled WebView was unavailable.")
        }
        let remaining = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        // Returning an unresolved Promise to callAsyncJavaScript can lose its
        // completion handler when WebKit collects the result. Retain the Promise
        // on the page and return only immediate polling snapshots to native code.
        let javascript = """
        (() => {
          const host = window.nostalgify;
          const player = document.querySelector('#app #webamp #main-window');
          if (!(host && player && document.documentElement.dataset.playerReady === 'true' &&
              window.Capacitor?.getPlatform() === 'ios' && !host.debug)) {
            return { phase: 'readiness' };
          }
          let probe = window.__nostalgifyNativeProbe;
          if (!probe) {
            probe = { phase: 'bridge', result: null, promise: null };
            window.__nostalgifyNativeProbe = probe;
            probe.promise = (async () => {
              try {
                const state = await host.getState();
                const validState = ['spotify', 'local'].includes(state.provider) &&
                  ['playing', 'paused', 'stopped'].includes(state.state) &&
                  Number.isSafeInteger(state.sequence);
                // Preserve real startup errors, including delayed layout errors.
                await new Promise(resolve => setTimeout(resolve, 250));
                probe.phase = 'diagnostics';
                const report = await host.getDiagnostics();
                const webErrors = (report.web || []).filter(event => event.event === 'web_error');
                const banner = document.getElementById('error-message');
                const errorBannerVisible = Boolean(banner && !banner.hidden);
                probe.result = { passed: validState && webErrors.length === 0 && !errorBannerVisible,
                  webErrors, errorBannerVisible,
                  code: !validState ? 'selfcheck_webview_bridge' : webErrors.length ? 'selfcheck_webview_error' :
                    errorBannerVisible ? 'selfcheck_webview_banner' : '' };
              } catch (_) { probe.result = { passed: false, code: 'selfcheck_webview_bridge' }; }
              probe.phase = 'done';
            })();
          }
          if (probe.result) {
            const report = probe.result;
            delete window.__nostalgifyNativeProbe;
            return { phase: 'done', report };
          }
          return { phase: probe.phase };
        })();
        """
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
            let probe = WebViewProbe()
            probe.continuation = continuation
            probe.timeout = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                probe.complete(.success(["passed": false, "code": "selfcheck_webview_timeout"]))
            }
            probe.evaluation = Task { @MainActor in
                while !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline {
                    do {
                        let value = try await webView.evaluateJavaScript(javascript)
                        if let poll = value as? [String: Any] {
                            if let phase = poll["phase"] as? String, ["readiness", "bridge", "diagnostics", "done"].contains(phase) {
                                probe.phase = phase
                            }
                            if let report = poll["report"] as? [String: Any] {
                                probe.complete(.success(report))
                                return
                            }
                        }
                    } catch {
                        // A page still loading may replace its execution context.
                        // Retry the immediate check within the original deadline.
                        probe.retries += 1
                    }
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                }
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
            let webReport = try await checkWebView(webView)
            result["webview"] = webReport
            guard webReport["passed"] as? Bool == true else {
                throw NativeFailure(code: webReport["code"] as? String ?? "selfcheck_webview_bridge", message: "The bundled player did not pass its startup checks.")
            }
            result = ["passed": true, "checks": ["import", "distinct-identities", "native-queue", "persistence", "webview-bridge"],
                      "libraryCount": 2, "provider": "local", "state": "stopped", "webview": webReport]
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
