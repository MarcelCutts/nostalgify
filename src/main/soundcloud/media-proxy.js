const { randomBytes } = require('node:crypto');

const MAX_ENTRIES = 8192;
const MAX_HOPS = 5;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const UNAVAILABLE = 'SoundCloud media is unavailable.';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TYPES = new Set(['hls', 'audio', 'auto', 'binary']);

function mediaUrl(value, base) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\\]/.test(value)) {
    throw new Error(UNAVAILABLE);
  }
  const url = new URL(value, base);
  const allowedHost = url.hostname === 'api.soundcloud.com'
    || url.hostname === 'sndcdn.com'
    || url.hostname.endsWith('.sndcdn.com')
    || url.hostname === 'playback.media-streaming.soundcloud.cloud';
  // Check the original authority as URL normalizes an explicit :443 away.
  const authority = /^(?:https:)?\/\/([^/]+)/i.exec(value)?.[1]?.split(/[?#]/, 1)[0];
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password
    || url.port || (authority && authority.includes(':'))) {
    throw new Error(UNAVAILABLE);
  }
  for (const key of url.searchParams.keys()) {
    if (/^(?:oauth_token|access_token|client_secret|authorization)$/i.test(key)) throw new Error(UNAVAILABLE);
  }
  url.hash = '';
  return url;
}

function rangeHeader(value) {
  if (!value) return null;
  const match = /^bytes=(\d{1,16})?-(\d{1,16})?$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error(UNAVAILABLE);
  const start = match[1] === undefined ? null : BigInt(match[1]);
  const end = match[2] === undefined ? null : BigInt(match[2]);
  if ((start === null && end === 0n) || (start !== null && end !== null && start > end)
    || (start !== null && start > BigInt(Number.MAX_SAFE_INTEGER))
    || (end !== null && end > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error(UNAVAILABLE);
  }
  return value;
}

function responseHeaders() {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
}

function failure(status) {
  const headers = responseHeaders();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(UNAVAILABLE, { status, headers });
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* A failed upstream body is discarded. */ }
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new Error(UNAVAILABLE));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then((result) => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) reject(new Error(UNAVAILABLE));
      else resolve(result);
    }, (error) => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
    if (signal.aborted) aborted();
  });
}

async function readLimited(response, limit, checkActive, signal) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await discard(response);
    throw new Error(UNAVAILABLE);
  }
  if (!response.body) throw new Error(UNAVAILABLE);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      checkActive();
      const { done, value } = await abortable(reader.read(), signal);
      checkActive();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(UNAVAILABLE);
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Keep the original failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** Keeps authenticated media requests and upstream URLs in Electron's main process. */
function createMediaProxy({ fetch: fetchMedia, getAccessToken }) {
  if (typeof fetchMedia !== 'function' || typeof getAccessToken !== 'function') {
    throw new TypeError('SoundCloud media proxy requires fetch and getAccessToken.');
  }
  const entries = new Map();
  const reverse = new Map();
  const pending = new Set();
  let generation = 0;

  function registerForGeneration(value, type, expectedGeneration) {
    if (generation !== expectedGeneration || !TYPES.has(type)) throw new Error(UNAVAILABLE);
    const url = mediaUrl(value).href;
    const key = `${type}:${url}`;
    const existing = reverse.get(key);
    if (existing) {
      const entry = entries.get(existing);
      entries.delete(existing);
      entries.set(existing, entry);
      return `soundcloud-media://local/${existing}`;
    }
    while (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      reverse.delete(entries.get(oldest).key);
      entries.delete(oldest);
    }
    const id = randomBytes(24).toString('hex');
    entries.set(id, { url, type, key });
    reverse.set(key, id);
    return `soundcloud-media://local/${id}`;
  }

  function register(url, type = 'hls') {
    return registerForGeneration(url, type, generation);
  }

  function rewriteManifest(text, base, expectedGeneration) {
    if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) throw new Error(UNAVAILABLE);
    let nextIsPlaylist = false;
    const resources = new Set();
    const resource = (value, type) => {
      const uri = registerForGeneration(mediaUrl(value, base).href, type, expectedGeneration);
      resources.add(uri);
      // Reject an oversized playlist instead of returning already-evicted links.
      if (resources.size > MAX_ENTRIES) throw new Error(UNAVAILABLE);
      return uri;
    };
    return text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) {
        const uri = resource(trimmed, nextIsPlaylist ? 'hls' : 'auto');
        nextIsPlaylist = false;
        return uri;
      }
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) nextIsPlaylist = true;
      // Quoted URI attributes appear on keys, init maps, alternate renditions,
      // iframe playlists and low-latency HLS parts. Never expose their URLs.
      const playlist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(trimmed);
      const binary = /^#EXT-X-(?:KEY|SESSION-KEY|MAP|PART|PRELOAD-HINT):/.test(trimmed);
      return line.replace(/\b((?:[A-Z0-9-]+-)?URI)=("[^"]*"|[^,\s]*)/g, (_match, name, raw) => {
        if (!raw.startsWith('"') || !raw.endsWith('"')) throw new Error(UNAVAILABLE);
        const uri = resource(raw.slice(1, -1), playlist ? 'hls' : binary ? 'binary' : 'auto');
        return `${name}="${uri}"`;
      });
    }).join('\n');
  }

  async function handle(request) {
    let entry;
    let range;
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'soundcloud-media:' || url.hostname !== 'local'
        || url.username || url.password || url.port || url.search || url.hash
        || !/^\/[a-f0-9]{48}$/.test(url.pathname)) return failure(404);
      entry = entries.get(url.pathname.slice(1));
      if (!entry) return failure(404);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders() });
      if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
      range = rangeHeader(request.headers.get('range'));
    } catch { return failure(400); }

    const expectedGeneration = generation;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    let timer;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(cancel, TIMEOUT_MS);
      timer.unref?.();
    };
    // Authentication, redirects and manifests share one bounded deadline.
    resetTimeout();
    pending.add(abort);
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const checkActive = () => {
      if (expectedGeneration !== generation || abort.signal.aborted) throw new Error(UNAVAILABLE);
    };
    const cleanup = () => {
      clearTimeout(timer);
      pending.delete(abort);
      request.signal?.removeEventListener('abort', cancel);
    };
    let streaming = false;
    try {
      let url = mediaUrl(entry.url);
      let upstream;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        checkActive();
        const headers = new Headers();
        if (range) headers.set('Range', range);
        if (url.hostname === 'api.soundcloud.com') {
          const token = await abortable(getAccessToken(), abort.signal);
          checkActive();
          if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error(UNAVAILABLE);
          headers.set('Authorization', `OAuth ${token}`);
        }
        upstream = await abortable(fetchMedia(url.href, {
          method: 'GET', headers, redirect: 'manual', signal: abort.signal,
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        }), abort.signal);
        checkActive();
        if (REDIRECTS.has(upstream.status)) {
          const location = upstream.headers.get('location');
          await discard(upstream);
          if (!location || hop === MAX_HOPS) throw new Error(UNAVAILABLE);
          url = mediaUrl(location, url);
          continue;
        }
        if (!upstream.ok) {
          const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
          await discard(upstream);
          return failure(status);
        }
        const contentType = upstream.headers.get('content-type') || '';
        if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
          if (url.hostname !== 'api.soundcloud.com' || hop === MAX_HOPS) {
            await discard(upstream);
            throw new Error(UNAVAILABLE);
          }
          const json = JSON.parse(await readLimited(upstream, 65536, checkActive, abort.signal));
          if (!json || typeof json.url !== 'string') throw new Error(UNAVAILABLE);
          url = mediaUrl(json.url, url);
          continue;
        }
        break;
      }
      checkActive();
      const contentType = upstream.headers.get('content-type') || '';
      const isManifest = entry.type === 'hls' || /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType)
        || (entry.type === 'auto' && /\.m3u8$/i.test(url.pathname));
      if (isManifest) {
        if (upstream.status !== 200) {
          await discard(upstream);
          throw new Error(UNAVAILABLE);
        }
        const manifest = await readLimited(upstream, MAX_MANIFEST_BYTES, checkActive, abort.signal);
        const rewritten = rewriteManifest(manifest, url, expectedGeneration);
        checkActive();
        const headers = responseHeaders();
        headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : rewritten, { status: 200, headers });
      }
      if (/^(?:text\/html|application\/(?:xhtml\+xml|javascript))\b/i.test(contentType)) {
        await discard(upstream);
        throw new Error(UNAVAILABLE);
      }
      const headers = responseHeaders();
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        // fetch returns decompressed bytes, so compressed Content-Length is stale.
        if (value && !(name === 'content-length' && upstream.headers.has('content-encoding'))) headers.set(name, value);
      }
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      if (request.method === 'HEAD' || !upstream.body) {
        await discard(upstream);
        return new Response(null, { status: upstream.status, headers });
      }
      const reader = upstream.body.getReader();
      // Audio may legitimately take longer to transfer than the setup deadline.
      // Once headers arrive, bound inactivity instead of the total body lifetime.
      resetTimeout();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            checkActive();
            const { done, value } = await abortable(reader.read(), abort.signal);
            checkActive();
            if (done) { cleanup(); controller.close(); }
            else {
              if (value.byteLength) resetTimeout();
              controller.enqueue(value);
            }
          } catch {
            cleanup();
            try { await reader.cancel(); } catch { /* Sanitize upstream errors. */ }
            controller.error(new Error(UNAVAILABLE));
          }
        },
        async cancel() {
          cancel();
          cleanup();
          try { await reader.cancel(); } catch { /* Cancellation is best effort. */ }
        },
      });
      streaming = true;
      return new Response(body, { status: upstream.status, headers });
    } catch { return failure(502); }
    finally { if (!streaming) cleanup(); }
  }

  function clear() {
    generation++;
    entries.clear();
    reverse.clear();
    for (const abort of pending) abort.abort();
    pending.clear();
  }

  return { register, handle, clear };
}

module.exports = { createMediaProxy };
