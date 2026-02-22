import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR: on Railway use the mounted Volume at /app/data,
// locally fall back to the project root (same behaviour as before).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

await fs.mkdir(CHATS_DIR, { recursive: true });

const app = express();

app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET', 'POST'],
}));

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
// Body: { nickname, passwordHash }  — passwordHash = sha256(sha256(password))
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
// Body: { nickname, passwordHash }
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

// ── Static client (production) ───────────────────────────────────────────────
// Serve the built React app. In development this folder won't exist, which is fine.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

app.use(express.static(CLIENT_DIST));

// SPA fallback — any unmatched route returns index.html so React Router works
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    // In dev the dist folder doesn't exist — just return 404 silently
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
});

// Map<roomId, Set<socketId>>
const roomMembers = new Map();

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
});
