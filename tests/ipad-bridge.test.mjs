import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNativeHost } from "../apps/ipad/src/bridge.js";
import { normalizeSnapshot, spotifyLinks } from "../packages/contracts/src/player.js";

const spotify = JSON.parse(await readFile(new URL("../packages/contracts/fixtures/spotify.json", import.meta.url)));
const local = JSON.parse(await readFile(new URL("../packages/contracts/fixtures/local.json", import.meta.url)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}, options = {}) {
  let state = structuredClone(spotify);
  let preferences = { retained: "existing" };
  let listener;
  let removed = false;
  const calls = [];
  const plugin = {
    addListener: async (_event, callback) => { listener = callback; return { remove: async () => { removed = true; } }; },
    getState: async () => structuredClone(state),
    getPreferences: async () => ({ value: structuredClone(preferences) }),
    setPreferences: async ({ value }) => { calls.push({ method: "setPreferences", value }); preferences = structuredClone(value); },
    command: async options => {
      calls.push({ method: "command", ...options });
      if (options.command === "provider") state = { ...local, sequence: state.sequence + 1 };
      return { state: structuredClone(state) };
    },
    getDiagnostics: async () => ({ events: [] }),
    connectSpotify: async () => {},
    exportDiagnostics: async value => { calls.push({ method: "exportDiagnostics", ...value }); return { shared: true }; },
    ...overrides,
  };
  const host = createNativeHost(plugin, { timeoutMs: 50, ...options });
  return { host, calls, plugin, emit(value) { listener(value); }, get preferences() { return preferences; }, get removed() { return removed; } };
}

test("native fixture snapshots preserve seconds and provider-specific volume capability", () => {
  assert.deepEqual(normalizeSnapshot(spotify), { ...spotify, error: null, message: "" });
  assert.deepEqual(normalizeSnapshot(local), { ...local, error: null, message: "" });
  const invalid = normalizeSnapshot({ position: Infinity, volume: NaN, capabilities: { canSeek: "yes" }, track: {} });
  assert.equal(invalid.position, 0); assert.equal(invalid.capabilities.canSeek, false); assert.equal(invalid.track, null);
});

test("Spotify links reject unrelated hosts, embedded credentials and non-content links", () => {
  const links = spotifyLinks("https://open.spotify.com/intl-en/track/abc?si=ignored spotify:track:abc https://open.spotify.com/playlist/XYZ");
  assert.deepEqual(links.map(item => item.uri), ["spotify:track:abc", "spotify:playlist:XYZ"]);
  for (const value of ["https://open.spotify.com.evil.test/track/abc", "https://secret@open.spotify.com/track/abc", "http://open.spotify.com/track/abc", "https://open.spotify.com:444/track/abc", "spotify:collection:tracks", "https://spotify.link/short", "javascript:alert(1)"]) assert.deepEqual(spotifyLinks(value), []);
});

test("a stale native poll cannot replace a newer state event", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  const pending = deferred(); f.plugin.getState = () => pending.promise;
  const request = f.host.getState();
  f.emit({ ...local, sequence: 12 });
  pending.resolve({ ...spotify, sequence: 9 });
  assert.equal((await request).provider, "local");
  f.emit({ ...spotify, sequence: 10 });
  assert.equal(f.host.getCachedState().sequence, 12);
});

test("a legacy unsequenced poll cannot replace an event arriving while it was pending", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  const pending = deferred(); f.plugin.getState = () => pending.promise;
  const request = f.host.getState(); f.emit(local);
  pending.resolve({ ...spotify, sequence: undefined });
  assert.equal((await request).provider, "local");
});

test("unsupported volume never reaches native Spotify; local volume does", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  await assert.rejects(f.host.command("volume", 40), { code: "unsupported" });
  assert.equal(f.calls.length, 0);
  f.emit(local);
  await f.host.command("volume", 40);
  assert.equal(f.calls[0].command, "volume");
  assert.match(f.calls[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("local shelf playback switches the native provider before loading its URI", async t => {
  const f = fixture(); t.after(() => f.host.dispose()); await f.host.ready;
  await f.host.command("playShelf", local.track.id);
  assert.deepEqual(f.calls.map(call => [call.command, call.arg]), [["provider", "local"], ["playShelf", local.track.id]]);
  await assert.rejects(f.host.command("playShelf", "local:../../private"), { code: "invalid_link" });
  assert.equal(f.calls.length, 2);
});

test("timeout releases the command queue, permits reconnect, and ignores a late result", async t => {
  const hanging = deferred(); let count = 0;
  const f = fixture({ command: () => ++count === 1 ? hanging.promise : Promise.resolve({ state: { ...local, sequence: 11 } }) }, { timeoutMs: 10 });
  t.after(() => f.host.dispose()); await f.host.ready;
  await assert.rejects(f.host.command("play"), { code: "timeout" });
  await f.host.connectSpotify();
  await f.host.command("pause");
  hanging.resolve({ state: { ...spotify, sequence: 99 } });
  await Promise.resolve();
  assert.equal(f.host.getCachedState().provider, "local");
});

test("known native errors are actionable while unknown details and tokens stay redacted", async t => {
  const f = fixture({ command: async () => { throw Object.assign(new Error("secret_token=do-not-leak"), { code: "spotify_not_installed" }); } });
  t.after(() => f.host.dispose()); await f.host.ready;
  await assert.rejects(f.host.command("play"), error => error.message.includes("Install Spotify") && !error.message.includes("secret"));
  f.plugin.command = async () => { throw Object.assign(new Error("access_token=do-not-leak"), { code: "unknown_with_secret" }); };
  await assert.rejects(f.host.command("play"), { code: "native_error" });
  assert.doesNotMatch(JSON.stringify(await f.host.getDiagnostics()), /do-not-leak|unknown_with_secret|access_token/);
});

test("concurrent preference patches preserve unrelated settings and serialize native writes", async t => {
  const first = deferred(); let writing = 0, peak = 0;
  const f = fixture({ setPreferences: async ({ value }) => { writing++; peak = Math.max(peak, writing); if (!value.shelf) await first.promise; f.calls.push(value); writing--; } });
  t.after(() => f.host.dispose()); await f.host.ready;
  const ui = f.host.saveUiPrefs({ playlistOpen: false });
  const shelf = f.host.saveShelf([{ uri: "spotify:track:abc" }]);
  first.resolve(); await Promise.all([ui, shelf]);
  assert.equal(peak, 1);
  assert.equal(f.calls.at(-1).retained, "existing");
  assert.equal(f.calls.at(-1).ui.playlistOpen, false);
  assert.equal(f.calls.at(-1).shelf[0].uri, "spotify:track:abc");
});

test("a failed preferences read cannot overwrite an existing native preference object", async t => {
  let reads = 0;
  const f = fixture({ getPreferences: async () => { if (++reads === 1) throw new Error("temporary"); return { value: { retained: "saved" } }; } });
  t.after(() => f.host.dispose()); await f.host.ready;
  await f.host.saveUiPrefs({ playlistOpen: true });
  assert.equal(f.preferences.retained, "saved");
  assert.equal(reads, 2);
});

test("diagnostic exports include bounded safe web events and disposal removes native listeners", async () => {
  const f = fixture(); await f.host.ready;
  for (let i = 0; i < 170; i++) f.host.recordError("javascript_error");
  await f.host.exportDiagnostics();
  const payload = f.calls.find(call => call.method === "exportDiagnostics");
  assert.equal(payload.webEvents.length, 150);
  assert.equal(payload.webEvents.at(-1).code, "javascript_error");
  await f.host.dispose(); assert.equal(f.removed, true);
});
