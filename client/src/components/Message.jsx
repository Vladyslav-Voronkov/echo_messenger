import { useState } from 'react';
import ImageMessage from './ImageMessage.jsx';
import FileMessage from './FileMessage.jsx';
import VoiceMessage from './VoiceMessage.jsx';
import { getNickColor } from '../utils/nickColor.js';

function parseMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === 'image' && parsed.image) {
      return { type: 'image', imageData: parsed.image, replyTo: null };
    }
    if (parsed && parsed.type === 'file' && parsed.file) {
      return { type: 'file', fileData: parsed.file, replyTo: null };
    }
    if (parsed && parsed.type === 'voice' && parsed.voice) {
      return { type: 'voice', voiceData: parsed.voice, replyTo: null };
    }
    if (parsed && typeof parsed.text === 'string') {
      return { type: 'text', text: parsed.text, replyTo: parsed.replyTo || null };
    }
  } catch {}
  return { type: 'text', text: raw, replyTo: null };
}

/* ── SVG icons (inline, no external dependency) ─── */
const IconReply = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 17 4 12 9 7"/>
    <path d="M20 18v-2a4 4 0 00-4-4H4"/>
  </svg>
);
const IconPin = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z"/>
  </svg>
);
const IconHeart = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
  </svg>
);

export default function Message({ message, onReply, onScrollToMessage, cryptoKey, highlighted, roomId, readReceipts, likes, onLike, pins, onPin }) {
  // System notification messages (join/leave/pin)
  if (message.type === 'system') {
    return (
      <div className="system-message">
        <span className="system-message-text">{message.text}</span>
      </div>
    );
  }
  const [hovered, setHovered] = useState(false);
  const { nick, ts, isOwn } = message;
  const parsed = parseMessage(message.text);

  // Nick color (deterministic)
  const nickColor = getNickColor(nick);

  // Show ✓✓ if at least one other user read up to (or past) this message's timestamp
  const isRead = isOwn && readReceipts &&
    Object.values(readReceipts).some(upToTs => upToTs >= ts);

  // likes is already an array of plaintext nicks (no decryption needed)
  const likeNicks = likes || [];

  // Is this message pinned?
  const isPinned = pins && pins.some(p => p.ts === ts);

  const time = new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit',
  });

  const displayText = parsed.type === 'text' ? parsed.text : null;
  const replyTo = parsed.replyTo || null;

  const rowCls = 'message-row ' + (isOwn ? 'own' : 'other') + (highlighted ? ' highlighted' : '');

  const handleReplyClick = () => {
    const replyText = parsed.type === 'image'
      ? 'Фотография'
      : parsed.type === 'file'
        ? (parsed.fileData && parsed.fileData.name ? parsed.fileData.name : 'Файл')
        : parsed.type === 'voice'
          ? 'Голосовое сообщение'
          : (parsed.text || message.text);
    onReply({ id: message.id, nick, text: replyText });
  };

  const handleQuoteClick = () => {
    if (replyTo && replyTo.id && onScrollToMessage) {
      onScrollToMessage(replyTo.id);
    }
  };

  return (
    <div
      className={rowCls}
      data-msg-id={message.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar for other users' messages */}
      {!isOwn && (
        <div
          className="msg-avatar"
          style={{ background: nickColor }}
          title={nick}
        >
          {nick ? nick[0].toUpperCase() : '?'}
        </div>
      )}

      {!isOwn && (
        <div className={'msg-actions msg-actions-left' + (hovered ? ' visible' : '')}>
          <button className="action-btn" onClick={handleReplyClick} title="Ответить">
            <IconReply />
          </button>
          {onPin && (
            <button
              className={'action-btn pin-btn' + (isPinned ? ' pinned' : '')}
              onClick={() => onPin(message)}
              title={isPinned ? 'Открепить' : 'Закрепить'}
            >
              <IconPin />
            </button>
          )}
        </div>
      )}

      <div className="message-bubble" onDoubleClick={() => onLike(message)}>
        {!isOwn && (
          <span className="message-nick" style={{ color: nickColor }}>{nick}</span>
        )}

        {replyTo && (
          <div
            className={'reply-quote' + (replyTo.id ? ' reply-quote-clickable' : '')}
            onClick={handleQuoteClick}
            title={replyTo.id ? 'Перейти к сообщению' : ''}
          >
            <span className="reply-quote-nick">{replyTo.nick}</span>
            <span className="reply-quote-text">
              {(replyTo.text?.length ?? 0) > 80 ? replyTo.text.slice(0, 80) + '...' : (replyTo.text || '')}
            </span>
          </div>
        )}

        {parsed.type === 'image' ? (
          <ImageMessage imageData={parsed.imageData} cryptoKey={cryptoKey} roomId={roomId} />
        ) : parsed.type === 'file' ? (
          <FileMessage fileData={parsed.fileData} cryptoKey={cryptoKey} roomId={roomId} />
        ) : parsed.type === 'voice' ? (
          <VoiceMessage
            fileId={parsed.voiceData.fileId}
            mime={parsed.voiceData.mime}
            duration={parsed.voiceData.duration}
            cryptoKey={cryptoKey}
            roomId={roomId}
          />
        ) : (
          <p className="message-text">{displayText}</p>
        )}

        <span className="message-time">{time}</span>
        {isRead && <span className="read-receipt">✓✓</span>}
      </div>

      {isOwn && (
        <div className={'msg-actions msg-actions-right' + (hovered ? ' visible' : '')}>
          {onPin && (
            <button
              className={'action-btn pin-btn' + (isPinned ? ' pinned' : '')}
              onClick={() => onPin(message)}
              title={isPinned ? 'Открепить' : 'Закрепить'}
            >
              <IconPin />
            </button>
          )}
          <button className="action-btn" onClick={handleReplyClick} title="Ответить">
            <IconReply />
          </button>
        </div>
      )}
      {likes && likes.length > 0 && (
        <div className={'like-badge' + (isOwn ? ' like-badge-own' : '')} onClick={() => onLike(message)}>
          <IconHeart />
          {likes.length > 1 && <span className="like-count">{likes.length}</span>}
          {likeNicks.length > 0 && (
            <span className="like-nicks">
              {likeNicks.map(n => n[0].toUpperCase()).join(' ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
