import { useState, useEffect } from 'react';
import ImageMessage from './ImageMessage.jsx';
import FileMessage from './FileMessage.jsx';
import { decryptNick } from '../utils/crypto.js';

function parseMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === 'image' && parsed.image) {
      return { type: 'image', imageData: parsed.image, replyTo: null };
    }
    if (parsed && parsed.type === 'file' && parsed.file) {
      return { type: 'file', fileData: parsed.file, replyTo: null };
    }
    if (parsed && typeof parsed.text === 'string') {
      return { type: 'text', text: parsed.text, replyTo: parsed.replyTo || null };
    }
  } catch {}
  return { type: 'text', text: raw, replyTo: null };
}

export default function Message({ message, onReply, onScrollToMessage, cryptoKey, highlighted, roomId, readReceipts }) {
  const [hovered, setHovered] = useState(false);
  const [readByNicks, setReadByNicks] = useState([]);
  const { nick, ts, isOwn } = message;
  const parsed = parseMessage(message.text);

  // Decrypt read receipt nicks for own messages
  useEffect(() => {
    if (!isOwn || !readReceipts || !cryptoKey) return;
    const entries = Object.entries(readReceipts);
    if (entries.length === 0) return;
    Promise.all(
      entries
        .filter(([, upToTs]) => upToTs >= ts)
        .map(([encNick]) => decryptNick(cryptoKey, encNick).catch(() => null))
    ).then(nicks => setReadByNicks(nicks.filter(Boolean)));
  }, [readReceipts, isOwn, ts, cryptoKey]);

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

      <div className="message-bubble">
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
        ) : (
          <p className="message-text">{displayText}</p>
        )}

        <span className="message-time">{time}</span>
        {isOwn && readByNicks.length > 0 && (
          <span className="read-receipt" title={readByNicks.join(', ')}>
            ✓✓ <span className="read-receipt-nicks">{readByNicks.join(', ')}</span>
          </span>
        )}
      </div>

      {isOwn && (
        <button
          className={replyRCls}
          onClick={handleReplyClick}
          title="Ответить"
        >↩</button>
      )}
    </div>
  );
}
