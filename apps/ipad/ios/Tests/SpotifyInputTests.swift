import XCTest
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
        for suffix in ["", "?access_token=fake", "#access_token=fake"] {
            XCTAssertTrue(SpotifyInput.isAuthorizationCallback(try XCTUnwrap(URL(string: SpotifyInput.redirectURI + suffix))))
        }
        for target in [
            "https://spotify-login-callback", "nostalgify://other-host",
            "nostalgify://spotify-login-callback.evil.example",
            "nostalgify://user@spotify-login-callback", "nostalgify://spotify-login-callback:123",
            "nostalgify://spotify-login-callback/extra", "nostalgify://spotify-login-callback/"
        ] {
            XCTAssertFalse(SpotifyInput.isAuthorizationCallback(try XCTUnwrap(URL(string: target))))
        }
    }

    func testSeekConvertsSecondsAndClampsToTrackDuration() throws {
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 12.345), duration: 180), 12_345)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 200), duration: 180.5), 180_500)
        XCTAssertEqual(try SpotifyInput.seekMilliseconds(NSNumber(value: 0), duration: 180), 0)
    }

    func testSeekRejectsBooleansNonFiniteValuesAndIntegerOverflow() {
        let invalid: [Any] = [true, "12", NSNumber(value: -1), NSNumber(value: Double.nan), NSNumber(value: Double.infinity)]
        for input in invalid {
            XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(input, duration: 180))
        }
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(nil, duration: 180))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(1, duration: 0))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(1, duration: .infinity))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(Double.greatestFiniteMagnitude, duration: Double.greatestFiniteMagnitude))
        XCTAssertThrowsError(try SpotifyInput.seekMilliseconds(Double(Int.max), duration: Double(Int.max)))
    }
}
