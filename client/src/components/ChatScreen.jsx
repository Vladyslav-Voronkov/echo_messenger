import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { io } from 'socket.io-client';
import Message from './Message.jsx';
import MessageInput from './MessageInput.jsx';
import PinnedBanner from './PinnedBanner.jsx';
import MediaPanel from './MediaPanel.jsx';
import WalletPanel from './WalletPanel.jsx';
import BuildBadge from './BuildBadge.jsx';
import { encryptMessage, encryptNick, decryptNick, decryptMessageObject } from '../utils/crypto.js';
import { getNickColor } from '../utils/nickColor.js';
import { useTranslation, interpolate } from '../utils/i18n.jsx';
import DmRequestBanner from './DmRequestBanner.jsx';

// ── Date separator label ──────────────────────────────────────────────────────
function formatMsgDate(ts) {
  const d    = new Date(ts);
  const now  = new Date();
  const toDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  if (toDay(d) === toDay(now)) return 'Сегодня';
  if (toDay(d) === toDay(now) - 86400000) return 'Вчера';
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ru-RU', opts);
}

// ── Last seen label ───────────────────────────────────────────────────────────
function formatLastSeen(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)       return 'был(а) только что';
  if (diff < 3_600_000)    return `был(а) ${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000)   return `был(а) ${Math.floor(diff / 3_600_000)} ч назад`;
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString())
    return 'был(а) вчера в ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return 'был(а) ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// In dev: Vite proxies /socket.io → localhost:3001 automatically.
// In production: server serves the built client, so same origin = correct.
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

// ── Build OpenAI context from chat history ────────────────────────────────────
function buildAIContext(messages, query) {
  const chatLines = [];
  const aiTurns  = [];
  const relevant  = messages.filter(m => m.type !== 'system').slice(-30);

  let i = 0;
  while (i < relevant.length) {
    const msg = relevant[i];

    // Detect type: either local flag or JSON content
    let isCmd  = msg.type === 'ai_command';
    let isResp = msg.type === 'ai_response';
    if (!isCmd && !isResp) {
      try {
        const p = JSON.parse(msg.text);
        if (p.type === 'ai_command')  isCmd  = true;
        if (p.type === 'ai_response') isResp = true;
      } catch { /* plain text */ }
    }

    if (isCmd) {
      // Extract query text
      let qText = msg.text;
      try { const p = JSON.parse(msg.text); if (p.text) qText = p.text; } catch { /* already plain */ }

      // Look for paired response
      let rText = null;
      const nxt = relevant[i + 1];
      if (nxt) {
        let nxtIsResp = nxt.type === 'ai_response';
        if (!nxtIsResp) { try { nxtIsResp = JSON.parse(nxt.text).type === 'ai_response'; } catch {} }
        if (nxtIsResp && !nxt.generating) {
          try { const p = JSON.parse(nxt.text); rText = p.text || nxt.text; } catch { rText = nxt.text; }
          i++;
        }
      }
      aiTurns.push({ query: qText, response: rText });

    } else if (!isResp) {
      // Regular text message
      let text = msg.text;
      try {
        const p = JSON.parse(msg.text);
        if (p.type === 'image' || p.type === 'album' || p.type === 'file' || p.type === 'voice') { i++; continue; }
        if (typeof p.text === 'string') text = p.text;
      } catch { /* plain text */ }
      if (text && text.trim()) chatLines.push(`${msg.nick}: ${text}`);
    }
    i++;
  }

  const msgs = [];
  let sys = 'You are ChatGPT, an AI assistant integrated into a secure encrypted group chat. Be helpful, concise, and friendly.';
  if (chatLines.length > 0) sys += '\n\nRecent group chat:\n' + chatLines.slice(-10).join('\n');
  msgs.push({ role: 'system', content: sys });

  // Previous AI conversation turns (max 5 pairs for context window)
  for (const turn of aiTurns.slice(-5)) {
    msgs.push({ role: 'user', content: turn.query });
    if (turn.response) msgs.push({ role: 'assistant', content: turn.response });
  }

  msgs.push({ role: 'user', content: query });
  return msgs;
}

const BATCH = 50; // messages to render per window

// Suspicious activity: if more than this many distinct join/leave events in this window
const SUSPICIOUS_EVENT_THRESHOLD = 6;
const SUSPICIOUS_WINDOW_MS = 60 * 1000; // 1 minute

/* ── SVG icon set for header/buttons ─────────────────────── */
const IconUsers = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 00-3-3.87"/>
    <path d="M16 3.13a4 4 0 010 7.75"/>
  </svg>
);
const IconMedia = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);
const IconUser = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);
const IconChevronLeft = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const IconLogout = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);
const IconArrowDown = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <polyline points="19 12 12 19 5 12"/>
  </svg>
);
const IconLock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0110 0v4"/>
  </svg>
);
const IconWarning = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const IconUserPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
    <circle cx="8.5" cy="7" r="4"/>
    <line x1="20" y1="8" x2="20" y2="14"/>
    <line x1="23" y1="11" x2="17" y2="11"/>
  </svg>
);

export default function ChatScreen({ session, chatName, onLeaveRoom, onLogout, onUpdateChat, onToggleSidebar, onDMRequestAccepted, onDMAccepted, onInviteToGroup, onOpenGroupInfo, chatAvatar = null }) {
  const { nickname, cryptoKey, type: chatType = 'legacy', roomId, dmId, groupId } = session;
  const contextId = chatType === 'dm' ? dmId : chatType === 'group' ? groupId : roomId;
  const [isPendingDM, setIsPendingDM] = useState(!!session.isPending);
  const [peerStatus, setPeerStatus]   = useState({ online: false, lastSeen: null });
  const { t } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [onlineCount, setOnlineCount] = useState(0);
  const [status, setStatus] = useState('connecting');

  const [replyTo, setReplyTo] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [typingUsers, setTypingUsers] = useState(new Set());
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [readReceipts, setReadReceipts] = useState({});
  const [likes, setLikes] = useState({});
  const [pins, setPins] = useState([]);
  const [activePinIdx, setActivePinIdx] = useState(0);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [suspiciousActivity, setSuspiciousActivity] = useState(false);
  // v0.2.0: scroll date label
  const [scrollDateLabel, setScrollDateLabel] = useState('');
  const [showScrollDate, setShowScrollDate] = useState(false);
  // v0.2.0: unread counter on scroll button
  const [unreadCount, setUnreadCount] = useState(0);

  const [peerAvatars, setPeerAvatars] = useState({});
  const fetchedNicksRef = useRef(new Set());

  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const loadedRef = useRef(false);
  const prevLenRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const messagesRef = useRef([]);
  const sendReadRef = useRef(null);
  const likesRef = useRef({});

  // Rolling window for suspicious activity detection
  const activityLogRef = useRef([]); // timestamps of join/leave events
  // v0.2.0: timer for hiding scroll date label
  const scrollDateTimerRef = useRef(null);
  // v0.2.0: keep showScrollBtn accessible in socket callback without stale closure
  const showScrollBtnRef = useRef(false);

  // Nick color for own avatar in header
  const ownNickColor    = getNickColor(nickname);
  // Avatar color for the current chat (shown in header)
  const chatAvatarColor = getNickColor(chatName || 'E');

  // Reset visible window and scroll flag when room changes
  useEffect(() => {
    setVisibleCount(BATCH);
    prevLenRef.current = 0;
    initialScrollDoneRef.current = false;
    loadedRef.current = false;
    setMessages([]);
  }, [contextId]);

  // Keep messagesRef in sync so sendRead can always access latest messages
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Scroll to bottom: instant on first load, smooth on new messages if near bottom
  useEffect(() => {
    const added = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (added > 0) {
      if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        sendReadRef.current();
        return;
      }
      const area = messagesAreaRef.current;
      if (area) {
        const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
        if (distFromBottom < 150) {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
      }
      sendReadRef.current();
    }
  }, [messages]);

  // Reset activePinIdx when pins change and it's out of bounds
  useEffect(() => {
    setActivePinIdx(prev => (pins.length === 0 ? 0 : Math.min(prev, pins.length - 1)));
  }, [pins]);

  // v0.2.0: keep ref in sync so socket message handler reads current value
  useEffect(() => { showScrollBtnRef.current = showScrollBtn; }, [showScrollBtn]);

  // v0.2.0: request browser push notification permission once on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Update sidebar preview with the last real message whenever messages change
  useEffect(() => {
    if (!messages.length || !onUpdateChat) return;
    const lastReal = [...messages].reverse().find(m => m.type !== 'system' && !m.generating);
    if (!lastReal) return;
    onUpdateChat(session.chatId, { lastMessage: lastReal.text || '', lastTs: lastReal.ts });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Fetch sender avatars for messages
  useEffect(() => {
    if (chatType === 'legacy') return;
    const toFetch = messages
      .filter(m => !m.isOwn && m.nick && !fetchedNicksRef.current.has(m.nick.toLowerCase()))
      .map(m => m.nick.toLowerCase());
    const unique = [...new Set(toFetch)];
    for (const nick of unique) {
      fetchedNicksRef.current.add(nick);
      const cached = localStorage.getItem('echo_avatar_' + nick);
      if (cached) { setPeerAvatars(prev => ({ ...prev, [nick]: cached })); continue; }
      fetch(`/users/pubkey/${encodeURIComponent(nick)}`)
        .then(r => r.json())
        .then(d => { if (d.avatar) { localStorage.setItem('echo_avatar_' + nick, d.avatar); setPeerAvatars(prev => ({ ...prev, [nick]: d.avatar })); } })
        .catch(() => {});
    }
  }, [messages, chatType]);

  // Track join/leave events for suspicious activity detection
  const recordActivityEvent = useCallback(() => {
    const now = Date.now();
    activityLogRef.current.push(now);
    // Keep only events within the window
    activityLogRef.current = activityLogRef.current.filter(t => now - t < SUSPICIOUS_WINDOW_MS);
    if (activityLogRef.current.length >= SUSPICIOUS_EVENT_THRESHOLD) {
      setSuspiciousActivity(true);
      // Auto-dismiss after 30 seconds if no more events
      setTimeout(() => {
        const latest = activityLogRef.current;
        if (!latest.length || Date.now() - latest[latest.length - 1] > 15000) {
          setSuspiciousActivity(false);
        }
      }, 30000);
    }
  }, []);

  // v0.2.0: play notification sound
  const playNotifSound = useCallback(() => {
    try {
      const audio = new Audio('/notification.mp3');
      audio.volume = 0.5;
      audio.play().catch(() => {});
    } catch { /* ignore */ }
  }, []);

  // v0.2.0: show browser push notification
  const showBrowserNotif = useCallback((plainNick, text) => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      const body = text && text.length > 100 ? text.slice(0, 100) + '...' : (text || '');
      const n = new Notification(plainNick, {
        body,
        icon: '/favicon.svg',
        tag: 'echo-message',
        silent: true, // we handle sound ourselves
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }, []);

  const loadHistory = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      const endpoint = chatType === 'dm'
        ? '/dm/history/' + contextId
        : chatType === 'group'
        ? '/groups/history/' + contextId
        : '/history/' + contextId;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const { lines } = await res.json();
      const decrypted = await Promise.all(
        lines.map(async (line, i) => {
          try {
            const obj = JSON.parse(line);
            // Handle persisted system events (join/leave/pin)
            if (obj.type === 'system') {
              // Plain-text system messages (group rename, avatar change, etc.)
              if (obj.text && obj.subtype && obj.subtype !== 'pin' && obj.subtype !== 'unpin') {
                return { id: 'hist-sys-' + i, type: 'system', text: obj.text, ts: obj.ts };
              }
              // Encrypted-nick system messages (pin/unpin)
              try {
                const plainNick = await decryptNick(cryptoKey, obj.nick);
                let text = '';
                if (obj.subtype === 'pin') text = interpolate(t('chat.sys_pinned'), { nick: plainNick });
                else if (obj.subtype === 'unpin') text = interpolate(t('chat.sys_unpinned'), { nick: plainNick });
                if (text) return { id: 'hist-sys-' + i, type: 'system', text, ts: obj.ts };
              } catch { return null; }
            }
            const msg = await decryptMessageObject(cryptoKey, obj);
            if (!msg) return null;
            // Detect AI message types from JSON content
            let msgType;
            try {
              const p = JSON.parse(msg.text);
              if (p.type === 'ai_command')  msgType = 'ai_command';
              if (p.type === 'ai_response') msgType = 'ai_response';
            } catch { /* plain text */ }
            return { ...msg, type: msgType, id: 'hist-' + i, isOwn: msg.nick === nickname };
          } catch { return null; }
        })
      );
      setMessages(decrypted.filter(Boolean));
    } catch (err) { console.error('History load error:', err); }
  }, [contextId, chatType, cryptoKey, nickname]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['polling', 'websocket'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      upgrade: true,
      query: { nick: nickname },
    });
    socketRef.current = socket;

    socket.on('connect', async () => {
      setStatus('online');
      if (!cryptoKey) {
        console.warn('[ChatScreen] cryptoKey is null — cannot join room');
        setStatus('error');
        return;
      }
      const encNick = await encryptNick(cryptoKey, nickname);
      if (chatType === 'dm') {
        socket.emit('dm_join', { dmId: contextId, encNick });
      } else if (chatType === 'group') {
        socket.emit('group_join', { groupId: contextId, encNick });
      } else {
        socket.emit('join', { roomId: contextId, nick: encNick });
      }
      loadHistory();
    });
    socket.on('disconnect', () => {
      setStatus('offline');
      setTypingUsers(new Set());
    });
    socket.on('connect_error', () => { setStatus('offline'); });
    socket.on('online_count', ({ count }) => setOnlineCount(count));

    const onIncomingMsg = async ({ encrypted }) => {
      const msg = await decryptMessageObject(cryptoKey, encrypted);
      if (!msg) return;

      // Detect AI message types from JSON content
      let detectedType;
      try {
        const p = JSON.parse(msg.text);
        if (p.type === 'ai_command')  detectedType = 'ai_command';
        if (p.type === 'ai_response') detectedType = 'ai_response';
      } catch { /* plain text — not an AI message */ }

      // Dedup: sender already has a local placeholder with same type+ts — skip echo
      if (detectedType) {
        const alreadyLocal = messagesRef.current.some(
          m => m.type === detectedType && m.ts === msg.ts
        );
        if (alreadyLocal) return;
      }

      // Remove typing indicator (only for regular messages)
      if (!detectedType) {
        setTypingUsers(prev => {
          const s = new Set(prev);
          s.delete(msg.nick);
          return s;
        });
      }

      const isOwn = msg.nick === nickname;
      setMessages(prev => [
        ...prev,
        { ...msg, type: detectedType, id: 'live-' + Date.now() + '-' + Math.random(), isOwn },
      ]);

      // Notifications only for regular messages from others
      if (!isOwn && !detectedType) {
        if (document.hidden || showScrollBtnRef.current) {
          playNotifSound();
        }
        // Build a display text for the notification body
        let notifText = msg.text || '';
        try {
          const parsed = JSON.parse(notifText);
          if (parsed.type === 'image') notifText = t('chat.notif_photo');
          else if (parsed.type === 'album') notifText = t('chat.notif_album').replace('{n}', parsed.album?.images?.length ?? '');
          else if (parsed.type === 'file') notifText = t('chat.notif_file') + ' ' + (parsed.file?.name || '');
          else if (parsed.type === 'voice') notifText = t('chat.notif_voice');
          else if (typeof parsed.text === 'string') notifText = parsed.text;
        } catch { /* plain text */ }
        showBrowserNotif(msg.nick, notifText);
        if (showScrollBtnRef.current) {
          setUnreadCount(prev => prev + 1);
        }
      }
    };
    socket.on('message',       onIncomingMsg);
    socket.on('dm_message',    onIncomingMsg);
    socket.on('group_message', onIncomingMsg);
    socket.on('dm_accepted', () => {
      setIsPendingDM(false);
      onDMAccepted?.(contextId);
    });

    socket.on('peer_status', ({ online, lastSeen }) => {
      if (chatType === 'dm') setPeerStatus({ online, lastSeen: lastSeen || null });
    });

    socket.on('receipts_snapshot', ({ receipts }) => {
      if (receipts && typeof receipts === 'object') {
        setReadReceipts(prev => ({ ...receipts, ...prev }));
      }
    });

    socket.on('group_updated', ({ groupId: gId, name, avatar }) => {
      if (gId === contextId) {
        if (name) onUpdateChat?.(session.chatId, { lastMessage: undefined, name });
      }
    });

    socket.on('user_avatar_updated', ({ nick, avatar }) => {
      const key = nick.toLowerCase();
      if (avatar) localStorage.setItem('echo_avatar_' + key, avatar);
      else localStorage.removeItem('echo_avatar_' + key);
      setPeerAvatars(prev => (prev[key] === avatar ? prev : { ...prev, [key]: avatar || null }));
    });

    socket.on('group_system', ({ text, ts, subtype }) => {
      if (text) {
        setMessages(prev => [
          ...prev,
          { id: 'sys-' + ts + '-' + Math.random(), type: 'system', text, ts: ts || Date.now() },
        ]);
      }
    });

    const onTyping = async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        if (plainNick === nickname) return;
        setTypingUsers(prev => new Set([...prev, plainNick]));
      } catch { /* ignore */ }
    };
    const onStopTyping = async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        setTypingUsers(prev => {
          const s = new Set(prev);
          s.delete(plainNick);
          return s;
        });
      } catch { /* ignore */ }
    };
    const typingEvt     = chatType === 'dm' ? 'dm_typing'      : chatType === 'group' ? 'group_typing'      : 'typing';
    const stopTypingEvt = chatType === 'dm' ? 'dm_stop_typing' : chatType === 'group' ? 'group_stop_typing' : 'stop_typing';
    socket.on(typingEvt,     onTyping);
    socket.on(stopTypingEvt, onStopTyping);

    socket.on('read_by', ({ nick, upToTs }) => {
      if (typeof nick !== 'string' || typeof upToTs !== 'number') return;
      setReadReceipts(prev => ({ ...prev, [nick]: upToTs }));
    });

    socket.on('liked', ({ msgTs, nicks }) => {
      if (typeof msgTs !== 'number' || !Array.isArray(nicks)) return;
      setLikes(prev => ({ ...prev, [msgTs]: nicks }));
    });

    // Receive full likes snapshot when joining (restores likes from server)
    socket.on('likes_snapshot', ({ likes: snapshot }) => {
      if (snapshot && typeof snapshot === 'object') {
        const converted = {};
        for (const [ts, nicks] of Object.entries(snapshot)) {
          converted[Number(ts)] = nicks;
        }
        setLikes(prev => ({ ...converted, ...prev }));
      }
    });

    socket.on('ai_response', async ({ queryId, text: aiText, done, error }) => {
      if (!done) return; // streaming not used, but guard anyway
      const respTs = Date.now();

      // Update local generating placeholder → show response immediately for sender
      setMessages(prev => prev.map(msg => {
        if (msg.type === 'ai_response' && msg.queryId === queryId) {
          return { ...msg, text: aiText, generating: false, ts: respTs, error: error || false };
        }
        return msg;
      }));

      // Encrypt ai_response and broadcast to room (saves to history, visible to all)
      try {
        const [respEnc, encNickGPT] = await Promise.all([
          encryptMessage(cryptoKey, JSON.stringify({ type: 'ai_response', text: aiText })),
          encryptNick(cryptoKey, 'ChatGPT'),
        ]);
        const aiRespEvt = chatType === 'dm' ? 'dm_message' : chatType === 'group' ? 'group_message' : 'message';
        const aiRespPayload = chatType === 'dm'
          ? { dmId: contextId,    encrypted: { iv: respEnc.iv, data: respEnc.data, ts: respTs, nick: encNickGPT }, fromNick: nickname }
          : chatType === 'group'
          ? { groupId: contextId, encrypted: { iv: respEnc.iv, data: respEnc.data, ts: respTs, nick: encNickGPT }, fromNick: nickname }
          : { roomId: contextId,  encrypted: { iv: respEnc.iv, data: respEnc.data, ts: respTs, nick: encNickGPT } };
        socketRef.current.emit(aiRespEvt, aiRespPayload);
      } catch (e) { console.error('ai_response encrypt error', e); }
    });

    socket.on('pins_updated', async ({ pins: updatedPins, action, byNick }) => {
      if (Array.isArray(updatedPins)) setPins(updatedPins);
      if (action && byNick) {
        try {
          const plainNick = await decryptNick(cryptoKey, byNick);
          const text = action === 'pin'
            ? interpolate(t('chat.sys_pinned'), { nick: plainNick })
            : interpolate(t('chat.sys_unpinned'), { nick: plainNick });
          setMessages(prev => [
            ...prev,
            { id: 'sys-' + Date.now() + '-' + Math.random(), type: 'system', text, ts: Date.now() },
          ]);
        } catch { /* ignore */ }
      }
    });

    // Page Visibility API — send set_active when tab is hidden/shown
    const onVisibilityChange = () => {
      if (socket.connected) {
        socket.emit('set_active', { active: document.visibilityState === 'visible' });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      socket.disconnect();
    };
  }, [contextId, chatType, cryptoKey, nickname, loadHistory, recordActivityEvent]);

  const handleSend = useCallback(async (text) => {
    if (!text.trim() || !socketRef.current?.connected || !cryptoKey) return;

    // /ai command — query ChatGPT, save result encrypted for all
    const trimmed = text.trim();
    if (trimmed.startsWith('/ai ') || trimmed === '/ai') {
      const query = trimmed.slice(3).trim();
      if (!query) return;
      const queryId = 'ai-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const cmdTs = Date.now();

      // 1. Show local placeholders immediately
      const cmdMsg = {
        id: 'ai-cmd-' + queryId,
        type: 'ai_command',
        nick: nickname,
        text: query,          // plain text for local display
        ts: cmdTs,
        isOwn: true,
      };
      const respMsg = {
        id: 'ai-resp-' + queryId,
        type: 'ai_response',
        nick: 'ChatGPT',
        text: '',
        ts: cmdTs + 1,
        isOwn: false,
        generating: true,
        queryId,
      };
      setMessages(prev => [...prev, cmdMsg, respMsg]);

      // 2. Encrypt the ai_command and broadcast to room (saves to history)
      try {
        const [cmdEnc, encNick] = await Promise.all([
          encryptMessage(cryptoKey, JSON.stringify({ type: 'ai_command', text: query })),
          encryptNick(cryptoKey, nickname),
        ]);
        const aiCmdEvt = chatType === 'dm' ? 'dm_message' : chatType === 'group' ? 'group_message' : 'message';
        const aiCmdPayload = chatType === 'dm'
          ? { dmId: contextId,    encrypted: { iv: cmdEnc.iv, data: cmdEnc.data, ts: cmdTs, nick: encNick }, fromNick: nickname }
          : chatType === 'group'
          ? { groupId: contextId, encrypted: { iv: cmdEnc.iv, data: cmdEnc.data, ts: cmdTs, nick: encNick }, fromNick: nickname }
          : { roomId: contextId,  encrypted: { iv: cmdEnc.iv, data: cmdEnc.data, ts: cmdTs, nick: encNick } };
        socketRef.current.emit(aiCmdEvt, aiCmdPayload);
      } catch (e) { console.error('ai_command encrypt error', e); }

      // 3. Send query to server with full conversation context
      const context = buildAIContext(messagesRef.current, query);
      socketRef.current.emit('ai_query', { queryId, text: query, context });
      setReplyTo(null);
      return;
    }

    const payload = replyTo ? JSON.stringify({ text: text.trim(), replyTo }) : text.trim();
    const [{ iv, data }, encNick] = await Promise.all([
      encryptMessage(cryptoKey, payload),
      encryptNick(cryptoKey, nickname),
    ]);
    if (chatType === 'dm') {
      socketRef.current.emit('dm_message',    { dmId: contextId,    encrypted: { iv, data, ts: Date.now(), nick: encNick }, fromNick: nickname });
    } else if (chatType === 'group') {
      socketRef.current.emit('group_message', { groupId: contextId, encrypted: { iv, data, ts: Date.now(), nick: encNick }, fromNick: nickname });
    } else {
      socketRef.current.emit('message',       { roomId: contextId,  encrypted: { iv, data, ts: Date.now(), nick: encNick } });
    }
    setReplyTo(null);
  }, [cryptoKey, nickname, contextId, chatType, replyTo]);

  const handleTyping = useCallback(async (isTyping) => {
    if (!socketRef.current?.connected) return;
    try {
      const encNick = await encryptNick(cryptoKey, nickname);
      if (chatType === 'dm') {
        socketRef.current.emit(isTyping ? 'dm_typing' : 'dm_stop_typing', { dmId: contextId, nick: encNick });
      } else if (chatType === 'group') {
        socketRef.current.emit(isTyping ? 'group_typing' : 'group_stop_typing', { groupId: contextId, nick: encNick });
      } else {
        socketRef.current.emit(isTyping ? 'typing' : 'stop_typing', { roomId: contextId, nick: encNick });
      }
    } catch { /* ignore */ }
  }, [cryptoKey, nickname, contextId, chatType]);

  const handleReply = useCallback((msg) => setReplyTo({ id: msg.id, nick: msg.nick, text: msg.text }), []);
  const handleCancelReply = useCallback(() => setReplyTo(null), []);

  const handleScrollToMessage = useCallback((msgId) => {
    const el = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(msgId);
      setTimeout(() => setHighlightId(null), 1500);
      setShowMediaPanel(false);
    }
  }, []);

  // v0.2.0: format a timestamp into a localized date label
  const formatScrollDate = useCallback((ts) => {
    const msgDate = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const isSameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (isSameDay(msgDate, today)) return t('chat.today');
    if (isSameDay(msgDate, yesterday)) return t('chat.yesterday');
    const months = t('chat.months');
    const day = msgDate.getDate();
    const month = Array.isArray(months) ? months[msgDate.getMonth()] : '';
    if (msgDate.getFullYear() === today.getFullYear()) return `${day} ${month}`;
    return `${day} ${month} ${msgDate.getFullYear()}`;
  }, [t]);

  const handleScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollTop < 80 && visibleCount < messages.length) {
      const prevScrollHeight = el.scrollHeight;
      setVisibleCount(v => Math.min(v + BATCH, messages.length));
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevScrollHeight;
      });
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distFromBottom > 200);

    // v0.2.0: reset unread count when scrolled to bottom
    if (distFromBottom < 50) {
      setUnreadCount(0);
    }

    // v0.2.0: floating date label — find the topmost visible message
    const area = el;
    const areaTop = area.getBoundingClientRect().top;
    const msgEls = area.querySelectorAll('[data-ts]');
    let topTs = null;
    for (const msgEl of msgEls) {
      const rect = msgEl.getBoundingClientRect();
      if (rect.bottom > areaTop + 4) {
        topTs = parseInt(msgEl.getAttribute('data-ts'), 10);
        break;
      }
    }
    if (topTs) {
      setScrollDateLabel(formatScrollDate(topTs));
      setShowScrollDate(true);
      if (scrollDateTimerRef.current) clearTimeout(scrollDateTimerRef.current);
      scrollDateTimerRef.current = setTimeout(() => setShowScrollDate(false), 1500);
    }
  }, [visibleCount, messages.length, formatScrollDate]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setUnreadCount(0);
  }, []);

  likesRef.current = likes;

  const handleLike = useCallback((msg) => {
    if (!socketRef.current?.connected) return;
    const already = (likesRef.current[msg.ts] || []).includes(nickname);
    socketRef.current.emit(already ? 'unlike' : 'like', {
      roomId: contextId, msgTs: msg.ts, nick: nickname,
    });
  }, [nickname, contextId]);

  const handlePin = useCallback(async (msg) => {
    if (!socketRef.current?.connected) return;
    const already = pins.some(p => p.ts === msg.ts);
    try {
      const encNick = await encryptNick(cryptoKey, nickname);
      socketRef.current.emit(already ? 'unpin' : 'pin', { roomId: contextId, msgTs: msg.ts, nick: encNick });
    } catch {
      socketRef.current.emit(already ? 'unpin' : 'pin', { roomId: contextId, msgTs: msg.ts });
    }
  }, [pins, contextId, cryptoKey, nickname]);

  const handleChangePin = useCallback((delta) => {
    setPins(currentPins => {
      setActivePinIdx(prev => {
        const next = prev + delta;
        if (next < 0) return currentPins.length - 1;
        if (next >= currentPins.length) return 0;
        return next;
      });
      return currentPins;
    });
  }, []);

  sendReadRef.current = () => {
    if (!socketRef.current?.connected || messagesRef.current.length === 0) return;
    const upToTs = messagesRef.current[messagesRef.current.length - 1].ts;
    socketRef.current.emit('read', { roomId: contextId, nick: nickname, upToTs });
  };

  useEffect(() => {
    const handler = () => sendReadRef.current();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, []);

  // Build typing label
  const typingArr = [...typingUsers];
  let typingLabel = '';
  if (typingArr.length === 1) typingLabel = interpolate(t('chat.typing_one'), { nick: typingArr[0] });
  else if (typingArr.length === 2) typingLabel = interpolate(t('chat.typing_two'), { a: typingArr[0], b: typingArr[1] });
  else if (typingArr.length > 2) typingLabel = t('chat.typing_many');

  return (
    <div className="chat-container">

      {/* ── Preloader overlay while connecting ── */}
      {status === 'connecting' && (
        <div className="chat-preloader">
          <div className="preloader-logo">EM</div>
          <div className="preloader-spinner" />
          <p className="preloader-text">{t('chat.preloader')}</p>
        </div>
      )}

      {/* ── Modern Chat Header ── */}
      <header className="chat-header glass">
        {/* Left: sidebar toggle (mobile) + chat avatar + info */}
        <div className="header-left">
          <button className="header-sidebar-btn" onClick={onToggleSidebar} title="Чаты">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          <div className="header-chat-avatar" style={{ background: chatAvatar ? 'var(--surface-1)' : chatAvatarColor, position: 'relative', overflow: 'hidden' }}>
            {chatAvatar
              ? <img src={`data:image/jpeg;base64,${chatAvatar}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (chatName || 'E')[0].toUpperCase()
            }
            {chatType === 'dm' && (
              <span className={`peer-online-dot ${peerStatus.online ? 'peer-online-dot--on' : 'peer-online-dot--off'}`} />
            )}
          </div>
          <div className="header-chat-info">
            <div className="header-chat-name-row">
              <span className="header-chat-name">{chatName || t('chat.name')}</span>
              {suspiciousActivity && (
                <span className="header-warning-badge" title={t('chat.suspicious_title')}>
                  <IconWarning /> {t('chat.suspicious')}
                </span>
              )}
            </div>
            {chatType === 'dm' && (
              <div className="header-peer-status">
                {peerStatus.online ? 'в сети' : peerStatus.lastSeen ? formatLastSeen(peerStatus.lastSeen) : ''}
              </div>
            )}
          </div>
        </div>

        {/* Right: online count (group/legacy only), media, actions */}
        <div className="header-right">
          {chatType !== 'dm' && (
            <div className="online-badge">
              <IconUsers />
              <span>{onlineCount}</span>
            </div>
          )}
          <button
            className={'header-btn' + (showMediaPanel ? ' active' : '')}
            onClick={() => setShowMediaPanel(v => !v)}
            title={t('chat.media_title')}
          >
            <IconMedia />
          </button>
          {chatType === 'group' && onInviteToGroup && (
            <button className="header-btn" onClick={onInviteToGroup} title="Добавить участника">
              <IconUserPlus />
            </button>
          )}
          {chatType === 'group' && onOpenGroupInfo && (
            <button className="header-btn" onClick={onOpenGroupInfo} title="Информация о группе">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
                <polyline points="11 12 12 12 12 16"/>
              </svg>
            </button>
          )}
          <WalletPanel mode="compact" />
        </div>
      </header>

      {/* ── Pinned messages banner ── */}
      {pins.length > 0 && (
        <PinnedBanner
          pins={pins}
          messages={messages}
          activePinIdx={activePinIdx}
          onChangePin={handleChangePin}
          onScrollToPin={handleScrollToMessage}
        />
      )}

      {/* v0.2.0: floating scroll date label */}
      <div className={'scroll-date-label' + (showScrollDate ? ' scroll-date-label--visible' : '')}>
        {scrollDateLabel}
      </div>

      {!cryptoKey && chatType !== 'legacy' && (
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 10, padding: '12px 16px', margin: '8px 12px',
          color: '#f87171', fontSize: 13, textAlign: 'center',
        }}>
          ⚠️ Ключи шифрования недоступны. Выйдите и войдите снова для генерации ключей.
        </div>
      )}

      {isPendingDM && chatType === 'dm' && session.otherNick && (
        <DmRequestBanner
          fromNick={session.otherNick}
          dmId={contextId}
          onAccept={() => {
            setIsPendingDM(false);
            onDMRequestAccepted?.(contextId, session.otherNick);
          }}
          onDecline={onLeaveRoom}
        />
      )}

      <main className="messages-area" ref={messagesAreaRef} onScroll={handleScroll}>
        {messages.length === 0 && status === 'online' && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p className="empty-title">{t('chat.empty_title')}</p>
            <p className="empty-hint">{t('chat.empty_hint')}</p>
          </div>
        )}
        {visibleCount < messages.length && (
          <div className="load-more-hint">{t('chat.load_more')}</div>
        )}
        {(() => {
          let lastDateStr = null;
          return messages.slice(-visibleCount).map(msg => {
            const dateStr = msg.ts ? new Date(msg.ts).toDateString() : null;
            const showSep = dateStr && dateStr !== lastDateStr && msg.type !== 'system';
            if (dateStr) lastDateStr = dateStr;
            return (
              <Fragment key={msg.id}>
                {showSep && (
                  <div className="msg-date-sep">
                    <span>{formatMsgDate(msg.ts)}</span>
                  </div>
                )}
                <Message
                  message={msg}
                  onReply={handleReply}
                  onScrollToMessage={handleScrollToMessage}
                  cryptoKey={cryptoKey}
                  highlighted={highlightId === msg.id}
                  socketRef={socketRef}
                  roomId={contextId}
                  nickname={nickname}
                  readReceipts={readReceipts}
                  likes={likes[msg.ts] || []}
                  onLike={handleLike}
                  pins={pins}
                  onPin={handlePin}
                  senderAvatar={!msg.isOwn && msg.nick ? (peerAvatars[msg.nick.toLowerCase()] || null) : null}
                />
              </Fragment>
            );
          });
        })()}
        <div ref={messagesEndRef} />
      </main>

      {/* ── Media panel (sliding drawer) ── */}
      {showMediaPanel && (
        <MediaPanel
          messages={messages}
          cryptoKey={cryptoKey}
          roomId={contextId}
          onClose={() => setShowMediaPanel(false)}
          onScrollToMessage={handleScrollToMessage}
        />
      )}

      {/* ── Scroll-to-bottom button ── */}
      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title={t('chat.scroll_bottom')}>
          <IconArrowDown />
          {unreadCount > 0 && (
            <span className="scroll-unread-badge">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      )}

      {/* ── Typing indicator ── */}
      <div className={'typing-indicator' + (typingUsers.size > 0 ? ' typing-indicator--visible' : '')}>
        {typingUsers.size > 0 && (
          <>
            <span className="typing-dots">
              <span /><span /><span />
            </span>
            <span className="typing-text">{typingLabel}</span>
          </>
        )}
      </div>

      <footer className="chat-footer glass">
        <MessageInput
          onSend={handleSend}
          onTyping={handleTyping}
          disabled={status !== 'online'}
          nickname={nickname}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
          cryptoKey={cryptoKey}
          roomId={contextId}
          socketRef={socketRef}
        />
        <BuildBadge />
      </footer>
    </div>
  );
}
