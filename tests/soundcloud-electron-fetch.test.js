const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Readable } = require("node:stream");
const { createElectronSoundCloudFetch } = require("../apps/desktop/src/main/soundcloud/electron-fetch");
const { createSoundCloudClient } = require("../apps/desktop/src/main/soundcloud/client");

function harness(onEnd = () => {}) {
  const requests = [];
  const fetches = [];
  const net = {
    async fetch(url, init) { fetches.push({ url, init }); return new Response("native fetch"); },
    request(options) {
      const request = new EventEmitter();
      Object.assign(request, {
        options, aborted: false, follows: 0,
        end() { onEnd(request); },
        followRedirect() { request.follows++; },
        abort() {
          if (request.aborted) return;
          request.aborted = true;
          request.emit("abort");
          request.incoming?.destroy();
        },
        respond(status = 200, headers = {}, incoming = new PassThrough()) {
          Object.assign(incoming, { statusCode: status, headers });
          request.incoming = incoming;
          request.emit("response", incoming);
          return incoming;
        },
      });
      requests.push(request);
      return request;
    },
  };
  return { fetch: createElectronSoundCloudFetch(net), requests, fetches };
}

test("Electron manual redirects expose status and Location, abort, and never follow with authorization", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const h = harness((request) => {
      request.emit("redirect", status, "GET", "https://untrusted.example/target", {
        location: ["https://untrusted.example/target"], "retry-after": ["20"],
      });
      // Electron can emit an error after cancelling its redirect. It must not
      // replace the already-returned redirect or become an unhandled error.
      request.emit("error", new Error("Redirect was cancelled: private-detail"));
    });
    const response = await h.fetch("https://api.soundcloud.com/resolve", {
      redirect: "manual", headers: { Authorization: "OAuth test-only-token" },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), "https://untrusted.example/target");
    assert.equal(response.headers.get("retry-after"), "20");
    assert.equal(response.body, null);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.redirect, "manual");
    assert.equal(h.requests[0].options.credentials, "omit");
    assert.equal(h.requests[0].options.headers.authorization, "OAuth test-only-token");
    assert.equal(h.requests[0].aborted, true);
    assert.equal(h.requests[0].follows, 0);
  }
});

test("SoundCloud host validation rejects a redirect exposed by the Electron adapter before another request", async () => {
  const h = harness((request) => request.emit("redirect", 302, "GET", "https://untrusted.example/track", {
    location: ["https://untrusted.example/track"],
  }));
  const client = createSoundCloudClient({ fetch: h.fetch, auth: { getAccessToken: async () => "test-only-token" } });
  await assert.rejects(client.resolveLinks("https://soundcloud.com/artist/track"));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].aborted, true);
  assert.equal(h.requests[0].follows, 0);
});

test("response headers, status and body chunks stream before the native request ends", async () => {
  const h = harness((request) => request.respond(206, {
    "content-type": "audio/mpeg", "content-range": "bytes 0-5/6", "x-test": ["one", "two"],
  }));
  const response = await h.fetch("https://media.sndcdn.com/audio", {
    redirect: "manual", headers: new Headers({ Range: "bytes=0-5" }), cache: "no-store", referrerPolicy: "no-referrer",
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-5/6");
  assert.equal(response.headers.get("x-test"), "one, two");
  assert.equal(h.requests[0].options.headers.range, "bytes=0-5");
  assert.equal(h.requests[0].options.referrerPolicy, "no-referrer");
  assert.equal(h.requests[0].options.cache, "no-store");
  const reader = response.body.getReader();
  h.requests[0].incoming.write(Buffer.from("abc"));
  assert.equal(Buffer.from((await reader.read()).value).toString(), "abc");
  h.requests[0].incoming.end(Buffer.from("def"));
  assert.equal(Buffer.from((await reader.read()).value).toString(), "def");
  assert.equal((await reader.read()).done, true);
  assert.equal(h.requests[0].aborted, false);
});

test("stream buffering stays bounded and cancelling the body aborts the native request", async () => {
  let produced = 0;
  const h = harness((request) => request.respond(200, {}, new Readable({
    read() { produced += 32768; this.push(Buffer.alloc(32768)); },
  })));
  const response = await h.fetch("https://media.sndcdn.com/audio", { redirect: "manual" });
  await new Promise(setImmediate);
  assert.ok(produced > 0 && produced <= 8 * 32768, "native and web queues must bound buffered bytes");
  await response.body.cancel();
  const stoppedAt = produced;
  await new Promise(setImmediate);
  assert.equal(produced, stoppedAt);
  assert.equal(h.requests[0].aborted, true);
  assert.equal(h.requests[0].incoming.destroyed, true);
});

test("abort before request creation or before response headers fails without leaking reasons", async () => {
  const h = harness();
  const before = new AbortController();
  before.abort(new Error("private-abort-reason"));
  await assert.rejects(h.fetch("https://api.soundcloud.com/resolve", { redirect: "manual", signal: before.signal }), { name: "AbortError" });
  assert.equal(h.requests.length, 0);
  const during = new AbortController();
  const pending = h.fetch("https://api.soundcloud.com/resolve", { redirect: "manual", signal: during.signal });
  during.abort(new Error("private-abort-reason"));
  await assert.rejects(pending, (error) => error.name === "AbortError" && !error.message.includes("private-abort-reason"));
  assert.equal(h.requests[0].aborted, true);
});

test("abort after headers rejects a pending body read and stops upstream transfer", async () => {
  const h = harness((request) => request.respond());
  const abort = new AbortController();
  const response = await h.fetch("https://media.sndcdn.com/audio", { redirect: "manual", signal: abort.signal });
  const reader = response.body.getReader();
  const pending = reader.read();
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.requests[0].aborted, true);
});

test("native request and body errors reject with fixed safe messages", async () => {
  const early = harness((request) => request.emit("error", new Error("private-signed-url")));
  await assert.rejects(early.fetch("https://api.soundcloud.com/resolve", { redirect: "manual" }), { message: "SoundCloud network request failed." });
  const h = harness((request) => request.respond());
  const response = await h.fetch("https://media.sndcdn.com/audio", { redirect: "manual" });
  const pending = response.text();
  h.requests[0].incoming.destroy(new Error("private-signed-url"));
  await assert.rejects(pending, { message: "SoundCloud network request failed." });
  assert.equal(h.requests[0].aborted, true);
});

test("completed bodies detach abort listeners and native aborts reject pending requests", async () => {
  const h = harness((request) => request.respond().end("complete"));
  const abort = new AbortController();
  const response = await h.fetch("https://media.sndcdn.com/audio", { redirect: "manual", signal: abort.signal });
  assert.equal(await response.text(), "complete");
  abort.abort();
  assert.equal(h.requests[0].aborted, false, "a completed request must detach the signal");
  const pendingHarness = harness();
  const pending = pendingHarness.fetch("https://media.sndcdn.com/audio", { redirect: "manual" });
  pendingHarness.requests[0].abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("unsupported automatic redirect modes and manual request bodies fail closed before networking", async () => {
  const h = harness();
  for (const init of [{}, { redirect: "follow" }, { redirect: "manual", method: "POST", body: "private-body" }]) {
    await assert.rejects(h.fetch("https://api.soundcloud.com/resolve", init), { message: "SoundCloud network request failed." });
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.fetches.length, 0);
});

test("bodyless responses and HEAD do not leave upstream requests open", async () => {
  for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 205], ["GET", 304]]) {
    const h = harness((request) => request.respond(status));
    const response = await h.fetch("https://media.sndcdn.com/audio", { method, redirect: "manual" });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(h.requests[0].aborted, true);
  }
});

test("token requests retain net.fetch with redirect rejection and no session credentials", async () => {
  const h = harness();
  const init = { method: "POST", redirect: "error", credentials: "include", body: "test-only-body", headers: { Authorization: "Basic test-only-token" } };
  const response = await h.fetch("https://secure.soundcloud.com/oauth/token", init);
  assert.equal(await response.text(), "native fetch");
  assert.equal(h.requests.length, 0);
  assert.equal(h.fetches[0].init.redirect, "error");
  assert.equal(h.fetches[0].init.credentials, "omit");
  assert.equal(h.fetches[0].init.body, init.body);
  assert.equal(h.fetches[0].init.headers, init.headers);
});
