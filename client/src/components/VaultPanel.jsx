import { useState, useEffect, useRef, useCallback } from 'react';
import { deriveVaultKey, encryptVaultData, decryptVaultData, encryptFileToBinary, decryptFileFromBinary, bufToB64, b64ToBuf } from '../utils/crypto.js';

const VAULT_KEY_LS = 'echo_vault_key_v1'; // stores passphrase hash for re-derive

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconFolder = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity="0.9">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
  </svg>
);
const IconFile = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
    <polyline points="13 2 13 9 20 9"/>
  </svg>
);
const IconBack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const IconUpload = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
  </svg>
);
const IconNewFolder = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
  </svg>
);
const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const IconDownload = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
  </svg>
);
const IconShield = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
  </svg>
);

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fileExt(name) {
  const parts = (name || '').split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function VaultPanel({ nickname, passwordHash, isSuperAdmin, adminInfo, onManageAdmins }) {
  const [vaultKey, setVaultKey]       = useState(null);
  const [passphrase, setPassphrase]   = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking]     = useState(false);

  const [items, setItems]             = useState([]); // decrypted metadata items
  const [currentFolder, setCurrentFolder] = useState(null); // null = root
  const [folderStack, setFolderStack] = useState([]); // breadcrumb

  const [uploading, setUploading]     = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [loading, setLoading]         = useState(false);
  const [selected, setSelected]       = useState(null); // selected item id
  const [renamingId, setRenamingId]   = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);

  const fileInputRef = useRef(null);
  const vaultKeyRef  = useRef(null);

  // Keep ref in sync for callbacks
  useEffect(() => { vaultKeyRef.current = vaultKey; }, [vaultKey]);

  // ── Auth headers for API calls ─────────────────────────────────────────────
  const authHeaders = { 'x-nickname': nickname.toLowerCase(), 'x-password-hash': passwordHash };

  // ── Load metadata from server ──────────────────────────────────────────────
  const loadMeta = useCallback(async (key) => {
    setLoading(true);
    try {
      const res = await fetch('/vault/meta', { headers: authHeaders });
      const data = await res.json();
      if (!data.meta) { setItems([]); return; }
      const decrypted = await decryptVaultData(key, data.meta);
      setItems(Array.isArray(decrypted) ? decrypted : []);
    } catch (e) {
      console.error('Vault meta load error:', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [nickname, passwordHash]);

  // ── Save metadata to server ────────────────────────────────────────────────
  const saveMeta = useCallback(async (newItems, key) => {
    const k = key || vaultKeyRef.current;
    if (!k) return;
    const encrypted = await encryptVaultData(k, newItems);
    await fetch('/vault/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, passwordHash, meta: encrypted }),
    });
  }, [nickname, passwordHash]);

  // ── Unlock vault ───────────────────────────────────────────────────────────
  const handleUnlock = async () => {
    if (!passphrase.trim()) return;
    setUnlocking(true);
    setUnlockError('');
    try {
      const key = await deriveVaultKey(passphrase.trim());
      // Verify key is correct by trying to load meta
      const res = await fetch('/vault/meta', { headers: authHeaders });
      const data = await res.json();
      if (data.meta) {
        try {
          await decryptVaultData(key, data.meta);
        } catch {
          setUnlockError('Неверный пароль хранилища');
          return;
        }
      }
      // Store passphrase for re-derive (only in sessionStorage for security)
      sessionStorage.setItem(VAULT_KEY_LS, passphrase.trim());
      setVaultKey(key);
      await loadMeta(key);
    } catch (e) {
      setUnlockError('Ошибка разблокировки: ' + e.message);
    } finally {
      setUnlocking(false);
    }
  };

  // Try auto-unlock from sessionStorage on mount
  useEffect(() => {
    const saved = sessionStorage.getItem(VAULT_KEY_LS);
    if (saved) {
      deriveVaultKey(saved).then(key => {
        setVaultKey(key);
        loadMeta(key);
      }).catch(() => {});
    }
  }, []);

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !vaultKey) return;
    setUploading(true);
    setUploadProgress(0);

    const newItems = [...items];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(Math.round((i / files.length) * 90));
      try {
        const buffer = await file.arrayBuffer();
        const { iv, blob } = await encryptFileToBinary(vaultKey, buffer);
        const fileId = crypto.randomUUID();

        const formData = new FormData();
        formData.append('file', blob, fileId);

        const res = await fetch(`/vault/upload/${fileId}`, {
          method: 'POST',
          headers: authHeaders,
          body: formData,
        });
        if (!res.ok) throw new Error('Upload failed');

        newItems.push({
          id: fileId,
          name: file.name,
          type: 'file',
          parentId: currentFolder,
          size: file.size,
          iv,
          uploadedBy: nickname,
          createdAt: Date.now(),
        });
      } catch (err) {
        console.error('Upload error:', err);
      }
    }
    setItems(newItems);
    await saveMeta(newItems);
    setUploadProgress(100);
    setUploading(false);
    e.target.value = '';
  };

  // ── Create folder ──────────────────────────────────────────────────────────
  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const newItem = {
      id: crypto.randomUUID(),
      name,
      type: 'folder',
      parentId: currentFolder,
      createdAt: Date.now(),
    };
    const newItems = [...items, newItem];
    setItems(newItems);
    await saveMeta(newItems);
    setNewFolderName('');
    setShowNewFolder(false);
  };

  // ── Delete item ────────────────────────────────────────────────────────────
  const handleDelete = async (item) => {
    if (!window.confirm(`Удалить "${item.name}"?`)) return;
    // If folder, also delete children recursively
    const toDelete = [item.id];
    if (item.type === 'folder') {
      const collectChildren = (parentId) => {
        items.filter(i => i.parentId === parentId).forEach(child => {
          toDelete.push(child.id);
          if (child.type === 'folder') collectChildren(child.id);
        });
      };
      collectChildren(item.id);
    }
    // Delete files from server
    for (const id of toDelete) {
      const target = items.find(i => i.id === id);
      if (target?.type === 'file') {
        await fetch(`/vault/file/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, passwordHash }),
        });
      }
    }
    const newItems = items.filter(i => !toDelete.includes(i.id));
    setItems(newItems);
    await saveMeta(newItems);
    setSelected(null);
  };

  // ── Download file ──────────────────────────────────────────────────────────
  const handleDownload = async (item) => {
    if (!vaultKey || item.type !== 'file') return;
    try {
      const res = await fetch(`/vault/file/${item.id}`, { headers: authHeaders });
      if (!res.ok) throw new Error('Download failed');
      const encBuffer = await res.arrayBuffer();
      const decBuffer = await decryptFileFromBinary(vaultKey, item.iv, encBuffer);
      const blob = new Blob([decBuffer]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Ошибка скачивания: ' + e.message);
    }
  };

  // ── Rename ─────────────────────────────────────────────────────────────────
  const handleRename = async (item) => {
    const name = renameValue.trim();
    if (!name || name === item.name) { setRenamingId(null); return; }
    const newItems = items.map(i => i.id === item.id ? { ...i, name } : i);
    setItems(newItems);
    await saveMeta(newItems);
    setRenamingId(null);
  };

  // ── Navigate ───────────────────────────────────────────────────────────────
  const openFolder = (folder) => {
    setFolderStack(prev => [...prev, { id: currentFolder, name: currentFolder ? items.find(i => i.id === currentFolder)?.name : 'Хранилище' }]);
    setCurrentFolder(folder.id);
    setSelected(null);
  };

  const goBack = () => {
    const stack = [...folderStack];
    const prev = stack.pop();
    setFolderStack(stack);
    setCurrentFolder(prev?.id || null);
    setSelected(null);
  };

  // ── Current folder items ───────────────────────────────────────────────────
  const currentItems = items.filter(i => i.parentId === currentFolder);
  const folders = currentItems.filter(i => i.type === 'folder');
  const files   = currentItems.filter(i => i.type === 'file');

  // ── Unlock screen ──────────────────────────────────────────────────────────
  if (!vaultKey) {
    return (
      <div className="vault-unlock">
        <div className="vault-unlock-box">
          <div className="vault-unlock-icon"><IconShield /></div>
          <h2 className="vault-unlock-title">Зашифрованное хранилище</h2>
          <p className="vault-unlock-sub">
            {items.length === 0
              ? 'Введите пароль для создания хранилища. Этот пароль знают только администраторы.'
              : 'Введите пароль хранилища для доступа к файлам.'}
          </p>
          <input
            className="vault-unlock-input"
            type="password"
            placeholder="Пароль хранилища..."
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleUnlock()}
            autoFocus
          />
          {unlockError && <p className="vault-unlock-error">{unlockError}</p>}
          <button className="vault-unlock-btn" onClick={handleUnlock} disabled={unlocking || !passphrase.trim()}>
            {unlocking ? 'Открываю...' : 'Открыть'}
          </button>
        </div>
      </div>
    );
  }

  // ── Main vault UI ──────────────────────────────────────────────────────────
  return (
    <div className="vault-panel">

      {/* Header */}
      <div className="vault-header">
        <div className="vault-header-left">
          {currentFolder && (
            <button className="vault-back-btn" onClick={goBack} title="Назад">
              <IconBack />
            </button>
          )}
          <div className="vault-breadcrumb">
            <span className="vault-breadcrumb-root" onClick={() => { setCurrentFolder(null); setFolderStack([]); }}>
              🗄 Хранилище
            </span>
            {folderStack.slice(1).map((f, i) => (
              <span key={i} className="vault-breadcrumb-sep"> / <span>{f.name}</span></span>
            ))}
            {currentFolder && (
              <span className="vault-breadcrumb-sep"> / <span>{items.find(i => i.id === currentFolder)?.name}</span></span>
            )}
          </div>
        </div>
        <div className="vault-header-actions">
          {isSuperAdmin && (
            <button className="vault-action-btn" onClick={onManageAdmins} title="Управление админами">
              <IconShield /> Админы
            </button>
          )}
          <button className="vault-action-btn" onClick={() => setShowNewFolder(true)} title="Новая папка">
            <IconNewFolder /> Папка
          </button>
          <button className="vault-action-btn vault-action-btn--primary" onClick={() => fileInputRef.current?.click()} title="Загрузить файл" disabled={uploading}>
            <IconUpload /> {uploading ? `${uploadProgress}%` : 'Загрузить'}
          </button>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        </div>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="vault-newfolder-bar">
          <input
            className="vault-newfolder-input"
            type="text"
            placeholder="Название папки..."
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
            autoFocus
          />
          <button className="vault-action-btn vault-action-btn--primary" onClick={handleCreateFolder}>Создать</button>
          <button className="vault-action-btn" onClick={() => setShowNewFolder(false)}>Отмена</button>
        </div>
      )}

      {/* Upload progress bar */}
      {uploading && (
        <div className="vault-progress-bar">
          <div className="vault-progress-fill" style={{ width: uploadProgress + '%' }} />
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="vault-empty"><span className="spinner" /></div>
      ) : currentItems.length === 0 ? (
        <div className="vault-empty">
          <div className="vault-empty-icon">🗄</div>
          <p>Папка пуста</p>
          <p style={{ fontSize: 12, opacity: 0.5 }}>Нажмите «Загрузить» чтобы добавить файлы</p>
        </div>
      ) : (
        <div className="vault-grid">
          {/* Folders first */}
          {folders.map(folder => (
            <div
              key={folder.id}
              className={'vault-item vault-item--folder' + (selected === folder.id ? ' vault-item--selected' : '')}
              onClick={() => setSelected(folder.id)}
              onDoubleClick={() => openFolder(folder)}
            >
              <div className="vault-item-icon vault-item-icon--folder"><IconFolder /></div>
              {renamingId === folder.id ? (
                <input
                  className="vault-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => handleRename(folder)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRename(folder); if (e.key === 'Escape') setRenamingId(null); }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="vault-item-name" onDoubleClick={e => { e.stopPropagation(); setRenamingId(folder.id); setRenameValue(folder.name); }}>
                  {folder.name}
                </span>
              )}
              <span className="vault-item-date">{formatDate(folder.createdAt)}</span>
              {selected === folder.id && (
                <div className="vault-item-actions">
                  <button onClick={e => { e.stopPropagation(); openFolder(folder); }} title="Открыть">→</button>
                  <button onClick={e => { e.stopPropagation(); setRenamingId(folder.id); setRenameValue(folder.name); }} title="Переименовать">✎</button>
                  <button onClick={e => { e.stopPropagation(); handleDelete(folder); }} title="Удалить"><IconTrash /></button>
                </div>
              )}
            </div>
          ))}

          {/* Files */}
          {files.map(file => (
            <div
              key={file.id}
              className={'vault-item vault-item--file' + (selected === file.id ? ' vault-item--selected' : '')}
              onClick={() => setSelected(file.id)}
              onDoubleClick={() => handleDownload(file)}
            >
              <div className="vault-item-icon vault-item-icon--file">
                {fileExt(file.name) ? (
                  <span className="vault-file-ext">{fileExt(file.name)}</span>
                ) : <IconFile />}
              </div>
              {renamingId === file.id ? (
                <input
                  className="vault-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => handleRename(file)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRename(file); if (e.key === 'Escape') setRenamingId(null); }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="vault-item-name" title={file.name} onDoubleClick={e => { e.stopPropagation(); setRenamingId(file.id); setRenameValue(file.name); }}>
                  {file.name}
                </span>
              )}
              <span className="vault-item-meta">{formatSize(file.size)}</span>
              <span className="vault-item-date">{formatDate(file.createdAt)}</span>
              {selected === file.id && (
                <div className="vault-item-actions">
                  <button onClick={e => { e.stopPropagation(); handleDownload(file); }} title="Скачать"><IconDownload /></button>
                  <button onClick={e => { e.stopPropagation(); setRenamingId(file.id); setRenameValue(file.name); }} title="Переименовать">✎</button>
                  <button onClick={e => { e.stopPropagation(); handleDelete(file); }} title="Удалить"><IconTrash /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
