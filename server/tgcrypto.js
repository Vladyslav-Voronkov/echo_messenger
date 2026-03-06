/**
 * tgcrypto.js — Server-side crypto matching client's crypto.js (Web Crypto API)
 *
 * Algorithms must be identical to the client:
 *   - SHA-256 for room ID (one-way hash)
 *   - PBKDF2 (100k iterations, SHA-256, salt="chatapp-v1") → AES-256-GCM key
 *   - AES-256-GCM, 12-byte random IV, 128-bit auth tag (tag appended to ciphertext)
 *
 * NOTE: Storing the seed phrase on the server breaks zero-knowledge for bridged rooms.
 * This is an explicit user choice when setting up Telegram sync.
 */

import crypto from 'crypto';

const SALT = Buffer.from('chatapp-v1', 'utf8');

export function deriveRoomId(seedPhrase) {
  return crypto.createHash('sha256').update(seedPhrase.trim(), 'utf8').digest('hex');
}

export function deriveKey(seedPhrase) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(seedPhrase.trim(), SALT, 100_000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Encrypt plaintext string → { iv: base64, data: base64 }
 * data = ciphertext + 16-byte GCM auth tag (matches Web Crypto output format)
 */
export function encryptData(keyBuffer, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return {
    iv: iv.toString('base64'),
    data: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
}

/**
 * Decrypt { iv: base64, data: base64 } → plaintext string
 * data = ciphertext + 16-byte GCM auth tag (last 16 bytes)
 */
export function decryptData(keyBuffer, ivBase64, dataBase64) {
  const iv = Buffer.from(ivBase64, 'base64');
  const buf = Buffer.from(dataBase64, 'base64');
  const tag = buf.slice(-16);
  const ciphertext = buf.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a nickname → "ivBase64.dataBase64"
 * Matches client encryptNick() format (dot-separated iv and ciphertext+tag)
 */
export function encryptNick(keyBuffer, nick) {
  const { iv, data } = encryptData(keyBuffer, nick);
  return `${iv}.${data}`;
}
