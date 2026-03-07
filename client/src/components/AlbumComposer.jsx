import { useState, useEffect, useCallback, useRef, createPortal } from 'react';

const MAX_ALBUM = 10;

// ── AlbumComposer ─────────────────────────────────────────────────────────────
//
// Design decisions to handle React StrictMode correctly:
//
// 1. State holds only File objects (fileList), NOT blob URLs.
//    Blob URLs are computed lazily at render time via a Map stored in a ref.
//
// 2. The blob URL Map (urlsRef) is populated during rendering and cleared in the
//    useEffect cleanup. Because the Map lives in a ref (not state), React's
//    Strict Mode "simulated unmount + remount" cycle works correctly:
//    cleanup clears the Map → next render repopulates it with fresh URLs.
//
// 3. The auto-close guard is trivial: fileList starts populated (lazy useState
//    initialiser), so the effect never fires on the first render.

export default function AlbumComposer({ files, onSend, onCancel }) {
  // fileList contains the selected File objects. Initialised synchronously so
  // the auto-close guard (which checks fileList.length) never fires on mount.
  const [fileList, setFileList] = useState(() =>
    Array.from(files).slice(0, MAX_ALBUM)
  );
  const [caption, setCaption] = useState('');

  // Map: File → blob URL. Lives in a ref so it survives re-renders but is
  // also cleared by the useEffect cleanup (which React runs on every unmount,
  // including Strict Mode's simulated one).
  const urlsRef = useRef(new Map());

  // Lazily create and cache a blob URL for each File.
  // Called during render — safe because the Map makes it idempotent.
  const getBlobUrl = useCallback((file) => {
    if (!urlsRef.current.has(file)) {
      urlsRef.current.set(file, URL.createObjectURL(file));
    }
    return urlsRef.current.get(file);
  }, []);

  // Revoke all blob URLs when the component unmounts (or on Strict Mode's
  // simulated unmount, after which getBlobUrl will recreate them on remount).
  useEffect(() => {
    return () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      urlsRef.current.clear();
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Auto-close when user removes ALL photos.
  // This is safe: fileList starts populated, so the condition is false on mount.
  useEffect(() => {
    if (fileList.length === 0 && files.length > 0) onCancel();
  }, [fileList.length, files.length, onCancel]);

  const removeAt = useCallback((idx) => {
    setFileList((prev) => {
      const removed = prev[idx];
      const url = urlsRef.current.get(removed);
      if (url) { URL.revokeObjectURL(url); urlsRef.current.delete(removed); }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSend = useCallback(() => {
    if (!fileList.length) return;
    onSend(fileList, caption.trim()); // pass File objects directly
  }, [fileList, caption, onSend]);

  if (!fileList.length) return null;

  // Build previews at render time using the cached URL map
  const previews  = fileList.map((file) => ({ file, url: getBlobUrl(file) }));
  const single    = previews.length === 1;
  const gridCols  = previews.length === 1 ? 1 : previews.length === 2 ? 2 : 3;

  return createPortal(
    <div className="album-composer-overlay" onClick={onCancel}>
      <div className="album-composer" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="album-composer-header">
          <span className="album-composer-title">
            {single ? 'Отправить фото' : `Отправить фото · ${previews.length}`}
          </span>
          <button className="album-composer-close" onClick={onCancel} title="Закрыть">✕</button>
        </div>

        {/* ── Photo grid ── */}
        <div
          className="album-composer-grid"
          style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
        >
          {previews.map((p, i) => (
            <div
              key={i}
              className={`album-composer-thumb${single ? ' album-composer-thumb-single' : ''}`}
            >
              <img src={p.url} alt="" className="album-composer-img" draggable={false} />
              <button
                className="album-composer-remove"
                onClick={() => removeAt(i)}
                title="Удалить"
              >✕</button>
            </div>
          ))}
        </div>

        {/* ── Caption input ── */}
        <div className="album-composer-caption-wrap">
          <textarea
            className="album-composer-caption"
            placeholder="Добавить подпись…"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={2}
            maxLength={1024}
          />
        </div>

        {/* ── Actions ── */}
        <div className="album-composer-actions">
          <button className="album-composer-cancel" onClick={onCancel}>Отмена</button>
          <button
            className="album-composer-send"
            onClick={handleSend}
            disabled={!fileList.length}
          >
            Отправить
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
