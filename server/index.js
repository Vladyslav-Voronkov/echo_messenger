import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR: on Railway use the mounted Volume at /app/data,
// locally fall back to the project root (same behaviour as before).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LIKES_FILE = path.join(DATA_DIR, 'likes.json');
const PINS_FILE = path.join(DATA_DIR, 'pins.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

await fs.mkdir(CHATS_DIR, { recursive: true });
await fs.mkdir(FILES_DIR, { recursive: true });

const app = express();

app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-file-meta'],
}));
app.options('*', cors()); // Handle preflight requests (needed for iOS URLSession)

app.use(express.json({ limit: '64kb' }));

// ── Validation helpers ───────────────────────────────────────────────────────

function isValidRoomId(id) {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
}

function isValidNick(n) {
  return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 32;
}

function isValidHash(h) {
  return typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
}

function isValidFileId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

// ── Accounts storage ─────────────────────────────────────────────────────────

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

// ── In-memory state ──────────────────────────────────────────────────────────

// Map<roomId, Map<encryptedNick, Set<socketId>>>
// One nick can have multiple tabs/sockets — we count unique nicks.
const roomMembers = new Map();

// Map<socketId, { roomId, encNick, active }>
// Tracks which room+nick each socket belongs to and if the tab is active.
const socketMeta = new Map();

// Map<roomId, Map<encryptedNick, upToTs>> — read receipts (in-memory only)
const readReceipts = new Map();

// Map<roomId, Map<msgTs_string, Set<plainNick>>> — message likes (persisted to likes.json)
const messageLikes = new Map();

// Map<roomId, Map<msgTs_string, { ts, pinnedAt }>> — pinned messages (persisted to pins.json)
const roomPins = new Map();

// Load persisted likes and pins into Maps
await loadLikes();
await loadPins();

// ── Helper: get count of UNIQUE nicks in a room (ignoring inactive-only nicks) ──
// We count a nick as "online" if at least ONE of its sockets is active.
function getRoomCount(roomId) {
  const nicks = roomMembers.get(roomId);
  if (!nicks) return 0;
  let count = 0;
  for (const [_encNick, sockets] of nicks) {
    // Count this nick if it has at least one socket (active or inactive)
    if (sockets.size > 0) count++;
  }
  return count;
}

// ── Likes storage ────────────────────────────────────────────────────────

async function loadLikes() {
  try {
    const raw = await fs.readFile(LIKES_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [roomId, msgs] of Object.entries(data)) {
      messageLikes.set(roomId, new Map());
      for (const [msgTs, nicks] of Object.entries(msgs)) {
        messageLikes.get(roomId).set(msgTs, new Set(nicks));
      }
    }
  } catch { /* file doesn't exist yet — start fresh */ }
}

async function saveLikes() {
  const data = {};
  for (const [roomId, msgs] of messageLikes) {
    data[roomId] = {};
    for (const [msgTs, nicks] of msgs) {
      if (nicks.size > 0) data[roomId][msgTs] = [...nicks];
    }
  }
  const tmp = LIKES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, LIKES_FILE);
}

// ── Pins storage ──────────────────────────────────────────────────────────

async function loadPins() {
  try {
    const raw = await fs.readFile(PINS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [roomId, pins] of Object.entries(data)) {
      roomPins.set(roomId, new Map());
      for (const [msgTs, pinObj] of Object.entries(pins)) {
        roomPins.get(roomId).set(msgTs, pinObj);
      }
    }
  } catch { /* file doesn't exist yet — start fresh */ }
}

async function savePins() {
  const data = {};
  for (const [roomId, pins] of roomPins) {
    if (pins.size > 0) {
      data[roomId] = {};
      for (const [msgTs, pinObj] of pins) {
        data[roomId][msgTs] = pinObj;
      }
    }
  }
  const tmp = PINS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, PINS_FILE);
}

// ── Auth routes ──────────────────────────────────────────────────────────────

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { nickname, passwordHash } = req.body || {};

  if (!isValidNick(nickname) || !isValidHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const nick = nickname.trim();
  const key = nick.toLowerCase();

  try {
    const accounts = await loadAccounts();

    if (accounts[key]) {
      return res.status(409).json({ error: 'Никнейм уже занят' });
    }

    const accountData = {
      nickname: nick,
      passwordHash,
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
app.post('/auth/login', async (req, res) => {
  const { nickname, passwordHash } = req.body || {};

  if (!isValidNick(nickname) || !isValidHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const key = nickname.trim().toLowerCase();

  try {
    const accounts = await loadAccounts();
    const account = accounts[key];

    if (!account) {
      return res.status(401).json({ error: 'Аккаунт не найден' });
    }

    if (account.passwordHash !== passwordHash) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    return res.json({ ok: true, nickname: account.nickname, createdAt: account.createdAt });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Chat history route ───────────────────────────────────────────────────────

app.get('/history/:roomId', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }
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

// ── File upload / download routes ────────────────────────────────────────────

// multer: stream directly to disk, no size limit enforced here (1GB checked below)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILES_DIR),
  filename: (_req, _file, cb) => cb(null, randomBytes(16).toString('hex') + '.enc'),
});
const upload = multer({
  storage,
  limits: { fileSize: 1.1 * 1024 * 1024 * 1024 }, // 1.1 GB hard limit
});

// POST /upload/:roomId
// Multipart: field "file" = encrypted binary blob
// Headers: x-file-meta = JSON { iv, nick, name, mime, size, ts }
app.post('/upload/:roomId', upload.single('file'), async (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid room ID' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file' });
  }

  let meta;
  try {
    meta = JSON.parse(req.headers['x-file-meta'] || '{}');
  } catch {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid meta' });
  }

  const { iv, nick, name, mime, size, ts } = meta;
  if (
    typeof iv !== 'string' || !iv ||
    typeof nick !== 'string' || !nick ||
    typeof name !== 'string' || !name
  ) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Missing meta fields' });
  }

  const fileId = path.basename(req.file.filename, '.enc');

  // Store mapping: fileId.meta.json → { iv, nick, name, mime, size, ts, roomId }
  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  await fs.writeFile(metaPath, JSON.stringify({ iv, nick, name, mime, size, ts, roomId }), 'utf8');

  return res.json({ ok: true, fileId });
});

// GET /files/:roomId/:fileId — stream encrypted file back
app.get('/files/:roomId/:fileId', async (req, res) => {
  const { roomId, fileId } = req.params;
  if (!isValidRoomId(roomId) || !isValidFileId(fileId)) {
    return res.status(400).end();
  }

  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  } catch {
    return res.status(404).end();
  }

  // Only allow access from the correct room
  if (meta.roomId !== roomId) return res.status(403).end();

  const filePath = path.join(FILES_DIR, fileId + '.enc');
  try {
    const stat = await fs.stat(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(filePath).pipe(res);
  } catch {
    res.status(404).end();
  }
});

// GET /files/:roomId/:fileId/meta — return metadata
app.get('/files/:roomId/:fileId/meta', async (req, res) => {
  const { roomId, fileId } = req.params;
  if (!isValidRoomId(roomId) || !isValidFileId(fileId)) {
    return res.status(400).end();
  }

  const metaPath = path.join(FILES_DIR, fileId + '.meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (meta.roomId !== roomId) return res.status(403).end();
    return res.json(meta);
  } catch {
    return res.status(404).end();
  }
});

// ── Static client (production) ───────────────────────────────────────────────
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

// Static assets (JS/CSS have hashed filenames — cache them aggressively)
app.use(express.static(CLIENT_DIST, {
  setHeaders: (res, filePath) => {
    // Never cache index.html — always serve fresh so the browser picks up new JS/CSS hashes
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else {
      // Hashed assets can be cached forever
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// SPA fallback — any unmatched route returns index.html (no cache)
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

// ── Socket.io ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6, // 1MB — socket messages are text only now
});

// ── Room member helpers ──────────────────────────────────────────────────────

function addMember(roomId, encNick, socketId) {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map());
  const nicks = roomMembers.get(roomId);
  if (!nicks.has(encNick)) nicks.set(encNick, new Set());
  nicks.get(encNick).add(socketId);
}

function removeMember(roomId, encNick, socketId) {
  const nicks = roomMembers.get(roomId);
  if (!nicks) return;
  const sockets = nicks.get(encNick);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) nicks.delete(encNick);
  }
  if (nicks.size === 0) roomMembers.delete(roomId);
}

// Returns true if this nick has NO other sockets in the room (i.e. last tab)
function isLastSocket(roomId, encNick, socketId) {
  const sockets = roomMembers.get(roomId)?.get(encNick);
  if (!sockets) return true;
  return sockets.size === 0 || (sockets.size === 1 && sockets.has(socketId));
}

// ── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentNick = null; // encrypted nick

  socket.on('join', async ({ roomId, nick }) => {
    if (!isValidRoomId(roomId)) {
      socket.emit('error', { message: 'Invalid room ID' });
      return;
    }

    currentRoom = roomId;
    currentNick = nick || null;

    socket.join(roomId);
    if (currentNick) addMember(roomId, currentNick, socket.id);

    socketMeta.set(socket.id, { roomId, encNick: currentNick, active: true });

    io.to(roomId).emit('online_count', { count: getRoomCount(roomId) });

    // Only notify others + persist if this is the FIRST socket for this nick in this room
    if (nick && isLastSocket(roomId, nick, socket.id) === false) {
      // Not last — means we just added one MORE tab, others already know this nick is here
      // Actually we need to check BEFORE adding: if nick already had sockets, don't re-announce
    }

    // Announce join only if this nick had no other sockets before this one joined
    const socketsForNick = roomMembers.get(roomId)?.get(nick);
    const isFirstSocket = socketsForNick && socketsForNick.size === 1; // we already added this one

    if (nick && isFirstSocket) {
      const joinEvent = { type: 'system', subtype: 'join', nick, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(joinEvent) + '\n', 'utf8').catch(() => {});
      socket.to(roomId).emit('user_joined', { nick });
    }

    // Send current pins to newly joined socket
    const pins = [...(roomPins.get(roomId)?.values() ?? [])].sort((a, b) => a.ts - b.ts);
    if (pins.length > 0) socket.emit('pins_updated', { pins });

    // Send all current likes to newly joined socket
    const roomLikesMap = messageLikes.get(roomId);
    if (roomLikesMap && roomLikesMap.size > 0) {
      const likesSnapshot = {};
      for (const [msgTs, nicks] of roomLikesMap) {
        if (nicks.size > 0) likesSnapshot[msgTs] = [...nicks];
      }
      if (Object.keys(likesSnapshot).length > 0) {
        socket.emit('likes_snapshot', { likes: likesSnapshot });
      }
    }
  });

  socket.on('message', async ({ roomId, encrypted }) => {
    if (!isValidRoomId(roomId)) return;
    if (
      !encrypted ||
      typeof encrypted.iv !== 'string' ||
      typeof encrypted.data !== 'string' ||
      typeof encrypted.nick !== 'string' ||
      typeof encrypted.ts !== 'number'
    ) {
      socket.emit('error', { message: 'Malformed message' });
      return;
    }

    const line = JSON.stringify({
      iv: encrypted.iv,
      data: encrypted.data,
      ts: encrypted.ts,
      nick: encrypted.nick,
    });

    const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
    try {
      await fs.appendFile(filePath, line + '\n', 'utf8');
    } catch {
      socket.emit('error', { message: 'Storage write failed' });
      return;
    }

    io.to(roomId).emit('message', { encrypted });
  });

  socket.on('typing', ({ roomId, nick }) => {
    if (!isValidRoomId(roomId) || typeof nick !== 'string') return;
    socket.to(roomId).emit('typing', { nick });
  });

  socket.on('stop_typing', ({ roomId, nick }) => {
    if (!isValidRoomId(roomId) || typeof nick !== 'string') return;
    socket.to(roomId).emit('stop_typing', { nick });
  });

  socket.on('read', ({ roomId, nick, upToTs }) => {
    if (!isValidRoomId(roomId) || typeof nick !== 'string' || typeof upToTs !== 'number') return;
    if (!readReceipts.has(roomId)) readReceipts.set(roomId, new Map());
    readReceipts.get(roomId).set(nick, upToTs);
    // Broadcast to everyone in room (including sender — needed for multi-device)
    io.to(roomId).emit('read_by', { nick, upToTs });
  });

  socket.on('like', ({ roomId, msgTs, nick }) => {
    // nick is plaintext — allows correct deduplication via Set
    if (!isValidRoomId(roomId) || !isValidNick(nick) || typeof msgTs !== 'number') return;
    if (!messageLikes.has(roomId)) messageLikes.set(roomId, new Map());
    const roomLikes = messageLikes.get(roomId);
    const key = String(msgTs);
    if (!roomLikes.has(key)) roomLikes.set(key, new Set());
    roomLikes.get(key).add(nick.trim());
    io.to(roomId).emit('liked', { msgTs, nicks: [...roomLikes.get(key)] });
    saveLikes().catch(() => {});
  });

  socket.on('unlike', ({ roomId, msgTs, nick }) => {
    if (!isValidRoomId(roomId) || !isValidNick(nick) || typeof msgTs !== 'number') return;
    const roomLikes = messageLikes.get(roomId);
    if (!roomLikes) return;
    const key = String(msgTs);
    roomLikes.get(key)?.delete(nick.trim());
    io.to(roomId).emit('liked', { msgTs, nicks: [...(roomLikes.get(key) ?? [])] });
    saveLikes().catch(() => {});
  });

  socket.on('pin', async ({ roomId, msgTs, nick }) => {
    if (!isValidRoomId(roomId) || typeof msgTs !== 'number') return;
    if (!roomPins.has(roomId)) roomPins.set(roomId, new Map());
    roomPins.get(roomId).set(String(msgTs), { ts: msgTs, pinnedAt: Date.now() });
    const pins = [...roomPins.get(roomId).values()].sort((a, b) => a.ts - b.ts);
    io.to(roomId).emit('pins_updated', { pins, action: 'pin', byNick: nick || null });
    savePins().catch(() => {});
    // Persist pin notification
    if (nick) {
      const pinEvent = { type: 'system', subtype: 'pin', nick, msgTs, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(pinEvent) + '\n', 'utf8').catch(() => {});
    }
  });

  socket.on('unpin', async ({ roomId, msgTs, nick }) => {
    if (!isValidRoomId(roomId) || typeof msgTs !== 'number') return;
    roomPins.get(roomId)?.delete(String(msgTs));
    const pins = [...(roomPins.get(roomId)?.values() ?? [])].sort((a, b) => a.ts - b.ts);
    io.to(roomId).emit('pins_updated', { pins, action: 'unpin', byNick: nick || null });
    savePins().catch(() => {});
    // Persist unpin notification
    if (nick) {
      const unpinEvent = { type: 'system', subtype: 'unpin', nick, msgTs, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(unpinEvent) + '\n', 'utf8').catch(() => {});
    }
  });

  // Ping/latency measurement — just acknowledge immediately
  socket.on('ping_check', (_data, callback) => {
    if (typeof callback === 'function') callback();
  });

  // Tab visibility: client sends this when tab becomes hidden/visible
  socket.on('set_active', ({ active }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    meta.active = !!active;
    // No count change — we count unique nicks regardless of active state.
    // But we could use this in the future for "away" indicator.
  });

  socket.on('disconnect', async () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);

    const roomId = currentRoom || meta?.roomId;
    const encNick = currentNick || meta?.encNick;

    if (!roomId) return;

    if (encNick) removeMember(roomId, encNick, socket.id);

    const count = getRoomCount(roomId);
    io.to(roomId).emit('online_count', { count });

    // Only announce leave + persist if this was the LAST socket for this nick
    const stillHasSockets = (roomMembers.get(roomId)?.get(encNick)?.size ?? 0) > 0;
    if (encNick && !stillHasSockets) {
      socket.to(roomId).emit('user_left', { nick: encNick });
      const leaveEvent = { type: 'system', subtype: 'leave', nick: encNick, ts: Date.now() };
      const filePath = path.join(CHATS_DIR, `${roomId}.txt`);
      await fs.appendFile(filePath, JSON.stringify(leaveEvent) + '\n', 'utf8').catch(() => {});
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`SecureChat server running on port ${PORT}`);
  console.log(`Chats directory: ${CHATS_DIR}`);
  console.log(`Accounts file: ${ACCOUNTS_FILE}`);
  console.log(`Files directory: ${FILES_DIR}`);
});
