import XCTest
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
}
