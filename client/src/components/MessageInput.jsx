import { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import PdfTools from './PdfTools.jsx';
import { encryptNick, encryptMessage, encryptFileToBinary } from '../utils/crypto.js';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024;
const TYPING_DEBOUNCE_MS = 1500;

function formatRecTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export default function MessageInput({ onSend, onTyping, disabled, nickname, replyTo, onCancelReply, cryptoKey, roomId, socketRef }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showPdfTools, setShowPdfTools] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // null | { pct: 0-100, label: string }
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [cancelRecord, setCancelRecord] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimerRef = useRef(null);
  const isTypingRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordStartYRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const micStreamRef = useRef(null);
  const recordingTimeRef = useRef(0);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [text]);

  // Close attach menu when clicking outside
  useEffect(() => {
    if (!showAttachMenu) return;
    const close = () => setShowAttachMenu(false);
    document.addEventListener('click', close, { capture: true, once: true });
    return () => document.removeEventListener('click', close, { capture: true });
  }, [showAttachMenu]);

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

  // ── Voice recording ───────────────────────────────────────────────────────

  const stopMicStream = () => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
  };

  const handleMicPointerDown = useCallback(async (e) => {
    if (disabled || isRecording) return;
    e.preventDefault();
    recordStartYRef.current = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    setCancelRecord(false);
    audioChunksRef.current = [];

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert('Нет доступа к микрофону');
      return;
    }
    micStreamRef.current = stream;

    // Pick best supported mime type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg')
          ? 'audio/ogg'
          : '';

    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) audioChunksRef.current.push(ev.data);
    };

    mr.start(200); // collect chunks every 200ms
    recordingTimeRef.current = 0;
    setRecordingTime(0);
    setIsRecording(true);

    recordingTimerRef.current = setInterval(() => {
      recordingTimeRef.current += 1;
      setRecordingTime(recordingTimeRef.current);
    }, 1000);
  }, [disabled, isRecording]);

  const handleMicPointerUp = useCallback(async (e) => {
    if (!isRecording) return;
    e.preventDefault();

    clearInterval(recordingTimerRef.current);
    const duration = recordingTimeRef.current;
    setIsRecording(false);
    setRecordingTime(0);
    setCancelRecord(false);

    const currentY = e.clientY ?? e.changedTouches?.[0]?.clientY ?? recordStartYRef.current;
    const cancelled = currentY < recordStartYRef.current - 60;

    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === 'inactive') { stopMicStream(); return; }

    if (cancelled) {
      mr.stop();
      stopMicStream();
      audioChunksRef.current = [];
      return;
    }

    // Normal stop → send voice message
    mr.onstop = async () => {
      stopMicStream();
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      if (chunks.length === 0) return;

      const mimeType = mr.mimeType || 'audio/webm';
      const audioBlob = new Blob(chunks, { type: mimeType });

      setImgLoading(true);
      setUploadProgress({ pct: 0, label: 'Шифрование аудио...' });
      try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const { iv, blob: encBlob } = await encryptFileToBinary(cryptoKey, arrayBuffer);
        const encNick = await encryptNick(cryptoKey, nickname);

        setUploadProgress({ pct: 10, label: 'Загрузка...' });
        const formData = new FormData();
        formData.append('file', encBlob, 'voice.bin');
        const meta = JSON.stringify({
          iv, nick: encNick,
          name: 'voice.webm', mime: mimeType, size: audioBlob.size, ts: Date.now(),
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

        setUploadProgress({ pct: 99, label: 'Отправка...' });
        const payload = JSON.stringify({
          type: 'voice',
          voice: { fileId, mime: mimeType, duration: Math.max(1, duration) },
        });
        const { iv: msgIv, data: msgData } = await encryptMessage(cryptoKey, payload);
        socketRef.current.emit('message', {
          roomId,
          encrypted: { iv: msgIv, data: msgData, ts: Date.now(), nick: encNick },
        });
        setUploadProgress({ pct: 100, label: 'Готово!' });
        setTimeout(() => setUploadProgress(null), 800);
      } catch (err) {
        console.error('Voice send error:', err);
        setUploadProgress(null);
        alert('Ошибка отправки голосового: ' + err.message);
      } finally {
        setImgLoading(false);
      }
    };
    mr.stop();
  }, [isRecording, cryptoKey, nickname, roomId, socketRef]);

  const handleMicPointerMove = useCallback((e) => {
    if (!isRecording) return;
    const currentY = e.clientY ?? e.touches?.[0]?.clientY ?? recordStartYRef.current;
    setCancelRecord(currentY < recordStartYRef.current - 60);
  }, [isRecording]);

  // Cancel recording if pointer leaves window
  const handleMicPointerLeave = useCallback((e) => {
    if (!isRecording) return;
    // Only cancel if truly left the window (not just the button)
    if (e.target === document.documentElement || !e.relatedTarget) {
      handleMicPointerUp(e);
    }
  }, [isRecording, handleMicPointerUp]);

  const placeholder = disabled ? 'Переподключение...'
    : imgLoading ? 'Шифрование...'
    : replyTo ? 'Ответ на сообщение...'
    : 'Написать сообщение...';

  const showSendBtn = !!text.trim();

  return (
    <div className="input-area">
      {/* Reply preview strip */}
      {replyTo && (
        <div className="reply-preview">
          <div className="reply-preview-content">
            <span className="reply-preview-label">↩ Ответ</span>
            <span className="reply-preview-nick">{replyTo.nick}</span>
            <span className="reply-preview-text">
              {replyTo.text.length > 60 ? replyTo.text.slice(0, 60) + '...' : replyTo.text}
            </span>
          </div>
          <button className="reply-cancel-btn" onClick={onCancelReply} type="button">✕</button>
        </div>
      )}

      {/* Recording overlay */}
      {isRecording && (
        <div className={'recording-overlay' + (cancelRecord ? ' cancel' : '')}>
          <span className="recording-dot" />
          <span className="recording-time">{formatRecTime(recordingTime)}</span>
          <span className="recording-cancel-hint">
            {cancelRecord ? '🗑 Отпустите для отмены' : '↑ Потяните вверх для отмены'}
          </span>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageSelect} style={{ display: 'none' }} />
      <input ref={fileInputRef} type="file" accept="*/*" onChange={handleFileSelect} style={{ display: 'none' }} />

      {/* ── Modern pill input bar ── */}
      <div className="input-bar">
        {/* Left action buttons */}
        {!isRecording && (
          <div className="input-left-actions">
            {/* Attach popup */}
            <div className="attach-menu-wrap">
              <button
                type="button"
                className={'input-icon-btn' + (showAttachMenu ? ' active' : '')}
                onClick={(e) => { e.stopPropagation(); setShowAttachMenu(v => !v); }}
                disabled={disabled || imgLoading}
                title="Вложения"
              >
                {imgLoading
                  ? <span className="spinner" style={{width:'15px',height:'15px'}} />
                  : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                }
              </button>

              {showAttachMenu && (
                <div className="attach-menu" onClick={e => e.stopPropagation()}>
                  <button className="attach-menu-item" onClick={() => { imageInputRef.current?.click(); setShowAttachMenu(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    Фото / видео
                  </button>
                  <button className="attach-menu-item" onClick={() => { fileInputRef.current?.click(); setShowAttachMenu(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                    Файл
                  </button>
                  <button className="attach-menu-item" onClick={() => { setShowPdfTools(v => !v); setShowAttachMenu(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    PDF инструменты
                  </button>
                </div>
              )}
            </div>

            {/* Emoji */}
            <button
              type="button"
              className={'input-icon-btn' + (showEmoji ? ' active' : '')}
              onClick={() => setShowEmoji(v => !v)}
              disabled={disabled}
              title="Эмодзи"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            </button>
          </div>
        )}

        {/* Text area */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => { setText(e.target.value); if (e.target.value) notifyTyping(); else stopTyping(); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || imgLoading || isRecording}
          rows={1}
          className="message-textarea"
        />

        {/* Right: send or mic */}
        {showSendBtn ? (
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={disabled || !text.trim() || imgLoading}
            aria-label="Отправить"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        ) : (
          <button
            className={'mic-btn' + (isRecording ? ' recording' : '') + (cancelRecord ? ' cancel' : '')}
            onPointerDown={handleMicPointerDown}
            onPointerUp={handleMicPointerUp}
            onPointerMove={handleMicPointerMove}
            onPointerLeave={handleMicPointerLeave}
            onPointerCancel={handleMicPointerUp}
            disabled={disabled || imgLoading}
            aria-label={isRecording ? 'Остановить запись' : 'Записать голосовое'}
            title={isRecording ? 'Отпустите для отправки' : 'Удерживайте для записи'}
          >
            {isRecording
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            }
          </button>
        )}
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
    </div>
  );
}
