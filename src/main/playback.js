// Own the active provider and prevent late network/poll results from switching it.
const SOUNDCLOUD_URI = /^soundcloud:(tracks|playlists):[A-Za-z0-9_-]+$/;

function createPlayback({ spotify, soundcloud, audio, media, openExternal, onProviderChange = () => {}, initialProvider = "spotify" }) {
  let provider = initialProvider === "soundcloud" ? "soundcloud" : "spotify";
  let desired = provider;
  let generation = 0;
  let serial = 0;
  let session = null;
  let hostSession = null;
  let switching = Promise.resolve();
  let spotifyPending = Promise.resolve();
  let wantsPlay = true;
  let loadDispatched = false;
  let pendingPosition = 0;
  let preview = false;
  let visited = new Set();
  let queue = [];
  let index = -1;
  let contextUri = null;
  let contextLoading = false;
  let disposed = false;
  const state = {
    provider: "soundcloud", running: true, state: "stopped", position: 0,
    volume: 60, shuffle: false, repeat: false, track: null, error: null,
    message: "Paste a SoundCloud track or playlist to begin",
  };
  const snapshot = () => ({ ...state, track: state.track && { ...state.track } });
  const current = (g) => !disposed && g === generation && desired === "soundcloud";
  const fail = (error) => {
    state.state = "paused";
    state.error = error?.code || "playback";
    state.message = error?.message || "SoundCloud playback failed. Try another track.";
  };

  function spotifyCommand(cmd, arg, g = generation) {
    const task = spotifyPending.catch(() => {}).then(() => {
      if (!disposed && generation === g && desired === "spotify") return spotify.command(cmd, arg);
    });
    spotifyPending = task;
    return task;
  }

  async function select(next) {
    if (!["spotify", "soundcloud"].includes(next)) throw new Error("Unknown music source");
    const g = ++generation;
    desired = next;
    // Queue just the stop/switch operations, not slow context or stream requests.
    const task = switching.catch(() => {}).then(async () => {
      if (disposed || g !== generation) return;
      if (hostSession) {
        const stopping = hostSession;
        await audio.send({ type: "stop", session: stopping });
        if (disposed || g !== generation) return;
        hostSession = null;
      }
      session = null;
      media.clear();
      if (next === "soundcloud") {
        await spotifyPending.catch(() => {});
        // A reload can release the switch queue while Spotify is still busy.
        // Do not let that obsolete switch pause playback in the new renderer.
        if (disposed || g !== generation) return;
        await spotify.pause();
      }
      if (disposed || g !== generation) return;
      provider = next;
      state.error = null;
      state.state = "stopped";
      state.position = 0;
      state.track = null;
      state.message = "Paste a SoundCloud track or playlist to begin";
      queue = [];
      index = -1;
      contextUri = null;
      contextLoading = false;
      loadDispatched = false;
      wantsPlay = true;
      visited = new Set();
      onProviderChange(provider);
    });
    switching = task;
    await task;
    return g;
  }

  async function loadTrack(nextIndex, g = generation, autoPlay = true, position = 0) {
    if (!current(g) || !queue[nextIndex]) return;
    const nextSession = `${g}:${++serial}`;
    wantsPlay = autoPlay;
    loadDispatched = false;
    pendingPosition = Math.max(0, Number.isFinite(position) ? position : 0);
    preview = false;
    index = nextIndex;
    visited.add(index);
    // Invalidate the previous track before awaiting any network work.
    const oldSession = hostSession;
    session = nextSession;
    if (oldSession) {
      try { await audio.send({ type: "stop", session: oldSession }); }
      catch (error) { if (current(g) && session === nextSession) fail(error); return; }
    }
    if (!current(g) || session !== nextSession) return;
    hostSession = null;
    media.clear();
    const track = queue[index];
    Object.assign(state, { track, position: pendingPosition, state: "loading", error: null, message: "Loading SoundCloud…" });
    try {
      const stream = await soundcloud.getStream(track);
      if (!current(g) || session !== nextSession) return;
      const url = media.register(stream.url, stream.type);
      preview = stream.preview;
      state.message = preview ? "SoundCloud preview" : "";
      loadDispatched = true;
      hostSession = nextSession;
      await audio.send({ type: "load", session: nextSession, url, streamType: stream.type, volume: state.volume, position: pendingPosition, autoPlay: wantsPlay });
      if (current(g) && session === nextSession) {
        if (!wantsPlay) await audio.send({ type: "pause", session: nextSession });
      }
    } catch (error) {
      if (current(g) && session === nextSession) fail(error);
    }
  }

  async function playShelf(uri) {
    const next = SOUNDCLOUD_URI.test(uri) ? "soundcloud" : "spotify";
    if (next === "spotify" && uri !== "liked" && !/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.test(uri)) {
      throw new Error("Unsupported music link");
    }
    const g = await select(next);
    if (g !== generation || disposed) return;
    if (next === "spotify") return spotifyCommand("playShelf", uri, g);
    contextUri = uri;
    await resolveContext(uri, g);
  }

  async function resolveContext(uri, g = generation) {
    contextLoading = true;
    state.state = "loading";
    state.error = null;
    state.message = "Loading SoundCloud…";
    try {
      const tracks = await soundcloud.loadContext(uri);
      if (!current(g)) return;
      if (!Array.isArray(tracks) || !tracks.length) throw new Error("This SoundCloud playlist has no available tracks.");
      queue = tracks;
      await loadTrack(0, g, wantsPlay);
    } catch (error) {
      if (current(g)) fail(error);
    } finally {
      if (current(g)) contextLoading = false;
    }
  }

  async function nextTrack(automatic = false) {
    if (!queue.length) return;
    let next = index + 1;
    if (state.shuffle && queue.length > 1) {
      let remaining = queue.map((_track, i) => i).filter((i) => !visited.has(i));
      if (!remaining.length && state.repeat) {
        visited = new Set([index]);
        remaining = queue.map((_track, i) => i).filter((i) => i !== index);
      }
      if (!remaining.length) {
        if (automatic) state.state = "stopped";
        return;
      }
      next = remaining[Math.floor(Math.random() * remaining.length)];
    } else if (next >= queue.length) {
      if (state.repeat) next = 0;
      else {
        if (automatic) state.state = "stopped";
        return;
      }
    }
    await loadTrack(next);
  }

  async function command(cmd, arg) {
    if (disposed) return { error: "Player has closed" };
    let commandGeneration = generation;
    try {
      if (cmd === "playShelf") {
        if (arg !== "liked" && !SOUNDCLOUD_URI.test(String(arg)) && !/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.test(String(arg))) return { error: "Unsupported music link" };
        commandGeneration++;
        return await playShelf(String(arg));
      }
      if (cmd === "selectProvider") {
        if (!["spotify", "soundcloud"].includes(arg)) return { error: "Unknown music source" };
        commandGeneration++;
        const g = await select(arg);
        if (arg === "spotify" && g === generation) await spotify.start();
        return;
      }
      await switching;
      if (commandGeneration !== generation) return;
      if (provider === "spotify") return await spotifyCommand(cmd, arg);
      if (cmd === "eject" || cmd === "activate") {
        const url = state.track?.sourceUrl || "https://soundcloud.com/";
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !["soundcloud.com", "www.soundcloud.com"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
          throw new Error("Invalid SoundCloud source link");
        }
        return await openExternal(url);
      }
      if (cmd === "shuffle" || cmd === "repeat") {
        state[cmd] = Boolean(arg);
        if (cmd === "shuffle") visited = new Set(index >= 0 ? [index] : []);
        return;
      }
      if (cmd === "volume") {
        if (!Number.isFinite(arg)) throw new Error("Invalid volume");
        state.volume = Math.max(0, Math.min(100, arg));
        if (session && loadDispatched) await audio.send({ type: "volume", session, volume: state.volume });
        return;
      }
      if (cmd === "next") return await nextTrack();
      if (cmd === "previous" && state.position <= 3 && index > 0) return await loadTrack(index - 1);
      if (cmd === "previous") { cmd = "seek"; arg = 0; }
      if (cmd === "playpause") {
        const pending = !loadDispatched && !state.error && (contextLoading || session);
        cmd = state.state === "playing" || state.state === "buffering" || (pending && wantsPlay) ? "pause" : "play";
      }
      if (cmd === "playOrFallback") cmd = "play";
      // Retry only on an explicit Play. A fresh stream may recover an expired
      // URL, but repeated failures must not cause an automatic request loop.
      if (cmd === "play" && state.error && index < 0 && contextUri) {
        wantsPlay = true;
        return await resolveContext(contextUri);
      }
      if (cmd === "play" && (state.error || !session) && index >= 0) {
        return await loadTrack(index, generation, true, state.error ? state.position : 0);
      }
      if (cmd === "play" || cmd === "pause") {
        wantsPlay = cmd === "play";
        if (!loadDispatched) {
          if (cmd === "pause") { state.state = "paused"; state.message = ""; }
          else if (contextLoading || session) { state.state = "loading"; state.message = "Loading SoundCloud…"; }
          return;
        }
      }
      if (!session) {
        state.message = "Paste a SoundCloud track or playlist to begin";
        return;
      }
      if (cmd === "seek") {
        if (!Number.isFinite(arg)) throw new Error("Invalid seek position");
        pendingPosition = Math.max(0, Math.min(state.track?.duration || Infinity, arg));
        if (loadDispatched) await audio.send({ type: "seek", session, position: pendingPosition });
      } else if (cmd === "play" || cmd === "pause") {
        await audio.send({ type: cmd, session });
      }
    } catch (error) {
      if (commandGeneration !== generation) return;
      if (desired === "soundcloud" && ["playShelf", "selectProvider", "play", "playOrFallback", "playpause", "next", "previous"].includes(cmd)) fail(error);
      return { error: error?.message || "Playback command failed" };
    }
  }

  async function getState() {
    if (desired === "soundcloud") return snapshot();
    const g = generation;
    const result = await spotify.getState();
    if (g !== generation || desired !== "spotify") return desired === "soundcloud" ? snapshot() : { provider, running: true, state: "paused" };
    return { ...result, provider: "spotify" };
  }

  function audioState(update) {
    if (disposed || provider !== "soundcloud" || desired !== "soundcloud" || !session || update?.session !== session) return;
    if (!["loading", "buffering", "playing", "paused", "ended", "error"].includes(update.state)) return;
    if (Number.isFinite(update.position)) state.position = Math.max(0, update.position);
    if (Number.isFinite(update.volume)) state.volume = Math.max(0, Math.min(100, update.volume));
    if (state.track && Number.isFinite(update.duration) && update.duration > 0) state.track = { ...state.track, duration: update.duration };
    if (update.state === "error") {
      fail(new Error("SoundCloud audio could not play. Check the connection and try again."));
    } else {
      state.state = update.state;
      state.error = null;
      state.message = update.state === "buffering" ? "Buffering SoundCloud…" : preview ? "SoundCloud preview" : "";
      if (update.state === "ended") {
        // Duplicate ended notifications must not advance the queue twice.
        state.state = "stopped";
        const ended = session;
        session = null;
        void nextTrack(true).catch((error) => { if (session === ended) fail(error); });
      }
    }
  }

  async function dispose() {
    disposed = true;
    generation++;
    await switching.catch(() => {});
    if (hostSession) await audio.send({ type: "stop", session: hostSession }).catch(() => {});
    session = null;
    hostSession = null;
    media.clear();
  }

  function rendererReset() {
    generation++;
    session = null;
    hostSession = null;
    loadDispatched = false;
    queue = [];
    index = -1;
    contextUri = null;
    contextLoading = false;
    media.clear();
    switching = Promise.resolve();
    Object.assign(state, { state: "stopped", position: 0, track: null, error: null, message: "Paste a SoundCloud track or playlist to begin" });
  }

  return { command, getState, audioState, dispose, rendererReset, getProvider: () => desired };
}

module.exports = { createPlayback };
