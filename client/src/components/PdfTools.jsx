import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PDFDocument } from 'pdf-lib';
import { encryptFileToBinary, encryptNick, encryptMessage } from '../utils/crypto.js';

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function parseRange(str, total) {
  const parts = str.split(',').map(s => s.trim()).filter(Boolean);
  const indices = new Set();
  for (const part of parts) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(s => parseInt(s.trim(), 10));
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          if (i >= 1 && i <= total) indices.add(i - 1);
        }
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= total) indices.add(n - 1);
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

// Render first page of a PDF bytes to a canvas data URL (thumbnail)
async function renderPdfThumb(pdfBytes, pageIndex) {
  try {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();
    const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/png');
  } catch { return null; }
}

async function splitByChunk(pdfBytes, chunkSize) {
  const src = await PDFDocument.load(pdfBytes);
  const total = src.getPageCount();
  const results = [];
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(start + chunkSize, total);
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
    pages.forEach(p => newDoc.addPage(p));
    const bytes = await newDoc.save();
    const pStart = start + 1;
    const pEnd = end;
    results.push({ bytes, name: 'pages_' + pStart + (pStart !== pEnd ? '-' + pEnd : '') + '.pdf', pageLabel: 'стр. ' + pStart + (pStart !== pEnd ? '–' + pEnd : '') });
  }
  return results;
}

async function splitByRange(pdfBytes, rangeStr) {
  const src = await PDFDocument.load(pdfBytes);
  const total = src.getPageCount();
  const indices = parseRange(rangeStr, total);
  if (!indices.length) return null;
  const newDoc = await PDFDocument.create();
  const pages = await newDoc.copyPages(src, indices);
  pages.forEach(p => newDoc.addPage(p));
  const bytes = await newDoc.save();
  const label = 'стр. ' + (indices[0] + 1) + (indices.length > 1 ? '–' + (indices[indices.length - 1] + 1) : '');
  return [{ bytes, name: 'pages_' + (indices[0] + 1) + '-' + (indices[indices.length - 1] + 1) + '.pdf', pageLabel: label }];
}

// ── PDF Thumbnail card ─────────────────────────────────────────────────────
function PdfCard({ file, index, total, onMoveUp, onMoveDown, onRemove, thumb }) {
  return (
    <div className="pdftool-card">
      <div className="pdftool-card-thumb">
        {thumb
          ? <img src={thumb} alt="preview" className="pdftool-card-img" />
          : <div className="pdftool-card-thumb-placeholder"><span className="spinner" style={{width:'18px',height:'18px'}} /></div>
        }
      </div>
      <div className="pdftool-card-info">
        <span className="pdftool-card-num">#{index + 1}</span>
        <span className="pdftool-card-name" title={file.name}>📕 {file.name}</span>
        <span className="pdftool-card-size">{formatSize(file.size)}</span>
      </div>
      <div className="pdftool-card-btns">
        <button className="pdftool-filebtn" onClick={() => onMoveUp(index)} disabled={index === 0} title="Выше">↑</button>
        <button className="pdftool-filebtn" onClick={() => onMoveDown(index)} disabled={index === total - 1} title="Ниже">↓</button>
        <button className="pdftool-filebtn danger" onClick={() => onRemove(index)} title="Удалить">✕</button>
      </div>
    </div>
  );
}

// ── Preview of split result ────────────────────────────────────────────────
function SplitPreview({ parts, sourceThumb }) {
  if (!parts || !parts.length) return null;
  return (
    <div className="split-preview">
      <div className="split-preview-label">Результат: {parts.length} файл{parts.length === 1 ? '' : parts.length < 5 ? 'а' : 'ов'}</div>
      <div className="split-preview-cards">
        {parts.map((p, i) => (
          <div key={i} className="split-preview-card">
            {sourceThumb
              ? <img src={sourceThumb} alt="" className="split-preview-thumb" />
              : <div className="split-preview-thumb-ph">📕</div>
            }
            <div className="split-preview-card-name">{p.pageLabel}</div>
            <div className="split-preview-card-file">{p.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Merge Panel ────────────────────────────────────────────────────────────
function MergePanel({ onSend, onClose }) {
  const [files, setFiles] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const addFiles = async (e) => {
    const newFiles = Array.from(e.target.files || []).filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    e.target.value = '';
    if (!newFiles.length) return;
    setFiles(prev => [...prev, ...newFiles]);
    setError('');
    // Generate thumbnails
    for (const f of newFiles) {
      const buf = await f.arrayBuffer();
      const thumb = await renderPdfThumb(new Uint8Array(buf), 0);
      if (thumb) setThumbs(t => ({ ...t, [f.name + f.size]: thumb }));
    }
  };

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));
  const moveUp = (i) => {
    if (i === 0) return;
    setFiles(prev => { const a = [...prev]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  };
  const moveDown = (i) => {
    setFiles(prev => {
      if (i >= prev.length - 1) return prev;
      const a = [...prev]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a;
    });
  };

  const handleMerge = async () => {
    if (files.length < 2) { setError('Добавьте минимум 2 PDF файла'); return; }
    setBusy(true); setError('');
    try {
      const merged = await PDFDocument.create();
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const src = await PDFDocument.load(buf);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      }
      const bytes = await merged.save();
      await onSend(bytes, 'merged.pdf');
      onClose();
    } catch (e) {
      setError('Ошибка: ' + e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="pdftool-panel">
      <div className="pdftool-body">
        <div className="pdftool-dropzone" onClick={() => inputRef.current?.click()}>
          <div className="pdftool-dropzone-icon">📁</div>
          <div>Нажмите чтобы добавить PDF файлы</div>
          <div className="pdftool-hint">Порядок файлов = порядок страниц в итоговом документе</div>
          <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple onChange={addFiles} style={{display:'none'}} />
        </div>

        {files.length > 0 && (
          <div className="pdftool-cards">
            {files.map((f, i) => (
              <PdfCard
                key={f.name + f.size + i}
                file={f}
                index={i}
                total={files.length}
                onMoveUp={moveUp}
                onMoveDown={moveDown}
                onRemove={removeFile}
                thumb={thumbs[f.name + f.size]}
              />
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="merge-arrow-hint">
            ↓ объединится в один файл <strong>merged.pdf</strong>
          </div>
        )}

        {error && <div className="pdftool-error">{error}</div>}

        <button className="pdftool-action-btn" onClick={handleMerge} disabled={busy || files.length < 2}>
          {busy
            ? <><span className="spinner" style={{width:'14px',height:'14px'}} /> Объединение...</>
            : '🔗 Объединить и отправить в чат'}
        </button>
      </div>
    </div>
  );
}

// ── Split Panel ────────────────────────────────────────────────────────────
function SplitPanel({ onSend, onClose }) {
  const [file, setFile] = useState(null);
  const [pdfInfo, setPdfInfo] = useState(null);
  const [thumb, setThumb] = useState(null);
  const [mode, setMode] = useState('chunk');
  const [chunkInput, setChunkInput] = useState('2');
  const [rangeInput, setRangeInput] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const loadFile = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError(''); setPreview(null);
    setFile(f);
    try {
      const buf = await f.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const total = doc.getPageCount();
      const u8 = new Uint8Array(buf);
      setPdfInfo({ buf: u8, total });
      const t = await renderPdfThumb(u8, 0);
      setThumb(t);
    } catch {
      setError('Не удалось прочитать PDF');
      setFile(null); setPdfInfo(null);
    }
  };

  // Compute preview whenever inputs change
  useEffect(() => {
    if (!pdfInfo) { setPreview(null); return; }
    if (mode === 'chunk') {
      const n = parseInt(chunkInput, 10);
      if (!n || n < 1) { setPreview(null); return; }
      const total = pdfInfo.total;
      const parts = [];
      for (let start = 0; start < total; start += n) {
        const end = Math.min(start + n, total);
        const pStart = start + 1;
        const pEnd = end;
        parts.push({ pageLabel: 'стр. ' + pStart + (pStart !== pEnd ? '–' + pEnd : ''), name: 'pages_' + pStart + (pStart !== pEnd ? '-' + pEnd : '') + '.pdf' });
      }
      setPreview(parts);
    } else {
      if (!rangeInput.trim()) { setPreview(null); return; }
      const indices = parseRange(rangeInput, pdfInfo.total);
      if (!indices.length) { setPreview(null); return; }
      const label = 'стр. ' + (indices[0] + 1) + (indices.length > 1 ? '–' + (indices[indices.length - 1] + 1) : '');
      setPreview([{ pageLabel: label, name: 'pages_' + (indices[0] + 1) + '-' + (indices[indices.length - 1] + 1) + '.pdf' }]);
    }
  }, [pdfInfo, mode, chunkInput, rangeInput]);

  const handleSplit = async () => {
    if (!pdfInfo) return;
    setBusy(true); setError('');
    try {
      let parts;
      if (mode === 'chunk') {
        const n = parseInt(chunkInput, 10);
        if (!n || n < 1) { setError('Укажите корректное число страниц'); setBusy(false); return; }
        parts = await splitByChunk(pdfInfo.buf, n);
      } else {
        parts = await splitByRange(pdfInfo.buf, rangeInput);
        if (!parts) { setError('Неверный диапазон страниц'); setBusy(false); return; }
      }
      for (const part of parts) await onSend(part.bytes, part.name);
      onClose();
    } catch (e) {
      setError('Ошибка: ' + e.message);
    } finally { setBusy(false); }
  };

  const modeChunkCls = 'pdftool-mode-btn' + (mode === 'chunk' ? ' active' : '');
  const modeRangeCls = 'pdftool-mode-btn' + (mode === 'range' ? ' active' : '');

  return (
    <div className="pdftool-panel">
      <div className="pdftool-body">
        {!file ? (
          <div className="pdftool-dropzone" onClick={() => inputRef.current?.click()}>
            <div className="pdftool-dropzone-icon">📁</div>
            <div>Нажмите чтобы выбрать PDF файл</div>
            <input ref={inputRef} type="file" accept=".pdf,application/pdf" onChange={loadFile} style={{display:'none'}} />
          </div>
        ) : (
          <div className="pdftool-source-file">
            {thumb && <img src={thumb} alt="preview" className="pdftool-source-thumb" />}
            <div className="pdftool-source-info">
              <span className="pdftool-card-name">📕 {file.name}</span>
              <span className="pdftool-card-size">{pdfInfo ? pdfInfo.total + ' стр.' : ''} · {formatSize(file.size)}</span>
            </div>
            <button className="pdftool-filebtn danger" onClick={() => { setFile(null); setPdfInfo(null); setPreview(null); setThumb(null); }}>✕</button>
          </div>
        )}

        {pdfInfo && (
          <>
            <div className="pdftool-modes">
              <button className={modeChunkCls} onClick={() => setMode('chunk')}>По N страниц</button>
              <button className={modeRangeCls} onClick={() => setMode('range')}>По диапазону</button>
            </div>

            {mode === 'chunk' ? (
              <div className="pdftool-field">
                <label className="pdftool-label">Разбить каждые N страниц:</label>
                <div className="pdftool-input-row">
                  <input
                    className="pdftool-input"
                    type="number"
                    min="1"
                    max={pdfInfo.total}
                    value={chunkInput}
                    onChange={e => setChunkInput(e.target.value)}
                  />
                  <span className="pdftool-hint">
                    {pdfInfo.total} стр. → {Math.ceil(pdfInfo.total / (parseInt(chunkInput) || 1))} файл(ов)
                  </span>
                </div>
              </div>
            ) : (
              <div className="pdftool-field">
                <label className="pdftool-label">
                  Диапазон страниц (напр. <code>1-3, 5, 8-10</code>):
                </label>
                <input
                  className="pdftool-input"
                  type="text"
                  value={rangeInput}
                  onChange={e => setRangeInput(e.target.value)}
                  placeholder="1-3, 5, 8-10"
                />
                <span className="pdftool-hint">Всего страниц: {pdfInfo.total}</span>
              </div>
            )}

            <SplitPreview parts={preview} sourceThumb={thumb} />
          </>
        )}

        {error && <div className="pdftool-error">{error}</div>}

        {pdfInfo && (
          <button className="pdftool-action-btn" onClick={handleSplit} disabled={busy || !preview}>
            {busy
              ? <><span className="spinner" style={{width:'14px',height:'14px'}} /> Разбивка...</>
              : '✂️ Разбить и отправить в чат (' + (preview ? preview.length : 0) + ' файл(ов))'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main PdfTools ──────────────────────────────────────────────────────────
export default function PdfTools({ cryptoKey, roomId, socketRef, nickname, onClose }) {
  const [tab, setTab] = useState('merge');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const sendPdf = useCallback(async (bytes, name) => {
    setSending(true);
    try {
      // slice() copies exact PDF bytes from pdf-lib's pooled ArrayBuffer
      const buf = bytes instanceof Uint8Array
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes;
      const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
      const mime = 'application/pdf';

      // 1. Encrypt to binary blob (same as regular file upload)
      const { iv, blob: encBlob } = await encryptFileToBinary(cryptoKey, buf);
      const encNick = await encryptNick(cryptoKey, nickname);

      // 2. Upload via XHR to /upload/:roomId
      const meta = JSON.stringify({ iv, nick: encNick, name, mime, size, ts: Date.now() });
      const formData = new FormData();
      formData.append('file', encBlob, 'encrypted.bin');

      const fileId = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload/' + roomId);
        xhr.setRequestHeader('x-file-meta', meta);
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

      // 3. Send small socket message referencing the uploaded file
      const payload = JSON.stringify({ type: 'file', file: { fileId, name, mime, size } });
      const { iv: msgIv, data: msgData } = await encryptMessage(cryptoKey, payload);
      socketRef.current.emit('message', {
        roomId,
        encrypted: { iv: msgIv, data: msgData, ts: Date.now(), nick: encNick },
      });
    } finally { setSending(false); }
  }, [cryptoKey, nickname, roomId, socketRef]);

  const tabMergeCls = 'pdftool-tab' + (tab === 'merge' ? ' active' : '');
  const tabSplitCls = 'pdftool-tab' + (tab === 'split' ? ' active' : '');

  return createPortal(
    <div className="pdftool-overlay" onClick={onClose}>
      <div className="pdftool-wrapper" onClick={e => e.stopPropagation()}>
        <div className="pdftool-tabs">
          <button className={tabMergeCls} onClick={() => setTab('merge')}>🔗 Объединить</button>
          <button className={tabSplitCls} onClick={() => setTab('split')}>✂️ Разбить</button>
          <div style={{flex:1}} />
          <button className="pdftool-close" onClick={onClose}>✕</button>
        </div>

        {sending && (
          <div className="pdftool-sending">
            <span className="spinner" style={{width:'16px',height:'16px'}} />
            <span>Шифрование и загрузка на сервер...</span>
          </div>
        )}

        {tab === 'merge' && <MergePanel onSend={sendPdf} onClose={onClose} />}
        {tab === 'split' && <SplitPanel onSend={sendPdf} onClose={onClose} />}
      </div>
    </div>,
    document.body
  );
}
