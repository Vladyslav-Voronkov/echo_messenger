/**
 * dmManager.js — Direct Message storage
 *
 * Conversations identified by SHA-256(sorted(nickA, nickB)).
 * Messages stored as JSON lines in dms/<dmId>.txt (same format as rooms).
 * Metadata in dm_conversations.json.
 * Pending requests in dm_requests.json.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

let DATA_DIR  = null;
let DMS_DIR   = null;
let CONVS_FILE = null;
let REQS_FILE  = null;

// In-memory
const conversations = new Map(); // dmId → { participants, createdAt, accepted }
const requests      = new Map(); // "<from>-><to>" → { dmId, from, to, createdAt }

export async function initDM(dataDir) {
  DATA_DIR   = dataDir;
  DMS_DIR    = path.join(dataDir, 'dms');
  CONVS_FILE = path.join(dataDir, 'dm_conversations.json');
  REQS_FILE  = path.join(dataDir, 'dm_requests.json');

  await fs.mkdir(DMS_DIR, { recursive: true });

  // Load conversations
  try {
    const raw = await fs.readFile(CONVS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, conv] of Object.entries(data)) conversations.set(id, conv);
  } catch {}

  // Load requests
  try {
    const raw = await fs.readFile(REQS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [key, req] of Object.entries(data)) requests.set(key, req);
  } catch {}

  console.log(`[dm] ${conversations.size} conversations, ${requests.size} pending requests`);
}

/** Deterministic DM ID: SHA-256 of sorted pair */
export function getDmId(nickA, nickB) {
  const sorted = [nickA.toLowerCase(), nickB.toLowerCase()].sort().join(':');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

/** Create a new DM conversation (or get existing). Returns { dmId, isNew } */
export function createDM(fromNick, toNick) {
  const dmId = getDmId(fromNick, toNick);
  if (conversations.has(dmId)) return { dmId, isNew: false };
  const conv = { participants: [fromNick.toLowerCase(), toNick.toLowerCase()], createdAt: Date.now(), accepted: false };
  conversations.set(dmId, conv);
  saveConvs().catch(() => {});
  return { dmId, isNew: true };
}

/** Accept a DM conversation */
export function acceptDM(dmId) {
  const conv = conversations.get(dmId);
  if (!conv) return false;
  conv.accepted = true;
  saveConvs().catch(() => {});
  // Remove the request entry
  for (const [key, req] of requests) {
    if (req.dmId === dmId) { requests.delete(key); break; }
  }
  saveReqs().catch(() => {});
  return true;
}

/** Decline (delete) a DM request */
export function declineDM(dmId) {
  for (const [key, req] of requests) {
    if (req.dmId === dmId) { requests.delete(key); break; }
  }
  conversations.delete(dmId);
  saveConvs().catch(() => {});
  saveReqs().catch(() => {});
}

/** Create a pending DM request */
export function createRequest(fromNick, toNick, dmId) {
  const key = `${fromNick.toLowerCase()}->${toNick.toLowerCase()}`;
  requests.set(key, { dmId, from: fromNick.toLowerCase(), to: toNick.toLowerCase(), createdAt: Date.now() });
  saveReqs().catch(() => {});
}

/** Get all pending requests where toNick is the recipient */
export function getRequests(toNick) {
  const result = [];
  for (const req of requests.values()) {
    if (req.to === toNick.toLowerCase()) result.push(req);
  }
  return result;
}

/** List all accepted DM conversations for a nickname */
export function listDMs(nick) {
  const result = [];
  const n = nick.toLowerCase();
  for (const [dmId, conv] of conversations) {
    if (conv.participants.includes(n) && conv.accepted) {
      const other = conv.participants.find(p => p !== n) || '';
      result.push({ dmId, other, createdAt: conv.createdAt });
    }
  }
  return result;
}

/** List all pending requests sent BY a nick (so they show as pending on their side) */
export function listSentRequests(nick) {
  const result = [];
  const n = nick.toLowerCase();
  for (const [dmId, conv] of conversations) {
    if (!conv.accepted && conv.participants.includes(n)) {
      // Check if there's a request from this nick
      for (const req of requests.values()) {
        if (req.dmId === dmId && req.from === n) {
          const other = conv.participants.find(p => p !== n) || '';
          result.push({ dmId, other, createdAt: conv.createdAt, pending: true });
        }
      }
    }
  }
  return result;
}

/** Get conversation info */
export function getConversation(dmId) {
  return conversations.get(dmId) || null;
}

/** Get the DM messages file path */
export function getDmFilePath(dmId) {
  return path.join(DMS_DIR, `${dmId}.txt`);
}

/** Append a message to a DM chat file */
export async function appendDmMessage(dmId, msgLine) {
  const filePath = getDmFilePath(dmId);
  await fs.appendFile(filePath, msgLine + '\n', 'utf8');
}

/** Read DM history */
export async function readDmHistory(dmId) {
  try {
    const content = await fs.readFile(getDmFilePath(dmId), 'utf8');
    return content.split('\n').filter(l => l.trim().length > 0);
  } catch {
    return [];
  }
}

async function saveConvs() {
  const data = Object.fromEntries(conversations);
  const tmp = CONVS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, CONVS_FILE);
}

async function saveReqs() {
  const data = Object.fromEntries(requests);
  const tmp = REQS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, REQS_FILE);
}
