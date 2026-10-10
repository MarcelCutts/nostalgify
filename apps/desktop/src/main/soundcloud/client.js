const API_ORIGIN = "https://api.soundcloud.com";
const PUBLIC_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com"]);
const SHORT_HOSTS = new Set(["on.soundcloud.com", "snd.sc"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TRACKS = 1000;
const MAX_REQUESTS = 1100;
const MAX_REDIRECTS = 5;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const CREDENTIAL_QUERY = /^(?:oauth_token|access_token|client_secret|authorization)$/i;
const URN = /^soundcloud:(tracks|playlists):\d+$/;

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Keep errors and upstream bodies private. */ }
}

function httpsURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch {
    throw failure("invalid_url", "This SoundCloud link is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw failure("unsafe_url", "SoundCloud links must use HTTPS without credentials or a custom port.");
  }
  return url;
}

function publicURL(value) {
  const url = httpsURL(value);
  if (!PUBLIC_HOSTS.has(url.hostname)) {
    throw failure("unsupported_url", "Use a public SoundCloud track or playlist link.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const reserved = new Set(["you", "discover", "search", "charts", "stations", "stream", "upload", "settings", "messages", "pages"]);
  const section = new Set(["likes", "sets", "tracks", "reposts", "albums", "popular-tracks"]);
  if (reserved.has(parts[0]) || !((parts.length === 2 && !section.has(parts[1])) ||
      (parts.length === 3 && parts[1] === "sets"))) {
    throw failure("unsupported_resource", "Only public SoundCloud tracks and playlists are supported; profile pages and private links are not.");
  }
  url.hostname = "soundcloud.com";
  url.pathname = `/${parts.join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

function apiURL(value, base = API_ORIGIN) {
  const url = httpsURL(value, base);
  if (url.origin !== API_ORIGIN) {
    throw failure("unsafe_redirect", "SoundCloud returned an unsupported API redirect.");
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    throw failure("unsafe_redirect", "SoundCloud returned an invalid API URL.");
  }
  // Resolve can return a legacy numeric resource URL. Always request its URN form.
  pathname = pathname.replace(/^\/(tracks|playlists)\/(\d+)\/?$/, "/$1/soundcloud:$1:$2");
  if (pathname !== "/resolve" &&
      !/^\/tracks\/soundcloud:tracks:\d+(?:\/streams)?$/.test(pathname) &&
      !/^\/playlists\/soundcloud:playlists:\d+(?:\/tracks)?$/.test(pathname)) {
    throw failure("unsupported_resource", "SoundCloud returned an unsupported resource; use a public track or playlist.");
  }
  url.pathname = pathname;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_QUERY.test(key)) url.searchParams.delete(key);
  }
  return url;
}

function streamURL(value) {
  const url = httpsURL(value);
  const host = url.hostname;
  // The AAC CDN is documented in soundcloud/api issue #441.
  if (host !== "api.soundcloud.com" && host !== "sndcdn.com" && !host.endsWith(".sndcdn.com") &&
      host !== "playback.media-streaming.soundcloud.cloud") {
    throw failure("unsafe_stream", "SoundCloud returned an unsupported audio host.");
  }
  if ([...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY.test(key))) {
    throw failure("unsafe_stream", "SoundCloud returned an unsafe audio URL.");
  }
  return url.href;
}

function identifier(resource, expected) {
  const supplied = resource?.urn || resource?.id;
  const urn = typeof supplied === "number" && Number.isSafeInteger(supplied) ? `soundcloud:${expected}:${supplied}` :
    typeof supplied === "string" && /^\d+$/.test(supplied) ? `soundcloud:${expected}:${supplied}` : supplied;
  if (typeof urn !== "string" || !URN.test(urn) || !urn.startsWith(`soundcloud:${expected}:`)) {
    throw failure("invalid_response", "SoundCloud returned a resource without a valid identifier.");
  }
  return urn;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, 2000) : fallback;
}

function sourceURL(value) {
  try { return publicURL(value).href; } catch { return ""; }
}

function artworkURL(value) {
  try {
    const url = httpsURL(value);
    return url.hostname.endsWith(".sndcdn.com") || url.hostname === "sndcdn.com" ? url.href : "";
  } catch { return ""; }
}

function normalizeTrack(track) {
  const uploader = text(track.user?.username).trim() || "Unknown artist";
  return {
    id: identifier(track, "tracks"),
    name: text(track.title, "Untitled track"),
    artist: text(track.metadata_artist).trim() || uploader,
    uploader,
    album: text(track.publisher_metadata?.album_title),
    duration: Number.isFinite(track.duration) && track.duration >= 0 ? track.duration / 1000 : 0,
    artworkUrl: artworkURL(track.artwork_url || track.user?.avatar_url),
    sourceUrl: sourceURL(track.permalink_url),
    access: ["playable", "preview", "blocked"].includes(track.access) ? track.access : "blocked",
  };
}

function createSoundCloudClient({ fetch: fetchImpl = globalThis.fetch, auth, now = Date.now } = {}) {
  if (typeof fetchImpl !== "function" || typeof auth?.getAccessToken !== "function") {
    throw new TypeError("SoundCloud requires a fetch implementation and authentication provider.");
  }
  let cooldownUntil = 0;

  async function rateLimitReset(response) {
    const currentTime = now();
    let latestReset = 0;
    const future = (value) => {
      // Dates outside JavaScript's representable range are malformed, not a
      // reason to shorten a legitimate server-directed cooldown.
      if (Number.isFinite(value) && value > currentTime && value <= 8640000000000000) latestReset = Math.max(latestReset, value);
    };
    const retryAfter = response.headers.get("retry-after")?.trim();
    if (retryAfter) {
      future(/^\d+(?:\.\d+)?$/.test(retryAfter)
        ? currentTime + Number(retryAfter) * 1000 : Date.parse(retryAfter));
    }
    try {
      const body = await response.json();
      for (const error of Array.isArray(body?.errors) ? body.errors : []) {
        const reset = error?.meta?.reset_time;
        if (typeof reset !== "string") continue;
        // SoundCloud documents yyyy/MM/dd HH:mm:ss Z. Normalize explicitly so
        // parsing does not depend on the host's local timezone or date parser.
        const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(reset);
        if (match) future(Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}${match[5]}:${match[6]}`));
        else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(reset)) future(Date.parse(reset));
      }
    } catch { /* Retry-After remains usable when the error body is not JSON. */ }
    await discard(response);
    return latestReset || currentTime + DEFAULT_COOLDOWN_MS;
  }

  async function request(url, operation, authorized) {
    const remaining = cooldownUntil - now();
    if (remaining > 0) {
      throw failure("rate_limited", "SoundCloud is temporarily rate limited. Please try again later.", { status: 429, retryAfterMs: remaining });
    }
    if (++operation.requests > MAX_REQUESTS) {
      throw failure("request_limit", "This SoundCloud playlist requires too many requests to load.");
    }
    const headers = { Accept: authorized ? "application/json" : "text/html" };
    if (authorized) {
      // Validate again immediately before attaching authentication.
      url = apiURL(url);
      let token;
      try { token = await auth.getAccessToken(); } catch (error) {
        if (error?.code === "rate_limited" && error.status === 429 &&
            Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
          throw failure("rate_limited", "SoundCloud is temporarily rate limited. Please try again later.",
            { status: 429, retryAfterMs: error.retryAfterMs });
        }
        throw failure("unauthorized", "Connect or reconnect SoundCloud before loading music.", { status: 401 });
      }
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
        throw failure("unauthorized", "Connect or reconnect SoundCloud before loading music.", { status: 401 });
      }
      headers.Authorization = `OAuth ${token}`;
    }
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET", headers, redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw failure("network_error", "Could not reach SoundCloud. Check your connection and try again.");
    }
    if (response.status === 401) {
      await discard(response);
      throw failure("unauthorized", "Your SoundCloud connection has expired. Reconnect SoundCloud and try again.", { status: 401 });
    }
    if (response.status === 429) {
      const resetTime = await rateLimitReset(response);
      cooldownUntil = Math.max(cooldownUntil, resetTime);
      const retryAfterMs = Math.max(0, cooldownUntil - now());
      throw failure("rate_limited", "SoundCloud is temporarily rate limited. Please try again later.", { status: 429, retryAfterMs });
    }
    if (!response.ok && !REDIRECT_STATUSES.has(response.status)) {
      await discard(response);
      const messages = {
        403: "SoundCloud does not allow access to this content. Check your application access or open it in SoundCloud.",
        404: "This SoundCloud track or playlist is unavailable or has been removed.",
      };
      throw failure("api_error", messages[response.status] || "SoundCloud could not complete the request. Please try again later.", { status: response.status });
    }
    return response;
  }

  async function json(initial, operation) {
    let url = apiURL(initial);
    const seen = new Set();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (seen.has(url.href)) throw failure("redirect_loop", "SoundCloud returned a repeated redirect.");
      seen.add(url.href);
      const response = await request(url, operation, true);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await discard(response);
        if (!location) throw failure("invalid_response", "SoundCloud returned an incomplete redirect.");
        url = apiURL(location, url);
        continue;
      }
      try { return await response.json(); } catch {
        throw failure("invalid_response", "SoundCloud returned an unreadable response. Please try again.");
      }
    }
    throw failure("redirect_limit", "This SoundCloud link redirects too many times.");
  }

  async function expandLink(value, operation) {
    let url = httpsURL(value);
    const seen = new Set();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (PUBLIC_HOSTS.has(url.hostname)) return publicURL(url.href);
      if (!SHORT_HOSTS.has(url.hostname)) throw failure("unsupported_url", "Use a public SoundCloud track or playlist link.");
      if (seen.has(url.href)) throw failure("redirect_loop", "This SoundCloud share link contains a redirect loop.");
      seen.add(url.href);
      const response = await request(url, operation, false);
      if (!REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        throw failure("unsupported_url", "This SoundCloud share link could not be resolved. Paste the full track or playlist URL.");
      }
      const location = response.headers.get("location");
      await discard(response);
      if (!location) throw failure("invalid_response", "This SoundCloud share link has no destination.");
      url = httpsURL(location, url);
    }
    throw failure("redirect_limit", "This SoundCloud share link redirects too many times.");
  }

  async function resolveLinks(input) {
    if (typeof input !== "string" || input.length > 65536) throw failure("invalid_input", "Paste a SoundCloud track or playlist link.");
    const candidates = input.match(/https?:\/\/[^\s<>"']+/gi) || [];
    const links = [];
    for (const candidate of candidates) {
      const value = candidate.replace(/[.,;!?)\]]+$/, "");
      let url;
      try { url = new URL(value); } catch { continue; }
      if (PUBLIC_HOSTS.has(url.hostname) || SHORT_HOSTS.has(url.hostname)) links.push(value);
    }
    if (links.length > 50) throw failure("too_many_links", "Add at most 50 SoundCloud links at a time.");
    const operation = { requests: 0 };
    const entries = new Map();
    for (const value of new Set(links)) {
      const url = await expandLink(value, operation);
      const resource = await json(`${API_ORIGIN}/resolve?url=${encodeURIComponent(url.href)}`, operation);
      if (!resource || !["track", "playlist"].includes(resource.kind) || resource.sharing === "private") {
        throw failure("unsupported_resource", "Only public SoundCloud tracks and playlists are supported.");
      }
      const uri = identifier(resource, resource.kind === "track" ? "tracks" : "playlists");
      entries.set(uri, {
        provider: "soundcloud", kind: resource.kind, uri,
        title: text(resource.title, resource.kind === "track" ? "Untitled track" : "Untitled playlist"),
        artist: text(resource.user?.username, "Unknown artist"),
        url: sourceURL(resource.permalink_url) || url.href,
      });
    }
    return [...entries.values()];
  }

  async function loadContext(uri) {
    if (typeof uri !== "string" || !URN.test(uri)) throw failure("invalid_resource", "Choose a saved SoundCloud track or playlist.");
    const operation = { requests: 0 };
    if (uri.startsWith("soundcloud:tracks:")) {
      return [normalizeTrack(await json(`${API_ORIGIN}/tracks/${uri}`, operation))];
    }
    let next = `${API_ORIGIN}/playlists/${uri}/tracks?linked_partitioning=true&limit=200&access=playable,preview,blocked`;
    const seen = new Set();
    const rawTracks = [];
    while (next) {
      const pageURL = apiURL(next).href;
      if (seen.has(pageURL)) throw failure("pagination_loop", "SoundCloud returned a repeated playlist page.");
      seen.add(pageURL);
      const page = await json(pageURL, operation);
      const tracks = Array.isArray(page) ? page : page?.collection;
      if (!Array.isArray(tracks)) throw failure("invalid_response", "SoundCloud returned an unreadable playlist.");
      if (tracks.length > MAX_TRACKS - rawTracks.length) throw failure("playlist_too_large", "SoundCloud playlists are limited to 1,000 tracks in Nostalgify.");
      rawTracks.push(...tracks);
      next = !Array.isArray(page) && page.next_href ? apiURL(page.next_href).href : null;
    }
    const hydrated = new Map();
    const tracks = [];
    for (const track of rawTracks) {
      const id = identifier(track, "tracks");
      let detail = track;
      if (typeof track.title !== "string" || !Number.isFinite(track.duration) || !track.access) {
        if (!hydrated.has(id)) hydrated.set(id, await json(`${API_ORIGIN}/tracks/${id}`, operation));
        detail = hydrated.get(id);
      }
      tracks.push(normalizeTrack(detail));
    }
    return tracks;
  }

  async function getStream(track) {
    const id = identifier(track, "tracks");
    if (track.access !== "playable" && track.access !== "preview") {
      throw failure("track_blocked", "This track cannot play through SoundCloud's API. Open it in SoundCloud instead.");
    }
    const streams = await json(`${API_ORIGIN}/tracks/${id}/streams`, { requests: 0 });
    if (track.access === "preview") {
      if (!streams?.preview_mp3_128_url) throw failure("stream_unavailable", "No preview is available for this SoundCloud track.");
      return { url: streamURL(streams.preview_mp3_128_url), type: "audio", preview: true };
    }
    // MP3 HLS remains documented in the current OpenAPI schema; progressive MP3 does not.
    const url = streams?.hls_aac_160_url || streams?.hls_aac_96_url || streams?.hls_mp3_128_url;
    if (!url) throw failure("stream_unavailable", "Full playback is unavailable for this track. Open it in SoundCloud instead.");
    return { url: streamURL(url), type: "hls", preview: false };
  }

  return { resolveLinks, loadContext, getStream };
}

module.exports = { createSoundCloudClient };
