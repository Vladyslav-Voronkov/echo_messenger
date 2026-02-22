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

app.use(express.static(CLIENT_DIST));

// SPA fallback — any unmatched route returns index.html
app.get('*', (_req, res) => {
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

// Map<roomId, Set<socketId>>
const roomMembers = new Map();

// Map<roomId, Map<encryptedNick, upToTs>> — read receipts (in-memory only)
const readReceipts = new Map();

function getRoomCount(roomId) {
  return roomMembers.get(roomId)?.size ?? 0;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ roomId }) => {
    if (!isValidRoomId(roomId)) {
      socket.emit('error', { message: 'Invalid room ID' });
      return;
    }
    currentRoom = roomId;
    socket.join(roomId);
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
    roomMembers.get(roomId).add(socket.id);
    io.to(roomId).emit('online_count', { count: getRoomCount(roomId) });
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

  socket.on('disconnect', () => {
    if (currentRoom && roomMembers.has(currentRoom)) {
      roomMembers.get(currentRoom).delete(socket.id);
      const count = getRoomCount(currentRoom);
      io.to(currentRoom).emit('online_count', { count });
      if (count === 0) roomMembers.delete(currentRoom);
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
