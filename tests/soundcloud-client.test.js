const test = require("node:test");
const assert = require("node:assert/strict");
const { createSoundCloudClient } = require("../src/main/soundcloud/client");

const TOKEN = "test-private-token";
const TRACK = {
  kind: "track", urn: "soundcloud:tracks:1", title: "Example", duration: 180000,
  user: { username: "Artist", avatar_url: "https://i1.sndcdn.com/avatar.jpg" },
  permalink_url: "https://soundcloud.com/artist/example", access: "playable", sharing: "public",
};
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

function fixture(sequence, auth = { getAccessToken: async () => TOKEN }, now = Date.now) {
  const calls = [];
  const client = createSoundCloudClient({ auth, now, fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    const next = sequence.shift();
    if (typeof next === "function") return next(url, options);
    assert.ok(next, `Unexpected request ${url}`);
    return next;
  } });
  return { client, calls };
}

test("public links resolve to stable shelf entries, discard tracking and deduplicate", async () => {
  const { client, calls } = fixture([response(TRACK), response(TRACK)]);
  const entries = await client.resolveLinks("Listen: https://www.soundcloud.com/artist/example?utm_source=share and https://soundcloud.com/artist/example.");
  assert.deepEqual(entries, [{ provider: "soundcloud", kind: "track", uri: TRACK.urn,
    title: "Example", artist: "Artist", url: TRACK.permalink_url }]);
  for (const call of calls) {
    assert.equal(new URL(call.url).searchParams.get("url"), TRACK.permalink_url);
    assert.equal(call.options.headers.Authorization, `OAuth ${TOKEN}`);
  }
});

test("canonical sets resolve as playlists and unrelated text is ignored", async () => {
  const { client } = fixture([response({ ...TRACK, urn: "soundcloud:playlists:5", kind: "playlist", permalink_url: "https://soundcloud.com/artist/sets/collection" })]);
  assert.equal((await client.resolveLinks("https://soundcloud.com/artist/sets/collection"))[0].kind, "playlist");
  assert.deepEqual(await client.resolveLinks("https://example.com/track spotify:track:abc"), []);
});

test("shortlinks redirect without cookies or tokens before authorized API resolution", async () => {
  const { client, calls } = fixture([
    redirect("https://snd.sc/second"), redirect(TRACK.permalink_url), response(TRACK),
  ]);
  const [entry] = await client.resolveLinks("https://on.soundcloud.com/first");
  assert.equal(entry.uri, TRACK.urn);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[2].options.headers.Authorization, `OAuth ${TOKEN}`);
});

for (const destination of ["https://evil.example/track", "http://soundcloud.com/artist/track", "https://user:password@soundcloud.com/artist/track", "https://soundcloud.com:8443/artist/track", "https://soundcloud.com.evil.example/artist/track"]) {
  test(`shortlink cannot request an unsafe destination: ${destination}`, async () => {
    const { client, calls } = fixture([redirect(destination)]);
    await assert.rejects(client.resolveLinks("https://on.soundcloud.com/first"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, undefined);
  });
}

test("API resolve follows safe redirects with URN paths", async () => {
  const { client, calls } = fixture([redirect("https://api.soundcloud.com/tracks/1", 303), response(TRACK)]);
  assert.equal((await client.resolveLinks(TRACK.permalink_url))[0].uri, TRACK.urn);
  assert.equal(calls[1].url, "https://api.soundcloud.com/tracks/soundcloud:tracks:1");
});

test("API redirect query credentials are stripped case-insensitively while pagination remains", async () => {
  const { client, calls } = fixture([
    redirect(`https://api.soundcloud.com/tracks/1?OAuth_Token=${TOKEN}&ACCESS_TOKEN=${TOKEN}&Client_Secret=${TOKEN}&AUTHORIZATION=${TOKEN}&cursor=next`),
    response(TRACK),
  ]);
  await client.resolveLinks(TRACK.permalink_url);
  assert.equal(calls[1].url, "https://api.soundcloud.com/tracks/soundcloud:tracks:1?cursor=next");
});

test("API redirects cannot send OAuth tokens to another host", async () => {
  const { client, calls } = fixture([redirect("https://evil.example/collect")]);
  await assert.rejects(client.resolveLinks(TRACK.permalink_url), { code: "unsafe_redirect" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, "api.soundcloud.com");
});

test("malformed redirects produce sanitized errors", async () => {
  const { client, calls } = fixture([redirect(`https://[${TOKEN}`)]);
  await assert.rejects(client.resolveLinks(TRACK.permalink_url), (error) => error.code === "invalid_url" && !error.message.includes(TOKEN));
  assert.equal(calls.length, 1);
});

test("shortlink loops stop before repeating a request", async () => {
  const { client, calls } = fixture([redirect("https://on.soundcloud.com/first")]);
  await assert.rejects(client.resolveLinks("https://on.soundcloud.com/first"), { code: "redirect_loop" });
  assert.equal(calls.length, 1);
});

test("profile, private, insecure and credential-bearing links are explicitly rejected", async () => {
  const { client, calls } = fixture([]);
  for (const url of ["https://soundcloud.com/artist", "https://soundcloud.com/artist/likes", "https://soundcloud.com/artist/example/s-private", "http://soundcloud.com/artist/example", "https://user:password@soundcloud.com/artist/example"]) {
    await assert.rejects(client.resolveLinks(url));
  }
  assert.equal(calls.length, 0);
});

test("private API resources are not added to the public shelf", async () => {
  const { client } = fixture([response({ ...TRACK, sharing: "private" })]);
  await assert.rejects(client.resolveLinks(TRACK.permalink_url), { code: "unsupported_resource" });
});

test("playlist pagination preserves order, restrictions and repeated tracks; hydrates incomplete records once", async () => {
  const next = "https://api.soundcloud.com/playlists/soundcloud:playlists:5/tracks?cursor=next";
  const { client, calls } = fixture([
    response({ collection: [TRACK, { id: 2 }], next_href: next }),
    response({ collection: [{ id: 2 }, { ...TRACK, urn: "soundcloud:tracks:3", access: "blocked" }], next_href: null }),
    response({ ...TRACK, urn: "soundcloud:tracks:2", title: "Preview", access: "preview", duration: 30000 }),
  ]);
  const tracks = await client.loadContext("soundcloud:playlists:5");
  assert.deepEqual(tracks.map((track) => track.id), ["soundcloud:tracks:1", "soundcloud:tracks:2", "soundcloud:tracks:2", "soundcloud:tracks:3"]);
  assert.deepEqual(tracks.map((track) => track.access), ["playable", "preview", "preview", "blocked"]);
  assert.equal(tracks[0].duration, 180);
  assert.equal(tracks[0].artist, "Artist");
  assert.equal(tracks[0].artworkUrl, "https://i1.sndcdn.com/avatar.jpg");
  assert.equal(calls[2].url, "https://api.soundcloud.com/tracks/soundcloud:tracks:2");
  assert.equal(calls.length, 3);
});

test("pagination rejects external next links before credentialed fetch", async () => {
  const { client, calls } = fixture([response({ collection: [TRACK], next_href: "https://evil.example/steal" })]);
  await assert.rejects(client.loadContext("soundcloud:playlists:5"), { code: "unsafe_redirect" });
  assert.equal(calls.length, 1);
});

test("pagination loops stop without repeated requests", async () => {
  const next = "https://api.soundcloud.com/playlists/soundcloud:playlists:5/tracks?cursor=repeat";
  const { client, calls } = fixture([
    response({ collection: [TRACK], next_href: next }),
    response({ collection: [TRACK], next_href: next }),
  ]);
  await assert.rejects(client.loadContext("soundcloud:playlists:5"), { code: "pagination_loop" });
  assert.equal(calls.length, 2);
});

test("oversized playlists fail explicitly instead of silently dropping tracks", async () => {
  const { client, calls } = fixture([response({ collection: Array.from({ length: 1001 }, () => TRACK) })]);
  await assert.rejects(client.loadContext("soundcloud:playlists:5"), { code: "playlist_too_large" });
  assert.equal(calls.length, 1);
});

test("endlessly changing empty playlist pages hit a bounded request limit", async () => {
  let count = 0;
  const client = createSoundCloudClient({ auth: { getAccessToken: async () => TOKEN }, fetch: async () => {
    count++;
    return response({ collection: [], next_href: `https://api.soundcloud.com/playlists/soundcloud:playlists:5/tracks?cursor=${count}` });
  } });
  await assert.rejects(client.loadContext("soundcloud:playlists:5"), { code: "request_limit" });
  assert.equal(count, 1100);
});

test("single-track contexts normalize missing access conservatively", async () => {
  const { client } = fixture([response({ ...TRACK, access: null })]);
  const [track] = await client.loadContext(TRACK.urn);
  assert.equal(track.access, "blocked");
  assert.equal(track.sourceUrl, TRACK.permalink_url);
  await assert.rejects(client.loadContext("1"), { code: "invalid_resource" });
});

test("artist metadata identifies performers while retaining uploader attribution", async () => {
  const resource = { ...TRACK, metadata_artist: "Performer One, Performer Two", user: { username: "Record Label" } };
  const { client } = fixture([response(resource), response(resource)]);
  const [track] = await client.loadContext(TRACK.urn);
  assert.equal(track.artist, "Performer One, Performer Two");
  assert.equal(track.uploader, "Record Label");
  const [shelf] = await client.resolveLinks(TRACK.permalink_url);
  assert.equal(shelf.artist, "Record Label", "saved public links retain the uploader's attribution");
});

test("blank or missing artist metadata falls back to the uploader", async () => {
  const { client } = fixture([response({ ...TRACK, metadata_artist: " \n " }), response(TRACK)]);
  for (let i = 0; i < 2; i++) {
    const [track] = await client.loadContext(TRACK.urn);
    assert.equal(track.artist, "Artist");
    assert.equal(track.uploader, "Artist");
  }
});

test("full playback prefers AAC HLS and exposes no preview substitution", async () => {
  const aac = "https://playback.media-streaming.soundcloud.cloud/id/aac_160k/playlist.m3u8?Policy=signed";
  const { client } = fixture([response({ hls_aac_160_url: aac, hls_mp3_128_url: "https://cf-hls-media.sndcdn.com/song.m3u8", preview_mp3_128_url: "https://cf-preview-media.sndcdn.com/preview.mp3" })]);
  assert.deepEqual(await client.getStream({ id: TRACK.urn, access: "playable" }), { url: aac, type: "hls", preview: false });
});

test("documented MP3 HLS can be a full-track fallback", async () => {
  const url = "https://api.soundcloud.com/tracks/soundcloud:tracks:1/streams/uuid";
  const { client } = fixture([response({ hls_mp3_128_url: url })]);
  assert.deepEqual(await client.getStream({ id: TRACK.urn, access: "playable" }), { url, type: "hls", preview: false });
});

test("preview and blocked access cannot silently become full playback", async () => {
  const url = "https://cf-preview-media.sndcdn.com/preview.mp3";
  const { client, calls } = fixture([response({ hls_aac_160_url: "https://api.soundcloud.com/full", preview_mp3_128_url: url })]);
  assert.deepEqual(await client.getStream({ id: TRACK.urn, access: "preview" }), { url, type: "audio", preview: true });
  await assert.rejects(client.getStream({ id: TRACK.urn, access: "blocked" }), { code: "track_blocked" });
  assert.equal(calls.length, 1);
  const other = fixture([response({ preview_mp3_128_url: url })]);
  await assert.rejects(other.client.getStream({ id: TRACK.urn, access: "playable" }), { code: "stream_unavailable" });
});

test("stream URLs cannot expose authentication or use unapproved hosts", async () => {
  for (const url of ["https://evil.example/song.m3u8", "https://not-sndcdn.com/song.m3u8", "https://api.soundcloud.com/stream?oauth_token=secret", "https://api.soundcloud.com/stream?OAuth_Token=secret", "https://api.soundcloud.com/stream?CLIENT_SECRET=secret", "https://user:secret@i1.sndcdn.com/song.m3u8", "https://other.soundcloud.cloud/song.m3u8"]) {
    const { client } = fixture([response({ hls_aac_160_url: url })]);
    await assert.rejects(client.getStream({ id: TRACK.urn, access: "playable" }));
  }
});

test("401s provide reconnect guidance without echoing upstream credentials", async () => {
  const { client } = fixture([response({ message: `bad token ${TOKEN}` }, 401)]);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => {
    assert.equal(error.code, "unauthorized");
    assert.match(error.message, /Reconnect/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test("429 honors Retry-After without retries and resumes only once the cooldown expires", async () => {
  let clock = Date.UTC(2026, 9, 8, 12);
  const { client, calls } = fixture([response({ detail: TOKEN }, 429, { "retry-after": "120" }), response(TRACK)], undefined, () => clock);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.code === "rate_limited" && error.retryAfterMs === 120000);
  clock += 119999;
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.code === "rate_limited" && error.retryAfterMs === 1);
  assert.equal(calls.length, 1);
  clock += 1;
  assert.equal((await client.loadContext(TRACK.urn))[0].id, TRACK.urn);
  assert.equal(calls.length, 2);
});

test("HTTP-date Retry-After is honored", async () => {
  const clock = Date.UTC(2026, 9, 8, 12);
  const date = new Date(clock + 90000).toUTCString();
  const { client } = fixture([response({}, 429, { "retry-after": date })], undefined, () => clock);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 90000);
});

test("documented 24-hour play quota reset is not shortened to a five-minute retry", async () => {
  let clock = Date.UTC(2026, 9, 8, 12);
  const { client, calls } = fixture([response({ errors: [{ meta: {
    rate_limit: { group: "plays", max_nr_of_requests: 15000, time_window: "PT24H" },
    reset_time: "2026/10/09 12:00:00 +0000", remaining_requests: 0,
  } }] }, 429), response(TRACK)], undefined, () => clock);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.code === "rate_limited" && error.retryAfterMs === 86400000);
  clock += 23 * 3600000;
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 3600000);
  assert.equal(calls.length, 1);
  clock += 3600000;
  assert.equal((await client.loadContext(TRACK.urn))[0].id, TRACK.urn);
});

test("the latest applicable quota wins across Retry-After and all JSON reset times", async () => {
  const clock = Date.UTC(2026, 9, 8, 12);
  const { client } = fixture([response({ errors: [
    { meta: { reset_time: "2026/10/08 15:00:00 +0200" } },
    { meta: { reset_time: "2026/10/09 16:00:00 +0200" } },
  ] }, 429, { "retry-after": "86400" })], undefined, () => clock);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 26 * 3600000);
  const longerHeader = fixture([response({ errors: [{ meta: { reset_time: "2026/10/09 12:00:00 +0000" } }] },
    429, { "retry-after": "172800" })], undefined, () => clock);
  await assert.rejects(longerHeader.client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 172800000);
});

test("a delayed shorter 429 response cannot replace a longer concurrent cooldown", async () => {
  const clock = Date.UTC(2026, 9, 8, 12);
  let releaseBody;
  let startedBody;
  const waiting = new Promise((resolve) => { startedBody = resolve; });
  const delayed = response({}, 429, { "retry-after": "3600" });
  delayed.json = () => { startedBody(); return new Promise((resolve) => { releaseBody = resolve; }); };
  const { client, calls } = fixture([delayed, response({}, 429, { "retry-after": "86400" })], undefined, () => clock);
  const shorter = assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 86400000);
  await waiting;
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 86400000);
  releaseBody({});
  await shorter;
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 86400000);
  assert.equal(calls.length, 2);
});

test("malformed quota details use a safe fallback without echoing upstream content", async () => {
  const clock = Date.UTC(2026, 9, 8, 12);
  for (const limited of [
    response({ errors: [{ meta: { reset_time: TOKEN } }, { meta: { reset_time: "2020/01/01 00:00:00 +0000" } }] }, 429, { "retry-after": "Infinity" }),
    new Response(TOKEN, { status: 429 }),
  ]) {
    const { client } = fixture([limited], undefined, () => clock);
    await assert.rejects(client.loadContext(TRACK.urn), (error) =>
      error.code === "rate_limited" && error.retryAfterMs === 60000 && !error.message.includes(TOKEN));
  }
  const { client } = fixture([new Response(TOKEN, { status: 429, headers: { "retry-after": "86400" } })], undefined, () => clock);
  await assert.rejects(client.loadContext(TRACK.urn), (error) => error.retryAfterMs === 86400000);
});

test("redirect and rejected response bodies are released without exposing their contents", async () => {
  let cancellations = 0;
  const streaming = (status, headers = {}) => new Response(new ReadableStream({
    cancel() { cancellations += 1; },
  }), { status, headers });
  const { client } = fixture([
    streaming(302, { location: TRACK.permalink_url }),
    streaming(303, { location: "https://api.soundcloud.com/tracks/1" }),
    response(TRACK),
    streaming(401),
    streaming(403),
  ]);
  await client.resolveLinks("https://on.soundcloud.com/first");
  await assert.rejects(client.loadContext(TRACK.urn), { code: "unauthorized" });
  await assert.rejects(client.loadContext(TRACK.urn), { code: "api_error" });
  assert.equal(cancellations, 4);
});

test("auth and network errors are sanitized and do not start browser authentication", async () => {
  const authFailure = fixture([], { getAccessToken: async () => { throw new Error(TOKEN); } });
  await assert.rejects(authFailure.client.loadContext(TRACK.urn), (error) => error.code === "unauthorized" && !error.message.includes(TOKEN));
  assert.equal(authFailure.calls.length, 0);
  const network = fixture([() => { throw new Error(`Request with ${TOKEN} failed`); }]);
  await assert.rejects(network.client.loadContext(TRACK.urn), (error) => error.code === "network_error" && !error.message.includes(TOKEN));
});

test("authentication rate limits retain safe retry metadata without exposing adapter text", async () => {
  const { client, calls } = fixture([], { getAccessToken: async () => {
    throw Object.assign(new Error(`sensitive ${TOKEN}`), { code: "rate_limited", status: 429, retryAfterMs: 3600000, token: TOKEN });
  } });
  await assert.rejects(client.loadContext(TRACK.urn), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 3600000);
    assert.equal(error.token, undefined);
    assert.doesNotMatch(error.message, /sensitive|reconnect/i);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(calls.length, 0);
});
