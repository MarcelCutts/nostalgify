const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../apps/desktop/src/main/spotify-selftest.js"), "utf8");

// Exercise failure/cleanup without launching Electron or controlling Spotify.
function harness({ platform = "darwin", env = { NOSTALGIFY_SELFTEST: "real" }, jsError = false, disposeError = false } = {}) {
  const calls = [];
  const messages = [];
  let onLoad;
  const state = { running: true, state: "playing", volume: 60 };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    process: { platform, env, pid: 123 },
    console: { log: (...args) => messages.push(args.join(" ")), error: (...args) => messages.push(args.join(" ")) },
    setTimeout, clearTimeout,
    require(name) {
      if (name === "node:assert/strict") return assert;
      if (name === "node:child_process") return {
        execFile(file, args, options, callback) {
          assert.equal(file, "osascript");
          const raw = Number(args[1].match(/set sound volume to (\d+)/)?.[1]);
          assert.ok(Number.isFinite(raw), "Only volume restoration may call AppleScript in this failure test");
          calls.push(["rawVolume", raw]);
          state.volume = raw ? raw - 1 : 0; // Spotify's observed rounding behavior.
          callback(null, "");
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const ctx = {
    win: { webContents: {
      once(event, callback) { assert.equal(event, "did-finish-load"); onLoad = callback; },
      async executeJavaScript() { if (jsError) throw new Error("Renderer unavailable"); return true; },
    } },
    app: { exit(code) { calls.push(["exit", code]); }, quit() { calls.push(["quit"]); } },
    async getSpotifyState() { return { ...state }; },
    async spotifyCommand(command, value) {
      calls.push([command, value]);
      if (command === "pause") state.state = "paused";
      if (command === "volume") state.volume = value;
    },
    playback: {
      async command() { throw new Error("Provider selection failed"); },
      async dispose() { calls.push(["dispose"]); if (disposeError) throw new Error("Playback is still busy"); },
    },
  };
  module.exports.runRealSpotifySelftest(ctx);
  return { calls, messages, state, onLoad };
}

test("real Spotify self-tests reject any active mock flag before registering or controlling playback", () => {
  for (const value of ["1", "0", "true"]) {
    const h = harness({ env: { NOSTALGIFY_SELFTEST: "real", NOSTALGIFY_MOCK: value } });
    assert.deepEqual(h.calls, [["exit", 1]]);
    assert.equal(h.onLoad, undefined);
  }
});

test("real Spotify self-tests require an explicit real/focus mode and macOS", () => {
  for (const options of [{ platform: "linux" }, { env: {} }, { env: { NOSTALGIFY_SELFTEST: "soundcloud" } }]) {
    const h = harness(options);
    assert.deepEqual(h.calls, [["exit", 1]]);
    assert.equal(h.onLoad, undefined);
  }
});

test("failure after muting pauses Spotify and restores its original observed volume before exiting nonzero", async () => {
  const h = harness();
  await h.onLoad();
  assert.equal(h.state.state, "paused");
  assert.equal(h.state.volume, 60);
  assert.deepEqual(h.calls, [["pause", undefined], ["volume", 0], ["dispose"], ["pause", undefined], ["rawVolume", 60], ["rawVolume", 61], ["exit", 1]]);
  assert.ok(h.messages.some((message) => message.includes("Provider selection failed")));
  assert.ok(h.messages.some((message) => message.includes("original volume restored")));
});

test("early UI failure still pauses Spotify and never writes an unknown original volume", async () => {
  const h = harness({ jsError: true });
  await h.onLoad();
  assert.equal(h.state.state, "paused");
  assert.equal(h.state.volume, 60);
  assert.deepEqual(h.calls, [["dispose"], ["pause", undefined], ["exit", 1]]);
  assert.ok(h.messages.some((message) => message.includes("original volume unchanged")));
});

test("failed command drain keeps Spotify muted instead of restoring audible volume", async () => {
  const h = harness({ disposeError: true });
  await h.onLoad();
  assert.equal(h.state.volume, 0);
  assert.equal(h.state.state, "paused");
  assert.ok(!h.calls.some(([command]) => command === "rawVolume"));
  assert.deepEqual(h.calls.slice(-3), [["volume", 0], ["pause", undefined], ["exit", 1]]);
  assert.ok(h.messages.some((message) => message.startsWith("FAIL real Spotify cleanup:")));
});
