import Foundation
import Security
import SpotifyiOS
import UIKit

/// Validation stays independent of the SDK so malformed links never reach App Remote.
enum SpotifyInput {
    static let redirectURI = "nostalgify://spotify-login-callback"

    static func configuration(clientID: String, redirectURI: String) throws -> (String, URL) {
        let identifier = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard identifier.range(of: "\\A[A-Fa-f0-9]{32}\\z", options: .regularExpression) != nil else {
            throw NativeFailure(code: "spotify_configuration", message: "Enter the public Client ID from your Spotify developer app, not its secret.")
        }
        // This scheme is registered in Info.plist. Arbitrary redirects cannot return to this binary.
        guard redirectURI == Self.redirectURI, let redirect = URL(string: redirectURI) else {
            throw NativeFailure(code: "spotify_redirect", message: "Register nostalgify://spotify-login-callback exactly in your Spotify app settings.")
        }
        return (identifier, redirect)
    }

    static func playbackURI(_ input: String) throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048 else {
            throw NativeFailure(code: "spotify_uri", message: "That Spotify link is too long.")
        }
        let pattern = "\\Aspotify:(track|album|artist|playlist|episode):[A-Za-z0-9]{22}\\z"
        if value.range(of: pattern, options: .regularExpression) != nil { return value }
        if let components = URLComponents(string: value), components.scheme == "https",
           components.host == "open.spotify.com", components.port == nil,
           components.user == nil, components.password == nil, components.fragment == nil {
            var parts = components.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            if parts.first?.range(of: "\\Aintl-[a-zA-Z-]{2,10}\\z", options: .regularExpression) != nil {
                parts.removeFirst()
            }
            if parts.count == 2 {
                let uri = "spotify:\(parts[0]):\(parts[1])"
                if uri.range(of: pattern, options: .regularExpression) != nil { return uri }
            }
        }
        throw NativeFailure(code: "spotify_uri", message: "Use a Spotify track, album, artist, playlist or episode link. Liked Songs and shortened links are not supported.")
    }

    static func isAuthorizationCallback(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == "nostalgify" && components.host == "spotify-login-callback"
            && components.path.isEmpty && components.port == nil
            && components.user == nil && components.password == nil
    }

    static func seekMilliseconds(_ input: Any?, duration: Double) throws -> Int {
        guard let number = input as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw NativeFailure(code: "invalid_argument", message: "Seek position must be a number of seconds.")
        }
        let seconds = number.doubleValue
        guard seconds.isFinite, seconds >= 0, duration.isFinite, duration > 0 else {
            throw NativeFailure(code: "invalid_argument", message: "Choose a valid position in the current track.")
        }
        let milliseconds = (min(seconds, duration) * 1000).rounded(.down)
        // Double(Int.max) rounds upward on 64-bit platforms; converting that value traps.
        guard milliseconds.isFinite, milliseconds < Double(Int.max) else {
            throw NativeFailure(code: "invalid_argument", message: "That seek position is out of range.")
        }
        return Int(milliseconds)
    }
}

/// Awaits an SDK connection event without polling, blocking the main actor, or
/// leaving a continuation behind when a caller cancels or Spotify never answers.
@MainActor
final class SpotifyConnectionWaiter {
    private struct Pending {
        let continuation: CheckedContinuation<Void, Error>
        let timeout: Task<Void, Never>
    }
    private var pending: [UUID: Pending] = [:]

    func wait(timeoutNanoseconds: UInt64 = 12_000_000_000, start: () -> Void) async throws {
        let id = UUID()
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let timeout = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: timeoutNanoseconds) } catch { return }
                    self?.finish(id, result: .failure(NativeFailure(code: "spotify_connection_timeout", message: "Spotify did not respond. Tap Connect Spotify to open Spotify and reconnect.")))
                }
                pending[id] = Pending(continuation: continuation, timeout: timeout)
                start()
            }
        }, onCancel: {
            Task { @MainActor [weak self] in self?.finish(id, result: .failure(CancellationError())) }
        })
        try Task.checkCancellation()
    }

    func complete(_ result: Result<Void, Error>) {
        let waiting = pending
        pending.removeAll()
        for request in waiting.values {
            request.timeout.cancel()
            request.continuation.resume(with: result)
        }
    }

    private func finish(_ id: UUID, result: Result<Void, Error>) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.continuation.resume(with: result)
    }
}

/// Spotify remains the audio owner. This service never opens an AVAudioSession,
/// manufactures audio, or pauses Spotify merely because Nostalgify backgrounds.
@MainActor
final class SpotifyRemoteService: NSObject, SPTAppRemoteDelegate, SPTAppRemotePlayerStateDelegate {
    var onStateChanged: (() -> Void)?

    private let diagnostics: NativeDiagnostics
    private let defaults: UserDefaults
    private var remote: SPTAppRemote?
    private var clientID: String?
    private var redirectURL: URL?
    private var playerState: SPTAppRemotePlayerState?
    private var positionReceivedAt = ProcessInfo.processInfo.systemUptime
    private var artworkURI: String?
    private var artworkDataURL = ""
    private var foreground = true
    private var wantsConnection = false
    private var authorizing = false
    private var connecting = false
    private var mayHaveActivePlayback = false
    private var generation = UUID()
    private var connectionTimeout: Task<Void, Never>?
    private let connectionWaiter = SpotifyConnectionWaiter()
    private var authorizationTimeout: Task<Void, Never>?
    private var failure: NativeFailure?
    private var statusMessage = "Add your Spotify Client ID in Settings, then connect."

    private struct PendingRequest {
        let continuation: CheckedContinuation<Any?, Error>
        let timeout: Task<Void, Never>
    }
    private var requests: [UUID: PendingRequest] = [:]
    private static let clientIDKey = "nostalgify.spotify.client-id"
    private static let redirectKey = "nostalgify.spotify.redirect-uri"

    init(diagnostics: NativeDiagnostics, defaults: UserDefaults = .standard) {
        self.diagnostics = diagnostics
        self.defaults = defaults
        super.init()
        if let identifier = defaults.string(forKey: Self.clientIDKey) {
            do {
                try configure(clientId: identifier, redirectURI: defaults.string(forKey: Self.redirectKey) ?? SpotifyInput.redirectURI)
            } catch let error as NativeFailure {
                setFailure(error.code, error.message)
            } catch {
                setFailure("spotify_configuration", "Check your Spotify Client ID and registered redirect in Settings.")
            }
        }
    }

    func configure(clientId: String, redirectURI: String) throws {
        let (identifier, redirect) = try SpotifyInput.configuration(clientID: clientId, redirectURI: redirectURI)
        if clientID == identifier, redirectURL == redirect, remote != nil { return }
        let savedID = defaults.string(forKey: Self.clientIDKey)
        let savedRedirect = defaults.string(forKey: Self.redirectKey)
        if (savedID != nil && savedID != identifier) || (savedRedirect != nil && savedRedirect != redirectURI) {
            try SpotifyTokenStore.delete()
        }
        disconnect()
        remote = nil
        playerState = nil
        artworkURI = nil
        artworkDataURL = ""
        let configuration = SPTConfiguration(clientID: identifier, redirectURL: redirect)
        // SDK diagnostics may contain URLs or metadata. Only our fixed event codes are recorded.
        let instance = SPTAppRemote(configuration: configuration, logLevel: .none)
        instance.delegate = self
        instance.connectionParameters.accessToken = try SpotifyTokenStore.read()
        clientID = identifier
        redirectURL = redirect
        remote = instance
        defaults.set(identifier, forKey: Self.clientIDKey)
        defaults.set(redirectURI, forKey: Self.redirectKey)
        wantsConnection = instance.connectionParameters.accessToken != nil
        failure = nil
        statusMessage = "Connect to Spotify. Spotify may open briefly and resume your music."
        notify()
    }

    /// Explicit user action: authorization can switch apps and start Spotify playback.
    func connect() throws {
        guard let remote else {
            throw NativeFailure(code: "spotify_configuration", message: "Add your Spotify Client ID in Settings first.")
        }
        guard !authorizing else { return }
        if remote.isConnected { return }
        closeTransport()
        wantsConnection = true
        foreground = true
        authorizing = true
        connecting = false
        failure = nil
        statusMessage = "Finish connecting in Spotify, then return to Nostalgify."
        let attempt = UUID()
        generation = attempt
        mayHaveActivePlayback = true
        diagnostics.record("spotify_authorization_started")
        authorizationTimeout?.cancel()
        authorizationTimeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 120_000_000_000) } catch { return }
            guard let self, self.generation == attempt, self.authorizing else { return }
            self.authorizing = false
            self.setFailure("spotify_authorization_timeout", "Spotify did not finish connecting. Check your Client ID, redirect and allowed Spotify account, then reconnect.")
        }
        remote.authorizeAndPlayURI("") { [weak self, weak remote] installed in
            guard let self, let remote, self.remote === remote, self.generation == attempt else { return }
            if !installed {
                self.authorizing = false
                self.mayHaveActivePlayback = false
                self.authorizationTimeout?.cancel()
                self.setFailure("spotify_not_installed", "Install Spotify on this iPad and sign in, then connect again.")
            }
        }
        notify()
    }

    func handleURL(_ url: URL) -> Bool {
        guard SpotifyInput.isAuthorizationCallback(url) else { return false }
        // Ignore stale callbacks after logout/provider switch, and unsolicited custom-scheme URLs.
        guard authorizing, wantsConnection, let remote else { return true }
        authorizing = false
        authorizationTimeout?.cancel()
        guard let token = remote.authorizationParameters(from: url)?[SPTAppRemoteAccessTokenKey],
              !token.isEmpty, token.utf8.count <= 16_384 else {
            setFailure("spotify_authorization_denied", "Spotify did not authorize this app. Check the registered redirect and allowed account, then connect again.")
            return true
        }
        do {
            try SpotifyTokenStore.write(token)
            remote.connectionParameters.accessToken = token
            failure = nil
            diagnostics.record("spotify_authorization_completed")
            if foreground { connectTransport() }
        } catch {
            remote.connectionParameters.accessToken = nil
            setFailure("spotify_token_storage", "Could not securely save Spotify authorization. Unlock this iPad and try connecting again.")
        }
        return true
    }

    func disconnect() {
        wantsConnection = false
        authorizing = false
        authorizationTimeout?.cancel()
        closeTransport()
        statusMessage = "Spotify disconnected. Playback remains controlled by Spotify."
        notify()
    }

    func logout() throws {
        disconnect()
        remote?.connectionParameters.accessToken = nil
        playerState = nil
        artworkURI = nil
        artworkDataURL = ""
        do { try SpotifyTokenStore.delete() } catch {
            setFailure("spotify_token_storage", "Spotify disconnected, but its saved authorization could not be removed. Unlock the iPad and retry disconnecting your account.")
            throw error
        }
        failure = nil
        statusMessage = "Spotify authorization removed from this iPad. Playback may continue in Spotify."
        diagnostics.record("spotify_logged_out")
        notify()
    }

    func suspend() {
        foreground = false
        if remote?.isConnected == true { mayHaveActivePlayback = true }
        closeTransport(preserveAuthorization: true)
    }

    func resume() {
        foreground = true
        guard wantsConnection, !authorizing, remote?.connectionParameters.accessToken != nil else { return }
        connectTransport() // Never opens Spotify or starts music automatically on foregrounding.
    }

    /// Source selection can finish before App Remote connects. Playback commands
    /// await that connection here; only the explicit Connect action can authorize.
    func prepareForPlayback() async throws {
        try Task.checkCancellation()
        guard let remote else {
            throw NativeFailure(code: "spotify_configuration", message: "Add your Spotify Client ID in Settings, then tap Connect Spotify.")
        }
        guard wantsConnection, remote.connectionParameters.accessToken != nil, !authorizing else {
            throw NativeFailure(code: "spotify_disconnected", message: "Tap Connect Spotify and finish authorization before using playback controls.")
        }
        guard foreground else {
            throw NativeFailure(code: "spotify_disconnected", message: "Return to Nostalgify before using Spotify playback controls.")
        }
        if remote.isConnected { return }
        let session = generation
        do {
            try await connectionWaiter.wait { connectTransport() }
            try Task.checkCancellation()
            guard foreground, wantsConnection, self.remote === remote,
                  generation == session, remote.isConnected else {
                throw NativeFailure(code: "spotify_disconnected", message: "Spotify disconnected. Tap Connect Spotify before using playback controls.")
            }
        } catch is CancellationError {
            throw NativeFailure(code: "spotify_connection_cancelled", message: "Connecting to Spotify was cancelled. Try the playback control again when ready.")
        } catch let error as NativeFailure {
            setFailure(error.code, error.message)
            throw error
        }
    }

    func command(_ command: String, arg: Any?) async throws {
        var playbackMayHaveStarted = false
        do {
            switch command {
            case "connect": try connect(); return
            case "disconnect": disconnect(); return
            case "logout": try logout(); return
            case "volume":
                throw NativeFailure(code: "unsupported", message: "Use the iPad volume buttons or Control Centre for Spotify volume.")
            case "playUri", "playShelf":
                guard let value = arg as? String else { throw invalidArgument() }
                let uri = try SpotifyInput.playbackURI(value)
                playbackMayHaveStarted = remote?.isConnected == true
                _ = try await request { $0.play(uri, callback: $1) }
                mayHaveActivePlayback = true
            case "play", "playOrFallback":
                playbackMayHaveStarted = remote?.isConnected == true
                _ = try await request { $0.resume($1) }
                mayHaveActivePlayback = true
            case "playpause":
                guard let state = try await request({ $0.getPlayerState($1) }) as? SPTAppRemotePlayerState else {
                    throw NativeFailure(code: "spotify_state_unavailable", message: "Spotify playback state is unavailable. Reconnect and try again.")
                }
                if state.isPaused {
                    playbackMayHaveStarted = true
                    _ = try await request { $0.resume($1) }
                    mayHaveActivePlayback = true
                } else {
                    _ = try await request { $0.pause($1) }
                }
            case "pause":
                _ = try await request { $0.pause($1) }
            case "stop":
                _ = try await request { $0.pause($1) }
                if playerState?.playbackRestrictions.canSeek == true {
                    _ = try await request { $0.seek(toPosition: 0, callback: $1) }
                }
            case "next":
                try require(playerState?.playbackRestrictions.canSkipNext == true)
                _ = try await request { $0.skip(toNext: $1) }
            case "previous":
                try require(playerState?.playbackRestrictions.canSkipPrevious == true)
                _ = try await request { $0.skip(toPrevious: $1) }
            case "seek":
                try require(playerState?.playbackRestrictions.canSeek == true)
                let position = try SpotifyInput.seekMilliseconds(arg, duration: Double(playerState?.track.duration ?? 0) / 1000)
                _ = try await request { $0.seek(toPosition: position, callback: $1) }
            case "shuffle":
                try require(playerState?.playbackRestrictions.canToggleShuffle == true)
                let enabled = try boolean(arg)
                _ = try await request { $0.setShuffle(enabled, callback: $1) }
            case "repeat":
                try require(playerState?.playbackRestrictions.canRepeatContext == true)
                let mode: SPTAppRemotePlaybackOptionsRepeatMode = try boolean(arg) ? .context : .off
                _ = try await request { $0.setRepeatMode(mode, callback: $1) }
            default:
                throw NativeFailure(code: "unsupported", message: "That control is not supported by Spotify on iPad.")
            }
            failure = nil
            statusMessage = ""
            refreshState()
        } catch let error as NativeFailure {
            if playbackMayHaveStarted { mayHaveActivePlayback = true }
            setFailure(error.code, error.message)
            throw error
        } catch {
            if playbackMayHaveStarted { mayHaveActivePlayback = true }
            let safe = NativeFailure(code: "spotify_command_failed", message: "Spotify could not complete that action. Open Spotify to check playback or reconnect.")
            setFailure(safe.code, safe.message)
            throw safe
        }
    }

    /// A switch must not start a second provider until Spotify acknowledges a pause.
    func pauseBeforeProviderSwitch() async throws {
        guard remote?.isConnected == true else {
            if mayHaveActivePlayback || authorizing {
                throw NativeFailure(code: "spotify_pause_unconfirmed", message: "Reconnect to Spotify so Nostalgify can pause it before switching to local files.")
            }
            return
        }
        _ = try await request { $0.pause($1) }
        guard let state = try await request({ $0.getPlayerState($1) }) as? SPTAppRemotePlayerState,
              state.isPaused else {
            throw NativeFailure(code: "spotify_pause_unconfirmed", message: "Spotify has not confirmed it paused. Try switching again after pausing Spotify.")
        }
        accept(state)
        mayHaveActivePlayback = false
    }

    func snapshot() -> [String: Any] {
        let connected = remote?.isConnected == true
        // A disconnected remote cannot report whether Spotify is still playing.
        let state = connected ? playerState : nil
        let restrictions = connected ? state?.playbackRestrictions : nil
        let elapsed = connected && state?.isPaused == false
            ? max(0, ProcessInfo.processInfo.systemUptime - positionReceivedAt) * Double(state?.playbackSpeed ?? 1) : 0
        let duration = Double(state?.track.duration ?? 0) / 1000
        var track: Any = NSNull()
        if let state {
            track = ["id": state.track.uri, "name": state.track.name,
                     "artist": state.track.artist.name, "album": state.track.album.name,
                     "duration": duration, "artworkUrl": artworkDataURL] as [String: Any]
        }
        return [
            "provider": "spotify", "configured": remote != nil, "connected": connected,
            "authorizing": authorizing, "connecting": connecting, "running": connected,
            "state": connected && state?.isPaused == false ? "playing" : (state == nil ? "stopped" : "paused"),
            "position": min(duration, max(0, Double(state?.playbackPosition ?? 0) / 1000 + elapsed)),
            "volume": 100.0, "shuffle": state?.playbackOptions.isShuffling ?? false,
            "repeat": state.map { $0.playbackOptions.repeatMode != .off } ?? false,
            "track": track, "error": failure.map { $0.code as Any } ?? NSNull(), "message": statusMessage,
            "capabilities": ["canSeek": restrictions?.canSeek ?? false, "canSetVolume": false,
                             "canSkipNext": restrictions?.canSkipNext ?? false,
                             "canSkipPrevious": restrictions?.canSkipPrevious ?? false,
                             "canShuffle": restrictions?.canToggleShuffle ?? false,
                             "canRepeat": restrictions?.canRepeatContext ?? false]
        ]
    }

    private func connectTransport() {
        guard foreground, wantsConnection, let remote, !remote.isConnected, !connecting,
              remote.connectionParameters.accessToken != nil else { return }
        connecting = true
        failure = nil
        statusMessage = "Connecting to Spotify…"
        let attempt = generation
        connectionTimeout?.cancel()
        connectionTimeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 12_000_000_000) } catch { return }
            guard let self, self.generation == attempt, self.connecting else { return }
            self.closeTransport()
            self.setFailure("spotify_connection_timeout", "Spotify did not respond. Tap Connect to open Spotify and reconnect.")
        }
        remote.connect()
        notify()
    }

    private func closeTransport(preserveAuthorization: Bool = false) {
        if !preserveAuthorization || !authorizing { generation = UUID() }
        connecting = false
        connectionTimeout?.cancel()
        connectionWaiter.complete(.failure(NativeFailure(code: "spotify_disconnected", message: "Spotify disconnected. Tap Connect Spotify before using playback controls.")))
        cancelPendingRequests()
        // App Remote releases its APIs on disconnect; their delegate is weak and nonnull in the SDK.
        remote?.disconnect()
    }

    private func cancelPendingRequests() {
        let outstanding = requests
        requests.removeAll()
        for request in outstanding.values {
            request.timeout.cancel()
            request.continuation.resume(throwing: NativeFailure(code: "spotify_disconnected", message: "Spotify disconnected. Reconnect before using playback controls."))
        }
    }

    private func request(_ action: (SPTAppRemotePlayerAPI, @escaping SPTAppRemoteCallback) -> Void) async throws -> Any? {
        guard foreground, let remote, remote.isConnected, let api = remote.playerAPI else {
            throw NativeFailure(code: "spotify_disconnected", message: "Tap Connect to open Spotify and reconnect before using playback controls.")
        }
        let session = generation
        return try await withCheckedThrowingContinuation { continuation in
            let id = UUID()
            let timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 12_000_000_000) } catch { return }
                self?.finishRequest(id, result: .failure(NativeFailure(code: "spotify_command_timeout", message: "Spotify did not confirm that action. Check Spotify before trying again.")))
            }
            requests[id] = PendingRequest(continuation: continuation, timeout: timeout)
            action(api) { [weak self, weak remote] result, error in
                guard let self, let remote, self.remote === remote, self.generation == session else { return }
                if error != nil || result == nil || (result as? NSNumber)?.boolValue == false {
                    self.finishRequest(id, result: .failure(NativeFailure(code: "spotify_command_failed", message: "Spotify could not complete that action. Check playback restrictions in Spotify or reconnect.")))
                } else {
                    self.finishRequest(id, result: .success(result))
                }
            }
        }
    }

    private func finishRequest(_ id: UUID, result: Result<Any?, Error>) {
        guard let request = requests.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.continuation.resume(with: result)
    }

    private func refreshState() {
        guard let remote, remote.isConnected else { return }
        let session = generation
        remote.playerAPI?.getPlayerState { [weak self, weak remote] result, error in
            guard let self, let remote, self.remote === remote, self.generation == session, remote.isConnected else { return }
            if let state = result as? SPTAppRemotePlayerState, error == nil { self.accept(state) }
        }
    }

    private func accept(_ state: SPTAppRemotePlayerState) {
        guard remote?.isConnected == true, foreground, wantsConnection else { return }
        playerState = state
        positionReceivedAt = ProcessInfo.processInfo.systemUptime
        mayHaveActivePlayback = !state.isPaused
        if artworkURI != state.track.uri {
            artworkURI = state.track.uri
            artworkDataURL = ""
            let uri = state.track.uri
            let session = generation
            remote?.imageAPI?.fetchImage(forItem: state.track, with: CGSize(width: 256, height: 256)) { [weak self] result, error in
                guard let self, self.generation == session, self.artworkURI == uri,
                      error == nil, let image = result as? UIImage,
                      let data = image.jpegData(compressionQuality: 0.8), data.count <= 262_144 else { return }
                self.artworkDataURL = "data:image/jpeg;base64," + data.base64EncodedString()
                self.notify()
            }
        }
        notify()
    }

    func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
        guard remote === appRemote, foreground, wantsConnection, !authorizing else { appRemote.disconnect(); return }
        connectionTimeout?.cancel()
        connecting = false
        authorizing = false
        failure = nil
        statusMessage = ""
        appRemote.playerAPI?.delegate = self
        let session = generation
        appRemote.playerAPI?.subscribe(toPlayerState: { [weak self, weak appRemote] _, error in
            guard let self, let appRemote, self.remote === appRemote, self.generation == session else { return }
            if error != nil {
                self.closeTransport()
                self.setFailure("spotify_subscription_failed", "Spotify playback updates stopped. Reconnect to restore the controls.")
            }
        })
        diagnostics.record("spotify_connected")
        refreshState()
        connectionWaiter.complete(.success(()))
        notify()
    }

    func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
        guard remote === appRemote, foreground, wantsConnection, !authorizing else { return }
        closeTransport()
        setFailure("spotify_connection_failed", "Open Spotify and start playback, then tap Connect. If needed, check your Client ID, registered redirect and allowed account.")
    }

    func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {
        guard remote === appRemote else { return }
        connecting = false
        connectionTimeout?.cancel()
        connectionWaiter.complete(.failure(NativeFailure(code: "spotify_disconnected", message: "Spotify disconnected. Tap Connect Spotify before using playback controls.")))
        cancelPendingRequests()
        if error != nil, foreground, wantsConnection, !authorizing {
            closeTransport()
            setFailure("spotify_disconnected", "Spotify disconnected. Tap Connect to open Spotify and resume controlling playback.")
        }
        notify()
    }

    func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) { accept(playerState) }

    private func require(_ capability: Bool) throws {
        guard remote?.isConnected == true else {
            throw NativeFailure(code: "spotify_disconnected", message: "Reconnect to Spotify before using playback controls.")
        }
        guard capability else {
            throw NativeFailure(code: "spotify_restricted", message: "Spotify does not currently allow that control for this track or account.")
        }
    }

    private func boolean(_ value: Any?) throws -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw invalidArgument() }
        return number.boolValue
    }

    private func invalidArgument() -> NativeFailure {
        NativeFailure(code: "invalid_argument", message: "That playback control received an invalid value.")
    }

    private func setFailure(_ code: String, _ message: String) {
        failure = NativeFailure(code: code, message: message)
        statusMessage = message
        diagnostics.record("spotify_failure", code: code)
        notify()
    }

    private func notify() { onStateChanged?() }
}

/// Tokens never cross the JavaScript bridge, enter preferences, or appear in logs.
private enum SpotifyTokenStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "nostalgify") + ".spotify",
         kSecAttrAccount as String: "app-remote-access-token"]
    }

    static func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { throw failure }
        return token
    }

    static func write(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8),
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = query.merging(attributes) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw failure }
        } else if status != errSecSuccess { throw failure }
    }

    static func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure }
    }

    private static var failure: NativeFailure {
        NativeFailure(code: "spotify_token_storage", message: "Spotify authorization could not be accessed securely. Unlock this iPad and try again.")
    }
}
