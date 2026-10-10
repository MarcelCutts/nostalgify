import { Capacitor, registerPlugin } from "@capacitor/core";
import { mountPlayer } from "@nostalgify/player-ui";
import { createNativeHost } from "./bridge.js";
import { attachSkinStore } from "./skins.js";
import { LOCAL_URI } from "../../../packages/contracts/src/player.js";
import { createMockPlugin } from "./mock.js";
import { safeWebError } from "./diagnostics.js";
import { installSkinAccessibility } from "./skin-accessibility.js";

const $ = id => document.getElementById(id);
const native = Capacitor.isNativePlatform();
// A production build always uses the real native plugin. Query parameters cannot enable mocks.
const demo = __IPAD_DEVELOPMENT__ && !native && new URLSearchParams(location.search).get("mock") === "1";
const plugin = demo ? createMockPlugin() : native ? registerPlugin("NostalgifyNative") : null;
$("demo-banner").hidden = !demo;
$("browser-banner").hidden = native || demo;
const host = attachSkinStore(createNativeHost(plugin, { debug: demo, onError: showError }));
window.nostalgify = host;
let mounted;
let library = [];
let savedShelf = [];
let selectedSource = "spotify";
let playerWidth = 275;
let playerHeight = 377;
let lastTrack = null;
let lastGeometry = "";
let settingsOpener;
const pendingActions = new WeakSet();

function showError(error) {
  $("error-message").textContent = error?.message || "The player could not complete that action. Please try again.";
  $("error-message").hidden = false;
}
function clearError() {
  $("error-message").hidden = true;
  for (const id of ["spotify-client-id", "spotify-redirect"]) {
    $(id).removeAttribute("aria-invalid");
    $(id).removeAttribute("aria-errormessage");
  }
}
async function action(callback, button) {
  if (button && pendingActions.has(button)) return;
  if (button) { pendingActions.add(button); button.setAttribute("aria-busy", "true"); }
  clearError();
  try { return await callback(); }
  catch (error) { showError(error); }
  finally {
    if (button) { pendingActions.delete(button); button.removeAttribute("aria-busy"); }
    renderState(host.getCachedState());
  }
}
const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
const setText = (id, value) => {
  const element = $(id);
  // Polling unchanged state must not replace the text nodes VoiceOver is reading.
  if (element.textContent !== value) element.textContent = value;
};
const spokenTime = seconds => {
  const value = Math.floor(Math.max(0, Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return [minutes && `${minutes} ${minutes === 1 ? "minute" : "minutes"}`, `${value % 60} ${value % 60 === 1 ? "second" : "seconds"}`].filter(Boolean).join(" ");
};
function updateSliderDescriptions() {
  $("seek").setAttribute("aria-valuetext", `${spokenTime($("seek").value)} of ${spokenTime($("seek").max)}`);
  $("native-volume").setAttribute("aria-valuetext", `${Math.round(Number($("native-volume").value))} percent`);
}
function renderState(state) {
  const caps = state.capabilities;
  setText("source-label", state.provider === "local" ? "LOCAL FILES" : "SPOTIFY");
  $("source-label").setAttribute("aria-label", `Playback source: ${state.provider === "local" ? "Local files" : "Spotify"}`);
  const title = state.track?.name || "Ready when you are.";
  const artist = state.track?.artist || (state.provider === "local" ? "Your imported music, on this iPad." : "Connect Spotify or bring your own music.");
  setText("track-title", title);
  const titleLabel = state.track ? `Now playing: ${title}` : `${title} No track selected`;
  if ($("track-title").getAttribute("aria-label") !== titleLabel) $("track-title").setAttribute("aria-label", titleLabel);
  setText("track-artist", artist);
  setText("elapsed", clock(state.position));
  setText("duration", clock(state.track?.duration || 0));
  $("seek").max = String(state.track?.duration || 0);
  if (document.activeElement !== $("seek")) $("seek").value = String(state.position);
  $("seek").disabled = !caps.canSeek || !state.track;
  $("native-volume").disabled = !caps.canSetVolume;
  if (document.activeElement !== $("native-volume")) $("native-volume").value = String(state.volume);
  updateSliderDescriptions();
  setText("volume-note", caps.canSetVolume ? "Volume applies to imported audio." : "Use the iPad volume buttons for Spotify.");
  $("previous-button").disabled = !caps.canSkipPrevious;
  $("next-button").disabled = !caps.canSkipNext;
  $("play-button").disabled = !state.running || (!state.track && state.provider === "local");
  const playing = ["playing", "buffering"].includes(state.state);
  setText("play-button", playing ? "Ⅱ" : "▶︎");
  $("play-button").setAttribute("aria-label", playing ? "Pause" : "Play");
  for (const key of ["shuffle", "repeat"]) {
    $(`${key}-button`).disabled = !caps[key === "shuffle" ? "canShuffle" : "canRepeat"];
    $(`${key}-button`).setAttribute("aria-pressed", String(state[key]));
  }
  setText("connect-button", state.provider === "spotify" && state.running ? "Reconnect Spotify" : "Connect Spotify");
  const playbackStatus = ({ playing: "Playing", buffering: "Buffering", paused: "Paused" })[state.state] || (state.running ? "Ready to play" : "Connect Spotify or import music from Files");
  const status = demo ? `Development demo · ${playbackStatus.toLowerCase()}; no audio plays.` : state.message || playbackStatus;
  // Native progress events arrive frequently; unchanged live-region writes can interrupt VoiceOver.
  setText("player-status", status);
  // The authentic controls use the same capability gates as the accessible controls.
  for (const [selector, enabled] of [["#volume", caps.canSetVolume], ["#position", caps.canSeek], ["#next", caps.canSkipNext], ["#previous", caps.canSkipPrevious], ["#shuffle", caps.canShuffle], ["#repeat", caps.canRepeat]]) {
    const element = document.querySelector(`#webamp ${selector}`);
    if (element) { element.style.pointerEvents = enabled ? "" : "none"; element.style.opacity = enabled ? "" : ".45"; element.setAttribute("aria-disabled", String(!enabled)); }
  }
  if (state.track?.id !== lastTrack) { lastTrack = state.track?.id; renderLists(); }
}
function resizePlayer() {
  const available = Math.max(240, $("player-viewport").clientWidth - 38);
  const scale = Math.min(1.7, available / playerWidth);
  const geometry = `${playerWidth}:${playerHeight}:${scale}`;
  if (geometry === lastGeometry) return;
  lastGeometry = geometry;
  $("app").style.transform = `scale(${scale})`;
  $("player-size").style.width = `${Math.ceil(playerWidth * scale)}px`;
  $("player-size").style.height = `${Math.ceil(playerHeight * scale)}px`;
  $("app").style.width = `${playerWidth}px`;
}
host.layout = (width, height) => {
  if (width > 0 && height > 0) { playerWidth = width; playerHeight = height; resizePlayer(); }
};
let resizePending = false;
new ResizeObserver(() => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => { resizePending = false; resizePlayer(); });
}).observe($("player-viewport"));
window.addEventListener("resize", resizePlayer);

const nativeImport = host.importFiles;
host.importFiles = async () => {
  const imported = await nativeImport();
  await refreshLibrary();
  if (imported.length) await mounted?.shelf.addItems?.(imported.map(localShelfItem));
  return imported;
};
const nativeSaveShelf = host.saveShelf;
host.saveShelf = async items => {
  // The native library owns local files. Preferences hold Spotify shortcuts only.
  savedShelf = items.filter(item => item.provider !== "local" && !item.uri?.startsWith("local:"));
  await nativeSaveShelf(savedShelf);
  renderLists();
};
host.loadShelf = async () => [...savedShelf, ...library.map(localShelfItem)];
const parseLinks = host.resolveLinks;
host.resolveLinks = async text => {
  if (LOCAL_URI.test(text)) return library.filter(item => item.uri === text).map(localShelfItem);
  return parseLinks(text);
};
const localShelfItem = item => ({ provider: "local", kind: "track", uri: item.uri || `local:${item.id}`, title: item.name, artist: item.artist || "" });
async function refreshLibrary() {
  const previous = library;
  library = await host.listAudio();
  if (mounted) {
    const retained = new Set(library.map(item => item.uri || `local:${item.id}`));
    for (const item of previous) {
      const uri = item.uri || `local:${item.id}`;
      if (!retained.has(uri)) await mounted.shelf.removeUri(uri);
    }
    await mounted.shelf.addItems(library.map(localShelfItem));
  }
  renderLists();
}
function renderLists() {
  renderList($("spotify-shelf"), savedShelf, "Save a Spotify link to start your collection.");
  renderList($("local-library"), library.map(localShelfItem), "Your imported audio will appear here.");
  const count = selectedSource === "local" ? library.length : savedShelf.length;
  $("collection-count").textContent = `${count} ${count === 1 ? "item" : "items"}`;
}
function renderList(container, items, emptyText) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const focusIndex = focused ? [...container.children].indexOf(focused.closest(".music-row")) : -1;
  const focusURI = focused?.dataset.uri;
  const focusAction = focused?.className;
  let nextFocus;
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p"); empty.className = "empty-library"; empty.textContent = emptyText; container.append(empty);
    if (focused) $(container.id === "local-library" ? "import-button" : "spotify-link").focus({ preventScroll: true });
    return;
  }
  for (const item of items) {
    const row = document.createElement("div"); row.className = "music-row";
    const play = document.createElement("button"); play.className = "music-play";
    const icon = document.createElement("span"); icon.className = "music-icon"; icon.textContent = "♪";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.className = "music-text";
    const title = document.createElement("span"); title.className = "music-title"; title.textContent = item.title;
    const subtitle = document.createElement("span"); subtitle.className = "music-subtitle"; subtitle.textContent = item.artist || (item.provider === "local" ? "Imported audio" : `Spotify ${item.kind}`);
    subtitle.id = `${container.id}-subtitle-${encodeURIComponent(item.uri)}`;
    text.append(title, subtitle); play.append(icon, text);
    play.setAttribute("aria-label", `Play ${item.title}`);
    play.setAttribute("aria-describedby", subtitle.id);
    play.addEventListener("click", () => action(() => host.command("playShelf", item.uri), play));
    const remove = document.createElement("button"); remove.className = "remove-item"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${item.title}`);
    play.dataset.uri = remove.dataset.uri = item.uri;
    if (item.uri === focusURI) nextFocus = focusAction === "remove-item" ? remove : play;
    remove.addEventListener("click", () => action(async () => {
      if (item.provider === "local") { await host.removeAudio(item.uri.slice(6)); await refreshLibrary(); }
      await mounted?.shelf.removeUri?.(item.uri);
      if (item.provider !== "local" && !mounted?.shelf.removeUri) await host.saveShelf(savedShelf.filter(saved => saved.uri !== item.uri));
    }, remove));
    row.append(play, remove); container.append(row);
  }
  if (focused) (nextFocus || container.children[Math.min(focusIndex, items.length - 1)]?.querySelector("button"))?.focus({ preventScroll: true });
}
function showSettings(open) {
  if (open && $("settings-panel").hidden) settingsOpener = document.activeElement;
  $("settings-panel").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    $("settings-panel").scrollIntoView({ behavior, block: "start" });
    $("spotify-client-id").focus({ preventScroll: true });
  } else (settingsOpener?.isConnected ? settingsOpener : $("settings-toggle")).focus();
}
$("settings-toggle").addEventListener("click", () => showSettings($("settings-panel").hidden));
$("settings-close").addEventListener("click", () => showSettings(false));
$("settings-panel").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); showSettings(false); }
});
$("spotify-settings").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => {
    const clientId = $("spotify-client-id").value.trim();
    const redirectURI = $("spotify-redirect").value.trim();
    const invalid = !/^[a-f0-9]{32}$/i.test(clientId) ? ["spotify-client-id", "Enter the 32-character client ID from your Spotify developer app."]
      : redirectURI !== "nostalgify://spotify-login-callback" ? ["spotify-redirect", "Register and use nostalgify://spotify-login-callback for this build."] : null;
    if (invalid) {
      $(invalid[0]).setAttribute("aria-invalid", "true");
      $(invalid[0]).setAttribute("aria-errormessage", "error-message");
      $(invalid[0]).focus();
      throw new Error(invalid[1]);
    }
    await host.configureSpotify({ clientId, redirectURI });
    $("diagnostics-status").textContent = "Connection settings saved. You can now connect Spotify.";
  }, event.submitter);
});
$("connect-button").addEventListener("click", () => action(async () => {
  const prefs = await host.getPreferences();
  if (!prefs.spotify?.clientId) { showSettings(true); throw new Error("Add your Spotify client ID in connection settings, then connect."); }
  await host.connectSpotify();
}, $("connect-button")));
$("reconnect-button").addEventListener("click", () => action(async () => { await host.getState(); $("diagnostics-status").textContent = "Player connection refreshed."; }, $("reconnect-button")));
$("logout-button").addEventListener("click", () => action(async () => { await host.command("logout"); await host.getState(); }, $("logout-button")));
$("disconnect-button").addEventListener("click", () => action(() => host.disconnectSpotify(), $("disconnect-button")));
for (const source of ["spotify", "local"]) {
  $(`${source}-source`).addEventListener("click", () => {
    selectedSource = source;
    for (const value of ["spotify", "local"]) {
      $(`${value}-source`).classList.toggle("active", value === source);
      $(`${value}-source`).setAttribute("aria-pressed", String(value === source));
      $(`${value}-panel`).hidden = value !== source;
    }
    renderLists();
    // Browsing the collection does not interrupt currently playing music.
  });
}
$("import-button").addEventListener("click", () => action(() => host.importFiles(), $("import-button")));
$("link-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => {
    const text = $("spotify-link").value.trim();
    const links = await host.resolveLinks(text);
    if (!links.length) throw new Error("Paste a link from open.spotify.com for a track, album, artist, playlist or episode.");
    if (mounted?.shelf.addItems) await mounted.shelf.addItems(links);
    else await mounted?.shelf.addFromText(text);
    $("spotify-link").value = "";
  }, event.submitter);
});
for (const [id, command] of [["play-button", "playpause"], ["previous-button", "previous"], ["next-button", "next"]]) $(id).addEventListener("click", () => action(() => host.command(command), $(id)));
for (const key of ["shuffle", "repeat"]) $(`${key}-button`).addEventListener("click", () => action(() => host.command(key, !host.getCachedState()[key]), $(`${key}-button`)));
$("seek").addEventListener("change", () => action(() => host.command("seek", Number($("seek").value))));
$("native-volume").addEventListener("change", () => action(() => host.command("volume", Number($("native-volume").value))));
for (const id of ["seek", "native-volume"]) $(id).addEventListener("input", updateSliderDescriptions);
$("skin-file").addEventListener("change", () => action(async () => {
  const file = $("skin-file").files?.[0]; if (!file) return;
  const skin = await host.importSkin(file); await renderSkins(); $("skin-select").value = skin.id; $("skin-file").value = "";
}));
$("skin-select").addEventListener("change", () => action(() => host.selectSkin($("skin-select").value)));
async function renderSkins() {
  const { skins } = await host.initSkins();
  const selected = (await host.getPreferences()).skinId || "";
  $("skin-select").replaceChildren(new Option("Classic Winamp", ""), ...skins.map(skin => new Option(skin.name, skin.id)));
  $("skin-select").value = selected;
}

$("diagnostics-button").addEventListener("click", () => action(async () => {
  const result = await host.exportDiagnostics();
  $("diagnostics-status").textContent = result?.shared ? "Diagnostics exported." : "Export closed.";
}, $("diagnostics-button")));
$("web-diagnostics-button").addEventListener("click", () => action(async () => {
  const report = await host.getDiagnostics();
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "nostalgify-diagnostics.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}, $("web-diagnostics-button")));
window.addEventListener("error", event => { const details = safeWebError(event); host.recordError(details.code, details); showError(new Error("The interface encountered an error. Refresh the connection or export diagnostics.")); });
window.addEventListener("unhandledrejection", event => { host.recordError("unhandled_promise", safeWebError({ error: event.reason })); showError(new Error("An action could not finish. Try again or export diagnostics.")); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void action(async () => { await host.getState(); if (native || demo) await refreshLibrary(); }); });
window.addEventListener("online", () => { void action(() => host.getState()); });
host.onStateChanged(renderState);

async function start() {
  await host.ready;
  const preferences = await host.getPreferences();
  savedShelf = Array.isArray(preferences.shelf) ? preferences.shelf : [];
  if (preferences.spotify) { $("spotify-client-id").value = preferences.spotify.clientId || ""; $("spotify-redirect").value = preferences.spotify.redirectURI || "nostalgify://spotify-login-callback"; }
  if (native || demo) await refreshLibrary();
  mounted = await mountPlayer(host);
  installSkinAccessibility($("app"));
  mounted.webamp.onWillClose(cancel => cancel());
  host.restoreDefaultSkin = () => mounted.webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" });
  host.confirmSkinLoad = () => new Promise((resolve, reject) => {
    const store = mounted.webamp.store;
    const before = store.getState().display.skinImages;
    const timer = setTimeout(() => finish(false), 12000);
    const unsubscribe = store.subscribe(() => {
      if (!store.getState().display.loading) finish(store.getState().display.skinImages !== before);
    });
    function finish(success) {
      clearTimeout(timer); unsubscribe();
      if (success) resolve();
      else reject(new Error("That skin could not be read. Your previous skin is still selected."));
    }
  });
  try { await host.restoreSavedSkin(); } catch (error) { showError(error); }
  await renderSkins();
  renderLists(); renderState(host.getCachedState()); resizePlayer();
  document.documentElement.dataset.playerReady = "true";
  // Initial library rows are rebuilt after the player and saved skin load.
  // Let users browse only once those controls have their final initial identity.
  $("spotify-source").disabled = false;
  $("local-source").disabled = false;
  if (demo) window.__ipad = { host, mounted, plugin };
}
void start().catch(error => { host.recordError("startup_failed"); showError(error); $("player-status").textContent = "The player could not start. Export diagnostics from Settings."; });
