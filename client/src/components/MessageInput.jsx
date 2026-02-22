import { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import PdfTools from './PdfTools.jsx';
import { encryptImageBuffer, encryptNick, encryptMessage } from '../utils/crypto.js';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;

export default function MessageInput({ onSend, disabled, nickname, replyTo, onCancelReply, cryptoKey, roomId, socketRef }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showPdfTools, setShowPdfTools] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [text]);

  const handleSend = () => {
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') { if (replyTo) onCancelReply(); if (showEmoji) setShowEmoji(false); }
  };

  const insertEmoji = useCallback((emoji) => {
    const ta = textareaRef.current;
    if (!ta) { setText(t => t + emoji); return; }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setText(t => t.slice(0, start) + emoji + t.slice(end));
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + emoji.length;
      ta.focus();
    });
  }, []);

  const handleImageSelect = useCallback(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Только изображения (JPG, PNG, GIF, WebP)'); return; }
    if (file.size > MAX_IMAGE_SIZE) { alert('Максимальный размер фото: 5MB'); return; }

    setImgLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const encImage = await encryptImageBuffer(cryptoKey, arrayBuffer, file.type);
      const encNick = await encryptNick(cryptoKey, nickname);
      const payload = JSON.stringify({ type: 'image', image: encImage });
      const { iv, data } = await encryptMessage(cryptoKey, payload);
      socketRef.current.emit('message', {
        roomId,
        encrypted: { iv, data, ts: Date.now(), nick: encNick },
      });
    } catch (err) {
      console.error('Image send error:', err);
      alert('Ошибка отправки изображения');
    } finally {
      setImgLoading(false);
    }
  }, [cryptoKey, nickname, roomId, socketRef]);

  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { alert('Максимальный размер файла: 1GB'); return; }

    setImgLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const encFile = await encryptImageBuffer(cryptoKey, arrayBuffer, file.type || 'application/octet-stream');
      const encNick = await encryptNick(cryptoKey, nickname);
      const fileInfo = {
        iv: encFile.iv,
        data: encFile.data,
        mime: encFile.mime,
        name: file.name,
        size: file.size,
      };
      const payload = JSON.stringify({ type: 'file', file: fileInfo });
      const { iv, data } = await encryptMessage(cryptoKey, payload);
      socketRef.current.emit('message', {
        roomId,
        encrypted: { iv, data, ts: Date.now(), nick: encNick },
      });
    } catch (err) {
      console.error('File send error:', err);
      alert('Ошибка отправки файла');
    } finally {
      setImgLoading(false);
    }
  }, [cryptoKey, nickname, roomId, socketRef]);

  const placeholder = disabled ? 'Переподключение...'
    : imgLoading ? 'Шифрование...'
    : replyTo ? 'Ответ на сообщение...'
    : 'Сообщение от ' + nickname + '...';

  const emojiCls = 'emoji-toggle-btn' + (showEmoji ? ' active' : '');

  return (
    <div className="input-area">
      {replyTo && (
        <div className="reply-preview">
          <div className="reply-preview-content">
            <span className="reply-preview-label">↩ Ответ для</span>
            <span className="reply-preview-nick">{replyTo.nick}</span>
            <span className="reply-preview-text">
              {replyTo.text.length > 60 ? replyTo.text.slice(0, 60) + '...' : replyTo.text}
            </span>
          </div>
          <button className="reply-cancel-btn" onClick={onCancelReply} type="button">✕</button>
        </div>
      )}

      <div className="input-wrapper">
        <button
          type="button"
          className={emojiCls}
          onClick={() => setShowEmoji(v => !v)}
          disabled={disabled}
          title="Эмодзи"
        >😊</button>

        <button
          type="button"
          className="img-upload-btn"
          onClick={() => imageInputRef.current?.click()}
          disabled={disabled || imgLoading}
          title="Отправить фото"
        >
          {imgLoading ? <span className="spinner" style={{width:'16px',height:'16px'}} /> : '🖼️'}
        </button>

        <button
          type="button"
          className="img-upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || imgLoading}
          title="Отправить файл"
        >📎</button>

        <button
          type="button"
          className="img-upload-btn"
          onClick={() => setShowPdfTools(v => !v)}
          disabled={disabled || imgLoading}
          title="PDF инструменты (объединить / разбить)"
        >📄</button>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          style={{ display: 'none' }}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || imgLoading}
          rows={1}
          className="message-textarea"
        />

        <button
          className="send-btn"
          onClick={handleSend}
          disabled={disabled || !text.trim() || imgLoading}
          aria-label="Отправить"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>

      {showEmoji && (
        <EmojiPicker
          onSelect={insertEmoji}
          onClose={() => setShowEmoji(false)}
        />
      )}

      {showPdfTools && (
        <PdfTools
          cryptoKey={cryptoKey}
          roomId={roomId}
          socketRef={socketRef}
          nickname={nickname}
          onClose={() => setShowPdfTools(false)}
        />
      )}

      <p className="input-hint">Enter — отправить · Shift+Enter — перенос · Esc — закрыть</p>
    </div>
  );
}
