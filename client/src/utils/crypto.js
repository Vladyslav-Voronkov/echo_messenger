/**
 * crypto.js — Client-side cryptography (Web Crypto API)
 *
 * All operations run entirely in the browser. No secrets ever leave the client.
 *
 * Algorithms:
 *   - SHA-256 for room ID derivation (legacy seed-phrase rooms)
 *   - PBKDF2 (300k iterations, SHA-256, random authSalt) → password hash for auth
 *   - ECDH P-256 for key exchange (DMs and group key wrapping)
 *   - HKDF (SHA-256) to derive AES-256-GCM keys from ECDH shared secrets
 *   - AES-256-GCM for all message + file encryption (12-byte random IV per call)
 *   - PBKDF2 to derive key for encrypting the user's ECDH private key (stored in localStorage)
 */

const KEY_BITS  = 256;
const IV_BYTES  = 12;
const TAG_BITS  = 128;

// Legacy seed-phrase PBKDF2 (kept for backward compat — rooms opened by seed)
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const LEGACY_PBKDF2_SALT       = new TextEncoder().encode('chatapp-v1');

// PBKDF2 iterations for password → auth hash (sent to server)
const AUTH_PBKDF2_ITERATIONS   = 300_000;

// PBKDF2 iterations for encrypting the local private key in localStorage
const KEY_WRAP_ITERATIONS      = 200_000;

// ── Utilities ─────────────────────────────────────────────────────────────────

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary  = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function encode(str) { return new TextEncoder().encode(str); }
function decode(buf) { return new TextDecoder().decode(buf); }

// ── Legacy: seed-phrase based room ID + key ───────────────────────────────────

export async function deriveRoomId(seedPhrase) {
  const hashBuf = await crypto.subtle.digest('SHA-256', encode(seedPhrase.trim()));
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function deriveKey(seedPhrase) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encode(seedPhrase.trim()), { name: 'PBKDF2' }, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: LEGACY_PBKDF2_SALT, iterations: LEGACY_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── Password auth hash (new, with random authSalt) ────────────────────────────

/**
 * Derive the password hash to send to server.
 * authSalt is a base64-encoded 16-byte random salt stored in accounts.json.
 * For legacy accounts (no authSalt), falls back to double-SHA256.
 */
export async function derivePasswordHash(password, authSalt) {
  if (!authSalt) {
    // Legacy fallback: sha256(sha256(password))
    const h1 = await crypto.subtle.digest('SHA-256', encode(password));
    const h2 = await crypto.subtle.digest('SHA-256', h1);
    return Array.from(new Uint8Array(h2)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const salt = b64ToBuf(authSalt);
  const keyMaterial = await crypto.subtle.importKey('raw', encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: AUTH_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random authSalt for new accounts (called client-side).
 * Returns base64 string.
 */
export function generateAuthSalt() {
  return bufToB64(crypto.getRandomValues(new Uint8Array(16)));
}

// ── ECDH P-256 key management ─────────────────────────────────────────────────

/**
 * Generate a fresh ECDH P-256 key pair.
 * The private key is extractable so we can encrypt + store it locally.
 */
export async function generateECDHKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,  // extractable
    ['deriveKey', 'deriveBits'],
  );
}

/** Export public key as base64-encoded SPKI */
export async function exportPublicKey(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufToB64(spki);
}

/** Import a base64-encoded SPKI public key */
export async function importPublicKey(b64Spki) {
  return crypto.subtle.importKey(
    'spki',
    b64ToBuf(b64Spki),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/**
 * Encrypt the private key JWK with password+authSalt for localStorage storage.
 * Returns base64-encoded payload: { iv(b64), data(b64) }.
 */
export async function encryptPrivateKey(privateKey, password, authSalt) {
  // Derive a wrapping key from the password
  const salt = authSalt ? b64ToBuf(authSalt) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KEY_WRAP_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  // Export private key as JWK, then encrypt it
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const plaintext = encode(JSON.stringify(jwk));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: TAG_BITS }, wrapKey, plaintext);

  return JSON.stringify({ iv: bufToB64(iv), data: bufToB64(cipherBuf), salt: bufToB64(salt) });
}

/**
 * Decrypt a stored encrypted private key.
 * Returns the CryptoKey or throws on wrong password.
 */
export async function decryptPrivateKey(encryptedJson, password) {
  const { iv, data, salt } = JSON.parse(encryptedJson);
  const keyMaterial = await crypto.subtle.importKey('raw', encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBuf(salt), iterations: KEY_WRAP_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(iv), tagLength: TAG_BITS },
    wrapKey,
    b64ToBuf(data),
  );

  const jwk = JSON.parse(decode(plainBuf));
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

// ── ECDH shared key derivation ────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key for a DM conversation.
 * Both parties derive the same key: ECDH(A_priv, B_pub) == ECDH(B_priv, A_pub)
 * Then HKDF with a context string based on sorted nicknames.
 *
 * @param {CryptoKey}  myPrivKey   - my ECDH private key
 * @param {CryptoKey}  theirPubKey - their ECDH public key (imported via importPublicKey)
 * @param {string}     nickA       - one participant nickname (will be sorted)
 * @param {string}     nickB       - other participant nickname
 */
export async function deriveDMKey(myPrivKey, theirPubKey, nickA, nickB) {
  // Step 1: raw ECDH shared secret (32 bytes)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPubKey },
    myPrivKey,
    256,
  );

  // Step 2: HKDF to derive AES key (prevents key reuse across contexts)
  const info = encode('dm:' + [nickA, nickB].map(n => n.toLowerCase()).sort().join(':'));
  return _hkdfToAESKey(sharedBits, info);
}

/**
 * Derive a shared wrapping key for encrypting a group key for a specific member.
 * Used when inviting someone to a group or when they accept.
 */
export async function deriveGroupWrapKey(myPrivKey, memberPubKey) {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: memberPubKey },
    myPrivKey,
    256,
  );
  const info = encode('group-key-wrap');
  return _hkdfToAESKey(sharedBits, info);
}

async function _hkdfToAESKey(sharedBits, info) {
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // zero salt — info provides domain separation
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── Group key management ──────────────────────────────────────────────────────

/**
 * Generate a random AES-256-GCM key for a new group.
 * Returns an extractable CryptoKey.
 */
export async function generateGroupKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap (encrypt) a group key for a member using their ECDH shared secret.
 * Returns base64 string.
 */
export async function wrapGroupKey(groupKey, wrapKey) {
  const rawKey = await crypto.subtle.exportKey('raw', groupKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    wrapKey,
    rawKey,
  );
  return JSON.stringify({ iv: bufToB64(iv), data: bufToB64(cipherBuf) });
}

/**
 * Unwrap (decrypt) a group key received from an invite.
 * Returns AES-256-GCM CryptoKey.
 */
export async function unwrapGroupKey(encryptedGroupKeyJson, wrapKey) {
  const { iv, data } = JSON.parse(encryptedGroupKeyJson);
  const rawKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(iv), tagLength: TAG_BITS },
    wrapKey,
    b64ToBuf(data),
  );
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// ── Message encryption / decryption ──────────────────────────────────────────

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
  } catch (err) {
    console.warn('[crypto] Decryption failed:', err?.message || err);
    return null;
  }
}

// ── Image encryption ──────────────────────────────────────────────────────────

export async function encryptImageBuffer(key, arrayBuffer, mimeType) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    arrayBuffer,
  );
  return { iv: bufToB64(iv), data: bufToB64(cipherBuf), mime: mimeType };
}

export async function decryptImageToDataUrl(key, ivB64, dataB64, mimeType) {
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64), tagLength: TAG_BITS },
    key,
    b64ToBuf(dataB64),
  );
  return 'data:' + mimeType + ';base64,' + bufToB64(plainBuf);
}

// ── File encryption (binary, memory-efficient) ────────────────────────────────

export async function encryptFileToBinary(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    arrayBuffer,
  );
  return { iv: bufToB64(iv), blob: new Blob([cipherBuf], { type: 'application/octet-stream' }) };
}

export async function decryptFileFromBinary(key, ivB64, cipherBuffer) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64), tagLength: TAG_BITS },
    key,
    cipherBuffer,
  );
}
