import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { decryptImageToDataUrl } from '../utils/crypto.js';

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

  // Close on Escape
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
      if (!cancelled) {
        setPdfDoc(doc);
        setTotal(doc.numPages);
        setPage(1);
      }
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [pdfBytes]);

  const renderPage = useCallback(async (doc, pageNum, sc) => {
    if (!doc || !canvasRef.current) return;
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
    setRendering(true);
    try {
      const pdfPage = await doc.getPage(pageNum);
      const viewport = pdfPage.getViewport({ scale: sc });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      const task = pdfPage.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.error(e);
    } finally {
      setRendering(false);
    }
  }, []);

  useEffect(() => {
    if (pdfDoc) renderPage(pdfDoc, page, scale);
  }, [pdfDoc, page, scale, renderPage]);

  const goTo = (n) => {
    if (n < 1 || n > total) return;
    setPage(n);
  };

  const downloadName = name || 'document.pdf';
  const blobForDownload = pdfBytes
    ? URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }))
    : null;

  return createPortal(
    <div className="pdf-fs-overlay" onClick={onClose}>
      <div className="pdf-fs-inner" onClick={e => e.stopPropagation()}>

        {/* Top bar */}
        <div className="pdf-fs-topbar">
          <span className="pdf-fs-title">📕 {name}</span>

          <div className="pdf-fs-controls">
            {/* Page navigation */}
            <div className="pdf-nav">
              <button className="pdf-nav-btn" onClick={() => goTo(page - 1)} disabled={page <= 1}>◀</button>
              <span className="pdf-page-info">{total ? (page + ' / ' + total) : '...'}</span>
              <button className="pdf-nav-btn" onClick={() => goTo(page + 1)} disabled={page >= total}>▶</button>
            </div>

            {/* Zoom */}
            <div className="pdf-zoom">
              <button className="pdf-nav-btn" onClick={() => setScale(s => Math.max(0.6, +(s - 0.2).toFixed(1)))} title="Уменьшить">−</button>
              <span className="pdf-page-info" style={{minWidth:'52px'}}>{Math.round(scale * 100)}%</span>
              <button className="pdf-nav-btn" onClick={() => setScale(s => Math.min(3.0, +(s + 0.2).toFixed(1)))} title="Увеличить">+</button>
            </div>

            {/* Download */}
            {blobForDownload && (
              <a
                href={blobForDownload}
                download={downloadName}
                className="fullscreen-btn"
                title="Скачать PDF"
                onClick={e => e.stopPropagation()}
              >⬇</a>
            )}

            {/* Close */}
            <button className="fullscreen-btn close-btn" onClick={onClose} title="Закрыть">✕</button>
          </div>
        </div>

        {/* Canvas area */}
        <div className="pdf-canvas-area">
          {rendering && (
            <div className="pdf-rendering-overlay">
              <span className="spinner large" />
            </div>
          )}
          <canvas ref={canvasRef} className="pdf-canvas" />
        </div>

      </div>
    </div>,
    document.body
  );
}

export default function FileMessage({ fileData, cryptoKey }) {
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
      .catch(() => {
        if (!cancelled) { setError(true); setLoading(false); }
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, [fileData, cryptoKey]);

  if (loading) {
    return (
      <div className="file-msg">
        <span className="spinner" style={{width:'18px',height:'18px'}} />
        <span className="file-msg-name">Расшифровка...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-msg file-msg-error">
        <span>🔒</span>
        <span className="file-msg-name">Не удалось расшифровать</span>
      </div>
    );
  }

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

      {showPdf && pdfBytes && (
        <PdfViewer pdfBytes={pdfBytes} name={name} onClose={handleClose} />
      )}
    </>
  );
}
