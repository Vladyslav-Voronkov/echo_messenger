import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import multer from 'multer';
import { initTelegram, forwardToTelegram } from './telegram.js';
import { initPush, getVapidPublicKey, addSubscription, removeSubscription, sendPush } from './pushService.js';
import { initDM, getDmId, createDM, acceptDM, declineDM, createRequest, getRequests, listDMs, listSentRequests, getConversation, appendDmMessage, readDmHistory } from './dmManager.js';
import { initGroups, loadGroup, saveGroup, createGroup, inviteToGroup, acceptGroupInvite, declineGroupInvite, listGroupsForNick, appendGroupMessage, readGroupHistory, isMember, isValidGroupId, getGroupFilePath } from './groupManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Data directories ──────────────────────────────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, '..');
const CHATS_DIR     = path.join(DATA_DIR, 'chats');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LIKES_FILE    = path.join(DATA_DIR, 'likes.json');
const PINS_FILE     = path.join(DATA_DIR, 'pins.json');
const FILES_DIR     = path.join(DATA_DIR, 'files');

await fs.mkdir(CHATS_DIR, { recursive: true });
await fs.mkdir(FILES_DIR, { recursive: true });

// ── Init sub-modules ──────────────────────────────────────────────────────────
await initPush(DATA_DIR);
await initDM(DATA_DIR);
await initGroups(DATA_DIR);

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Trust proxy (Cloudflare/Railway) for correct IP in rate limiter
app.set('trust proxy', 1);

// Security headers via helmet (CSP configured to allow SPA + WebSocket)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],  // Vite inlines bootstrap
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      mediaSrc:   ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.openai.com'],
      fontSrc:    ["'self'", 'data:'],
      workerSrc:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow SharedArrayBuffer if needed
}));

// CORS — allow same origin + dev
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-file-meta', 'x-nickname'],
}));
app.options('*', cors());

app.use(express.json({ limit: '64kb' }));

// ── Rate limiters ─────────────────────────────────────────────────────────────

const authRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Слишком много попыток регистрации. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Слишком много запросов.' },
});

// ── Validation helpers ────────────────────────────────────────────────────────

function isValidRoomId(id) {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
}

// DM ID and Group ID are also 64-hex strings
const isValidDmId    = isValidRoomId;
const isValidGrpId   = isValidRoomId;

// Context ID: any valid 64-hex (room, DM, or group)
const isValidCtxId   = isValidRoomId;

function isValidNick(n) {
  return typeof n === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(n.trim());
}

function isValidHash(h) {
  return typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
}

function isValidBase64(s, maxLen = 131072) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9+/=]+$/.test(s);
}

function isValidFileId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

// ── Accounts storage ──────────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    const raw = await fs.readFile(ACCOUNTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveAccounts(accounts) {
  const tmp = ACCOUNTS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(accounts, null, 2), 'utf8');
  await fs.rename(tmp, ACCOUNTS_FILE);
}

// ── In-memory state ───────────────────────────────────────────────────────────

// Tracks room members for online count (works for rooms, DMs, groups uniformly)
const roomMembers  = new Map(); // contextId → Map<encNick, Set<socketId>>
const socketMeta   = new Map(); // socketId → { roomId, encNick, active }
const readReceipts = new Map(); // contextId → Map<nick, upToTs>
const messageLikes = new Map(); // contextId → Map<msgTs, Set<nick>>
const roomPins     = new Map(); // contextId → Map<msgTs, { ts, pinnedAt }>

// Per-socket message rate limiter
const msgRateMap   = new Map(); // socketId → { count, resetAt }

function checkMsgRate(socketId) {
  const now = Date.now();
  let rate = msgRateMap.get(socketId);
  if (!rate || now > rate.resetAt) {
    rate = { count: 0, resetAt: now + 1000 };
    msgRateMap.set(socketId, rate);
  }
  rate.count++;
  return rate.count <= 20; // max 20 msg/sec per socket
}

await loadLikes();
await loadPins();

// ── Online count ──────────────────────────────────────────────────────────────
function getRoomCount(contextId) {
  const nicks = roomMembers.get(contextId);
  if (!nicks) return 0;
  let count = 0;
  for (const [_n, sockets] of nicks) { if (sockets.size > 0) count++; }
  return count;
}

// ── Likes storage ─────────────────────────────────────────────────────────────
async function loadLikes() {
  try {
    const raw = await fs.readFile(LIKES_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, msgs] of Object.entries(data)) {
      messageLikes.set(id, new Map());
      for (const [msgTs, nicks] of Object.entries(msgs)) {
        messageLikes.get(id).set(msgTs, new Set(nicks));
      }
    }
  } catch {}
}

async function saveLikes() {
  const data = {};
  for (const [id, msgs] of messageLikes) {
    data[id] = {};
    for (const [msgTs, nicks] of msgs) {
      if (nicks.size > 0) data[id][msgTs] = [...nicks];
    }
  }
  const tmp = LIKES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, LIKES_FILE);
}

// ── Pins storage ──────────────────────────────────────────────────────────────
async function loadPins() {
  try {
    const raw = await fs.readFile(PINS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, pins] of Object.entries(data)) {
      roomPins.set(id, new Map());
      for (const [msgTs, pinObj] of Object.entries(pins)) {
        roomPins.get(id).set(msgTs, pinObj);
      }
    }
  } catch {}
}

async function savePins() {
  const data = {};
  for (const [id, pins] of roomPins) {
    if (pins.size > 0) {
      data[id] = {};
      for (const [msgTs, pinObj] of pins) data[id][msgTs] = pinObj;
    }
  }
  const tmp = PINS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, PINS_FILE);
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// GET /auth/salt/:nickname — return authSalt for login (public endpoint)
app.get('/auth/salt/:nickname', apiLimiter, async (req, res) => {
  const nick = (req.params.nickname || '').trim().toLowerCase();
  if (!nick) return res.status(400).json({ error: 'Invalid nickname' });
  try {
    const accounts = await loadAccounts();
    const account = accounts[nick];
    if (!account) return res.status(404).json({ error: 'Аккаунт не найден' });
    // Return authSalt; for legacy accounts without authSalt, return a derived one
    return res.json({ authSalt: account.authSalt || null });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/register
app.post('/auth/register', authRegisterLimiter, async (req, res) => {
  const { nickname, passwordHash, authSalt, pubKey } = req.body || {};

  if (!isValidNick(nickname) || !isValidHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const nick = nickname.trim();
  const key  = nick.toLowerCase();

  try {
    const accounts = await loadAccounts();
    if (accounts[key]) return res.status(409).json({ error: 'Никнейм уже занят' });

    const accountData = {
      nickname: nick,
      passwordHash,
      authSalt: authSalt || null,  // base64 random 16 bytes, computed client-side
      pubKey:   pubKey  || null,   // ECDH P-256 public key (SPKI, base64)
      createdAt: Date.now(),
    };

    accounts[key] = accountData;
    await saveAccounts(accounts);
    return res.json({ ok: true, nickname: nick, createdAt: accountData.createdAt });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/login
app.post('/auth/login', authLoginLimiter, async (req, res) => {
  const { nickname, passwordHash } = req.body || {};

  if (!isValidNick(nickname) || !isValidHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const key = nickname.trim().toLowerCase();

  try {
    const accounts = await loadAccounts();
    const account = accounts[key];
    if (!account) return res.status(401).json({ error: 'Аккаунт не найден' });
    if (account.passwordHash !== passwordHash) return res.status(401).json({ error: 'Неверный пароль' });

    return res.json({
      ok: true,
      nickname:  account.nickname,
      createdAt: account.createdAt,
      authSalt:  account.authSalt || null,
      pubKey:    account.pubKey   || null,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/update-pubkey — update ECDH public key
app.post('/auth/update-pubkey', apiLimiter, async (req, res) => {
  const { nickname, passwordHash, pubKey } = req.body || {};
  if (!isValidNick(nickname) || !isValidHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  try {
    const accounts = await loadAccounts();
    const key = nickname.trim().toLowerCase();
    const account = accounts[key];
    if (!account || account.passwordHash !== passwordHash) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    account.pubKey = pubKey || null;
    await saveAccounts(accounts);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── User routes ───────────────────────────────────────────────────────────────

// GET /users/search?q=actavis&limit=10
app.get('/users/search', apiLimiter, async (req, res) => {
  const q     = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);

  if (q.length < 2) return res.json({ users: [] });

  try {
    const accounts = await loadAccounts();
    const results = [];
    for (const [key, acc] of Object.entries(accounts)) {
      if (key.startsWith(q) || acc.nickname.toLowerCase().startsWith(q)) {
        results.push({ nickname: acc.nickname, pubKey: acc.pubKey || null });
        if (results.length >= limit) break;
      }
    }
    return res.json({ users: results });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/pubkey/:nickname
app.get('/users/pubkey/:nickname', apiLimiter, async (req, res) => {
  const nick = (req.params.nickname || '').trim().toLowerCase();
  try {
    const accounts = await loadAccounts();
    const account = accounts[nick];
    if (!account) return res.status(404).json({ error: 'User not found' });
    return res.json({ nickname: account.nickname, pubKey: account.pubKey || null });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── DM routes ─────────────────────────────────────────────────────────────────

// POST /dm/request — create DM request (first message or just a request)
app.post('/dm/request', apiLimiter, async (req, res) => {
  const { fromNick, toNick } = req.body || {};
  if (!isValidNick(fromNick) || !isValidNick(toNick)) {
    return res.status(400).json({ error: 'Invalid nicknames' });
  }
  if (fromNick.toLowerCase() === toNick.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot DM yourself' });
  }
  try {
    const accounts = await loadAccounts();
    if (!accounts[toNick.toLowerCase()]) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const { dmId, isNew } = createDM(fromNick, toNick);
    if (isNew) {
      createRequest(fromNick, toNick, dmId);
      // Socket + Push notify recipient about new request
      io.to(`user:${toNick.toLowerCase()}`).emit('dm_request_notify', { dmId, fromNick });
      sendPush(toNick.toLowerCase(), {
        title: `Новый запрос от @${fromNick}`,
        body:  'Хочет написать вам сообщение',
        url:   '/',
        tag:   `dm-request-${dmId}`,
      }).catch(() => {});
    }
    return res.json({ ok: true, dmId });
  } catch (err) {
    console.error('DM request error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /dm/requests?nick=me
app.get('/dm/requests', apiLimiter, async (req, res) => {
  const nick = (req.query.nick || '').trim();
  if (!isValidNick(nick)) return res.status(400).json({ error: 'Invalid nick' });
  const reqs = getRequests(nick);
  // Enrich with sender info
  const accounts = await loadAccounts().catch(() => ({}));
  const enriched = reqs.map(r => ({
    ...r,
    fromNickDisplay: accounts[r.from]?.nickname || r.from,
    fromPubKey:      accounts[r.from]?.pubKey    || null,
  }));
  return res.json({ requests: enriched });
});

// POST /dm/accept
app.post('/dm/accept', apiLimiter, async (req, res) => {
  const { dmId, nick } = req.body || {};
  if (!isValidDmId(dmId) || !isValidNick(nick)) return res.status(400).json({ error: 'Invalid input' });
  const ok = acceptDM(dmId);
  if (!ok) return res.status(404).json({ error: 'Conversation not found' });
  // Notify the sender via socket if online
  io.to(dmId).emit('dm_accepted', { dmId });
  return res.json({ ok: true });
});

// POST /dm/decline
app.post('/dm/decline', apiLimiter, async (req, res) => {
  const { dmId, nick } = req.body || {};
  if (!isValidDmId(dmId) || !isValidNick(nick)) return res.status(400).json({ error: 'Invalid input' });
  declineDM(dmId);
  io.to(dmId).emit('dm_declined', { dmId });
  return res.json({ ok: true });
});

// GET /dm/list?nick=me
app.get('/dm/list', apiLimiter, async (req, res) => {
  const nick = (req.query.nick || '').trim();
  if (!isValidNick(nick)) return res.status(400).json({ error: 'Invalid nick' });
  const dms     = listDMs(nick);
  const pending = listSentRequests(nick);
  // Enrich with last message timestamp
  const enriched = await Promise.all(dms.map(async d => {
    const lines = await readDmHistory(d.dmId);
    let lastTs = null;
    if (lines.length) { try { lastTs = JSON.parse(lines[lines.length - 1]).ts; } catch {} }
    return { ...d, lastTs, msgCount: lines.length };
  }));
  return res.json({ dms: enriched, pending });
});

// GET /dm/history/:dmId
app.get('/dm/history/:dmId', apiLimiter, async (req, res) => {
  const { dmId } = req.params;
  if (!isValidDmId(dmId)) return res.status(400).json({ error: 'Invalid DM ID' });
  const lines = await readDmHistory(dmId);
  return res.json({ lines });
});

// ── Group routes ──────────────────────────────────────────────────────────────

// POST /groups/create
app.post('/groups/create', apiLimiter, async (req, res) => {
  const { groupId, name, createdBy, members } = req.body || {};
  if (!isValidGrpId(groupId) || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  if (!isValidNick(createdBy)) return res.status(400).json({ error: 'Invalid creator nick' });
  if (!members || typeof members !== 'object') return res.status(400).json({ error: 'Members required' });

  try {
    const existing = await loadGroup(groupId);
    if (existing) return res.status(409).json({ error: 'Group already exists' });
    const groupName = name.trim().slice(0, 64);
    const group = await createGroup({ groupId, name: groupName, createdBy, members });
    // Real-time notify each initial member (except creator) so they see the group immediately
    for (const [memberNick, memberData] of Object.entries(members)) {
      if (memberNick.toLowerCase() === createdBy.toLowerCase()) continue;
      if (!isValidNick(memberNick)) continue;
      io.to(`user:${memberNick.toLowerCase()}`).emit('group_invite_notify', {
        groupId,
        groupName,
        fromNick:         createdBy,
        encryptedGroupKey: memberData.encryptedGroupKey,
        encryptedBy:       createdBy.toLowerCase(),
        alreadyMember:     true,
      });
    }
    return res.json({ ok: true, group });
  } catch (err) {
    console.error('Group create error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /groups/invite
app.post('/groups/invite', apiLimiter, async (req, res) => {
  const { groupId, toNick, encryptedGroupKey, fromNick } = req.body || {};
  if (!isValidGrpId(groupId) || !isValidNick(toNick) || !isValidNick(fromNick)) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  try {
    const result = await inviteToGroup(groupId, toNick, encryptedGroupKey, fromNick);
    if (result.error) return res.status(400).json(result);
    // Push notify invitee
    const group = await loadGroup(groupId);
    sendPush(toNick.toLowerCase(), {
      title: `Приглашение в группу`,
      body:  `@${fromNick} приглашает вас в "${group?.name || 'группу'}"`,
      url:   '/',
      tag:   `group-invite-${groupId}`,
    }).catch(() => {});
    // Socket notify if online
    io.to(`user:${toNick.toLowerCase()}`).emit('group_invite_notify', {
      groupId,
      groupName:    group?.name || '',
      fromNick,
      encryptedGroupKey,
      encryptedBy:  fromNick.toLowerCase(),
      alreadyMember: false,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Group invite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /groups/accept
app.post('/groups/accept', apiLimiter, async (req, res) => {
  const { groupId, nick } = req.body || {};
  if (!isValidGrpId(groupId) || !isValidNick(nick)) return res.status(400).json({ error: 'Invalid input' });
  const result = await acceptGroupInvite(groupId, nick);
  if (result.error) return res.status(400).json(result);
  io.to(groupId).emit('group_member_update', { groupId, action: 'join', nick });
  return res.json({ ok: true });
});

// POST /groups/decline
app.post('/groups/decline', apiLimiter, async (req, res) => {
  const { groupId, nick } = req.body || {};
  if (!isValidGrpId(groupId) || !isValidNick(nick)) return res.status(400).json({ error: 'Invalid input' });
  const result = await declineGroupInvite(groupId, nick);
  return res.json(result);
});

// GET /groups/list?nick=me
app.get('/groups/list', apiLimiter, async (req, res) => {
  const nick = (req.query.nick || '').trim();
  if (!isValidNick(nick)) return res.status(400).json({ error: 'Invalid nick' });
  const groups = await listGroupsForNick(nick);
  // Enrich with last message timestamp
  const enriched = await Promise.all(groups.map(async g => {
    const lines = await readGroupHistory(g.groupId);
    let lastTs = null;
    if (lines.length) { try { lastTs = JSON.parse(lines[lines.length - 1]).ts; } catch {} }
    return { ...g, lastTs, msgCount: lines.length };
  }));
  return res.json({ groups: enriched });
});

// GET /groups/info/:groupId
app.get('/groups/info/:groupId', apiLimiter, async (req, res) => {
  const { groupId } = req.params;
  if (!isValidGrpId(groupId)) return res.status(400).end();
  const group = await loadGroup(groupId);
  if (!group) return res.status(404).json({ error: 'Not found' });
  return res.json(group);
});

// GET /groups/history/:groupId
app.get('/groups/history/:groupId', apiLimiter, async (req, res) => {
  const { groupId } = req.params;
  if (!isValidGrpId(groupId)) return res.status(400).end();
  const lines = await readGroupHistory(groupId);
  return res.json({ lines });
});

// ── Push routes ───────────────────────────────────────────────────────────────

app.get('/push/vapid-public-key', (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  return res.json({ publicKey: key });
});

app.post('/push/subscribe', apiLimiter, async (req, res) => {
  const { nick, subscription } = req.body || {};
  if (!isValidNick(nick) || !subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  await addSubscription(nick.toLowerCase(), subscription);
  return res.json({ ok: true });
});

app.post('/push/unsubscribe', apiLimiter, async (req, res) => {
  const { nick, endpoint } = req.body || {};
  if (!isValidNick(nick) || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  await removeSubscription(nick.toLowerCase(), endpoint);
  return res.json({ ok: true });
});

// ── Legacy chat history route ────────────────────────────────────────────────

app.get('/history/:roomId', apiLimiter, async (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'Invalid room ID' });
  const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    return res.json({ lines });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ lines: [] });
    return res.status(500).json({ error: 'Storage error' });
  }
});

// ── File upload / download ────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILES_DIR),
  filename:    (_req, _file, cb) => cb(null, randomBytes(16).toString('hex') + '.enc'),
});
const upload = multer({
  storage,
  limits: { fileSize: 1.1 * 1024 * 1024 * 1024 },
});

// POST /upload/:contextId — contextId can be roomId, dmId, or groupId (all are 64-hex)
app.post('/upload/:contextId', upload.single('file'), async (req, res) => {
  const { contextId } = req.params;
  if (!isValidCtxId(contextId)) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid context ID' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file' });

  let meta;
  try {
    meta = JSON.parse(req.headers['x-file-meta'] || '{}');
  } catch {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid meta' });
  }

  const { iv, nick, name, mime, size, ts } = meta;
  if (!iv || !nick || !name) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Missing meta fields' });
  }

  const fileId = path.basename(req.file.filename, '.enc');
  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  await fs.writeFile(metaPath, JSON.stringify({ iv, nick, name, mime, size, ts, contextId }), 'utf8');

  return res.json({ ok: true, fileId });
});

// GET /files/:contextId/:fileId
app.get('/files/:contextId/:fileId', async (req, res) => {
  const { contextId, fileId } = req.params;
  if (!isValidCtxId(contextId) || !isValidFileId(fileId)) return res.status(400).end();

  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  let meta;
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); }
  catch { return res.status(404).end(); }

  // Support both old (roomId) and new (contextId) field names
  const storedCtx = meta.contextId || meta.roomId;
  if (storedCtx !== contextId) return res.status(403).end();

  const filePath = path.join(FILES_DIR, fileId + '.enc');
  try {
    const stat = await fs.stat(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(filePath).pipe(res);
  } catch { res.status(404).end(); }
});

// GET /files/:contextId/:fileId/meta
app.get('/files/:contextId/:fileId/meta', async (req, res) => {
  const { contextId, fileId } = req.params;
  if (!isValidCtxId(contextId) || !isValidFileId(fileId)) return res.status(400).end();

  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const storedCtx = meta.contextId || meta.roomId;
    if (storedCtx !== contextId) return res.status(403).end();
    return res.json(meta);
  } catch { return res.status(404).end(); }
});

// ── Static client (production) ────────────────────────────────────────────────
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

app.use(express.static(CLIENT_DIST, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    // Service worker must have correct scope
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
    }
  },
}));

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
});

// ── Telegram bridge helpers ───────────────────────────────────────────────────

async function appendToRoom(roomId, storedMsg) {
  const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
  await fs.appendFile(filePath, JSON.stringify(storedMsg) + '\n', 'utf8');
}

function broadcastToRoom(roomId, storedMsg) {
  io.to(roomId).emit('message', { encrypted: storedMsg });
}

await initTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  dataDir: DATA_DIR,
  appendToRoom,
  broadcastToRoom,
});

// ── Room member helpers ───────────────────────────────────────────────────────

function addMember(contextId, encNick, socketId) {
  if (!roomMembers.has(contextId)) roomMembers.set(contextId, new Map());
  const nicks = roomMembers.get(contextId);
  if (!nicks.has(encNick)) nicks.set(encNick, new Set());
  nicks.get(encNick).add(socketId);
}

function removeMember(contextId, encNick, socketId) {
  const nicks = roomMembers.get(contextId);
  if (!nicks) return;
  const sockets = nicks.get(encNick);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) nicks.delete(encNick);
  }
  if (nicks.size === 0) roomMembers.delete(contextId);
}

function isLastSocket(contextId, encNick, socketId) {
  const sockets = roomMembers.get(contextId)?.get(encNick);
  if (!sockets) return true;
  return sockets.size === 0 || (sockets.size === 1 && sockets.has(socketId));
}

// Helper: validate encrypted message fields + security limits
function validateEncrypted(encrypted) {
  if (!encrypted) return false;
  if (typeof encrypted.iv   !== 'string' || !isValidBase64(encrypted.iv,   32))   return false;
  if (typeof encrypted.data !== 'string' || !isValidBase64(encrypted.data, 131072)) return false;
  // Nick format: "base64_iv.base64_ciphertext" (dot-separated, produced by encryptNick)
  if (typeof encrypted.nick !== 'string') return false;
  const nickParts = encrypted.nick.split('.');
  if (nickParts.length !== 2 || !isValidBase64(nickParts[0], 32) || !isValidBase64(nickParts[1], 512)) return false;
  if (typeof encrypted.ts   !== 'number') return false;
  // Timestamp must be within ±2 minutes of server time
  if (Math.abs(encrypted.ts - Date.now()) > 120_000) return false;
  return true;
}

// ── Socket handlers ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentContext = null;
  let currentNick    = null;
  const userNick     = socket.handshake.query?.nick || null; // plaintext nick for user room

  // Join a personal "user room" for receiving invites/requests while not in a chat
  if (userNick && isValidNick(userNick)) {
    socket.join(`user:${userNick.toLowerCase()}`);
  }

  // ── Legacy room join ────────────────────────────────────────────────────────
  socket.on('join', async ({ roomId, nick }) => {
    if (!isValidRoomId(roomId)) { socket.emit('error', { message: 'Invalid room ID' }); return; }

    currentContext = roomId;
    currentNick    = nick || null;
    socket.join(roomId);
    if (currentNick) addMember(roomId, currentNick, socket.id);
    socketMeta.set(socket.id, { roomId, encNick: currentNick, active: true });

    io.to(roomId).emit('online_count', { count: getRoomCount(roomId) });

    const pins = [...(roomPins.get(roomId)?.values() ?? [])].sort((a, b) => a.ts - b.ts);
    if (pins.length > 0) socket.emit('pins_updated', { pins });

    const roomLikesMap = messageLikes.get(roomId);
    if (roomLikesMap?.size > 0) {
      const snap = {};
      for (const [ts, nicks] of roomLikesMap) { if (nicks.size > 0) snap[ts] = [...nicks]; }
      if (Object.keys(snap).length > 0) socket.emit('likes_snapshot', { likes: snap });
    }

    // Notify pending DM requests for this user
    if (userNick) {
      const reqs = getRequests(userNick);
      if (reqs.length > 0) socket.emit('dm_requests_pending', { requests: reqs });
    }
  });

  // ── Legacy message ──────────────────────────────────────────────────────────
  socket.on('message', async ({ roomId, encrypted }) => {
    if (!isValidRoomId(roomId)) return;
    if (!checkMsgRate(socket.id)) { socket.emit('error', { message: 'Rate limit' }); return; }
    if (!validateEncrypted(encrypted)) { socket.emit('error', { message: 'Malformed message' }); return; }

    const line = JSON.stringify({ iv: encrypted.iv, data: encrypted.data, ts: encrypted.ts, nick: encrypted.nick });
    const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
    try {
      await fs.appendFile(filePath, line + '\n', 'utf8');
    } catch {
      socket.emit('error', { message: 'Storage write failed' });
      return;
    }
    io.to(roomId).emit('message', { encrypted });
    forwardToTelegram(roomId, encrypted).catch(() => {});
  });

  // ── DM join ─────────────────────────────────────────────────────────────────
  socket.on('dm_join', async ({ dmId, encNick }) => {
    if (!isValidDmId(dmId)) { socket.emit('error', { message: 'Invalid DM ID' }); return; }
    socket.join(dmId);
    if (encNick) addMember(dmId, encNick, socket.id);

    // Send pending DM requests when user connects
    if (userNick) {
      const reqs = getRequests(userNick);
      if (reqs.length > 0) socket.emit('dm_requests_pending', { requests: reqs });
    }
  });

  // ── DM message ──────────────────────────────────────────────────────────────
  socket.on('dm_message', async ({ dmId, encrypted, fromNick }) => {
    if (!isValidDmId(dmId)) return;
    if (!checkMsgRate(socket.id)) { socket.emit('error', { message: 'Rate limit' }); return; }
    if (!validateEncrypted(encrypted)) { socket.emit('error', { message: 'Malformed message' }); return; }

    const conv = getConversation(dmId);
    if (!conv) { socket.emit('error', { message: 'Conversation not found' }); return; }

    const line = JSON.stringify({ iv: encrypted.iv, data: encrypted.data, ts: encrypted.ts, nick: encrypted.nick });
    await appendDmMessage(dmId, line);
    io.to(dmId).emit('dm_message', { dmId, encrypted });

    // Push to recipient if not online in this DM
    if (fromNick && isValidNick(fromNick)) {
      const otherNick = conv.participants.find(p => p !== fromNick.toLowerCase());
      if (otherNick) {
        const dmRoom = io.sockets.adapter.rooms.get(dmId);
        const recipientOnline = dmRoom && dmRoom.size > 1;
        if (!recipientOnline) {
          sendPush(otherNick, {
            title: `@${fromNick}`,
            body:  'Новое личное сообщение',
            url:   '/',
            tag:   `dm-${dmId}`,
          }).catch(() => {});
        }
      }
    }
  });

  // ── DM typing ───────────────────────────────────────────────────────────────
  socket.on('dm_typing', ({ dmId, nick }) => {
    if (!isValidDmId(dmId)) return;
    socket.to(dmId).emit('dm_typing', { dmId, nick });
  });
  socket.on('dm_stop_typing', ({ dmId, nick }) => {
    if (!isValidDmId(dmId)) return;
    socket.to(dmId).emit('dm_stop_typing', { dmId, nick });
  });

  // ── Group join ──────────────────────────────────────────────────────────────
  socket.on('group_join', async ({ groupId, encNick }) => {
    if (!isValidGrpId(groupId)) { socket.emit('error', { message: 'Invalid group ID' }); return; }
    socket.join(groupId);
    if (encNick) addMember(groupId, encNick, socket.id);
    io.to(groupId).emit('online_count', { count: getRoomCount(groupId) });

    // Send pins for group
    const pins = [...(roomPins.get(groupId)?.values() ?? [])].sort((a, b) => a.ts - b.ts);
    if (pins.length > 0) socket.emit('pins_updated', { pins });
  });

  // ── Group message ────────────────────────────────────────────────────────────
  socket.on('group_message', async ({ groupId, encrypted, fromNick }) => {
    if (!isValidGrpId(groupId)) return;
    if (!checkMsgRate(socket.id)) { socket.emit('error', { message: 'Rate limit' }); return; }
    if (!validateEncrypted(encrypted)) { socket.emit('error', { message: 'Malformed message' }); return; }

    const line = JSON.stringify({ iv: encrypted.iv, data: encrypted.data, ts: encrypted.ts, nick: encrypted.nick });
    await appendGroupMessage(groupId, line);
    io.to(groupId).emit('group_message', { groupId, encrypted });

    // Push to offline members
    const group = await loadGroup(groupId);
    if (group && fromNick && isValidNick(fromNick)) {
      const grpRoom      = io.sockets.adapter.rooms.get(groupId);
      const onlineCount  = grpRoom?.size || 0;
      const totalMembers = Object.keys(group.members).length;
      if (onlineCount < totalMembers) {
        // Push to members who are not in the group room
        for (const memberNick of Object.keys(group.members)) {
          if (memberNick === fromNick.toLowerCase()) continue;
          sendPush(memberNick, {
            title: group.name || 'Группа',
            body:  `@${fromNick}: новое сообщение`,
            url:   '/',
            tag:   `group-${groupId}`,
          }).catch(() => {});
        }
      }
    }
  });

  // ── Group typing ─────────────────────────────────────────────────────────────
  socket.on('group_typing', ({ groupId, nick }) => {
    if (!isValidGrpId(groupId)) return;
    socket.to(groupId).emit('group_typing', { groupId, nick });
  });
  socket.on('group_stop_typing', ({ groupId, nick }) => {
    if (!isValidGrpId(groupId)) return;
    socket.to(groupId).emit('group_stop_typing', { groupId, nick });
  });

  // ── Shared events (work for room/dm/group via contextId) ───────────────────

  socket.on('typing', ({ roomId, nick }) => {
    if (!isValidRoomId(roomId) || typeof nick !== 'string') return;
    socket.to(roomId).emit('typing', { nick });
  });
  socket.on('stop_typing', ({ roomId, nick }) => {
    if (!isValidRoomId(roomId) || typeof nick !== 'string') return;
    socket.to(roomId).emit('stop_typing', { nick });
  });

  socket.on('read', ({ roomId, nick, upToTs }) => {
    if (!isValidCtxId(roomId) || typeof nick !== 'string' || typeof upToTs !== 'number') return;
    if (!readReceipts.has(roomId)) readReceipts.set(roomId, new Map());
    readReceipts.get(roomId).set(nick, upToTs);
    io.to(roomId).emit('read_by', { nick, upToTs });
  });

  socket.on('like', ({ roomId, msgTs, nick }) => {
    if (!isValidCtxId(roomId) || !isValidNick(nick) || typeof msgTs !== 'number') return;
    if (!messageLikes.has(roomId)) messageLikes.set(roomId, new Map());
    const roomLikes = messageLikes.get(roomId);
    const key = String(msgTs);
    if (!roomLikes.has(key)) roomLikes.set(key, new Set());
    roomLikes.get(key).add(nick.trim());
    io.to(roomId).emit('liked', { msgTs, nicks: [...roomLikes.get(key)] });
    saveLikes().catch(() => {});
  });

  socket.on('unlike', ({ roomId, msgTs, nick }) => {
    if (!isValidCtxId(roomId) || !isValidNick(nick) || typeof msgTs !== 'number') return;
    const roomLikes = messageLikes.get(roomId);
    if (!roomLikes) return;
    roomLikes.get(String(msgTs))?.delete(nick.trim());
    io.to(roomId).emit('liked', { msgTs, nicks: [...(roomLikes.get(String(msgTs)) ?? [])] });
    saveLikes().catch(() => {});
  });

  socket.on('pin', async ({ roomId, msgTs, nick }) => {
    if (!isValidCtxId(roomId) || typeof msgTs !== 'number') return;
    if (!roomPins.has(roomId)) roomPins.set(roomId, new Map());
    roomPins.get(roomId).set(String(msgTs), { ts: msgTs, pinnedAt: Date.now() });
    const pins = [...roomPins.get(roomId).values()].sort((a, b) => a.ts - b.ts);
    io.to(roomId).emit('pins_updated', { pins, action: 'pin', byNick: nick || null });
    savePins().catch(() => {});
    if (nick) {
      const pinEvent = { type: 'system', subtype: 'pin', nick, msgTs, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(pinEvent) + '\n', 'utf8').catch(() => {});
    }
  });

  socket.on('unpin', async ({ roomId, msgTs, nick }) => {
    if (!isValidCtxId(roomId) || typeof msgTs !== 'number') return;
    roomPins.get(roomId)?.delete(String(msgTs));
    const pins = [...(roomPins.get(roomId)?.values() ?? [])].sort((a, b) => a.ts - b.ts);
    io.to(roomId).emit('pins_updated', { pins, action: 'unpin', byNick: nick || null });
    savePins().catch(() => {});
    if (nick) {
      const unpinEvent = { type: 'system', subtype: 'unpin', nick, msgTs, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(unpinEvent) + '\n', 'utf8').catch(() => {});
    }
  });

  socket.on('ping_check', (_data, callback) => {
    if (typeof callback === 'function') callback();
  });

  socket.on('set_active', ({ active }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    meta.active = !!active;
  });

  // ── AI Query ─────────────────────────────────────────────────────────────────
  socket.on('ai_query', async ({ queryId, text, context }) => {
    if (!queryId || typeof text !== 'string' || !text.trim()) return;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      socket.emit('ai_response', { queryId, text: 'OPENAI_API_KEY не задан на сервере.', done: true, error: true });
      return;
    }

    const messages = (Array.isArray(context) && context.length > 0)
      ? context
      : [
          { role: 'system', content: 'You are ChatGPT in a secure encrypted messenger. Be helpful and concise.' },
          { role: 'user',   content: text.trim() },
        ];

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 1500 }),
      });

      if (!response.ok) {
        socket.emit('ai_response', { queryId, text: 'Ошибка ChatGPT (' + response.status + ').', done: true, error: true });
        return;
      }
      const data = await response.json();
      socket.emit('ai_response', { queryId, text: data.choices?.[0]?.message?.content || 'Нет ответа.', done: true });
    } catch {
      socket.emit('ai_response', { queryId, text: 'Ошибка соединения с ChatGPT.', done: true, error: true });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    msgRateMap.delete(socket.id);
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);

    const contextId = currentContext || meta?.roomId;
    const encNick   = currentNick    || meta?.encNick;

    if (!contextId) return;
    if (encNick) removeMember(contextId, encNick, socket.id);

    io.to(contextId).emit('online_count', { count: getRoomCount(contextId) });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Echo Messenger server running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Push VAPID public key: ${getVapidPublicKey()?.slice(0, 20)}...`);
});
