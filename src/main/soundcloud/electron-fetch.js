const { Readable } = require("node:stream");

const BUFFER_BYTES = 64 * 1024;
const networkError = () => new Error("SoundCloud network request failed.");
const abortError = () => new DOMException("SoundCloud network request was aborted.", "AbortError");

function responseHeaders(values) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values || {})) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

// Electron net.fetch rejects manual redirects instead of returning their status
// and Location (electron/electron#43715). Expose just that response and cancel
// the native request: the SoundCloud client/proxy validates every next hop and
// decides whether to attach authorization to a newly created request.
function createElectronSoundCloudFetch(net) {
  return async function soundcloudFetch(url, init = {}) {
    if (init.redirect === "error") return net.fetch(url, { ...init, credentials: "omit" });
    if (init.redirect !== "manual") throw networkError();
    const method = String(init.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) || init.body != null) throw networkError();
    if (init.signal?.aborted) throw abortError();

    return new Promise((resolve, reject) => {
      let request;
      let reader;
      let controller;
      let settled = false;
      let finished = false;
      const cleanup = () => init.signal?.removeEventListener("abort", onAbort);
      const abortRequest = () => { try { request?.abort(); } catch { /* Already closed. */ } };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (settled) controller?.error(error);
        else { settled = true; reject(error); }
        abortRequest();
        void reader?.cancel().catch(() => {});
      };
      const onAbort = () => fail(abortError());
      try {
        request = net.request({
          url: String(url), method,
          headers: Object.fromEntries(new Headers(init.headers)),
          redirect: "manual", credentials: "omit",
          referrerPolicy: init.referrerPolicy || "no-referrer",
          cache: init.cache || "no-store",
        });
        request.on("error", () => fail(networkError()));
        request.on("abort", onAbort);
        request.on("redirect", (status, _method, redirectUrl, values) => {
          if (finished || settled) return;
          try {
            const headers = responseHeaders(values);
            if (!headers.has("location")) headers.set("location", redirectUrl);
            const response = new Response(null, { status, headers });
            settled = finished = true;
            cleanup();
            resolve(response);
            // Never call followRedirect: even an allowed URL needs the caller's
            // fresh host validation and per-host authorization decision.
            abortRequest();
          } catch { fail(networkError()); }
        });
        request.on("response", (incoming) => {
          incoming.on("error", () => {}); // Late native errors must stay handled.
          if (finished || settled) { abortRequest(); return; }
          incoming.once("aborted", onAbort);
          try {
            const options = { status: incoming.statusCode, headers: responseHeaders(incoming.headers) };
            if (method === "HEAD" || [204, 205, 304].includes(options.status)) {
              const response = new Response(null, options);
              settled = finished = true;
              cleanup();
              resolve(response);
              abortRequest();
              return;
            }
            // Bound buffering in bytes, not in chunk count, and retain native
            // backpressure so long media transfers do not accumulate in memory.
            const strategy = { highWaterMark: BUFFER_BYTES, size: (chunk) => chunk.byteLength };
            reader = Readable.toWeb(incoming, { strategy }).getReader();
            const body = new ReadableStream({
              start(value) { controller = value; },
              async pull() {
                try {
                  const { done, value } = await reader.read();
                  if (finished) return;
                  if (done) { finished = true; cleanup(); controller.close(); }
                  else controller.enqueue(value);
                } catch { fail(init.signal?.aborted ? abortError() : networkError()); }
              },
              async cancel() {
                if (finished) return;
                finished = true;
                cleanup();
                abortRequest();
                try { await reader.cancel(); } catch { /* Cancellation is best effort. */ }
              },
            }, strategy);
            const response = new Response(body, options);
            settled = true;
            resolve(response);
          } catch { fail(networkError()); }
        });
        init.signal?.addEventListener("abort", onAbort, { once: true });
        if (init.signal?.aborted) onAbort();
        else request.end();
      } catch { fail(networkError()); }
    });
  };
}

module.exports = { createElectronSoundCloudFetch };
