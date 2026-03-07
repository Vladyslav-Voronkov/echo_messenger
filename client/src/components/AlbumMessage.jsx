import { useState, useEffect, useRef, useCallback, createPortal } from 'react';
import { decryptFileFromBinary } from '../utils/crypto.js';

// ── Shared hook: load & decrypt one image from Echo storage ──────────────────

function useDecryptedImage(fileId, mime, cryptoKey, roomId) {
  const [src, setSrc]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(false);
  const blobRef = useRef(null);

  useEffect(() => {
    if (!fileId || !cryptoKey) return;
    let cancelled = false;

    (async () => {
      try {
        const cipherBuf = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', `/files/${roomId}/${fileId}`);
          xhr.responseType = 'arraybuffer';
          xhr.onload  = () => xhr.status === 200 ? resolve(xhr.response) : reject(new Error('HTTP ' + xhr.status));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send();
        });

        const metaRes = await fetch(`/files/${roomId}/${fileId}/meta`);
        if (!metaRes.ok) throw new Error('Meta failed');
        const { iv } = await metaRes.json();

        const plain = await decryptFileFromBinary(cryptoKey, iv, cipherBuf);
        if (cancelled) return;

        const blob = new Blob([plain], { type: mime || 'image/jpeg' });
        const url  = URL.createObjectURL(blob);
        if (blobRef.current) URL.revokeObjectURL(blobRef.current);
        blobRef.current = url;
        setSrc(url);
        setLoading(false);
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    })();

    return () => {
      cancelled = true;
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    };
  }, [fileId, mime, cryptoKey, roomId]);

  return { src, loading, error };
}

// ── Lightbox with prev / next navigation ─────────────────────────────────────

function AlbumLightbox({ images, startIndex, cryptoKey, roomId, onClose }) {
  const [idx, setIdx] = useState(startIndex);
  const cur  = images[idx];
  const prev = idx > 0             ? images[idx - 1] : null;
  const next = idx < images.length - 1 ? images[idx + 1] : null;

  const { src, loading } = useDecryptedImage(cur.fileId,  cur.mime,  cryptoKey, roomId);
  // Eagerly preload adjacent images
  useDecryptedImage(prev?.fileId ?? null, prev?.mime ?? null, cryptoKey, roomId);
  useDecryptedImage(next?.fileId ?? null, next?.mime ?? null, cryptoKey, roomId);

  const goPrev = useCallback(() => setIdx(i => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIdx(i => Math.min(images.length - 1, i + 1)), [images.length]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape')     onClose();
      if (e.key === 'ArrowLeft')  goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, goPrev, goNext]);

  const ext = (cur.mime || 'image/jpeg').split('/')[1] || 'jpg';

  return createPortal(
    <div className="fullscreen-lightbox" onClick={onClose}>
      <div className="fullscreen-lightbox-topbar" onClick={e => e.stopPropagation()}>
        <span className="album-lb-counter">{idx + 1} / {images.length}</span>
        <div className="fullscreen-lightbox-actions">
          {src && (
            <a
              href={src}
              download={`photo.${ext}`}
              className="fullscreen-btn"
              title="Сохранить"
              onClick={e => e.stopPropagation()}
            >⬇</a>
          )}
        </div>
        <button className="fullscreen-btn close-btn" onClick={onClose} title="Закрыть">✕</button>
      </div>

      <div className="fullscreen-lightbox-body" onClick={onClose}>
        {idx > 0 && (
          <button
            className="album-lb-nav album-lb-prev"
            onClick={e => { e.stopPropagation(); goPrev(); }}
            title="Назад"
          >‹</button>
        )}

        {loading ? (
          <span className="spinner album-lb-spinner" />
        ) : (
          <img
            src={src}
            alt=""
            className="album-lb-img"
            onClick={e => e.stopPropagation()}
          />
        )}

        {idx < images.length - 1 && (
          <button
            className="album-lb-nav album-lb-next"
            onClick={e => { e.stopPropagation(); goNext(); }}
            title="Вперёд"
          >›</button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Single grid cell ──────────────────────────────────────────────────────────

function AlbumCell({ fileId, mime, cryptoKey, roomId, overflowCount, onClick }) {
  const { src, loading, error } = useDecryptedImage(fileId, mime, cryptoKey, roomId);

  return (
    <div className="album-cell" onClick={onClick}>
      {loading && !src && (
        <div className="album-cell-placeholder"><span className="spinner" /></div>
      )}
      {error && (
        <div className="album-cell-placeholder album-cell-error"><span>🔒</span></div>
      )}
      {src && <img src={src} alt="" className="album-cell-img" draggable={false} />}
      {overflowCount > 0 && (
        <div className="album-overflow-overlay">+{overflowCount}</div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function AlbumMessage({ albumData, cryptoKey, roomId }) {
  const [lightboxIdx, setLightboxIdx] = useState(null);

  if (!albumData?.images?.length) return null;

  const { images, caption } = albumData;
  const visibleCount = Math.min(images.length, 4);
  const overflow     = images.length - 4;
  const gridClass    = `album-grid album-grid-${visibleCount}`;

  return (
    <div className="album-message">
      <div className={gridClass}>
        {images.slice(0, 4).map((img, i) => (
          <AlbumCell
            key={img.fileId}
            fileId={img.fileId}
            mime={img.mime}
            cryptoKey={cryptoKey}
            roomId={roomId}
            overflowCount={i === 3 && overflow > 0 ? overflow : 0}
            onClick={() => setLightboxIdx(i)}
          />
        ))}
      </div>

      {caption ? <p className="album-caption">{caption}</p> : null}

      {lightboxIdx !== null && (
        <AlbumLightbox
          images={images}
          startIndex={lightboxIdx}
          cryptoKey={cryptoKey}
          roomId={roomId}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}
