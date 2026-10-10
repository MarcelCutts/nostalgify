import test from "node:test";
import assert from "node:assert/strict";
import { createNativeHost } from "../apps/ipad/src/bridge.js";

const savedLink = { provider: "spotify", kind: "track", uri: "spotify:track:0123456789abcdefghijkl", title: "Saved track" };
const initialPreferences = () => ({ shelf: [savedLink], ui: { playlistOpen: true }, retained: "existing settings" });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture(t, overrides = {}) {
  let preferences = initialPreferences();
  const writes = [];
  const plugin = {
    getState: async () => ({}),
    getPreferences: async () => ({ value: structuredClone(preferences) }),
    setPreferences: async ({ value }) => { writes.push(structuredClone(value)); preferences = structuredClone(value); },
    ...overrides,
  };
  const host = createNativeHost(plugin, { timeoutMs: 100 });
  t.after(() => host.dispose());
  return { host, plugin, writes, get preferences() { return preferences; } };
}

test("the first failed preference read is retried before a shelf becomes authoritative", async t => {
  let reads = 0;
  const f = fixture(t, { getPreferences: async () => {
    if (++reads === 1) throw new Error("cold-start failure");
    return { value: initialPreferences() };
  } });
  await f.host.ready;
  const shelf = await f.host.loadShelf();
  assert.deepEqual(shelf, [savedLink]);
  // A Files import saves the same Spotify shortcuts, even though it adds a
  // local row to the combined player shelf.
  await f.host.saveShelf(shelf);
  assert.deepEqual(f.preferences, initialPreferences());
  assert.equal(reads, 2);
});

test("unavailable preferences reject reads and writes until a later retry succeeds", async t => {
  let unavailable = true;
  const f = fixture(t, { getPreferences: async () => {
    if (unavailable) throw new Error("storage unavailable");
    return { value: initialPreferences() };
  } });
  await f.host.ready;
  await assert.rejects(f.host.getPreferences());
  await assert.rejects(f.host.loadShelf());
  await assert.rejects(f.host.saveUiPrefs({ playlistOpen: false }));
  assert.deepEqual(f.writes, [], "an unavailable store must never accept an empty replacement");
  unavailable = false;
  await f.host.saveUiPrefs({ playlistOpen: false });
  assert.deepEqual((await f.host.getPreferences()).shelf, [savedLink]);
  assert.equal(f.preferences.retained, "existing settings");
  assert.equal(f.preferences.ui.playlistOpen, false);
});

test("concurrent readers and a writer share a recovery read without replacing its cache", async t => {
  let reads = 0;
  const gate = deferred(), started = deferred();
  const f = fixture(t, { getPreferences: async () => {
    if (++reads === 1) throw new Error("initial failure");
    started.resolve();
    await gate.promise;
    return { value: initialPreferences() };
  } });
  await f.host.ready;
  const readers = [f.host.getPreferences(), f.host.loadShelf()];
  await started.promise;
  const saving = f.host.saveUiPrefs({ playlistOpen: false });
  gate.resolve();
  await Promise.all([...readers, saving]);
  assert.equal(reads, 2, "only one native recovery read runs");
  assert.deepEqual((await f.host.getPreferences()).shelf, [savedLink]);
  assert.equal((await f.host.getPreferences()).ui.playlistOpen, false);
});

test("a timed-out first read cannot replace recovered preferences when its result arrives late", async t => {
  const late = deferred();
  let reads = 0;
  const f = fixture(t, { getPreferences: () => ++reads === 1 ? late.promise : Promise.resolve({ value: initialPreferences() }) });
  await f.host.ready;
  assert.deepEqual(await f.host.loadShelf(), [savedLink]);
  await f.host.saveUiPrefs({ playlistOpen: false });
  late.resolve({ value: {} });
  await Promise.resolve();
  assert.deepEqual((await f.host.getPreferences()).shelf, [savedLink]);
  assert.equal((await f.host.getPreferences()).ui.playlistOpen, false);
});

test("malformed preference responses are unavailable, while a confirmed empty object is valid", async t => {
  let value;
  const f = fixture(t, { getPreferences: async () => ({ value }) });
  await f.host.ready;
  await assert.rejects(f.host.getPreferences(), /could not be read/);
  value = [];
  await assert.rejects(f.host.savePreferences({ shelf: [] }), /could not be read/);
  assert.deepEqual(f.writes, []);
  value = {};
  assert.deepEqual(await f.host.getPreferences(), {});
});

test("failed writes leave the last acknowledged preferences available for a retry", async t => {
  const f = fixture(t);
  await f.host.ready;
  const write = f.plugin.setPreferences;
  f.plugin.setPreferences = async () => { throw new Error("write failed"); };
  await assert.rejects(f.host.savePreferences({ shelf: [] }));
  assert.deepEqual(await f.host.loadShelf(), [savedLink]);
  f.plugin.setPreferences = write;
  await f.host.saveUiPrefs({ playlistOpen: false });
  assert.deepEqual(f.preferences.shelf, [savedLink]);
});

test("a browser preview exposes an empty read-only store without masking native failures", async t => {
  const host = createNativeHost(null);
  t.after(() => host.dispose());
  await host.ready;
  assert.deepEqual(await host.getPreferences(), {});
  await assert.rejects(host.savePreferences({ shelf: [savedLink] }), { code: "native_unavailable" });
  assert.deepEqual(await host.loadShelf(), []);
});
