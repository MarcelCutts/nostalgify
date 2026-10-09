const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanShelf } = require("../apps/desktop/src/main/shelf");

test("legacy Spotify shelves migrate without changing order or metadata", () => {
  const saved = [
    { kind: "album", uri: "spotify:album:123", title: "Discovery", artist: "Daft Punk" },
    { kind: "playlist", uri: "spotify:playlist:456", title: "Favorites" },
  ];
  const result = cleanShelf(saved);
  assert.deepEqual(result, saved.map((item) => ({ provider: "spotify", ...item })));
  assert.deepEqual(cleanShelf(result), result, "migration must be idempotent");
  assert.equal(saved[0].provider, undefined, "migration must not mutate its input");
});

test("mixed providers preserve shelf ordering and canonicalize SoundCloud URLs", () => {
  assert.deepEqual(cleanShelf([
    { uri: "spotify:album:123", title: "Album" },
    { provider: "soundcloud", uri: "soundcloud:tracks:abc_123", title: "Song", artist: "Creator", url: "https://soundcloud.com/creator/song?si=tracking#section" },
    { provider: "soundcloud", kind: "wrong", uri: "soundcloud:playlists:abc-456", title: "Set", url: "https://www.soundcloud.com/creator/sets/set" },
  ]), [
    { provider: "spotify", kind: "album", uri: "spotify:album:123", title: "Album" },
    { provider: "soundcloud", kind: "track", uri: "soundcloud:tracks:abc_123", title: "Song", artist: "Creator", url: "https://soundcloud.com/creator/song" },
    { provider: "soundcloud", kind: "playlist", uri: "soundcloud:playlists:abc-456", title: "Set", url: "https://www.soundcloud.com/creator/sets/set" },
  ]);
});

test("invalid, spoofed and duplicate entries do not survive persistence", () => {
  assert.deepEqual(cleanShelf([
    null, undefined, false, "soundcloud:tracks:1", {}, { uri: 1 },
    { uri: "soundcloud:users:1" }, { uri: "soundcloud:tracks:1/path" },
    { uri: "soundcloud:tracks:1", provider: "spotify", title: "Spoof" },
    { uri: "spotify:track:1", provider: "soundcloud", title: "Spoof" },
    { uri: "liked", title: "Synthetic Spotify collection" },
    { uri: "spotify:track:1", title: "First" },
    { uri: "spotify:track:1", title: "Duplicate" },
    { uri: "soundcloud:tracks:1", title: "Different provider" },
  ]), [
    { provider: "spotify", kind: "track", uri: "spotify:track:1", title: "First" },
    { provider: "soundcloud", kind: "track", uri: "soundcloud:tracks:1", title: "Different provider" },
  ]);
});

test("untrusted source URLs cannot become saved external-navigation targets", () => {
  const urls = [
    "javascript:alert(1)", "file:///etc/passwd", "http://soundcloud.com/artist/song",
    "https://soundcloud.com.attacker.example/song", "https://attacker.example/?soundcloud.com",
    "https://user:password@soundcloud.com/song", "https://soundcloud.com:8443/song", "not a url",
  ];
  for (const url of urls) {
    const [entry] = cleanShelf([{ uri: "soundcloud:tracks:1", title: "Song", url }]);
    assert.equal(entry.url, undefined, url);
    assert.equal(entry.uri, "soundcloud:tracks:1", "an invalid optional URL should not erase a valid track");
  }
});

test("shelves are bounded and persist only display fields", () => {
  const items = Array.from({ length: 510 }, (_, i) => ({
    uri: `soundcloud:tracks:${i}`, title: "t".repeat(150), artist: "a".repeat(150),
    accessToken: "not-for-persistence", streamUrl: "https://cdn.example/signed", anything: true,
  }));
  const result = cleanShelf(items);
  assert.equal(result.length, 500);
  assert.equal(result[0].title.length, 120);
  assert.equal(result[0].artist.length, 120);
  assert.equal(result[499].uri, "soundcloud:tracks:499");
  assert.deepEqual(Object.keys(result[0]).sort(), ["artist", "kind", "provider", "title", "uri"]);
  for (const input of [null, undefined, {}, "shelf", 7]) assert.deepEqual(cleanShelf(input), []);
});
