import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Message from './Message.jsx';
import MessageInput from './MessageInput.jsx';
import PinnedBanner from './PinnedBanner.jsx';
import MediaPanel from './MediaPanel.jsx';
import { encryptMessage, encryptNick, decryptNick, decryptMessageObject } from '../utils/crypto.js';

// In dev: Vite proxies /socket.io → localhost:3001 automatically.
// In production: server serves the built client, so same origin = correct.
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

const BATCH = 50; // messages to render per window

export default function ChatScreen({ session, onLeaveRoom, onLogout }) {
  const { nickname, roomId, cryptoKey, chatName, seedShort } = session;
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
                if (obj.subtype === 'join') text = `${plainNick} присоединился(-ась)`;
                else if (obj.subtype === 'leave') text = `${plainNick} покинул(а) чат`;
                else if (obj.subtype === 'pin') text = `📌 ${plainNick} закрепил(а) сообщение`;
                else if (obj.subtype === 'unpin') text = `📌 ${plainNick} открепил(а) сообщение`;
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
      setMessages(prev => [
        ...prev,
        { ...msg, id: 'live-' + Date.now() + '-' + Math.random(), isOwn: msg.nick === nickname },
      ]);
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
            ? `📌 ${plainNick} закрепил(а) сообщение`
            : `📌 ${plainNick} открепил(а) сообщение`;
          setMessages(prev => [
            ...prev,
            { id: 'sys-' + Date.now() + '-' + Math.random(), type: 'system', text, ts: Date.now() },
          ]);
        } catch { /* ignore */ }
      }
    });

    socket.on('user_joined', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        if (plainNick === nickname) return;
        setMessages(prev => [
          ...prev,
          { id: 'sys-' + Date.now() + '-' + Math.random(), type: 'system', text: `${plainNick} присоединился(-ась)`, ts: Date.now() },
        ]);
      } catch { /* ignore */ }
    });

    socket.on('user_left', async ({ nick: encNick }) => {
      try {
        const plainNick = await decryptNick(cryptoKey, encNick);
        setMessages(prev => [
          ...prev,
          { id: 'sys-' + Date.now() + '-' + Math.random(), type: 'system', text: `${plainNick} покинул(а) чат`, ts: Date.now() },
        ]);
      } catch { /* ignore */ }
    });

    return () => {
      clearInterval(pingIntervalRef.current);
      socket.disconnect();
    };
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
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(msgId);
      setTimeout(() => setHighlightId(null), 1500);
      setShowMediaPanel(false);
    }
  }, []);

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
  if (typingArr.length === 1) typingLabel = typingArr[0] + ' печатает...';
  else if (typingArr.length === 2) typingLabel = typingArr.join(' и ') + ' печатают...';
  else if (typingArr.length > 2) typingLabel = 'Несколько человек печатают...';

  // Ping label
  const pingLabel = ping === null ? null
    : ping < 80 ? { text: ping + ' мс', cls: 'ping-good' }
    : ping < 200 ? { text: ping + ' мс', cls: 'ping-ok' }
    : { text: ping + ' мс', cls: 'ping-bad' };

  return (
    <div className="chat-container">

      {/* ── Preloader overlay while connecting ── */}
      {status === 'connecting' && (
        <div className="chat-preloader">
          <div className="preloader-logo">EM</div>
          <div className="preloader-spinner" />
          <p className="preloader-text">Подключение к чату...</p>
        </div>
      )}

      {/* ── Modern Chat Header ── */}
      <header className="chat-header glass">
        {/* Left: logo + chat info */}
        <div className="header-left">
          <div className="header-logo">EM</div>
          <div className="header-chat-info">
            <div className="header-chat-name-row">
              <span className="header-chat-name">{chatName || 'Чат'}</span>
              <span className="header-seed-badge">#{seedShort}</span>
            </div>
            <div className="header-meta-row">
              <span className={`header-status-dot ${status === 'online' ? 'dot-online' : status === 'offline' ? 'dot-offline' : 'dot-connecting'}`} />
              <span className="header-status-text">
                {status === 'online' ? 'Подключено' : status === 'offline' ? 'Переподключение...' : 'Подключение...'}
              </span>
              {pingLabel && (
                <>
                  <span className="header-meta-sep">·</span>
                  <span className={`header-ping ${pingLabel.cls}`}>{pingLabel.text}</span>
                </>
              )}
              <span className="header-meta-sep">·</span>
              <span className="header-enc-badge">🔒 AES-256</span>
            </div>
          </div>
        </div>

        {/* Right: online count, media, nick, actions */}
        <div className="header-right">
          <div className="online-badge">
            <span className="online-dot" />
            <span>{onlineCount}</span>
          </div>
          <button
            className={'header-btn' + (showMediaPanel ? ' active' : '')}
            onClick={() => setShowMediaPanel(v => !v)}
            title="Медиафайлы чата"
          >📂</button>
          <div className="nick-badge">👤 {nickname}</div>
          <button className="leave-btn" onClick={onLeaveRoom} title="Сменить чат">← Чаты</button>
          <button className="logout-btn" onClick={onLogout}>Выйти</button>
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

      <main className="messages-area" ref={messagesAreaRef} onScroll={handleScroll}>
        {messages.length === 0 && status === 'online' && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p className="empty-title">Чат пуст</p>
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
