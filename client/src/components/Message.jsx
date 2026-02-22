import { useState } from 'react';
import ImageMessage from './ImageMessage.jsx';
import FileMessage from './FileMessage.jsx';
import VoiceMessage from './VoiceMessage.jsx';

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

export default function Message({ message, onReply, onScrollToMessage, cryptoKey, highlighted, roomId, readReceipts, likes, onLike }) {
  const [hovered, setHovered] = useState(false);
  const { nick, ts, isOwn } = message;
  const parsed = parseMessage(message.text);

  // Show ✓✓ if at least one other user read up to (or past) this message's timestamp
  const isRead = isOwn && readReceipts &&
    Object.values(readReceipts).some(upToTs => upToTs >= ts);

  // likes is already an array of plaintext nicks (no decryption needed)
  const likeNicks = likes || [];

  const time = new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit',
  });

  const displayText = parsed.type === 'text' ? parsed.text : null;
  const replyTo = parsed.replyTo || null;

  const rowCls = 'message-row ' + (isOwn ? 'own' : 'other') + (highlighted ? ' highlighted' : '');
  const replyLCls = 'reply-btn reply-btn-left' + (hovered ? ' visible' : '');
  const replyRCls = 'reply-btn reply-btn-right' + (hovered ? ' visible' : '');

  const handleReplyClick = () => {
    const replyText = parsed.type === 'image'
      ? '📸 Фотография'
      : parsed.type === 'file'
        ? ('📎 ' + (parsed.fileData && parsed.fileData.name ? parsed.fileData.name : 'Файл'))
        : parsed.type === 'voice'
          ? '🎙 Голосовое сообщение'
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
      {!isOwn && (
        <button
          className={replyLCls}
          onClick={handleReplyClick}
          title="Ответить"
        >↩</button>
      )}

      <div className="message-bubble" onDoubleClick={() => onLike(message)}>
        {!isOwn && <span className="message-nick">{nick}</span>}

        {replyTo && (
          <div
            className={'reply-quote' + (replyTo.id ? ' reply-quote-clickable' : '')}
            onClick={handleQuoteClick}
            title={replyTo.id ? 'Перейти к сообщению' : ''}
          >
            <span className="reply-quote-nick">{replyTo.nick}</span>
            <span className="reply-quote-text">
              {replyTo.text.length > 80 ? replyTo.text.slice(0, 80) + '...' : replyTo.text}
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
        <button
          className={replyRCls}
          onClick={handleReplyClick}
          title="Ответить"
        >↩</button>
      )}
      {likes && likes.length > 0 && (
        <div className={'like-badge' + (isOwn ? ' like-badge-own' : '')} onClick={() => onLike(message)}>
          ❤️
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
