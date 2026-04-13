'use strict';

const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';
const KEY_LENGTH = 32;           // 256 bits for AES-256
const SALT_LENGTH = 32;          // 256-bit salt
const IV_LENGTH = 12;            // 96-bit IV for GCM (NIST recommended)
const AUTH_TAG_LENGTH = 16;      // 128-bit auth tag
const ALGORITHM = 'aes-256-gcm';

// ─── Derive key from password + salt ──────────────────────────────────
// PBKDF2 with 100,000 iterations of SHA-512 → 32-byte key
function deriveKey(password, salt) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) {
    throw new Error('Salt must be a ' + SALT_LENGTH + '-byte Buffer');
  }
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

// ─── Encrypt data with AES-256-GCM ───────────────────────────────────
// Input:  data (Buffer), key (32-byte Buffer)
// Output: Buffer [IV(12) | AuthTag(16) | CipherText(...)]
function encrypt(data, key) {
  if (!Buffer.isBuffer(data)) {
    throw new Error('Data must be a Buffer');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error('Key must be a ' + KEY_LENGTH + '-byte Buffer');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: [IV(12)] [AuthTag(16)] [CipherText]
  return Buffer.concat([iv, authTag, encrypted]);
}

// ─── Decrypt data with AES-256-GCM ───────────────────────────────────
// Input:  packed Buffer [IV(12) | AuthTag(16) | CipherText(...)], key (32-byte Buffer)
// Output: Buffer (plaintext)
function decrypt(data, key) {
  if (!Buffer.isBuffer(data)) {
    throw new Error('Data must be a Buffer');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error('Key must be a ' + KEY_LENGTH + '-byte Buffer');
  }

  const minLength = IV_LENGTH + AUTH_TAG_LENGTH;
  if (data.length < minLength) {
    throw new Error('Encrypted data too short (minimum ' + minLength + ' bytes)');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const cipherText = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch (err) {
    if (err.message.includes('auth') || err.message.includes('tag') || err.code === 'ERR_CRYPTO_AEAD_TAG') {
      throw new Error('Decryption failed: wrong password or corrupted data');
    }
    throw err;
  }
}

// ─── Generate a cryptographically random salt ─────────────────────────
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

module.exports = {
  deriveKey,
  encrypt,
  decrypt,
  generateSalt,
  SALT_LENGTH,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
};
