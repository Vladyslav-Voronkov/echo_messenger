import { useState, useLayoutEffect, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

const MAX_ALBUM = 10;

// ── AlbumComposer ─────────────────────────────────────────────────────────────
//
// Blob URL lifecycle (StrictMode-safe):
//
// · State holds only File objects (fileList), never blob URLs.
//
// · Blob URLs live in the `previews` state array and are created/revoked
//   exclusively inside a useLayoutEffect([fileList]):
//   - useLayoutEffect is synchronous — URLs exist before the first browser
//     paint, so the photo grid is never visibly empty.
//   - Cleanup revokes all current URLs whenever fileList changes or the
//     component unmounts.
//   - In React StrictMode (dev) the simulated unmount calls the cleanup
//     (revokes URLs) and the simulated remount immediately re-runs the effect
//     (creates fresh URLs, calls setPreviews → re-render) — all before the
//     next paint, so no broken-image flash ever appears.
//
// · The auto-close guard is safe: fileList starts populated (lazy useState
//   initialiser), so the condition is always false on the first render.

export default function AlbumComposer({ files, onSend, onCancel }) {
  // fileList: File[] — initialised synchronously so auto-close never fires on mount.
  const [fileList, setFileList] = useState(() =>
    Array.from(files).slice(0, MAX_ALBUM)
  );
  const [caption, setCaption] = useState('');

  // previews: [{ file, url }] — rebuilt whenever fileList changes.
  const [previews, setPreviews] = useState([]);

  // Create blob URLs synchronously before first paint; revoke on cleanup.
  // StrictMode: cleanup revokes → remount re-creates (via setPreviews re-render)
  // all before the next paint → no broken images.
  useLayoutEffect(() => {
    const items = fileList.map(file => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(items);
    return () => items.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [fileList]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Auto-close when user removes ALL photos.
  // Safe: fileList starts populated, so condition is false on mount.
  useEffect(() => {
    if (fileList.length === 0 && files.length > 0) onCancel();
  }, [fileList.length, files.length, onCancel]);

  const removeAt = useCallback((idx) => {
    // useLayoutEffect([fileList]) handles URL cleanup automatically when
    // fileList changes — no manual revocation needed here.
    setFileList(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSend = useCallback(() => {
    if (!fileList.length) return;
    onSend(fileList, caption.trim()); // pass File objects directly
  }, [fileList, caption, onSend]);

  // useLayoutEffect runs before paint, so this null is never visible to user.
  if (!previews.length) return null;

  const single   = previews.length === 1;
  const gridCols = single ? 1 : previews.length === 2 ? 2 : 3;

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
