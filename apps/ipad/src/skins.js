const DATABASE = "nostalgify-ipad-skins";
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("skins", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Skin storage is unavailable."));
  });
}
async function transaction(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("skins", mode);
      const request = operation(tx.objectStore("skins"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error("The skin could not be saved."));
    });
  } finally { db.close(); }
}

export function attachSkinStore(host) {
  let skins = [];
  const setListeners = new Set();
  const changeListeners = new Set();
  const byURL = new Map();
  let operations = Promise.resolve();
  let storageLoaded = false;
  let loading;
  let visibleId = null;
  let choice = 0;
  const enqueue = operation => {
    const pending = operations.then(operation);
    // One failed operation must not poison later imports or selections.
    operations = pending.catch(() => {});
    return pending;
  };
  const createSkin = record => {
    const skin = { id: record.id, name: record.name, url: URL.createObjectURL(new Blob([record.bytes], { type: "application/zip" })), hasEq: true };
    byURL.set(skin.url, skin.id);
    return skin;
  };
  let initialization;
  host.initSkins = () => initialization ||= (async () => {
    try {
      skins = (await transaction("readonly", store => store.getAll())).map(createSkin);
      storageLoaded = true;
    }
    catch { host.recordError("skin_storage_unavailable"); }
    // Start with the embedded skin, then restore through the same validated selection path.
    return { skins, initial: null };
  })();
  host.isSkinUrl = url => byURL.has(url);
  host.skinChosen = url => {
    const id = byURL.get(url);
    if (!id || !host.confirmSkinLoad) return;
    const confirmed = host.confirmSkinLoad();
    void confirmed.catch(() => {});
    // Webamp calls this synchronously from fetch during onSetSkin. The owning
    // operation handles persistence and rollback after this load completes.
    if (loading?.url === url) { loading.confirmed = confirmed; return; }
    const current = ++choice;
    const pending = enqueue(async () => {
      if (current !== choice) return;
      await selectSkin(id, confirmed, current);
    });
    void pending.catch(() => host.recordError("skin_load_failed"));
  };
  host.onSetSkin = callback => { setListeners.add(callback); return () => setListeners.delete(callback); };
  host.onSkinsChanged = callback => { changeListeners.add(callback); return () => changeListeners.delete(callback); };
  async function applySkin(id) {
    choice++;
    if (!id) { host.restoreDefaultSkin?.(); visibleId = null; return; }
    const skin = skins.find(item => item.id === id);
    if (!skin) throw new Error("Choose a saved skin.");
    const load = { url: skin.url };
    loading = load;
    try {
      for (const callback of setListeners) callback(skin.url);
    } finally { loading = null; }
    if (!load.confirmed) throw new Error("The skin player is unavailable.");
    await load.confirmed;
    visibleId = id;
  }
  async function selectSkin(id, confirmed, current) {
    await host.initSkins();
    if (id && !storageLoaded) throw new Error("Skin storage is unavailable.");
    const previous = (await host.getPreferences()).skinId || null;
    let applied = false;
    try {
      if (confirmed) {
        await confirmed;
        if (current !== choice) return;
        visibleId = id;
      } else await applySkin(id);
      applied = true;
      await host.savePreferences({ skinId: id || null });
    } catch (error) {
      // A rejected load leaves Webamp's previous artwork intact. A rejected
      // preference write happens after application, so restore the saved skin
      // without attempting another preference write.
      if (applied && (current === undefined || current === choice)) {
        try { await applySkin(previous); }
        catch { host.recordError("skin_load_failed"); }
      }
      throw error;
    }
  }
  host.selectSkin = id => enqueue(() => selectSkin(id));
  host.restoreSavedSkin = () => enqueue(async () => {
    await host.initSkins();
    const id = (await host.getPreferences()).skinId;
    if (!id) return;
    // An unreadable store is not evidence that a saved selection is missing.
    if (!storageLoaded) throw new Error("Skin storage is unavailable.");
    // Restoring an already saved selection must not depend on another write.
    try { await applySkin(id); }
    catch (error) {
      await applySkin(null);
      await host.savePreferences({ skinId: null });
      throw error;
    }
  });
  host.importSkin = file => enqueue(async () => {
    if (!/\.(wsz|zip)$/i.test(file.name) || file.size > 15 * 1024 * 1024) throw new Error("Choose a .wsz or .zip skin smaller than 15 MB.");
    const bytes = await file.arrayBuffer();
    const header = new Uint8Array(bytes);
    if (header[0] !== 80 || header[1] !== 75) throw new Error("That file is not a ZIP skin archive.");
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    await host.initSkins();
    if (!storageLoaded) throw new Error("Skin storage is unavailable.");
    const created = !skins.some(skin => skin.id === id);
    if (created) {
      const record = { id, name: file.name.replace(/\.(wsz|zip)$/i, ""), bytes };
      await transaction("readwrite", store => store.put(record));
      skins.push(createSkin(record));
      for (const callback of changeListeners) callback(skins.slice());
    }
    try { await selectSkin(id); }
    catch (error) {
      // Never remove a re-imported record. If visual recovery also failed,
      // retain the new record and URL while Webamp may still be using them.
      if (created && visibleId !== id) {
        try {
          await transaction("readwrite", store => store.delete(id));
          const index = skins.findIndex(skin => skin.id === id);
          if (index >= 0) {
            const [removed] = skins.splice(index, 1);
            byURL.delete(removed.url); URL.revokeObjectURL(removed.url);
            for (const callback of changeListeners) callback(skins.slice());
          }
        } catch { host.recordError("skin_storage_unavailable"); }
      }
      throw error;
    }
    return skins.find(skin => skin.id === id);
  });
  return host;
}
