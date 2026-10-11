#if DEBUG
import Foundation
import CoreFoundation
import WebKit
import OSLog

/// App-only test setup: the production bridge and AVPlayer still execute every
/// UI action. A UUID isolates each test's native preferences and library from
/// normal application data; reusing it across launches verifies persistence.
/// Release builds contain neither this type nor the launch argument hook.
@MainActor
enum NativeUITestFixture {
    struct Configuration {
        let identifier: UUID
        let defaults: UserDefaults
        let libraryDirectory: URL

        init?(arguments: [String]) {
            guard let flag = arguments.firstIndex(of: "--ui-testing"),
                  arguments.indices.contains(flag + 1),
                  let identifier = UUID(uuidString: arguments[flag + 1]),
                  let defaults = UserDefaults(suiteName: "dev.nostalgify.ipad.uitests." + identifier.uuidString) else { return nil }
            self.identifier = identifier
            self.defaults = defaults
            self.libraryDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("UIAutomation", isDirectory: true)
                .appendingPathComponent(identifier.uuidString, isDirectory: true)
        }
    }

    static let configuration = Configuration(arguments: ProcessInfo.processInfo.arguments)

    static func prepare() async throws {
        guard let configuration else { return }
        let playback = NativePlayback.shared
        if !configuration.defaults.bool(forKey: "fixture.seeded") {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            for title in ["UI Test One", "UI Test Two"] {
                let source = folder.appendingPathComponent(title + ".wav")
                try NativeSelfCheck.fixture(at: source, seconds: 120)
                let result = try await playback.local.importFiles([source])
                guard result.items.count == 1 else {
                    throw NativeFailure(code: "uitest_fixture_failed", message: "The UI test audio fixture could not be imported.")
                }
            }
            configuration.defaults.set(true, forKey: "fixture.seeded")
        }
        // Exercise the real service silently. Do not autoplay or configure an
        // account; tests must explicitly invoke playback through visible UI.
        try playback.local.setActive(true)
        try await playback.local.command("volume", arg: 0)
        try playback.local.setActive(playback.provider == "local")
    }
}

/// Passive, fixture-only evidence at the DOM input boundary. The content
/// controller owns this handler; it never retains the view controller.
@MainActor
final class NativeUITestInputTrace: NSObject, WKScriptMessageHandler {
    static let limit = 32
    private static let messageName = "nostalgifyUITestInput"
    private let fixtureID: String
    private let launchID: String
    private let writer = DispatchQueue(label: "dev.nostalgify.ipad.uitest-input-writer")
    private var scriptReady = false
    private var records: [InputRecord] = []

    static func install(on content: WKUserContentController,
                        fixture: NativeUITestFixture.Configuration, launchID: String) {
        let trace = NativeUITestInputTrace(fixtureID: fixture.identifier.uuidString, launchID: launchID)
        let world = WKContentWorld.world(name: "NostalgifyUITestInput")
        content.add(trace, contentWorld: world, name: messageName)
        content.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                                          forMainFrameOnly: true, in: world))
        // An empty record distinguishes no input from a probe that never ran.
        trace.persist()
    }

    private init(fixtureID: String, launchID: String) {
        self.fixtureID = fixtureID
        self.launchID = launchID
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName, message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any] else { return }
        if body.count == 1, InputRecord.boolean(body["ready"]) == true {
            guard !scriptReady else { return }
            scriptReady = true
        } else {
            guard scriptReady, records.count < Self.limit,
                  let record = InputRecord(body) else { return }
            records.append(record)
        }
        persist()
    }

    private func persist() {
        let record = TraceRecord(fixtureID: fixtureID, launchID: launchID,
            appProcessID: ProcessInfo.processInfo.processIdentifier,
            scriptReady: scriptReady, capacityReached: records.count == Self.limit, records: records)
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("UITestStartupDiagnostics", isDirectory: true)
        let destination = directory.appendingPathComponent(fixtureID + "-" + launchID + "-input.json")
        // At most 34 serial writes: installed, ready, then 32 accepted records.
        // No filesystem work or synchronous IPC runs in the input callback.
        writer.async {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(record).write(to: destination, options: .atomic)
            } catch {
                Logger(subsystem: "dev.nostalgify.ipad", category: "UITestInput").error("input_probe_write_failed")
            }
        }
    }

    private struct TraceRecord: Encodable, Sendable {
        let version = 1
        let phase = "input"
        let fixtureID: String
        let launchID: String
        let appProcessID: Int32
        let scriptReady: Bool
        let capacityReached: Bool
        let records: [InputRecord]
    }

    struct InputRecord: Encodable, Sendable {
        // Receipt time correlates the file with native/XCTest logs; it is not
        // the original HID timestamp or a claim of synchronous DOM delivery.
        let receivedAtUnixMs = Date().timeIntervalSince1970 * 1000
        let event: String
        let phase: String
        let target: String
        let timeMs: Double
        let x: Double?
        let y: Double?
        let trusted: Bool?
        let defaultPrevented: Bool?
        let filesDisabled: Bool?
        let filesPressed: Bool?
        let playLabel: String

        init?(_ body: [String: Any]) {
            let mutation = ["files-state", "play-state"].contains(body["event"] as? String ?? "")
            guard Set(body.keys) == Set(["event", "phase", "target", "timeMs", "x", "y",
                                        "trusted", "defaultPrevented", "filesDisabled", "filesPressed", "playLabel"]),
                  let event = body["event"] as? String,
                  ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "click", "files-state", "play-state"].contains(event),
                  let phase = body["phase"] as? String,
                  (phase == "capture" && !mutation) || (phase == "bubble" && event == "click") || (phase == "mutation" && mutation),
                  let target = body["target"] as? String,
                  ["files", "spotify", "play", "other", "none"].contains(target),
                  event != "files-state" || target == "files",
                  event != "play-state" || target == "play",
                  let time = Self.number(body["timeMs"]), (0...86_400_000).contains(time),
                  Self.optionalNumberIsValid(body["x"]), Self.optionalNumberIsValid(body["y"]),
                  mutation ? (body["trusted"] is NSNull && body["defaultPrevented"] is NSNull && body["x"] is NSNull && body["y"] is NSNull)
                           : (Self.boolean(body["trusted"]) != nil && Self.boolean(body["defaultPrevented"]) != nil),
                  Self.optionalBooleanIsValid(body["filesDisabled"]),
                  Self.optionalBooleanIsValid(body["filesPressed"]),
                  let playLabel = body["playLabel"] as? String,
                  ["Play", "Pause", "other"].contains(playLabel) else { return nil }
            self.event = event; self.phase = phase; self.target = target; self.timeMs = time
            x = Self.number(body["x"]); y = Self.number(body["y"])
            trusted = Self.boolean(body["trusted"]); defaultPrevented = Self.boolean(body["defaultPrevented"])
            filesDisabled = Self.boolean(body["filesDisabled"])
            filesPressed = Self.boolean(body["filesPressed"])
            self.playLabel = playLabel
        }

        static func boolean(_ value: Any?) -> Bool? {
            guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
            return value.boolValue
        }

        private static func number(_ value: Any?) -> Double? {
            guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue.isFinite else { return nil }
            return value.doubleValue
        }

        private static func optionalNumberIsValid(_ value: Any?) -> Bool {
            value is NSNull || number(value).map { (-16_384...16_384).contains($0) } == true
        }

        private static func optionalBooleanIsValid(_ value: Any?) -> Bool {
            value is NSNull || boolean(value) != nil
        }
    }

    // Keep this literal independently executable for portable probe tests.
    static let script = #"""
    (() => {
      'use strict';
      const events = ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click'];
      const listeners = [];
      let count = 0;
      let observer;
      const stop = () => {
        for (const [type, listener, capture] of listeners) document.removeEventListener(type, listener, capture);
        observer?.disconnect();
      };
      const post = value => {
        try {
          const handler = window.webkit?.messageHandlers?.nostalgifyUITestInput;
          if (!handler) return false;
          handler.postMessage(value);
          return true;
        } catch { return false; }
      };
      const number = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 16384 ? value : null;
      const state = () => {
        const files = document.getElementById('local-source');
        const pressed = files?.getAttribute('aria-pressed');
        const label = document.getElementById('play-button')?.getAttribute('aria-label');
        return {filesDisabled: files ? files.disabled === true : null,
          filesPressed: pressed === 'true' ? true : pressed === 'false' ? false : null,
          playLabel: label === 'Play' ? 'Play' : label === 'Pause' ? 'Pause' : 'other'};
      };
      const record = (type, phase, target, event = null) => {
        if (count >= 32) return;
        const point = event?.changedTouches?.[0] ?? event;
        const time = performance.now();
        if (!Number.isFinite(time) || time < 0 || time > 86400000) { stop(); return; }
        count++;
        const sent = post({event: type, phase, target, timeMs: time,
          x: number(point?.clientX), y: number(point?.clientY), trusted: event ? event.isTrusted === true : null,
          defaultPrevented: event ? event.defaultPrevented === true : null, ...state()});
        if (!sent || count >= 32) stop();
      };
      const input = (event, phase) => {
        const control = event.target instanceof Element ? event.target.closest('#local-source, #spotify-source, #play-button') : null;
        const target = control?.id === 'local-source' ? 'files' : control?.id === 'spotify-source' ? 'spotify' :
          control?.id === 'play-button' ? 'play' : event.target instanceof Element ? 'other' : 'none';
        record(event.type, phase, target, event);
      };
      for (const type of events) {
        const listener = event => input(event, 'capture');
        document.addEventListener(type, listener, {capture: true, passive: true});
        listeners.push([type, listener, true]);
      }
      const bubble = event => input(event, 'bubble');
      document.addEventListener('click', bubble, {capture: false, passive: true});
      listeners.push(['click', bubble, false]);
      // Polling may set an unchanged attribute every second. Record only
      // normalized value changes, not each mutation or any page text.
      let previous = state();
      observer = new MutationObserver(() => {
        const current = state();
        if (current.filesPressed !== previous.filesPressed) record('files-state', 'mutation', 'files');
        if (current.playLabel !== previous.playLabel) record('play-state', 'mutation', 'play');
        previous = current;
      });
      for (const [id, attribute] of [['local-source', 'aria-pressed'], ['play-button', 'aria-label']]) {
        const element = document.getElementById(id);
        if (element) observer.observe(element, {attributes: true, attributeFilter: [attribute]});
      }
      if (!post({ready: true})) stop();
    })();
    """#
}
#endif
