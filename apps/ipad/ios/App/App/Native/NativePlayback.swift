import Foundation
import UIKit

/// One coordinator per application, independent of the lifetime of a JS bridge.
@MainActor
final class NativePlayback {
    static let shared: NativePlayback = {
        #if DEBUG
        if let fixture = NativeUITestFixture.configuration {
            return NativePlayback(defaults: fixture.defaults, localDirectory: fixture.libraryDirectory)
        }
        #endif
        return NativePlayback()
    }()
    let diagnostics = NativeDiagnostics()
    let local: LocalAudioService
    let spotify: SpotifyRemoteService
    private(set) var provider: String
    private var sequence: Int = 0
    private var listeners: [UUID: ([String: Any]) -> Void] = [:]
    private var commandTail: Task<Void, Error>?
    private var foreground = UIApplication.shared.applicationState == .active
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, localDirectory: URL? = nil,
         localService: LocalAudioService? = nil) {
        self.defaults = defaults
        provider = defaults.string(forKey: "nostalgify.provider") == "local" ? "local" : "spotify"
        local = localService ?? LocalAudioService(diagnostics: diagnostics, directory: localDirectory)
        spotify = SpotifyRemoteService(diagnostics: diagnostics, defaults: defaults)
        local.onStateChanged = { [weak self] in if self?.provider == "local" { self?.publish() } }
        spotify.onStateChanged = { [weak self] in if self?.provider == "spotify" { self?.publish() } }
        if provider == "local" { try? local.setActive(true) }
        diagnostics.record("app.started")
    }

    func snapshot() -> [String: Any] {
        var state = provider == "local" ? local.snapshot() : spotify.snapshot()
        state["provider"] = provider
        state["sequence"] = sequence
        return state
    }

    func subscribe(id: UUID, listener: @escaping ([String: Any]) -> Void) {
        listeners[id] = listener
        if foreground { listener(snapshot()) }
    }

    func unsubscribe(id: UUID) { listeners.removeValue(forKey: id) }

    func publish() {
        sequence += 1
        // Native playback and command replies remain current while the WebView
        // is inactive. Foregrounding publishes one fresh snapshot to listeners.
        guard foreground, !listeners.isEmpty else { return }
        let value = snapshot()
        Array(listeners.values).forEach { $0(value) }
    }

    func becameActive() {
        foreground = true
        diagnostics.record("app.active")
        if provider == "spotify" { spotify.resume() }
        publish()
    }

    func becameInactive() {
        foreground = false
        diagnostics.record("app.inactive")
        spotify.suspend()
        // Local AVPlayer continues in the genuine background-audio mode.
    }

    @discardableResult
    func handleURL(_ url: URL) -> Bool { spotify.handleURL(url) }

    func configureSpotify(clientId: String, redirectURI: String) throws {
        try spotify.configure(clientId: clientId, redirectURI: redirectURI)
        publish()
    }

    func connectSpotify() async throws {
        try await enqueue {
            guard self.foreground else {
                throw NativeFailure(code: "spotify_disconnected", message: "Return to Nostalgify before connecting Spotify.")
            }
            try await self.select("spotify")
            try self.spotify.connect()
        }
    }

    func disconnectSpotify() async throws {
        try await enqueue { self.spotify.disconnect(); self.publish() }
    }

    func command(_ name: String, arg: Any?, requestID: String?) async throws {
        guard NativeDiagnostics.commands.contains(name) else {
            throw NativeFailure(code: "unsupported_command", message: "That control is not supported.")
        }
        let started = ProcessInfo.processInfo.systemUptime
        diagnostics.record("command.started", requestId: requestID, command: name)
        do {
            try await enqueue {
                if name == "provider" {
                    guard let next = arg as? String else {
                        throw NativeFailure(code: "invalid_provider", message: "Choose Spotify or Local Files.")
                    }
                    try await self.select(next)
                } else if name == "logout" {
                    // Account management is independent of the selected audio provider.
                    try self.spotify.logout()
                } else if name == "eject" {
                    guard self.provider == "spotify", let url = URL(string: "spotify:") else { return }
                    let opened = await UIApplication.shared.open(url)
                    if !opened { throw NativeFailure(code: "spotify_not_installed", message: "Install Spotify on this iPad first.") }
                } else if self.provider == "local" {
                    try await self.local.command(name, arg: arg)
                } else {
                    try await self.spotify.prepareForPlayback()
                    try await self.spotify.command(name, arg: arg)
                }
                self.publish()
            }
            diagnostics.record("command.completed", requestId: requestID, command: name,
                durationMs: (ProcessInfo.processInfo.systemUptime - started) * 1000)
        } catch {
            diagnostics.record("command.failed", requestId: requestID, command: name,
                durationMs: (ProcessInfo.processInfo.systemUptime - started) * 1000,
                code: (error as? NativeFailure)?.code ?? "native_error")
            throw error
        }
    }

    /// Async Spotify callbacks must not let a later play/switch overtake an earlier pause.
    private func enqueue(_ work: @escaping @MainActor () async throws -> Void) async throws {
        let previous = commandTail
        let task = Task { @MainActor in
            _ = try? await previous?.value
            try Task.checkCancellation()
            try await work()
        }
        commandTail = task
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func select(_ next: String) async throws {
        guard ["spotify", "local"].contains(next) else {
            throw NativeFailure(code: "invalid_provider", message: "Choose Spotify or Local Files.")
        }
        guard next != provider else { return }
        if provider == "spotify" {
            // Never start a second source while the old source might still be playing.
            try await spotify.pauseBeforeProviderSwitch()
            spotify.suspend()
            try local.setActive(true)
        } else {
            local.pauseBeforeProviderSwitch()
            try local.setActive(false)
        }
        provider = next
        defaults.set(next, forKey: "nostalgify.provider")
        diagnostics.record("provider.changed", code: next)
        if next == "spotify", foreground { spotify.resume() }
        publish()
    }

    func getPreferences() -> [String: Any] {
        guard let data = defaults.data(forKey: "nostalgify.ui"),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }

    func setPreferences(_ value: [String: Any]) throws {
        func containsSecret(_ object: Any) -> Bool {
            if let values = object as? [String: Any] {
                return values.contains { key, value in
                    let name = key.lowercased()
                    return name.contains("token") || name.contains("secret") || name.contains("password") || containsSecret(value)
                }
            }
            if let values = object as? [Any] { return values.contains(where: containsSecret) }
            return false
        }
        guard !containsSecret(value), JSONSerialization.isValidJSONObject(value) else {
            throw NativeFailure(code: "invalid_preferences", message: "Preferences must contain settings only, without credentials.")
        }
        let data = try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
        guard data.count <= 131_072 else {
            throw NativeFailure(code: "preferences_too_large", message: "There are too many saved settings.")
        }
        defaults.set(data, forKey: "nostalgify.ui")
    }
}
