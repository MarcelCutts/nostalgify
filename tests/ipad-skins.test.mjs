import test from "node:test";
import assert from "node:assert/strict";
import { attachSkinStore } from "../apps/ipad/src/skins.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const file = name => new File([new Uint8Array([80, 75]), name], `${name}.wsz`);

function fixture(t) {
  const records = new Map(), blobs = new Map(), revoked = [], writes = [], errors = [];
  const loadSteps = [], saveSteps = [], readSteps = [], loads = [], changes = [], storageOperations = [];
  let preferences = { skinId: null, retained: "other preferences" };
  let visible = null, requested, sequence = 0, failDelete = false, failRead = false, storageUnavailable = false;
  const originalIndexedDB = globalThis.indexedDB;
  // Model transaction completion rather than request success: mutations become
  // visible only at commit, and aborts leave the original records intact.
  globalThis.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => {
              const operation = (name, value) => {
                const result = {};
                storageOperations.push(name);
                const readStep = name === "getAll" ? readSteps.shift() : null;
                setImmediate(async () => {
                  if (name === "getAll") {
                    await readStep?.();
                    if (failRead || storageUnavailable) {
                      failRead = false;
                      tx.onabort();
                      return;
                    }
                  }
                  if (name === "delete" && failDelete) {
                    failDelete = false;
                    tx.onabort();
                    return;
                  }
                  if (name === "getAll") result.result = structuredClone([...records.values()]);
                  if (name === "put") { records.set(value.id, structuredClone(value)); result.result = value.id; }
                  if (name === "delete") records.delete(value);
                  tx.oncomplete();
                });
                return result;
              };
              return {
                getAll: () => operation("getAll"),
                put: value => operation("put", value),
                delete: id => operation("delete", id),
              };
            };
            return tx;
          },
        };
        request.onsuccess();
      });
      return request;
    },
  };
  t.after(() => {
    if (originalIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDB;
  });
  t.mock.method(URL, "createObjectURL", blob => { const url = `blob:skin-${++sequence}`; blobs.set(url, blob); return url; });
  t.mock.method(URL, "revokeObjectURL", url => { revoked.push(url); blobs.delete(url); });
  function createHost() {
    const host = attachSkinStore({
      getPreferences: async () => structuredClone(preferences),
      async savePreferences(update) {
        writes.push(structuredClone(update));
        await saveSteps.shift()?.(update);
        preferences = { ...preferences, ...update };
      },
      recordError: code => errors.push(code),
      restoreDefaultSkin() { loads.push(null); visible = null; },
      confirmSkinLoad() {
        const url = requested;
        const step = loadSteps.shift();
        return Promise.resolve().then(async () => {
          await step?.(url);
          visible = url;
        });
      },
    });
    // Match the renderer: onSetSkin immediately starts fetch, which announces
    // skinChosen before the eventual asynchronous load confirmation.
    host.onSetSkin(url => { requested = url; loads.push(url); host.skinChosen(url); });
    host.onSkinsChanged(skins => changes.push(skins.slice()));
    return host;
  }
  return {
    host: createHost(), createHost, records, blobs, revoked, writes, errors, loadSteps, saveSteps, readSteps, loads, changes, storageOperations,
    get preferences() { return preferences; },
    get visible() { return visible; },
    failNextDelete() { failDelete = true; },
    failNextRead() { failRead = true; },
    setStorageUnavailable(value) { storageUnavailable = value; },
    failNextSave(error = new Error("preferences unavailable")) { saveSteps.push(async () => { throw error; }); return error; },
    failNextLoad(error = new Error("malformed skin")) { loadSteps.push(async () => { throw error; }); return error; },
  };
}

test("re-import save failure preserves stored bytes, identity, URL and saved selection", async t => {
  const f = fixture(t), archive = file("Saved");
  const skin = await f.host.importSkin(archive);
  const record = structuredClone(f.records.get(skin.id));
  const error = f.failNextSave();
  await assert.rejects(f.host.importSkin(archive), value => value === error);
  assert.deepEqual(f.records.get(skin.id), record);
  assert.deepEqual((await f.host.initSkins()).skins, [skin]);
  assert.equal(f.visible, skin.url);
  assert.equal(f.preferences.skinId, skin.id);
  assert.equal(f.preferences.retained, "other preferences");
  assert.ok(f.host.isSkinUrl(skin.url));
  assert.ok(f.blobs.has(skin.url));
  assert.deepEqual(f.revoked, []);
  assert.equal(f.writes.length, 2, "rollback must not write preferences again");
});

test("a failed re-import load keeps an existing unselected skin and the previous selection", async t => {
  const f = fixture(t), archive = file("Saved");
  const saved = await f.host.importSkin(archive);
  const selected = await f.host.importSkin(file("Selected"));
  const error = f.failNextLoad();
  await assert.rejects(f.host.importSkin(archive), value => value === error);
  assert.equal(f.records.size, 2);
  assert.deepEqual((await f.host.initSkins()).skins, [saved, selected]);
  assert.equal(f.visible, selected.url);
  assert.equal(f.preferences.skinId, selected.id);
  assert.ok(f.host.isSkinUrl(saved.url));
  assert.deepEqual(f.revoked, []);
});

test("new import save failure restores the prior skin before removing only the new record", async t => {
  const f = fixture(t);
  const previous = await f.host.importSkin(file("Previous"));
  const error = f.failNextSave();
  await assert.rejects(f.host.importSkin(file("New")), value => value === error);
  assert.deepEqual([...f.records.keys()], [previous.id]);
  assert.deepEqual((await f.host.initSkins()).skins, [previous]);
  assert.equal(f.visible, previous.url);
  assert.equal(f.preferences.skinId, previous.id);
  assert.equal(f.revoked.length, 1);
  assert.notEqual(f.revoked[0], previous.url);
  assert.equal(f.host.isSkinUrl(f.revoked[0]), false);
  assert.equal(f.writes.length, 2);
});

test("new import save failure restores the default and releases its new URL", async t => {
  const f = fixture(t);
  f.failNextSave();
  await assert.rejects(f.host.importSkin(file("New")), /preferences unavailable/);
  assert.equal(f.visible, null);
  assert.equal(f.preferences.skinId, null);
  assert.equal(f.records.size, 0);
  assert.deepEqual((await f.host.initSkins()).skins, []);
  assert.equal(f.revoked.length, 1);
});

test("selecting a saved skin or the default rolls back a failed preference save", async t => {
  const f = fixture(t);
  const first = await f.host.importSkin(file("First"));
  const previous = await f.host.importSkin(file("Previous"));
  for (const id of [first.id, null]) {
    const writes = f.writes.length;
    f.failNextSave();
    await assert.rejects(f.host.selectSkin(id), /preferences unavailable/);
    assert.equal(f.visible, previous.url);
    assert.equal(f.preferences.skinId, previous.id);
    assert.equal(f.writes.length, writes + 1);
  }
  assert.equal(f.records.size, 2);
  assert.deepEqual(f.revoked, []);
});

test("overlapping same-byte failed imports preserve unrelated records and recover the queue", async t => {
  const f = fixture(t), gate = deferred(), started = deferred();
  const unrelated = await f.host.importSkin(file("Unrelated"));
  f.saveSteps.push(async () => { started.resolve(); await gate.promise; throw new Error("first failure"); });
  f.failNextSave(new Error("second failure"));
  const archive = file("Duplicate");
  const first = assert.rejects(f.host.importSkin(archive), /first failure/);
  await started.promise;
  const second = assert.rejects(f.host.importSkin(archive), /second failure/);
  await new Promise(setImmediate);
  assert.equal(f.records.size, 2);
  assert.equal(f.loads.length, 2, "second import cannot begin its load during the first save");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual([...f.records.keys()], [unrelated.id]);
  assert.deepEqual((await f.host.initSkins()).skins, [unrelated]);
  assert.equal(f.visible, unrelated.url);
  assert.equal(f.preferences.skinId, unrelated.id);
  assert.equal(f.revoked.length, 2);
  assert.ok(!f.revoked.includes(unrelated.url));
  const recovered = await f.host.importSkin(file("Recovered"));
  assert.equal(f.visible, recovered.url);
  assert.equal(f.preferences.skinId, recovered.id);
});

test("a queued default selection waits for failed import recovery and then wins", async t => {
  const f = fixture(t), gate = deferred(), started = deferred();
  const previous = await f.host.importSkin(file("Previous"));
  f.saveSteps.push(async () => { started.resolve(); await gate.promise; throw new Error("import failure"); });
  const importing = assert.rejects(f.host.importSkin(file("New")), /import failure/);
  await started.promise;
  const selecting = f.host.selectSkin(null);
  gate.resolve();
  await Promise.all([importing, selecting]);
  assert.equal(f.visible, null);
  assert.equal(f.preferences.skinId, null);
  assert.deepEqual([...f.records.keys()], [previous.id]);
});

test("success deduplicates imports and reload restores a saved skin without another write", async t => {
  const f = fixture(t), archive = file("Saved");
  const skin = await f.host.importSkin(archive);
  assert.equal(await f.host.importSkin(archive), skin);
  assert.equal(f.records.size, 1);
  const writes = f.writes.length;
  const reloaded = f.createHost();
  const { skins, initial } = await reloaded.initSkins();
  assert.equal(initial, null);
  assert.equal(skins[0].id, skin.id);
  assert.notEqual(skins[0].url, skin.url);
  f.failNextSave();
  await reloaded.restoreSavedSkin();
  assert.equal(f.visible, skins[0].url);
  assert.equal(f.preferences.skinId, skin.id);
  assert.equal(f.writes.length, writes, "startup restoration must work when preference writes are unavailable");
});

test("malformed new import preserves the prior skin and malformed saved restore falls back", async t => {
  const f = fixture(t);
  const previous = await f.host.importSkin(file("Previous"));
  f.failNextLoad();
  await assert.rejects(f.host.importSkin(file("Malformed")), /malformed skin/);
  assert.equal(f.visible, previous.url);
  assert.equal(f.preferences.skinId, previous.id);
  assert.deepEqual([...f.records.keys()], [previous.id]);
  const reloaded = f.createHost();
  f.failNextLoad();
  await assert.rejects(reloaded.restoreSavedSkin(), /malformed skin/);
  assert.equal(f.visible, null);
  assert.equal(f.preferences.skinId, null);
  assert.ok(f.records.has(previous.id), "a failed saved load must not discard its archive");
});

test("missing saved skin recovers to default without changing other stored skins", async t => {
  const f = fixture(t);
  const previous = await f.host.importSkin(file("Previous"));
  f.records.delete(previous.id);
  const reloaded = f.createHost();
  await assert.rejects(reloaded.restoreSavedSkin(), /Choose a saved skin/);
  assert.equal(f.visible, null);
  assert.equal(f.preferences.skinId, null);
});

test("failed visual rollback retains the new archive and preserves the original save error", async t => {
  const f = fixture(t);
  const previous = await f.host.importSkin(file("Previous"));
  f.loadSteps.push(async () => {});
  f.failNextLoad(new Error("rollback load failed"));
  const error = f.failNextSave();
  await assert.rejects(f.host.importSkin(file("New")), value => value === error);
  const skins = (await f.host.initSkins()).skins;
  assert.equal(skins.length, 2);
  assert.equal(f.records.size, 2);
  assert.equal(f.visible, skins[1].url);
  assert.ok(f.host.isSkinUrl(f.visible));
  assert.ok(f.blobs.has(f.visible));
  assert.equal(f.preferences.skinId, previous.id);
  assert.deepEqual(f.revoked, []);
  assert.ok(f.errors.includes("skin_load_failed"));
  await f.host.selectSkin(previous.id);
  assert.equal(f.visible, previous.url);
});

test("cleanup storage failure retains the record and URL and reports the original error", async t => {
  const f = fixture(t), error = f.failNextSave();
  f.failNextDelete();
  await assert.rejects(f.host.importSkin(file("New")), value => value === error);
  const { skins } = await f.host.initSkins();
  assert.equal(f.visible, null);
  assert.equal(f.preferences.skinId, null);
  assert.equal(skins.length, 1);
  assert.equal(f.records.size, 1);
  assert.ok(f.host.isSkinUrl(skins[0].url));
  assert.deepEqual(f.revoked, []);
  assert.ok(f.errors.includes("skin_storage_unavailable"));
});

test("invalid imports and missing selections do not disturb the saved skin", async t => {
  const f = fixture(t), previous = await f.host.importSkin(file("Previous"));
  await assert.rejects(f.host.importSkin(new File(["text"], "not-a-skin.txt")), /Choose a .wsz or .zip/);
  await assert.rejects(f.host.importSkin(new File(["text"], "not-a-zip.wsz")), /not a ZIP/);
  await assert.rejects(f.host.selectSkin("missing"), /Choose a saved skin/);
  assert.equal(f.visible, previous.url);
  assert.equal(f.preferences.skinId, previous.id);
  assert.deepEqual([...f.records.keys()], [previous.id]);
});

test("repeated unavailable reads cannot overwrite a re-import or reset any saved selection", async t => {
  const f = fixture(t), archive = file("Saved");
  const previous = await f.host.importSkin(archive);
  const record = structuredClone(f.records.get(previous.id));
  const writes = f.writes.length;
  const reloaded = f.createHost();
  const beforeStorage = f.storageOperations.length;
  const beforeURLs = f.blobs.size;
  f.setStorageUnavailable(true);
  assert.deepEqual((await reloaded.initSkins()).skins, []);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reloaded.importSkin(archive), /Skin storage is unavailable/);
    await assert.rejects(reloaded.selectSkin(previous.id), /Skin storage is unavailable/);
    await assert.rejects(reloaded.selectSkin(null), /Skin storage is unavailable/);
    await assert.rejects(reloaded.restoreSavedSkin(), /Skin storage is unavailable/);
  }
  assert.deepEqual(f.records.get(previous.id), record);
  assert.equal(f.records.size, 1);
  assert.equal(f.preferences.skinId, previous.id);
  assert.equal(f.writes.length, writes);
  assert.equal(f.blobs.size, beforeURLs);
  assert.deepEqual(f.storageOperations.slice(beforeStorage), Array(9).fill("getAll"));
  assert.deepEqual(f.revoked, []);
});

test("a transient initial read failure permits importing in the same page", async t => {
  const f = fixture(t);
  f.failNextRead();
  const initial = await f.host.initSkins();
  assert.deepEqual(initial.skins, []);
  const recovered = await f.host.importSkin(file("Recovered"));
  assert.deepEqual([...f.records.keys()], [recovered.id]);
  assert.equal(f.preferences.skinId, recovered.id);
  assert.equal(f.visible, recovered.url);
  assert.equal(initial.skins, (await f.host.initSkins()).skins, "initial catalog references stay live after recovery");
  assert.deepEqual(initial.skins, [recovered]);
  assert.deepEqual(f.storageOperations, ["getAll", "getAll", "put"]);
});

test("retry recovers existing archives before re-import rollback without rewriting or deleting them", async t => {
  const f = fixture(t), archive = file("Saved");
  const saved = await f.host.importSkin(archive);
  const record = structuredClone(f.records.get(saved.id));
  const reloaded = f.createHost();
  f.failNextRead();
  const initial = await reloaded.initSkins();
  const beforeStorage = f.storageOperations.length;
  const beforeURLs = f.blobs.size;
  const beforeChanges = f.changes.length;
  const error = f.failNextSave();
  await assert.rejects(reloaded.importSkin(archive), value => value === error);
  const recovered = (await reloaded.initSkins()).skins[0];
  assert.equal(initial.skins[0], recovered);
  assert.equal(recovered.id, saved.id);
  assert.equal(f.visible, recovered.url);
  assert.equal(f.preferences.skinId, saved.id);
  assert.deepEqual(f.records.get(saved.id), record);
  assert.deepEqual(f.storageOperations.slice(beforeStorage), ["getAll"]);
  assert.equal(f.blobs.size, beforeURLs + 1);
  assert.deepEqual(f.changes.slice(beforeChanges), [[recovered]], "recovered catalog is published to the mounted renderer");
  assert.deepEqual(f.revoked, []);
});

test("concurrent init, import and selection share retry reads and memoize successful catalog URLs", { timeout: 1000 }, async t => {
  const f = fixture(t), archive = file("Saved");
  const saved = await f.host.importSkin(archive);
  const record = structuredClone(f.records.get(saved.id));
  const reloaded = f.createHost();
  f.failNextRead();
  const initial = await reloaded.initSkins();
  const started = deferred(), gate = deferred();
  f.readSteps.push(async () => { started.resolve(); await gate.promise; });
  const beforeStorage = f.storageOperations.length;
  const beforeURLs = f.blobs.size;
  const beforeWrites = f.writes.length;
  const beforeChanges = f.changes.length;
  const first = reloaded.initSkins(), second = reloaded.initSkins();
  assert.equal(first, second, "concurrent callers must share the pending read");
  await started.promise;
  const importing = reloaded.importSkin(archive);
  const selecting = reloaded.selectSkin(saved.id);
  const restoring = reloaded.restoreSavedSkin();
  assert.equal(reloaded.initSkins(), first);
  assert.equal(f.writes.length, beforeWrites, "selection and import wait for a complete catalog");
  assert.deepEqual(f.storageOperations.slice(beforeStorage), ["getAll"]);
  gate.resolve();
  const [result, , imported] = await Promise.all([first, second, importing, selecting, restoring]);
  assert.equal(result.skins, initial.skins);
  assert.equal(result.skins[0], imported);
  assert.equal(f.blobs.size, beforeURLs + 1, "each recovered record gets exactly one blob URL");
  assert.equal(f.visible, imported.url);
  assert.equal(f.preferences.skinId, saved.id);
  assert.deepEqual(f.records.get(saved.id), record);
  assert.deepEqual(f.changes.slice(beforeChanges), [[imported]]);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(reloaded.initSkins(), first, "successful initialization remains memoized");
    assert.equal(await reloaded.initSkins(), result);
  }
  assert.deepEqual(f.storageOperations.slice(beforeStorage), ["getAll"]);
  assert.equal(f.writes.length, beforeWrites + 2, "only explicit import/select save preferences; restoration does not");
});

test("concurrent callers share a failed read and can share a later successful retry", { timeout: 1000 }, async t => {
  const f = fixture(t), started = deferred(), gate = deferred();
  f.failNextRead();
  f.readSteps.push(async () => { started.resolve(); await gate.promise; });
  const first = f.host.initSkins();
  await started.promise;
  const second = f.host.initSkins();
  const selecting = assert.rejects(f.host.selectSkin(null), /Skin storage is unavailable/);
  assert.equal(first, second);
  // Let the queued selection join the same in-flight read before it aborts.
  await Promise.resolve();
  gate.resolve();
  await Promise.all([first, second, selecting]);
  assert.deepEqual(f.storageOperations, ["getAll"]);
  assert.deepEqual(f.writes, []);
  const retry = f.host.initSkins();
  assert.notEqual(retry, first);
  assert.equal(f.host.initSkins(), retry);
  await retry;
  assert.deepEqual(f.storageOperations, ["getAll", "getAll"]);
  assert.deepEqual(f.errors, ["skin_storage_unavailable"]);
});

test("a recovery listener failure cannot invalidate successful storage or duplicate URLs", async t => {
  const f = fixture(t), saved = await f.host.importSkin(file("Saved"));
  const reloaded = f.createHost();
  f.failNextRead();
  await reloaded.initSkins();
  reloaded.onSkinsChanged(() => { throw new Error("renderer listener failed"); });
  const notified = [];
  reloaded.onSkinsChanged(skins => notified.push(skins));
  const beforeStorage = f.storageOperations.length;
  const beforeURLs = f.blobs.size;
  const recovered = await reloaded.initSkins();
  await reloaded.selectSkin(saved.id);
  assert.equal(await reloaded.initSkins(), recovered);
  assert.deepEqual(f.storageOperations.slice(beforeStorage), ["getAll"]);
  assert.equal(f.blobs.size, beforeURLs + 1);
  assert.deepEqual(notified, [recovered.skins]);
  assert.equal(f.visible, recovered.skins[0].url);
  assert.equal(f.preferences.skinId, saved.id);
  assert.deepEqual(f.errors, ["skin_storage_unavailable", "skin_load_failed"]);
});
