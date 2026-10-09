import AVFoundation
import MediaPlayer
import UIKit

/// Application-owned playback survives WebView navigation, reloads, and suspension.
@MainActor
final class LocalAudioService {
    var onStateChanged: (() -> Void)?
    private(set) var library: [LocalAudioRecord] = []
    private let player = AVPlayer()
    private let diagnostics: NativeDiagnostics
    private let directory: URL
    private var queue = LocalQueue()
    private var active = false
    private var stopped = true
    private var shuffle = false
    private var repeating = false
    private var error: String?
    private var message = "Import audio from Files to start listening."
    private var resumeAfterInterruption = false
    private var notificationTokens: [NSObjectProtocol] = []
    private var periodicToken: Any?
    private var statusObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var remoteTargets: [(MPRemoteCommand, Any)] = []

    init(diagnostics: NativeDiagnostics, directory storageDirectory: URL? = nil) {
        self.diagnostics = diagnostics
        directory = storageDirectory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Audio", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("library.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let decoded = try JSONDecoder().decode([LocalAudioRecord].self, from: Data(contentsOf: url))
                library = decoded.filter { $0.isSafe && FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.filename).path) }
            }
        } catch {
            self.error = "library_read_failed"
            message = "The local library could not be read. Your audio files have not been deleted."
            diagnostics.record("local.library_read_failed")
        }
        player.automaticallyWaitsToMinimizeStalling = true
        periodicToken = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.changed() }
        }
        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.changed() }
        }
        observe(AVPlayerItem.didPlayToEndTimeNotification) { [weak self] notification in
            guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.finished()
        }
        observe(AVPlayerItem.failedToPlayToEndTimeNotification) { [weak self] notification in
            guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.failed("local_playback_failed", "This audio file could not be played.")
        }
        observe(AVAudioSession.interruptionNotification) { [weak self] note in self?.interrupted(note) }
        observe(AVAudioSession.routeChangeNotification) { [weak self] note in
            guard let self, self.active,
                  let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self.player.pause()
            self.resumeAfterInterruption = false
            self.diagnostics.record("local.route_disconnected")
            self.changed()
        }
        observe(AVAudioSession.mediaServicesWereResetNotification) { [weak self] _ in
            guard let self, self.active else { return }
            self.player.pause()
            if let record = self.current { self.load(record) }
            self.failed("audio_services_reset", "Audio services restarted. Press Play to continue.")
        }
    }

    deinit {
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
        if let token = periodicToken { player.removeTimeObserver(token) }
        remoteTargets.forEach { $0.0.removeTarget($0.1) }
        statusObservation?.invalidate()
        rateObservation?.invalidate()
    }

    private var current: LocalAudioRecord? { library.first { $0.id == queue.current } }
    private var elapsed: Double { PlaybackValue.position(player.currentTime().seconds, duration: current?.duration ?? 0) }

    private func observe(_ name: Notification.Name, handler: @escaping @MainActor (Notification) -> Void) {
        notificationTokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
            Task { @MainActor in handler(note) }
        })
    }

    func setActive(_ value: Bool) throws {
        if value == active { return }
        if !value {
            player.pause()
            resumeAfterInterruption = false
            remoteTargets.forEach { $0.0.removeTarget($0.1) }
            remoteTargets.removeAll()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
            catch { diagnostics.record("local.session_deactivate_failed") }
        }
        active = value
        if value { installRemoteCommands() }
        changed()
    }

    func pauseBeforeProviderSwitch() {
        player.pause()
        resumeAfterInterruption = false
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
                    "canSkipNext": library.count > 1, "canSkipPrevious": record != nil,
                    "canShuffle": true, "canRepeat": true]]
    }

    func importFiles(_ urls: [URL]) async throws -> (items: [LocalAudioRecord], skipped: Int) {
        var imported: [LocalAudioRecord] = []
        var skipped = 0
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
                try await Task.detached(priority: .userInitiated) {
                    try FileManager.default.copyItem(at: source, to: destination)
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
                }.value
                let asset = AVURLAsset(url: destination)
                guard try await asset.load(.isPlayable) else {
                    throw NativeFailure(code: "unsupported_audio", message: "This audio format is not supported.")
                }
                let duration = try await asset.load(.duration).seconds
                guard duration.isFinite, duration > 0 else {
                    throw NativeFailure(code: "unsupported_audio", message: "This file has no playable audio duration.")
                }
                let metadata = try await asset.load(.commonMetadata)
                func value(_ key: AVMetadataKey) -> String {
                    metadata.first { $0.commonKey == key }?.stringValue ?? ""
                }
                let title = value(.commonKeyTitle)
                let record = LocalAudioRecord(id: id, filename: filename,
                    name: title.isEmpty ? source.deletingPathExtension().lastPathComponent : title,
                    artist: value(.commonKeyArtist), album: value(.commonKeyAlbumName), duration: duration)
                try save(library + [record])
                library.append(record)
                imported.append(record)
            } catch {
                try? FileManager.default.removeItem(at: destination)
                skipped += 1
                diagnostics.record("local.import_failed", code: "unsupported_or_unreadable")
            }
        }
        if !imported.isEmpty {
            queue.reset(library.map(\.id), startingAt: queue.current, shuffled: shuffle)
            error = nil
            message = skipped > 0 ? "Some files could not be imported." : ""
            diagnostics.record("local.import_completed")
            changed()
        }
        if imported.isEmpty && !urls.isEmpty {
            throw NativeFailure(code: "import_failed", message: "No files could be imported. Choose unprotected audio files downloaded in Files and try again.")
        }
        return (imported, skipped)
    }

    func remove(id: String) throws {
        guard let record = library.first(where: { $0.id == id }) else {
            throw NativeFailure(code: "not_found", message: "That audio file is no longer in the library.")
        }
        let remaining = library.filter { $0.id != id }
        try save(remaining)
        let selected = queue.current
        if selected == id {
            player.pause()
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
            try JSONEncoder().encode(records).write(to: directory.appendingPathComponent("library.json"), options: .atomic)
        } catch {
            throw NativeFailure(code: "library_write_failed", message: "The library could not be saved. Check available iPad storage.")
        }
    }

    func command(_ command: String, arg: Any?) async throws {
        guard active else { throw NativeFailure(code: "inactive_provider", message: "Select Local Files first.") }
        switch command {
        case "play", "playOrFallback": try play()
        case "pause": player.pause(); resumeAfterInterruption = false
        case "playpause":
            if player.rate > 0 { player.pause(); resumeAfterInterruption = false } else { try play() }
        case "stop":
            player.pause(); stopped = true; resumeAfterInterruption = false
            await seek(0)
        case "seek":
            guard current != nil else { throw NativeFailure(code: "no_track", message: "Choose a local audio file first.") }
            await seek(try PlaybackValue.number(arg))
        case "volume": player.volume = Float(PlaybackValue.volume(try PlaybackValue.number(arg)) / 100)
        case "next": try skip(1)
        case "previous":
            if elapsed > 3 { await seek(0) } else { try skip(-1) }
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
        statusObservation?.invalidate()
        let item = AVPlayerItem(url: directory.appendingPathComponent(record.filename))
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
        if current == nil { queue.reset(library.map(\.id), startingAt: nil, shuffled: shuffle) }
        if player.currentItem == nil, let record = current { load(record) }
        if player.currentItem?.status == .failed, let record = current { load(record) }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            throw NativeFailure(code: "audio_session_failed", message: "The audio output is unavailable. Try Play again.")
        }
        if stopped { player.seek(to: .zero) }
        stopped = false
        error = nil
        message = ""
        player.play()
    }

    private func seek(_ seconds: Double) async {
        guard player.currentItem != nil else { return }
        let time = CMTime(seconds: PlaybackValue.position(seconds, duration: current?.duration ?? 0), preferredTimescale: 600)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { _ in continuation.resume() }
        }
    }

    private func skip(_ direction: Int) throws {
        guard !library.isEmpty else { throw NativeFailure(code: "empty_library", message: "Import audio from Files first.") }
        let playing = player.rate > 0
        guard queue.advance(by: direction, wrapping: repeating), let record = current else {
            throw NativeFailure(code: "queue_boundary", message: direction > 0 ? "This is the last file." : "This is the first file.")
        }
        load(record)
        if playing { try play() }
    }

    private func finished() {
        guard active else { return }
        if queue.advance(by: 1, wrapping: repeating), let record = current {
            load(record)
            do { try play() } catch { failed("audio_session_failed", "Press Play to continue.") }
        } else {
            player.pause()
            stopped = true
        }
        diagnostics.record("local.track_finished")
        changed()
    }

    private func interrupted(_ note: Notification) {
        guard active, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            resumeAfterInterruption = player.rate > 0
            player.pause()
            diagnostics.record("local.interruption_began")
        } else {
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            let resume = resumeAfterInterruption && options.contains(.shouldResume)
            resumeAfterInterruption = false
            if resume { do { try play() } catch { failed("audio_session_failed", "Press Play to resume audio.") } }
            diagnostics.record("local.interruption_ended")
        }
        changed()
    }

    private func failed(_ code: String, _ text: String) {
        player.pause()
        error = code
        message = text
        diagnostics.record("local.playback_failed", code: code)
        changed()
    }

    private func changed() {
        guard active else { return }
        updateNowPlaying()
        onStateChanged?()
    }

    private func updateNowPlaying() {
        guard let record = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: record.name, MPMediaItemPropertyArtist: record.artist,
            MPMediaItemPropertyAlbumTitle: record.album, MPMediaItemPropertyPlaybackDuration: record.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyIsLiveStream: false]
        MPNowPlayingInfoCenter.default().playbackState = player.rate > 0 ? .playing : (stopped ? .stopped : .paused)
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
