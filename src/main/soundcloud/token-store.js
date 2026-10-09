const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function storageError(code, message, reason, operation) {
  // Only fixed messages and structured categories cross into auth, which owns
  // user-facing recovery guidance. Never retain an adapter error or its cause.
  return Object.assign(new Error(message), { code, reason, operation });
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
      // Electron 44 reports readiness here even when Keychain consent was
      // denied. A temporary decrypt rejection is classified separately below.
      if (!await safeStorage?.isAsyncEncryptionAvailable() ||
          typeof safeStorage.encryptStringAsync !== 'function' ||
          typeof safeStorage.decryptStringAsync !== 'function' ||
          safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('unavailable');
      }
    } catch {
      throw storageError('storage_unavailable', 'Secure storage is unavailable.', 'availability');
    }
  }

  async function writeTokens(tokens) {
    await requireEncryption();
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    let reason = 'encryption';
    try {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(tokens));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('invalid ciphertext');
      // Electron's async Linux encryptor can select the hardcoded-key v10
      // fallback independently of getSelectedStorageBackend(). Never persist it.
      if (platform === 'linux' && encrypted.subarray(0, 3).toString() === 'v10') {
        throw storageError('storage_unavailable', 'Insecure token encryption was rejected.', 'insecure', 'save');
      }
      reason = 'filesystem';
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (error.code === 'storage_unavailable') throw error;
      throw storageError('storage_error', 'SoundCloud tokens could not be saved.', reason, 'save');
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return {
    load: () => serialized(async () => {
      let handle;
      let reason = 'filesystem';
      try {
        handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) {
          throw storageError('storage_error', 'Invalid saved token file.', 'corrupt', 'load');
        }
        const encrypted = await handle.readFile();
        await handle.close();
        handle = null;
        // Existing files must meet the same encryption policy as new writes.
        if (platform === 'linux' && encrypted.subarray(0, 3).toString() === 'v10') {
          throw storageError('storage_unavailable', 'Insecure saved token encryption was rejected.', 'insecure', 'load');
        }
        // A fresh profile has no account tokens. Avoid prompting for access to
        // Keychain for application credentials that never persist a user login.
        await requireEncryption();
        reason = 'corrupt';
        let decrypted;
        try { decrypted = await safeStorage.decryptStringAsync(encrypted); } catch (error) {
          if (error?.message === 'safeStorage.decryptStringAsync is temporarily unavailable. Please try again.') {
            throw storageError('storage_unavailable', 'Token decryption is temporarily unavailable.', 'temporary', 'load');
          }
          throw storageError('storage_error', 'Saved tokens could not be decrypted.', 'corrupt', 'load');
        }
        if (typeof decrypted?.result !== 'string' || typeof decrypted.shouldReEncrypt !== 'boolean') {
          throw new Error('invalid decryption result');
        }
        const tokens = JSON.parse(decrypted.result);
        // Stay inside the same queue entry: a queued save/clear must follow the
        // atomic rotation, and recursively queuing save here would deadlock.
        // Fail closed if rotation fails, preserving the old ciphertext to retry.
        if (decrypted.shouldReEncrypt) {
          try { await writeTokens(tokens); } catch (error) {
            throw storageError(error.code, 'Saved token re-encryption failed.', error.reason, 'rotate');
          }
        }
        return tokens;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'storage_unavailable' || error.code === 'storage_error') throw error;
        throw storageError('storage_error', 'Saved tokens could not be read.', reason, 'load');
      } finally {
        await handle?.close().catch(() => {});
      }
    }),

    save: (tokens) => serialized(() => writeTokens(tokens)),

    clear: () => serialized(async () => {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        throw storageError('storage_error', 'Saved tokens could not be removed.', 'filesystem', 'clear');
      }
    }),
  };
}

module.exports = { createTokenStore };
