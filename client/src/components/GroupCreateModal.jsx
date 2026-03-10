import { useState, useRef, useEffect } from 'react';
import { getNickColor } from '../utils/nickColor.js';
import {
  generateGroupKey, generateECDHKeyPair,
  importPublicKey, deriveGroupWrapKey, wrapGroupKey,
  exportPublicKey, bufToB64,
} from '../utils/crypto.js';

/**
 * GroupCreateModal — create a new encrypted group.
 *
 * Props:
 *   myNick        string — creator's nickname
 *   myPrivKey     CryptoKey — creator's ECDH private key
 *   myPubKeyB64   string — creator's ECDH public key (base64 SPKI)
 *   onCreated(groupId, groupKey, groupName) — called after successful creation
 *   onClose()
 */
export default function GroupCreateModal({ myNick, myPrivKey, myPubKeyB64, onCreated, onClose }) {
  const [groupName, setGroupName]   = useState('');
  const [memberInput, setMemberInput] = useState('@');
  const [members, setMembers]       = useState([]);
  const [searchRes, setSearchRes]   = useState([]);
  const [searching, setSearching]   = useState(false);
  const [creating, setCreating]     = useState(false);
  const [error, setError]           = useState('');
  const debounceRef = useRef(null);

  const handleMemberInput = (e) => {
    let val = e.target.value;
    if (!val.startsWith('@')) val = '@' + val.replace(/^@*/, '');
    setMemberInput(val);

    clearTimeout(debounceRef.current);
    const q = val.replace(/^@/, '').trim();
    if (q.length < 2) { setSearchRes([]); return; }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res  = await fetch(`/users/search?q=${encodeURIComponent(q)}&limit=8`);
        const data = await res.json();
        // Filter out already added members and self
        const filtered = (data.users || []).filter(
          u => u.nickname.toLowerCase() !== myNick.toLowerCase()
          && !members.find(m => m.nickname.toLowerCase() === u.nickname.toLowerCase())
        );
        setSearchRes(filtered);
      } catch {}
      finally { setSearching(false); }
    }, 300);
  };

  const addMember = (user) => {
    if (!user.pubKey) {
      setError(`@${user.nickname} не поддерживает E2E шифрование (нет ключа).`);
      return;
    }
    setMembers(prev => [...prev, user]);
    setMemberInput('@');
    setSearchRes([]);
  };

  const removeMember = (nick) => {
    setMembers(prev => prev.filter(m => m.nickname !== nick));
  };

  const handleCreate = async () => {
    if (!groupName.trim()) { setError('Введите название группы'); return; }
    if (!myPrivKey) { setError('Ключи шифрования не загружены. Пожалуйста, войдите снова.'); return; }

    setCreating(true);
    setError('');

    try {
      // Generate random group AES key
      const groupKey = await generateGroupKey();

      // Generate group ID (random 32 bytes → 64 hex)
      const groupId = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      // Encrypt group key for each member (including creator)
      const membersPayload = {};

      // For creator: encrypt group key with self-ECDH (or just wrap with own key)
      const myPubKey = await importPublicKey(myPubKeyB64);
      const selfWrapKey = await deriveGroupWrapKey(myPrivKey, myPubKey);
      membersPayload[myNick.toLowerCase()] = await wrapGroupKey(groupKey, selfWrapKey);

      // For each invited member
      for (const member of members) {
        const memberPubKey = await importPublicKey(member.pubKey);
        const wrapKey = await deriveGroupWrapKey(myPrivKey, memberPubKey);
        membersPayload[member.nickname.toLowerCase()] = await wrapGroupKey(groupKey, wrapKey);
      }

      // Create group on server
      const res = await fetch('/groups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId,
          name:       groupName.trim(),
          createdBy:  myNick,
          members:    membersPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка создания группы');

      onCreated(groupId, groupKey, groupName.trim());
    } catch (err) {
      setError(err.message || 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card glass"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 440, width: '95%' }}
      >
        <div className="modal-header">
          <h2 className="modal-title">👥 Новая группа</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field-group" style={{ margin: 0 }}>
            <label>Название группы</label>
            <input
              type="text"
              value={groupName}
              onChange={e => setGroupName(e.target.value.slice(0, 64))}
              placeholder="Например: Команда проекта"
              autoFocus
              maxLength={64}
            />
          </div>

          {/* Added members */}
          {members.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {members.map(m => (
                <div key={m.nickname} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'rgba(79,142,247,0.15)', borderRadius: 20,
                  padding: '4px 10px 4px 6px', fontSize: 13,
                }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: getNickColor(m.nickname),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: '#fff',
                  }}>
                    {m.nickname[0].toUpperCase()}
                  </div>
                  <span style={{ color: 'var(--text)' }}>@{m.nickname}</span>
                  <button
                    onClick={() => removeMember(m.nickname)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, fontSize: 14 }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          <div className="field-group" style={{ margin: 0, position: 'relative' }}>
            <label>Добавить участников</label>
            <input
              type="text"
              value={memberInput}
              onChange={handleMemberInput}
              placeholder="@username"
              autoCorrect="off"
              autoCapitalize="off"
              style={{ fontFamily: 'monospace' }}
            />
            {/* Dropdown search results */}
            {(searchRes.length > 0 || searching) && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                overflow: 'hidden', marginTop: 4,
              }}>
                {searching && (
                  <div style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: 13 }}>
                    Поиск...
                  </div>
                )}
                {searchRes.map(u => (
                  <div
                    key={u.nickname}
                    onClick={() => addMember(u)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px', cursor: 'pointer', transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{
                      width: 30, height: 30, borderRadius: '50%',
                      background: getNickColor(u.nickname),
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 700, fontSize: 13, color: '#fff',
                    }}>
                      {u.nickname[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500 }}>
                        @{u.nickname}
                      </div>
                      {!u.pubKey && (
                        <div style={{ fontSize: 11, color: 'var(--error)' }}>Нет ключа E2E</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'rgba(79,142,247,0.08)', borderRadius: 8, padding: '8px 12px' }}>
            🔐 Ключ группы генерируется автоматически и шифруется для каждого участника. Сервер никогда не видит ключ.
          </div>

          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="login-btn"
              onClick={onClose}
              style={{ flex: 1, background: 'rgba(255,255,255,0.05)', color: 'var(--text)' }}
              disabled={creating}
            >
              Отмена
            </button>
            <button
              className="login-btn"
              onClick={handleCreate}
              disabled={creating || !groupName.trim()}
              style={{ flex: 2 }}
            >
              {creating
                ? <span className="btn-loading"><span className="spinner" /> Создание...</span>
                : '✅ Создать группу'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
