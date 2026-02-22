import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import Message from './Message.jsx';
import MessageInput from './MessageInput.jsx';
import { encryptMessage, encryptNick, decryptMessageObject } from '../utils/crypto.js';

// In dev: Vite proxies /socket.io → localhost:3001 automatically.
// In production: server serves the built client, so same origin = correct.
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

export default function ChatScreen({ session, onLeaveRoom, onLogout }) {
  const { nickname, roomId, cryptoKey } = session;
  const [messages, setMessages] = useState([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [replyTo, setReplyTo] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));
    socket.on('online_count', ({ count }) => setOnlineCount(count));

    socket.on('message', async ({ encrypted }) => {
      const msg = await decryptMessageObject(cryptoKey, encrypted);
      if (!msg) return;
      setMessages(prev => [
        ...prev,
        { ...msg, id: 'live-' + Date.now() + '-' + Math.random(), isOwn: msg.nick === nickname },
      ]);
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

  const handleReply = useCallback((msg) => setReplyTo({ id: msg.id, nick: msg.nick, text: msg.text }), []);
  const handleCancelReply = useCallback(() => setReplyTo(null), []);

  const handleScrollToMessage = useCallback((msgId) => {
    const el = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(msgId);
    setTimeout(() => setHighlightId(null), 1500);
  }, []);

  const statusInfo = {
    connecting: { label: 'Подключение...', cls: 'status-connecting' },
    online:     { label: '🔒 Зашифровано', cls: 'status-online' },
    offline:    { label: 'Переподключение...', cls: 'status-offline' },
  }[status];

  return (
    <div className="chat-container">
      <header className="chat-header glass">
        <div className="header-left">
          <div className="header-logo">LC</div>
          <div className="header-info">
            <span className="header-title">LEGITCHAT</span>
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

      <main className="messages-area" ref={messagesAreaRef}>
        {messages.length === 0 && status === 'online' && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p className="empty-title">Комната пуста</p>
            <p className="empty-hint">Напишите первое сообщение. Оно будет зашифровано.</p>
          </div>
        )}
        {messages.length === 0 && status === 'connecting' && (
          <div className="empty-state">
            <div className="spinner large" />
            <p className="empty-hint" style={{ marginTop: 12 }}>Загрузка...</p>
          </div>
        )}
        {messages.map(msg => (
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
          />
        ))}
        <div ref={messagesEndRef} />
      </main>

      <footer className="chat-footer glass">
        <MessageInput
          onSend={handleSend}
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
