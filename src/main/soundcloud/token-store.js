const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function storageError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Encrypt account tokens with OS-protected keys through Electron safeStorage. */
function createTokenStore({ filePath, safeStorage, platform = process.platform }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('SoundCloud token storage requires an absolute file path.');
  }
  let queue = Promise.resolve();
  const serialized = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };

  async function requireEncryption() {
    try {
      if (!await safeStorage?.isAsyncEncryptionAvailable() ||
          typeof safeStorage.encryptStringAsync !== 'function' ||
          typeof safeStorage.decryptStringAsync !== 'function' ||
          safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('unavailable');
      }
    } catch {
      throw storageError('storage_unavailable', 'Secure storage is unavailable. Unlock your system keychain, restart Nostalgify, and try again.');
    }
  }

  async function writeTokens(tokens) {
    await requireEncryption();
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(tokens));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('invalid ciphertext');
      // Electron's async Linux encryptor can select the hardcoded-key v10
      // fallback independently of getSelectedStorageBackend(). Never persist it.
      if (platform === 'linux' && encrypted.subarray(0, 3).toString() === 'v10') {
        throw storageError('storage_unavailable', 'Secure storage is unavailable. Unlock your system keychain, restart Nostalgify, and try again.');
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (error.code === 'storage_unavailable') throw error;
      throw storageError('storage_error', 'SoundCloud sign-in tokens could not be saved securely. Unlock your system keychain, restart Nostalgify, and try again.');
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return {
    load: () => serialized(async () => {
      let handle;
      try {
        handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid token file');
        const encrypted = await handle.readFile();
        await handle.close();
        handle = null;
        // A fresh profile has no account tokens. Avoid prompting/blocking on
        // Keychain for application credentials that never persist a user login.
        await requireEncryption();
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        if (typeof decrypted?.result !== 'string' || typeof decrypted.shouldReEncrypt !== 'boolean') {
          throw new Error('invalid decryption result');
        }
        const tokens = JSON.parse(decrypted.result);
        // Stay inside the same queue entry: a queued save/clear must follow the
        // atomic rotation, and recursively queuing save here would deadlock.
        if (decrypted.shouldReEncrypt) await writeTokens(tokens);
        return tokens;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'storage_unavailable') throw error;
        throw storageError('storage_error', 'Saved SoundCloud sign-in could not be read securely. Unlock your system keychain and restart Nostalgify. If the problem persists, use Playback > Forget Local SoundCloud Sign-in, then connect again.');
      } finally {
        await handle?.close();
      }
    }),

    save: (tokens) => serialized(() => writeTokens(tokens)),

    clear: () => serialized(async () => {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        throw storageError('storage_error', 'Saved SoundCloud sign-in could not be removed. Check the application data directory permissions.');
      }
    }),
  };
}

module.exports = { createTokenStore };
