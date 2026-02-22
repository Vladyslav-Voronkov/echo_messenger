import { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import PdfTools from './PdfTools.jsx';
import { encryptNick, encryptMessage, encryptFileToBinary } from '../utils/crypto.js';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;
const TYPING_DEBOUNCE_MS = 1500;

export default function MessageInput({ onSend, onTyping, disabled, nickname, replyTo, onCancelReply, cryptoKey, roomId, socketRef }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showPdfTools, setShowPdfTools] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // null | { pct: 0-100, label: string }
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimerRef = useRef(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [text]);

  // Notify parent that user started/stopped typing (debounced)
  const notifyTyping = useCallback(() => {
    if (!onTyping) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      onTyping(true);
    }
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      onTyping(false);
    }, TYPING_DEBOUNCE_MS);
  }, [onTyping]);

  const stopTyping = useCallback(() => {
    if (!onTyping) return;
    clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);

  const handleSend = () => {
    if (!text.trim() || disabled) return;
    stopTyping();
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
    setUploadProgress({ pct: 0, label: 'Чтение файла...' });
    try {
      const arrayBuffer = await file.arrayBuffer();

      // Encrypt to binary blob (same approach as regular files)
      setUploadProgress({ pct: 5, label: 'Шифрование...' });
      const { iv, blob: encBlob } = await encryptFileToBinary(cryptoKey, arrayBuffer);
      const encNick = await encryptNick(cryptoKey, nickname);

      // Upload via XHR with progress
      setUploadProgress({ pct: 10, label: 'Загрузка 0%...' });
      const formData = new FormData();
      formData.append('file', encBlob, 'encrypted.bin');
      const meta = JSON.stringify({
        iv, nick: encNick,
        name: file.name, mime: file.type, size: file.size, ts: Date.now(),
      });

      const fileId = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload/' + roomId);
        xhr.setRequestHeader('x-file-meta', meta);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.round(10 + (ev.loaded / ev.total) * 88);
            setUploadProgress({ pct, label: 'Загрузка ' + Math.round((ev.loaded / ev.total) * 100) + '%...' });
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            try { resolve(JSON.parse(xhr.responseText).fileId); }
            catch { reject(new Error('Bad server response')); }
          } else reject(new Error('Upload failed: ' + xhr.status));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      // Send small socket message referencing the uploaded image
      setUploadProgress({ pct: 99, label: 'Отправка...' });
      const payload = JSON.stringify({ type: 'image', image: { fileId, mime: file.type, size: file.size } });
      const { iv: msgIv, data: msgData } = await encryptMessage(cryptoKey, payload);
      socketRef.current.emit('message', {
        roomId,
        encrypted: { iv: msgIv, data: msgData, ts: Date.now(), nick: encNick },
      });
      setUploadProgress({ pct: 100, label: 'Готово!' });
      setTimeout(() => setUploadProgress(null), 800);
    } catch (err) {
      console.error('Image send error:', err);
      setUploadProgress(null);
      alert('Ошибка отправки изображения: ' + err.message);
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
    setUploadProgress({ pct: 0, label: 'Чтение файла...' });
    try {
      // 1. Read file into memory
      const arrayBuffer = await file.arrayBuffer();

      // 2. Encrypt to binary blob (no base64 — stays binary, 1.33x less memory)
      setUploadProgress({ pct: 5, label: 'Шифрование...' });
      const { iv, blob: encBlob } = await encryptFileToBinary(cryptoKey, arrayBuffer);
      const encNick = await encryptNick(cryptoKey, nickname);

      // 3. Upload via XHR so we get progress events
      setUploadProgress({ pct: 10, label: 'Загрузка 0%...' });
      const formData = new FormData();
      formData.append('file', encBlob, 'encrypted.bin');

      const meta = JSON.stringify({
        iv,
        nick: encNick,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        ts: Date.now(),
      });

      const fileId = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload/' + roomId);
        xhr.setRequestHeader('x-file-meta', meta);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.round(10 + (ev.loaded / ev.total) * 88);
            setUploadProgress({ pct, label: 'Загрузка ' + Math.round((ev.loaded / ev.total) * 100) + '%...' });
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            try { resolve(JSON.parse(xhr.responseText).fileId); }
            catch { reject(new Error('Bad server response')); }
          } else {
            reject(new Error('Upload failed: ' + xhr.status));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      // 4. Send a small socket message referencing the uploaded file
      setUploadProgress({ pct: 99, label: 'Отправка...' });
      const payload = JSON.stringify({
        type: 'file',
        file: { fileId, name: file.name, mime: file.type || 'application/octet-stream', size: file.size },
      });
      const { iv: msgIv, data: msgData } = await encryptMessage(cryptoKey, payload);
      socketRef.current.emit('message', {
        roomId,
        encrypted: { iv: msgIv, data: msgData, ts: Date.now(), nick: encNick },
      });
      setUploadProgress({ pct: 100, label: 'Готово!' });
      setTimeout(() => setUploadProgress(null), 800);
    } catch (err) {
      console.error('File send error:', err);
      setUploadProgress(null);
      alert('Ошибка отправки файла: ' + err.message);
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
          onChange={e => { setText(e.target.value); if (e.target.value) notifyTyping(); else stopTyping(); }}
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

      {uploadProgress !== null && (
        <div className="upload-progress-bar">
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: uploadProgress.pct + '%' }} />
          </div>
          <span className="upload-progress-label">{uploadProgress.label}</span>
        </div>
      )}

      <p className="input-hint">Enter — отправить · Shift+Enter — перенос · Esc — закрыть</p>
    </div>
  );
}
