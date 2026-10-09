import Hls, { FetchLoader } from "hls.js";

const REPORT_INTERVAL = 250;
const playbackError = "SoundCloud audio could not play. Try again or open the track in SoundCloud.";
const finite = (value, fallback = 0) => Math.max(0, Number.isFinite(value) ? value : fallback);

function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "soundcloud-media:" || url.hostname !== "local" || url.username || url.password) {
    throw new Error("SoundCloud returned an invalid media source. Try loading the track again.");
  }
  return url.href;
}

// The main process owns authentication and stream URLs. The renderer sees only
// short-lived local media handles, never an access token or a signed CDN URL.
export function createSoundCloudAudio({
  api = window.nostalgify,
  createAudio = () => new Audio(),
  HlsClass = Hls,
  now = () => performance.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let active = null;
  let disposed = false;
  let reportTimer = null;
  let lastReport = -Infinity;

  function report(instance) {
    if (disposed || instance !== active) return;
    if (reportTimer != null) return;
    const delay = Math.max(0, REPORT_INTERVAL - (now() - lastReport));
    if (delay > 0) {
      reportTimer = schedule(() => {
        reportTimer = null;
        report(instance);
      }, delay);
      return;
    }
    lastReport = now();
    const { audio, session, state, error } = instance;
    api.reportAudioState({
      session,
      state,
      position: finite(audio.currentTime),
      duration: finite(audio.duration),
      volume: Math.min(100, finite(audio.volume, 1) * 100),
      ...(error ? { error } : {}),
    });
  }

  function state(instance, next, error) {
    if (instance !== active || disposed) return;
    instance.state = next;
    instance.error = error;
    report(instance);
  }

  function release() {
    if (reportTimer != null) cancel(reportTimer);
    reportTimer = null;
    const old = active;
    active = null; // native events and pending play promises become stale first
    if (!old) return;
    for (const [event, handler] of old.listeners) old.audio.removeEventListener(event, handler);
    old.hls?.destroy();
    old.audio.pause();
    old.audio.removeAttribute("src");
    old.audio.load();
  }

  function listen(instance, event, handler) {
    const guarded = () => {
      if (active === instance && !disposed) handler();
    };
    instance.listeners.push([event, guarded]);
    instance.audio.addEventListener(event, guarded);
  }

  async function play(instance) {
    try {
      await instance.audio.play();
    } catch (error) {
      if (instance !== active || disposed) return;
      // Pausing/loading another source intentionally cancels pending play().
      if (error?.name === "AbortError") return;
      const message = error?.name === "NotAllowedError"
        ? "Press Play to allow SoundCloud audio."
        : playbackError;
      state(instance, "error", message);
      throw new Error(message);
    }
  }

  function load(command) {
    const url = mediaUrl(command.url);
    release();
    const audio = createAudio();
    const instance = { session: command.session, audio, listeners: [], hls: null, state: "loading" };
    active = instance;
    audio.preload = "auto";
    audio.volume = Math.min(100, finite(command.volume, 100)) / 100;
    listen(instance, "playing", () => state(instance, "playing"));
    listen(instance, "pause", () => {
      if (!audio.ended && instance.state !== "error") state(instance, "paused");
    });
    for (const event of ["waiting", "stalled", "seeking"]) {
      listen(instance, event, () => {
        if (!audio.paused && instance.state !== "error") state(instance, "buffering");
      });
    }
    listen(instance, "ended", () => state(instance, "ended"));
    listen(instance, "error", () => state(instance, "error", playbackError));
    for (const event of ["timeupdate", "durationchange", "volumechange", "seeked"]) {
      listen(instance, event, () => report(instance));
    }
    if (Number.isFinite(command.position) && command.position > 0) {
      listen(instance, "loadedmetadata", () => {
        audio.currentTime = Math.min(command.position, finite(audio.duration, command.position));
      });
    }
    report(instance);
    if (command.streamType === "hls" && HlsClass.isSupported()) {
      const hls = new HlsClass({
        enableWorker: false,
        loader: FetchLoader,
        fetchSetup: (context, init) => new Request(mediaUrl(context.url), init),
      });
      instance.hls = hls;
      hls.on(HlsClass.Events.ERROR, (_event, data) => {
        if (instance !== active || !data.fatal) return;
        // HLS errors can contain signed URLs; expose only our fixed message.
        state(instance, "error", playbackError);
        hls.stopLoad();
        audio.pause();
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else if (command.streamType !== "hls" || audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = url;
      audio.load();
    } else {
      state(instance, "error", "This device cannot play SoundCloud HLS audio. Open the track in SoundCloud.");
      return;
    }
    if (command.autoPlay !== false) void play(instance).catch(() => {});
    else state(instance, "paused");
  }

  async function execute(command) {
    let error;
    try {
      if (disposed || !command || typeof command.session !== "string") return;
      if (command.type === "load") load(command);
      else {
        const instance = active;
        if (!instance && ["pause", "stop"].includes(command.type)) return;
        if (!instance || command.session !== instance.session) throw new Error("The SoundCloud track changed. Try again.");
        // Acknowledge acceptance without waiting for network buffering. Native
        // playback events and play() failures report the outcome asynchronously.
        if (command.type === "play") void play(instance).catch(() => {});
        else if (command.type === "pause") {
          instance.audio.pause();
          if (instance.state !== "error") state(instance, "paused");
        } else if (command.type === "stop") release();
        else if (command.type === "seek") {
          if (!Number.isFinite(command.position)) throw new Error("Choose a valid playback position.");
          instance.audio.currentTime = Math.min(finite(command.position), finite(instance.audio.duration, command.position));
          report(instance);
        } else if (command.type === "volume") {
          if (!Number.isFinite(command.volume)) throw new Error("Choose a valid volume.");
          instance.audio.volume = Math.min(100, finite(command.volume)) / 100;
          report(instance);
        }
      }
    } catch {
      error = playbackError;
      if (command?.type === "load" && active?.session === command.session) {
        state(active, "error", error);
        active.audio.pause();
      }
    } finally {
      if (command?.requestId) api.audioCommandDone?.({ requestId: command.requestId, session: command.session, ...(error ? { error } : {}) });
    }
  }

  const unsubscribe = api.onAudioCommand((command) => { void execute(command); });
  function dispose() {
    disposed = true;
    unsubscribe?.();
    release();
  }
  return { dispose };
}
