import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Load the browser module with its production bundler, injecting only browser
// media and time primitives. No real network or audio device is required.
const built = await build({
  entryPoints: [new URL("../src/renderer/soundcloudAudio.js", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { createSoundCloudAudio } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

class FakeAudio extends EventTarget {
  currentTime = 0;
  duration = NaN;
  volume = 1;
  paused = true;
  ended = false;
  playResult = Promise.resolve();
  src = "";
  play() { this.paused = false; return this.playResult; }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  load() {}
  removeAttribute() { this.src = ""; }
  canPlayType() { return ""; }
  event(name) { this.dispatchEvent(new Event(name)); }
}

function harness({ hlsSupported = true } = {}) {
  let callback;
  let time = 0;
  let nextTimer = 0;
  let unsubscribed = false;
  const timers = new Map();
  const audios = [], reports = [], acknowledgements = [], hlsInstances = [];
  class FakeHls {
    static Events = { ERROR: "error" };
    static isSupported() { return hlsSupported; }
    constructor(config) { this.config = config; hlsInstances.push(this); }
    on(_name, listener) { this.error = listener; }
    loadSource(url) { this.url = url; }
    attachMedia(media) { this.media = media; }
    stopLoad() { this.stopped = true; }
    destroy() { this.destroyed = true; }
  }
  const audio = createSoundCloudAudio({
    api: {
      onAudioCommand: (cb) => { callback = cb; return () => { unsubscribed = true; }; },
      reportAudioState: (state) => reports.push({ ...state, at: time }),
      audioCommandDone: (result) => acknowledgements.push(result),
    },
    createAudio: () => { const value = new FakeAudio(); audios.push(value); return value; },
    HlsClass: FakeHls,
    now: () => time,
    schedule: (cb, delay) => { const id = ++nextTimer; timers.set(id, { cb, at: time + delay }); return id; },
    cancel: (id) => timers.delete(id),
  });
  return {
    audio, audios, reports, acknowledgements, hlsInstances,
    command: (command) => callback(command),
    load: (session = "first", extra = {}) => callback({ type: "load", session, url: "soundcloud-media://local/opaque", streamType: "hls", ...extra }),
    advance: (ms = 250) => {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.cb(); }
    },
    get unsubscribed() { return unsubscribed; },
  };
}

test("reports only observed playback, limits reports to four per second, and keeps numbers finite", () => {
  const h = harness();
  h.load();
  assert.equal(h.reports[0].state, "loading");
  assert.equal(h.reports[0].duration, 0);
  const media = h.audios[0];
  media.duration = 120;
  media.currentTime = 12;
  media.event("playing");
  for (let i = 0; i < 20; i++) media.event("timeupdate");
  assert.equal(h.reports.length, 1);
  h.advance();
  assert.equal(h.reports.at(-1).state, "playing");
  assert.equal(h.reports.at(-1).position, 12);
  media.event("waiting");
  h.advance();
  assert.equal(h.reports.at(-1).state, "buffering");
  assert.equal(h.reports.at(-1).position, 12);
  media.currentTime = Infinity;
  media.event("timeupdate");
  h.advance();
  assert.equal(h.reports.at(-1).position, 0);
  assert.ok(h.reports.every((item, index) => index === 0 || item.at - h.reports[index - 1].at >= 250));
  h.audio.dispose();
});

test("source changes destroy prior media and suppress stale events and play rejections", async () => {
  const h = harness();
  h.load("old", { autoPlay: false });
  let rejectPlay;
  h.audios[0].playResult = new Promise((resolve, reject) => { rejectPlay = reject; });
  h.command({ type: "play", session: "old", requestId: "play-old" });
  h.load("new");
  assert.equal(h.hlsInstances[0].destroyed, true);
  assert.equal(h.audios[0].paused, true);
  assert.equal(h.audios[0].src, "");
  h.audios[0].event("playing");
  h.hlsInstances[0].error("error", { fatal: true });
  rejectPlay(new Error("signed-url-must-never-leak"));
  await Promise.resolve();
  await Promise.resolve();
  h.advance();
  assert.equal(h.reports.at(-1).session, "new");
  assert.equal(h.reports.at(-1).state, "loading");
  assert.ok(!JSON.stringify(h.reports).includes("signed-url"));
  assert.deepEqual(h.acknowledgements.find((ack) => ack.requestId === "play-old"),
    { requestId: "play-old", session: "old" });
  h.audio.dispose();
});

test("Play acknowledges acceptance while buffering longer than the IPC deadline", async () => {
  const h = harness();
  h.load("buffering", { autoPlay: false });
  h.advance();
  let finish;
  h.audios[0].playResult = new Promise((resolve) => { finish = resolve; });
  h.command({ type: "play", session: "buffering", requestId: "slow-play" });
  assert.deepEqual(h.acknowledgements.at(-1), { requestId: "slow-play", session: "buffering" });
  h.advance(11000);
  assert.ok(h.reports.every((report) => report.state !== "error"));
  finish();
  await Promise.resolve();
  h.audios[0].event("playing");
  h.advance();
  assert.equal(h.reports.at(-1).state, "playing");
  assert.equal(h.acknowledgements.filter((ack) => ack.requestId === "slow-play").length, 1);
  h.audio.dispose();
});

test("Play failures arrive through state after the acceptance acknowledgement", async () => {
  for (const error of [new Error("https://private.example/signed"), new DOMException("private detail", "NotAllowedError")]) {
    const h = harness();
    h.load("failed", { autoPlay: false });
    h.advance();
    let fail;
    h.audios[0].playResult = new Promise((_resolve, reject) => { fail = reject; });
    h.command({ type: "play", session: "failed", requestId: "play-failed" });
    assert.deepEqual(h.acknowledgements.at(-1), { requestId: "play-failed", session: "failed" });
    fail(error);
    await Promise.resolve();
    await Promise.resolve();
    h.advance();
    assert.equal(h.reports.at(-1).state, "error");
    assert.match(h.reports.at(-1).error, error.name === "NotAllowedError" ? /Press Play to allow/ : /could not play/);
    assert.ok(!JSON.stringify(h.reports).includes("private"));
    assert.equal(h.acknowledgements.filter((ack) => ack.requestId === "play-failed").length, 1);
    h.audio.dispose();
  }
});

test("loading without autoplay reports paused without depending on a native pause event", () => {
  const h = harness();
  h.load("paused", { autoPlay: false, requestId: "load-paused" });
  assert.equal(h.audios[0].paused, true);
  h.advance();
  assert.equal(h.reports.at(-1).state, "paused");
  assert.deepEqual(h.acknowledgements.at(-1), { requestId: "load-paused", session: "paused" });
  h.audios[0].duration = 30;
  h.audios[0].event("durationchange");
  h.advance();
  assert.equal(h.reports.at(-1).state, "paused");
  assert.equal(h.reports.at(-1).duration, 30);
  h.audio.dispose();
});

test("pause acknowledgments confirm playback stopped and stale commands cannot control a new track", () => {
  const h = harness();
  h.load("one");
  h.command({ type: "pause", session: "one", requestId: "pause-one" });
  assert.equal(h.audios[0].paused, true);
  assert.deepEqual(h.acknowledgements.at(-1), { requestId: "pause-one", session: "one" });
  h.load("two");
  h.command({ type: "pause", session: "one", requestId: "late" });
  assert.equal(h.audios[1].paused, false);
  assert.ok(h.acknowledgements.at(-1).error);
  h.command({ type: "stop", session: "two", requestId: "stop-two" });
  assert.equal(h.audios[1].paused, true);
  assert.equal(h.hlsInstances[1].destroyed, true);
  h.audio.dispose();
  assert.equal(h.unsubscribed, true);
});

test("accepts only opaque local media handles, including HLS child resources", () => {
  const h = harness();
  h.load("bad", { url: "https://secret.example/signed", requestId: "bad-load" });
  assert.equal(h.audios.length, 0);
  assert.ok(h.acknowledgements.at(-1).error);
  h.load("good");
  assert.equal(h.hlsInstances[0].config.enableWorker, false);
  assert.throws(() => h.hlsInstances[0].config.fetchSetup({ url: "https://secret.example/key" }, {}));
  assert.equal(h.hlsInstances[0].config.fetchSetup({ url: "soundcloud-media://local/segment" }, {}).url, "soundcloud-media://local/segment");
  h.audio.dispose();
});

test("fatal media failures stop playback, provide safe errors, and dispose cancels pending reports", () => {
  const h = harness();
  h.load();
  h.audios[0].event("playing");
  h.hlsInstances[0].error("error", { fatal: true, details: "https://secret.example/token" });
  h.advance();
  assert.equal(h.reports.at(-1).state, "error");
  assert.match(h.reports.at(-1).error, /open the track in SoundCloud/);
  assert.equal(h.audios[0].paused, true);
  assert.ok(!JSON.stringify(h.reports).includes("secret.example"));
  const count = h.reports.length;
  h.audios[0].event("timeupdate");
  h.audio.dispose();
  h.advance();
  assert.equal(h.reports.length, count);
});

test("unsupported HLS produces an actionable state without starting playback", () => {
  const h = harness({ hlsSupported: false });
  h.load();
  h.advance();
  assert.equal(h.reports.at(-1).state, "error");
  assert.match(h.reports.at(-1).error, /cannot play SoundCloud HLS/);
  assert.equal(h.audios[0].paused, true);
  h.audio.dispose();
});

test("seek and volume clamp finite input and reject non-finite values", () => {
  const h = harness();
  h.load();
  h.command({ type: "seek", session: "first", position: -20 });
  assert.equal(h.audios[0].currentTime, 0);
  h.audios[0].duration = 60;
  h.command({ type: "seek", session: "first", position: 100 });
  assert.equal(h.audios[0].currentTime, 60);
  h.command({ type: "volume", session: "first", volume: 200 });
  assert.equal(h.audios[0].volume, 1);
  h.command({ type: "seek", session: "first", position: Infinity, requestId: "invalid-seek" });
  assert.ok(h.acknowledgements.at(-1).error);
  assert.equal(h.audios[0].currentTime, 60);
  h.audio.dispose();
});
