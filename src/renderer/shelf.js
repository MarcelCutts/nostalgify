// Saved Spotify and SoundCloud links in Winamp's playlist window. Links come
// from drag and drop, paste, or ADD > URL, which reads the clipboard.
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
  const provider = item.provider === "soundcloud" ? "SoundCloud, " : "";
  return `${name} (${provider}${KIND_LABEL[item.kind] || item.kind})`;
}

export function createShelf(webamp, { quietly, flash, onPlay }) {
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
    void window.nostalgify.saveShelf(items()).catch(() => flash("Your shelf could not be saved. Try again."));
  }

  async function load() {
    let saved = [];
    try {
      saved = (await window.nostalgify.loadShelf()) || [];
    } catch {}
    // Liked Songs is always first.
    const rest = saved.filter((i) => i && i.kind !== "liked" && i.uri);
    [LIKED, ...rest].forEach(addItem);
  }

  // The main process resolves supported links and supplies safe metadata.
  async function addFromText(text) {
    try {
      const found = await window.nostalgify.resolveLinks(String(text || ""));
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
      save();
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

  // The playlist's ADD > URL button reads a link from the clipboard.
  async function handleAddUrl() {
    try {
      await addFromText(await window.nostalgify.readClipboard());
    } catch {
      flash("Could not read the clipboard. Paste a Spotify or SoundCloud link.");
    }
    return [];
  }

  // Called by the Redux middleware for every action.
  function onAction(action, quiet) {
    if (quiet) return;
    if (CHANGES.has(action.type)) {
      save();
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

  // Cmd+V anywhere in the window adds a supported link from the clipboard.
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      addFromText(text);
    }
  });

  return { load, onAction, handleAddUrl, addFromText, isShelfTrack: (id) => byId.has(id) };
}
