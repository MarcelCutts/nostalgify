// Native and web player values use seconds and a 0–100 volume scale.
export const CAPABILITIES = ["canSeek", "canSetVolume", "canSkipNext", "canSkipPrevious", "canShuffle", "canRepeat"];
export const LOCAL_URI = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SPOTIFY_URI = /^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/;
const finite = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, value) : fallback;
const text = (value) => typeof value === "string" ? value : "";

export function normalizeSnapshot(value = {}) {
  const track = value.track && typeof value.track.id === "string" ? {
    id: value.track.id, name: text(value.track.name), artist: text(value.track.artist),
    album: text(value.track.album), duration: finite(value.track.duration), artworkUrl: text(value.track.artworkUrl),
  } : null;
  return {
    provider: value.provider === "local" ? "local" : "spotify",
    running: value.running === true,
    state: ["playing", "paused", "stopped", "loading", "buffering"].includes(value.state) ? value.state : "stopped",
    position: finite(value.position), volume: Math.min(100, finite(value.volume, 100)),
    shuffle: value.shuffle === true, repeat: value.repeat === true, track,
    error: typeof value.error === "string" ? value.error : null, message: text(value.message),
    ...(Number.isSafeInteger(value.sequence) ? { sequence: value.sequence } : {}),
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, value.capabilities?.[key] === true])),
  };
}

export function spotifyLinks(input) {
  const found = [];
  const seen = new Set();
  for (const token of String(input).trim().split(/\s+/)) {
    let uri = token;
    if (!SPOTIFY_URI.test(uri)) {
      try {
        const url = new URL(token);
        if (url.protocol !== "https:" || url.hostname !== "open.spotify.com" || url.username || url.password || url.port) continue;
        const match = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)\/?$/);
        if (!match) continue;
        uri = `spotify:${match[1]}:${match[2]}`;
      } catch { continue; }
    }
    if (seen.has(uri)) continue;
    seen.add(uri);
    const [, kind, id] = uri.split(":");
    found.push({ provider: "spotify", kind, uri, title: `Spotify ${kind} · ${id.slice(0, 8)}` });
  }
  return found;
}

export function commandCapability(command) {
  return ({ seek: "canSeek", volume: "canSetVolume", next: "canSkipNext", previous: "canSkipPrevious", shuffle: "canShuffle", repeat: "canRepeat" })[command];
}
