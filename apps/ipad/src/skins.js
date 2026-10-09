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
  const createSkin = record => {
    const skin = { id: record.id, name: record.name, url: URL.createObjectURL(new Blob([record.bytes], { type: "application/zip" })), hasEq: true };
    byURL.set(skin.url, skin.id);
    return skin;
  };
  let initialization;
  host.initSkins = () => initialization ||= (async () => {
    try { skins = (await transaction("readonly", store => store.getAll())).map(createSkin); }
    catch { host.recordError("skin_storage_unavailable"); }
    const prefs = await host.getPreferences();
    return { skins, initial: skins.find(skin => skin.id === prefs.skinId)?.url || null };
  })();
  host.isSkinUrl = url => byURL.has(url);
  host.skinChosen = url => {
    const id = byURL.get(url);
    if (id) void host.savePreferences({ skinId: id }).catch(() => host.recordError("skin_preference_failed"));
  };
  host.onSetSkin = callback => { setListeners.add(callback); return () => setListeners.delete(callback); };
  host.onSkinsChanged = callback => { changeListeners.add(callback); return () => changeListeners.delete(callback); };
  host.selectSkin = async id => {
    if (!id) { await host.savePreferences({ skinId: null }); location.reload(); return; }
    const skin = skins.find(item => item.id === id);
    if (!skin) throw new Error("Choose a saved skin.");
    await host.savePreferences({ skinId: id });
    for (const callback of setListeners) callback(skin.url);
  };
  host.importSkin = async file => {
    if (!/\.(wsz|zip)$/i.test(file.name) || file.size > 15 * 1024 * 1024) throw new Error("Choose a .wsz or .zip skin smaller than 15 MB.");
    const bytes = await file.arrayBuffer();
    const header = new Uint8Array(bytes);
    if (header[0] !== 80 || header[1] !== 75) throw new Error("That file is not a ZIP skin archive.");
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    await host.initSkins();
    if (!skins.some(skin => skin.id === id)) {
      const record = { id, name: file.name.replace(/\.(wsz|zip)$/i, ""), bytes };
      await transaction("readwrite", store => store.put(record));
      skins.push(createSkin(record));
      for (const callback of changeListeners) callback(skins.slice());
    }
    await host.selectSkin(id);
    return skins.find(skin => skin.id === id);
  };
  return host;
}
