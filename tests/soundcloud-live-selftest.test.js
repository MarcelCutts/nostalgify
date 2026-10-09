const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "helpers/soundcloud-live.js"), "utf8");

function harness({ platform = "darwin", mock, packaged = false, disposeError = false } = {}) {
  const calls = [];
  const messages = [];
  let onLoad;
  const state = { running: true, state: "playing", volume: 44 };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    process: { platform, env: {
      NOSTALGIFY_SELFTEST: "soundcloud-live-real",
      ...(mock === undefined ? {} : { NOSTALGIFY_MOCK: mock }),
      SOUNDCLOUD_CLIENT_ID: "test-only-client",
      SOUNDCLOUD_CLIENT_SECRET: "test-only-secret",
    } },
    console: { log: (...args) => messages.push(args.join(" ")), error: (...args) => messages.push(args.join(" ")) },
    setTimeout, clearTimeout,
    require(name) {
      if (name === "../../src/main/spotify-selftest") return {
        bounded: async (_label, operation) => operation(),
        restoreSpotifyVolume: async (volume) => { calls.push(["restore", volume]); state.volume = volume; },
      };
      return require(name);
    },
  });
  module.exports.runLiveSoundCloudSelftest({
    app: { isPackaged: packaged, exit: (code) => calls.push(["exit", code]), quit: () => calls.push(["quit"]) },
    win: { webContents: {
      once(event, callback) { assert.equal(event, "did-finish-load"); onLoad = callback; },
      async executeJavaScript() { return true; },
    } },
    playback: {
      async command(command) {
        calls.push(["provider", command]);
        if (command === "selectProvider") throw new Error("Provider selection failed");
      },
      async dispose() { calls.push(["dispose"]); if (disposeError) throw new Error("Playback is still busy"); },
    },
    getSpotifyState: async () => ({ ...state }),
    async spotifyCommand(command, value) {
      calls.push(["spotify", command, value]);
      if (command === "pause") state.state = "paused";
      if (command === "volume") state.volume = value;
    },
  });
  return { calls, messages, state, onLoad };
}

test("live SoundCloud with real Spotify rejects mock, non-macOS and packaged execution before touching playback", () => {
  for (const options of [{ mock: "1" }, { mock: "0" }, { platform: "linux" }, { packaged: true }]) {
    const h = harness(options);
    assert.deepEqual(h.calls, [["exit", 1]]);
    assert.equal(h.onLoad, undefined);
  }
});

test("live handoff failure pauses both providers and restores the captured Spotify volume", async () => {
  const h = harness();
  await h.onLoad();
  assert.equal(h.state.state, "paused");
  assert.equal(h.state.volume, 44);
  assert.deepEqual(h.calls, [
    ["spotify", "pause", undefined], ["spotify", "volume", 0], ["provider", "selectProvider"],
    ["dispose"], ["spotify", "pause", undefined], ["restore", 44], ["exit", 1],
  ]);
  assert.ok(h.messages.some((message) => message.includes("Provider selection failed")));
  assert.ok(h.messages.some((message) => message.includes("original volume restored")));
  assert.ok(!h.messages.join(" ").includes("test-only-"), "Credentials must not appear in diagnostic output");
});

test("live handoff cleanup keeps Spotify muted if pending playback cannot be drained", async () => {
  const h = harness({ disposeError: true });
  await h.onLoad();
  assert.equal(h.state.volume, 0);
  assert.equal(h.state.state, "paused");
  assert.ok(!h.calls.some(([command]) => command === "restore"));
  assert.deepEqual(h.calls.slice(-3), [["spotify", "volume", 0], ["spotify", "pause", undefined], ["exit", 1]]);
  assert.ok(h.messages.some((message) => message.startsWith("FAIL live SoundCloud cleanup:")));
});
