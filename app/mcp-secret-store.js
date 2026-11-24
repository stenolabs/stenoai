'use strict';

/**
 * Encrypted credentials for MCP action connections: bearer/header tokens,
 * OAuth token sets and Dynamic Client Registration results.
 *
 * Same contract as the cloud ASR key (openai-asr-key-store.js):
 *   - encrypted at rest with Electron safeStorage, never in config.json, argv,
 *     the environment of a child process, or a log line;
 *   - bound to an endpoint origin: the envelope records the origin it was
 *     saved for and a read for any other origin fails closed, so editing a
 *     connection's URL to a different host cannot hand it the old secret;
 *   - written atomically (exclusive temp file, 0600, rename) and read back
 *     before the write counts as done.
 *
 * One file per secret under <userData>/mcp-credentials/, named by a hash of
 * the key so connection ids and issuer URLs never appear as file names.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const ENVELOPE_VERSION = 1;

function fileNameFor(key) {
  return `${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 40)}.bin`;
}

function writePrivateTemp(fs, target, bytes) {
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    try { fs.unlinkSync(target); } catch (_) {}
    throw error;
  }
}

function createSecretStore({ dir, safeStorage, fs = nodeFs, path = nodePath }) {
  const fileFor = (key) => path.join(dir, fileNameFor(key));
  const storage = () => (typeof safeStorage === 'function' ? safeStorage() : safeStorage);

  function available() {
    try {
      return storage().isEncryptionAvailable();
    } catch (_) {
      return false;
    }
  }

  /** The secret saved for (key, origin), or null (missing, other origin, undecryptable). */
  function load(key, origin) {
    if (typeof origin !== 'string' || !origin) return null;
    try {
      const file = fileFor(key);
      if (!fs.existsSync(file)) return null;
      const envelope = JSON.parse(storage().decryptString(fs.readFileSync(file)));
      if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.key !== key || envelope.origin !== origin) {
        return null;
      }
      return envelope.value ?? null;
    } catch (_) {
      return null;
    }
  }

  function save(key, origin, value) {
    if (typeof origin !== 'string' || !origin) throw new Error('Credential origin is invalid');
    if (!available()) throw new Error('Secure storage is not available on this computer');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = fileFor(key);
    const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    const encrypted = storage().encryptString(JSON.stringify({ version: ENVELOPE_VERSION, key, origin, value }));
    writePrivateTemp(fs, temp, encrypted);
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch (_) {}
      throw new Error('Credential was not saved', { cause: error });
    }
    const readback = load(key, origin);
    if (JSON.stringify(readback) !== JSON.stringify(value ?? null)) {
      throw new Error('Credential readback did not match');
    }
    return true;
  }

  function remove(key) {
    try {
      const file = fileFor(key);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { available, load, save, remove, fileFor };
}

module.exports = { createSecretStore, fileNameFor };
