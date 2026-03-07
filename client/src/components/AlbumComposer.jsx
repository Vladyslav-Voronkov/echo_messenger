import { useState, useEffect, useCallback, createPortal } from 'react';

const MAX_ALBUM = 10;

export default function AlbumComposer({ files, onSend, onCancel }) {
  const [previews, setPreviews] = useState([]);   // [{ file, url }]
  const [caption, setCaption]   = useState('');

  // Build preview URLs on mount / when files change
  useEffect(() => {
    const items = Array.from(files).slice(0, MAX_ALBUM).map(file => ({
      file,
      url: URL.createObjectURL(file),
    }));
    setPreviews(items);
    return () => items.forEach(i => URL.revokeObjectURL(i.url));
  }, [files]);

  const removeAt = useCallback((idx) => {
    setPreviews(prev => {
      URL.revokeObjectURL(prev[idx].url);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // If all photos removed, close
  useEffect(() => {
    if (previews.length === 0 && files.length > 0) onCancel();
  }, [previews.length, files.length, onCancel]);

  const handleSend = useCallback(() => {
    if (!previews.length) return;
    onSend(previews.map(p => p.file), caption.trim());
  }, [previews, caption, onSend]);

  if (!previews.length) return null;

  const single = previews.length === 1;

  // Grid columns: 1→1col, 2→2col, 3+→3col (wrap)
  const gridCols = previews.length === 1 ? 1 : previews.length === 2 ? 2 : 3;

  return createPortal(
    <div className="album-composer-overlay" onClick={onCancel}>
      <div className="album-composer" onClick={e => e.stopPropagation()}>

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
            <div key={i} className={`album-composer-thumb${single ? ' album-composer-thumb-single' : ''}`}>
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
            onChange={e => setCaption(e.target.value)}
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
            disabled={!previews.length}
          >
            Отправить
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
