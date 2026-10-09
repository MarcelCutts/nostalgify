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
        fixtureID = UUID().uuidString
        app = XCUIApplication()
        app.launchArguments = ["--ui-testing", fixtureID, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        XCUIDevice.shared.orientation = .portrait
        launch()
    }

    override func tearDownWithError() throws {
        if let app, testRun?.hasSucceeded == false {
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
        app.launch()
        XCTAssertTrue(button("settings-toggle", "Settings").waitForExistence(timeout: 30), "The real bundled UI must become ready.")
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
        for _ in 0..<6 where !element.isHittable { app.webViews.firstMatch.swipeUp() }
        for _ in 0..<8 where !element.isHittable { app.webViews.firstMatch.swipeDown() }
        XCTAssertTrue(element.isHittable, "Element is inaccessible after scrolling: \(element)", file: file, line: line)
    }

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        reveal(element, file: file, line: line)
        element.tap()
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, message)
    }

    private func openFiles() { tap(button("local-source", "Files")) }

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
        tap(button("spotify-source", "Spotify"))
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

    func testAccessibleControlsRemainUsableAfterRotation() throws {
        openFiles()
        // iPadOS 17+ audit APIs: detect unlabeled/non-discoverable elements.
        // No issue handler suppresses findings. This is a baseline audit, not a
        // claim of a complete VoiceOver, contrast or Dynamic Type assessment.
        try app.performAccessibilityAudit(for: [.elementDetection, .sufficientElementDescription])
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
        tap(button("settings-toggle", "Settings"))
        tap(button("reconnect-button", "Refresh connection"))
        try app.performAccessibilityAudit(for: [.elementDetection, .sufficientElementDescription])
    }

    func testVoiceOverCanDiscoverAndLeaveSettingsOnCurrentPlatform() throws {
        // The compiler condition keeps the older-SDK compatibility lane valid;
        // the runtime condition protects devices older than iPadOS 27.
        #if compiler(>=6.4)
        guard #available(iOS 27.0, *) else { throw XCTSkip("VoiceOver automation requires iPadOS 27.") }
        let voiceOver = XCUIDevice.shared.voiceOverService
        try voiceOver.enable()
        defer { try? voiceOver.disable() }
        var speech = try voiceOver.currentSpeech().utterance
        for _ in 0..<20 {
            if speech.localizedCaseInsensitiveContains("settings") { break }
            speech = try voiceOver.moveForward().utterance
        }
        XCTAssertTrue(speech.localizedCaseInsensitiveContains("settings"), "Settings must be reachable through VoiceOver navigation.")
        XCTAssertTrue(speech.localizedCaseInsensitiveContains("button"), "VoiceOver must announce Settings as an actionable button.")
        let next = try voiceOver.moveForward().utterance
        XCTAssertFalse(next.isEmpty)
        XCTAssertNotEqual(next, speech, "VoiceOver focus must be able to leave the Settings control.")
        #else
        throw XCTSkip("VoiceOver automation is compiled by Xcode 27 and later.")
        #endif
    }
}
