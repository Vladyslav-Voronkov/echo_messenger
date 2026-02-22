import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Message from './Message.jsx';
import MessageInput from './MessageInput.jsx';
import { encryptMessage, encryptNick, decryptNick, decryptMessageObject } from '../utils/crypto.js';

// In dev: Vite proxies /socket.io → localhost:3001 automatically.
// In production: server serves the built client, so same origin = correct.
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

const BATCH = 50; // messages to render per window

export default function ChatScreen({ session, onLeaveRoom, onLogout }) {
  const { nickname, roomId, cryptoKey } = session;
  const [messages, setMessages] = useState([]);
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [onlineCount, setOnlineCount] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [replyTo, setReplyTo] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [typingUsers, setTypingUsers] = useState(new Set());
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [readReceipts, setReadReceipts] = useState({});
  // { encryptedNick: upToTs } — tracks who read up to which timestamp
  const [likes, setLikes] = useState({});
  // { msgTs: [encNick, ...] } — who liked each message
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const loadedRef = useRef(false);
  const prevLenRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const messagesRef = useRef([]);
  const sendReadRef = useRef(null);
  const likesRef = useRef({});

  // Reset visible window and scroll flag when room changes
  useEffect(() => {
    setVisibleCount(BATCH);
    prevLenRef.current = 0;
    initialScrollDoneRef.current = false;
  }, [roomId]);

  // Keep messagesRef in sync so sendRead can always access latest messages
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Scroll to bottom: instant on first load, smooth on new messages if near bottom
  // Also send read receipt whenever new messages arrive
  useEffect(() => {
    const added = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (added > 0) {
      if (!initialScrollDoneRef.current) {
        // Initial history load — jump instantly to bottom (like Telegram)
        initialScrollDoneRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        sendReadRef.current(); // mark all history as read
        return;
      }
      // Live messages — only auto-scroll if user is already near the bottom
      const area = messagesAreaRef.current;
      if (area) {
        const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
        if (distFromBottom < 150) {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
      }
      sendReadRef.current(); // mark newly received messages as read
    }
  }, [messages]);

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
            const msg = await decryptMessageObject(cryptoKey, obj);
            if (!msg) return null;
            return { ...msg, id: 'hist-' + i, isOwn: msg.nick === nickname };
          } catch { return null; }
        })
      );
      setMessages(decrypted.filter(Boolean));
      // Scroll handled by useEffect on messages change (initialScrollDoneRef)
    } catch (err) { console.error('History load error:', err); }
  }, [roomId, cryptoKey, nickname]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('online');
      socket.emit('join', { roomId });
      loadHistory();
    });
    socket.on('disconnect', () => {
      setStatus('offline');
      setTypingUsers(new Set()); // clear typing on disconnect
    });
    socket.on('connect_error', () => setStatus('offline'));
    socket.on('online_count', ({ count }) => setOnlineCount(count));

    socket.on('message', async ({ encrypted }) => {
      const msg = await decryptMessageObject(cryptoKey, encrypted);
      if (!msg) return;
      // When a message arrives, remove that nick from typing set
      setTypingUsers(prev => {
        const s = new Set(prev);
        s.delete(msg.nick);
        return s;
      });
      setMessages(prev => [
        ...prev,
        { ...msg, id: 'live-' + Date.now() + '-' + Math.random(), isOwn: msg.nick === nickname },
      ]);
    });

    socket.on('typing', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        if (plainNick === nickname) return; // ignore own echoes if any
        setTypingUsers(prev => new Set([...prev, plainNick]));
      } catch { /* ignore decrypt errors */ }
    });

    socket.on('stop_typing', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        setTypingUsers(prev => {
          const s = new Set(prev);
          s.delete(plainNick);
          return s;
        });
      } catch { /* ignore decrypt errors */ }
    });

    socket.on('read_by', ({ nick, upToTs }) => {
      if (typeof nick !== 'string' || typeof upToTs !== 'number') return;
      setReadReceipts(prev => ({ ...prev, [nick]: upToTs }));
    });

    socket.on('liked', ({ msgTs, nicks }) => {
      if (typeof msgTs !== 'number' || !Array.isArray(nicks)) return;
      setLikes(prev => ({ ...prev, [msgTs]: nicks }));
    });

    return () => socket.disconnect();
  }, [roomId, cryptoKey, nickname, loadHistory]);

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
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(msgId);
    setTimeout(() => setHighlightId(null), 1500);
  }, []);

  // Load older messages when near top; show/hide scroll-to-bottom button
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
  }, [visibleCount, messages.length]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Keep likesRef in sync for handleLike
  likesRef.current = likes;

  // Toggle like/unlike on a message
  const handleLike = useCallback(async (msg) => {
    if (!socketRef.current?.connected) return;
    try {
      const encNick = await encryptNick(cryptoKey, nickname);
      const already = (likesRef.current[msg.ts] || []).includes(encNick);
      socketRef.current.emit(already ? 'unlike' : 'like', {
        roomId, msgTs: msg.ts, nick: encNick,
      });
    } catch { /* ignore */ }
  }, [cryptoKey, nickname, roomId]);

  // Always keep sendReadRef.current pointing to the latest closure
  sendReadRef.current = async () => {
    if (!socketRef.current?.connected || messagesRef.current.length === 0) return;
    try {
      const upToTs = messagesRef.current[messagesRef.current.length - 1].ts;
      const encNick = await encryptNick(cryptoKey, nickname);
      socketRef.current.emit('read', { roomId, nick: encNick, upToTs });
    } catch { /* ignore */ }
  };

  // Send read receipt when window regains focus
  useEffect(() => {
    const handler = () => sendReadRef.current();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, []);

  const statusInfo = {
    connecting: { label: 'Подключение...', cls: 'status-connecting' },
    online:     { label: '🔒 Зашифровано', cls: 'status-online' },
    offline:    { label: 'Переподключение...', cls: 'status-offline' },
  }[status];

  // Build typing label
  const typingArr = [...typingUsers];
  let typingLabel = '';
  if (typingArr.length === 1) typingLabel = typingArr[0] + ' печатает...';
  else if (typingArr.length === 2) typingLabel = typingArr.join(' и ') + ' печатают...';
  else if (typingArr.length > 2) typingLabel = 'Несколько человек печатают...';

  return (
    <div className="chat-container">

      {/* ── Preloader overlay while connecting ── */}
      {status === 'connecting' && (
        <div className="chat-preloader">
          <div className="preloader-logo">EM</div>
          <div className="preloader-spinner" />
          <p className="preloader-text">Подключение к каналу...</p>
        </div>
      )}

      <header className="chat-header glass">
        <div className="header-left">
          <div className="header-logo">EM</div>
          <div className="header-info">
            <span className="header-title">ECHO</span>
            <span className={'header-status ' + statusInfo.cls}>{statusInfo.label}</span>
          </div>
        </div>
        <div className="header-right">
          <div className="online-badge">
            <span className="online-dot" />
            <span>{onlineCount}</span>
          </div>
          <div className="nick-badge">👤 {nickname}</div>
          <button className="leave-btn" onClick={onLeaveRoom}>← Комнаты</button>
          <button className="logout-btn" onClick={onLogout}>Выйти</button>
        </div>
      </header>

      <main className="messages-area" ref={messagesAreaRef} onScroll={handleScroll}>
        {messages.length === 0 && status === 'online' && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p className="empty-title">Канал пуст</p>
            <p className="empty-hint">Напишите первое сообщение. Оно будет зашифровано.</p>
          </div>
        )}
        {visibleCount < messages.length && (
          <div className="load-more-hint">▲ Прокрутите вверх для загрузки старых сообщений</div>
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
          />
        ))}
        <div ref={messagesEndRef} />
      </main>

      {/* ── Scroll-to-bottom button ── */}
      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="В конец">↓</button>
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
      </footer>
    </div>
  );
}
