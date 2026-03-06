/**
 * telegram.js — Telegram ↔ Echo Messenger bridge
 *
 * Flow:
 *   1. Add the bot to a Telegram chat (group or DM)
 *   2. Send your Echo seed phrase to the bot — this links the chat
 *   3. New Telegram messages are encrypted and pushed into the Echo room (marked [TG])
 *   4. New Echo messages are decrypted and forwarded to the Telegram chat
 *
 * Commands:
 *   /start   — show welcome message
 *   /unlink  — remove the bridge for this chat
 *
 * Environment variable: TELEGRAM_BOT_TOKEN
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { deriveRoomId, deriveKey, encryptData, decryptData, encryptNick } from './tgcrypto.js';

let bot = null;
let bridgesFile = '';

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

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text) return; // ignore photos, stickers, etc.

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
      try {
        const seedPhrase = text.trim();
        const roomId = deriveRoomId(seedPhrase);
        const key = await deriveKey(seedPhrase);
        bridges[chatId] = { roomId, seedPhrase, key, linkedAt: Date.now() };
        saveBridges();
        await bot.sendMessage(
          chatId,
          '✅ Linked to Echo!\n\n' +
          '• New messages here → appear in Echo with [TG] label\n' +
          '• New Echo messages → forwarded here\n\n' +
          'Send /unlink to disconnect.',
        );
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Failed to link: ${e.message}`);
      }
      return;
    }

    // Skip messages from bots (avoid loops with other bots)
    if (msg.from?.is_bot) return;

    // ── Forward Telegram → Echo ──────────────────────────────────────────────
    const bridge = bridges[chatId];
    const senderNick = msg.from?.username
      ? `@${msg.from.username}`
      : (msg.from?.first_name || 'TG User');
    const displayNick = `${senderNick} [TG]`;
    const ts = Date.now();

    const msgPayload = JSON.stringify({
      text,
      nick: displayNick,
      ts,
      type: 'text',
      fromTelegram: true, // prevents echo-back to Telegram
    });

    const encrypted = encryptData(bridge.key, msgPayload);
    const encNick = encryptNick(bridge.key, displayNick);

    const storedMsg = {
      iv: encrypted.iv,
      data: encrypted.data,
      ts,
      nick: encNick,
    };

    try {
      await appendToRoom(bridge.roomId, storedMsg);
      broadcastToRoom(bridge.roomId, storedMsg);
    } catch (e) {
      console.error('[Telegram] Failed to push message to Echo room:', e.message);
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
 * Finds the bridge for this room and forwards the decrypted message to Telegram.
 */
export async function forwardToTelegram(roomId, encryptedMsg) {
  if (!bot) return;

  for (const [chatId, bridge] of Object.entries(bridges)) {
    if (bridge.roomId !== roomId || !bridge.key) continue;

    try {
      const json = decryptData(bridge.key, encryptedMsg.iv, encryptedMsg.data);
      const msg = JSON.parse(json);

      // Don't echo TG-originated messages back to Telegram
      if (msg.fromTelegram) continue;

      let outText;
      if (msg.type === 'text' && msg.text) {
        outText = `💬 ${msg.nick}: ${msg.text}`;
      } else if (msg.type === 'image') {
        outText = `🖼 ${msg.nick} sent an image`;
      } else if (msg.type === 'voice') {
        outText = `🎤 ${msg.nick} sent a voice message`;
      } else if (msg.type === 'file') {
        outText = `📎 ${msg.nick} sent a file${msg.file?.name ? ': ' + msg.file.name : ''}`;
      } else {
        continue; // skip system, ai_command, ai_response, etc.
      }

      await bot.sendMessage(chatId, outText);
    } catch (e) {
      // Decryption failure = wrong key or message not for this bridge — silently skip
      if (!e.message?.includes('Unsupported state')) {
        console.error('[Telegram] Forward error:', e.message);
      }
    }
  }
}
