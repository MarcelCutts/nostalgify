import XCTest
import SpotifyiOS
@testable import App

final class SpotifyInputTests: XCTestCase {
    private let identifier = "4uLU6hMCjMI75M1A2tKUQC"

    func testPlaybackLinksNormalizeOnlySupportedSpotifyResources() throws {
        for kind in ["track", "album", "artist", "playlist", "episode"] {
            let uri = "spotify:\(kind):\(identifier)"
            XCTAssertEqual(try SpotifyInput.playbackURI(uri), uri)
            XCTAssertEqual(try SpotifyInput.playbackURI("https://open.spotify.com/\(kind)/\(identifier)?si=share"), uri)
            XCTAssertEqual(try SpotifyInput.playbackURI(" https://open.spotify.com/intl-en/\(kind)/\(identifier) \n"), uri)
        }
    }

    func testPlaybackLinksRejectUnsafeAndUnsupportedTargets() {
        let invalid = [
            "spotify:collection:tracks", "spotify:user:someone:collection", "spotify:show:\(identifier)",
            "spotify:track:short", "spotify:track:\(identifier)?extra=1",
            "http://open.spotify.com/track/\(identifier)",
            "https://open.spotify.com.evil.example/track/\(identifier)",
            "https://open.spotify.com@evil.example/track/\(identifier)",
            "https://user@open.spotify.com/track/\(identifier)",
            "https://open.spotify.com:443/track/\(identifier)",
            "https://open.spotify.com/track/\(identifier)#token",
            "https://open.spotify.com/track/\(identifier)%0A",
            "https://open.spotify.com/track/\(identifier)%0D",
            "https://open.spotify.com/track/\(identifier)/extra",
            "https://spotify.link/example", "javascript:alert(1)",
            String(repeating: "x", count: 2_049)
        ]
        for input in invalid {
            XCTAssertThrowsError(try SpotifyInput.playbackURI(input), "Accepted an unsupported Spotify target")
        }
    }

    func testConfigurationAcceptsOnlyPublicClientIDShapeAndRegisteredCallback() throws {
        let publicID = String(repeating: "a", count: 32)
        let result = try SpotifyInput.configuration(clientID: " \(publicID) ", redirectURI: SpotifyInput.redirectURI)
        XCTAssertEqual(result.0, publicID)
        XCTAssertEqual(result.1.absoluteString, SpotifyInput.redirectURI)
        XCTAssertThrowsError(try SpotifyInput.configuration(clientID: "missing", redirectURI: SpotifyInput.redirectURI))
        XCTAssertThrowsError(try SpotifyInput.configuration(clientID: publicID, redirectURI: "other-app://callback"))
        XCTAssertThrowsError(try SpotifyInput.configuration(clientID: publicID, redirectURI: SpotifyInput.redirectURI + "/"))
    }

    func testAuthorizationCallbackRequiresExactRegisteredDestination() throws {
        for suffix in ["", "?access_token=fake", "#access_token=fake", "/", "/?spotify_version=9#access_token=fake"] {
            XCTAssertTrue(SpotifyInput.isAuthorizationCallback(try XCTUnwrap(URL(string: SpotifyInput.redirectURI + suffix))))
        }
        for target in [
            "https://spotify-login-callback", "nostalgify://other-host",
            "nostalgify://spotify-login-callback.evil.example",
            "nostalgify://user@spotify-login-callback", "nostalgify://spotify-login-callback:123",
            "nostalgify://spotify-login-callback/extra", "nostalgify://spotify-login-callback//",
            "nostalgify://user:password@spotify-login-callback/"
        ] {
            XCTAssertFalse(SpotifyInput.isAuthorizationCallback(try XCTUnwrap(URL(string: target))))
        }
    }

    func testSeekConvertsSecondsAndClampsToTrackDuration() throws {
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 12.345), duration: 180), 12_345)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 200), duration: 180.5), 180_500)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 0), duration: 180), 0)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: -2), duration: 180), 0)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(-Double.greatestFiniteMagnitude, duration: 180), 0)
    }

    func testSeekRejectsBooleansNonFiniteValuesAndIntegerOverflow() {
        let invalid: [Any] = [true, "12", NSNumber(value: -Double.infinity), NSNumber(value: Double.nan), NSNumber(value: Double.infinity)]
        for input in invalid {
            XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(input, duration: 180))
        }
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(nil, duration: 180))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(1, duration: 0))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(1, duration: .infinity))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(Double.greatestFiniteMagnitude, duration: Double.greatestFiniteMagnitude))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(Double(Int.max), duration: Double(Int.max)))
    }

    @MainActor
    func testPlaybackWaitsForConnectionEventBeforeSendingCommand() async throws {
        let waiter = SpotifyConnectionWaiter()
        let started = expectation(description: "Reconnect requested")
        var played = false
        let playback = Task { @MainActor in
            try await waiter.wait { started.fulfill() }
            played = true
        }
        await fulfillment(of: [started], timeout: 1)
        XCTAssertFalse(played, "A source switch must not send play before App Remote connects")
        waiter.complete(.success(()))
        try await playback.value
        XCTAssertTrue(played)
        waiter.complete(.success(())) // A duplicate delegate event must not resume twice.
    }

    @MainActor
    func testDisconnectRejectsWaitingPlaybackWithoutSendingCommand() async throws {
        let waiter = SpotifyConnectionWaiter()
        let started = expectation(description: "Reconnect requested")
        var played = false
        let playback = Task { @MainActor in
            try await waiter.wait { started.fulfill() }
            played = true
        }
        await fulfillment(of: [started], timeout: 1)
        waiter.complete(.failure(NativeFailure(code: "spotify_disconnected", message: "Reconnect Spotify.")))
        do {
            try await playback.value
            XCTFail("A disconnected source must fail waiting playback")
        } catch let error as NativeFailure {
            XCTAssertEqual(error.code, "spotify_disconnected")
        }
        waiter.complete(.success(()))
        XCTAssertFalse(played)
    }

    @MainActor
    func testCancelledPlaybackDoesNotRunWhenConnectionArrives() async throws {
        let waiter = SpotifyConnectionWaiter()
        let started = expectation(description: "Reconnect requested")
        var played = false
        let playback = Task { @MainActor in
            try await waiter.wait { started.fulfill() }
            played = true
        }
        await fulfillment(of: [started], timeout: 1)
        playback.cancel()
        // Deliberately race success with the cancellation handler's main-actor hop.
        waiter.complete(.success(()))
        do {
            try await playback.value
            XCTFail("Cancellation must prevent the following playback command")
        } catch is CancellationError { }
        XCTAssertFalse(played)
    }

    @MainActor
    func testConnectionWaitTimesOutWhenSpotifyNeverAnswers() async throws {
        let waiter = SpotifyConnectionWaiter()
        do {
            try await waiter.wait(timeoutNanoseconds: 1_000_000) { }
            XCTFail("A silent SDK must not hold the command queue indefinitely")
        } catch let error as NativeFailure {
            XCTAssertEqual(error.code, "spotify_connection_timeout")
        }
        waiter.complete(.success(()))
    }

    @MainActor
    func testUnconfiguredPlaybackRequestsExplicitSetup() async throws {
        let domain = "SpotifyInputTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let service = SpotifyRemoteService(diagnostics: NativeDiagnostics(), defaults: defaults)
        do {
            try await service.prepareForPlayback()
            XCTFail("Preparing playback must not begin implicit authorization")
        } catch let error as NativeFailure {
            XCTAssertEqual(error.code, "spotify_configuration")
        }
        XCTAssertEqual(service.snapshot()["authorizing"] as? Bool, false)
    }
}

final class SpotifyAuthorizationIntentTests: XCTestCase {
    func testPendingIntentSurvivesColdStartAndUIWaitButExpires() throws {
        let domain = "SpotifyAuthorizationIntentTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        var now = Date(timeIntervalSince1970: 1000)
        let first = SpotifyAuthorizationIntent(defaults: defaults, now: { now })
        XCTAssertFalse(first.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
        first.begin(clientID: "client", redirectURI: SpotifyInput.redirectURI)
        now += 121
        let restored = SpotifyAuthorizationIntent(defaults: defaults, now: { now })
        XCTAssertTrue(restored.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
        now = Date(timeIntervalSince1970: 1000 + SpotifyAuthorizationIntent.lifetime)
        XCTAssertFalse(restored.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
        now -= 1
        XCTAssertFalse(restored.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI), "Expired intents are removed, not revived by a clock change")
    }

    func testCancellationAndConfigurationChangesInvalidatePersistedIntent() throws {
        let domain = "SpotifyAuthorizationIntentTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let intent = SpotifyAuthorizationIntent(defaults: defaults)
        intent.begin(clientID: "client", redirectURI: SpotifyInput.redirectURI)
        intent.invalidate()
        XCTAssertFalse(SpotifyAuthorizationIntent(defaults: defaults).isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
        intent.begin(clientID: "client", redirectURI: SpotifyInput.redirectURI)
        XCTAssertFalse(intent.isPending(clientID: "other-client", redirectURI: SpotifyInput.redirectURI))
        XCTAssertFalse(intent.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
        intent.begin(clientID: "client", redirectURI: SpotifyInput.redirectURI)
        XCTAssertFalse(intent.isPending(clientID: "client", redirectURI: "other://callback"))
    }

    func testClockRollbackDoesNotExtendPendingIntent() throws {
        let domain = "SpotifyAuthorizationIntentTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        var now = Date(timeIntervalSince1970: 1000)
        let intent = SpotifyAuthorizationIntent(defaults: defaults, now: { now })
        intent.begin(clientID: "client", redirectURI: SpotifyInput.redirectURI)
        now -= 1
        XCTAssertFalse(intent.isPending(clientID: "client", redirectURI: SpotifyInput.redirectURI))
    }
}

final class SpotifyRecoveryTests: XCTestCase {
    @MainActor
    func testRetiredPlayerDelegateCannotChangeReplacementConnection() async throws {
        for replaceRemote in [false, true] {
            let f = try SpotifyRecoveryFixture()
            defer { f.cleanup() }
            f.establish(paused: true, position: 10_000)
            let old = f.remote
            // A queued SDK callback can retain the delegate after its weak API
            // property is cleared. Keep that exact receiver alive through reconnect.
            let retiredDelegate = try XCTUnwrap(old.api.delegate)
            if replaceRemote {
                old.disconnectStaysConnected = true
                try f.service.connect()
                XCTAssertFalse(f.remote === old)
            } else {
                f.service.suspend()
                f.service.resume()
                XCTAssertTrue(f.remote === old)
            }
            f.establish(paused: false, position: 80_000, trackURI: "spotify:track:current")
            retiredDelegate.playerStateDidChange(SpotifyTestState(paused: true, position: 10_000))
            let snapshot = f.service.snapshot()
            XCTAssertEqual(snapshot["state"] as? String, "playing")
            XCTAssertEqual((snapshot["track"] as? [String: Any])?["id"] as? String, "spotify:track:current")
            XCTAssertGreaterThan(snapshot["position"] as? Double ?? 0, 79)
            f.service.disconnect()
            await assertPauseUnconfirmed(f.service)
        }
    }

    @MainActor
    func testExternalPlaybackAfterBackgroundRequiresFreshPause() async throws {
        for history in ["observed", "handoff", "logout", "configuration"] {
            let f = try SpotifyRecoveryFixture()
            defer { f.cleanup() }
            f.establish(paused: true)
            if history != "observed" { try await f.service.pauseBeforeProviderSwitch() }
            if history == "logout" { try f.service.logout() }
            if history == "configuration" {
                try f.service.configure(clientId: String(repeating: "b", count: 32), redirectURI: SpotifyInput.redirectURI)
            }
            f.service.suspend() // An ordinary app lifecycle event, even after a handoff.
            // Spotify resumes externally while no App Remote state can be observed.
            f.remote.api.state = SpotifyTestState(paused: false, position: 31_000)
            f.service.resume()
            XCTAssertFalse(f.remote.isConnected)
            await assertPauseUnconfirmed(f.service)
            XCTAssertFalse(f.remote.api.state.isPaused)
        }
    }

    @MainActor
    func testBackgroundWithoutSpotifyUseDoesNotBlockFiles() async throws {
        let f = try SpotifyRecoveryFixture(token: nil)
        defer { f.cleanup() }
        f.service.suspend()
        f.service.resume()
        try await f.service.pauseBeforeProviderSwitch()
        let domain = "SpotifyUnusedTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let unconfigured = SpotifyRemoteService(diagnostics: NativeDiagnostics(), defaults: defaults)
        unconfigured.suspend()
        unconfigured.resume()
        try await unconfigured.pauseBeforeProviderSwitch()
    }

    @MainActor
    func testBackgroundAfterPauseReplyCannotCompletePendingHandoff() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: false)
        f.remote.api.delayState = true
        let read = expectation(description: "Pause confirmation requested")
        f.remote.api.onStateRead = { read.fulfill() }
        let pause = Task { @MainActor in try await f.service.pauseBeforeProviderSwitch() }
        await fulfillment(of: [read], timeout: 1)
        f.remote.api.completeState(SpotifyTestState(paused: true, position: 30_000))
        // The reply has resumed the continuation, but the actor has not yet
        // returned to the handoff. A lifecycle event must invalidate that reply.
        f.service.suspend()
        do { try await pause.value; XCTFail("A lifecycle gap must invalidate an in-flight handoff") }
        catch let error as NativeFailure { XCTAssertEqual(error.code, "spotify_pause_unconfirmed") }
        f.service.resume()
        await assertPauseUnconfirmed(f.service)
    }

    @MainActor
    func testConfirmedProviderHandoffSurvivesFailedTransportRecovery() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: false)
        try await f.service.pauseBeforeProviderSwitch()
        XCTAssertFalse(f.remote.isConnected, "A successful handoff retires the transport with its confirmed pause")
        f.service.resume()
        f.service.appRemote(f.remote, didFailConnectionAttemptWithError: nil)
        // This is the same gate NativePlayback uses before enabling Files.
        try await f.service.pauseBeforeProviderSwitch()
    }

    @MainActor
    func testDelayedPausedReadCannotOverrideNewerPlayingEventDuringHandoff() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: false)
        f.remote.api.delayState = true
        let read = expectation(description: "Pause confirmation requested")
        f.remote.api.onStateRead = { read.fulfill() }
        let pause = Task { @MainActor in try await f.service.pauseBeforeProviderSwitch() }
        await fulfillment(of: [read], timeout: 1)
        try XCTUnwrap(f.remote.api.delegate).playerStateDidChange(SpotifyTestState(paused: false, position: 31_000))
        f.remote.api.completeState(SpotifyTestState(paused: true, position: 30_000))
        do { try await pause.value; XCTFail("A stale paused response must not approve starting Files") }
        catch let error as NativeFailure { XCTAssertEqual(error.code, "spotify_pause_unconfirmed") }
        f.service.disconnect()
        await assertPauseUnconfirmed(f.service)
    }

    @MainActor
    func testDisconnectAndLogoutDoNotClearUncertainActivePlayback() async throws {
        for logout in [false, true] {
            let f = try SpotifyRecoveryFixture()
            defer { f.cleanup() }
            f.establish(paused: false)
            if logout { try f.service.logout() } else { f.service.disconnect() }
            await assertPauseUnconfirmed(f.service)
        }
    }

    @MainActor
    func testFailedAppOpenDoesNotClearPriorPlaybackUncertainty() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: false)
        f.service.disconnect()
        try f.service.connect()
        f.remote.authorizationCompletions.last?(false)
        await settleCallbacks()
        await assertPauseUnconfirmed(f.service)
    }

    @MainActor
    func testConnectedReconnectUsesFreshTransportAndIgnoresOldDelegateEvents() throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: true)
        let old = f.remote
        old.disconnectStaysConnected = true // SDK disconnect need not be synchronous.
        try f.service.connect()
        XCTAssertFalse(f.remote === old)
        XCTAssertEqual(f.remote.connectCalls, 1)
        XCTAssertEqual(f.remote.authorizationCompletions.count, 0)
        XCTAssertEqual(f.service.snapshot()["connecting"] as? Bool, true)
        f.service.appRemote(old, didDisconnectWithError: NSError(domain: "test", code: 1))
        f.service.appRemote(old, didFailConnectionAttemptWithError: nil)
        XCTAssertEqual(f.service.snapshot()["connecting"] as? Bool, true)
    }

    @MainActor
    func testAbandonedAuthorizationCanRetryAndOldAvailabilityCannotCancelIt() async throws {
        let f = try SpotifyRecoveryFixture(token: nil)
        defer { f.cleanup() }
        try f.service.connect()
        let previous = f.remote
        try f.service.connect()
        XCTAssertEqual(f.remote.authorizationCompletions.count, 1)
        previous.authorizationCompletions.last?(false)
        await settleCallbacks()
        XCTAssertEqual(f.service.snapshot()["authorizing"] as? Bool, true)
        XCTAssertTrue(f.service.handleURL(f.callback))
        XCTAssertEqual(f.writes, ["callback-token"])
    }

    @MainActor
    func testExpectedCallbackSurvivesUIWaitTimeoutAndIsConsumedOnce() async throws {
        let f = try SpotifyRecoveryFixture(token: nil, authorizationTimeout: 1_000_000)
        defer { f.cleanup() }
        try f.service.connect()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(f.service.snapshot()["error"] as? String, "spotify_authorization_timeout")
        XCTAssertEqual(f.service.snapshot()["authorizing"] as? Bool, false)
        XCTAssertTrue(f.service.handleURL(f.callback))
        XCTAssertEqual(f.writes, ["callback-token"])
        XCTAssertTrue(f.service.snapshot()["error"] is NSNull)
        XCTAssertTrue(f.service.handleURL(f.callback))
        XCTAssertEqual(f.writes.count, 1)
    }

    @MainActor
    func testColdLaunchRestoresOnlyExpectedConfiguredAuthorization() async throws {
        let f = try SpotifyRecoveryFixture(token: nil)
        defer { f.cleanup() }
        try f.service.connect()
        f.service.suspend()
        f.relaunch()
        XCTAssertEqual(f.service.snapshot()["authorizing"] as? Bool, true)
        await assertPauseUnconfirmed(f.service)
        XCTAssertTrue(f.service.handleURL(f.callback))
        XCTAssertEqual(f.writes, ["callback-token"])
        XCTAssertEqual(f.remote.connectCalls, 1)
    }

    @MainActor
    func testUnsolicitedExpiredCancelledAndWrongDestinationCallbacksCannotWriteToken() throws {
        for cancellation in ["unsolicited", "expired", "disconnect", "logout", "provider", "configuration"] {
            let f = try SpotifyRecoveryFixture(token: nil)
            defer { f.cleanup() }
            if cancellation != "unsolicited" { try f.service.connect() }
            switch cancellation {
            case "expired": f.now += SpotifyAuthorizationIntent.lifetime
            case "disconnect": f.service.disconnect()
            case "logout": try f.service.logout()
            case "provider": f.service.cancelPendingAuthorization()
            case "configuration": try f.service.configure(clientId: String(repeating: "b", count: 32), redirectURI: SpotifyInput.redirectURI)
            default: break
            }
            XCTAssertTrue(f.service.handleURL(f.callback))
            XCTAssertTrue(f.writes.isEmpty, cancellation)
        }
        let f = try SpotifyRecoveryFixture(token: nil)
        defer { f.cleanup() }
        try f.service.connect()
        XCTAssertFalse(f.service.handleURL(URL(string: SpotifyInput.redirectURI + "/wrong#access_token=fake")!))
        XCTAssertFalse(f.service.handleURL(URL(string: "nostalgify://user:password@spotify-login-callback/#access_token=fake")!))
        XCTAssertTrue(f.writes.isEmpty)
        XCTAssertTrue(f.service.handleURL(f.callback), "Unrelated URLs must not consume valid pending intent")
        XCTAssertEqual(f.writes.count, 1)
    }

    @MainActor
    func testProviderCancellationOnColdLaunchRejectsCallbackAndRetainsUncertainty() async throws {
        let f = try SpotifyRecoveryFixture(token: nil)
        defer { f.cleanup() }
        try f.service.connect()
        f.service.suspend()
        f.relaunch()
        f.service.cancelPendingAuthorization()
        XCTAssertTrue(f.service.handleURL(f.callback))
        XCTAssertTrue(f.writes.isEmpty)
        await assertPauseUnconfirmed(f.service)
    }

    @MainActor
    func testTransientCommandFailureKeepsTrackAndClearsOnSuccessfulState() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: false)
        f.remote.api.failNextCommand = true
        do { try await f.service.command("seek", arg: 120); XCTFail("Expected rejection") }
        catch let error as NativeFailure { XCTAssertEqual(error.code, "spotify_command_failed") }
        XCTAssertEqual((f.service.snapshot()["track"] as? [String: Any])?["id"] as? String, "spotify:track:fixture")
        XCTAssertEqual(f.service.snapshot()["state"] as? String, "playing")
        XCTAssertEqual(f.service.snapshot()["error"] as? String, "spotify_command_failed")
        try XCTUnwrap(f.remote.api.delegate).playerStateDidChange(SpotifyTestState(paused: false, position: 45_000))
        XCTAssertTrue(f.service.snapshot()["error"] is NSNull)
        XCTAssertEqual(f.service.snapshot()["message"] as? String, "")
    }

    @MainActor
    func testStopReturnsAfterItsCommandsWhileStateRefreshIsStillPending() async throws {
        let f = try SpotifyRecoveryFixture(requestTimeout: 20_000_000)
        defer { f.cleanup() }
        f.establish(paused: false)
        f.remote.api.delayState = true
        try await f.service.command("stop", arg: nil)
        XCTAssertEqual(f.remote.api.seekPositions, [0])
        XCTAssertEqual(f.remote.api.stateCallbacks.count, 1, "Stop keeps its existing command budget rather than awaiting an extra read")
        f.remote.api.completeState(SpotifyTestState(paused: true, position: 0))
        XCTAssertEqual(f.service.snapshot()["state"] as? String, "paused")
    }

    @MainActor
    func testSeekReplyWaitsForDelayedPlayerStateAfterAcknowledgement() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: true, position: 30_000)
        f.remote.api.delayState = true
        let read = expectation(description: "Post-command read requested")
        f.remote.api.onStateRead = { read.fulfill() }
        var completed = false
        let seek = Task { @MainActor in
            try await f.service.command("seek", arg: 120)
            completed = true
        }
        await fulfillment(of: [read], timeout: 1)
        XCTAssertEqual(f.remote.api.seekPositions, [120_000])
        XCTAssertFalse(completed, "The SDK acknowledgement alone must not resolve a stale command snapshot")
        XCTAssertEqual(f.service.snapshot()["position"] as? Double, 30)
        f.remote.api.completeState(SpotifyTestState(paused: true, position: 120_000))
        try await seek.value
        XCTAssertTrue(completed)
        XCTAssertEqual(f.service.snapshot()["position"] as? Double, 120)
    }

    @MainActor
    func testNewerSubscriptionStateWinsOverDelayedRead() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.establish(paused: true, position: 30_000)
        f.remote.api.delayState = true
        let read = expectation(description: "Post-command read requested")
        f.remote.api.onStateRead = { read.fulfill() }
        let seek = Task { @MainActor in try await f.service.command("seek", arg: 120) }
        await fulfillment(of: [read], timeout: 1)
        try XCTUnwrap(f.remote.api.delegate).playerStateDidChange(SpotifyTestState(paused: true, position: 121_000))
        f.remote.api.completeState(SpotifyTestState(paused: true, position: 120_000))
        try await seek.value
        XCTAssertEqual(f.service.snapshot()["position"] as? Double, 121)
    }

    @MainActor
    func testPreCommandReadCannotEraseActivePlaybackUncertainty() async throws {
        let f = try SpotifyRecoveryFixture()
        defer { f.cleanup() }
        f.remote.api.delayState = true
        f.establish(paused: true)
        // Connection's initial state read is still pending when Resume starts.
        let oldRead = f.remote.api.stateCallbacks.removeFirst()
        f.remote.api.delayState = false
        try await f.service.command("play", arg: nil)
        oldRead(SpotifyTestState(paused: true, position: 30_000), nil)
        f.service.disconnect()
        await assertPauseUnconfirmed(f.service)
    }

    @MainActor
    func testPostCommandStateReadTimesOutAndDisconnectReleasesIt() async throws {
        for disconnect in [false, true] {
            let f = try SpotifyRecoveryFixture(requestTimeout: 20_000_000)
            defer { f.cleanup() }
            f.establish(paused: true)
            f.remote.api.delayState = true
            let read = expectation(description: "Post-command read requested")
            f.remote.api.onStateRead = { read.fulfill() }
            let seek = Task { @MainActor in try await f.service.command("seek", arg: -2) }
            await fulfillment(of: [read], timeout: 1)
            XCTAssertEqual(f.remote.api.seekPositions, [0])
            if disconnect { f.service.disconnect() }
            do { try await seek.value; XCTFail("An unavailable state must not leave the command pending") }
            catch let error as NativeFailure {
                XCTAssertEqual(error.code, disconnect ? "spotify_disconnected" : "spotify_command_timeout")
            }
            f.remote.api.completeState(SpotifyTestState(paused: true, position: 0))
        }
    }

    @MainActor
    private func assertPauseUnconfirmed(_ service: SpotifyRemoteService, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await service.pauseBeforeProviderSwitch(); XCTFail("Uncertain Spotify must protect the Files handoff", file: file, line: line) }
        catch let error as NativeFailure { XCTAssertEqual(error.code, "spotify_pause_unconfirmed", file: file, line: line) }
        catch { XCTFail("Unexpected error: \(error)", file: file, line: line) }
    }

    @MainActor
    private func settleCallbacks() async {
        for _ in 0..<10 { await Task.yield() }
    }
}

@MainActor
private final class SpotifyRecoveryFixture {
    let domain = "SpotifyRecoveryTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    var now = Date(timeIntervalSince1970: 1000)
    var token: String?
    var writes: [String] = []
    var remotes: [SpotifyTestRemote] = []
    var remote: SpotifyTestRemote { remotes.last! }
    var service: SpotifyRemoteService!
    var dependencies = SpotifyRemoteDependencies()
    let callback = URL(string: SpotifyInput.redirectURI + "/?spotify_version=fixture#access_token=callback-token")!

    init(token: String? = "saved-token", authorizationTimeout: UInt64 = 120_000_000_000,
         requestTimeout: UInt64 = 12_000_000_000) throws {
        defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        self.token = token
        dependencies.makeRemote = { [unowned self] configuration in
            let remote = SpotifyTestRemote(configuration: configuration, logLevel: .none)
            remotes.append(remote)
            return remote
        }
        dependencies.readToken = { [unowned self] in self.token }
        dependencies.writeToken = { [unowned self] value in writes.append(value); self.token = value }
        dependencies.deleteToken = { [unowned self] in self.token = nil }
        dependencies.now = { [unowned self] in now }
        dependencies.authorizationTimeoutNanoseconds = authorizationTimeout
        dependencies.requestTimeoutNanoseconds = requestTimeout
        relaunch()
        try service.configure(clientId: String(repeating: "a", count: 32), redirectURI: SpotifyInput.redirectURI)
    }

    func relaunch() { service = SpotifyRemoteService(diagnostics: NativeDiagnostics(), defaults: defaults, dependencies: dependencies) }
    func establish(paused: Bool, position: Int = 30_000, trackURI: String = "spotify:track:fixture") {
        remote.connectedValue = true
        remote.api.state = SpotifyTestState(paused: paused, position: position, trackURI: trackURI)
        service.appRemoteDidEstablishConnection(remote)
    }
    func cleanup() { service.disconnect(); service = nil; defaults.removePersistentDomain(forName: domain) }
}

private final class SpotifyTestRemote: SPTAppRemote {
    var connectedValue = false
    var disconnectStaysConnected = false
    var connectCalls = 0
    var authorizationCompletions: [(Bool) -> Void] = []
    let api = SpotifyTestPlayerAPI()
    override var isConnected: Bool { connectedValue }
    override var playerAPI: SPTAppRemotePlayerAPI? { api }
    override var imageAPI: SPTAppRemoteImageAPI? { nil }
    override func connect() { connectCalls += 1 }
    override func disconnect() { if !disconnectStaysConnected { connectedValue = false } }
    override func authorizeAndPlayURI(_ URI: String, completionHandler: ((Bool) -> Void)?) {
        if let completionHandler { authorizationCompletions.append(completionHandler) }
    }
    override func authorizationParameters(from url: URL) -> [String: String]? { [SPTAppRemoteAccessTokenKey: "callback-token"] }
}

private final class SpotifyTestPlayerAPI: NSObject, SPTAppRemotePlayerAPI {
    weak var delegate: SPTAppRemotePlayerStateDelegate?
    var state = SpotifyTestState(paused: true, position: 30_000)
    var failNextCommand = false
    var delayState = false
    var onStateRead: (() -> Void)?
    var stateCallbacks: [SPTAppRemoteCallback] = []
    var seekPositions: [Int] = []
    func completeState(_ state: SpotifyTestState) {
        self.state = state
        let callbacks = stateCallbacks
        stateCallbacks.removeAll()
        callbacks.forEach { $0(state, nil) }
    }
    private func complete(_ callback: SPTAppRemoteCallback?) {
        if failNextCommand { failNextCommand = false; callback?(nil, NSError(domain: "test", code: 1)) }
        else { callback?(NSNumber(value: true), nil) }
    }
    func getPlayerState(_ callback: SPTAppRemoteCallback?) {
        if delayState { if let callback { stateCallbacks.append(callback) } }
        else { callback?(state, nil) }
        onStateRead?()
    }
    func pause(_ callback: SPTAppRemoteCallback?) { state = SpotifyTestState(paused: true, position: state.playbackPosition); complete(callback) }
    func resume(_ callback: SPTAppRemoteCallback?) { state = SpotifyTestState(paused: false, position: state.playbackPosition); complete(callback) }
    func seek(toPosition position: Int, callback: SPTAppRemoteCallback?) { seekPositions.append(position); complete(callback) }
    func subscribe(toPlayerState callback: SPTAppRemoteCallback?) { callback?(state, nil) }
    func unsubscribe(toPlayerState callback: SPTAppRemoteCallback?) { complete(callback) }
    func play(_ entityIdentifier: String, callback: SPTAppRemoteCallback?) { resume(callback) }
    func play(_ trackUri: String, asRadio: Bool, callback: @escaping SPTAppRemoteCallback) { resume(callback) }
    func play(_ contentItem: SPTAppRemoteContentItem, callback: SPTAppRemoteCallback?) { complete(callback) }
    func play(_ contentItem: SPTAppRemoteContentItem, skipToTrackIndex index: Int, callback: SPTAppRemoteCallback?) { complete(callback) }
    func skip(toNext callback: SPTAppRemoteCallback?) { complete(callback) }
    func skip(toPrevious callback: SPTAppRemoteCallback?) { complete(callback) }
    func seekForward15Seconds(_ callback: SPTAppRemoteCallback?) { complete(callback) }
    func seekBackward15Seconds(_ callback: SPTAppRemoteCallback?) { complete(callback) }
    func setShuffle(_ shuffle: Bool, callback: SPTAppRemoteCallback?) { complete(callback) }
    func setRepeatMode(_ repeatMode: SPTAppRemotePlaybackOptionsRepeatMode, callback: SPTAppRemoteCallback?) { complete(callback) }
    func enqueueTrackUri(_ trackUri: String, callback: SPTAppRemoteCallback?) { complete(callback) }
    func getAvailablePodcastPlaybackSpeeds(_ callback: SPTAppRemoteCallback?) { complete(callback) }
    func getCurrentPodcastPlaybackSpeed(_ callback: SPTAppRemoteCallback?) { complete(callback) }
    func setPodcastPlaybackSpeed(_ speed: SPTAppRemotePodcastPlaybackSpeed, callback: SPTAppRemoteCallback?) { complete(callback) }
    func getCrossfadeState(_ callback: SPTAppRemoteCallback?) { complete(callback) }
}

private final class SpotifyTestState: NSObject, SPTAppRemotePlayerState {
    let track: SPTAppRemoteTrack
    let playbackPosition: Int
    let playbackSpeed: Float = 1
    let isPaused: Bool
    let playbackRestrictions: SPTAppRemotePlaybackRestrictions = SpotifyTestRestrictions()
    let playbackOptions: SPTAppRemotePlaybackOptions = SpotifyTestOptions()
    let contextTitle = "Fixture"
    let contextURI = URL(string: "spotify:playlist:fixture")!
    init(paused: Bool, position: Int, trackURI: String = "spotify:track:fixture") {
        isPaused = paused
        playbackPosition = position
        track = SpotifyTestTrack(uri: trackURI)
    }
}

private final class SpotifyTestTrack: NSObject, SPTAppRemoteTrack {
    let name = "Test track"
    let uri: String
    let duration: UInt = 180_000
    let artist: SPTAppRemoteArtist = SpotifyTestArtist()
    let album: SPTAppRemoteAlbum = SpotifyTestAlbum()
    let isSaved = false
    let isEpisode = false
    let isPodcast = false
    let isAdvertisement = false
    let imageIdentifier = "fixture"
    init(uri: String) { self.uri = uri }
}
private final class SpotifyTestArtist: NSObject, SPTAppRemoteArtist { let name = "Artist"; let uri = "spotify:artist:fixture" }
private final class SpotifyTestAlbum: NSObject, SPTAppRemoteAlbum { let name = "Album"; let uri = "spotify:album:fixture" }
private final class SpotifyTestRestrictions: NSObject, SPTAppRemotePlaybackRestrictions {
    let canSkipNext = true
    let canSkipPrevious = true
    let canRepeatTrack = true
    let canRepeatContext = true
    let canToggleShuffle = true
    let canSeek = true
}
private final class SpotifyTestOptions: NSObject, SPTAppRemotePlaybackOptions {
    let isShuffling = false
    let repeatMode: SPTAppRemotePlaybackOptionsRepeatMode = .off
}
