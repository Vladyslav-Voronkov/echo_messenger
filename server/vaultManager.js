import fs from 'fs/promises';
import path from 'path';

let VAULT_DIR;
let META_FILE;

export async function initVault(dataDir) {
  VAULT_DIR = path.join(dataDir, 'vault');
  META_FILE = path.join(VAULT_DIR, '_meta');
  await fs.mkdir(VAULT_DIR, { recursive: true });
}

// Returns opaque encrypted metadata string (encrypted by client)
export async function getVaultMeta() {
  try {
    return await fs.readFile(META_FILE, 'utf8');
  } catch {
    return null;
  }
}

// Saves opaque encrypted metadata string (already encrypted by client)
export async function saveVaultMeta(encryptedBlob) {
  await fs.writeFile(META_FILE, encryptedBlob, 'utf8');
}

export function getVaultDir() {
  return VAULT_DIR;
}

export function getVaultFilePath(fileId) {
  // Sanitize: only alphanumeric + dashes
  const safe = fileId.replace(/[^a-zA-Z0-9\-]/g, '');
  return path.join(VAULT_DIR, safe);
}

export async function deleteVaultFile(fileId) {
  const filePath = getVaultFilePath(fileId);
  await fs.unlink(filePath);
}
