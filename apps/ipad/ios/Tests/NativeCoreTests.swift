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
}
