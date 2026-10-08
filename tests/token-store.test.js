const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTokenStore } = require('../src/main/soundcloud/token-store');

function encryptionAdapter(overrides = {}) {
  const key = crypto.randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptStringAsync: async (value) => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
    ...overrides,
  };
}
async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nostalgify-token-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'user', 'soundcloud.tokens');
  return { dir, filePath, store: createTokenStore({ filePath, safeStorage: encryptionAdapter(overrides) }) };
}

test('tokens round trip encrypted with private file permissions', async (t) => {
  const { store, filePath } = await fixture(t);
  assert.equal(await store.load(), null);
  const tokens = { accessToken: 'very-secret-access-token', refreshToken: 'secret-refresh' };
  await store.save(tokens);
  assert.deepEqual(await store.load(), tokens);
  const disk = await fs.readFile(filePath);
  assert.equal(disk.includes(Buffer.from(tokens.accessToken)), false);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['soundcloud.tokens']);
  await store.clear(); assert.equal(await store.load(), null);
});

test('plaintext and unavailable backends reject saves and existing token files without decrypting', async (t) => {
  for (const overrides of [
    { getSelectedStorageBackend: () => 'basic_text' },
    { isAsyncEncryptionAvailable: async () => false },
    { isAsyncEncryptionAvailable: undefined },
    { encryptStringAsync: undefined },
    { decryptStringAsync: undefined },
  ]) {
    let decrypted = false;
    const { store, filePath } = await fixture(t, { decryptStringAsync() { decrypted = true; }, ...overrides });
    await assert.rejects(store.save({ accessToken: 'secret' }), { code: 'storage_unavailable' });
    assert.equal(await store.load(), null);
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
    await fs.mkdir(path.dirname(filePath));
    await fs.writeFile(filePath, 'test-only-encrypted-data');
    await assert.rejects(store.load(), { code: 'storage_unavailable' });
    assert.equal(decrypted, false);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'test-only-encrypted-data');
    await store.clear();
  }
});

test('a missing token file never consults safeStorage or Keychain', async (t) => {
  const { filePath } = await fixture(t);
  const lookups = [];
  const safeStorage = new Proxy({}, {
    get(_target, property) { lookups.push(property); throw new Error('Keychain lookup must not happen'); },
  });
  const store = createTokenStore({ filePath, safeStorage });
  assert.equal(await store.load(), null, 'a missing parent directory is an empty account profile');
  await fs.mkdir(path.dirname(filePath));
  assert.equal(await store.load(), null, 'a missing token file is an empty account profile');
  assert.deepEqual(lookups, []);
  await fs.writeFile(filePath, 'test-only-encrypted-data');
  await assert.rejects(store.load(), { code: 'storage_unavailable' });
  assert.deepEqual(lookups, ['isAsyncEncryptionAvailable'], 'existing ciphertext still requires secure storage before decrypting');
});

test('atomic replacement and concurrent writes leave one complete encrypted file', async (t) => {
  const { store, filePath } = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, sequence) => store.save({ sequence })));
  assert.deepEqual(await store.load(), { sequence: 9 });
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['soundcloud.tokens']);
  await Promise.all([store.save({ sequence: 10 }), store.clear()]);
  assert.equal(await store.load(), null);
});

test('corrupt ciphertext reports a fixed error without echoing token contents', async (t) => {
  const { store, filePath } = await fixture(t);
  await fs.mkdir(path.dirname(filePath));
  await fs.writeFile(filePath, 'plaintext-secret-token');
  await assert.rejects(store.load(), (error) => error.code === 'storage_error' && !error.message.includes('plaintext-secret-token'));
});

test('failed encryption preserves the previous file and cleans temporary output', async (t) => {
  let fail = false;
  const adapter = encryptionAdapter();
  const { dir, filePath } = await fixture(t);
  const store = createTokenStore({ filePath, safeStorage: { ...adapter, async encryptStringAsync(value) {
    if (fail) throw new Error('secret in adapter error');
    return adapter.encryptStringAsync(value);
  } } });
  await store.save({ token: 'previous' }); fail = true;
  await assert.rejects(store.save({ token: 'next' }), (error) => error.code === 'storage_error' && !error.message.includes('secret in'));
  assert.deepEqual(await store.load(), { token: 'previous' });
  assert.deepEqual(await fs.readdir(path.join(dir, 'user')), ['soundcloud.tokens']);
});

test('existing tokens use async APIs without touching synchronous Keychain methods', async (t) => {
  const { filePath } = await fixture(t);
  const adapter = encryptionAdapter();
  for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
    Object.defineProperty(adapter, method, { get() { assert.fail(`must not access ${method}`); } });
  }
  const store = createTokenStore({ filePath, safeStorage: adapter });
  await store.save({ token: 'async-only' });
  assert.deepEqual(await store.load(), { token: 'async-only' });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('pending Keychain operations yield to the event loop and serialize a queued clear', { timeout: 5000 }, async (t) => {
  for (const method of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    const { filePath } = await fixture(t);
    const adapter = encryptionAdapter();
    const entered = deferred();
    const release = deferred();
    const store = createTokenStore({ filePath, safeStorage: adapter });
    await store.save({ token: 'before' });
    const original = adapter[method];
    adapter[method] = async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    let settled = false;
    const pending = (method === 'decryptStringAsync' ? store.load() : store.save({ token: 'after' }))
      .finally(() => { settled = true; });
    await entered.promise;
    const clearing = store.clear();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `${method} is still awaiting Keychain`);
    assert.ok((await fs.stat(filePath)).isFile(), 'clear cannot race the in-flight operation');
    release.resolve();
    await Promise.all([pending, clearing]);
    assert.equal(await store.load(), null, 'a completed delayed save cannot restore a cleared sign-in');
  }
});

test('key rotation rewrites atomically before queued saves and clears', { timeout: 5000 }, async (t) => {
  for (const nextOperation of ['save', 'clear']) {
    const { filePath } = await fixture(t);
    const adapter = encryptionAdapter();
    const store = createTokenStore({ filePath, safeStorage: adapter });
    await store.save({ token: 'old' });
    const previous = await fs.readFile(filePath);
    const entered = deferred();
    const release = deferred();
    const decrypt = adapter.decryptStringAsync;
    const encrypt = adapter.encryptStringAsync;
    adapter.decryptStringAsync = async (value) => ({ ...await decrypt(value), shouldReEncrypt: true });
    adapter.encryptStringAsync = async (value) => {
      entered.resolve();
      await release.promise;
      return encrypt(value);
    };
    const loading = store.load();
    await entered.promise;
    const next = nextOperation === 'save' ? store.save({ token: 'new' }) : store.clear();
    assert.deepEqual(await fs.readFile(filePath), previous, 'old ciphertext survives until rotation commits');
    release.resolve();
    assert.deepEqual(await loading, { token: 'old' });
    await next;
    adapter.decryptStringAsync = decrypt;
    assert.deepEqual(await store.load(), nextOperation === 'save' ? { token: 'new' } : null);
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), nextOperation === 'save' ? ['soundcloud.tokens'] : []);
  }
});

test('rotation persists new ciphertext with private permissions', async (t) => {
  const { filePath } = await fixture(t);
  const adapter = encryptionAdapter();
  const store = createTokenStore({ filePath, safeStorage: adapter });
  await store.save({ token: 'rotate' });
  const previous = await fs.readFile(filePath);
  const decrypt = adapter.decryptStringAsync;
  adapter.decryptStringAsync = async (value) => ({ ...await decrypt(value), shouldReEncrypt: true });
  assert.deepEqual(await store.load(), { token: 'rotate' });
  const rotated = await fs.readFile(filePath);
  assert.notDeepEqual(rotated, previous);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await decrypt(rotated), { result: JSON.stringify({ token: 'rotate' }), shouldReEncrypt: false });
});

test('failed rotation preserves ciphertext and a later load can retry', async (t) => {
  const { filePath } = await fixture(t);
  const adapter = encryptionAdapter();
  const store = createTokenStore({ filePath, safeStorage: adapter });
  await store.save({ token: 'preserved' });
  const previous = await fs.readFile(filePath);
  const decrypt = adapter.decryptStringAsync;
  const encrypt = adapter.encryptStringAsync;
  adapter.decryptStringAsync = async (value) => ({ ...await decrypt(value), shouldReEncrypt: true });
  adapter.encryptStringAsync = async () => { throw new Error('sensitive adapter detail'); };
  await assert.rejects(store.load(), (error) => error.code === 'storage_error' && !error.message.includes('sensitive'));
  assert.deepEqual(await fs.readFile(filePath), previous);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['soundcloud.tokens']);
  adapter.encryptStringAsync = encrypt;
  assert.deepEqual(await store.load(), { token: 'preserved' });
  assert.notDeepEqual(await fs.readFile(filePath), previous);
});

test('async availability and decryption failures keep ciphertext for a later retry', async (t) => {
  for (const method of ['isAsyncEncryptionAvailable', 'decryptStringAsync']) {
    const { filePath } = await fixture(t);
    const adapter = encryptionAdapter();
    const store = createTokenStore({ filePath, safeStorage: adapter });
    await store.save({ token: 'preserved' });
    const previous = await fs.readFile(filePath);
    const original = adapter[method];
    adapter[method] = async () => { throw new Error('sensitive provider failure'); };
    await assert.rejects(store.load(), (error) =>
      error.code === (method === 'isAsyncEncryptionAvailable' ? 'storage_unavailable' : 'storage_error') &&
      !error.message.includes('sensitive'));
    assert.deepEqual(await fs.readFile(filePath), previous);
    adapter[method] = original;
    assert.deepEqual(await store.load(), { token: 'preserved' });
  }
});

test('Linux async hardcoded-key fallback cannot overwrite securely stored tokens', async (t) => {
  const { filePath } = await fixture(t);
  const adapter = encryptionAdapter();
  const store = createTokenStore({ filePath, safeStorage: adapter, platform: 'linux' });
  await store.save({ token: 'preserved' });
  const previous = await fs.readFile(filePath);
  // Async providers are selected independently of the synchronous backend label.
  adapter.encryptStringAsync = async () => Buffer.from('v10-test-only-fallback');
  await assert.rejects(store.save({ token: 'next' }), { code: 'storage_unavailable' });
  assert.deepEqual(await fs.readFile(filePath), previous);
  assert.deepEqual(await store.load(), { token: 'preserved' });
});

test('the Linux fallback guard allows macOS Keychain v10 ciphertext', async (t) => {
  const { filePath } = await fixture(t);
  const encrypted = Buffer.from('v10-test-only-keychain-ciphertext');
  const adapter = encryptionAdapter({ encryptStringAsync: async () => encrypted });
  delete adapter.getSelectedStorageBackend;
  const store = createTokenStore({ filePath, safeStorage: adapter, platform: 'darwin' });
  await store.save({ token: 'macos' });
  assert.deepEqual(await fs.readFile(filePath), encrypted);
});

test('token loading refuses symbolic links', async (t) => {
  const { store, dir, filePath } = await fixture(t);
  const target = path.join(dir, 'target');
  await fs.writeFile(target, 'unrelated'); await fs.mkdir(path.dirname(filePath));
  await fs.symlink(target, filePath);
  await assert.rejects(store.load(), { code: 'storage_error' });
  await store.clear();
  assert.equal(await fs.readFile(target, 'utf8'), 'unrelated');
});
