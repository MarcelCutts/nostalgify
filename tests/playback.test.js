const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlayback } = require("../src/main/playback");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(check, message = "Expected asynchronous operation did not complete") {
  for (let i = 0; i < 40 && !check(); i++) await new Promise(setImmediate);
  assert.ok(check(), message);
}

const track = (id) => ({
  id: `soundcloud:tracks:${id}`, name: `Track ${id}`, artist: "An artist", duration: 60,
  sourceUrl: `https://soundcloud.com/artist/track-${id}`,
});

function fixture(t, overrides = {}) {
  const calls = [];
  const handles = new Set();
  let playingSession = null;
  let loadedSession = null;
  let spotifyPlaying = true;
  let instance;
  let nextHandle = 0;
  const spotify = {
    async getState() { return { running: true, state: spotifyPlaying ? "playing" : "paused", track: { id: "spotify:track:one" } }; },
    async command(cmd, arg) {
      calls.push({ type: "spotify:command", cmd, arg });
      if (["play", "playShelf"].includes(cmd)) spotifyPlaying = true;
      if (cmd === "pause") spotifyPlaying = false;
    },
    async pause() { calls.push({ type: "spotify:pause" }); spotifyPlaying = false; },
    async start() { calls.push({ type: "spotify:start" }); },
    ...overrides.spotify,
  };
  const soundcloud = {
    async loadContext() { return [track(1), track(2), track(3)]; },
    async getStream(item) { return { url: `https://cdn.example/${item.id}`, type: "progressive", preview: false }; },
    ...overrides.soundcloud,
  };
  const audio = {
    async send(message) {
      calls.push({ ...message });
      if (message.type === "load") {
        loadedSession = message.session;
        playingSession = message.autoPlay ? message.session : null;
        instance.audioState({ session: message.session, state: message.autoPlay ? "playing" : "paused", position: message.position || 0 });
      } else if (message.session === loadedSession) {
        if (message.type === "pause") {
          playingSession = null;
          instance.audioState({ session: message.session, state: "paused" });
        } else if (message.type === "play") {
          playingSession = message.session;
          instance.audioState({ session: message.session, state: "playing" });
        } else if (message.type === "stop") {
          playingSession = null;
          loadedSession = null;
        } else if (message.type === "seek") {
          instance.audioState({ session: message.session, state: playingSession ? "playing" : "paused", position: message.position });
        }
      }
      if (overrides.onAudio) await overrides.onAudio(message);
    },
  };
  instance = createPlayback({
    spotify, soundcloud, audio,
    media: {
      register(url, type) { const handle = `soundcloud-media://stream/${++nextHandle}`; handles.add(handle); calls.push({ type: "register", url, streamType: type }); return handle; },
      clear() { handles.clear(); calls.push({ type: "clear" }); },
    },
    openExternal: async (url) => { calls.push({ type: "external", url }); },
    onProviderChange: (provider) => calls.push({ type: "provider", provider }),
    initialProvider: overrides.initialProvider,
  });
  t.after(() => instance.dispose());
  return {
    player: instance, calls, handles,
    get session() { return loadedSession; },
    get playing() { return playingSession !== null; },
    get spotifyPlaying() { return spotifyPlaying; },
    setSpotifyPlaying(value) { spotifyPlaying = value; },
    destroyRenderer() { playingSession = null; loadedSession = null; },
    end() {
      const session = loadedSession;
      playingSession = null;
      instance.audioState({ session, state: "ended", position: 60 });
      return session;
    },
  };
}

test("switching sources pauses the old source before starting the new one", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:tracks:1");
  assert.equal(f.player.getProvider(), "soundcloud");
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true);
  assert.ok(f.calls.findIndex((c) => c.type === "spotify:pause") < f.calls.findIndex((c) => c.type === "load"));
  const session = f.session;
  await f.player.command("playShelf", "spotify:album:123abc");
  assert.equal(f.playing, false);
  assert.equal(f.spotifyPlaying, true);
  assert.equal(f.handles.size, 0);
  assert.ok(f.calls.findIndex((c) => c.type === "stop" && c.session === session) < f.calls.findIndex((c) => c.cmd === "playShelf"));
});

test("a Spotify poll completing after source selection cannot replace SoundCloud state", async (t) => {
  const poll = deferred();
  const f = fixture(t, { spotify: { getState: () => poll.promise } });
  const pending = f.player.getState();
  await f.player.command("playShelf", "soundcloud:tracks:1");
  poll.resolve({ running: true, state: "playing", track: { id: "spotify:track:old" } });
  const result = await pending;
  assert.equal(result.provider, "soundcloud");
  assert.equal(result.track.id, "soundcloud:tracks:1");
});

test("a late context response cannot overwrite a newer shelf selection", async (t) => {
  const old = deferred();
  let requestedOld = false;
  const f = fixture(t, { soundcloud: {
    loadContext(uri) {
      if (uri === "soundcloud:playlists:old") { requestedOld = true; return old.promise; }
      return Promise.resolve([track("new")]);
    },
  } });
  const pending = f.player.command("playShelf", "soundcloud:playlists:old");
  await until(() => requestedOld);
  await f.player.command("playShelf", "soundcloud:tracks:new");
  old.resolve([track("old")]);
  await pending;
  assert.equal((await f.player.getState()).track.id, "soundcloud:tracks:new");
  assert.equal(f.calls.filter((c) => c.type === "load").length, 1);
});

test("a stream completing after switching to Spotify never reaches the audio host", async (t) => {
  const stream = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { getStream() { requested = true; return stream.promise; } } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  await f.player.command("playShelf", "spotify:track:abc");
  stream.resolve({ url: "https://cdn.example/stale", type: "progressive" });
  await pending;
  assert.equal(f.calls.some((c) => c.type === "load"), false);
  assert.equal(f.calls.some((c) => c.type === "register"), false);
  assert.equal(f.spotifyPlaying, true);
});

test("selecting an idle source cancels a pending stream without leaving a phantom load", async (t) => {
  const stream = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { getStream() { requested = true; return stream.promise; } } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  await f.player.command("selectProvider", "soundcloud");
  await f.player.command("play");
  stream.resolve({ url: "https://cdn.example/obsolete", type: "hls" });
  await pending;
  const state = await f.player.getState();
  assert.equal(state.track, null);
  assert.equal(state.state, "stopped");
  assert.match(state.message, /Paste/);
  assert.equal(f.calls.some((call) => call.type === "load"), false);
});

test("pause while a stream is loading remains paused when it becomes available", async (t) => {
  const stream = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { getStream() { requested = true; return stream.promise; } } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  await f.player.command("pause");
  stream.resolve({ url: "https://cdn.example/track", type: "progressive" });
  await pending;
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).state, "paused");
  await f.player.command("play");
  assert.equal(f.playing, true);
});

test("pause while a playlist is resolving suppresses its eventual autoplay", async (t) => {
  const context = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { loadContext() { requested = true; return context.promise; } } });
  const pending = f.player.command("playShelf", "soundcloud:playlists:1");
  await until(() => requested);
  await f.player.command("pause");
  context.resolve([track(1)]);
  await pending;
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).state, "paused");
});

for (const stage of ["context", "stream"]) {
  test(`Play/Pause toggles pending autoplay while the ${stage} loads`, async (t) => {
    const pending = deferred();
    let requested = false;
    const overrides = stage === "context"
      ? { loadContext() { requested = true; return pending.promise; } }
      : { getStream() { requested = true; return pending.promise; } };
    const f = fixture(t, { soundcloud: overrides });
    const starting = f.player.command("playShelf", "soundcloud:tracks:1");
    await until(() => requested);
    await f.player.command("playpause");
    assert.equal((await f.player.getState()).state, "paused");
    await f.player.command("playpause");
    assert.equal((await f.player.getState()).state, "loading");
    await f.player.command("playpause");
    pending.resolve(stage === "context" ? [track(1)] : { url: "https://cdn.example/track", type: "hls" });
    await starting;
    assert.equal(f.playing, false);
    assert.equal(f.calls.find((call) => call.type === "load").autoPlay, false);
    assert.equal((await f.player.getState()).state, "paused");
  });
}

test("rapid Next commands cannot let the slower earlier stream replace the last selection", async (t) => {
  const second = deferred();
  let requestedSecond = false;
  const f = fixture(t, { soundcloud: { getStream(item) {
    if (item.id === "soundcloud:tracks:2") { requestedSecond = true; return second.promise; }
    return Promise.resolve({ url: `https://cdn.example/${item.id}`, type: "progressive" });
  } } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  const pending = f.player.command("next");
  await until(() => requestedSecond);
  await f.player.command("next");
  second.resolve({ url: "https://cdn.example/late-second", type: "progressive" });
  await pending;
  assert.equal((await f.player.getState()).track.id, "soundcloud:tracks:3");
  assert.equal(f.calls.filter((c) => c.type === "load").length, 2);
  assert.equal(f.calls.some((c) => c.url === "https://cdn.example/late-second"), false);
});

test("duplicate ended events advance a queue once, and final completion can be replayed", async (t) => {
  const f = fixture(t, { soundcloud: { loadContext: async () => [track(1), track(2)] } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  const first = f.end();
  f.player.audioState({ session: first, state: "ended", position: 60 });
  await until(() => f.calls.filter((c) => c.type === "load").length === 2);
  assert.equal((await f.player.getState()).track.id, "soundcloud:tracks:2");
  f.end();
  await until(() => !f.playing);
  assert.equal((await f.player.getState()).state, "stopped");
  await f.player.command("play");
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).state, "playing");
});

test("repeat advances from the last item to the first and stale events are ignored", async (t) => {
  const f = fixture(t, { soundcloud: { loadContext: async () => [track(1), track(2)] } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  await f.player.command("repeat", true);
  await f.player.command("next");
  const old = f.end();
  await until(() => f.calls.filter((c) => c.type === "load").length === 3);
  f.player.audioState({ session: old, state: "error" });
  const state = await f.player.getState();
  assert.equal(state.track.id, "soundcloud:tracks:1");
  assert.equal(state.state, "playing");
  assert.equal(state.error, null);
});

test("buffering preserves the media position and Play/Pause pauses buffered playback", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:tracks:1");
  f.player.audioState({ session: f.session, state: "buffering", position: 17 });
  const state = await f.player.getState();
  assert.equal(state.state, "buffering");
  assert.equal(state.position, 17);
  state.track.name = "Not the stored title";
  assert.equal((await f.player.getState()).track.name, "Track 1");
  await f.player.command("playpause");
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).state, "paused");
});

test("seek and volume are clamped, and previous restarts a track past three seconds", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:playlists:1");
  await f.player.command("next");
  await f.player.command("seek", 300);
  assert.equal((await f.player.getState()).position, 60);
  await f.player.command("previous");
  assert.equal((await f.player.getState()).position, 0);
  assert.equal((await f.player.getState()).track.id, "soundcloud:tracks:2");
  await f.player.command("previous");
  assert.equal((await f.player.getState()).track.id, "soundcloud:tracks:1");
  await f.player.command("volume", 200);
  assert.equal((await f.player.getState()).volume, 100);
});

test("unsupported shelf URIs do not switch sources or invoke any player", async (t) => {
  const f = fixture(t);
  for (const uri of ["https://evil.example/song", "soundcloud:users:1", "soundcloud:tracks:1/../../x", "spotify:track:abc\"", "liked\n", "soundcloud:tracks:"]) {
    const result = await f.player.command("playShelf", uri);
    assert.match(result.error, /Unsupported/);
  }
  assert.equal(f.player.getProvider(), "spotify");
  assert.deepEqual(f.calls, []);
});

test("a failed Spotify pause prevents SoundCloud from starting over it", async (t) => {
  const f = fixture(t, { spotify: { pause: async () => { throw new Error("Automation denied"); } } });
  const result = await f.player.command("playShelf", "soundcloud:tracks:1");
  assert.match(result.error, /Automation denied/);
  assert.equal(f.playing, false);
  assert.equal(f.spotifyPlaying, true);
  assert.equal(f.calls.some((c) => c.type === "load"), false);
});

test("a failed source switch restores Spotify controls without retrying playback", async (t) => {
  let pauses = 0;
  let f;
  f = fixture(t, { spotify: { async pause() {
    if (++pauses === 1) throw new Error("Automation denied");
    f.setSpotifyPlaying(false);
  } } });
  const failed = await f.player.command("playShelf", "soundcloud:tracks:1");
  assert.match(failed.error, /Automation denied/);
  assert.equal(f.player.getProvider(), "spotify");
  assert.equal((await f.player.getState()).provider, "spotify");
  assert.equal(f.spotifyPlaying, true);
  assert.equal(f.calls.some((call) => call.type === "spotify:command"), false, "recovery must not resume or pause Spotify itself");
  assert.equal(await f.player.command("pause"), undefined);
  assert.equal(f.spotifyPlaying, false);
  assert.equal(await f.player.command("play"), undefined);
  assert.equal(f.spotifyPlaying, true);
  assert.equal(pauses, 1, "ordinary Spotify controls must not retry the failed selection");
  assert.equal(f.calls.some((call) => call.type === "load"), false);
  await f.player.command("playShelf", "soundcloud:tracks:1");
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true, "an explicit selection can retry after permission recovers");
});

test("a failed SoundCloud stop restores its controls without starting Spotify", async (t) => {
  let rejectStop = true;
  const f = fixture(t, { onAudio(message) {
    if (message.type === "stop" && rejectStop) throw new Error("Audio did not acknowledge stop");
  } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  const failed = await f.player.command("playShelf", "spotify:track:123");
  assert.match(failed.error, /acknowledge/);
  assert.equal(f.player.getProvider(), "soundcloud");
  assert.equal(f.spotifyPlaying, false);
  assert.equal(await f.player.command("volume", 25), undefined);
  assert.equal(await f.player.command("pause"), undefined);
  assert.equal((await f.player.getState()).volume, 25);
  assert.equal(f.calls.some((call) => call.type === "spotify:command"), false);
  rejectStop = false;
  await f.player.command("playShelf", "spotify:track:123");
  assert.equal(f.player.getProvider(), "spotify");
  assert.equal(f.playing, false);
  assert.equal(f.spotifyPlaying, true);
});

test("SoundCloud stopped before a failed Spotify pause cannot resume over Spotify", async (t) => {
  let denyPause = false;
  let f;
  f = fixture(t, { spotify: { async pause() {
    if (denyPause) throw new Error("Automation denied");
    f.setSpotifyPlaying(false);
  } } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  f.setSpotifyPlaying(true); // Spotify was started outside Nostalgify.
  denyPause = true;
  const failed = await f.player.command("playShelf", "soundcloud:tracks:2");
  assert.match(failed.error, /Automation denied/);
  assert.equal(f.player.getProvider(), "soundcloud");
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).track, null);
  const loads = f.calls.filter((call) => call.type === "load").length;
  assert.equal(await f.player.command("play"), undefined);
  assert.equal(await f.player.command("next"), undefined);
  assert.equal(f.calls.filter((call) => call.type === "load").length, loads, "the discarded context must not resume without a safe source selection");
  assert.equal(f.spotifyPlaying, true);
  denyPause = false;
  await f.player.command("playShelf", "soundcloud:tracks:2");
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true);
});

test("a rejected older Spotify pause cannot revert a newer SoundCloud selection", async (t) => {
  const firstPause = deferred();
  let pauses = 0;
  let f;
  f = fixture(t, { spotify: { async pause() {
    if (++pauses === 1) return firstPause.promise;
    f.setSpotifyPlaying(false);
  } } });
  const older = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => pauses === 1);
  const replacement = f.player.command("playShelf", "soundcloud:tracks:2");
  firstPause.reject(new Error("Obsolete permission error"));
  await Promise.all([older, replacement]);
  assert.equal(f.player.getProvider(), "soundcloud");
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).error, null);
  assert.equal(f.calls.filter((call) => call.type === "load").length, 1);
});

test("an in-flight Spotify play completes before source switching pauses it", async (t) => {
  const started = deferred();
  const finish = deferred();
  let f;
  f = fixture(t, { spotify: { async command(cmd) {
    if (cmd === "play") {
      started.resolve();
      await finish.promise;
      f.setSpotifyPlaying(true);
    }
  } } });
  f.setSpotifyPlaying(false);
  const play = f.player.command("play");
  await started.promise;
  const switchSource = f.player.command("playShelf", "soundcloud:tracks:1");
  await new Promise(setImmediate);
  finish.resolve();
  await Promise.all([play, switchSource]);
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true);
});

test("a source switch waiting for Spotify before reload cannot pause replacement Spotify playback", async (t) => {
  const started = deferred();
  const firstPlay = deferred();
  const latePause = deferred();
  let plays = 0;
  let pauses = 0;
  let f;
  f = fixture(t, { spotify: {
    async command(cmd) {
      if (cmd !== "play") return;
      if (++plays === 1) { started.resolve(); await firstPlay.promise; }
      f.setSpotifyPlaying(true);
    },
    async pause() {
      pauses++;
      await latePause.promise;
      f.setSpotifyPlaying(false);
    },
  } });
  const original = f.player.command("play");
  await started.promise;
  const obsolete = f.player.command("selectProvider", "soundcloud");
  await new Promise(setImmediate);
  await f.player.rendererReset();
  await f.player.command("selectProvider", "spotify");
  const replacement = f.player.command("play");
  firstPlay.resolve();
  await replacement;
  latePause.resolve();
  await Promise.all([original, obsolete]);
  assert.equal(pauses, 0, "the obsolete switch must not send any Spotify pause");
  assert.equal(f.player.getProvider(), "spotify");
  assert.equal(f.spotifyPlaying, true);
});

test("disposing invalidates pending streams and prevents further playback", async (t) => {
  const stream = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { getStream() { requested = true; return stream.promise; } } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  await f.player.dispose();
  stream.resolve({ url: "https://cdn.example/late", type: "progressive" });
  await pending;
  assert.equal(f.calls.some((c) => c.type === "load"), false);
  assert.match((await f.player.command("play")).error, /closed/);
});

test("disposing drains an in-flight Spotify command and rejects later playback", async (t) => {
  const firstPlay = deferred();
  const commands = [];
  const f = fixture(t, { spotify: { async command(command) {
    commands.push(command);
    if (command === "play") await firstPlay.promise;
  } } });
  const playing = f.player.command("play");
  await until(() => commands.length === 1);
  const queued = f.player.command("next");
  await new Promise(setImmediate);
  let completed = false;
  const disposing = f.player.dispose().then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, false, "cleanup must wait for native playback already in progress");
  assert.match((await f.player.command("play")).error, /closed/);
  firstPlay.resolve();
  await Promise.all([playing, queued, disposing]);
  assert.deepEqual(commands, ["play"], "queued playback must not run after disposal starts");
  assert.equal(completed, true);
});

test("empty playlists expose an actionable playback error", async (t) => {
  const f = fixture(t, { soundcloud: { loadContext: async () => [] } });
  await f.player.command("playShelf", "soundcloud:playlists:empty");
  assert.match((await f.player.getState()).message, /no available tracks/);
  assert.equal(f.playing, false);
});

test("a failed stream can be retried with Play without resolving the playlist again", async (t) => {
  let attempts = 0;
  let contexts = 0;
  const f = fixture(t, { soundcloud: {
    async loadContext() { contexts++; return [track(1)]; },
    async getStream() {
      if (++attempts === 1) throw Object.assign(new Error("SoundCloud is temporarily unavailable"), { code: "unavailable" });
      return { url: "https://cdn.example/retry", type: "progressive" };
    },
  } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  const failed = await f.player.getState();
  assert.equal(failed.error, "unavailable");
  assert.equal(failed.state, "paused");
  assert.equal(f.playing, false);
  await f.player.command("play");
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).error, null);
  assert.equal(attempts, 2);
  assert.equal(contexts, 1);
});

test("Play retries a failed context once and rapid Play commands share the pending retry", async (t) => {
  const retry = deferred();
  let attempts = 0;
  const uris = [];
  const f = fixture(t, { soundcloud: { async loadContext(uri) {
    uris.push(uri);
    if (++attempts === 1) throw new Error("SoundCloud is temporarily unavailable");
    return retry.promise;
  } } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  assert.equal((await f.player.getState()).state, "paused");
  await new Promise(setImmediate);
  assert.equal(attempts, 1, "a failed context must not retry itself");
  const playing = f.player.command("play");
  await until(() => attempts === 2);
  await f.player.command("play");
  assert.equal(attempts, 2);
  retry.resolve([track(1)]);
  await playing;
  assert.deepEqual(uris, ["soundcloud:playlists:1", "soundcloud:playlists:1"]);
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).error, null);
});

test("a late manual context retry cannot replace a newly selected source", async (t) => {
  const retry = deferred();
  let attempts = 0;
  const f = fixture(t, { soundcloud: { async loadContext() {
    if (++attempts === 1) throw new Error("Try again");
    return retry.promise;
  } } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  const pending = f.player.command("play");
  await until(() => attempts === 2);
  await f.player.command("playShelf", "spotify:track:123");
  retry.resolve([track(1)]);
  await pending;
  assert.equal((await f.player.getState()).provider, "spotify");
  assert.equal(f.calls.some((call) => call.type === "load"), false);
});

test("manual retry refreshes a failed stream at its last position without automatic retry loops", async (t) => {
  let streams = 0;
  const f = fixture(t, { soundcloud: { async getStream() {
    if (++streams === 2) throw new Error("Still unavailable");
    return { url: `https://cdn.example/stream-${streams}`, type: "hls" };
  } } });
  await f.player.command("playShelf", "soundcloud:playlists:1");
  await f.player.command("volume", 25);
  f.player.audioState({ session: f.session, state: "error", position: 23.5 });
  await new Promise(setImmediate);
  assert.equal(streams, 1, "a media error must wait for the user's retry");
  await f.player.command("play");
  assert.equal(streams, 2);
  assert.equal((await f.player.getState()).position, 23.5);
  assert.equal((await f.player.getState()).state, "paused");
  await new Promise(setImmediate);
  assert.equal(streams, 2, "a failed manual retry must not start a retry loop");
  await f.player.command("play");
  const loads = f.calls.filter((call) => call.type === "load");
  assert.equal(loads.length, 2);
  assert.notEqual(loads[0].session, loads[1].session);
  assert.equal(loads[1].position, 23.5);
  assert.equal(loads[1].volume, 25);
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).position, 23.5);
  await f.player.command("next");
  assert.equal((await f.player.getState()).position, 0, "a different track starts at zero");
});

test("a rejected old context and obsolete audio events cannot damage a newer source", async (t) => {
  const old = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: {
    async loadContext(uri) {
      if (uri === "soundcloud:playlists:old") { requested = true; return old.promise; }
      return [track(1)];
    },
  } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  const oldSession = f.session;
  const pending = f.player.command("playShelf", "soundcloud:playlists:old");
  await until(() => requested);
  await f.player.command("playShelf", "spotify:track:abc");
  old.reject(new Error("Late network failure"));
  await pending;
  f.player.audioState({ session: oldSession, state: "error" });
  const state = await f.player.getState();
  assert.equal(state.provider, "spotify");
  assert.equal(state.state, "playing");
  assert.equal(state.error, undefined);
});

test("opening SoundCloud rejects a malicious track URL", async (t) => {
  const f = fixture(t, { soundcloud: {
    loadContext: async () => [{ ...track(1), sourceUrl: "https://soundcloud.com.attacker.example/phishing" }],
  } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  const result = await f.player.command("activate");
  assert.match(result.error, /Invalid SoundCloud source link/);
  assert.equal(f.calls.some((c) => c.type === "external"), false);
  assert.equal(f.playing, true);
  assert.equal((await f.player.getState()).state, "playing");
  assert.equal((await f.player.getState()).error, null);
});

test("invalid seek or volume commands leave ongoing playback and its state intact", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:tracks:1");
  for (const [command, value] of [["seek", NaN], ["seek", Infinity], ["seek", "20"], ["volume", NaN]]) {
    const result = await f.player.command(command, value);
    assert.match(result.error, /Invalid/);
    assert.equal(f.playing, true);
    const state = await f.player.getState();
    assert.equal(state.state, "playing");
    assert.equal(state.error, null);
  }
});

test("shuffle without repeat exhausts every track once and then stops", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:playlists:1");
  await f.player.command("shuffle", true);
  await f.player.command("repeat", false);
  const played = [];
  for (let i = 0; i < 3; i++) {
    played.push((await f.player.getState()).track.id);
    f.end();
    if (i < 2) await until(() => f.calls.filter((c) => c.type === "load").length === i + 2);
  }
  await new Promise(setImmediate);
  assert.deepEqual([...played].sort(), ["soundcloud:tracks:1", "soundcloud:tracks:2", "soundcloud:tracks:3"]);
  assert.equal(f.calls.filter((c) => c.type === "load").length, 3);
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).state, "stopped");
});

test("remembered SoundCloud source pauses externally playing Spotify before its first HLS load", async (t) => {
  const pause = deferred();
  let pauseRequested = false;
  let f;
  f = fixture(t, {
    initialProvider: "soundcloud",
    spotify: { async pause() {
      pauseRequested = true;
      await pause.promise;
      f.setSpotifyPlaying(false);
    } },
    soundcloud: { getStream: async () => ({ url: "https://cdn.example/playlist.m3u8", type: "hls", preview: false }) },
  });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  try {
    await until(() => pauseRequested || f.calls.some((c) => c.type === "load"));
    assert.equal(pauseRequested, true, "the remembered source must not assume Spotify is paused");
    assert.equal(f.calls.some((c) => c.type === "load"), false, "HLS must wait for Spotify to finish pausing");
  } finally {
    pause.resolve();
    await pending;
  }
  assert.equal(f.spotifyPlaying, false);
  assert.equal(f.playing, true);
  assert.equal(f.calls.find((c) => c.type === "load").streamType, "hls");
});

test("renderer reset invalidates a pending stream without sending IPC to the dead renderer", async (t) => {
  const stream = deferred();
  let requested = false;
  let requests = 0;
  const f = fixture(t, { soundcloud: { getStream() {
    if (++requests === 1) { requested = true; return stream.promise; }
    return Promise.resolve({ url: "https://cdn.example/recovered", type: "progressive" });
  } } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  const sent = f.calls.filter((c) => ["load", "stop", "pause", "play", "seek", "volume"].includes(c.type)).length;
  await f.player.rendererReset();
  stream.resolve({ url: "https://cdn.example/obsolete", type: "progressive" });
  await pending;
  assert.equal(f.calls.filter((c) => ["load", "stop", "pause", "play", "seek", "volume"].includes(c.type)).length, sent);
  assert.equal(f.handles.size, 0);
  assert.notEqual((await f.player.getState()).state, "playing");
  await f.player.command("playShelf", "soundcloud:tracks:2");
  assert.equal(f.playing, true, "the fresh renderer must be able to start playback again");
});

test("renderer reset rejects stale audio and pending load acknowledgements without issuing commands", async (t) => {
  const ack = deferred();
  let loading = false;
  const f = fixture(t, { onAudio(message) {
    if (message.type === "load" && !loading) { loading = true; return ack.promise; }
  } });
  const pending = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => loading);
  const old = f.session;
  const count = f.calls.length;
  f.destroyRenderer();
  await f.player.rendererReset();
  ack.resolve();
  await pending;
  f.player.audioState({ session: old, state: "playing", position: 20 });
  assert.equal(f.calls.slice(count).some((c) => ["load", "stop", "pause", "play", "seek", "volume"].includes(c.type)), false);
  assert.equal(f.handles.size, 0);
  assert.notEqual((await f.player.getState()).state, "playing");
  assert.equal(f.playing, false);
  await f.player.command("playShelf", "soundcloud:tracks:2");
  assert.equal(f.playing, true);
});

test("renderer reset clears a rejected source switch so later commands are not poisoned", async (t) => {
  let dead = false;
  const f = fixture(t, { onAudio(message) {
    if (dead && message.type === "stop") throw new Error("Renderer has been destroyed");
  } });
  await f.player.command("playShelf", "soundcloud:tracks:1");
  dead = true;
  const failed = await f.player.command("selectProvider", "soundcloud");
  assert.match(failed.error, /destroyed/);
  f.destroyRenderer();
  const count = f.calls.length;
  await f.player.rendererReset();
  assert.equal(f.calls.slice(count).some((c) => ["load", "stop", "pause", "play", "seek", "volume"].includes(c.type)), false);
  assert.equal(await f.player.command("volume", 37), undefined);
  assert.equal((await f.player.getState()).volume, 37);
  dead = false;
  await f.player.command("playShelf", "soundcloud:tracks:2");
  assert.equal(f.playing, true);
});

for (const outcome of ["resolve", "reject"]) {
  test(`an old source switch cannot damage replacement playback when its stop later ${outcome}s`, async (t) => {
    const stop = deferred();
    let stopping = false;
    const f = fixture(t, { onAudio(message) {
      if (message.type === "stop" && !stopping) { stopping = true; return stop.promise; }
    } });
    await f.player.command("playShelf", "soundcloud:tracks:1");
    const obsolete = f.player.command("selectProvider", "soundcloud");
    await until(() => stopping);
    f.destroyRenderer();
    await f.player.rendererReset();
    await f.player.command("playShelf", "soundcloud:tracks:2");
    const replacement = f.session;
    if (outcome === "resolve") stop.resolve();
    else stop.reject(new Error("The old renderer was destroyed"));
    await obsolete;
    assert.equal(f.playing, true);
    assert.equal((await f.player.getState()).state, "playing");
    assert.equal((await f.player.getState()).error, null);
    assert.equal(f.handles.size, 1, "an old switch cannot revoke replacement media");
    f.player.audioState({ session: replacement, state: "playing", position: 31 });
    assert.equal((await f.player.getState()).position, 31, "replacement session must remain active");
  });
}

test("Spotify Stop finishes its rewind before the next native command", async (t) => {
  const pause = deferred();
  const commands = [];
  const f = fixture(t, { spotify: { async command(cmd, arg) {
    commands.push({ cmd, arg });
    if (cmd === "pause") await pause.promise;
  } } });
  const stopping = f.player.command("stop");
  await until(() => commands.length === 1);
  const next = f.player.command("next");
  await new Promise(setImmediate);
  assert.deepEqual(commands, [{ cmd: "pause", arg: undefined }]);
  pause.resolve();
  await Promise.all([stopping, next]);
  assert.deepEqual(commands, [
    { cmd: "pause", arg: undefined },
    { cmd: "seek", arg: 0 },
    { cmd: "next", arg: undefined },
  ]);
});

test("a Spotify Stop interrupted by a source selection does not rewind later playback", async (t) => {
  const pause = deferred();
  const commands = [];
  const f = fixture(t, { spotify: { async command(cmd) {
    commands.push(cmd);
    if (cmd === "pause") await pause.promise;
  } } });
  const stopping = f.player.command("stop");
  await until(() => commands.length === 1);
  const replacement = f.player.command("playShelf", "spotify:track:new");
  pause.resolve();
  await Promise.all([stopping, replacement]);
  assert.deepEqual(commands, ["pause", "playShelf"]);
});

test("SoundCloud Stop pauses and rewinds the current track without releasing it", async (t) => {
  const f = fixture(t);
  await f.player.command("playShelf", "soundcloud:tracks:1");
  const session = f.session;
  f.player.audioState({ session, state: "playing", position: 25 });
  const start = f.calls.length;
  await f.player.command("stop");
  assert.deepEqual(f.calls.slice(start), [
    { type: "pause", session }, { type: "seek", session, position: 0 },
  ]);
  assert.equal(f.playing, false);
  assert.equal((await f.player.getState()).position, 0);
  assert.equal(f.handles.size, 1);
  await f.player.command("play");
  assert.equal(f.session, session);
  assert.equal(f.playing, true);
});

for (const replacement of ["spotify", "next"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`a delayed SoundCloud Stop cannot affect ${replacement} playback when its pause ${outcome}s`, async (t) => {
      const pause = deferred();
      let pausing = false;
      const f = fixture(t, { onAudio(message) {
        if (message.type === "pause") { pausing = true; return pause.promise; }
      } });
      await f.player.command("playShelf", "soundcloud:playlists:1");
      const stopping = f.player.command("stop");
      await until(() => pausing);
      if (replacement === "spotify") await f.player.command("playShelf", "spotify:track:new");
      else await f.player.command("next");
      const start = f.calls.length;
      if (outcome === "resolve") pause.resolve();
      else pause.reject(new Error("Obsolete pause failed"));
      assert.equal(await stopping, undefined, "stale Stop errors must not reach replacement playback");
      assert.equal(f.calls.slice(start).some((call) => call.type === "seek" || call.cmd === "seek"), false);
      assert.equal((await f.player.getState()).state, "playing");
      assert.equal(replacement === "spotify" ? f.spotifyPlaying : f.playing, true);
    });
  }
}

test("Stop during a pending SoundCloud stream prevents late autoplay", async (t) => {
  const stream = deferred();
  let requested = false;
  const f = fixture(t, { soundcloud: { getStream() { requested = true; return stream.promise; } } });
  const loading = f.player.command("playShelf", "soundcloud:tracks:1");
  await until(() => requested);
  await f.player.command("seek", 20);
  await f.player.command("stop");
  stream.resolve({ url: "https://cdn.example/track", type: "progressive" });
  await loading;
  const load = f.calls.find((call) => call.type === "load");
  assert.equal(load.autoPlay, false);
  assert.equal(load.position, 0);
  assert.equal(f.playing, false);
});

for (const provider of ["spotify", "soundcloud"]) {
  test(`a failed ${provider} Stop does not rewind and leaves later controls usable`, async (t) => {
    const nativeCommands = [];
    const f = fixture(t, {
      spotify: { async command(cmd) {
        nativeCommands.push(cmd);
        if (cmd === "pause") throw new Error("Pause failed");
      } },
      onAudio(message) { if (message.type === "pause") throw new Error("Pause failed"); },
    });
    if (provider === "soundcloud") await f.player.command("playShelf", "soundcloud:tracks:1");
    assert.match((await f.player.command("stop")).error, /Pause failed/);
    assert.equal(f.calls.some((call) => call.type === "seek" || call.cmd === "seek"), false);
    assert.equal(nativeCommands.includes("seek"), false);
    assert.equal(await f.player.command("volume", 35), undefined);
    if (provider === "spotify") assert.deepEqual(nativeCommands, ["pause", "volume"]);
    else assert.equal(f.calls.at(-1).type, "volume");
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`reload during a SoundCloud-to-Spotify switch restores consistent controls when stop ${outcome}s`, async (t) => {
    const stop = deferred();
    let stopping = false;
    const f = fixture(t, { onAudio(message) {
      if (message.type === "stop" && !stopping) { stopping = true; return stop.promise; }
    } });
    await f.player.command("playShelf", "soundcloud:tracks:1");
    const selection = f.player.command("selectProvider", "spotify");
    await until(() => stopping);
    f.destroyRenderer();
    f.player.rendererReset();
    assert.equal(f.player.getProvider(), "soundcloud");
    assert.equal((await f.player.getState()).provider, "soundcloud");
    await f.player.command("volume", 37);
    assert.equal((await f.player.getState()).volume, 37);
    if (outcome === "resolve") stop.resolve();
    else stop.reject(new Error("The old renderer was destroyed"));
    await selection;
    assert.equal(f.player.getProvider(), "soundcloud");
    assert.equal(f.calls.some((call) => call.type === "spotify:start"), false);
    await f.player.command("playShelf", "spotify:track:new");
    await f.player.command("pause");
    assert.equal((await f.player.getState()).provider, "spotify");
    assert.equal(f.spotifyPlaying, false);
  });
}

test("reload during a native handoff pause drains it before replacement Spotify Play", async (t) => {
  const pause = deferred();
  let pausing = false;
  let f;
  f = fixture(t, { spotify: { async pause() {
    pausing = true;
    await pause.promise;
    f.setSpotifyPlaying(false);
  } } });
  const selection = f.player.command("selectProvider", "soundcloud");
  await until(() => pausing);
  f.player.rendererReset();
  assert.equal(f.player.getProvider(), "spotify");
  assert.equal((await f.player.getState()).provider, "spotify");
  const playing = f.player.command("play");
  await new Promise(setImmediate);
  assert.equal(f.calls.some((call) => call.cmd === "play"), false, "Play must wait for the already-running pause");
  pause.resolve();
  await Promise.all([selection, playing]);
  assert.equal(f.spotifyPlaying, true);
  assert.equal(f.player.getProvider(), "spotify");
  assert.equal(f.calls.some((call) => call.type === "provider"), false);
});
