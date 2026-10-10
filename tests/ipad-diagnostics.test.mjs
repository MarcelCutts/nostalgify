import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNativeHost } from "../apps/ipad/src/bridge.js";

function fixture(overrides = {}) {
  const exports = [];
  const plugin = {
    getState: async () => ({ sequence: 1 }),
    getPreferences: async () => ({ value: {} }),
    listAudio: async () => ({ items: [] }),
    getDiagnostics: async () => ({ events: [] }),
    exportDiagnostics: async value => { exports.push(value); return { shared: true }; },
    ...overrides,
  };
  return { plugin, exports, host: createNativeHost(plugin) };
}

// Check native emitters, so a newly introduced ordinary failure needs safe web text
// instead of silently degrading to native_error. Test fixtures/selfcheck are separate.
const nativeSources = await Promise.all([
  "NativeModels", "NativePlayback", "NostalgifyNativePlugin", "SpotifyRemoteService", "LocalAudioService",
].map(name => readFile(new URL(`../apps/ipad/ios/App/App/Native/${name}.swift`, import.meta.url), "utf8")));
const nativeCodes = new Set(nativeSources.flatMap(source => [
  ...source.matchAll(/(?:NativeFailure\(code:\s*|\bsetFailure\(|\bfailed\()"([a-z_]+)"/g),
  ...source.matchAll(/call\.reject\("[^"\n]*",\s*"([a-z_]+)"/g),
].map(match => match[1])));
// These are coordinated additions from the local playback task on the same base.
nativeCodes.add("local_seek_failed");
nativeCodes.add("local_seek_timeout");

const actionableMessages = {
  spotify_connection_timeout: "Spotify did not respond. Tap Connect Spotify to open Spotify and reconnect.",
  spotify_connection_cancelled: "Connecting to Spotify was cancelled. Try the playback control again when ready.",
  invalid_provider: "Choose Spotify or Local Files before using playback controls.",
  inactive_provider: "Select Local Files before using this control.",
  invalid_command: "That playback control is unavailable. Refresh the connection and try again.",
  picker_unavailable: "The file picker is unavailable. Reopen the app and try importing again.",
  local_seek_failed: "The audio position could not be changed. Press Play and try again.",
  local_seek_timeout: "The audio position took too long to change. Press Play and try again.",
};

test("ordinary native codes retain safe identity and actionable text without native messages", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  assert.ok(nativeCodes.size >= 40, "inventory includes ordinary state and rejection codes");
  for (const code of nativeCodes) {
    f.plugin.listAudio = async () => { throw Object.assign(new Error("access_token=private-title"), { code }); };
    await assert.rejects(f.host.listAudio(), error => {
      assert.equal(error.code, code, `safe mapping for ${code}`);
      assert.doesNotMatch(error.message, /private-title|access_token/);
      assert.ok(error.message.length > 20);
      if (actionableMessages[code]) assert.equal(error.message, actionableMessages[code]);
      return true;
    });
  }
  await f.host.exportDiagnostics();
  assert.deepEqual(new Set(f.exports[0].webEvents.filter(row => row.event === "failure").map(row => row.code)), nativeCodes);
  assert.doesNotMatch(JSON.stringify(f.exports), /private-title|access_token/);
});

test("hundreds of successful state polls and other successful calls preserve failure evidence", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  f.host.recordError("skin_storage_unavailable");
  f.host.recordError("startup_failed");
  f.plugin.getState = async () => { throw Object.assign(new Error("private"), { code: "spotify_connection_timeout" }); };
  await assert.rejects(f.host.getState(), { code: "spotify_connection_timeout" });
  f.plugin.getState = async () => ({ sequence: 2 });
  for (let i = 0; i < 400; i++) await f.host.getState();
  for (let i = 0; i < 200; i++) await f.host.listAudio();
  const { web } = await f.host.getDiagnostics();
  assert.equal(web.length, 150);
  assert.equal(web.some(row => row.event === "getState"), false);
  assert.deepEqual(web.filter(row => row.code).map(row => row.code), ["skin_storage_unavailable", "startup_failed", "spotify_connection_timeout"]);
  await f.host.exportDiagnostics();
  assert.deepEqual(f.exports[0].webEvents.filter(row => row.code), web.filter(row => row.code));
});

test("a saturated failure buffer retains the newest 150 failures and ignores new successful activity", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  for (let line = 0; line < 175; line++) f.host.recordError("javascript_error", { line });
  await f.host.listAudio();
  for (let i = 0; i < 175; i++) await f.host.getState();
  const { web } = await f.host.getDiagnostics();
  assert.equal(web.length, 150);
  assert.deepEqual(web.map(row => row.line), Array.from({ length: 150 }, (_, i) => i + 25));
  assert.ok(web.every(row => row.event === "web_error"));
});

test("listener registration failure survives successful polling", async t => {
  const f = fixture({ addListener: async () => { throw new Error("private"); } });
  t.after(() => f.host.dispose()); await f.host.ready;
  for (let i = 0; i < 175; i++) await f.host.getState();
  assert.ok((await f.host.getDiagnostics()).web.some(row => row.event === "listener_unavailable"));
});

test("web recording admits only safe structure and fixed codes, including skin failures", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  const id = "12345678-1234-1234-1234-123456789012";
  f.host.recordError("skin_load_failed", {
    code: "private_code", event: "private_event", time: "private_time", requestId: id,
    durationMs: 12, errorClass: "TypeError", source: "app.js", line: 42, column: 7,
    message: "access_token=private", stack: "private-stack", url: "https://private.example", nested: { secret: "private" },
  });
  f.host.recordError("skin_storage_unavailable");
  f.host.recordError("private_token", {
    requestId: "private_id", durationMs: Infinity, errorClass: "private", source: "file:///private/song.mp3",
    line: -1, column: 2 ** 32,
  });
  f.plugin.listAudio = async () => { throw Object.assign(new Error("secret=private"), { code: "private_rejection" }); };
  await assert.rejects(f.host.listAudio(), { code: "native_error" });
  const { web } = await f.host.getDiagnostics();
  const rows = web.filter(row => row.event === "web_error");
  assert.deepEqual(rows.map(({ time, ...row }) => row), [
    { event: "web_error", requestId: id, durationMs: 12, code: "skin_load_failed", errorClass: "TypeError", source: "app.js", line: 42, column: 7 },
    { event: "web_error", code: "skin_storage_unavailable" },
    { event: "web_error", code: "unexpected" },
  ]);
  assert.ok(rows.every(row => Number.isFinite(Date.parse(row.time))));
  assert.doesNotMatch(JSON.stringify(web), /private|secret|access_token/);
});

test("diagnostic consumers cannot mutate stored event objects", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  f.host.recordError("skin_load_failed");
  const report = await f.host.getDiagnostics();
  report.web.find(row => row.event === "web_error").code = "private_report";
  await f.host.exportDiagnostics();
  f.exports[0].webEvents.find(row => row.event === "web_error").code = "private_plugin";
  const next = await f.host.getDiagnostics();
  assert.equal(next.web.find(row => row.event === "web_error").code, "skin_load_failed");
  assert.doesNotMatch(JSON.stringify(next), /private_/);
});

test("production browser diagnostics remain available without a native plugin", async t => {
  const host = createNativeHost(null);
  t.after(() => host.dispose()); await host.ready;
  host.recordError("skin_storage_unavailable");
  const report = await host.getDiagnostics();
  assert.equal(report.native, null);
  assert.equal(report.version, 1);
  assert.ok(report.web.some(row => row.code === "skin_storage_unavailable"));
  assert.ok(report.web.some(row => row.code === "native_unavailable"));
});
