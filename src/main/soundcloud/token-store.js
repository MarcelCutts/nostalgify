const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function storageError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Tokens are encrypted by the OS keychain; never fall back to plaintext storage. */
function createTokenStore({ filePath, safeStorage }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('SoundCloud token storage requires an absolute file path.');
  }
  let queue = Promise.resolve();
  const serialized = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };

  function requireEncryption() {
    try {
      if (!safeStorage?.isEncryptionAvailable() ||
          safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('unavailable');
      }
    } catch {
      throw storageError('storage_unavailable', 'Secure credential storage is unavailable. Enable your system keychain before connecting SoundCloud.');
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
        // A fresh profile has no account tokens. Avoid prompting/blocking on
        // Keychain for application credentials that never persist a user login.
        requireEncryption();
        return JSON.parse(safeStorage.decryptString(encrypted));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'storage_unavailable') throw error;
        throw storageError('storage_error', 'SoundCloud credentials could not be read securely. Disconnect SoundCloud and connect again.');
      } finally {
        await handle?.close();
      }
    }),

    save: (tokens) => serialized(async () => {
      requireEncryption();
      const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      let handle;
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('invalid ciphertext');
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        handle = await fs.open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(encrypted);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, filePath);
      } catch {
        throw storageError('storage_error', 'SoundCloud credentials could not be saved securely. Check your system keychain and reconnect.');
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
      }
    }),

    clear: () => serialized(async () => {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        throw storageError('storage_error', 'Saved SoundCloud credentials could not be removed. Check the application data directory permissions.');
      }
    }),
  };
}

module.exports = { createTokenStore };
