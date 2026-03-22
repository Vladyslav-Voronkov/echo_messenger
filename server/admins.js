import fs from 'fs/promises';
import path from 'path';

let ADMINS_FILE;
let data = { superAdmin: 'actavis', admins: [] };

export async function initAdmins(dataDir) {
  ADMINS_FILE = path.join(dataDir, 'admins.json');
  try {
    const raw = await fs.readFile(ADMINS_FILE, 'utf8');
    data = { superAdmin: 'actavis', admins: [], ...JSON.parse(raw) };
  } catch {
    await _save();
  }
}

async function _save() {
  await fs.writeFile(ADMINS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function isSuperAdmin(nick) {
  return nick.toLowerCase() === data.superAdmin.toLowerCase();
}

export function isAdmin(nick) {
  const key = nick.toLowerCase();
  return key === data.superAdmin.toLowerCase() ||
    data.admins.map(n => n.toLowerCase()).includes(key);
}

export function getAdminInfo() {
  return { superAdmin: data.superAdmin, admins: [...data.admins] };
}

export async function grantAdmin(nick) {
  const key = nick.toLowerCase();
  if (!data.admins.map(n => n.toLowerCase()).includes(key)) {
    data.admins.push(nick);
    await _save();
  }
}

export async function revokeAdmin(nick) {
  const key = nick.toLowerCase();
  data.admins = data.admins.filter(n => n.toLowerCase() !== key);
  await _save();
}
