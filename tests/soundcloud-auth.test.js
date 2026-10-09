const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createSoundCloudAuth } = require('../apps/desktop/src/main/soundcloud/auth');

const CLIENT = 'test-client';
const CLOCK = 1700000000000;
const response = (access = 'access-new', refresh = 'refresh-new') => ({
  ok: true, json: async () => ({ access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'bearer' }),
});
const saved = (expiresAt = CLOCK + 3600000) => ({
  clientId: CLIENT, accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function memoryStore(value = null) {
  return {
    value, saves: 0, clears: 0,
    async load() { return this.value; },
    async save(next) { this.saves += 1; this.value = next; },
    async clear() { this.clears += 1; this.value = null; },
  };
}
async function redirectUri() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/callback`;
}
async function fixture(t, overrides = {}) {
  const store = overrides.store || memoryStore();
  const opened = deferred();
  const redirect = await redirectUri();
  const auth = createSoundCloudAuth({
    clientId: CLIENT, redirectUri: redirect, store, now: () => CLOCK, timeoutMs: 2000,
    fetch: async () => response(), openExternal: async (url) => opened.resolve(new URL(url)),
    ...overrides,
  });
  t.after(() => auth.dispose());
  return { auth, store, opened, redirect };
}
function callbackUrl(authorize, overrides = {}) {
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'test-code', ...overrides });
  return callback;
}

test('public-client connect uses a loopback callback, state and PKCE without a secret', async (t) => {
  let request;
  const { auth, store, opened } = await fixture(t, { fetch: async (url, options) => {
    request = { url, options }; return response();
  } });
  const connecting = auth.connect();
  assert.strictEqual(auth.connect(), connecting);
  const authorize = await opened.promise;
  assert.equal(authorize.origin + authorize.pathname, 'https://secure.soundcloud.com/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await fetch(callbackUrl(authorize))).status, 200);
  assert.deepEqual(await connecting, { configured: true, connected: true, authMode: 'user' });
  const form = new URLSearchParams(request.options.body);
  assert.equal(request.url, 'https://secure.soundcloud.com/oauth/token');
  assert.equal(request.options.redirect, 'error');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'test-code');
  assert.equal(form.has('client_secret'), false);
  const challenge = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url');
  assert.equal(challenge, authorize.searchParams.get('code_challenge'));
  assert.equal(store.saves, 1);
  assert.equal(await auth.getAccessToken(), 'access-new');
  assert.equal(JSON.stringify(await auth.status()).includes('access'), false);
});

test('callback rejects wrong state, duplicate fields, Unicode state and wrong method without consuming login', async (t) => {
  const { auth, opened } = await fixture(t);
  const connecting = auth.connect();
  const authorize = await opened.promise;
  assert.equal((await fetch(callbackUrl(authorize, { state: 'x'.repeat(43) }))).status, 400);
  assert.equal((await fetch(callbackUrl(authorize, { state: 'é'.repeat(43) }))).status, 400);
  const duplicate = callbackUrl(authorize);
  duplicate.searchParams.append('state', authorize.searchParams.get('state'));
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal((await fetch(callbackUrl(authorize), { method: 'POST' })).status, 405);
  const wrongPath = callbackUrl(authorize); wrongPath.pathname = '/other';
  assert.equal((await fetch(wrongPath)).status, 404);
  assert.equal((await fetch(callbackUrl(authorize))).status, 200);
  assert.equal((await connecting).connected, true);
});

test('missing authentication never opens the browser', async (t) => {
  let opens = 0;
  const { auth } = await fixture(t, { openExternal: () => { opens += 1; } });
  await assert.rejects(auth.getAccessToken(), { code: 'auth_required' });
  assert.equal(opens, 0);
});

test('token request times out during a shared storage read and a later request can use its result', async (t) => {
  const loading = deferred(); const release = deferred();
  const store = memoryStore(saved());
  let reads = 0;
  let requests = 0;
  store.load = async () => { reads++; loading.resolve(); return release.promise; };
  const { auth } = await fixture(t, { store, timeoutMs: 30,
    fetch: async () => { requests++; return response(); },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let outcome = 'pending';
  const first = auth.getAccessToken().then(() => { outcome = 'resolved'; }, (error) => { outcome = error.code; });
  try {
    await loading.promise;
    t.mock.timers.tick(30);
    await new Promise(setImmediate);
    assert.equal(outcome, 'auth_timeout', 'the caller settles before storage returns');
    const retry = auth.getAccessToken();
    await new Promise(setImmediate);
    assert.equal(reads, 1, 'retry shares the pending read after the auth queue is released');
    assert.equal(requests, 0);
    release.resolve(store.value);
    assert.equal(await retry, 'access-old');
    assert.equal(outcome, 'auth_timeout', 'the late read cannot resolve the timed-out caller');
    assert.equal(requests, 0);
    assert.equal(store.saves, 0);
    assert.equal(store.clears, 0);
  } finally { release.resolve(store.value); await first; }
});

test('disconnect cancels a token request before its pending storage read finishes', async (t) => {
  const loading = deferred(); const release = deferred();
  const store = memoryStore(saved());
  store.load = async () => { loading.resolve(); return release.promise; };
  let requests = 0;
  const { auth } = await fixture(t, { store, fetch: async () => { requests++; return response(); } });
  let outcome = 'pending';
  const pending = auth.getAccessToken().then(() => { outcome = 'resolved'; }, (error) => { outcome = error.code; });
  let disconnecting;
  try {
    await loading.promise;
    disconnecting = auth.disconnect();
    await new Promise(setImmediate);
    assert.equal(outcome, 'auth_cancelled', 'the caller does not wait for storage');
    assert.equal(store.clears, 0, 'the clear still waits for the underlying read');
    release.resolve(store.value);
    await disconnecting;
    await new Promise(setImmediate);
    assert.equal(store.value, null);
    assert.equal((await auth.status()).connected, false);
    await assert.rejects(auth.getAccessToken(), { code: 'auth_required' });
    assert.equal(requests, 0, 'late saved credentials do not authenticate or refresh');
  } finally { release.resolve(store.value); await pending; await disconnecting; }
});

test('a storage rejection after the token request timeout is handled and permits a fresh read', async (t) => {
  const loading = deferred(); const release = deferred();
  const store = memoryStore(saved());
  let reads = 0;
  store.load = async () => {
    if (++reads > 1) return store.value;
    loading.resolve();
    await release.promise;
    throw Object.assign(new Error('keychain temporarily unavailable'), { code: 'storage_unavailable' });
  };
  const { auth } = await fixture(t, { store, timeoutMs: 30 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let outcome = 'pending';
  const pending = auth.getAccessToken().then(() => { outcome = 'resolved'; }, (error) => { outcome = error.code; });
  try {
    await loading.promise;
    t.mock.timers.tick(30);
    await new Promise(setImmediate);
    assert.equal(outcome, 'auth_timeout');
    release.resolve();
    // Let the late rejection reach the shared load and storage queues. The
    // test runner also rejects unhandled promises from this abandoned wait.
    await new Promise(setImmediate);
    assert.equal(await auth.getAccessToken(), 'access-old');
    assert.equal(reads, 2);
    assert.equal(outcome, 'auth_timeout');
  } finally { release.resolve(); await pending; }
});

test('concurrent expired-token requests share one refresh and durably rotate credentials', async (t) => {
  const store = memoryStore(saved(CLOCK - 1));
  let requests = 0;
  const { auth } = await fixture(t, { store, fetch: async (url, options) => {
    requests += 1;
    assert.equal(store.value, null, 'old single-use refresh token is removed before transmission');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'refresh-old');
    return response();
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken())), Array(8).fill('access-new'));
  assert.equal(requests, 1);
  assert.equal(store.value.refreshToken, 'refresh-new');
});

test('ambiguous failed refresh is not retried with a consumed single-use token', async (t) => {
  let requests = 0;
  const store = memoryStore(saved(CLOCK - 1));
  const { auth } = await fixture(t, { store, fetch: async () => {
    requests += 1; throw new Error('secret refresh-old');
  } });
  await assert.rejects(auth.getAccessToken(), (error) => error.code === 'auth_failed' && !error.message.includes('refresh-old'));
  await assert.rejects(auth.getAccessToken(), { code: 'auth_required' });
  assert.equal(requests, 1);
  assert.equal(store.value, null);
});

test('disconnect cancels refresh and late network results cannot restore tokens', async (t) => {
  const started = deferred();
  const network = deferred();
  const store = memoryStore(saved(CLOCK - 1));
  const { auth } = await fixture(t, { store, fetch: () => { started.resolve(); return network.promise; } });
  const refreshed = auth.getAccessToken();
  const rejected = assert.rejects(refreshed, { code: 'auth_cancelled' });
  await started.promise;
  await auth.disconnect();
  await rejected;
  network.resolve(response());
  await new Promise(setImmediate);
  assert.equal((await auth.status()).connected, false);
  assert.equal(store.value, null);
});

test('disconnect clears a save already in flight and never restores a late token', async (t) => {
  const saving = deferred();
  const release = deferred();
  const store = memoryStore(saved(CLOCK - 1));
  store.save = async function (value) { saving.resolve(); await release.promise; this.value = value; };
  const { auth } = await fixture(t, { store });
  const refreshed = auth.getAccessToken();
  const rejected = assert.rejects(refreshed, { code: 'auth_cancelled' });
  await saving.promise;
  const disconnecting = auth.disconnect();
  release.resolve();
  await Promise.all([disconnecting, rejected]);
  assert.equal(store.value, null);
  assert.equal((await auth.status()).connected, false);
});

test('timeout during a save removes late credentials before a subsequent launch can load them', async (t) => {
  const saving = deferred(); const release = deferred();
  const store = memoryStore(saved(CLOCK - 1));
  store.save = async function (value) { saving.resolve(); await release.promise; this.value = value; };
  const { auth } = await fixture(t, { store, timeoutMs: 30 });
  const refreshed = auth.getAccessToken();
  const rejected = assert.rejects(refreshed, { code: 'auth_timeout' });
  await saving.promise; await rejected; release.resolve();
  await auth.dispose();
  assert.equal(store.value, null);
});

test('storage failures reject user tokens without publishing a usable session', async (t) => {
  const store = memoryStore(saved(CLOCK - 1));
  store.save = async () => { throw new Error('raw token access-new'); };
  const { auth } = await fixture(t, { store });
  await assert.rejects(auth.getAccessToken(), (error) => {
    assert.equal(error.code, 'storage_error');
    assert.match(error.message, /restart Nostalgify/);
    assert.doesNotMatch(error.message, /Forget/);
    assert.doesNotMatch(error.message, /raw token|access-new|refresh-new/);
    return true;
  });
  assert.equal(store.value, null);
  assert.equal((await auth.status()).connected, false);
});

test('failed credential persistence reports filesystem recovery without echoing store text', async (t) => {
  const store = memoryStore(saved(CLOCK - 1));
  store.save = async () => { throw Object.assign(new Error('raw token access-new'), {
    code: 'storage_error', reason: 'filesystem', operation: 'save',
  }); };
  const { auth } = await fixture(t, { store });
  await assert.rejects(auth.getAccessToken(), (error) => {
    assert.equal(error.code, 'storage_error');
    assert.match(error.message, /could not be saved/);
    assert.match(error.message, /directory permissions and available disk space/);
    assert.doesNotMatch(error.message, /keychain|Forget|raw token|access-new/i);
    return true;
  });
  assert.equal(store.value, null);
});

test('timeout and disconnect close callback listeners', async (t) => {
  const { auth, opened, redirect } = await fixture(t, { timeoutMs: 50 });
  const connecting = auth.connect();
  const rejected = assert.rejects(connecting, { code: 'auth_timeout' });
  await opened.promise;
  await rejected;
  await assert.rejects(fetch(redirect));
  const next = auth.connect();
  const cancelled = assert.rejects(next, { code: 'auth_cancelled' });
  await auth.disconnect();
  await cancelled;
});

test('denied sign-in and browser errors never echo provider or browser secrets', async (t) => {
  const { auth, opened } = await fixture(t);
  const connecting = auth.connect();
  const rejected = assert.rejects(connecting, (error) => error.code === 'auth_denied' && !error.message.includes('provider-secret'));
  const authorize = await opened.promise;
  const url = callbackUrl(authorize);
  url.searchParams.delete('code'); url.searchParams.set('error', 'provider-secret');
  await fetch(url); await rejected;
  const second = await fixture(t, { openExternal: () => { throw new Error('browser-secret'); } });
  await assert.rejects(second.auth.connect(), (error) => error.code === 'auth_browser_failed' && !error.message.includes('browser-secret'));
});

test('tokens saved for another client cannot authenticate this client', async (t) => {
  const { auth } = await fixture(t, { store: memoryStore({ ...saved(), clientId: 'other-client' }) });
  await assert.rejects(auth.getAccessToken(), { code: 'auth_required' });
});

test('application grant uses HTTP Basic only and caches tokens without a browser or keychain', async (t) => {
  let requests = 0;
  let opens = 0;
  const store = memoryStore();
  store.load = async () => { throw Object.assign(new Error('no keychain'), { code: 'storage_unavailable' }); };
  const { auth } = await fixture(t, { clientSecret: 'test-secret', store,
    openExternal: () => { opens += 1; }, fetch: async (url, options) => {
      requests += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${CLIENT}:test-secret`).toString('base64')}`);
      assert.equal(options.body, 'grant_type=client_credentials');
      assert.equal(form.has('client_id'), false);
      assert.equal(form.has('client_secret'), false);
      return response();
    },
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken())), Array(8).fill('access-new'));
  assert.equal(requests, 1); assert.equal(opens, 0); assert.equal(store.saves, 0);
  assert.deepEqual(await auth.status(), { configured: true, connected: true, authMode: 'application' });
});

test('token quotas stop concurrent requests and reconnects until Retry-After expires', async (t) => {
  let clock = CLOCK;
  let requests = 0;
  const { auth } = await fixture(t, { clientSecret: 'test-secret', now: () => clock,
    fetch: async () => ++requests === 1
      ? new Response('sensitive upstream token', { status: 429, headers: { 'retry-after': '3600' } }) : response(),
  });
  const results = await Promise.allSettled([auth.getAccessToken(), auth.getAccessToken(), auth.reconnect()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'rate_limited');
    assert.equal(result.reason.status, 429);
    assert.equal(result.reason.retryAfterMs, 3600000);
    assert.doesNotMatch(result.reason.message, /sensitive|test-secret|credentials/);
  }
  assert.equal(requests, 1);
  await auth.disconnect();
  clock += 3599999;
  await assert.rejects(auth.reconnect(), (error) => error.code === 'rate_limited' && error.retryAfterMs === 1);
  assert.equal(requests, 1, 'forgetting local sign-in cannot bypass a server quota');
  clock += 1;
  assert.equal(await auth.getAccessToken(), 'access-new');
  assert.equal(requests, 2);
});

test('token quotas honor HTTP dates and safely default malformed or absent Retry-After', async (t) => {
  for (const [header, delay] of [
    [new Date(CLOCK + 86400000).toUTCString(), 86400000],
    [undefined, 60000], ['invalid secret header', 60000], ['1e100', 60000],
  ]) {
    let requests = 0;
    const { auth } = await fixture(t, { clientSecret: 'test-secret', fetch: async () => {
      requests++;
      return new Response('upstream secret', { status: 429, headers: header ? { 'retry-after': header } : {} });
    } });
    await assert.rejects(auth.getAccessToken(), (error) => error.code === 'rate_limited' && error.retryAfterMs === delay);
    await assert.rejects(auth.reconnect(), (error) => error.retryAfterMs === delay && !error.message.includes('secret'));
    assert.equal(requests, 1);
  }
});

test('application tokens without a refresh token obtain a new grant on expiry', async (t) => {
  let clock = CLOCK;
  let requests = 0;
  const { auth, store } = await fixture(t, { clientSecret: 'test-secret', now: () => clock,
    fetch: async (url, options) => {
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
      requests += 1;
      return { ok: true, json: async () => ({ access_token: `application-${requests}`, expires_in: 3600 }) };
    },
  });
  assert.equal(await auth.getAccessToken(), 'application-1');
  clock += 3600000;
  assert.equal(await auth.getAccessToken(), 'application-2');
  assert.equal(store.saves, 0);
});

test('application refresh is single-use, memory-only and serialized', async (t) => {
  let clock = CLOCK;
  let requests = 0;
  const { auth, store } = await fixture(t, { clientSecret: 'test-secret', now: () => clock,
    fetch: async (url, options) => {
      requests += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), requests === 1 ? 'client_credentials' : 'refresh_token');
      if (requests === 2) {
        assert.equal(form.get('client_id'), CLIENT);
        assert.equal(form.get('client_secret'), 'test-secret');
        assert.equal(options.headers.Authorization, undefined);
      }
      return response(`application-${requests}`, `refresh-${requests}`);
    },
  });
  await auth.getAccessToken(); clock += 3600000;
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ['application-2', 'application-2']);
  assert.equal(requests, 2); assert.equal(store.saves, 0); assert.equal(store.clears, 0);
});

test('explicit application reconnect replaces a rejected unexpired token with one fresh grant', async (t) => {
  let requests = 0;
  const { auth, store } = await fixture(t, { clientSecret: 'test-secret',
    fetch: async (url, options) => {
      requests += 1;
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
      return response(`application-${requests}`, `refresh-${requests}`);
    },
  });
  assert.equal(await auth.getAccessToken(), 'application-1');
  // API 401 does not change the token's cached expiry; Connect must bypass it.
  const pending = auth.reconnect();
  assert.strictEqual(auth.reconnect(), pending);
  const statuses = await Promise.all(Array.from({ length: 8 }, () => auth.reconnect()));
  await pending;
  assert.equal(requests, 2);
  assert.equal(await auth.getAccessToken(), 'application-2');
  assert.equal(store.saves, 0); assert.equal(store.clears, 0);
  for (const status of statuses) assert.deepEqual(status, { configured: true, connected: true, authMode: 'application' });
});

test('application reconnect preserves encrypted user credentials', async (t) => {
  const stored = saved();
  const store = memoryStore(stored);
  const { auth } = await fixture(t, { store, clientSecret: 'test-secret' });
  assert.equal(await auth.getAccessToken(), 'access-old');
  assert.deepEqual(await auth.reconnect(), { configured: true, connected: true, authMode: 'application' });
  assert.equal(await auth.getAccessToken(), 'access-new');
  assert.deepEqual(store.value, stored);
  assert.equal(store.saves, 0); assert.equal(store.clears, 0);
});

test('disconnect cancels application reconnect and ignores a late grant response', async (t) => {
  const started = deferred(); const network = deferred();
  const { auth } = await fixture(t, { clientSecret: 'test-secret', fetch: () => { started.resolve(); return network.promise; } });
  const pending = auth.reconnect();
  const rejected = assert.rejects(pending, { code: 'auth_cancelled' });
  await started.promise; await auth.disconnect(); await rejected;
  network.resolve(response()); await new Promise(setImmediate);
  assert.equal((await auth.status()).connected, false);
});

test('public-client reconnect uses the browser PKCE flow', async (t) => {
  const { auth, opened } = await fixture(t);
  const pending = auth.reconnect();
  assert.strictEqual(auth.reconnect(), pending);
  const authorize = await opened.promise;
  assert.equal((await fetch(callbackUrl(authorize))).status, 200);
  assert.deepEqual(await pending, { configured: true, connected: true, authMode: 'user' });
});

test('disconnect cancels an in-flight application grant', async (t) => {
  const started = deferred(); const network = deferred();
  const { auth } = await fixture(t, { clientSecret: 'test-secret', fetch: () => { started.resolve(); return network.promise; } });
  const pending = auth.getAccessToken();
  const rejected = assert.rejects(pending, { code: 'auth_cancelled' });
  await started.promise; await auth.disconnect(); await rejected;
  network.resolve(response()); await new Promise(setImmediate);
  assert.equal((await auth.status()).connected, false);
});

test('malformed token responses cannot establish an application session', async (t) => {
  for (const invalid of [
    { access_token: 'token', expires_in: true },
    { access_token: 'token', expires_in: -1 },
    { access_token: 'token\u0000', expires_in: 3600 },
    { access_token: 'token', expires_in: 3600, token_type: 'unsupported' },
  ]) {
    const { auth } = await fixture(t, { clientSecret: 'test-secret', fetch: async () => ({ ok: true, json: async () => invalid }) });
    await assert.rejects(auth.getAccessToken(), { code: 'auth_failed' });
    assert.equal((await auth.status()).connected, false);
  }
});

test('redirect configuration accepts only exact numeric loopback addresses', () => {
  for (const redirect of ['https://example.com/callback', 'http://localhost:47832/callback',
    'http://127.0.0.1/callback', 'http://127.0.0.1:0/callback', 'http://127.0.0.1:47832/callback?extra=1']) {
    assert.throws(() => createSoundCloudAuth({ redirectUri: redirect }), { code: 'auth_configuration' });
  }
});
