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
    // The app owns one WKWebView. Start at its first native wrapper instead of
    // repeatedly searching every nested/auxiliary WebView accessibility node.
    private var webView: XCUIElement { app.webViews.firstMatch }

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Real keyboard, accessibility and AVPlayer interactions took 116s on
        // the compatibility runner. Keep a bounded allowance for VM variance.
        executionTimeAllowance = 180
        fixtureID = UUID().uuidString
        app = XCUIApplication()
        app.launchArguments = ["--ui-testing", fixtureID, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        XCUIDevice.shared.orientation = .portrait
        launch()
    }

    override func tearDownWithError() throws {
        // hasSucceeded remains false until teardown itself completes.
        if let app, (testRun?.totalFailureCount ?? 0) > 0 {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Failed app screen"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Failed accessibility hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        app?.terminate()
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch() {
        let started = Date()
        let startUptime = ProcessInfo.processInfo.systemUptime
        launchOrdinal += 1
        app.launch()
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
        let filesReady = files.waitForExistence(timeout: readinessWaitLimit)
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
        XCTAssertTrue(expected.waitForExistence(timeout: 10), message, file: file, line: line)
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
        XCTAssertTrue(element.waitForExistence(timeout: 10), "Element is missing: \(element)", file: file, line: line)
        // A scroll moves content within this viewport; it does not resize the
        // viewport. Read its bounds once, after any rotation/keyboard dismissal.
        let visible = webView.frame.intersection(app.frame).insetBy(dx: 0, dy: 25)
        for _ in 0..<8 {
            let snapshot: XCUIElementSnapshot
            do {
                snapshot = try element.snapshot()
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

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        // WKWebView can report a DOM control as hittable behind the keyboard.
        // Dismiss the actual iPad keyboard before tapping a non-text control.
        let hideKeyboard = app.keyboards.buttons["Hide keyboard"].firstMatch
        if keyboardIsVisible {
            XCTAssertTrue(hideKeyboard.waitForExistence(timeout: 5), file: file, line: line)
            hideKeyboard.tap()
            waitUntil("The keyboard must close before tapping content") { !self.keyboardIsVisible }
        }
        reveal(element, file: file, line: line)
        element.tap()
    }

    private var keyboardIsVisible: Bool {
        // Keep the common no-keyboard path to one cheap existence query.
        guard app.keyboards.firstMatch.exists else { return false }
        do {
            // The keyboard can disappear between separate exists/frame reads.
            // Inspect a single app snapshot after the check so disappearance is
            // normal, never a failed lookup of the now-absent keyboard query.
            let snapshot = try app.snapshot()
            return firstSnapshot(in: snapshot) { element in
                guard element.elementType == .keyboard else { return false }
                // iPadOS 27 retains a zero-height keyboard and offscreen preview
                // buttons after dismissal. Existence alone does not mean open.
                let visible = element.frame.intersection(snapshot.frame)
                return !visible.isNull && visible.width > 1 && visible.height > 1
            } != nil
        } catch {
            XCTFail("Could not inspect the application's keyboard state: \(error)")
            return true // A failed snapshot must never authorize a content tap.
        }
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, message)
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
        tap(button("", "Play UI Test One"))
        waitForPlaybackAction("Pause", "The real AVPlayer must confirm playing")
        XCTAssertTrue(text("Now playing: UI Test One").waitForExistence(timeout: 10))
    }

    func testSettingsValidationAndRecoveryThroughNativeRefresh() throws {
        tap(button("settings-toggle", "Settings"))
        let clientID = webView.textFields.matching(NSPredicate(format: "identifier == %@ OR label == %@", "spotify-client-id", "Spotify client ID")).firstMatch
        reveal(clientID)
        clientID.tap()
        clientID.typeText("invalid")
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
        app.terminate()
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
        link.tap()
        let spotifyURL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        link.typeText(spotifyURL)
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
            XCUIDevice.shared.orientation = orientation
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
        let settingsFrame = settings.frame
        let appFrame = app.frame
        let settingsCenter = app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: settingsFrame.midX - appFrame.minX, dy: settingsFrame.midY - appFrame.minY))
        let voiceOver = XCUIDevice.shared.voiceOverService
        var trace: [String] = []
        func record(_ value: String) {
            if trace.count < 50 { trace.append(String(value.prefix(240))) }
            // Phase-only console breadcrumbs identify a stalled service call.
            // Speech stays in a bounded test attachment, never app diagnostics.
            if value.hasPrefix("phase:") { print("UI_VOICEOVER \(value)") }
        }
        defer {
            let attachment = XCTAttachment(string: trace.joined(separator: "\n"))
            attachment.name = "VoiceOver navigation trace"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        record("phase:enable")
        try voiceOver.enable()
        defer {
            record("phase:disable")
            do {
                try voiceOver.disable()
                if voiceOver.isEnabled {
                    record("phase:still-enabled")
                    XCTFail("VoiceOver remained enabled after the service reported successful cleanup.")
                } else {
                    record("phase:disabled")
                }
            } catch {
                record("phase:disable-failed")
                record("cleanup error: \(error)")
                XCTFail("VoiceOver cleanup failed: \(error)")
            }
        }
        // VoiceOver touch exploration selects an item with one tap; activation
        // requires a double tap. Send one physical coordinate event to establish
        // a known focus before testing sequential navigation. This avoids
        // assuming that enabling VoiceOver produced an initial spoken element.
        // https://support.apple.com/guide/ipad/ipad58ced58d/ipados
        record("phase:touch-settings")
        settingsCenter.tap()
        record("phase:current-speech")
        let speech = try voiceOver.currentSpeech().utterance
        record("speech: " + speech)
        func isSettingsButton(_ utterance: String) -> Bool {
            let normalized = utterance.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized.hasPrefix("settings") && normalized.contains("button")
        }
        XCTAssertTrue(isSettingsButton(speech), "Touch exploration must select Settings and announce it as a button, rather than incidental help text.")
        XCTAssertFalse(button("settings-close", "Close settings").exists, "One VoiceOver touch must select Settings without activating it.")
        record("phase:leave-settings")
        let next = try voiceOver.moveForward().utterance
        record("speech: " + next)
        XCTAssertFalse(next.isEmpty)
        XCTAssertNotEqual(next, speech, "VoiceOver focus must be able to leave the Settings control.")
        record("phase:return-to-settings")
        let previous = try voiceOver.moveBackward().utterance
        record("speech: " + previous)
        XCTAssertTrue(isSettingsButton(previous), "Backward navigation must return to the selected Settings button.")
        #else
        throw XCTSkip("VoiceOver automation is compiled by Xcode 27 and later.")
        #endif
    }
}
