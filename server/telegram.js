/**
 * telegram.js — Telegram ↔ Echo Messenger bridge
 *
 * Flow:
 *   1. Add the bot to a Telegram chat (group or DM)
 *   2. Send your Echo seed phrase to the bot — this links the chat
 *   3. New Telegram messages (text + photos + files) → encrypted and pushed into the Echo room
 *   4. New Echo messages (text + photos + files) → forwarded to the Telegram chat
 *
 * Commands:
 *   /start   — show welcome message
 *   /unlink  — remove the bridge for this chat
 *
 * Environment variable: TELEGRAM_BOT_TOKEN
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { deriveRoomId, deriveKey, encryptData, decryptData, encryptNick, encryptFileBinary, decryptFileBinary } from './tgcrypto.js';

let bot = null;
let bridgesFile = '';
let filesDir = '';

// { chatId(string): { roomId, seedPhrase, key(Buffer), linkedAt } }
const bridges = {};

// ── Public: look up bridge by roomId ────────────────────────────────────────

export function getBridgeByRoom(roomId) {
  for (const [chatId, bridge] of Object.entries(bridges)) {
    if (bridge.roomId === roomId) return { chatId, bridge };
  }
  return null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function saveBridges() {
  const toSave = {};
  for (const [chatId, { roomId, seedPhrase, linkedAt }] of Object.entries(bridges)) {
    toSave[chatId] = { roomId, seedPhrase, linkedAt };
  }
  fs.writeFileSync(bridgesFile, JSON.stringify(toSave, null, 2), 'utf8');
}

// ── File helpers ─────────────────────────────────────────────────────────────

/** Download a Telegram file by its file_id and return a Buffer. */
async function downloadTgFile(tgFileId) {
  const fileLink = await bot.getFileLink(tgFileId);
  const response = await fetch(fileLink);
  if (!response.ok) throw new Error(`TG download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Encrypt a Buffer and save it into the Echo FILES_DIR as a proper Echo file.
 * Returns the Echo fileId (32-char hex).
 */
async function saveFileForEcho(bridge, fileBuffer, { name, mime, size, ts }) {
  const fileId = crypto.randomBytes(16).toString('hex');
  const { iv, encBuffer } = encryptFileBinary(bridge.key, fileBuffer);
  const encNick = encryptNick(bridge.key, `TG Bridge [TG]`);

  await fsPromises.writeFile(path.join(filesDir, fileId + '.enc'), encBuffer);
  await fsPromises.writeFile(
    path.join(filesDir, fileId + '.meta.json'),
    JSON.stringify({ iv, nick: encNick, name, mime, size, ts, roomId: bridge.roomId }),
    'utf8',
  );
  return fileId;
}

/**
 * Read and decrypt an Echo file.
 * Returns { buffer, name, mime }.
 */
async function readEchoFile(roomId, fileId, key) {
  const metaPath = path.join(filesDir, fileId + '.meta.json');
  const encPath  = path.join(filesDir, fileId + '.enc');

  const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
  if (meta.roomId !== roomId) throw new Error('Room mismatch');

  const encBuffer = await fsPromises.readFile(encPath);
  const buffer = decryptFileBinary(key, meta.iv, encBuffer);
  return { buffer, name: meta.name, mime: meta.mime };
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.token          TELEGRAM_BOT_TOKEN
 * @param {string} opts.dataDir        DATA_DIR path
 * @param {Function} opts.appendToRoom async (roomId, storedMsg) => void
 * @param {Function} opts.broadcastToRoom (roomId, storedMsg) => void
 */
export async function initTelegram({ token, dataDir, appendToRoom, broadcastToRoom }) {
  if (!token) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN not set — bridge disabled');
    return;
  }

  bridgesFile = path.join(dataDir, 'tg_bridges.json');
  filesDir    = path.join(dataDir, 'files');

  // Load persisted bridges and re-derive keys
  if (fs.existsSync(bridgesFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(bridgesFile, 'utf8'));
      for (const [chatId, data] of Object.entries(saved)) {
        const key = await deriveKey(data.seedPhrase);
        bridges[chatId] = { ...data, key };
      }
      console.log(`[Telegram] Loaded ${Object.keys(bridges).length} bridge(s)`);
    } catch (e) {
      console.error('[Telegram] Failed to load bridges:', e.message);
    }
  }

  bot = new TelegramBot(token, { polling: true });

  // ── Helper: push any encrypted storedMsg into Echo ─────────────────────────
  async function pushToEcho(bridge, payload, displayNick) {
    const ts = Date.now();
    const encrypted = encryptData(bridge.key, JSON.stringify(payload));
    const encNick   = encryptNick(bridge.key, displayNick);
    const storedMsg = { iv: encrypted.iv, data: encrypted.data, ts, nick: encNick };
    await appendToRoom(bridge.roomId, storedMsg);
    broadcastToRoom(bridge.roomId, storedMsg);
  }

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);

    // ── /start ───────────────────────────────────────────────────────────────
    const text = msg.text || '';
    if (text === '/start' || text.startsWith('/start ') || text.startsWith('/start@')) {
      if (bridges[chatId]) {
        await bot.sendMessage(chatId, '✅ This chat is already linked to an Echo room.\nSend /unlink to disconnect.');
      } else {
        await bot.sendMessage(chatId, '👋 Welcome! Send me your Echo seed phrase to link this Telegram chat to your Echo room.');
      }
      return;
    }

    // ── /unlink ──────────────────────────────────────────────────────────────
    if (text === '/unlink' || text.startsWith('/unlink ') || text.startsWith('/unlink@')) {
      if (bridges[chatId]) {
        delete bridges[chatId];
        saveBridges();
        await bot.sendMessage(chatId, '✅ Echo bridge unlinked. Send your seed phrase to link again.');
      } else {
        await bot.sendMessage(chatId, 'ℹ️ This chat is not linked to Echo.');
      }
      return;
    }

    // Ignore unknown commands
    if (text.startsWith('/')) return;

    // ── Link: first non-command message = seed phrase ────────────────────────
    if (!bridges[chatId]) {
      // Only allow plain text for linking
      if (!text) return;
      try {
        const seedPhrase = text.trim();
        const roomId = deriveRoomId(seedPhrase);
        const key = await deriveKey(seedPhrase);
        bridges[chatId] = { roomId, seedPhrase, key, linkedAt: Date.now() };
        saveBridges();
        await bot.sendMessage(
          chatId,
          '✅ Linked to Echo!\n\n' +
          '• New messages, photos & files here → appear in Echo\n' +
          '• New Echo messages, photos & files → forwarded here\n\n' +
          'Send /unlink to disconnect.',
        );
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Failed to link: ${e.message}`);
      }
      return;
    }

    // Skip messages from bots (avoid loops with other bots)
    if (msg.from?.is_bot) return;

    const bridge = bridges[chatId];
    const senderName = msg.from?.username
      ? `@${msg.from.username}`
      : (msg.from?.first_name || 'TG User');
    const displayNick = `${senderName} [TG]`;
    const caption = msg.caption || '';

    // ── Photo ────────────────────────────────────────────────────────────────
    if (msg.photo) {
      try {
        const photo = msg.photo[msg.photo.length - 1]; // highest resolution
        const buffer = await downloadTgFile(photo.file_id);
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: 'photo.jpg',
          mime: 'image/jpeg',
          size: photo.file_size || buffer.length,
          ts: Date.now(),
        });
        const payload = { type: 'image', image: { fileId, mime: 'image/jpeg', size: photo.file_size || buffer.length } };
        if (caption) payload.caption = caption;
        await pushToEcho(bridge, payload, displayNick);
        if (caption) {
          // Also send the caption as a text message so Echo users see it
          await pushToEcho(bridge, { type: 'text', text: caption }, displayNick);
        }
      } catch (e) {
        console.error('[Telegram→Echo] Photo forward error:', e.message);
      }
      return;
    }

    // ── Document / generic file ───────────────────────────────────────────────
    if (msg.document) {
      try {
        const doc = msg.document;
        const buffer = await downloadTgFile(doc.file_id);
        const name = doc.file_name || 'file';
        const mime = doc.mime_type || 'application/octet-stream';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: doc.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: doc.file_size || buffer.length } }, displayNick);
        if (caption) {
          await pushToEcho(bridge, { type: 'text', text: caption }, displayNick);
        }
      } catch (e) {
        console.error('[Telegram→Echo] Document forward error:', e.message);
      }
      return;
    }

    // ── Voice message ────────────────────────────────────────────────────────
    if (msg.voice) {
      try {
        const voice = msg.voice;
        const buffer = await downloadTgFile(voice.file_id);
        const mime = voice.mime_type || 'audio/ogg';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: 'voice.ogg', mime, size: voice.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'voice', voice: { fileId, mime, duration: voice.duration || 1 } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Voice forward error:', e.message);
      }
      return;
    }

    // ── Audio file ───────────────────────────────────────────────────────────
    if (msg.audio) {
      try {
        const audio = msg.audio;
        const buffer = await downloadTgFile(audio.file_id);
        const name = audio.file_name || 'audio.mp3';
        const mime = audio.mime_type || 'audio/mpeg';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: audio.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: audio.file_size || buffer.length } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Audio forward error:', e.message);
      }
      return;
    }

    // ── Video ────────────────────────────────────────────────────────────────
    if (msg.video) {
      try {
        const video = msg.video;
        const buffer = await downloadTgFile(video.file_id);
        const name = video.file_name || 'video.mp4';
        const mime = video.mime_type || 'video/mp4';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: video.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: video.file_size || buffer.length } }, displayNick);
        if (caption) {
          await pushToEcho(bridge, { type: 'text', text: caption }, displayNick);
        }
      } catch (e) {
        console.error('[Telegram→Echo] Video forward error:', e.message);
      }
      return;
    }

    // ── Sticker → forward as file ────────────────────────────────────────────
    if (msg.sticker) {
      try {
        const sticker = msg.sticker;
        // Static stickers are WebP; animated are TGS (ignore animated/video stickers)
        if (sticker.is_animated || sticker.is_video) return;
        const buffer = await downloadTgFile(sticker.file_id);
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: (sticker.emoji || '🎯') + '.webp',
          mime: 'image/webp',
          size: sticker.file_size || buffer.length,
          ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'image', image: { fileId, mime: 'image/webp', size: sticker.file_size || buffer.length } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Sticker forward error:', e.message);
      }
      return;
    }

    // ── Plain text ────────────────────────────────────────────────────────────
    if (!text) return;

    try {
      await pushToEcho(bridge, { type: 'text', text }, displayNick);
    } catch (e) {
      console.error('[Telegram→Echo] Text forward error:', e.message);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.code, err.message);
  });

  console.log('[Telegram] Bot initialized and polling');
}

// ── Forward Echo → Telegram ──────────────────────────────────────────────────

/**
 * Called for every incoming Echo message.
 * Finds the bridge for this room and forwards the decrypted content to Telegram.
 */
export async function forwardToTelegram(roomId, encryptedMsg) {
  if (!bot) return;

  for (const [chatId, bridge] of Object.entries(bridges)) {
    if (bridge.roomId !== roomId || !bridge.key) continue;

    try {
      // Decrypt nick — used for display and loop prevention
      const [nickIv, nickData] = encryptedMsg.nick.split('.');
      const senderNick = decryptData(bridge.key, nickIv, nickData);

      // Skip messages that came FROM Telegram (prevents echo loop)
      if (senderNick.includes('[TG]')) continue;

      // Decrypt the message payload
      const payload = decryptData(bridge.key, encryptedMsg.iv, encryptedMsg.data);

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Plain text message
        if (!payload.trim()) continue;
        await bot.sendMessage(chatId, `💬 ${senderNick}: ${payload}`);
        continue;
      }

      // ── Image ────────────────────────────────────────────────────────────
      if (parsed.type === 'image') {
        const fileId = parsed.image?.fileId;
        if (!fileId) { await bot.sendMessage(chatId, `🖼 ${senderNick} sent an image`); continue; }
        try {
          const { buffer, mime } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendPhoto(chatId, buffer, { caption: `🖼 ${senderNick}` });
        } catch (e) {
          console.error('[Echo→Telegram] Image send error:', e.message);
          await bot.sendMessage(chatId, `🖼 ${senderNick} sent an image (could not forward)`);
        }
        continue;
      }

      // ── Voice ────────────────────────────────────────────────────────────
      if (parsed.type === 'voice') {
        const fileId = parsed.voice?.fileId;
        if (!fileId) { await bot.sendMessage(chatId, `🎤 ${senderNick} sent a voice message`); continue; }
        try {
          const { buffer } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendVoice(chatId, buffer, { caption: `🎤 ${senderNick}` });
        } catch (e) {
          console.error('[Echo→Telegram] Voice send error:', e.message);
          await bot.sendMessage(chatId, `🎤 ${senderNick} sent a voice message (could not forward)`);
        }
        continue;
      }

      // ── File / document ──────────────────────────────────────────────────
      if (parsed.type === 'file') {
        const fileId = parsed.file?.fileId;
        const name   = parsed.file?.name || 'file';
        const mime   = parsed.file?.mime || 'application/octet-stream';
        if (!fileId) { await bot.sendMessage(chatId, `📎 ${senderNick} sent a file: ${name}`); continue; }
        try {
          const { buffer } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendDocument(
            chatId,
            buffer,
            { caption: `📎 ${senderNick}: ${name}` },
            { filename: name, contentType: mime },
          );
        } catch (e) {
          console.error('[Echo→Telegram] File send error:', e.message);
          await bot.sendMessage(chatId, `📎 ${senderNick} sent a file: ${name} (could not forward)`);
        }
        continue;
      }

      // ── Text ─────────────────────────────────────────────────────────────
      if (parsed.text) {
        await bot.sendMessage(chatId, `💬 ${senderNick}: ${parsed.text}`);
        continue;
      }

      // system/AI messages — skip silently
    } catch (e) {
      console.error('[Telegram] Forward error:', e.message);
    }
  }
}
