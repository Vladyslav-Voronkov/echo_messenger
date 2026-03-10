/**
 * pushService.js — Web Push (VAPID) helper
 *
 * Manages VAPID keys, push subscriptions, and sending notifications.
 * Keys are generated once and stored in vapid_keys.json.
 * Subscriptions are stored in push_subscriptions.json per nickname.
 */

import webpush from 'web-push';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DATA_DIR = null;
let VAPID_FILE = null;
let SUBS_FILE = null;

// In-memory subscriptions: Map<nickname, Set<subscriptionJSON>>
const subscriptions = new Map();

/**
 * Initialize push service.
 * @param {string} dataDir — root data directory
 */
export async function initPush(dataDir) {
  DATA_DIR = dataDir;
  VAPID_FILE = path.join(dataDir, 'vapid_keys.json');
  SUBS_FILE  = path.join(dataDir, 'push_subscriptions.json');

  // Load or generate VAPID keys
  let vapid;
  try {
    const raw = await fs.readFile(VAPID_FILE, 'utf8');
    vapid = JSON.parse(raw);
  } catch {
    vapid = webpush.generateVAPIDKeys();
    await fs.writeFile(VAPID_FILE, JSON.stringify(vapid, null, 2), 'utf8');
    console.log('[push] Generated new VAPID keys');
  }

  webpush.setVapidDetails(
    'mailto:admin@echo-messenger.local',
    vapid.publicKey,
    vapid.privateKey,
  );

  // Store public key for client access
  initPush._publicKey = vapid.publicKey;

  // Load persisted subscriptions
  try {
    const raw = await fs.readFile(SUBS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [nick, subs] of Object.entries(data)) {
      subscriptions.set(nick, new Set(subs));
    }
    console.log(`[push] Loaded subscriptions for ${subscriptions.size} users`);
  } catch { /* first start — no file */ }
}

/**
 * Returns the VAPID public key (for client subscription).
 */
export function getVapidPublicKey() {
  return initPush._publicKey || null;
}

/**
 * Add (or update) a push subscription for a nickname.
 */
export async function addSubscription(nickname, subscription) {
  if (!subscriptions.has(nickname)) subscriptions.set(nickname, new Set());
  const subs = subscriptions.get(nickname);

  // Remove any existing sub with same endpoint (re-subscribe)
  for (const s of subs) {
    try {
      const parsed = JSON.parse(s);
      if (parsed.endpoint === subscription.endpoint) {
        subs.delete(s);
        break;
      }
    } catch {}
  }
  subs.add(JSON.stringify(subscription));
  await saveSubs();
}

/**
 * Remove a push subscription by endpoint.
 */
export async function removeSubscription(nickname, endpoint) {
  const subs = subscriptions.get(nickname);
  if (!subs) return;
  for (const s of subs) {
    try {
      if (JSON.parse(s).endpoint === endpoint) {
        subs.delete(s);
        break;
      }
    } catch {}
  }
  if (subs.size === 0) subscriptions.delete(nickname);
  await saveSubs();
}

/**
 * Send a push notification to all devices of a nickname.
 * @param {string} nickname
 * @param {{ title: string, body: string, url?: string, tag?: string }} payload
 */
export async function sendPush(nickname, payload) {
  const subs = subscriptions.get(nickname);
  if (!subs || subs.size === 0) return;

  const deadEndpoints = [];
  const pushPayload = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    url:   payload.url  || '/',
    tag:   payload.tag  || 'echo-msg',
    icon:  '/favicon.svg',
  });

  for (const subStr of subs) {
    let sub;
    try { sub = JSON.parse(subStr); } catch { continue; }

    try {
      await webpush.sendNotification(sub, pushPayload, {
        TTL: 86400, // 24 hours — deliver even if device is offline
      });
    } catch (err) {
      // 410 Gone / 404 = subscription expired, clean it up
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadEndpoints.push(sub.endpoint);
      } else {
        console.warn(`[push] Failed to send to ${nickname}:`, err.message);
      }
    }
  }

  // Clean dead subscriptions
  if (deadEndpoints.length > 0) {
    for (const ep of deadEndpoints) {
      await removeSubscription(nickname, ep).catch(() => {});
    }
  }
}

async function saveSubs() {
  if (!SUBS_FILE) return;
  const data = {};
  for (const [nick, subs] of subscriptions) {
    if (subs.size > 0) data[nick] = [...subs];
  }
  const tmp = SUBS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, SUBS_FILE);
}
