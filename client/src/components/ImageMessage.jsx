import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { decryptImageToDataUrl, decryptFileFromBinary } from '../utils/crypto.js';

// ── Shared lightbox (portal into document.body) ───────────────────────────
function Lightbox({ src, mime, onClose }) {
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const rotateCW  = useCallback((e) => { e.stopPropagation(); setRotation(r => (r + 90) % 360); }, []);
  const rotateCCW = useCallback((e) => { e.stopPropagation(); setRotation(r => (r - 90 + 360) % 360); }, []);

  const isHoriz = rotation === 90 || rotation === 270;
  const imgStyle = {
    transform: 'rotate(' + rotation + 'deg)',
    transition: 'transform 0.3s ease',
    maxWidth: isHoriz ? '80vh' : '90vw',
    maxHeight: isHoriz ? '90vw' : '80vh',
    objectFit: 'contain',
    borderRadius: '8px',
    boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
  };

  const ext = mime ? (mime.split('/')[1] || 'jpg') : 'jpg';
  const downloadName = 'image.' + ext;

  return createPortal(
    <div className="fullscreen-lightbox" onClick={onClose}>
      <div className="fullscreen-lightbox-topbar" onClick={e => e.stopPropagation()}>
        <div className="fullscreen-lightbox-actions">
          <button className="fullscreen-btn" onClick={rotateCCW} title="Повернуть влево">↺</button>
          <button className="fullscreen-btn" onClick={rotateCW} title="Повернуть вправо">↻</button>
          <a
            href={src}
            download={downloadName}
            className="fullscreen-btn"
            title="Сохранить"
            onClick={e => e.stopPropagation()}
          >⬇</a>
        </div>
        <button className="fullscreen-btn close-btn" onClick={onClose} title="Закрыть">✕</button>
      </div>
      <div className="fullscreen-lightbox-body" onClick={onClose}>
        <img
          src={src}
          alt="изображение"
          style={imgStyle}
          onClick={e => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body
  );
}

// ── New-style image: has fileId, downloaded on mount ──────────────────────
function RemoteImageMessage({ imageData, cryptoKey, roomId }) {
  const { fileId, mime } = imageData;
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const blobUrlRef = useRef(null);
  const handleClose = useCallback(() => setEnlarged(false), []);

  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); }, []);

  useEffect(() => {
    if (!fileId || !cryptoKey) return;
    let cancelled = false;

    async function load() {
      try {
        // Download encrypted binary
        const cipherBuf = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/files/' + roomId + '/' + fileId);
          xhr.responseType = 'arraybuffer';
          xhr.onload = () => {
            if (xhr.status === 200) resolve(xhr.response);
            else reject(new Error('HTTP ' + xhr.status));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send();
        });

        // Fetch IV from meta
        const metaRes = await fetch('/files/' + roomId + '/' + fileId + '/meta');
        if (!metaRes.ok) throw new Error('Meta fetch failed');
        const meta = await metaRes.json();

        // Decrypt
        const plainBuf = await decryptFileFromBinary(cryptoKey, meta.iv, cipherBuf);
        if (cancelled) return;

        const blob = new Blob([plainBuf], { type: mime || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setSrc(url);
        setLoading(false);
      } catch (err) {
        console.error('Remote image load error:', err);
        if (!cancelled) { setError(true); setLoading(false); }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [fileId, roomId, cryptoKey, mime]);

  if (loading) {
    return (
      <div className="img-msg-placeholder">
        <span className="spinner" />
        <span>Загрузка...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="img-msg-placeholder error">
        <span>🔒</span>
        <span>Не удалось загрузить</span>
      </div>
    );
  }

  return (
    <>
      <div className="img-msg-wrapper" onClick={() => setEnlarged(true)}>
        <img src={src} alt="изображение" className="img-msg" />
        <div className="img-msg-overlay">🔍</div>
      </div>
      {enlarged && <Lightbox src={src} mime={mime} onClose={handleClose} />}
    </>
  );
}

// ── Legacy image: has iv+data base64 inline ───────────────────────────────
function LegacyImageMessage({ imageData, cryptoKey }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const handleClose = useCallback(() => setEnlarged(false), []);

  useEffect(() => {
    if (!imageData || !cryptoKey) return;
    decryptImageToDataUrl(cryptoKey, imageData.iv, imageData.data, imageData.mime)
      .then(url => { setSrc(url); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [imageData, cryptoKey]);

  if (loading) {
    return (
      <div className="img-msg-placeholder">
        <span className="spinner" />
        <span>Расшифровка...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="img-msg-placeholder error">
        <span>🔒</span>
        <span>Не удалось расшифровать</span>
      </div>
    );
  }

  return (
    <>
      <div className="img-msg-wrapper" onClick={() => setEnlarged(true)}>
        <img src={src} alt="изображение" className="img-msg" />
        <div className="img-msg-overlay">🔍</div>
      </div>
      {enlarged && <Lightbox src={src} mime={imageData.mime} onClose={handleClose} />}
    </>
  );
}

// ── Main export: auto-detect format ──────────────────────────────────────
export default function ImageMessage({ imageData, cryptoKey, roomId }) {
  if (!imageData) return null;

  // New format: { fileId, mime, size }
  if (imageData.fileId) {
    return <RemoteImageMessage imageData={imageData} cryptoKey={cryptoKey} roomId={roomId} />;
  }

  // Legacy format: { iv, data, mime }
  return <LegacyImageMessage imageData={imageData} cryptoKey={cryptoKey} />;
}
