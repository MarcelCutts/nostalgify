const crypto = require('node:crypto');
const http = require('node:http');

const AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:47832/callback';

function authError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function validateRedirect(value) {
  let parsed;
  try { parsed = new URL(value); } catch { /* Report only a fixed message. */ }
  if (!parsed || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.port || Number(parsed.port) === 0 || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw authError('auth_configuration', 'SoundCloud requires a registered HTTP callback on 127.0.0.1 with an explicit port.');
  }
  return parsed;
}

function createSoundCloudAuth({ clientId, clientSecret, redirectUri = DEFAULT_REDIRECT_URI,
  fetch, openExternal, store, now = Date.now, timeoutMs = 120000 }) {
  const redirect = validateRedirect(redirectUri);
  const configured = typeof clientId === 'string' && clientId.trim().length > 0;
  const applicationCredentials = configured && typeof clientSecret === 'string' && clientSecret.length > 0;
  if (typeof fetch !== 'function' || typeof openExternal !== 'function' ||
      !store?.load || !store?.save || !store?.clear) {
    throw new TypeError('SoundCloud authentication requires fetch, browser, and secure storage adapters.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid SoundCloud authentication timeout.');

  let tokens = null;
  let loaded = false;
  let loadPromise = null;
  let generation = 0;
  let disposed = false;
  let connectPromise = null;
  let reconnectPromise = null;
  let authQueue = Promise.resolve();
  let storageQueue = Promise.resolve();
  const operations = new Set();
  const cancelled = () => authError('auth_cancelled', 'SoundCloud connection was cancelled.');
  const required = () => authError('auth_required', 'Choose Playback > Connect SoundCloud to play SoundCloud tracks.');
  const snapshot = () => ({ configured, connected: !!tokens && !disposed,
    authMode: tokens?.authMode || (applicationCredentials ? 'application' : 'none') });

  function enqueueStorage(work) {
    const result = storageQueue.then(work);
    storageQueue = result.catch(() => {});
    return result;
  }

  function assertCurrent(epoch) {
    if (disposed || epoch !== generation) throw cancelled();
  }

  function requireConfigured() {
    if (disposed) throw cancelled();
    if (!configured) throw authError('auth_configuration', 'Configure your SoundCloud application credentials before connecting.');
  }

  function storageFailure(error) {
    return authError(error?.code === 'storage_unavailable' ? 'storage_unavailable' : 'storage_error',
      'Saved SoundCloud sign-in could not be accessed securely. Unlock your system keychain, restart Nostalgify, and try again.');
  }

  function loadTokens() {
    if (loaded) return Promise.resolve();
    if (loadPromise) return loadPromise;
    const epoch = generation;
    const pending = enqueueStorage(async () => {
      let saved;
      try { saved = await store.load(); } catch (error) {
        // Public playback with developer-owned credentials does not require a
        // desktop keychain. Only user-delegated tokens are stored on disk.
        if (!applicationCredentials) throw storageFailure(error);
      }
      assertCurrent(epoch);
      if (saved && saved.clientId === clientId && validToken(saved.accessToken) &&
          validToken(saved.refreshToken) && Number.isFinite(saved.expiresAt) && saved.expiresAt > 0) {
        tokens = { ...saved, authMode: 'user' };
      }
      loaded = true;
    });
    loadPromise = pending.finally(() => { loadPromise = null; });
    return loadPromise;
  }

  function operation(epoch) {
    const controller = new AbortController();
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    cancellation.catch(() => {});
    const op = {
      epoch, controller, close: () => {},
      check: () => {
        assertCurrent(epoch);
        if (controller.signal.aborted) throw op.failure;
      },
      wait: (promise) => Promise.race([promise, cancellation]),
      cancel: (error) => {
        if (controller.signal.aborted) return;
        op.failure = error;
        controller.abort();
        op.close();
        rejectCancellation(error);
      },
      finish: () => {
        clearTimeout(timer);
        op.close();
        operations.delete(op);
      },
    };
    const timer = setTimeout(() => op.cancel(authError('auth_timeout', 'Connecting to SoundCloud timed out. Try Playback > Connect SoundCloud again.')), timeoutMs);
    operations.add(op);
    return op;
  }

  function serialized(work) {
    const epoch = generation;
    const result = authQueue.then(() => { assertCurrent(epoch); return work(epoch); });
    authQueue = result.catch(() => {});
    return result;
  }

  async function exchange(parameters, op, authMode = 'user') {
    let response;
    let data;
    try {
      op.check();
      const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
      const form = { ...parameters };
      if (parameters.grant_type === 'client_credentials') {
        // SoundCloud accepts only HTTP Basic credentials for this grant.
        headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
      } else {
        // Authorization-code exchange and refresh use form credentials. An
        // explicitly approved public client continues to omit the secret.
        form.client_id = clientId;
        if (applicationCredentials) form.client_secret = clientSecret;
      }
      response = await op.wait(fetch(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: op.controller.signal,
        headers,
        body: new URLSearchParams(form).toString(),
      }));
      op.check();
      if (!response.ok) {
        throw authError('auth_failed', 'SoundCloud authentication failed. Check the application credentials and authorization settings, then connect again.');
      }
      data = await op.wait(response.json());
      op.check();
    } catch (error) {
      op.check();
      if (error?.code === 'auth_failed') throw error;
      throw authError('auth_failed', 'Could not connect to SoundCloud. Check your connection and try again.');
    }
    const lifetime = data?.expires_in;
    const seconds = typeof lifetime === 'number' || (typeof lifetime === 'string' && /^\d+$/.test(lifetime))
      ? Number(lifetime) : NaN;
    const expiresAt = now() + seconds * 1000;
    if (!validToken(data?.access_token) ||
        (authMode === 'user' ? !validToken(data?.refresh_token) :
          data?.refresh_token != null && !validToken(data.refresh_token)) ||
        !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(expiresAt) ||
        (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer')) {
      throw authError('auth_failed', 'SoundCloud returned an invalid authentication response. Try connecting again.');
    }
    return { clientId, accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresAt, authMode };
  }

  async function commit(next, op) {
    if (next.authMode === 'application') {
      op.check();
      tokens = next;
      return;
    }
    await op.wait(enqueueStorage(async () => {
      op.check();
      try {
        await store.save(next);
        // A timeout or disconnect during a write cannot leave credentials that
        // silently reconnect on the next app launch.
        op.check();
      } catch (error) {
        if (op.epoch === generation) tokens = null;
        await store.clear().catch(() => {});
        op.check();
        throw storageFailure(error);
      }
      // A disconnect queues a clear after this write, and must never be undone.
      op.check();
      tokens = next;
      loaded = true;
    }));
    op.check();
  }

  async function receiveCode(op, state) {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    codePromise.catch(() => {});
    let accepted = false;
    const sockets = new Set();
    const server = http.createServer((request, response) => {
      const respond = (status, text) => {
        response.writeHead(status, {
          'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff', connection: 'close',
        });
        response.end(text);
        // Stop tracking once the small, constant response has been sent so
        // cleanup can close incomplete requests without truncating this page.
        response.once('finish', () => sockets.delete(request.socket));
      };
      let url;
      try { url = new URL(request.url, redirect.origin); } catch { return respond(400, 'Invalid request.'); }
      if (request.method !== 'GET') return respond(405, 'Use the SoundCloud browser sign-in link.');
      if (request.headers.host !== redirect.host || url.origin !== redirect.origin ||
          url.pathname !== redirect.pathname) return respond(404, 'Not found.');
      const suppliedState = url.searchParams.get('state') || '';
      if (url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(suppliedState) !== Buffer.byteLength(state) ||
          !crypto.timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))) {
        return respond(400, 'Invalid sign-in state. Use the original SoundCloud sign-in link.');
      }
      if (accepted) return respond(409, 'This sign-in response has already been received.');
      const codes = url.searchParams.getAll('code');
      const errors = url.searchParams.getAll('error');
      if (errors.length === 1 && codes.length === 0) {
        accepted = true;
        respond(400, 'SoundCloud sign-in was declined. Return to Nostalgify.');
        rejectCode(authError('auth_denied', 'SoundCloud sign-in was declined. Connect again when ready.'));
      } else if (codes.length === 1 && errors.length === 0 && validToken(codes[0])) {
        accepted = true;
        respond(200, 'SoundCloud sign-in response received. Return to Nostalgify.');
        resolveCode(codes[0]);
      } else {
        respond(400, 'Invalid SoundCloud sign-in response.');
      }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 5000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    op.close = () => {
      server.close();
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
    };
    await op.wait(new Promise((resolve, reject) => {
      server.once('error', () => reject(authError('auth_callback_unavailable', 'The SoundCloud callback port is unavailable. Close the other sign-in session and try again.')));
      server.listen(Number(redirect.port), '127.0.0.1', resolve);
    }));
    op.check();
    return { codePromise, rejectCode };
  }

  function connect() {
    try { requireConfigured(); } catch (error) { return Promise.reject(error); }
    if (connectPromise) return connectPromise;
    const pending = serialized(async (epoch) => {
      const op = operation(epoch);
      try {
        await op.wait(loadTokens());
        op.check();
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const state = crypto.randomBytes(32).toString('base64url');
        const { codePromise } = await receiveCode(op, state);
        const authorize = new URL(AUTHORIZE_URL);
        authorize.search = new URLSearchParams({
          response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
          code_challenge: challenge, code_challenge_method: 'S256', state,
        }).toString();
        try { await op.wait(openExternal(authorize.toString())); } catch {
          op.check();
          throw authError('auth_browser_failed', 'The browser could not open SoundCloud. Check your default browser and try again.');
        }
        const code = await op.wait(codePromise);
        const next = await exchange({ grant_type: 'authorization_code', code,
          code_verifier: verifier, redirect_uri: redirectUri }, op);
        await commit(next, op);
        return snapshot();
      } finally { op.finish(); }
    });
    connectPromise = pending.finally(() => { if (connectPromise === exposed) connectPromise = null; });
    const exposed = connectPromise;
    return exposed;
  }

  function getAccessToken() {
    try { requireConfigured(); } catch (error) { return Promise.reject(error); }
    return serialized(async (epoch) => {
      const op = operation(epoch);
      try {
        // Bound this caller's wait even when a shared Keychain read is still
        // pending. The storage operation itself finishes independently.
        await op.wait(loadTokens());
        op.check();
        if (!tokens && !applicationCredentials) throw required();
        if (tokens?.expiresAt > now() + 60000) return tokens.accessToken;
        const previous = tokens;
        // A refresh token is single-use. Remove the saved token before sending
        // it, so an ambiguous network failure cannot cause its reuse.
        tokens = null;
        if (previous?.authMode === 'user') {
          await op.wait(enqueueStorage(async () => {
            op.check();
            try { await store.clear(); } catch (error) { throw storageFailure(error); }
          }));
        }
        const mode = previous?.authMode || 'application';
        const parameters = previous?.refreshToken
          ? { grant_type: 'refresh_token', refresh_token: previous.refreshToken }
          : { grant_type: 'client_credentials' };
        const next = await exchange(parameters, op, mode);
        await commit(next, op);
        return next.accessToken;
      } finally { op.finish(); }
    });
  }

  function reconnect() {
    if (!applicationCredentials) return connect();
    try { requireConfigured(); } catch (error) { return Promise.reject(error); }
    if (reconnectPromise) return reconnectPromise;
    const pending = serialized(async (epoch) => {
      const op = operation(epoch);
      try {
        await op.wait(loadTokens());
        op.check();
        // An API-rejected token may still have a future expiry. Explicit
        // reconnect must request a fresh grant, not return that cached token.
        // Keep encrypted user credentials intact when changing to app access.
        tokens = null;
        const next = await exchange({ grant_type: 'client_credentials' }, op, 'application');
        await commit(next, op);
        return snapshot();
      } finally { op.finish(); }
    });
    reconnectPromise = pending.finally(() => { if (reconnectPromise === exposed) reconnectPromise = null; });
    const exposed = reconnectPromise;
    return exposed;
  }

  async function disconnect() {
    generation += 1;
    tokens = null;
    loaded = true;
    connectPromise = null;
    reconnectPromise = null;
    for (const op of operations) op.cancel(cancelled());
    try { await enqueueStorage(() => store.clear()); } catch (error) { throw storageFailure(error); }
    return snapshot();
  }

  return {
    connect, reconnect, getAccessToken, disconnect,
    status: async () => {
      if (configured && !disposed) await loadTokens();
      return snapshot();
    },
    dispose: async () => {
      disposed = true;
      generation += 1;
      tokens = null;
      for (const op of operations) op.cancel(cancelled());
      // Shutdown preserves encrypted credentials for the next app launch.
      await storageQueue;
    },
  };
}

module.exports = { createSoundCloudAuth, DEFAULT_REDIRECT_URI };
