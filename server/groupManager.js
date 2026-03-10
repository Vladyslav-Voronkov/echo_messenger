/**
 * groupManager.js — Group chat storage
 *
 * Groups use invite-only access. The group AES-256 key is generated client-side
 * and encrypted for each member via ECDH shared secret — server never sees plaintext key.
 *
 * Storage:
 *   groups/<groupId>.json  — metadata (name, members + their encryptedGroupKey, pending invites)
 *   groups/<groupId>.txt   — messages (JSON lines, same format as rooms)
 */

import fs from 'fs/promises';
import path from 'path';

let GROUPS_DIR = null;

export async function initGroups(dataDir) {
  GROUPS_DIR = path.join(dataDir, 'groups');
  await fs.mkdir(GROUPS_DIR, { recursive: true });
  console.log(`[groups] Storage at ${GROUPS_DIR}`);
}

/** Load group metadata */
export async function loadGroup(groupId) {
  try {
    const raw = await fs.readFile(path.join(GROUPS_DIR, `${groupId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Save group metadata (atomic write) */
export async function saveGroup(groupId, data) {
  const filePath = path.join(GROUPS_DIR, `${groupId}.json`);
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

/** Create a new group */
export async function createGroup({ groupId, name, createdBy, members }) {
  // members: { nick: encryptedGroupKey, ... }
  const membersObj = {};
  for (const [nick, encryptedGroupKey] of Object.entries(members)) {
    membersObj[nick.toLowerCase()] = { encryptedGroupKey, joinedAt: Date.now(), encryptedBy: createdBy.toLowerCase() };
  }
  const data = {
    groupId,
    name,
    createdBy: createdBy.toLowerCase(),
    createdAt: Date.now(),
    members: membersObj,
    pending: {},
  };
  await saveGroup(groupId, data);
  return data;
}

/** Invite a user to a group — store encryptedGroupKey in pending */
export async function inviteToGroup(groupId, toNick, encryptedGroupKey, fromNick) {
  const data = await loadGroup(groupId);
  if (!data) return { error: 'Group not found' };
  const n = toNick.toLowerCase();
  if (data.members[n]) return { error: 'Already a member' };
  data.pending[n] = {
    encryptedGroupKey,
    invitedBy: fromNick.toLowerCase(),
    invitedAt: Date.now(),
  };
  await saveGroup(groupId, data);
  return { ok: true };
}

/** Accept a group invite — move from pending to members */
export async function acceptGroupInvite(groupId, nick) {
  const data = await loadGroup(groupId);
  if (!data) return { error: 'Group not found' };
  const n = nick.toLowerCase();
  const pending = data.pending[n];
  if (!pending) return { error: 'No invite found' };
  data.members[n] = { encryptedGroupKey: pending.encryptedGroupKey, joinedAt: Date.now(), encryptedBy: pending.invitedBy };
  delete data.pending[n];
  await saveGroup(groupId, data);
  return { ok: true, group: data };
}

/** Decline (remove) a group invite */
export async function declineGroupInvite(groupId, nick) {
  const data = await loadGroup(groupId);
  if (!data) return { error: 'Group not found' };
  delete data.pending[nick.toLowerCase()];
  await saveGroup(groupId, data);
  return { ok: true };
}

/** List groups for a nickname (as member or pending) */
export async function listGroupsForNick(nick) {
  const n = nick.toLowerCase();
  const result = [];
  try {
    const files = await fs.readdir(GROUPS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(GROUPS_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        if (data.members[n] || data.pending[n]) {
          result.push({
            groupId: data.groupId,
            name: data.name,
            createdBy: data.createdBy,
            createdAt: data.createdAt,
            memberCount: Object.keys(data.members).length,
            encryptedGroupKey: data.members[n]?.encryptedGroupKey || data.pending[n]?.encryptedGroupKey || null,
            encryptedBy: data.members[n]?.encryptedBy || data.pending[n]?.invitedBy || data.createdBy || null,
            isPending: !!data.pending[n],
            invitedBy: data.pending[n]?.invitedBy || null,
          });
        }
      } catch {}
    }
  } catch {}
  return result;
}

/** Get messages file path */
export function getGroupFilePath(groupId) {
  return path.join(GROUPS_DIR, `${groupId}.txt`);
}

/** Append a message to group chat */
export async function appendGroupMessage(groupId, msgLine) {
  await fs.appendFile(getGroupFilePath(groupId), msgLine + '\n', 'utf8');
}

/** Read group history */
export async function readGroupHistory(groupId) {
  try {
    const content = await fs.readFile(getGroupFilePath(groupId), 'utf8');
    return content.split('\n').filter(l => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** Check if nick is a member */
export async function isMember(groupId, nick) {
  const data = await loadGroup(groupId);
  return data ? !!data.members[nick.toLowerCase()] : false;
}

/** Validate group ID format: 64 hex chars */
export function isValidGroupId(id) {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
}
