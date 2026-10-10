import XCTest
import WebKit
import Capacitor
import UIKit
@testable import App

final class NativeCoreTests: XCTestCase {
    func testPlaybackValuesRejectBooleansAndNonFiniteNumbers() throws {
        XCTAssertThrowsError(try PlaybackValue.number(true))
        XCTAssertThrowsError(try PlaybackValue.number(Double.nan))
        XCTAssertThrowsError(try PlaybackValue.number("10"))
        XCTAssertEqual(try PlaybackValue.number(15.5), 15.5)
        XCTAssertEqual(PlaybackValue.position(400, duration: 180), 180)
        XCTAssertEqual(PlaybackValue.position(-4, duration: 180), 0)
        XCTAssertEqual(PlaybackValue.position(.infinity, duration: 180), 0)
        XCTAssertEqual(PlaybackValue.volume(120), 100)
        XCTAssertEqual(PlaybackValue.volume(-1), 0)
    }

    func testQueueAdvancesWithoutWrappingUnlessRepeatIsEnabled() {
        var queue = LocalQueue()
        queue.reset(["one", "two", "two"], startingAt: "one", shuffled: false)
        XCTAssertEqual(queue.ids, ["one", "two"])
        XCTAssertTrue(queue.advance(by: 1, wrapping: false))
        XCTAssertEqual(queue.current, "two")
        XCTAssertFalse(queue.advance(by: 1, wrapping: false))
        XCTAssertEqual(queue.current, "two")
        XCTAssertTrue(queue.advance(by: 1, wrapping: true))
        XCTAssertEqual(queue.current, "one")
        XCTAssertTrue(queue.advance(by: -1, wrapping: true))
        XCTAssertEqual(queue.current, "two")
        queue.reset([], startingAt: nil, shuffled: false)
        XCTAssertNil(queue.current)
        XCTAssertFalse(queue.advance(by: 1, wrapping: true))
    }

    func testLibraryRecordRejectsUnsafeFilesystemNames() throws {
        let id = UUID().uuidString
        let good = LocalAudioRecord(id: id, filename: id + ".mp3", name: "Music", artist: "", album: "", duration: 1)
        XCTAssertTrue(good.isSafe)
        XCTAssertEqual(try JSONDecoder().decode(LocalAudioRecord.self, from: JSONEncoder().encode(good)), good)
        XCTAssertFalse(LocalAudioRecord(id: id, filename: id + ".mp3/../../secret", name: "", artist: "", album: "", duration: 1).isSafe)
        XCTAssertFalse(LocalAudioRecord(id: "user supplied path", filename: "track.mp3", name: "", artist: "", album: "", duration: 1).isSafe)
    }

    func testShuffleKeepsSelectedTrackAndReachesEveryTrackWithoutRepeat() {
        let identifiers = ["one", "two", "three", "four", "five"]
        var queue = LocalQueue()
        for iteration in 0..<100 {
            let selected = identifiers[iteration % identifiers.count]
            queue.reset(identifiers + [selected], startingAt: selected, shuffled: true)
            XCTAssertEqual(queue.current, selected)
            var visited = [selected]
            while queue.advance(by: 1, wrapping: false) {
                if let current = queue.current { visited.append(current) }
            }
            XCTAssertEqual(visited.count, identifiers.count)
            XCTAssertEqual(Set(visited), Set(identifiers))
            let last = queue.current
            queue.reset(identifiers, startingAt: last, shuffled: true)
            XCTAssertEqual(queue.current, last)
            XCTAssertEqual(queue.index, 0)
        }
    }

    @MainActor
    func testImportCopiesFilesWithStableDistinctIdentities() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("same-name.wav")
        try NativeSelfCheck.fixture(at: source)
        let storage = folder.appendingPathComponent("library")
        let service = LocalAudioService(diagnostics: NativeDiagnostics(), directory: storage)
        let first = try await service.importFiles([source])
        let second = try await service.importFiles([source])
        let a = try XCTUnwrap(first.items.first)
        let b = try XCTUnwrap(second.items.first)
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertTrue(a.isSafe)
        XCTAssertEqual(a.duration, 0.6, accuracy: 0.05)
        try FileManager.default.removeItem(at: source)
        let reopened = LocalAudioService(diagnostics: NativeDiagnostics(), directory: storage)
        XCTAssertEqual(reopened.library.map(\.id), [a.id, b.id])
        try reopened.remove(id: a.id)
        XCTAssertEqual(reopened.library.map(\.id), [b.id])
        XCTAssertTrue(FileManager.default.fileExists(atPath: storage.appendingPathComponent(b.filename).path))
    }

    @MainActor
    func testSeekAfterStopPreservesPositionForNextPlay() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("seek-fixture.wav")
        try NativeSelfCheck.fixture(at: source, seconds: 8)
        let service = LocalAudioService(diagnostics: NativeDiagnostics(), directory: folder.appendingPathComponent("library"))
        _ = try await service.importFiles([source])
        try service.setActive(true)
        defer { try? service.setActive(false) }
        try await service.command("volume", arg: 0)
        try await service.command("play", arg: nil)
        try await service.command("stop", arg: nil)
        XCTAssertEqual(service.snapshot()["state"] as? String, "stopped")
        try await service.command("seek", arg: 4)
        XCTAssertEqual(service.snapshot()["state"] as? String, "paused")
        try await service.command("play", arg: nil)
        try await Task.sleep(for: .milliseconds(200))
        try await service.command("pause", arg: nil)
        let position = try XCTUnwrap(service.snapshot()["position"] as? Double)
        XCTAssertGreaterThanOrEqual(position, 3.9)
        XCTAssertLessThan(position, 5)
    }

    @MainActor
    func testDiagnosticsAreBoundedAndDoNotAcceptUserTextInIdentifiers() {
        let log = NativeDiagnostics()
        for _ in 0..<350 { log.record("command.completed", requestId: "spotify:track:private", command: "play", code: "ok") }
        log.record("https://private.example/token", requestId: "not-a-uuid", command: "a track name")
        let events = log.snapshot()["events"] as? [[String: Any]] ?? []
        XCTAssertEqual(events.count, 300)
        XCTAssertNil(events.last?["requestId"])
        XCTAssertNil(events.last?["command"])
        XCTAssertEqual(events.last?["event"] as? String, "redacted")
        XCTAssertFalse(String(describing: events).contains("spotify:track"))
    }

    @MainActor
    func testWebErrorExportKeepsOnlyFixedCodesAndStructuralLocations() {
        let valid = NativeDiagnostics.sanitizedWebError(["code": "resize_observer_loop", "errorClass": "ResizeObserver",
            "source": "app.js", "line": 42, "column": 8, "message": "private song title", "stack": "private URL"])
        XCTAssertEqual(valid["code"] as? String, "resize_observer_loop")
        XCTAssertEqual(valid["line"] as? Int, 42)
        XCTAssertNil(valid["message"])
        XCTAssertNil(valid["stack"])
        let untrusted = NativeDiagnostics.sanitizedWebError(["code": "private", "errorClass": "private",
            "source": "https://private.example", "line": Double.infinity, "column": -1])
        XCTAssertEqual(untrusted["code"] as? String, "unexpected")
        XCTAssertEqual(untrusted.count, 1)
    }

    @MainActor
    func testWebViewProbeWaitsThroughStartupNavigationAndAsyncBridge() async throws {
        let webView = WKWebView()
        webView.loadHTMLString("<html><body>Loading</body></html>", baseURL: nil)
        let navigation = Task { @MainActor in
            try await Task.sleep(for: .milliseconds(300))
            webView.loadHTMLString(Self.webViewFixture(errors: "[]"), baseURL: nil)
        }
        defer { navigation.cancel() }
        let result = try await NativeSelfCheck.checkWebView { webView }
        XCTAssertEqual(result["passed"] as? Bool, true)
        XCTAssertEqual(result["phase"] as? String, "done")
        let calls = try await webView.evaluateJavaScript("window.bridgeCalls")
        XCTAssertEqual(calls as? Int, 2)
        let cleaned = try await webView.evaluateJavaScript("!('__nostalgifyNativeProbe' in window)")
        XCTAssertEqual(cleaned as? Bool, true)
    }

    @MainActor
    func testWebViewProbeFailsOnRecordedBrowserErrorWithoutLeakingMessage() async throws {
        let webView = WKWebView()
        webView.loadHTMLString(Self.webViewFixture(errors: "[{event:'web_error',code:'javascript_error',errorClass:'TypeError',source:'app.js',line:12,column:4,message:'private song'}]"), baseURL: nil)
        let result = try await NativeSelfCheck.checkWebView { webView }
        XCTAssertEqual(result["passed"] as? Bool, false)
        XCTAssertEqual(result["code"] as? String, "selfcheck_webview_error")
        let errors = try XCTUnwrap(result["webErrors"] as? [[String: Any]])
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(errors.first?["errorClass"] as? String, "TypeError")
        XCTAssertNil(errors.first?["message"])
    }

    @MainActor
    func testBootstrapHostedControllerUsesEffectiveConfigurationAndScriptOrder() throws {
        let controller = try XCTUnwrap(UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            .compactMap { $0.rootViewController as? NostalgifyViewController }.first)
        let configuration = try XCTUnwrap(controller.bridge?.config)
        let scripts = try XCTUnwrap(controller.webView).configuration.userContentController.userScripts
        let prefix = NativeBridgeBootstrap.installationScript(
            cookiesEnabled: configuration.getPluginConfig("CapacitorCookies").getBoolean("enabled", false),
            httpEnabled: configuration.getPluginConfig("CapacitorHttp").getBoolean("enabled", false))
        let resource = try XCTUnwrap(Bundle(for: CAPBridgeViewController.self).url(forResource: "native-bridge", withExtension: "js"))
        let bridgeSource = try String(contentsOf: resource, encoding: .utf8)
        let prefixIndex = try XCTUnwrap(scripts.firstIndex { $0.source == prefix.source })
        let bridgeIndex = try XCTUnwrap(scripts.firstIndex { $0.source == bridgeSource })
        let pluginIndex = try XCTUnwrap(scripts.lastIndex { $0.source.contains("NostalgifyNative") })
        let cleanupIndex = try XCTUnwrap(scripts.firstIndex { $0.source == NativeBridgeBootstrap.cleanupScript.source })
        XCTAssertLessThan(prefixIndex, bridgeIndex)
        XCTAssertLessThan(bridgeIndex, pluginIndex)
        XCTAssertLessThan(pluginIndex, cleanupIndex)
        for index in [prefixIndex, bridgeIndex, cleanupIndex] {
            XCTAssertEqual(scripts[index].injectionTime, .atDocumentStart)
            XCTAssertTrue(scripts[index].isForMainFrameOnly)
        }
    }

    @MainActor
    func testBootstrapPreanswersPackagedBridgeConfigurationAndRestoresPrompt() async throws {
        for cookies in [false, true] {
            for http in [false, true] {
                let fixture = try BootstrapWebViewFixture(cookies: cookies, http: http)
                defer { fixture.close() }
                // A second document must install a fresh shim and restore it again.
                for _ in 0..<2 {
                    let result = try await fixture.load(in: self)
                    XCTAssertEqual(result["configCalls"] as? Int, 0)
                    XCTAssertEqual(result["bridgeReady"] as? Bool, true)
                    XCTAssertEqual(result["cookiesPatched"] as? Bool, cookies)
                    XCTAssertEqual(result["fetchPatched"] as? Bool, http)
                    XCTAssertEqual(result["xhrPatched"] as? Bool, http)
                    XCTAssertEqual(result["wrappedBeforeBridge"] as? Bool, true)
                    XCTAssertEqual(result["wrappedAfterBridge"] as? Bool, true)
                    XCTAssertEqual(result["descriptorRestored"] as? Bool, true)
                    XCTAssertEqual(result["cleanupRemoved"] as? Bool, true)
                    XCTAssertEqual(result["forwardingPreserved"] as? Bool, true)
                    XCTAssertEqual(result["exceptionPreserved"] as? Bool, true)
                    XCTAssertEqual(result["exclusionsPreserved"] as? Bool, true)
                    XCTAssertTrue(fixture.prompts.isEmpty)
                }
            }
        }
    }

    @MainActor
    func testBootstrapBaselineDetectsBothSynchronousConfigurationQueries() async throws {
        let fixture = try BootstrapWebViewFixture(cookies: false, http: false, installShim: false)
        defer { fixture.close() }
        let result = try await fixture.load(in: self)
        XCTAssertEqual(result["configCalls"] as? Int, 2,
            "The real packaged bridge must exercise the sentinel; removing the production prefix must fail the zero-call regression.")
        XCTAssertEqual(result["bridgeReady"] as? Bool, true)
        XCTAssertTrue(fixture.prompts.isEmpty, "The baseline must not enter the known synchronous IPC stall.")
    }

    @MainActor
    func testBootstrapForwardsOrdinaryPromptsAndCookieOperations() async throws {
        let fixture = try BootstrapWebViewFixture(cookies: true, http: false)
        defer { fixture.close() }
        _ = try await fixture.load(in: self)
        let value = try await fixture.evaluate("""
        (() => {
          window.__bootstrapTest.useNativePrompt = true;
          const ordinary = prompt('ordinary', 'prefill');
          const cancelled = prompt('cancel');
          const cookie = document.cookie;
          document.cookie = 'fixture=updated; domain=localhost';
          return {ordinary, cancelled, cookie};
        })()
        """, in: self)
        let result = try XCTUnwrap(value as? [String: Any])
        XCTAssertEqual(result["ordinary"] as? String, "native reply")
        XCTAssertTrue(result["cancelled"] is NSNull)
        XCTAssertEqual(result["cookie"] as? String, "fixture=value")
        XCTAssertEqual(fixture.prompts.count, 4)
        guard fixture.prompts.count == 4 else { return }
        XCTAssertEqual(fixture.prompts[0].message, "ordinary")
        XCTAssertEqual(fixture.prompts[0].defaultText, "prefill")
        XCTAssertEqual(fixture.prompts[1].message, "cancel")
        XCTAssertEqual(fixture.prompts[2].message, #"{"type":"CapacitorCookies.get"}"#)
        let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(fixture.prompts[3].message.utf8)) as? [String: String])
        XCTAssertEqual(payload, ["type": "CapacitorCookies.set", "action": "fixture=updated; domain=localhost", "domain": "localhost"])
    }

    @MainActor
    func testBootstrapPreservesOwnAndInheritedPromptAccessors() async throws {
        for property in [BootstrapWebViewFixture.PromptProperty.ownAccessor, .inheritedAccessor, .immutableAccessor] {
            let fixture = try BootstrapWebViewFixture(cookies: false, http: false, promptProperty: property)
            defer { fixture.close() }
            let result = try await fixture.load(in: self)
            XCTAssertEqual(result["configCalls"] as? Int, property == .immutableAccessor ? 2 : 0)
            XCTAssertEqual(result["descriptorRestored"] as? Bool, true)
            XCTAssertEqual(result["setterCalls"] as? Int, 0)
            XCTAssertEqual(result["cleanupRemoved"] as? Bool, true)
            XCTAssertEqual(result["exclusionsPreserved"] as? Bool, true)
            if property == .immutableAccessor {
                XCTAssertEqual(result["installationGetterReads"] as? Int, 0)
            }
            XCTAssertTrue(fixture.prompts.isEmpty)
        }
    }

    @MainActor
    func testBootstrapCleanupHandlesMissingOrThrowingBridgeAndPreservesPromptOwnership() async throws {
        for scenario in [BootstrapWebViewFixture.Scenario.missing, .throwing, .foreignPrompt, .foreignGetter] {
            let fixture = try BootstrapWebViewFixture(cookies: false, http: false, scenario: scenario)
            defer { fixture.close() }
            let result = try await fixture.load(in: self)
            XCTAssertEqual(result["configCalls"] as? Int, 0)
            XCTAssertEqual(result["cleanupRemoved"] as? Bool, true)
            let hasForeignPrompt = scenario == .foreignPrompt || scenario == .foreignGetter
            XCTAssertEqual(result["descriptorRestored"] as? Bool, !hasForeignPrompt)
            XCTAssertEqual(result["foreignPromptPreserved"] as? Bool, hasForeignPrompt)
            XCTAssertEqual(result["bridgeReady"] as? Bool, hasForeignPrompt)
            XCTAssertEqual(result["bridgeThrew"] as? Bool, scenario == .throwing)
            XCTAssertEqual(result["foreignGetterReads"] as? Int, 0)
            XCTAssertTrue(fixture.prompts.isEmpty)
        }
    }

    private static func webViewFixture(errors: String) -> String {
        """
        <html data-player-ready="true"><body>
        <div id="app"><div id="webamp"><div id="main-window"></div></div></div>
        <p id="error-message" hidden></p>
        <script>
        window.bridgeCalls = 0;
        window.Capacitor = {getPlatform: () => 'ios'};
        window.nostalgify = {
          debug: false,
          getState: async () => {
            window.bridgeCalls++;
            await new Promise(resolve => setTimeout(resolve, 150));
            return {provider:'spotify',state:'stopped',sequence:0};
          },
          getDiagnostics: async () => {
            window.bridgeCalls++;
            await new Promise(resolve => setTimeout(resolve, 50));
            return {web:\(errors)};
          }
        };
        </script></body></html>
        """
    }
}

/// The saved-prompt sentinel makes an unpatched bridge fail by a call count,
/// without entering WebKit's document-start synchronous IPC path in the control.
@MainActor
private final class BootstrapWebViewFixture: NSObject, WKScriptMessageHandler, WKUIDelegate {
    enum Scenario { case normal, missing, throwing, foreignPrompt, foreignGetter }
    enum PromptProperty { case data, ownAccessor, inheritedAccessor, immutableAccessor }
    let webView: WKWebView
    private var report: [String: Any]?
    private var reportReady: XCTestExpectation?
    private(set) var prompts: [(message: String, defaultText: String?)] = []

    init(cookies: Bool, http: Bool, installShim: Bool = true, scenario: Scenario = .normal,
         promptProperty: PromptProperty = .data) throws {
        let bridgeURL = try XCTUnwrap(Bundle(for: CAPBridgeViewController.self).url(forResource: "native-bridge", withExtension: "js"))
        let bridgeSource = try String(contentsOf: bridgeURL, encoding: .utf8)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let content = configuration.userContentController
        func add(_ source: String, at time: WKUserScriptInjectionTime = .atDocumentStart) {
            content.addUserScript(WKUserScript(source: source, injectionTime: time, forMainFrameOnly: true))
        }
        add("""
        (() => {
          const nativePrompt = window.prompt;
          const state = window.__bootstrapTest = {
            fetch: window.fetch, xhr: window.XMLHttpRequest, configCalls: 0,
            calls: [], exception: {}, bridgeThrew: false, useNativePrompt: false,
            getterCalls: 0, setterCalls: 0, foreignGetterReads: 0, coercions: 0
          };
          function sentinel(message) {
            if (arguments.length === 1 && message === '{"type":"CapacitorCookies.isEnabled"}') {
              state.configCalls++; return '\(cookies)';
            }
            if (arguments.length === 1 && message === '{"type":"CapacitorHttp"}') {
              state.configCalls++; return '\(http)';
            }
            if (state.useNativePrompt) return Reflect.apply(nativePrompt, this, arguments);
            state.calls.push({receiver: this, arguments: Array.from(arguments)});
            if (message === state.exception) throw state.exception;
            return 'forwarded';
          }
          const descriptor = \(promptProperty == .data) ? {
            value: sentinel, configurable: true, enumerable: false, writable: true
          } : {
            configurable: \(promptProperty != .immutableAccessor), enumerable: false,
            get() { state.getterCalls++; return sentinel; },
            set(value) { state.setterCalls++; state.assignedPrompt = value; }
          };
          if (\(promptProperty == .inheritedAccessor)) {
            Object.defineProperty(Object.getPrototypeOf(window), 'prompt', descriptor);
            delete window.prompt;
          } else Object.defineProperty(window, 'prompt', descriptor);
          state.savedPrompt = sentinel;
          state.descriptor = Object.getOwnPropertyDescriptor(window, 'prompt');
        })();
        """)
        if installShim {
            let prefix = NativeBridgeBootstrap.installationScript(cookiesEnabled: cookies, httpEnabled: http)
            XCTAssertEqual(prefix.injectionTime, .atDocumentStart)
            XCTAssertTrue(prefix.isForMainFrameOnly)
            content.addUserScript(prefix)
        }
        add("""
        (() => {
          const state = window.__bootstrapTest, receiver = {}, message = {}, defaultText = {}, extra = {};
          state.installationGetterReads = state.getterCalls;
          state.wrappedBeforeBridge = window.prompt !== state.savedPrompt;
          const answer = window.prompt.call(receiver, message, defaultText, extra);
          const call = state.calls[0];
          state.forwardingPreserved = answer === 'forwarded' && call.receiver === receiver &&
            call.arguments.length === 3 && call.arguments[0] === message &&
            call.arguments[1] === defaultText && call.arguments[2] === extra;
          try { window.prompt(state.exception); } catch (error) {
            state.exceptionPreserved = error === state.exception && state.calls.length === 2;
          }
          const config = '{"type":"CapacitorHttp"}';
          const excluded = [
            [config, defaultText], [config, undefined, extra], [new String(config)],
            [{toString() { state.coercions++; return config; }}],
            ['{ "type": "CapacitorHttp" }'], ['{"type":"CapacitorHttp","extra":true}'],
            ['{"type":"CapacitorCookies.get"}'],
            ['{"type":"CapacitorCookies.set","action":"a=b","domain":"localhost"}']
          ];
          state.exclusionsPreserved = excluded.every(args => {
            const count = state.calls.length;
            const answer = Reflect.apply(window.prompt, receiver, args);
            const call = state.calls[state.calls.length - 1];
            return answer === 'forwarded' && state.calls.length === count + 1 &&
              call.receiver === receiver && call.arguments.length === args.length &&
              args.every((value, index) => call.arguments[index] === value);
          }) && state.coercions === 0;
        })();
        window.Capacitor = {DEBUG: false, isLoggingEnabled: false, Plugins: {}};
        window.WEBVIEW_SERVER_URL = 'capacitor://localhost';
        """)
        if scenario == .throwing {
            add("""
            Object.defineProperty(window, 'XMLHttpRequest', {configurable: true, get() {
              window.__bootstrapTest.bridgeThrew = true;
              throw new Error('bootstrap fixture');
            }});
            """)
        }
        if scenario != .missing { add(bridgeSource) }
        add("window.__bootstrapTest.wrappedAfterBridge = window.prompt !== window.__bootstrapTest.savedPrompt;")
        if scenario == .foreignPrompt {
            add("window.prompt = window.__bootstrapTest.foreignPrompt = function () { return 'foreign'; };")
        }
        if scenario == .foreignGetter {
            add("""
            window.__bootstrapTest.foreignGetter = function () {
              window.__bootstrapTest.foreignGetterReads++; return function () {};
            };
            Object.defineProperty(window, 'prompt', {configurable: true, get: window.__bootstrapTest.foreignGetter});
            """)
        }
        let cleanup = NativeBridgeBootstrap.cleanupScript
        XCTAssertEqual(cleanup.injectionTime, .atDocumentStart)
        XCTAssertTrue(cleanup.isForMainFrameOnly)
        content.addUserScript(cleanup)
        add("""
        (() => {
          const state = window.__bootstrapTest;
          const descriptor = Object.getOwnPropertyDescriptor(window, 'prompt');
          window.webkit.messageHandlers.bootstrapResult.postMessage({
            configCalls: state.configCalls,
            bridgeReady: typeof window.Capacitor.nativePromise === 'function',
            cookiesPatched: Object.prototype.hasOwnProperty.call(document, 'cookie'),
            fetchPatched: window.fetch !== state.fetch,
            xhrPatched: !state.bridgeThrew && window.XMLHttpRequest !== state.xhr,
            wrappedBeforeBridge: state.wrappedBeforeBridge,
            wrappedAfterBridge: state.wrappedAfterBridge,
            descriptorRestored: state.descriptor === undefined
              ? descriptor === undefined && window.prompt === state.savedPrompt
              : !!descriptor && ['value', 'writable', 'enumerable', 'configurable', 'get', 'set']
                .every(key => descriptor[key] === state.descriptor[key]),
            cleanupRemoved: !Object.prototype.hasOwnProperty.call(window, '__nostalgifyRestoreBootstrapPrompt'),
            forwardingPreserved: state.forwardingPreserved,
            exceptionPreserved: state.exceptionPreserved === true,
            exclusionsPreserved: state.exclusionsPreserved,
            setterCalls: state.setterCalls,
            installationGetterReads: state.installationGetterReads,
            foreignGetterReads: state.foreignGetterReads,
            foreignPromptPreserved: (!!state.foreignPrompt && descriptor.value === state.foreignPrompt) ||
              (!!state.foreignGetter && descriptor.get === state.foreignGetter),
            bridgeThrew: state.bridgeThrew
          });
        })();
        """, at: .atDocumentEnd)
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        content.add(self, name: "bridge")
        content.add(self, name: "bootstrapResult")
        webView.uiDelegate = self
    }

    func load(in test: XCTestCase) async throws -> [String: Any] {
        report = nil
        let ready = test.expectation(description: "bootstrap document finished")
        reportReady = ready
        webView.loadHTMLString("<html><body>Bootstrap fixture</body></html>", baseURL: URL(string: "https://bootstrap.invalid/"))
        await test.fulfillment(of: [ready], timeout: 10)
        reportReady = nil
        return try XCTUnwrap(report)
    }

    func evaluate(_ source: String, in test: XCTestCase) async throws -> Any {
        let ready = test.expectation(description: "bootstrap JavaScript completed")
        var result: Result<Any, Error>?
        webView.evaluateJavaScript(source) { value, error in
            result = error.map { .failure($0) } ?? .success(value ?? NSNull())
            ready.fulfill()
        }
        await test.fulfillment(of: [ready], timeout: 10)
        return try XCTUnwrap(result).get()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "bootstrapResult", report == nil else { return }
        report = message.body as? [String: Any]
        reportReady?.fulfill()
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        prompts.append((prompt, defaultText))
        switch prompt {
        case "cancel": completionHandler(nil)
        case #"{"type":"CapacitorCookies.get"}"#: completionHandler("fixture=value")
        case #"{"type":"CapacitorCookies.isEnabled"}"#, #"{"type":"CapacitorHttp"}"#:
            XCTFail("Configuration queries must not reach native prompt IPC")
            completionHandler("false")
        default: completionHandler("native reply")
        }
    }

    func close() {
        webView.stopLoading()
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "bootstrapResult")
    }
}
