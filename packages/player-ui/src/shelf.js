// Saved Spotify and SoundCloud links in Winamp's playlist window. Links come
// from drag and drop, paste, or the ADD menu’s clipboard action.
import { sendCommand } from "./playbackMedia.js";

const KIND_LABEL = { album: "album", playlist: "playlist", artist: "artist", track: "track" };
const LIKED = { provider: "spotify", kind: "liked", uri: "liked", title: "Liked Songs" };

// Webamp gives tracks small numeric ids. Ours start far above them.
let nextId = 9_000_000;

// Actions that change the playlist's contents or order.
const CHANGES = new Set([
  "REMOVE_TRACKS",
  "REMOVE_ALL_TRACKS",
  "DRAG_SELECTED",
  "REVERSE_LIST",
  "RANDOMIZE_LIST",
  "SET_TRACK_ORDER",
]);

export function shelfLabel(item) {
  if (item.kind === "liked") return "♥ Liked Songs (Spotify)";
  const name = item.artist ? `${item.artist} - ${item.title}` : item.title;
  if (item.provider === "local" || item.uri?.startsWith("local:")) return name;
  const provider = item.provider === "soundcloud" ? "SoundCloud, " : "";
  return `${name} (${provider}${KIND_LABEL[item.kind] || item.kind})`;
}

export function createShelf(webamp, { host = window.nostalgify, quietly, flash, onPlay }) {
  const store = webamp.store;
  const byId = new Map(); // Webamp track id -> shelf item

  function addItem(item) {
    const id = nextId++;
    byId.set(id, item);
    const name = shelfLabel(item);
    quietly(() => {
      store.dispatch({ type: "ADD_TRACK_FROM_URL", id, url: "shelf:" + item.uri, defaultName: name, duration: null });
      // Marking the tags as known stops Webamp trying to read them from the "file".
      store.dispatch({ type: "SET_MEDIA_TAGS", id, title: name, artist: null, album: null });
    });
  }

  function items() {
    return store
      .getState()
      .playlist.trackOrder.map((id) => byId.get(id))
      .filter(Boolean);
  }

  function save() {
    return host.saveShelf(items());
  }

  // Event handlers cannot return an acknowledgement to a caller. Keep their
  // failures handled; API callers await save() and decide when to report success.
  function saveFromUI() {
    void Promise.resolve().then(save).catch((error) => flash(error?.message || "Your shelf could not be saved. Try again.", 6000));
  }

  async function load() {
    let saved = [];
    try {
      saved = (await host.loadShelf()) || [];
    } catch {}
    // Liked Songs is always first.
    const rest = saved.filter((i) => i && i.kind !== "liked" && i.uri);
    (host.supportsLikedSongs === false ? rest : [LIKED, ...rest]).forEach(addItem);
  }

  // Native file imports already carry normalized shelf metadata. Keep the
  // native library authoritative while avoiding duplicate rows on refresh.
  async function addItems(entries) {
    const have = new Set(items().map((item) => `${item.provider || "spotify"}:${item.uri}`));
    const fresh = entries.filter((item) => {
      if (!item || typeof item.uri !== "string") return false;
      const key = `${item.provider || "spotify"}:${item.uri}`;
      if (have.has(key)) return false;
      have.add(key);
      return true;
    });
    fresh.forEach(addItem);
    // Persist even when every entry is already visible: a previous save may
    // have failed after adding its rows, and a retry still needs an acknowledgement.
    await save();
    return fresh;
  }

  async function removeUri(uri) {
    const ids = [...byId].filter(([, item]) => item.uri === uri).map(([id]) => id);
    if (ids.length) quietly(() => store.dispatch({ type: "REMOVE_TRACKS", ids }));
    for (const id of ids) byId.delete(id);
    await save();
  }

  // The main process resolves supported links and supplies safe metadata.
  async function addFromText(text) {
    try {
      const found = await host.resolveLinks(String(text || ""));
      if (found?.error) {
        flash(found.error, 6000);
        return;
      }
      if (!Array.isArray(found) || !found.length) {
        flash("Copy a Spotify or SoundCloud track or playlist link", 3500);
        return;
      }
      const have = new Set(items().map((i) => `${i.provider || "spotify"}:${i.uri}`));
      const fresh = found.filter((i) => {
        const key = `${i.provider || "spotify"}:${i.uri}`;
        if (have.has(key)) return false;
        have.add(key);
        return true;
      });
      fresh.forEach(addItem);
      await save();
      if (fresh.length === 1) flash("Added " + shelfLabel(fresh[0]));
      else if (fresh.length > 1) flash(`Added ${fresh.length} items`);
      else flash("Already on your shelf");
    } catch {
      flash("Could not add that link. Check your connection and try again.", 6000);
    }
  }

  // We take every drop ourselves, before Webamp sees it. Webamp would otherwise
  // clear the playlist on a drop onto the main window, and try to play dropped
  // files. It also stops the page navigating to a dropped link.
  window.addEventListener("dragover", (e) => e.preventDefault(), true);
  window.addEventListener(
    "drop",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      const text = [dt.getData("text/uri-list"), dt.getData("text/plain")].filter(Boolean).join("\n");
      if (text) addFromText(text);
      else flash("Drag a Spotify or SoundCloud track or playlist link");
    },
    true
  );

  // The shelf's ADD menu reads a link from the clipboard.
  async function handleAddUrl() {
    try {
      await addFromText(await host.readClipboard());
    } catch {
      flash("Could not read the clipboard. Paste a Spotify or SoundCloud link.");
    }
    return [];
  }

  // Called by the Redux middleware for every action.
  function onAction(action, quiet) {
    if (quiet) return;
    if (CHANGES.has(action.type)) {
      saveFromUI();
      return;
    }
    if (action.type === "PLAY_TRACK" && byId.has(action.id)) {
      const item = byId.get(action.id);
      flash("Playing " + shelfLabel(item));
      void sendCommand("playShelf", item.uri).then((result) => {
        if (!result?.error) onPlay();
      });
    }
  }

  // Paste outside editable controls adds a supported link to the shelf. Native
  // shells also contain settings/link inputs, which must keep normal editing.
  document.addEventListener("paste", (e) => {
    const target = e.composedPath?.()[0] || e.target;
    const control = target?.closest?.("input, textarea, select");
    // Webamp ranges can retain focus after dragging; desktop paste remains a
    // shelf action there. Native shell controls keep their usual editing behavior.
    const classicRange = host.platform !== "ios" && control?.type === "range" && control.closest?.("#webamp");
    if (e.defaultPrevented || target?.isContentEditable || (control && !classicRange)) return;
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      addFromText(text);
    }
  });

  return { load, addItems, removeUri, onAction, handleAddUrl, addFromText, isShelfTrack: (id) => byId.has(id) };
}
