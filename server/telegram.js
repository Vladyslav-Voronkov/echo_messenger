/**
 * telegram.js — Telegram ↔ Echo Messenger bridge
 *
 * Flow:
 *   1. Add the bot to a Telegram chat (group or DM)
 *   2. Send your Echo seed phrase to the bot — this links the chat
 *   3. New Telegram messages (text / photos / albums / files) → pushed into Echo
 *   4. New Echo messages (text / photos / albums / files)    → forwarded to Telegram
 *
 * Commands:
 *   /start   — show welcome message
 *   /unlink  — remove the bridge for this chat
 *
 * Environment variable: TELEGRAM_BOT_TOKEN
 */

import TelegramBot from 'node-telegram-bot-api';
import { Readable } from 'stream';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  deriveRoomId, deriveKey,
  encryptData, decryptData,
  encryptNick,
  encryptFileBinary, decryptFileBinary,
} from './tgcrypto.js';

let bot = null;
let bridgesFile = '';
let filesDir = '';

// { chatId(string): { roomId, seedPhrase, key(Buffer), linkedAt } }
const bridges = {};

// Media-group buffer: groupId → { bridge, displayNick, items[], caption, timer }
// Telegram sends each photo in an album as a separate message with the same media_group_id.
// We collect them for 1.5 s then flush as a single album message.
const mediaGroupBuffers = new Map();

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

/** Download a Telegram file by its file_id → Buffer */
async function downloadTgFile(tgFileId) {
  const fileLink = await bot.getFileLink(tgFileId);
  const response = await fetch(fileLink);
  if (!response.ok) throw new Error(`TG download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Encrypt and save a file into Echo's FILES_DIR.
 * Returns the Echo fileId (32-char hex).
 */
async function saveFileForEcho(bridge, fileBuffer, { name, mime, size, ts }) {
  const fileId = crypto.randomBytes(16).toString('hex');
  const { iv, encBuffer } = encryptFileBinary(bridge.key, fileBuffer);
  const encNick = encryptNick(bridge.key, 'TG Bridge [TG]');

  await fsPromises.writeFile(path.join(filesDir, `${fileId}.enc`), encBuffer);
  await fsPromises.writeFile(
    path.join(filesDir, `${fileId}.meta.json`),
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
  const metaPath = path.join(filesDir, `${fileId}.meta.json`);
  const encPath  = path.join(filesDir, `${fileId}.enc`);

  const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
  if (meta.roomId !== roomId) throw new Error('Room mismatch');

  const encBuffer = await fsPromises.readFile(encPath);
  const buffer = decryptFileBinary(key, meta.iv, encBuffer);
  return { buffer, name: meta.name, mime: meta.mime };
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}   opts.token          TELEGRAM_BOT_TOKEN
 * @param {string}   opts.dataDir        DATA_DIR path
 * @param {Function} opts.appendToRoom   async (roomId, storedMsg) => void
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

  // ── Helper: encrypt payload + push into Echo room ──────────────────────────
  async function pushToEcho(bridge, payload, displayNick) {
    const ts = Date.now();
    const encrypted = encryptData(bridge.key, JSON.stringify(payload));
    const encNick   = encryptNick(bridge.key, displayNick);
    const storedMsg = { iv: encrypted.iv, data: encrypted.data, ts, nick: encNick };
    await appendToRoom(bridge.roomId, storedMsg);
    broadcastToRoom(bridge.roomId, storedMsg);
  }

  // ── Helper: flush a buffered media group as a single album message ─────────
  async function flushMediaGroup(groupId) {
    const buf = mediaGroupBuffers.get(groupId);
    if (!buf) return;
    mediaGroupBuffers.delete(groupId);

    try {
      const images = await Promise.all(buf.items.map(async ({ tgFileId, fileSize }) => {
        const buffer = await downloadTgFile(tgFileId);
        const fileId = await saveFileForEcho(buf.bridge, buffer, {
          name: 'photo.jpg',
          mime: 'image/jpeg',
          size: fileSize || buffer.length,
          ts:   Date.now(),
        });
        return { fileId, mime: 'image/jpeg', size: fileSize || buffer.length };
      }));

      const payload = images.length === 1
        ? { type: 'image', image: images[0], ...(buf.caption ? { caption: buf.caption } : {}) }
        : { type: 'album', album: { images, caption: buf.caption || '' } };

      await pushToEcho(buf.bridge, payload, buf.displayNick);
    } catch (e) {
      console.error('[Telegram→Echo] Album flush error:', e.message);
    }
  }

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text   = msg.text || '';

    // ── /start ───────────────────────────────────────────────────────────────
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
      if (!text) return;
      try {
        const seedPhrase = text.trim();
        const roomId = deriveRoomId(seedPhrase);
        const key    = await deriveKey(seedPhrase);
        bridges[chatId] = { roomId, seedPhrase, key, linkedAt: Date.now() };
        saveBridges();
        await bot.sendMessage(
          chatId,
          '✅ Linked to Echo!\n\n' +
          '• Messages, photos & albums here → appear in Echo\n' +
          '• Echo messages, photos & albums → forwarded here\n\n' +
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
    const senderName  = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'TG User');
    const displayNick = `${senderName} [TG]`;
    const caption     = msg.caption || '';

    // ── Photo (may be part of a media group / album) ──────────────────────────
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1]; // highest resolution

      if (msg.media_group_id) {
        // Buffer this photo; flush after all messages in the group arrive
        const groupId = msg.media_group_id;
        if (!mediaGroupBuffers.has(groupId)) {
          mediaGroupBuffers.set(groupId, { bridge, displayNick, items: [], caption: '', timer: null });
        }
        const buf = mediaGroupBuffers.get(groupId);
        buf.items.push({ tgFileId: photo.file_id, fileSize: photo.file_size });
        if (caption) buf.caption = caption;

        clearTimeout(buf.timer);
        buf.timer = setTimeout(() => flushMediaGroup(groupId), 1500);
        return;
      }

      // Single photo (not in a group)
      try {
        const buffer = await downloadTgFile(photo.file_id);
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: 'photo.jpg',
          mime: 'image/jpeg',
          size: photo.file_size || buffer.length,
          ts:   Date.now(),
        });
        const payload = { type: 'image', image: { fileId, mime: 'image/jpeg', size: photo.file_size || buffer.length } };
        if (caption) payload.caption = caption;
        await pushToEcho(bridge, payload, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Photo error:', e.message);
      }
      return;
    }

    // ── Document / generic file ───────────────────────────────────────────────
    if (msg.document) {
      try {
        const doc    = msg.document;
        const buffer = await downloadTgFile(doc.file_id);
        const name   = doc.file_name || 'file';
        const mime   = doc.mime_type || 'application/octet-stream';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: doc.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: doc.file_size || buffer.length } }, displayNick);
        if (caption) await pushToEcho(bridge, { type: 'text', text: caption }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Document error:', e.message);
      }
      return;
    }

    // ── Voice message ─────────────────────────────────────────────────────────
    if (msg.voice) {
      try {
        const voice  = msg.voice;
        const buffer = await downloadTgFile(voice.file_id);
        const mime   = voice.mime_type || 'audio/ogg';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: 'voice.ogg', mime, size: voice.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'voice', voice: { fileId, mime, duration: voice.duration || 1 } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Voice error:', e.message);
      }
      return;
    }

    // ── Audio file ────────────────────────────────────────────────────────────
    if (msg.audio) {
      try {
        const audio  = msg.audio;
        const buffer = await downloadTgFile(audio.file_id);
        const name   = audio.file_name || 'audio.mp3';
        const mime   = audio.mime_type || 'audio/mpeg';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: audio.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: audio.file_size || buffer.length } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Audio error:', e.message);
      }
      return;
    }

    // ── Video ─────────────────────────────────────────────────────────────────
    if (msg.video) {
      try {
        const video  = msg.video;
        const buffer = await downloadTgFile(video.file_id);
        const name   = video.file_name || 'video.mp4';
        const mime   = video.mime_type || 'video/mp4';
        const fileId = await saveFileForEcho(bridge, buffer, {
          name, mime, size: video.file_size || buffer.length, ts: Date.now(),
        });
        await pushToEcho(bridge, { type: 'file', file: { fileId, name, mime, size: video.file_size || buffer.length } }, displayNick);
        if (caption) await pushToEcho(bridge, { type: 'text', text: caption }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Video error:', e.message);
      }
      return;
    }

    // ── Static sticker → image ────────────────────────────────────────────────
    if (msg.sticker) {
      try {
        const sticker = msg.sticker;
        if (sticker.is_animated || sticker.is_video) return;
        const buffer = await downloadTgFile(sticker.file_id);
        const fileId = await saveFileForEcho(bridge, buffer, {
          name: (sticker.emoji || '🎯') + '.webp',
          mime: 'image/webp',
          size: sticker.file_size || buffer.length,
          ts:   Date.now(),
        });
        await pushToEcho(bridge, { type: 'image', image: { fileId, mime: 'image/webp', size: sticker.file_size || buffer.length } }, displayNick);
      } catch (e) {
        console.error('[Telegram→Echo] Sticker error:', e.message);
      }
      return;
    }

    // ── Plain text ────────────────────────────────────────────────────────────
    if (!text) return;
    try {
      await pushToEcho(bridge, { type: 'text', text }, displayNick);
    } catch (e) {
      console.error('[Telegram→Echo] Text error:', e.message);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.code, err.message);
  });

  console.log('[Telegram] Bot initialized and polling');
}

// ── Forward Echo → Telegram ──────────────────────────────────────────────────

/**
 * Send a Telegram media group using raw bot._request (supports Buffer streams).
 * images: [{ buffer, mime }]
 */
async function sendTgMediaGroup(chatId, images, caption) {
  if (images.length === 1) {
    // Single image: simpler sendPhoto call
    return bot.sendPhoto(
      chatId,
      images[0].buffer,
      caption ? { caption } : {},
    );
  }

  const mediaArr = [];
  const formData = {};

  for (let i = 0; i < images.length; i++) {
    const key    = `photo_${i}`;
    const stream = new Readable({ read() {} });
    stream.push(images[i].buffer);
    stream.push(null);

    mediaArr.push({
      type:  'photo',
      media: `attach://${key}`,
      // Put caption on the first item
      ...(i === 0 && caption ? { caption } : {}),
    });

    formData[key] = {
      value:   stream,
      options: { filename: 'photo.jpg', contentType: images[i].mime || 'image/jpeg' },
    };
  }

  return bot._request('sendMediaGroup', {
    qs:       { chat_id: chatId, media: JSON.stringify(mediaArr) },
    formData,
  });
}

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

      // Decrypt message payload
      const payload = decryptData(bridge.key, encryptedMsg.iv, encryptedMsg.data);

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        if (!payload.trim()) continue;
        await bot.sendMessage(chatId, `💬 ${senderNick}: ${payload}`);
        continue;
      }

      // ── Album ───────────────────────────────────────────────────────────────
      if (parsed.type === 'album') {
        const imgs       = parsed.album?.images || [];
        const albumCaption = parsed.album?.caption ? `${senderNick}: ${parsed.album.caption}` : `🖼 ${senderNick}`;
        if (!imgs.length) continue;

        try {
          const decryptedImages = await Promise.all(
            imgs.map(img => readEchoFile(roomId, img.fileId, bridge.key)),
          );
          await sendTgMediaGroup(chatId, decryptedImages, albumCaption);
        } catch (e) {
          console.error('[Echo→Telegram] Album send error:', e.message);
          await bot.sendMessage(chatId, `🖼 ${senderNick} sent ${imgs.length} photo(s)`);
        }
        continue;
      }

      // ── Image ───────────────────────────────────────────────────────────────
      if (parsed.type === 'image') {
        const fileId = parsed.image?.fileId;
        const imgCaption = parsed.caption
          ? `🖼 ${senderNick}: ${parsed.caption}`
          : `🖼 ${senderNick}`;
        if (!fileId) { await bot.sendMessage(chatId, imgCaption); continue; }
        try {
          const { buffer } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendPhoto(chatId, buffer, { caption: imgCaption });
        } catch (e) {
          console.error('[Echo→Telegram] Image error:', e.message);
          await bot.sendMessage(chatId, imgCaption + ' (could not forward)');
        }
        continue;
      }

      // ── Voice ───────────────────────────────────────────────────────────────
      if (parsed.type === 'voice') {
        const fileId = parsed.voice?.fileId;
        if (!fileId) { await bot.sendMessage(chatId, `🎤 ${senderNick} sent a voice message`); continue; }
        try {
          const { buffer } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendVoice(chatId, buffer, { caption: `🎤 ${senderNick}` });
        } catch (e) {
          console.error('[Echo→Telegram] Voice error:', e.message);
          await bot.sendMessage(chatId, `🎤 ${senderNick} sent a voice message (could not forward)`);
        }
        continue;
      }

      // ── File / document ──────────────────────────────────────────────────────
      if (parsed.type === 'file') {
        const fileId = parsed.file?.fileId;
        const name   = parsed.file?.name || 'file';
        const mime   = parsed.file?.mime || 'application/octet-stream';
        if (!fileId) { await bot.sendMessage(chatId, `📎 ${senderNick}: ${name}`); continue; }
        try {
          const { buffer } = await readEchoFile(roomId, fileId, bridge.key);
          await bot.sendDocument(
            chatId,
            buffer,
            { caption: `📎 ${senderNick}: ${name}` },
            { filename: name, contentType: mime },
          );
        } catch (e) {
          console.error('[Echo→Telegram] File error:', e.message);
          await bot.sendMessage(chatId, `📎 ${senderNick}: ${name} (could not forward)`);
        }
        continue;
      }

      // ── Text ─────────────────────────────────────────────────────────────────
      if (parsed.text) {
        await bot.sendMessage(chatId, `💬 ${senderNick}: ${parsed.text}`);
        continue;
      }

      // system / AI messages — skip silently

    } catch (e) {
      console.error('[Telegram] Forward error:', e.message);
    }
  }
}
