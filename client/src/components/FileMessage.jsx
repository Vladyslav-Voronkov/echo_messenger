import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { decryptImageToDataUrl, decryptFileFromBinary } from '../utils/crypto.js';

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getFileIcon(mime, name) {
  if (!mime && !name) return '📄';
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return '📕';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z') || n.match(/\.(zip|rar|7z|tar|gz)$/)) return '🗜️';
  if (m.includes('word') || n.match(/\.(doc|docx)$/)) return '📝';
  if (m.includes('excel') || m.includes('spreadsheet') || n.match(/\.(xls|xlsx|csv)$/)) return '📊';
  if (m.includes('presentation') || n.match(/\.(ppt|pptx)$/)) return '📊';
  if (m.startsWith('text/') || n.match(/\.(txt|md|js|ts|jsx|tsx|py|json|html|css)$/)) return '📃';
  return '📄';
}

function isPdf(mime, name) {
  return (mime || '').toLowerCase() === 'application/pdf' || (name || '').toLowerCase().endsWith('.pdf');
}

// Full-screen PDF Viewer rendered via portal directly into document.body
function PdfViewer({ pdfBytes, name, onClose }) {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [scale, setScale] = useState(1.4);
  const [rendering, setRendering] = useState(false);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
      const doc = await loadingTask.promise;
      if (!cancelled) { setPdfDoc(doc); setTotal(doc.numPages); setPage(1); }
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [pdfBytes]);

  const renderPage = useCallback(async (doc, pageNum, sc) => {
    if (!doc || !canvasRef.current) return;
    if (renderTaskRef.current) { renderTaskRef.current.cancel(); renderTaskRef.current = null; }
    setRendering(true);
    try {
      const pdfPage = await doc.getPage(pageNum);
      const viewport = pdfPage.getViewport({ scale: sc });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.error(e);
    } finally { setRendering(false); }
  }, []);

  useEffect(() => { if (pdfDoc) renderPage(pdfDoc, page, scale); }, [pdfDoc, page, scale, renderPage]);

  const goTo = (n) => { if (n >= 1 && n <= total) setPage(n); };
  const blobForDownload = pdfBytes ? URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' })) : null;

  return createPortal(
    <div className="pdf-fs-overlay" onClick={onClose}>
      <div className="pdf-fs-inner" onClick={e => e.stopPropagation()}>
        <div className="pdf-fs-topbar">
          <span className="pdf-fs-title">📕 {name}</span>
          <div className="pdf-fs-controls">
            <div className="pdf-nav">
              <button className="pdf-nav-btn" onClick={() => goTo(page - 1)} disabled={page <= 1}>◀</button>
              <span className="pdf-page-info">{total ? (page + ' / ' + total) : '...'}</span>
              <button className="pdf-nav-btn" onClick={() => goTo(page + 1)} disabled={page >= total}>▶</button>
            </div>
            <div className="pdf-zoom">
              <button className="pdf-nav-btn" onClick={() => setScale(s => Math.max(0.6, +(s - 0.2).toFixed(1)))} title="Уменьшить">−</button>
              <span className="pdf-page-info" style={{minWidth:'52px'}}>{Math.round(scale * 100)}%</span>
              <button className="pdf-nav-btn" onClick={() => setScale(s => Math.min(3.0, +(s + 0.2).toFixed(1)))} title="Увеличить">+</button>
            </div>
            {blobForDownload && (
              <a href={blobForDownload} download={name || 'document.pdf'} className="fullscreen-btn" title="Скачать PDF" onClick={e => e.stopPropagation()}>⬇</a>
            )}
            <button className="fullscreen-btn close-btn" onClick={onClose} title="Закрыть">✕</button>
          </div>
        </div>
        <div className="pdf-canvas-area">
          {rendering && <div className="pdf-rendering-overlay"><span className="spinner large" /></div>}
          <canvas ref={canvasRef} className="pdf-canvas" />
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── New-style file: has fileId, downloaded on demand ──────────────────────────
function RemoteFileMessage({ fileData, cryptoKey, roomId }) {
  const { fileId, name, mime, size } = fileData;
  const [dlState, setDlState] = useState('idle'); // idle | downloading | done | error
  const [dlPct, setDlPct] = useState(0);
  const [blobUrl, setBlobUrl] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [showPdf, setShowPdf] = useState(false);
  const blobUrlRef = useRef(null);
  const handleClose = useCallback(() => setShowPdf(false), []);

  // Cleanup blob URL on unmount
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); }, []);

  const handleDownload = useCallback(async () => {
    if (dlState === 'downloading') return;
    if (dlState === 'done' && blobUrl) {
      // Already downloaded — trigger download again
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name || 'file';
      a.click();
      return;
    }

    setDlState('downloading');
    setDlPct(0);
    try {
      // Download with XHR for progress
      const cipherBuf = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/files/' + roomId + '/' + fileId);
        xhr.responseType = 'arraybuffer';
        xhr.onprogress = (ev) => {
          if (ev.lengthComputable) setDlPct(Math.round((ev.loaded / ev.total) * 80));
        };
        xhr.onload = () => {
          if (xhr.status === 200) resolve(xhr.response);
          else reject(new Error('HTTP ' + xhr.status));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send();
      });

      setDlPct(85);

      // Fetch IV from meta
      const metaRes = await fetch('/files/' + roomId + '/' + fileId + '/meta');
      if (!metaRes.ok) throw new Error('Meta fetch failed');
      const meta = await metaRes.json();

      setDlPct(90);

      // Decrypt
      const plainBuf = await decryptFileFromBinary(cryptoKey, meta.iv, cipherBuf);
      setDlPct(99);

      const blob = new Blob([plainBuf], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setBlobUrl(url);

      if (isPdf(mime, name)) setPdfBytes(new Uint8Array(plainBuf));

      // Auto-trigger browser download
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'file';
      a.click();

      setDlPct(100);
      setDlState('done');
    } catch (err) {
      console.error('Download error:', err);
      setDlState('error');
    }
  }, [dlState, blobUrl, fileId, roomId, cryptoKey, mime, name]);

  const icon = getFileIcon(mime, name);
  const pdf = isPdf(mime, name);

  return (
    <>
      <div className="file-msg">
        <span className="file-msg-icon">{icon}</span>
        <div className="file-msg-info">
          <span className="file-msg-name">{name || 'файл'}</span>
          {size ? <span className="file-msg-size">{formatSize(size)}</span> : null}
        </div>
        <div className="file-msg-actions">
          {dlState === 'done' && pdf && pdfBytes && (
            <button className="file-action-btn" onClick={() => setShowPdf(true)} title="Открыть PDF">👁</button>
          )}
          {dlState === 'downloading' ? (
            <span className="file-dl-progress">
              <span className="spinner" style={{width:'14px',height:'14px'}} />
              {dlPct}%
            </span>
          ) : dlState === 'error' ? (
            <button className="file-action-btn" onClick={handleDownload} title="Повторить">↺</button>
          ) : (
            <button className="file-action-btn" onClick={handleDownload} title="Скачать">⬇</button>
          )}
        </div>
      </div>

      {showPdf && pdfBytes && <PdfViewer pdfBytes={pdfBytes} name={name} onClose={handleClose} />}
    </>
  );
}

// ── Old-style file: has iv+data base64 inline (legacy) ───────────────────────
function LegacyFileMessage({ fileData, cryptoKey }) {
  const [pdfBytes, setPdfBytes] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showPdf, setShowPdf] = useState(false);
  const blobUrlRef = useRef(null);
  const handleClose = useCallback(() => setShowPdf(false), []);

  useEffect(() => {
    if (!fileData || !cryptoKey) return;
    let cancelled = false;

    decryptImageToDataUrl(cryptoKey, fileData.iv, fileData.data, fileData.mime || 'application/octet-stream')
      .then(dataUrl => {
        if (cancelled) return;
        const arr = dataUrl.split(',');
        const mimeMatch = arr[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        const bstr = atob(arr[1]);
        const u8arr = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
        const blob = new Blob([u8arr], { type: mime });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        if (isPdf(mime, fileData.name)) setPdfBytes(u8arr);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, [fileData, cryptoKey]);

  if (loading) return (
    <div className="file-msg">
      <span className="spinner" style={{width:'18px',height:'18px'}} />
      <span className="file-msg-name">Расшифровка...</span>
    </div>
  );

  if (error) return (
    <div className="file-msg file-msg-error">
      <span>🔒</span>
      <span className="file-msg-name">Не удалось расшифровать</span>
    </div>
  );

  const mime = fileData.mime || '';
  const name = fileData.name || 'файл';
  const size = fileData.size;
  const icon = getFileIcon(mime, name);
  const pdf = isPdf(mime, name);

  return (
    <>
      <div className="file-msg">
        <span className="file-msg-icon">{icon}</span>
        <div className="file-msg-info">
          <span className="file-msg-name">{name}</span>
          {size ? <span className="file-msg-size">{formatSize(size)}</span> : null}
        </div>
        <div className="file-msg-actions">
          {pdf && pdfBytes && (
            <button className="file-action-btn" onClick={() => setShowPdf(true)} title="Открыть PDF">👁</button>
          )}
          <a href={blobUrl} download={name} className="file-action-btn" title="Скачать" onClick={e => e.stopPropagation()}>⬇</a>
        </div>
      </div>
      {showPdf && pdfBytes && <PdfViewer pdfBytes={pdfBytes} name={name} onClose={handleClose} />}
    </>
  );
}

// ── Main export: auto-detect format ──────────────────────────────────────────
export default function FileMessage({ fileData, cryptoKey, roomId }) {
  if (!fileData) return null;

  // New format: { fileId, name, mime, size }
  if (fileData.fileId) {
    return <RemoteFileMessage fileData={fileData} cryptoKey={cryptoKey} roomId={roomId} />;
  }

  // Legacy format: { iv, data, mime, name, size }
  return <LegacyFileMessage fileData={fileData} cryptoKey={cryptoKey} />;
}
