import XCTest
import UIKit

/// These tests launch the installed app and operate its WKWebView accessibility
/// tree. Only input files/storage are fixtures; Capacitor and AVPlayer are real.
/// Spotify authorization, Files providers and audible output remain device tests.
@MainActor
final class AppUITests: XCTestCase {
    private var app: XCUIApplication!
    private var fixtureID: String!
    // XCTest creates a separate case instance for each test method.
    private var launchOrdinal = 0
    private var phaseSequence = 0
    private var testStartedUptime = ProcessInfo.processInfo.systemUptime
    private var lastPhaseRecord: String?
    private var voiceOverTeardown: (@MainActor () -> String?)?
    // The app owns one WKWebView. Start at its first native wrapper instead of
    // repeatedly searching every nested/auxiliary WebView accessibility node.
    private var webView: XCUIElement { app.webViews.firstMatch }

    override func setUpWithError() throws {
        // Keep lifecycle hooks synchronous: async hooks plus fail-fast assertions
        // make XCTest restart its runner after failures on Xcode 26 and later.
        // https://developer.apple.com/forums/thread/809989
        testStartedUptime = ProcessInfo.processInfo.systemUptime
        continueAfterFailure = false
        // Real keyboard, accessibility and AVPlayer interactions took 116s on
        // the compatibility runner. Keep a bounded allowance for VM variance.
        executionTimeAllowance = 180
        fixtureID = UUID().uuidString
        app = XCUIApplication()
        app.launchArguments = ["--ui-testing", fixtureID, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        phase("setup.orientation") { XCUIDevice.shared.orientation = .portrait }
        launch()
    }

    override func tearDownWithError() throws {
        // Save runner-side evidence even when termination is the first failure.
        // This uses cached phase data, never another app or accessibility query.
        let previousPhase = lastPhaseRecord ?? "No UI phase was recorded."
        let evidence = XCTAttachment(string: previousPhase)
        evidence.name = "Last phase before teardown"
        evidence.lifetime = .keepAlways
        add(evidence)
        var cleanupFailure: String?
        phase("teardown") {
            // XCTest invokes this synchronous hook after fail-fast interruptions.
            // Clear the retained closure before invoking it so it cannot run twice
            // or remain retained by this test if cleanup is interrupted.
            let cleanupVoiceOver = voiceOverTeardown
            voiceOverTeardown = nil
            cleanupFailure = cleanupVoiceOver?()
            // hasSucceeded remains false until teardown itself completes.
            if let app, (testRun?.totalFailureCount ?? 0) > 0 {
                let screenshot = XCTAttachment(screenshot: phase("failure.screenshot") { app.screenshot() })
                screenshot.name = "Failed app screen"
                screenshot.lifetime = .keepAlways
                add(screenshot)
                let hierarchy = XCTAttachment(string: phase("failure.hierarchy") { app.debugDescription })
                hierarchy.name = "Failed accessibility hierarchy"
                hierarchy.lifetime = .keepAlways
                add(hierarchy)
            }
            phase("app.terminate") { app?.terminate() }
            phase("teardown.orientation") { XCUIDevice.shared.orientation = .portrait }
        }
        if let cleanupFailure { XCTFail(cleanupFailure) }
    }

    /// Emit a start record before a potentially blocking call. A finished record
    /// means the call returned; assertion failures remain XCTest's source of truth.
    private func phase<T>(_ name: String, _ operation: () throws -> T) rethrows -> T {
        let identifier = UUID().uuidString
        return try XCTContext.runActivity(named: name) { activity in
            @MainActor
            func record(_ status: String) {
                phaseSequence += 1
                let timestamp = ISO8601DateFormatter()
                timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let event: [String: Any] = ["version": 1, "testId": self.name,
                    "fixtureId": fixtureID ?? "uninitialized", "launchOrdinal": launchOrdinal,
                    "phaseId": identifier, "sequence": phaseSequence, "phase": name, "status": status,
                    "processId": ProcessInfo.processInfo.processIdentifier,
                    "utc": timestamp.string(from: Date()),
                    "elapsedMs": (ProcessInfo.processInfo.systemUptime - testStartedUptime) * 1000]
                guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
                let json = String(decoding: data, as: UTF8.self)
                lastPhaseRecord = json
                // Direct stderr output survives loss of buffered test stdout.
                FileHandle.standardError.write(Data(("NOSTALGIFY_TEST_PHASE " + json + "\n").utf8))
                let attachment = XCTAttachment(string: json)
                attachment.name = "\(name) \(status)"
                attachment.lifetime = .keepAlways
                activity.add(attachment)
            }
            record("started")
            do {
                let result = try operation()
                record("finished")
                return result
            } catch {
                // Swift errors reach this branch; XCTest interruption exceptions
                // can instead leave a started phase without a matching end.
                record("threw")
                throw error
            }
        }
    }

    private func launch() {
        let started = Date()
        let startUptime = ProcessInfo.processInfo.systemUptime
        launchOrdinal += 1
        phase("app.launch") { app.launch() }
        let launchedUptime = ProcessInfo.processInfo.systemUptime
        // CI recorded 28-second launches for WebKit's renderer, networking and
        // GPU helpers before the page could load. This is a bounded readiness
        // allowance after app.launch(), within the unchanged 180-second case.
        let readinessWaitLimit: TimeInterval = 60
        // Source browsing becomes enabled after startup's final library render.
        // Evaluate the enabled attribute within XCTest's native element query,
        // preserving one readiness wait rather than polling separate properties.
        let files = webView.switches.matching(
            NSPredicate(format: "label == %@ AND enabled == YES", "Files")).firstMatch
        let filesReady = phase("app.readiness") { files.waitForExistence(timeout: readinessWaitLimit) }
        // Check the real header immediately; there is no second readiness wait.
        let settingsReady = filesReady && button("settings-toggle", "Settings").exists
        let ready = filesReady && settingsReady
        let checkedUptime = ProcessInfo.processInfo.systemUptime
        let timing = LaunchTiming(fixtureID: fixtureID, launchOrdinal: launchOrdinal,
            startedAtUTC: ISO8601DateFormatter().string(from: started),
            appLaunchSeconds: launchedUptime - startUptime,
            readinessWaitSeconds: checkedUptime - launchedUptime,
            totalSeconds: checkedUptime - startUptime,
            readinessWaitLimitSeconds: readinessWaitLimit, ready: ready)
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let attachment = XCTAttachment(string: String(decoding: try encoder.encode(timing), as: UTF8.self))
            attachment.name = "App launch timing \(launchOrdinal)"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not encode app launch timing: \(error)")
        }
        if !ready {
            let details = """
            Launch began: \(ISO8601DateFormatter().string(from: started))
            Elapsed seconds including app.launch(): \(Date().timeIntervalSince(started))
            App state: \(app.state.rawValue)
            App frame: \(app.frame)
            Window count: \(app.windows.count)
            WKWebView count: \(app.webViews.count)
            Orientation: \(XCUIDevice.shared.orientation.rawValue)
            Enabled Files found during the single 60-second wait: \(filesReady)
            Settings present immediately afterward: \(filesReady ? String(settingsReady) : "not checked because Files was not ready")
            The interface did not finish initializing. See the failure screenshot/hierarchy and simulator startup log.
            """
            let attachment = XCTAttachment(string: details)
            attachment.name = "Launch readiness failure"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertTrue(ready, "The real bundled UI must become ready.")
        XCTAssertFalse(app.staticTexts["UI test fixture failed"].exists)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "DEVELOPMENT DEMO")).firstMatch.exists)
    }

    private struct LaunchTiming: Encodable {
        let version = 1
        let fixtureID: String
        let launchOrdinal: Int
        let startedAtUTC: String
        let appLaunchSeconds: Double
        let readinessWaitSeconds: Double
        let totalSeconds: Double
        let readinessWaitLimitSeconds: Double
        let ready: Bool
    }

    private func button(_ identifier: String, _ label: String) -> XCUIElement {
        let predicate = identifier.isEmpty ? NSPredicate(format: "label == %@", label) :
            NSPredicate(format: "identifier == %@ OR label == %@", identifier, label)
        return webView.buttons.matching(predicate).firstMatch
    }

    private func text(_ label: String) -> XCUIElement { webView.staticTexts[label].firstMatch }

    private func waitForPlaybackAction(_ label: String, _ message: String,
                                       file: StaticString = #filePath, line: UInt = #line) {
        // The label changes with native playback state. Query for that state
        // without resolving a required element before its new label is present.
        let expected = webView.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(phase("playback.confirmAction") { expected.waitForExistence(timeout: 10) },
                      message, file: file, line: line)
    }

    private func firstSnapshot(in root: XCUIElementSnapshot,
                               matching predicate: (XCUIElementSnapshot) -> Bool) -> XCUIElementSnapshot? {
        if predicate(root) { return root }
        for child in root.children {
            if let match = firstSnapshot(in: child, matching: predicate) { return match }
        }
        return nil
    }

    @discardableResult
    private func reveal(_ element: XCUIElement, file: StaticString = #filePath,
                        line: UInt = #line) -> XCUIElementSnapshot? {
        phase("control.reveal") {
            XCTAssertTrue(element.waitForExistence(timeout: 10), "Element is missing: \(element)", file: file, line: line)
            // A scroll moves content within this viewport; it does not resize the
            // viewport. Read its bounds once, after any rotation/keyboard dismissal.
            let visible = webView.frame.intersection(app.frame).insetBy(dx: 0, dy: 25)
            for _ in 0..<8 {
                let snapshot: XCUIElementSnapshot
                do {
                    snapshot = try phase("control.snapshot") { try element.snapshot() }
                } catch {
                    XCTFail("Could not inspect the control: \(error)", file: file, line: line)
                    return nil
                }
                let frame = snapshot.frame
                let center = CGPoint(x: frame.midX, y: frame.midY)
                // Avoid an expensive hit-point query for a known offscreen control.
                // Return this same snapshot for subsequent frame/label assertions.
                if visible.contains(center) && element.isHittable { return snapshot }
                if center.y < visible.minY { webView.swipeDown() } else { webView.swipeUp() }
            }
            XCTFail("Element is inaccessible after scrolling: \(element)", file: file, line: line)
            return nil
        }
    }

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        // WKWebView can report a DOM control as hittable behind the keyboard.
        // Dismiss the actual iPad keyboard before tapping a non-text control.
        let hideKeyboard = app.keyboards.buttons["Hide keyboard"].firstMatch
        if keyboardIsVisible {
            XCTAssertTrue(hideKeyboard.waitForExistence(timeout: 5), file: file, line: line)
            phase("keyboard.dismiss") { hideKeyboard.tap() }
            waitUntil("The keyboard must close before tapping content", file: file, line: line) { !self.keyboardIsVisible }
        }
        reveal(element, file: file, line: line)
        phase("control.tap") { element.tap() }
    }

    private var keyboardIsVisible: Bool {
        // Keep the common no-keyboard path to one cheap existence query.
        guard phase("keyboard.exists", { app.keyboards.firstMatch.exists }) else { return false }
        do {
            // The keyboard can disappear between separate exists/frame reads.
            // Inspect a single app snapshot after the check so disappearance is
            // normal, never a failed lookup of the now-absent keyboard query.
            let snapshot = try phase("keyboard.snapshot") { try app.snapshot() }
            return keyboardIsVisible(in: snapshot)
        } catch {
            XCTFail("Could not inspect the application's keyboard state: \(error)")
            return true // A failed snapshot must never authorize a content tap.
        }
    }

    private func keyboardIsVisible(in snapshot: XCUIElementSnapshot) -> Bool {
        firstSnapshot(in: snapshot) { element in
            guard element.elementType == .keyboard else { return false }
            // iPadOS 27 retains a zero-height keyboard and offscreen preview
            // buttons after dismissal. Existence alone does not mean open.
            let visible = element.frame.intersection(snapshot.frame)
            return !visible.isNull && visible.width > 1 && visible.height > 1
        } != nil
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 10,
                           file: StaticString = #filePath, line: UInt = #line,
                           _ condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        let result = phase("assertion.wait") { XCTWaiter.wait(for: [expectation], timeout: timeout) }
        XCTAssertEqual(result, .completed, message, file: file, line: line)
    }

    private func auditAccessibility() throws {
        // Report every finding from this screen while preserving test failure.
        // Restore fail-fast behavior for ordinary interactions afterward.
        let previousContinueAfterFailure = continueAfterFailure
        continueAfterFailure = true
        defer { continueAfterFailure = previousContinueAfterFailure }
        try app.performAccessibilityAudit(for: [.elementDetection, .sufficientElementDescription]) { issue in
            var details = ["Type: \(issue.auditType)", issue.compactDescription, issue.detailedDescription]
            if let element = issue.element {
                details += ["Element type: \(element.elementType)", "Label: \(element.label)",
                            "Frame: \(element.frame)", element.debugDescription]
            } else {
                details.append("The audit did not associate an accessibility element with this finding.")
            }
            let attachment = XCTAttachment(string: String(details.joined(separator: "\n").prefix(12_000)))
            attachment.name = "Accessibility audit finding"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            return false // Preserve the failure; this handler only adds evidence.
        }
    }

    // WebKit exposes HTML aria-pressed controls as native accessibility switches.
    private func openFiles() {
        tap(webView.switches["Files"].firstMatch)
        let selectedFiles = webView.switches.matching(
            NSPredicate(format: "label == %@ AND value == %@", "Files", "1")).firstMatch
        XCTAssertTrue(selectedFiles.waitForExistence(timeout: 10),
                      "The single Files tap must select the Files collection.")
    }

    private func playFixture() {
        openFiles()
        tapFixturePlay()
        waitForPlaybackAction("Pause", "The real AVPlayer must confirm playing")
        XCTAssertTrue(text("Now playing: UI Test One").waitForExistence(timeout: 10))
    }

    private func tapFixturePlay(file: StaticString = #filePath, line: UInt = #line) {
        let label = "Play UI Test One"
        let element = button("", label)
        phase("fixture.play") {
            XCTAssertTrue(phase("fixture.exists") { element.waitForExistence(timeout: 10) },
                          "Element is missing: \(element)", file: file, line: line)
            do {
                // One coherent read supplies keyboard, viewport and target
                // geometry. Separate AX queries took tens of seconds each in CI.
                var snapshot = try phase("fixture.snapshot") { try app.snapshot() }
                if keyboardIsVisible(in: snapshot) {
                    let hideKeyboard = app.keyboards.buttons["Hide keyboard"].firstMatch
                    XCTAssertTrue(hideKeyboard.waitForExistence(timeout: 5), file: file, line: line)
                    phase("keyboard.dismiss") { hideKeyboard.tap() }
                    waitUntil("The keyboard must close before tapping content", file: file, line: line) {
                        !self.keyboardIsVisible
                    }
                    snapshot = try phase("fixture.snapshot") { try app.snapshot() }
                }
                for attempt in 0..<8 {
                    if attempt > 0 {
                        snapshot = try phase("fixture.snapshot") { try app.snapshot() }
                    }
                    // Match the live query within the same first WebView;
                    // similarly named controls outside it cannot satisfy this.
                    guard let web = firstSnapshot(in: snapshot, matching: { $0.elementType == .webView }),
                          let target = firstSnapshot(in: web, matching: { $0.elementType == .button && $0.label == label }) else {
                        XCTFail("Could not find the fixture control in the application's snapshot.", file: file, line: line)
                        return
                    }
                    let visible = web.frame.intersection(snapshot.frame).insetBy(dx: 0, dy: 25)
                    let center = CGPoint(x: target.frame.midX, y: target.frame.midY)
                    if visible.contains(center) {
                        // tap() computes a live hittable point. Keep that real
                        // input check without resolving isHittable separately.
                        phase("control.tap") { element.tap() }
                        return
                    }
                    if center.y < visible.minY { webView.swipeDown() } else { webView.swipeUp() }
                }
                XCTFail("Element is inaccessible after scrolling: \(element)", file: file, line: line)
            } catch {
                XCTFail("Could not inspect the fixture screen: \(error)", file: file, line: line)
            }
        }
    }

    func testSettingsValidationAndRecoveryThroughNativeRefresh() throws {
        tap(button("settings-toggle", "Settings"))
        let clientID = webView.textFields.matching(NSPredicate(format: "identifier == %@ OR label == %@", "spotify-client-id", "Spotify client ID")).firstMatch
        reveal(clientID)
        phase("settings.focus") { clientID.tap() }
        phase("settings.typeText") { clientID.typeText("invalid") }
        waitUntil("The keyboard must enter the validation input.") { clientID.value as? String == "invalid" }
        tap(button("", "Save connection settings"))
        let error = text("Enter the 32-character client ID from your Spotify developer app.")
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        tap(button("reconnect-button", "Refresh connection"))
        XCTAssertTrue(text("Player connection refreshed.").waitForExistence(timeout: 10))
        waitUntil("Refresh must clear the recoverable validation error") { !error.exists }
        tap(button("settings-close", "Close settings"))
        waitUntil("Settings must close") { !clientID.exists }
        playFixture()
        tap(button("play-button", "Pause"))
        waitForPlaybackAction("Play", "Pause must be confirmed")
    }

    func testNativeLocalTransportAndLibraryPersistAcrossColdLaunch() throws {
        playFixture()
        tap(button("next-button", "Next track"))
        XCTAssertTrue(text("Now playing: UI Test Two").waitForExistence(timeout: 10), "Next must update the selected native track, not merely leave a library row visible.")
        tap(button("play-button", "Pause"))
        waitForPlaybackAction("Play", "Pause must change the available action")
        tap(button("", "Remove UI Test One"))
        waitUntil("Removed audio must leave the library") { !self.button("", "Play UI Test One").exists }
        phase("relaunch.terminate") { app.terminate() }
        launch()
        openFiles()
        XCTAssertTrue(button("", "Play UI Test Two").waitForExistence(timeout: 10))
        XCTAssertFalse(button("", "Play UI Test One").exists, "Relaunch must read persisted deletion, not reseed fixtures.")
        tap(button("", "Play UI Test Two"))
        waitForPlaybackAction("Pause", "Persisted audio must still play through AVPlayer")
    }

    func testFailedSpotifyHandoffCanRecoverToLocalPlayback() throws {
        playFixture()
        tap(webView.switches["Spotify"].firstMatch)
        let link = webView.textFields.matching(NSPredicate(format: "identifier == %@ OR label == %@", "spotify-link", "Add a Spotify track, album or playlist")).firstMatch
        reveal(link)
        phase("spotify.focus") { link.tap() }
        let spotifyURL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        phase("spotify.typeText") { link.typeText(spotifyURL) }
        // WebKit's accessibility value can trail synthesized keyboard input.
        // Wait for the exact value before saving; never retype or submit a prefix.
        waitUntil("The keyboard must enter the complete Spotify link before saving.") {
            link.value as? String == spotifyURL
        }
        tap(button("", "Save Spotify link"))
        let saved = webView.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Play Spotify track")).firstMatch
        tap(saved)
        XCTAssertTrue(text("Add the public client ID from your Spotify developer app in Settings.").waitForExistence(timeout: 15))
        XCTAssertTrue(button("play-button", "Play").exists)
        playFixture()
        waitUntil("A later local action must clear the previous provider error") {
            !self.text("Add the public client ID from your Spotify developer app in Settings.").exists
        }
    }

    func testFilesLibraryAccessibilityAudit() throws {
        openFiles()
        waitUntil("The Files audit must inspect the selected source and its imported library") {
            self.webView.switches["Files"].firstMatch.value as? String == "1" &&
                self.button("import-button", "Import from Files").exists &&
                self.button("", "Play UI Test One").exists &&
                self.button("", "Play UI Test Two").exists
        }
        // Retain the actual pre-audit screen, including passing runs. When an
        // audit cannot resolve its issue element, this still preserves the
        // contemporaneous semantic names, roles and bounds for comparison.
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "Files library before accessibility audit"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        // iPadOS 17+ audit APIs: detect unlabeled/non-discoverable elements.
        // The issue handler preserves findings. This is a baseline audit, not a
        // claim of a complete VoiceOver, contrast or Dynamic Type assessment.
        try auditAccessibility()
    }

    func testSettingsAccessibilityAudit() throws {
        tap(button("settings-toggle", "Settings"))
        tap(button("reconnect-button", "Refresh connection"))
        try auditAccessibility()
    }

    func testAccessibleControlsRemainUsableAfterRotation() throws {
        playFixture()
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            phase("rotation.change") { XCUIDevice.shared.orientation = orientation }
            waitUntil("The app and WebView must adopt the requested \(orientation == .portrait ? "portrait" : "landscape") layout") {
                guard let snapshot = try? self.app.snapshot(),
                      let web = self.firstSnapshot(in: snapshot, matching: { $0.elementType == .webView }) else { return false }
                return [snapshot.frame, web.frame].allSatisfy { bounds in
                    orientation == .portrait ? bounds.height > bounds.width : bounds.width > bounds.height
                }
            }
            let settings = button("settings-toggle", "Settings")
            let settingsSnapshot = try XCTUnwrap(reveal(settings))
            let bounds = app.frame
            let settingsFrame = settingsSnapshot.frame
            XCTAssertGreaterThanOrEqual(settingsFrame.width, 44)
            XCTAssertGreaterThanOrEqual(settingsFrame.height, 44)
            XCTAssertGreaterThanOrEqual(settingsFrame.minX, bounds.minX)
            XCTAssertLessThanOrEqual(settingsFrame.maxX, bounds.maxX)
            let pause = button("play-button", "Pause")
            let pauseSnapshot = try XCTUnwrap(reveal(pause))
            XCTAssertEqual(pauseSnapshot.label, "Pause", "Native playback must remain active across rotation.")
            let pauseFrame = pauseSnapshot.frame
            XCTAssertGreaterThanOrEqual(pauseFrame.width, 44)
            XCTAssertGreaterThanOrEqual(pauseFrame.height, 44)
            XCTAssertTrue(bounds.intersects(pauseFrame))
        }
        tap(button("play-button", "Pause"))
        waitForPlaybackAction("Play", "Pause must be confirmed after both rotations")
    }

    func testVoiceOverCanDiscoverAndLeaveSettingsOnCurrentPlatform() throws {
        // The compiler condition keeps the older-SDK compatibility lane valid;
        // the runtime condition protects devices older than iPadOS 27.
        #if compiler(>=6.4)
        guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver automation requires iPadOS 27.") }
        let settings = button("settings-toggle", "Settings")
        reveal(settings)
        XCTAssertFalse(button("settings-close", "Close settings").exists)
        let voiceOver = XCUIDevice.shared.voiceOverService
        var trace: [String] = []
        @MainActor
        func record(_ value: String) {
            if trace.count < 50 { trace.append(String(value.prefix(240))) }
            // Phase-only console breadcrumbs identify a stalled service call.
            // Speech stays in a bounded test attachment, never app diagnostics.
            if value.hasPrefix("phase:") { print("UI_VOICEOVER \(value)") }
        }
        @MainActor
        func attachTrace(named name: String) {
            let attachment = XCTAttachment(string: trace.joined(separator: "\n"))
            attachment.name = name
            attachment.lifetime = .keepAlways
            self.add(attachment)
        }
        // Keep this work in XCTest's synchronous teardown hook: Swift defer
        // cannot guarantee cleanup across fail-fast Objective-C interruptions.
        // Save a trace even when enable throws before cleanup can be installed.
        voiceOverTeardown = {
            attachTrace(named: "VoiceOver navigation trace")
            return nil
        }
        record("enabled before: \(voiceOver.isEnabled)")
        record("phase:enable")
        try phase("voiceover.enable") { try voiceOver.enable() }
        voiceOverTeardown = {
            record("phase:disable")
            // Preserve the journey even if the service never returns from
            // disable. No app or accessibility hierarchy query is needed.
            attachTrace(named: "VoiceOver trace before cleanup")
            var cleanupFailure: String?
            do {
                try self.phase("voiceover.disable") { try voiceOver.disable() }
                if voiceOver.isEnabled {
                    record("phase:still-enabled")
                    cleanupFailure = "VoiceOver remained enabled after the service reported successful cleanup."
                } else {
                    record("phase:disabled")
                }
            } catch {
                record("phase:disable-failed")
                record("cleanup error: \(error)")
                cleanupFailure = "VoiceOver cleanup failed: \(error)"
            }
            attachTrace(named: "VoiceOver navigation trace")
            // Report a Swift cleanup error only after the app and orientation
            // cleanup have had a chance to finish in tearDownWithError.
            return cleanupFailure
        }
        record("enabled after: \(voiceOver.isEnabled)")
        record("service: \(voiceOver.debugDescription)")
        XCTAssertTrue(voiceOver.isEnabled, "VoiceOver must be enabled before touch exploration.")
        // Enabling VoiceOver can move focus or scroll the page. Read the target
        // after that change; enabled state alone does not prove service readiness.
        let settingsFrame = phase("voiceover.targetFrame") { settings.frame }
        let appFrame = phase("voiceover.appFrame") { app.frame }
        record("settings frame after enable: \(settingsFrame); app frame: \(appFrame)")
        XCTAssertTrue(appFrame.contains(settingsFrame), "Settings must still be onscreen after enabling VoiceOver.")
        let settingsCenter = app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: settingsFrame.midX - appFrame.minX, dy: settingsFrame.midY - appFrame.minY))
        // VoiceOver touch exploration selects an item with one tap; activation
        // requires a double tap. Send one physical coordinate event to establish
        // a known focus before testing sequential navigation. This avoids
        // assuming that enabling VoiceOver produced an initial spoken element.
        // https://support.apple.com/guide/ipad/ipad58ced58d/ipados
        record("phase:touch-settings")
        phase("voiceover.touchSettings") { settingsCenter.tap() }
        let opened = phase("voiceover.activationCheck") { button("settings-close", "Close settings").exists }
        record("settings opened after one touch: \(opened)")
        XCTAssertFalse(opened, "One VoiceOver touch must select Settings without activating it.")
        record("phase:current-speech")
        let speech = try phase("voiceover.currentSpeech") { try voiceOver.currentSpeech().utterance }
        record("speech: " + speech)
        func isSettingsButton(_ utterance: String) -> Bool {
            let normalized = utterance.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized.hasPrefix("settings") && normalized.contains("button")
        }
        XCTAssertTrue(isSettingsButton(speech), "Touch exploration must select Settings and announce it as a button, rather than incidental help text.")
        record("phase:leave-settings")
        let next = try phase("voiceover.moveForward") { try voiceOver.moveForward().utterance }
        record("speech: " + next)
        XCTAssertFalse(next.isEmpty)
        XCTAssertNotEqual(next, speech, "VoiceOver focus must be able to leave the Settings control.")
        record("phase:return-to-settings")
        let previous = try phase("voiceover.moveBackward") { try voiceOver.moveBackward().utterance }
        record("speech: " + previous)
        XCTAssertTrue(isSettingsButton(previous), "Backward navigation must return to the selected Settings button.")
        #else
        throw XCTSkip("VoiceOver automation is compiled by Xcode 27 and later.")
        #endif
    }
}
