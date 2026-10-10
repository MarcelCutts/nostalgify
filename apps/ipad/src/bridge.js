import { normalizeSnapshot, commandCapability, spotifyLinks, LOCAL_URI, SPOTIFY_URI } from "../../../packages/contracts/src/player.js";

const ERROR_MESSAGES = {
  timeout: "The player took too long to respond. Refresh its connection and try again.",
  native_unavailable: "Open the installed iPad app to use Spotify and Files.",
  spotify_configuration: "Add the public client ID from your Spotify developer app in Settings.",
  spotify_redirect: "Register nostalgify://spotify-login-callback exactly in your Spotify app settings.",
  spotify_not_installed: "Install Spotify on this iPad and sign in, then reconnect.",
  spotify_sdk_missing: "This build needs the Spotify iOS SDK. Follow the Xcode setup guide and rebuild.",
  spotify_disconnected: "Spotify disconnected. Tap Connect Spotify before using playback controls.",
  spotify_state_unavailable: "Spotify playback state is unavailable. Reconnect and try again.",
  spotify_pause_unconfirmed: "Reconnect to Spotify so it can pause before switching to Files.",
  spotify_command_timeout: "Spotify did not confirm that action. Check Spotify before trying again.",
  spotify_command_failed: "Spotify could not complete that action. Open Spotify to check playback or reconnect.",
  spotify_restricted: "Spotify does not currently allow that control for this track or account.",
  spotify_uri: "Use a full Spotify track, album, artist, playlist or episode link.",
  spotify_token_storage: "Unlock this iPad and try connecting Spotify again.",
  unsupported: "This control is unavailable for the current source.",
  unsupported_command: "This control is unavailable for the current source.",
  unsupported_audio: "This audio format is not supported. Choose an unprotected audio file.",
  import_failed: "No files could be imported. Download unprotected audio in Files and try again.",
  not_found: "That audio file is no longer in the library. Import it again.",
  library_write_failed: "The library could not be saved. Check available iPad storage.",
  empty_library: "Import audio from Files first.",
  no_track: "Choose an imported audio file first.",
  audio_session_failed: "The audio output is unavailable. Try Play again.",
  queue_boundary: "You have reached the end of this queue.",
  dialog_busy: "Finish the current dialog first.",
  invalid_preferences: "Those settings could not be saved. Please try again.",
  preferences_too_large: "There are too many saved settings. Remove some saved links and try again.",
  invalid_argument: "That control received an invalid value. Please try again.",
  native_error: "The player could not complete that action. Check the connection and try again.",
};

export function createNativeHost(plugin, {
  timeoutMs = 12000,
  // Spotify can reconnect and await multiple bounded native requests for one command.
  commandTimeoutMs = timeoutMs === 12000 ? 45000 : timeoutMs,
  debug = false,
  onError = () => {},
} = {}) {
  let state = normalizeSnapshot({ message: "Connect Spotify or import music from Files" });
  let eventVersion = 0;
  let listener;
  let disposed = false;
  let pendingState;
  let prefs = {};
  let preferencesLoaded = false;
  let prefsQueue = Promise.resolve();
  let commands = Promise.resolve();
  const subscribers = new Set();
  const diagnostics = [];
  const record = (event, details = {}) => {
    diagnostics.push({ time: new Date().toISOString(), event, ...details });
    if (diagnostics.length > 150) diagnostics.shift();
  };
  const requestId = () => crypto.randomUUID();
  function failure(code, message, id) {
    const error = Object.assign(new Error(message), { code, requestId: id });
    record("failure", { code, requestId: id });
    onError(error);
    return error;
  }
  async function invoke(method, options, wait = timeoutMs) {
    const id = options?.requestId || requestId();
    const started = performance.now();
    let timer;
    try {
      if (!plugin || typeof plugin[method] !== "function") throw Object.assign(new Error(), { code: "native_unavailable" });
      const operation = Promise.resolve().then(() => plugin[method](options));
      const result = wait === null ? await operation : await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { code: "timeout" })), wait); }),
      ]);
      // Native operation failures reject. Snapshot.error is playback state and must be displayed.
      record(method, { requestId: id, durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : "native_error";
      throw failure(code, ERROR_MESSAGES[code], id);
    } finally { clearTimeout(timer); }
  }
  function accept(value, fromEvent = false) {
    if (disposed || !value || typeof value !== "object") return state;
    const next = normalizeSnapshot(value.state && typeof value.state === "object" ? value.state : value);
    if (Number.isSafeInteger(state.sequence) && Number.isSafeInteger(next.sequence) && next.sequence < state.sequence) return state;
    if (fromEvent) eventVersion++;
    state = next;
    for (const subscriber of subscribers) subscriber(state);
    return state;
  }
  async function refresh() {
    if (pendingState) return pendingState;
    const started = eventVersion;
    pendingState = invoke("getState").then(value => {
      if (started !== eventVersion && !Number.isSafeInteger(value?.sequence)) return state;
      return accept(value);
    }).finally(() => { pendingState = null; });
    return pendingState;
  }
  async function readPreferences() {
    const result = await invoke("getPreferences");
    prefs = result?.value && typeof result.value === "object" ? result.value : {};
    preferencesLoaded = true;
  }
  const preferencesReady = readPreferences().catch(() => {});
  function savePreferences(update) {
    const save = prefsQueue.catch(() => {}).then(async () => {
      await preferencesReady;
      // A failed initial read must never turn a patch into a destructive replacement.
      if (!preferencesLoaded) await readPreferences();
      const next = { ...prefs, ...(typeof update === "function" ? update(prefs) : update) };
      await invoke("setPreferences", { value: next });
      prefs = next;
      return prefs;
    });
    prefsQueue = save;
    return save;
  }
  async function execute(command, arg) {
    const capability = commandCapability(command);
    if (capability && !state.capabilities[capability]) throw failure("unsupported", "This control is unavailable for the current source.", requestId());
    if (command === "playShelf") {
      const provider = LOCAL_URI.test(String(arg)) ? "local" : SPOTIFY_URI.test(String(arg)) ? "spotify" : null;
      if (!provider) throw failure("invalid_link", "Use a Spotify link or an imported audio file.", requestId());
      if (state.provider !== provider) accept((await invoke("command", { command: "provider", arg: provider, requestId: requestId() }, commandTimeoutMs))?.state);
    }
    const result = await invoke("command", { command, ...(arg === undefined ? {} : { arg }), requestId: requestId() }, commandTimeoutMs);
    if (result?.state) accept(result.state);
    return result;
  }
  const host = {
    platform: "ios", debug, supportsLikedSongs: false, fakeVisualization: false,
    getState: refresh,
    getCachedState: () => state,
    onStateChanged(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    command(command, arg) { const next = commands.catch(() => {}).then(() => execute(command, arg)); commands = next; return next; },
    async getPreferences() { await preferencesReady; await prefsQueue.catch(() => {}); return { ...prefs }; },
    savePreferences,
    async loadShelf() { return (await host.getPreferences()).shelf || []; },
    saveShelf: shelf => savePreferences({ shelf }),
    async loadUiPrefs() { return (await host.getPreferences()).ui || {}; },
    saveUiPrefs: ui => savePreferences(current => ({ ui: { ...current.ui, ...ui } })),
    resolveLinks: async text => spotifyLinks(text),
    async readClipboard() { return navigator.clipboard.readText(); },
    async configureSpotify(value) { await invoke("configureSpotify", value); await savePreferences({ spotify: value }); },
    async connectSpotify() { await invoke("connectSpotify", undefined, 60000); return refresh(); },
    async disconnectSpotify() { await invoke("disconnectSpotify"); return refresh(); },
    async listAudio() { return (await invoke("listAudio"))?.items || []; },
    async importFiles() { return (await invoke("importAudio", undefined, null))?.items || []; },
    async removeAudio(id) { await invoke("removeAudio", { id }); return refresh(); },
    getDiagnostics: async () => ({ version: 1, web: diagnostics.slice(), native: await invoke("getDiagnostics") }),
    exportDiagnostics: () => invoke("exportDiagnostics", { webEvents: diagnostics.slice() }, null),
    recordError: (code, details = {}) => record("web_error", { ...details, code: /^[a-z_]{1,40}$/.test(code) ? code : "unexpected" }),
    close() {}, minimize() {}, layout() {}, resizeStart() {}, resizeEnd() {},
    async dispose() { disposed = true; subscribers.clear(); await listener?.remove?.(); },
  };
  host.ready = (async () => {
    try { listener = await plugin?.addListener?.("stateChanged", value => accept(value, true)); }
    catch { record("listener_unavailable"); }
    await preferencesReady;
    try { await refresh(); } catch { /* UI exposes unavailable native connection. */ }
    return host;
  })();
  return host;
}
