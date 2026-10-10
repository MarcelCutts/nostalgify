import Capacitor
import WebKit
#if DEBUG
import Foundation
import OSLog
#endif

final class NostalgifyViewController: CAPBridgeViewController {
    private var bootstrapCookiesEnabled = false
    private var bootstrapHttpEnabled = false

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        bootstrapCookiesEnabled = instanceConfiguration.getPluginConfig("CapacitorCookies").getBoolean("enabled", false)
        bootstrapHttpEnabled = instanceConfiguration.getPluginConfig("CapacitorHttp").getBoolean("enabled", false)
        return super.webViewConfiguration(for: instanceConfiguration)
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Capacitor replaces the content controller after webViewConfiguration.
        // This hook sees its final controller, before the SDK exports its bridge.
        configuration.userContentController.addUserScript(NativeBridgeBootstrap.installationScript(
            cookiesEnabled: bootstrapCookiesEnabled, httpEnabled: bootstrapHttpEnabled))
        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NostalgifyNativePlugin())
        // Run after the SDK/plugin exports, before page content. A separate
        // script also restores prompt if an earlier bootstrap script throws.
        webView?.configuration.userContentController.addUserScript(NativeBridgeBootstrap.cleanupScript)
        #if DEBUG
        scheduleUITestStartupProbe()
        #endif
    }

    #if DEBUG
    private var startupProbeScheduled = false

    /// This probe observes the normal Capacitor setup without replacing its
    /// navigation delegate, retrying navigation, or extending UI-test deadlines.
    private func scheduleUITestStartupProbe() {
        guard !startupProbeScheduled, let fixture = NativeUITestFixture.configuration else { return }
        startupProbeScheduled = true
        let fixtureID = fixture.identifier.uuidString
        let launchID = UUID().uuidString
        let started = ProcessInfo.processInfo.systemUptime
        writeStartupProbe(startupRecord(phase: "scheduled", fixtureID: fixtureID, launchID: launchID, started: started))
        Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            guard let self else { return }
            self.requestStartupProbe(fixtureID: fixtureID, launchID: launchID, started: started)
        }
    }

    private func requestStartupProbe(fixtureID: String, launchID: String, started: Double) {
        // Persist the request before sending JavaScript: a stalled web process
        // must still leave its native loading state available in CI artifacts.
        let requested = startupRecord(phase: "requested", fixtureID: fixtureID, launchID: launchID, started: started)
        writeStartupProbe(requested)
        guard let webView else { return }
        let javascript = """
        (() => ({
          readyState: document.readyState,
          hasSettings: !!document.getElementById('settings-toggle'),
          hasCapacitor: !!window.Capacitor,
          playerReady: document.documentElement?.dataset.playerReady === 'true'
        }))()
        """
        webView.evaluateJavaScript(javascript) { [weak self] value, error in
            guard let self else { return }
            var completed = self.startupRecord(phase: "completed", fixtureID: fixtureID, launchID: launchID, started: started)
            completed.javascriptSucceeded = error == nil
            if let state = value as? [String: Any] {
                if let readyState = state["readyState"] as? String,
                   ["loading", "interactive", "complete"].contains(readyState) {
                    completed.readyState = readyState
                }
                completed.hasSettings = state["hasSettings"] as? Bool
                completed.hasCapacitor = state["hasCapacitor"] as? Bool
                completed.playerReady = state["playerReady"] as? Bool
            }
            self.writeStartupProbe(completed)
        }
    }

    private func startupRecord(phase: String, fixtureID: String, launchID: String, started: Double) -> StartupProbeRecord {
        let progress = webView?.estimatedProgress
        return StartupProbeRecord(fixtureID: fixtureID, launchID: launchID,
            appProcessID: ProcessInfo.processInfo.processIdentifier, phase: phase,
            elapsedMs: max(0, (ProcessInfo.processInfo.systemUptime - started) * 1000),
            webViewPresent: webView != nil, isLoading: webView?.isLoading,
            estimatedProgress: progress.flatMap { $0.isFinite ? min(1, max(0, $0)) : nil })
    }

    private func writeStartupProbe(_ record: StartupProbeRecord) {
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("UITestStartupDiagnostics", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = record.fixtureID + "-" + record.launchID + "-" + record.phase + ".json"
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(record).write(to: directory.appendingPathComponent(name), options: .atomic)
        } catch {
            // A fixed event is sufficient: raw filesystem errors can include paths.
            Logger(subsystem: "dev.nostalgify.ipad", category: "UITestStartup").error("probe_write_failed")
        }
    }

    /// Only fixed phases, generated identities, the numeric process identity,
    /// booleans and loading progress leave the app. Never include a URL, page
    /// text, source or raw JavaScript error.
    private struct StartupProbeRecord: Encodable, Sendable {
        let version = 1
        let fixtureID: String
        let launchID: String
        let appProcessID: Int32
        let phase: String
        let elapsedMs: Double
        let webViewPresent: Bool
        let isLoading: Bool?
        let estimatedProgress: Double?
        var javascriptSucceeded: Bool?
        var readyState: String?
        var hasSettings: Bool?
        var hasCapacitor: Bool?
        var playerReady: Bool?
    }
    #endif
}

/// Capacitor 8.5.3 synchronously prompts for these two native configuration
/// values at document start, even when both plugins are disabled. Answer them
/// from the same configuration without entering WebKit's synchronous prompt IPC.
@MainActor
enum NativeBridgeBootstrap {
    static func installationScript(cookiesEnabled: Bool, httpEnabled: Bool) -> WKUserScript {
        let source = """
        (() => {
          'use strict';
          const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'prompt');
          // An immutable own property cannot safely be replaced.
          if (originalDescriptor && !originalDescriptor.configurable &&
              (!('value' in originalDescriptor) || !originalDescriptor.writable)) return;
          const originalPrompt = window.prompt;
          function bootstrapPrompt(message) {
            if (arguments.length === 1 && typeof message === 'string') {
              if (message === '{"type":"CapacitorCookies.isEnabled"}') return '\(cookiesEnabled)';
              if (message === '{"type":"CapacitorHttp"}') return '\(httpEnabled)';
            }
            return Reflect.apply(originalPrompt, this, arguments);
          }
          Object.defineProperty(window, '__nostalgifyRestoreBootstrapPrompt', {
            configurable: true,
            value: () => {
              if (Object.getOwnPropertyDescriptor(window, 'prompt')?.value === bootstrapPrompt) {
                if (originalDescriptor) Object.defineProperty(window, 'prompt', originalDescriptor);
                else delete window.prompt;
              }
              delete window.__nostalgifyRestoreBootstrapPrompt;
            }
          });
          // Defining an own data property avoids invoking accessor setters.
          Object.defineProperty(window, 'prompt', {
            value: bootstrapPrompt,
            writable: originalDescriptor && 'value' in originalDescriptor ? originalDescriptor.writable : true,
            enumerable: originalDescriptor ? originalDescriptor.enumerable : true,
            configurable: originalDescriptor ? originalDescriptor.configurable : true
          });
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    static var cleanupScript: WKUserScript {
        WKUserScript(source: "window.__nostalgifyRestoreBootstrapPrompt?.();",
                     injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}
