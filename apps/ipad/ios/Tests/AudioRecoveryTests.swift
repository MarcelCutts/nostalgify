import AVFoundation
import MediaPlayer
import XCTest
@testable import App

final class AudioRecoveryTests: XCTestCase {
    @MainActor
    func testResetRecreatesPlayerAndObserversWithoutResumingThenAllowsExplicitPlay() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("volume", arg: 37)
        try await service.command("playShelf", arg: "local:" + fixture.records[1].id)
        try await service.command("repeat", arg: true)
        try await service.command("seek", arg: 3.5)
        let original = fixture.players[0]
        let oldItem = try XCTUnwrap(original.currentItem)
        let queuedPeriodicCallback = original.periodicCallback
        let configurationsBeforeReset = fixture.configurations
        let activationsBeforeReset = fixture.activations

        fixture.postReset()
        try await eventually { fixture.players.count == 2 }
        let recovered = fixture.players[1]
        XCTAssertFalse(recovered === original)
        XCTAssertNil(original.currentItem)
        XCTAssertEqual(original.periodicRemovals, 1)
        XCTAssertEqual(recovered.periodicAdditions, 1)
        XCTAssertEqual(recovered.playCalls, 0)
        XCTAssertEqual(recovered.volume, 0.37, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(service.snapshot()["position"] as? Double), 3.5, accuracy: 0.01)
        XCTAssertEqual(service.snapshot()["state"] as? String, "paused")
        XCTAssertEqual(service.snapshot()["error"] as? String, "audio_services_reset")
        XCTAssertEqual(trackID(service), fixture.records[1].id)
        XCTAssertEqual(service.library, fixture.records)
        XCTAssertEqual(service.snapshot()["repeat"] as? Bool, true)
        XCTAssertEqual(fixture.configurations, configurationsBeforeReset + 1)
        XCTAssertEqual(fixture.activations, activationsBeforeReset, "Reset must never activate audio.")

        // Callbacks already enqueued by the old engine cannot change selection,
        // clear the reset error, or resume the freshly created player.
        queuedPeriodicCallback?(.zero)
        fixture.center.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: oldItem)
        fixture.center.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: oldItem)
        await settleNotifications()
        XCTAssertEqual(trackID(service), fixture.records[1].id)
        XCTAssertEqual(service.snapshot()["error"] as? String, "audio_services_reset")
        XCTAssertEqual(recovered.playCalls, 0)

        try await service.command("next", arg: nil)
        XCTAssertEqual(trackID(service), fixture.records[2].id, "Reset must retain the queue index.")
        XCTAssertEqual(recovered.playCalls, 0, "Skipping a paused queue must remain paused.")
        try await service.command("play", arg: nil)
        XCTAssertEqual(recovered.playCalls, 1)
        XCTAssertTrue(service.snapshot()["error"] is NSNull)
        XCTAssertEqual(fixture.activations, activationsBeforeReset + [true])
    }

    @MainActor
    func testInactiveResetRebuildsEngineWithoutTakingSpotifySessionOwnership() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("playShelf", arg: "local:" + fixture.records[1].id)
        try service.setActive(false)
        let configurations = fixture.configurations
        let activations = fixture.activations
        let center = MPRemoteCommandCenter.shared()
        XCTAssertFalse(center.playCommand.isEnabled)
        XCTAssertFalse(center.nextTrackCommand.isEnabled)

        fixture.postReset()
        try await eventually { fixture.players.count == 2 }
        XCTAssertEqual(fixture.configurations, configurations)
        XCTAssertEqual(fixture.activations, activations)
        XCTAssertEqual(fixture.players[1].playCalls, 0)
        XCTAssertFalse(center.playCommand.isEnabled)
        XCTAssertEqual(trackID(service), fixture.records[1].id)
        try service.setActive(true)
        XCTAssertEqual(fixture.activations, activations, "Selecting local audio alone must not start it.")
        try await service.command("play", arg: nil)
        XCTAssertEqual(fixture.configurations, configurations + 1)
        XCTAssertEqual(fixture.activations, activations + [true])
        XCTAssertEqual(fixture.players[1].playCalls, 1)
    }

    @MainActor
    func testRepeatedResetRemovesEachOwnersObserverAndServiceTeardownRemovesLast() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        for count in 2...4 {
            fixture.postReset()
            try await eventually { fixture.players.count == count }
        }
        XCTAssertEqual(fixture.players.map(\.periodicAdditions), [1, 1, 1, 1])
        XCTAssertEqual(fixture.players.map(\.periodicRemovals), [1, 1, 1, 0])
        XCTAssertTrue(fixture.players.allSatisfy { $0.playCalls == 0 })
        XCTAssertTrue(fixture.activations.isEmpty)
        weak var releasedService = fixture.service
        fixture.service = nil
        try await eventually { releasedService == nil }
        XCTAssertEqual(fixture.players.map(\.periodicRemovals), [1, 1, 1, 1])
        fixture.postReset()
        await settleNotifications()
        XCTAssertEqual(fixture.players.count, 4, "Teardown must remove the notification subscription.")
    }

    @MainActor
    func testInterruptionUsesUserIntentEvenWhenPlayerRateAlreadyBecameZero() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("play", arg: nil)
        let player = fixture.players[0]
        XCTAssertEqual(player.rate, 0, "The probe models a player already paused by iOS.")
        try await fixture.postInterruption(.began)
        try await fixture.postInterruption(.ended, shouldResume: true)
        try await eventually { player.playCalls == 2 }

        try await fixture.postInterruption(.began)
        try await service.command("pause", arg: nil)
        try await fixture.postInterruption(.ended, shouldResume: true)
        XCTAssertEqual(player.playCalls, 2, "An explicit pause cancels the interruption's resume intent.")
    }

    @MainActor
    func testResetDuringInterruptionCancelsPendingAutomaticResume() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("play", arg: nil)
        try await fixture.postInterruption(.began)
        fixture.postReset()
        try await eventually { fixture.players.count == 2 }
        try await fixture.postInterruption(.ended, shouldResume: true)
        XCTAssertEqual(fixture.players[1].playCalls, 0)
        XCTAssertEqual(service.snapshot()["error"] as? String, "audio_services_reset")
        try await service.command("playpause", arg: nil)
        XCTAssertEqual(fixture.players[1].playCalls, 1)
    }

    @MainActor
    func testRouteLossOrSystemResumeDenialRequiresNextUserPlay() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("play", arg: nil)
        try await fixture.postInterruption(.began)
        try await fixture.postRouteLoss()
        try await fixture.postInterruption(.ended, shouldResume: true)
        XCTAssertEqual(fixture.players[0].playCalls, 1)
        try await service.command("playpause", arg: nil)
        XCTAssertEqual(fixture.players[0].playCalls, 2)
        try await fixture.postInterruption(.began)
        try await fixture.postInterruption(.ended, shouldResume: false)
        try await service.command("playpause", arg: nil)
        XCTAssertEqual(fixture.players[0].playCalls, 3, "A denied resume must leave the toggle ready to play.")
    }

    @MainActor
    func testLateInterruptionEndCannotPauseFreshUserPlaybackAfterReset() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("play", arg: nil)
        try await fixture.postInterruption(.began)
        fixture.postReset()
        try await eventually { fixture.players.count == 2 }
        try await service.command("play", arg: nil)
        try await fixture.postInterruption(.ended, shouldResume: false)
        XCTAssertEqual(fixture.players[1].playCalls, 1)
        XCTAssertTrue(MPRemoteCommandCenter.shared().pauseCommand.isEnabled,
                      "A stale interruption ending must preserve new user playback intent.")
        try await service.command("playpause", arg: nil)
        XCTAssertEqual(fixture.players[1].playCalls, 1, "The next toggle should pause the fresh playback.")
        XCTAssertFalse(MPRemoteCommandCenter.shared().pauseCommand.isEnabled)
    }

    @MainActor
    func testRemoteAvailabilityFollowsQueueBoundariesAndProviderOwnership() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        let center = MPRemoteCommandCenter.shared()
        XCTAssertTrue(center.playCommand.isEnabled)
        XCTAssertFalse(center.pauseCommand.isEnabled)
        try await service.command("playShelf", arg: "local:" + fixture.records[2].id)
        XCTAssertFalse(center.nextTrackCommand.isEnabled)
        XCTAssertTrue(center.previousTrackCommand.isEnabled)
        XCTAssertTrue(center.pauseCommand.isEnabled)
        try await service.command("repeat", arg: true)
        XCTAssertTrue(center.nextTrackCommand.isEnabled)
        try service.setActive(false)
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                        center.stopCommand, center.nextTrackCommand, center.previousTrackCommand,
                        center.changePlaybackPositionCommand] {
            XCTAssertFalse(command.isEnabled)
        }
    }

    @MainActor
    func testSeekCompletionFromReplacedPlayerCannotChangeRecoveredState() async throws {
        let fixture = try AudioRecoveryFixture()
        defer { fixture.cleanup() }
        let service = fixture.service!
        try service.setActive(true)
        try await service.command("play", arg: nil)
        try await service.command("stop", arg: nil)
        let original = fixture.players[0]
        original.holdSeeks = true
        let seek = Task { @MainActor in try await service.command("seek", arg: 4) }
        try await eventually { original.pendingSeek != nil }
        fixture.postReset()
        try await eventually { fixture.players.count == 2 }
        original.completeSeek()
        try await seek.value
        XCTAssertEqual(service.snapshot()["state"] as? String, "stopped")
        XCTAssertEqual(fixture.players[1].playCalls, 0)
    }

    @MainActor
    private func trackID(_ service: LocalAudioService) -> String? {
        (service.snapshot()["track"] as? [String: Any])?["id"] as? String
    }

    @MainActor
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Expected asynchronous audio event did not finish", file: file, line: line)
        throw NativeFailure(code: "test_timeout", message: "Audio event timed out.")
    }

    @MainActor
    private func settleNotifications() async {
        // The service deliberately hops notification callbacks onto MainActor.
        for _ in 0..<10 { await Task.yield() }
    }
}

@MainActor
private final class AudioRecoveryFixture {
    let directory: URL
    let center = NotificationCenter()
    let diagnostics = NativeDiagnostics()
    let records: [LocalAudioRecord]
    var service: LocalAudioService?
    var players: [RecoveryProbePlayer] = []
    var configurations = 0
    var activations: [Bool] = []

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var generated: [LocalAudioRecord] = []
        for index in 0..<3 {
            let id = UUID().uuidString.lowercased()
            let filename = id + ".wav"
            try NativeSelfCheck.fixture(at: directory.appendingPathComponent(filename), seconds: 8)
            generated.append(LocalAudioRecord(id: id, filename: filename, name: "Fixture \(index)", artist: "", album: "", duration: 8))
        }
        records = generated
        try JSONEncoder().encode(records).write(to: directory.appendingPathComponent("library.json"))
        let session = LocalAudioSessionActions(configure: { [weak self] in self?.configurations += 1 },
            setActive: { [weak self] in self?.activations.append($0) })
        service = LocalAudioService(diagnostics: diagnostics, directory: directory,
                                    notificationCenter: center, session: session, makePlayer: { [weak self] in
            let player = RecoveryProbePlayer()
            self?.players.append(player)
            return player
        })
    }

    func postReset() { center.post(name: AVAudioSession.mediaServicesWereResetNotification, object: nil) }

    func postInterruption(_ type: AVAudioSession.InterruptionType, shouldResume: Bool = false) async throws {
        let event = type == .began ? "local.interruption_began" : "local.interruption_ended"
        let previous = eventCount(event)
        center.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [
            AVAudioSessionInterruptionTypeKey: type.rawValue,
            AVAudioSessionInterruptionOptionKey: shouldResume ? AVAudioSession.InterruptionOptions.shouldResume.rawValue : 0])
        try await waitForEvent(event, after: previous)
    }

    func postRouteLoss() async throws {
        let event = "local.route_disconnected"
        let previous = eventCount(event)
        center.post(name: AVAudioSession.routeChangeNotification, object: nil,
                    userInfo: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue])
        try await waitForEvent(event, after: previous)
    }

    private func eventCount(_ name: String) -> Int {
        (diagnostics.snapshot()["events"] as? [[String: Any]] ?? []).filter { ($0["event"] as? String) == name }.count
    }

    private func waitForEvent(_ name: String, after previous: Int) async throws {
        for _ in 0..<100 {
            if eventCount(name) > previous { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Audio notification was not handled: " + name)
        throw NativeFailure(code: "test_timeout", message: "Audio notification timed out.")
    }

    func cleanup() {
        try? service?.setActive(false)
        service = nil
        try? FileManager.default.removeItem(at: directory)
    }
}

/// Real AVPlayer item/KVO lifecycle with deterministic transport and periodic
/// callbacks. It never emits audio or depends on simulator route availability.
private final class RecoveryProbePlayer: AVPlayer, @unchecked Sendable {
    var playCalls = 0
    var periodicAdditions = 0
    var periodicRemovals = 0
    var periodicCallback: (@Sendable (CMTime) -> Void)?
    var holdSeeks = false
    private var position: CMTime = .zero
    private var pendingPosition: CMTime = .zero
    var pendingSeek: (@Sendable (Bool) -> Void)?
    private let periodicID = NSObject()

    override func play() { playCalls += 1 }
    override func currentTime() -> CMTime { position }
    override func seek(to time: CMTime) { position = time }

    override func addPeriodicTimeObserver(forInterval interval: CMTime, queue: DispatchQueue?, using block: @escaping @Sendable (CMTime) -> Void) -> Any {
        periodicAdditions += 1
        periodicCallback = block
        return periodicID
    }

    override func removeTimeObserver(_ observer: Any) {
        XCTAssertTrue((observer as? NSObject) === periodicID, "Remove the token from the player that created it.")
        periodicRemovals += 1
        periodicCallback = nil
    }

    override func seek(to time: CMTime, toleranceBefore: CMTime, toleranceAfter: CMTime, completionHandler: @escaping @Sendable (Bool) -> Void) {
        if holdSeeks { pendingPosition = time; pendingSeek = completionHandler }
        else { position = time; completionHandler(true) }
    }

    func completeSeek() {
        let completion = pendingSeek
        pendingSeek = nil
        position = pendingPosition
        completion?(true)
    }
}
