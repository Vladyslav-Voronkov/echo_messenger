import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { decryptImageToDataUrl } from '../utils/crypto.js';

export default function ImageMessage({ imageData, cryptoKey }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    if (!imageData || !cryptoKey) return;
    decryptImageToDataUrl(cryptoKey, imageData.iv, imageData.data, imageData.mime)
      .then(url => { setSrc(url); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [imageData, cryptoKey]);

  // Close on Escape
  useEffect(() => {
    if (!enlarged) return;
    const handler = (e) => { if (e.key === 'Escape') setEnlarged(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enlarged]);

  const handleOpen = () => { setEnlarged(true); setRotation(0); };
  const handleClose = () => setEnlarged(false);
  const rotateCW = useCallback((e) => { e.stopPropagation(); setRotation(r => (r + 90) % 360); }, []);
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

  const ext = imageData && imageData.mime ? (imageData.mime.split('/')[1] || 'jpg') : 'jpg';
  const downloadName = 'image.' + ext;

  const lightbox = enlarged ? createPortal(
    <div className="fullscreen-lightbox" onClick={handleClose}>
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
        <button className="fullscreen-btn close-btn" onClick={handleClose} title="Закрыть">✕</button>
      </div>
      <div className="fullscreen-lightbox-body" onClick={handleClose}>
        <img
          src={src}
          alt="изображение"
          style={imgStyle}
          onClick={e => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <div className="img-msg-wrapper" onClick={handleOpen}>
        <img src={src} alt="изображение" className="img-msg" />
        <div className="img-msg-overlay">🔍</div>
      </div>
      {lightbox}
    </>
  );
}
