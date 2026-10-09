const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/main/selftest.js"), "utf8");
const fixtures = {
  soundcloud: ["../../tests/helpers/soundcloud-fixture", "runSoundCloudSelftest"],
  "soundcloud-live": ["../../tests/helpers/soundcloud-live", "runLiveSoundCloudSelftest"],
};

// Dispatch only: neither Electron nor the fixture's API/playback operations run.
function dispatch(mode, { mock, packaged = false } = {}) {
  const calls = [];
  const messages = [];
  const ctx = {
    app: {
      isPackaged: packaged,
      exit(code) { calls.push(["exit", code]); },
      getPath(name) { calls.push(["getPath", name]); return "/tmp"; },
    },
    win: { webContents: {
      once(event) { calls.push(["diagnostic", event]); },
    } },
  };
  vm.runInNewContext(source + "\nmodule.exports(ctx);", {
    module: { exports: {} },
    ctx,
    process: { env: { NOSTALGIFY_SELFTEST: mode, NOSTALGIFY_MOCK: mock } },
    console: { error: (message) => messages.push(message) },
    require(name) {
      if (name === "fs" || name === "path") return require(name);
      const fixture = Object.values(fixtures).find(([file]) => file === name);
      assert.ok(fixture, `Unexpected dependency: ${name}`);
      return { [fixture[1]](received) {
        assert.equal(received, ctx);
        calls.push(["fixture", name]);
      } };
    },
  }, { timeout: 1000 });
  return { calls, messages };
}

for (const [mode, [file]] of Object.entries(fixtures)) {
  test(`${mode} rejects missing or non-1 mock values instead of running diagnostics`, { timeout: 1000 }, () => {
    for (const mock of [undefined, "", "0", "true"]) {
      const result = dispatch(mode, { mock });
      assert.deepEqual(result.calls, [["exit", 1]], `mock=${JSON.stringify(mock)}`);
      assert.deepEqual(result.messages, [`FAIL ${mode} requires a development app and NOSTALGIFY_MOCK=1`]);
    }
  });

  test(`${mode} rejects packaged apps before requiring a development fixture`, { timeout: 1000 }, () => {
    const result = dispatch(mode, { mock: "1", packaged: true });
    assert.deepEqual(result.calls, [["exit", 1]]);
    assert.match(result.messages[0], /requires a development app/);
  });

  test(`${mode} invokes its asserting fixture for a development app with mock=1`, { timeout: 1000 }, () => {
    const result = dispatch(mode, { mock: "1" });
    assert.deepEqual(result.calls, [["fixture", file]]);
    assert.deepEqual(result.messages, []);
  });
}

test("legacy diagnostic modes still register their window-load callback", { timeout: 1000 }, () => {
  const result = dispatch("buttons", { mock: "true" });
  assert.deepEqual(result.calls, [["getPath", "temp"], ["diagnostic", "did-finish-load"]]);
  assert.deepEqual(result.messages, []);
});
