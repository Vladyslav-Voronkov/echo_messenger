import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Message from './Message.jsx';
import MessageInput from './MessageInput.jsx';
import PinnedBanner from './PinnedBanner.jsx';
import MediaPanel from './MediaPanel.jsx';
import WalletPanel from './WalletPanel.jsx';
import BuildBadge from './BuildBadge.jsx';
import { encryptMessage, encryptNick, decryptNick, decryptMessageObject } from '../utils/crypto.js';
import { getNickColor } from '../utils/nickColor.js';
import { useTranslation, interpolate, LanguageSwitcher } from '../utils/i18n.jsx';

// In dev: Vite proxies /socket.io → localhost:3001 automatically.
// In production: server serves the built client, so same origin = correct.
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

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

export default function ChatScreen({ session, onLeaveRoom, onLogout }) {
  const { nickname, roomId, cryptoKey } = session;
  const { t } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [onlineCount, setOnlineCount] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [ping, setPing] = useState(null); // ms latency
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

  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const loadedRef = useRef(false);
  const prevLenRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const messagesRef = useRef([]);
  const sendReadRef = useRef(null);
  const likesRef = useRef({});
  const pingIntervalRef = useRef(null);
  // Rolling window for suspicious activity detection
  const activityLogRef = useRef([]); // timestamps of join/leave events
  // v0.2.0: timer for hiding scroll date label
  const scrollDateTimerRef = useRef(null);
  // v0.2.0: keep showScrollBtn accessible in socket callback without stale closure
  const showScrollBtnRef = useRef(false);

  // Nick color for own avatar in header
  const ownNickColor = getNickColor(nickname);

  // Reset visible window and scroll flag when room changes
  useEffect(() => {
    setVisibleCount(BATCH);
    prevLenRef.current = 0;
    initialScrollDoneRef.current = false;
  }, [roomId]);

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
      const res = await fetch('/history/' + roomId);
      if (!res.ok) return;
      const { lines } = await res.json();
      const decrypted = await Promise.all(
        lines.map(async (line, i) => {
          try {
            const obj = JSON.parse(line);
            // Handle persisted system events (join/leave/pin)
            if (obj.type === 'system') {
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
            return { ...msg, id: 'hist-' + i, isOwn: msg.nick === nickname };
          } catch { return null; }
        })
      );
      setMessages(decrypted.filter(Boolean));
    } catch (err) { console.error('History load error:', err); }
  }, [roomId, cryptoKey, nickname]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    // Ping measurement
    const measurePing = () => {
      const t0 = Date.now();
      socket.emit('ping_check', {}, () => {
        setPing(Date.now() - t0);
      });
    };

    socket.on('connect', async () => {
      setStatus('online');
      const encNick = await encryptNick(cryptoKey, nickname);
      socket.emit('join', { roomId, nick: encNick });
      loadHistory();
      // Start ping interval
      setTimeout(measurePing, 500);
      pingIntervalRef.current = setInterval(measurePing, 10000);
    });
    socket.on('disconnect', () => {
      setStatus('offline');
      setTypingUsers(new Set());
      setPing(null);
      clearInterval(pingIntervalRef.current);
    });
    socket.on('connect_error', () => { setStatus('offline'); setPing(null); });
    socket.on('online_count', ({ count }) => setOnlineCount(count));

    socket.on('message', async ({ encrypted }) => {
      const msg = await decryptMessageObject(cryptoKey, encrypted);
      if (!msg) return;
      setTypingUsers(prev => {
        const s = new Set(prev);
        s.delete(msg.nick);
        return s;
      });
      const isOwn = msg.nick === nickname;
      setMessages(prev => [
        ...prev,
        { ...msg, id: 'live-' + Date.now() + '-' + Math.random(), isOwn },
      ]);
      // v0.2.0: sound + push notif + unread counter for messages from others
      if (!isOwn) {
        if (document.hidden || showScrollBtnRef.current) {
          playNotifSound();
        }
        // Build a display text for the notification body
        let notifText = msg.text || '';
        try {
          const parsed = JSON.parse(notifText);
          if (parsed.type === 'image') notifText = t('chat.notif_photo');
          else if (parsed.type === 'file') notifText = t('chat.notif_file') + ' ' + (parsed.file?.name || '');
          else if (parsed.type === 'voice') notifText = t('chat.notif_voice');
          else if (typeof parsed.text === 'string') notifText = parsed.text;
        } catch { /* plain text */ }
        showBrowserNotif(msg.nick, notifText);
        // Increment unread counter when user is not at bottom
        if (showScrollBtnRef.current) {
          setUnreadCount(prev => prev + 1);
        }
      }
    });

    socket.on('typing', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        if (plainNick === nickname) return;
        setTypingUsers(prev => new Set([...prev, plainNick]));
      } catch { /* ignore */ }
    });

    socket.on('stop_typing', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        setTypingUsers(prev => {
          const s = new Set(prev);
          s.delete(plainNick);
          return s;
        });
      } catch { /* ignore */ }
    });

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
      clearInterval(pingIntervalRef.current);
      socket.disconnect();
    };
  }, [roomId, cryptoKey, nickname, loadHistory, recordActivityEvent]);

  const handleSend = useCallback(async (text) => {
    if (!text.trim() || !socketRef.current?.connected) return;
    const payload = replyTo ? JSON.stringify({ text: text.trim(), replyTo }) : text.trim();
    const [{ iv, data }, encNick] = await Promise.all([
      encryptMessage(cryptoKey, payload),
      encryptNick(cryptoKey, nickname),
    ]);
    socketRef.current.emit('message', { roomId, encrypted: { iv, data, ts: Date.now(), nick: encNick } });
    setReplyTo(null);
  }, [cryptoKey, nickname, roomId, replyTo]);

  const handleTyping = useCallback(async (isTyping) => {
    if (!socketRef.current?.connected) return;
    try {
      const encNick = await encryptNick(cryptoKey, nickname);
      socketRef.current.emit(isTyping ? 'typing' : 'stop_typing', { roomId, nick: encNick });
    } catch { /* ignore */ }
  }, [cryptoKey, nickname, roomId]);

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
      roomId, msgTs: msg.ts, nick: nickname,
    });
  }, [nickname, roomId]);

  const handlePin = useCallback(async (msg) => {
    if (!socketRef.current?.connected) return;
    const already = pins.some(p => p.ts === msg.ts);
    try {
      const encNick = await encryptNick(cryptoKey, nickname);
      socketRef.current.emit(already ? 'unpin' : 'pin', { roomId, msgTs: msg.ts, nick: encNick });
    } catch {
      socketRef.current.emit(already ? 'unpin' : 'pin', { roomId, msgTs: msg.ts });
    }
  }, [pins, roomId, cryptoKey, nickname]);

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

  sendReadRef.current = async () => {
    if (!socketRef.current?.connected || messagesRef.current.length === 0) return;
    try {
      const upToTs = messagesRef.current[messagesRef.current.length - 1].ts;
      const encNick = await encryptNick(cryptoKey, nickname);
      socketRef.current.emit('read', { roomId, nick: encNick, upToTs });
    } catch { /* ignore */ }
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

  // Ping label
  const msLabel = t('chat.ms');
  const pingLabel = ping === null ? null
    : ping < 80 ? { text: ping + ' ' + msLabel, cls: 'ping-good' }
    : ping < 200 ? { text: ping + ' ' + msLabel, cls: 'ping-ok' }
    : { text: ping + ' ' + msLabel, cls: 'ping-bad' };

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
        {/* Left: logo + chat info */}
        <div className="header-left">
          <div className="header-logo">EM</div>
          <div className="header-chat-info">
            <div className="header-chat-name-row">
              <span className="header-chat-name">{t('chat.name')}</span>
              {suspiciousActivity && (
                <span className="header-warning-badge" title={t('chat.suspicious_title')}>
                  <IconWarning /> {t('chat.suspicious')}
                </span>
              )}
            </div>
            <div className="header-meta-row">
              <span className={`header-status-dot ${status === 'online' ? 'dot-online' : status === 'offline' ? 'dot-offline' : 'dot-connecting'}`} />
              <span className="header-status-text">
                {status === 'online' ? t('chat.status_online') : status === 'offline' ? t('chat.status_offline') : t('chat.status_connecting')}
              </span>
              {pingLabel && (
                <>
                  <span className="header-meta-sep">·</span>
                  <span className={`header-ping ${pingLabel.cls}`}>{pingLabel.text}</span>
                </>
              )}
              <span className="header-meta-sep">·</span>
              <span className="header-enc-badge">
                <IconLock /> AES-256
              </span>
            </div>
          </div>
        </div>

        {/* Right: online count, media, nick, actions */}
        <div className="header-right">
          <div className="online-badge">
            <IconUsers />
            <span>{onlineCount}</span>
          </div>
          <button
            className={'header-btn' + (showMediaPanel ? ' active' : '')}
            onClick={() => setShowMediaPanel(v => !v)}
            title={t('chat.media_title')}
          >
            <IconMedia />
          </button>
          <div className="nick-badge">
            <div
              className="nick-avatar-sm"
              style={{ background: ownNickColor }}
              title={nickname}
            >
              {nickname ? nickname[0].toUpperCase() : '?'}
            </div>
            <span>{nickname}</span>
          </div>
          <WalletPanel mode="compact" />
          <LanguageSwitcher />
          <button className="leave-btn" onClick={onLeaveRoom} title={t('chat.leave_title')}>
            <IconChevronLeft />
            <span>{t('chat.chats_btn')}</span>
          </button>
          <button className="logout-btn" onClick={onLogout} title={t('chat.logout_title')}>
            <IconLogout />
          </button>
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
        {messages.slice(-visibleCount).map(msg => (
          <Message
            key={msg.id}
            message={msg}
            onReply={handleReply}
            onScrollToMessage={handleScrollToMessage}
            cryptoKey={cryptoKey}
            highlighted={highlightId === msg.id}
            socketRef={socketRef}
            roomId={roomId}
            nickname={nickname}
            readReceipts={readReceipts}
            likes={likes[msg.ts] || []}
            onLike={handleLike}
            pins={pins}
            onPin={handlePin}
          />
        ))}
        <div ref={messagesEndRef} />
      </main>

      {/* ── Media panel (sliding drawer) ── */}
      {showMediaPanel && (
        <MediaPanel
          messages={messages}
          cryptoKey={cryptoKey}
          roomId={roomId}
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
          roomId={roomId}
          socketRef={socketRef}
        />
        <BuildBadge />
      </footer>
    </div>
  );
}
