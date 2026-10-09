import XCTest
import UIKit

/// These tests launch the installed app and operate its WKWebView accessibility
/// tree. Only input files/storage are fixtures; Capacitor and AVPlayer are real.
/// Spotify authorization, Files providers and audible output remain device tests.
@MainActor
final class AppUITests: XCTestCase {
    private var app: XCUIApplication!
    private var fixtureID: String!

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
        app.launch()
        let ready = button("settings-toggle", "Settings").waitForExistence(timeout: 30)
        if !ready {
            let details = """
            Launch began: \(ISO8601DateFormatter().string(from: started))
            Elapsed seconds including app.launch(): \(Date().timeIntervalSince(started))
            App state: \(app.state.rawValue)
            App frame: \(app.frame)
            Window count: \(app.windows.count)
            WKWebView count: \(app.webViews.count)
            Orientation: \(XCUIDevice.shared.orientation.rawValue)
            Settings absent after the 30-second readiness deadline. See the failure screenshot/hierarchy and simulator startup log.
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

    private func button(_ identifier: String, _ label: String) -> XCUIElement {
        let predicate = identifier.isEmpty ? NSPredicate(format: "label == %@", label) :
            NSPredicate(format: "identifier == %@ OR label == %@", identifier, label)
        return app.webViews.buttons.matching(predicate).firstMatch
    }

    private func text(_ label: String) -> XCUIElement { app.webViews.staticTexts[label].firstMatch }

    private func reveal(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "Element is missing: \(element)", file: file, line: line)
        let webView = app.webViews.firstMatch
        for _ in 0..<8 {
            let visible = webView.frame.intersection(app.frame).insetBy(dx: 0, dy: 25)
            let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
            if element.isHittable && visible.contains(center) { return }
            if center.y < visible.minY { webView.swipeDown() } else { webView.swipeUp() }
        }
        XCTFail("Element is inaccessible after scrolling: \(element)", file: file, line: line)
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
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return false }
        // iPadOS 27 retains a zero-height keyboard and its offscreen preview
        // buttons after dismissal. Existence alone does not mean it is open.
        let visible = keyboard.frame.intersection(app.frame)
        return !visible.isNull && visible.width > 1 && visible.height > 1
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, message)
    }

    private func auditAccessibility() throws {
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
    private func openFiles() { tap(app.webViews.switches["Files"].firstMatch) }

    private func playFixture() {
        openFiles()
        tap(button("", "Play UI Test One"))
        waitUntil("The real AVPlayer must confirm playing") { self.button("play-button", "Pause").label == "Pause" }
        XCTAssertTrue(text("Now playing: UI Test One").waitForExistence(timeout: 10))
    }

    func testSettingsValidationAndRecoveryThroughNativeRefresh() throws {
        tap(button("settings-toggle", "Settings"))
        let clientID = app.webViews.textFields.matching(NSPredicate(format: "identifier == %@ OR label == %@", "spotify-client-id", "Spotify client ID")).firstMatch
        reveal(clientID)
        clientID.tap()
        clientID.typeText("invalid")
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
        waitUntil("Pause must be confirmed") { self.button("play-button", "Play").label == "Play" }
    }

    func testNativeLocalTransportAndLibraryPersistAcrossColdLaunch() throws {
        playFixture()
        tap(button("next-button", "Next track"))
        XCTAssertTrue(text("Now playing: UI Test Two").waitForExistence(timeout: 10), "Next must update the selected native track, not merely leave a library row visible.")
        tap(button("play-button", "Pause"))
        waitUntil("Pause must change the available action") { self.button("play-button", "Play").label == "Play" }
        tap(button("", "Remove UI Test One"))
        waitUntil("Removed audio must leave the library") { !self.button("", "Play UI Test One").exists }
        app.terminate()
        launch()
        openFiles()
        XCTAssertTrue(button("", "Play UI Test Two").waitForExistence(timeout: 10))
        XCTAssertFalse(button("", "Play UI Test One").exists, "Relaunch must read persisted deletion, not reseed fixtures.")
        tap(button("", "Play UI Test Two"))
        waitUntil("Persisted audio must still play through AVPlayer") { self.button("play-button", "Pause").label == "Pause" }
    }

    func testFailedSpotifyHandoffCanRecoverToLocalPlayback() throws {
        playFixture()
        tap(app.webViews.switches["Spotify"].firstMatch)
        let link = app.webViews.textFields.matching(NSPredicate(format: "identifier == %@ OR label == %@", "spotify-link", "Add a Spotify track, album or playlist")).firstMatch
        reveal(link)
        link.tap()
        link.typeText("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
        tap(button("", "Save Spotify link"))
        let saved = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Play Spotify track")).firstMatch
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
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let settings = button("settings-toggle", "Settings")
            reveal(settings)
            let bounds = app.frame
            XCTAssertGreaterThanOrEqual(settings.frame.width, 44)
            XCTAssertGreaterThanOrEqual(settings.frame.height, 44)
            XCTAssertGreaterThanOrEqual(settings.frame.minX, bounds.minX)
            XCTAssertLessThanOrEqual(settings.frame.maxX, bounds.maxX)
            playFixture()
            let pause = button("play-button", "Pause")
            reveal(pause)
            XCTAssertGreaterThanOrEqual(pause.frame.width, 44)
            XCTAssertGreaterThanOrEqual(pause.frame.height, 44)
            XCTAssertTrue(bounds.intersects(pause.frame))
            tap(pause)
        }
    }

    func testVoiceOverCanDiscoverAndLeaveSettingsOnCurrentPlatform() throws {
        // The compiler condition keeps the older-SDK compatibility lane valid;
        // the runtime condition protects devices older than iPadOS 27.
        #if compiler(>=6.4)
        guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver automation requires iPadOS 27.") }
        let settings = button("settings-toggle", "Settings")
        reveal(settings)
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
            try? voiceOver.disable()
            record("phase:disabled")
        }
        record("phase:current-speech")
        var speech = try voiceOver.currentSpeech().utterance
        record("speech: " + speech)
        func isSettingsButton(_ utterance: String) -> Bool {
            let normalized = utterance.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized.hasPrefix("settings") && normalized.contains("button")
        }
        // Webamp receives DOM focus at startup. The real WK accessibility tree
        // places Settings before that focused subtree, so navigate backward to
        // the preceding header control rather than through the entire player.
        for index in 0..<20 {
            if isSettingsButton(speech) { break }
            record("phase:move-backward-\(index)")
            speech = try voiceOver.moveBackward().utterance
            record("speech: " + speech)
        }
        XCTAssertTrue(isSettingsButton(speech), "VoiceOver must reach Settings and announce it as a button, rather than incidental help text.")
        record("phase:leave-settings")
        let next = try voiceOver.moveForward().utterance
        record("speech: " + next)
        XCTAssertFalse(next.isEmpty)
        XCTAssertNotEqual(next, speech, "VoiceOver focus must be able to leave the Settings control.")
        #else
        throw XCTSkip("VoiceOver automation is compiled by Xcode 27 and later.")
        #endif
    }
}
