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
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString: (value) => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
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

test('plaintext and unavailable encryption backends fail closed before touching files', async (t) => {
  for (const overrides of [{ getSelectedStorageBackend: () => 'basic_text' }, { isEncryptionAvailable: () => false }]) {
    const { store, filePath } = await fixture(t, overrides);
    await assert.rejects(store.save({ accessToken: 'secret' }), { code: 'storage_unavailable' });
    await assert.rejects(store.load(), { code: 'storage_unavailable' });
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
    await store.clear();
  }
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
  const store = createTokenStore({ filePath, safeStorage: { ...adapter, encryptString(value) {
    if (fail) throw new Error('secret in adapter error');
    return adapter.encryptString(value);
  } } });
  await store.save({ token: 'previous' }); fail = true;
  await assert.rejects(store.save({ token: 'next' }), (error) => error.code === 'storage_error' && !error.message.includes('secret in'));
  assert.deepEqual(await store.load(), { token: 'previous' });
  assert.deepEqual(await fs.readdir(path.join(dir, 'user')), ['soundcloud.tokens']);
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
