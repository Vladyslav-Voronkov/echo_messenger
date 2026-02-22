/**
 * crypto.js — Client-side cryptography (Web Crypto API)
 *
 * All operations run entirely in the browser.
 * No secrets ever leave the client.
 *
 * Algorithms:
 *   - SHA-256 for room ID derivation (one-way)
 *   - PBKDF2 (100k iterations, SHA-256) → AES-256-GCM key
 *   - AES-256-GCM for all message + image encryption
 *   - Random 12-byte IV per encryption call
 */

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = new TextEncoder().encode('chatapp-v1');
const KEY_BITS = 256;
const IV_BYTES = 12;
const TAG_BITS = 128;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function encode(str) {
  return new TextEncoder().encode(str);
}

function decode(buf) {
  return new TextDecoder().decode(buf);
}

export async function deriveRoomId(seedPhrase) {
  const hashBuf = await crypto.subtle.digest('SHA-256', encode(seedPhrase.trim()));
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function deriveKey(seedPhrase) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encode(seedPhrase.trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptMessage(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    encode(plaintext),
  );
  return { iv: bufToB64(iv), data: bufToB64(cipherBuf) };
}

export async function encryptNick(key, nickname) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    encode(nickname),
  );
  return bufToB64(iv) + '.' + bufToB64(cipherBuf);
}

export async function decryptMessage(key, ivB64, dataB64) {
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64), tagLength: TAG_BITS },
    key,
    b64ToBuf(dataB64),
  );
  return decode(plainBuf);
}

export async function decryptNick(key, encryptedNick) {
  const [ivB64, dataB64] = encryptedNick.split('.');
  return decryptMessage(key, ivB64, dataB64);
}

export async function decryptMessageObject(key, msgObj) {
  try {
    const [text, nick] = await Promise.all([
      decryptMessage(key, msgObj.iv, msgObj.data),
      decryptNick(key, msgObj.nick),
    ]);
    return { text, nick, ts: msgObj.ts };
  } catch {
    return null;
  }
}

export async function encryptImageBuffer(key, arrayBuffer, mimeType) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    arrayBuffer,
  );
  return {
    iv: bufToB64(iv),
    data: bufToB64(cipherBuf),
    mime: mimeType,
  };
}

export async function decryptImageToDataUrl(key, ivB64, dataB64, mimeType) {
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64), tagLength: TAG_BITS },
    key,
    b64ToBuf(dataB64),
  );
  return 'data:' + mimeType + ';base64,' + bufToB64(plainBuf);
}
