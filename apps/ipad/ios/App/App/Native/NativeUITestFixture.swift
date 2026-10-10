#if DEBUG
import Foundation

/// App-only test setup: the production bridge and AVPlayer still execute every
/// UI action. A UUID isolates each test's native preferences and library from
/// normal application data; reusing it across launches verifies persistence.
/// Release builds contain neither this type nor the launch argument hook.
@MainActor
enum NativeUITestFixture {
    struct Configuration {
        let identifier: UUID
        let defaults: UserDefaults
        let libraryDirectory: URL

        init?(arguments: [String]) {
            guard let flag = arguments.firstIndex(of: "--ui-testing"),
                  arguments.indices.contains(flag + 1),
                  let identifier = UUID(uuidString: arguments[flag + 1]),
                  let defaults = UserDefaults(suiteName: "dev.nostalgify.ipad.uitests." + identifier.uuidString) else { return nil }
            self.identifier = identifier
            self.defaults = defaults
            self.libraryDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("UIAutomation", isDirectory: true)
                .appendingPathComponent(identifier.uuidString, isDirectory: true)
        }
    }

    static let configuration = Configuration(arguments: ProcessInfo.processInfo.arguments)

    static func prepare() async throws {
        guard let configuration else { return }
        let playback = NativePlayback.shared
        if !configuration.defaults.bool(forKey: "fixture.seeded") {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            for title in ["UI Test One", "UI Test Two"] {
                let source = folder.appendingPathComponent(title + ".wav")
                try NativeSelfCheck.fixture(at: source, seconds: 120)
                let result = try await playback.local.importFiles([source])
                guard result.items.count == 1 else {
                    throw NativeFailure(code: "uitest_fixture_failed", message: "The UI test audio fixture could not be imported.")
                }
            }
            configuration.defaults.set(true, forKey: "fixture.seeded")
        }
        // Exercise the real service silently. Do not autoplay or configure an
        // account; tests must explicitly invoke playback through visible UI.
        try playback.local.setActive(true)
        try await playback.local.command("volume", arg: 0)
        try playback.local.setActive(playback.provider == "local")
    }
}
#endif
