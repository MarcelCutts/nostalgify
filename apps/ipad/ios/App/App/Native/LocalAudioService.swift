import AVFoundation
import MediaPlayer
import UIKit

/// Session actions are injectable so reset tests can distinguish configuration
/// from activation without taking ownership of the simulator's audio session.
struct LocalAudioSessionActions {
    var configure: () throws -> Void
    var setActive: (Bool) throws -> Void

    static var live: Self {
        Self(configure: {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        }, setActive: { active in
            try AVAudioSession.sharedInstance().setActive(active, options: active ? [] : .notifyOthersOnDeactivation)
        })
    }
}

struct LocalAudioStorageActions {
    var copy: @Sendable (URL, URL) throws -> Void
    var write: (Data, URL) throws -> Void

    static var live: Self {
        Self(copy: { source, destination in
            try FileManager.default.copyItem(at: source, to: destination)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        }, write: { data, destination in try data.write(to: destination, options: .atomic) })
    }
}

/// A seek includes waiting for readiness, and always settles exactly once even
/// if AVFoundation never completes it or delivers a callback after cancellation.
@MainActor
private final class LocalAudioSeek {
    private let player: AVPlayer
    private let item: AVPlayerItem
    private let time: CMTime
    private var continuation: CheckedContinuation<Bool, Error>?
    private var observation: NSKeyValueObservation?
    private var deadline: Task<Void, Never>?
    private var started = false

    init(player: AVPlayer, item: AVPlayerItem, time: CMTime) {
        self.player = player
        self.item = item
        self.time = time
    }

    func wait(timeout: Duration) async throws -> Bool {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                deadline = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.finish(.failure(NativeFailure(code: "local_seek_timeout", message: "The audio position took too long to change. Press Play and try again.")), cancel: true)
                }
                observation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
                    Task { @MainActor in self?.advance() }
                }
                advance()
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError()), cancel: true) }
        }
    }

    func cancel() { finish(.success(false), cancel: true) }

    private func advance() {
        guard continuation != nil else { return }
        guard item.status != .failed else { fail(); return }
        guard !started, item.status == .readyToPlay else { return }
        started = true
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
            Task { @MainActor in
                guard let self else { return }
                if completed { self.finish(.success(true)) } else { self.fail() }
            }
        }
    }

    private func fail() {
        finish(.failure(NativeFailure(code: "local_seek_failed", message: "The audio position could not be changed. Press Play and try again.")), cancel: true)
    }

    private func finish(_ result: Result<Bool, Error>, cancel: Bool = false) {
        guard let continuation else { return }
        self.continuation = nil
        deadline?.cancel()
        deadline = nil
        observation?.invalidate()
        observation = nil
        // Clear the continuation before AVFoundation can synchronously invoke
        // its completion handler while cancelling the underlying operation.
        if cancel { item.cancelPendingSeeks() }
        continuation.resume(with: result)
    }
}

/// Application-owned playback survives WebView navigation, reloads, and suspension.
@MainActor
final class LocalAudioService {
    var onStateChanged: (() -> Void)?
    private(set) var library: [LocalAudioRecord] = []
    private var player: AVPlayer
    private let makePlayer: () -> AVPlayer
    private let makeItem: (URL) -> AVPlayerItem
    private let seekTimeout: Duration
    private var pendingSeek: LocalAudioSeek?
    private let notificationCenter: NotificationCenter
    private let session: LocalAudioSessionActions
    private let storage: LocalAudioStorageActions
    private let diagnostics: NativeDiagnostics
    private let directory: URL
    private var queue = LocalQueue()
    private var active = false
    private var stopped = true
    private var shuffle = false
    private var repeating = false
    private var error: String?
    private var message = "Import audio from Files to start listening."
    // AVPlayer may already be paused when iOS delivers an interruption. Keep
    // the user's intent independently from AVPlayer's observed rate.
    private var wantsPlayback = false
    private var playbackRevision: UInt64 = 0
    private var resumeAfterInterruption = false
    private var interruptionInProgress = false
    private var notificationTokens: [NSObjectProtocol] = []
    private var periodicToken: Any?
    private var statusObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var remoteTargets: [(MPRemoteCommand, Any)] = []

    init(diagnostics: NativeDiagnostics, directory storageDirectory: URL? = nil,
         notificationCenter: NotificationCenter = .default,
         session: LocalAudioSessionActions = .live,
         storage: LocalAudioStorageActions = .live,
         seekTimeout: Duration = .seconds(5),
         makeItem: @escaping (URL) -> AVPlayerItem = { AVPlayerItem(url: $0) },
         makePlayer: @escaping () -> AVPlayer = { AVPlayer() }) {
        self.diagnostics = diagnostics
        self.notificationCenter = notificationCenter
        self.session = session
        self.makePlayer = makePlayer
        self.makeItem = makeItem
        self.seekTimeout = seekTimeout
        self.storage = storage
        player = makePlayer()
        directory = storageDirectory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Audio", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("library.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let decoded = try JSONDecoder().decode([LocalAudioRecord].self, from: Data(contentsOf: url))
                library = decoded.filter { $0.isSafe && FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.filename).path) }
            }
            if !library.isEmpty { message = "" }
        } catch {
            self.error = "library_read_failed"
            message = "The local library could not be read. Your audio files have not been deleted."
            diagnostics.record("local.library_read_failed")
        }
        installPlayerObservers()
        observe(AVPlayerItem.didPlayToEndTimeNotification) { [weak self] notification in
            guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.finished()
        }
        observe(AVPlayerItem.failedToPlayToEndTimeNotification) { [weak self] notification in
            guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.failed("local_playback_failed", "This audio file could not be played.")
        }
        observe(AVPlayerItem.timeJumpedNotification) { [weak self] notification in
            guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
            // Plain seeks used during recovery can settle after their caller
            // publishes. Reanchor metadata when that actual time jump arrives.
            self.changed()
        }
        observe(AVAudioSession.interruptionNotification) { [weak self] note in self?.interrupted(note) }
        observe(AVAudioSession.routeChangeNotification) { [weak self] note in
            guard let self, self.active,
                  let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self.cancelPlaybackIntent()
            self.diagnostics.record("local.route_disconnected")
            self.changed()
        }
        observe(AVAudioSession.mediaServicesWereResetNotification) { [weak self] _ in
            self?.mediaServicesReset()
        }
    }

    deinit {
        notificationTokens.forEach(notificationCenter.removeObserver)
        if let token = periodicToken { player.removeTimeObserver(token) }
        remoteTargets.forEach { $0.0.removeTarget($0.1); $0.0.isEnabled = false }
        statusObservation?.invalidate()
        rateObservation?.invalidate()
    }

    private func installPlayerObservers() {
        let observedPlayer = player
        observedPlayer.automaticallyWaitsToMinimizeStalling = true
        periodicToken = observedPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self, weak observedPlayer] _ in
            Task { @MainActor in
                guard let self, observedPlayer === self.player else { return }
                self.progressChanged()
            }
        }
        rateObservation = observedPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] observedPlayer, _ in
            Task { @MainActor in
                guard let self, observedPlayer === self.player else { return }
                self.changed()
            }
        }
    }

    private func cancelPlaybackIntent() {
        playbackRevision &+= 1
        pendingSeek?.cancel()
        pendingSeek = nil
        wantsPlayback = false
        resumeAfterInterruption = false
        player.pause()
    }

    private func mediaServicesReset() {
        let selected = current
        let position = elapsed
        let volume = player.volume
        let wasStopped = stopped
        cancelPlaybackIntent()
        interruptionInProgress = false
        // Tokens belong to the old player. Remove them before replacing it;
        // queued callbacks also verify their player/item identity.
        statusObservation?.invalidate()
        statusObservation = nil
        rateObservation?.invalidate()
        rateObservation = nil
        if let token = periodicToken { player.removeTimeObserver(token) }
        periodicToken = nil
        player.currentItem?.cancelPendingSeeks()
        player.replaceCurrentItem(with: nil)
        player = makePlayer()
        player.volume = volume
        installPlayerObservers()
        if let selected {
            load(selected)
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600))
        }
        stopped = wasStopped
        // Configure without activation. An inactive local provider must not
        // change the shared session while Spotify owns playback; Play configures
        // the session when the user next chooses local playback.
        if active {
            do { try session.configure() }
            catch { diagnostics.record("local.session_configure_failed") }
        }
        diagnostics.record("local.media_services_reset")
        failed("audio_services_reset", "Audio services restarted. Press Play to continue.")
    }

    private var canSkipNext: Bool {
        !queue.ids.isEmpty && (queue.index + 1 < queue.ids.count || repeating)
    }

    private var canSkipPrevious: Bool {
        current != nil && (elapsed > 3 || queue.index > 0 || repeating)
    }

    private var current: LocalAudioRecord? { library.first { $0.id == queue.current } }
    private var elapsed: Double { PlaybackValue.position(player.currentTime().seconds, duration: current?.duration ?? 0) }

    private func observe(_ name: Notification.Name, handler: @escaping @MainActor @Sendable (Notification) -> Void) {
        notificationTokens.append(notificationCenter.addObserver(forName: name, object: nil, queue: .main) { note in
            // NotificationCenter delivers this subscription on the main queue,
            // including notifications posted from background threads. Handle it
            // there without transferring Notification's non-Sendable payload.
            MainActor.assumeIsolated { handler(note) }
        })
    }

    func setActive(_ value: Bool) throws {
        if value == active { return }
        if !value {
            cancelPlaybackIntent()
            remoteTargets.forEach { $0.0.removeTarget($0.1); $0.0.isEnabled = false }
            remoteTargets.removeAll()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            do { try session.setActive(false) }
            catch { diagnostics.record("local.session_deactivate_failed") }
        }
        active = value
        if value { installRemoteCommands() }
        changed()
    }

    func pauseBeforeProviderSwitch() {
        cancelPlaybackIntent()
        changed()
    }

    func snapshot() -> [String: Any] {
        let record = current
        return ["provider": "local", "running": true,
                "state": player.timeControlStatus == .playing ? "playing" : (stopped ? "stopped" : "paused"),
                "position": elapsed, "volume": Double(player.volume) * 100,
                "shuffle": shuffle, "repeat": repeating,
                "track": record.map { $0.snapshot as Any } ?? NSNull(),
                "error": error.map { $0 as Any } ?? NSNull(), "message": message,
                "capabilities": ["canSeek": record != nil, "canSetVolume": true,
                    "canSkipNext": canSkipNext, "canSkipPrevious": canSkipPrevious,
                    "canShuffle": true, "canRepeat": true]]
    }

    func importFiles(_ urls: [URL]) async throws -> (items: [LocalAudioRecord], skipped: Int) {
        var imported: [LocalAudioRecord] = []
        var skipped = 0
        var storageFailure: NativeFailure?
        for source in urls {
            let id = UUID().uuidString.lowercased()
            let ext = source.pathExtension.lowercased()
            let safeExtension = !ext.isEmpty && ext.count <= 12 && ext.allSatisfy { $0.isLetter || $0.isNumber } ? ext : "audio"
            let filename = id + "." + safeExtension
            let destination = directory.appendingPathComponent(filename)
            let accessed = source.startAccessingSecurityScopedResource()
            defer { if accessed { source.stopAccessingSecurityScopedResource() } }
            do {
                // File Provider can download large items; keep copy I/O off the UI thread.
                let copy = storage.copy
                try await Task.detached(priority: .userInitiated) {
                    try copy(source, destination)
                }.value
                let asset = AVURLAsset(url: destination)
                guard try await asset.load(.isPlayable) else {
                    throw NativeFailure(code: "unsupported_audio", message: "This audio format is not supported.")
                }
                let duration = try await asset.load(.duration).seconds
                guard duration.isFinite, duration > 0 else {
                    throw NativeFailure(code: "unsupported_audio", message: "This file has no playable audio duration.")
                }
                let metadata = (try? await asset.load(.commonMetadata)) ?? []
                func value(_ key: AVMetadataKey) async -> String {
                    guard let item = metadata.first(where: { $0.commonKey == key }) else { return "" }
                    return (try? await item.load(.stringValue)) ?? ""
                }
                let title = await value(.commonKeyTitle)
                let artist = await value(.commonKeyArtist)
                let album = await value(.commonKeyAlbumName)
                let record = LocalAudioRecord(id: id, filename: filename,
                    name: title.isEmpty ? source.deletingPathExtension().lastPathComponent : title,
                    artist: artist, album: album, duration: duration)
                try save(library + [record])
                library.append(record)
                imported.append(record)
            } catch {
                try? FileManager.default.removeItem(at: destination)
                if let failure = Self.importStorageFailure(error) {
                    storageFailure = failure
                    diagnostics.record("local.import_failed", code: failure.code)
                    break
                }
                skipped += 1
                diagnostics.record("local.import_failed", code: "unsupported_or_unreadable")
            }
        }
        if !imported.isEmpty {
            queue.reset(library.map(\.id), startingAt: queue.current, shuffled: shuffle)
            // Import notices belong to this operation's result, not playback.
            // Preserve an existing playback failure until playback recovers.
            if error == nil { message = "" }
            diagnostics.record("local.import_completed")
            changed()
        }
        if let storageFailure { throw storageFailure }
        if imported.isEmpty && !urls.isEmpty {
            throw NativeFailure(code: "import_failed", message: "No files could be imported. Choose unprotected audio files downloaded in Files and try again.")
        }
        return (imported, skipped)
    }

    private static func importStorageFailure(_ error: Error) -> NativeFailure? {
        if let failure = error as? NativeFailure, failure.code == "library_write_failed" { return failure }
        let error = error as NSError
        let writeCodes: Set<Int> = [NSFileWriteUnknownError, NSFileWriteNoPermissionError,
            NSFileWriteInvalidFileNameError, NSFileWriteFileExistsError,
            NSFileWriteOutOfSpaceError, NSFileWriteVolumeReadOnlyError]
        if (error.domain == NSCocoaErrorDomain && writeCodes.contains(error.code)) ||
            (error.domain == NSPOSIXErrorDomain && [Int(ENOSPC), Int(EDQUOT), Int(EROFS)].contains(error.code)) {
            return NativeFailure(code: "library_write_failed", message: "The library could not be saved. Check available iPad storage.")
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? Error { return importStorageFailure(underlying) }
        return nil
    }

    func remove(id: String) throws {
        guard let record = library.first(where: { $0.id == id }) else {
            throw NativeFailure(code: "not_found", message: "That audio file is no longer in the library.")
        }
        let remaining = library.filter { $0.id != id }
        try save(remaining)
        let selected = queue.current
        if selected == id {
            cancelPlaybackIntent()
            statusObservation?.invalidate()
            statusObservation = nil
            player.replaceCurrentItem(with: nil)
            stopped = true
        }
        library = remaining
        queue.reset(remaining.map(\.id), startingAt: selected == id ? nil : selected, shuffled: shuffle)
        // Metadata is committed before deletion; a failed delete only leaves an orphan file.
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(record.filename))
        if selected == id, let next = current { load(next) }
        diagnostics.record("local.removed")
        changed()
    }

    private func save(_ records: [LocalAudioRecord]) throws {
        do {
            try storage.write(JSONEncoder().encode(records), directory.appendingPathComponent("library.json"))
        } catch {
            throw NativeFailure(code: "library_write_failed", message: "The library could not be saved. Check available iPad storage.")
        }
    }

    func command(_ command: String, arg: Any?) async throws {
        guard active else { throw NativeFailure(code: "inactive_provider", message: "Select Local Files first.") }
        switch command {
        case "play", "playOrFallback": try play()
        case "pause": cancelPlaybackIntent()
        case "playpause":
            if wantsPlayback { cancelPlaybackIntent() } else { try play() }
        case "stop":
            cancelPlaybackIntent(); stopped = true
            // Stopping takes effect even if the bounded rewind later fails.
            changed()
            try await seek(0)
        case "seek":
            guard let record = current else { throw NativeFailure(code: "no_track", message: "Choose a local audio file first.") }
            let seconds = try PlaybackValue.number(arg)
            if player.currentItem == nil { load(record) }
            let completed = try await seek(seconds)
            // An explicit scrub selects the next playback position even after
            // Stop or natural completion. Stop's internal seek keeps stopped.
            if completed { stopped = false }
        case "volume": player.volume = Float(PlaybackValue.volume(try PlaybackValue.number(arg)) / 100)
        case "next": try skip(1)
        case "previous":
            if elapsed > 3 { try await seek(0) } else { try skip(-1) }
        case "shuffle":
            guard let value = arg as? Bool else { throw NativeFailure(code: "invalid_argument", message: "Shuffle requires true or false.") }
            shuffle = value
            queue.reset(library.map(\.id), startingAt: queue.current, shuffled: shuffle)
        case "repeat":
            guard let value = arg as? Bool else { throw NativeFailure(code: "invalid_argument", message: "Repeat requires true or false.") }
            repeating = value
        case "playShelf":
            guard let uri = arg as? String, uri.hasPrefix("local:"),
                  let record = library.first(where: { $0.id == String(uri.dropFirst(6)) }) else {
                throw NativeFailure(code: "not_found", message: "Choose an imported local audio file.")
            }
            queue.reset(library.map(\.id), startingAt: record.id, shuffled: shuffle)
            load(record)
            try play()
        default: throw NativeFailure(code: "unsupported_command", message: "This control is unavailable for local audio.")
        }
        changed()
    }

    private func load(_ record: LocalAudioRecord) {
        cancelPlaybackIntent()
        statusObservation?.invalidate()
        let item = makeItem(directory.appendingPathComponent(record.filename))
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self, item === self.player.currentItem else { return }
                if item.status == .failed { self.failed("local_playback_failed", "This audio file could not be played.") }
            }
        }
        player.replaceCurrentItem(with: item)
        stopped = false
        error = nil
        message = ""
    }

    private func play() throws {
        guard !library.isEmpty else { throw NativeFailure(code: "empty_library", message: "Import audio from Files first.") }
        playbackRevision &+= 1
        pendingSeek?.cancel()
        pendingSeek = nil
        if current == nil { queue.reset(library.map(\.id), startingAt: nil, shuffled: shuffle) }
        if player.currentItem == nil, let record = current { load(record) }
        if player.currentItem?.status == .failed, let record = current { load(record) }
        do {
            try session.configure()
            try session.setActive(true)
        } catch {
            cancelPlaybackIntent()
            throw NativeFailure(code: "audio_session_failed", message: "The audio output is unavailable. Try Play again.")
        }
        if stopped { player.seek(to: .zero) }
        stopped = false
        error = nil
        message = ""
        wantsPlayback = true
        // A fresh Play supersedes any old interruption's eventual ended event.
        interruptionInProgress = false
        resumeAfterInterruption = false
        player.play()
    }

    @discardableResult
    private func seek(_ seconds: Double) async throws -> Bool {
        playbackRevision &+= 1
        pendingSeek?.cancel()
        let revision = playbackRevision
        let seekingPlayer = player
        guard let seekingItem = player.currentItem else { return false }
        let time = CMTime(seconds: PlaybackValue.position(seconds, duration: current?.duration ?? 0), preferredTimescale: 600)
        let operation = LocalAudioSeek(player: seekingPlayer, item: seekingItem, time: time)
        pendingSeek = operation
        defer { if pendingSeek === operation { pendingSeek = nil } }
        let completed = try await operation.wait(timeout: seekTimeout)
        // Reset, deletion, or a source change can supersede this asynchronous seek.
        return completed && revision == playbackRevision && seekingPlayer === player && seekingItem === player.currentItem
    }

    private func skip(_ direction: Int) throws {
        guard !library.isEmpty else { throw NativeFailure(code: "empty_library", message: "Import audio from Files first.") }
        let playing = wantsPlayback
        guard queue.advance(by: direction, wrapping: repeating), let record = current else {
            throw NativeFailure(code: "queue_boundary", message: direction > 0 ? "This is the last file." : "This is the first file.")
        }
        load(record)
        if playing { try play() }
    }

    private func finished() {
        guard active, wantsPlayback, !interruptionInProgress else { return }
        if queue.advance(by: 1, wrapping: repeating), let record = current {
            load(record)
            do { try play() } catch { failed("audio_session_failed", "Press Play to continue.") }
        } else {
            cancelPlaybackIntent()
            stopped = true
        }
        diagnostics.record("local.track_finished")
        changed()
    }

    private func interrupted(_ note: Notification) {
        guard active, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            if !interruptionInProgress { resumeAfterInterruption = wantsPlayback }
            interruptionInProgress = true
            playbackRevision &+= 1
            pendingSeek?.cancel()
            pendingSeek = nil
            // The toggle now represents the observed pause. The separate
            // resume flag remembers intent only for a matching ended event.
            wantsPlayback = false
            player.pause()
            diagnostics.record("local.interruption_began")
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            let wasInterrupted = interruptionInProgress
            let resume = wasInterrupted && resumeAfterInterruption && options.contains(.shouldResume)
            interruptionInProgress = false
            resumeAfterInterruption = false
            if resume { do { try play() } catch { failed("audio_session_failed", "Press Play to resume audio.") } }
            else if wasInterrupted { cancelPlaybackIntent() }
            diagnostics.record("local.interruption_ended")
        }
        changed()
    }

    private func failed(_ code: String, _ text: String) {
        cancelPlaybackIntent()
        error = code
        message = text
        diagnostics.record("local.playback_failed", code: code)
        changed()
    }

    private func progressChanged() {
        guard active else { return }
        // Previous becomes available after three seconds even without a
        // transport change. Only write flags whose values actually changed.
        updateRemoteCommandAvailability()
        onStateChanged?()
    }

    private func changed() {
        guard active else { return }
        updateRemoteCommandAvailability()
        // MediaPlayer extrapolates elapsed time from this position/rate anchor.
        // Refresh it for transport changes and seeks, not each progress tick.
        updateNowPlaying()
        onStateChanged?()
    }

    private func updateNowPlaying() {
        guard let record = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        // AVPlayer can retain a requested rate while waiting for data. Only
        // extrapolate lock-screen progress while its clock is actually moving.
        let rate: Float = player.timeControlStatus == .playing ? player.rate : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: record.name, MPMediaItemPropertyArtist: record.artist,
            MPMediaItemPropertyAlbumTitle: record.album, MPMediaItemPropertyPlaybackDuration: record.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyIsLiveStream: false]
        MPNowPlayingInfoCenter.default().playbackState = rate > 0 ? .playing : (stopped ? .stopped : .paused)
    }

    private func updateRemoteCommandAvailability() {
        let center = MPRemoteCommandCenter.shared()
        func setEnabled(_ command: MPRemoteCommand, _ enabled: Bool) {
            if command.isEnabled != enabled { command.isEnabled = enabled }
        }
        setEnabled(center.playCommand, !library.isEmpty)
        setEnabled(center.pauseCommand, wantsPlayback)
        setEnabled(center.togglePlayPauseCommand, !library.isEmpty)
        setEnabled(center.stopCommand, current != nil && !stopped)
        setEnabled(center.nextTrackCommand, canSkipNext)
        setEnabled(center.previousTrackCommand, canSkipPrevious)
        setEnabled(center.changePlaybackPositionCommand, current != nil)
    }

    private func installRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func bind(_ remote: MPRemoteCommand, _ action: String) {
            remote.isEnabled = true
            let token = remote.addTarget { [weak self] event in
                Task { @MainActor in
                    guard let self, self.active else { return }
                    let arg: Any? = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                    do { try await self.command(action, arg: arg) }
                    catch { self.diagnostics.record("local.remote_failed", command: action, code: "command_failed") }
                }
                return .success
            }
            remoteTargets.append((remote, token))
        }
        bind(center.playCommand, "play")
        bind(center.pauseCommand, "pause")
        bind(center.togglePlayPauseCommand, "playpause")
        bind(center.stopCommand, "stop")
        bind(center.nextTrackCommand, "next")
        bind(center.previousTrackCommand, "previous")
        bind(center.changePlaybackPositionCommand, "seek")
    }
}
