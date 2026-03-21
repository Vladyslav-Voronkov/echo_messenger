/**
 * apnService.js — Apple Push Notification Service (APNs) via HTTP/2 token-based auth
 *
 * Required env vars:
 *   APNS_KEY_PATH   — path to the .p8 key file (e.g. /data/AuthKey_XXXXXXXX.p8)
 *   APNS_KEY_ID     — 10-char key ID from Apple Developer portal
 *   APNS_TEAM_ID    — 10-char Team ID from Apple Developer portal
 *   APNS_BUNDLE_ID  — app bundle ID (com.echoapp.messenger)
 *   APNS_PRODUCTION — set to "true" for production, otherwise sandbox
 */

import apn from 'apn';
import fs from 'fs';

let provider = null;
const apnsTokens = new Map(); // nick → Set<deviceToken>

export function initApns() {
  const keyPath  = process.env.APNS_KEY_PATH;
  const keyId    = process.env.APNS_KEY_ID;
  const teamId   = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;

  if (!keyPath || !keyId || !teamId || !bundleId) {
    console.log('[apns] Missing env vars — APNs disabled. Set APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID');
    return;
  }

  if (!fs.existsSync(keyPath)) {
    console.warn('[apns] Key file not found at', keyPath);
    return;
  }

  const production = process.env.APNS_PRODUCTION === 'true';

  provider = new apn.Provider({
    token: {
      key:    keyPath,
      keyId,
      teamId,
    },
    production,
  });

  console.log(`[apns] Initialized (${production ? 'production' : 'sandbox'})`);
}

export function registerApnsToken(nick, token) {
  const key = nick.toLowerCase();
  if (!apnsTokens.has(key)) apnsTokens.set(key, new Set());
  apnsTokens.get(key).add(token);
  console.log(`[apns] Registered token for @${key} (total: ${apnsTokens.get(key).size})`);
}

export function removeApnsToken(nick, token) {
  const key = nick.toLowerCase();
  apnsTokens.get(key)?.delete(token);
}

export async function sendApnsPush(nick, title, body, data = {}) {
  if (!provider) return;
  const key    = nick.toLowerCase();
  const tokens = [...(apnsTokens.get(key) || [])];
  if (!tokens.length) return;

  const bundleId = process.env.APNS_BUNDLE_ID;
  const note = new apn.Notification();
  note.expiry    = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
  note.badge     = 1;
  note.sound     = 'default';
  note.alert     = { title, body };
  note.payload   = data;
  note.topic     = bundleId;

  try {
    const result = await provider.send(note, tokens);
    // Remove invalid tokens
    for (const fail of result.failed) {
      if (fail.response?.reason === 'BadDeviceToken' || fail.response?.reason === 'Unregistered') {
        removeApnsToken(nick, fail.device);
      }
    }
  } catch (err) {
    console.warn('[apns] Send error:', err?.message);
  }
}
