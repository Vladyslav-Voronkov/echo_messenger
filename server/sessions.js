import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

let SESSIONS_FILE;
let sessions = {}; // token -> { nick, expiresAt }

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function initSessions(dataDir) {
  SESSIONS_FILE = path.join(dataDir, 'sessions.json');
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    sessions = JSON.parse(raw);
    // Clean expired
    const now = Date.now();
    let changed = false;
    for (const [token, sess] of Object.entries(sessions)) {
      if (sess.expiresAt < now) { delete sessions[token]; changed = true; }
    }
    if (changed) await _save();
  } catch {
    sessions = {};
  }
}

async function _save() {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), 'utf8');
}

export async function createSession(nick) {
  const token = randomBytes(32).toString('hex');
  sessions[token] = { nick: nick.toLowerCase(), expiresAt: Date.now() + SESSION_TTL };
  await _save();
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const sess = sessions[token];
  if (!sess || sess.expiresAt < Date.now()) return null;
  return sess;
}

export async function deleteSession(token) {
  delete sessions[token];
  await _save();
}
