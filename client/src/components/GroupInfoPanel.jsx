import { useState, useEffect, useRef } from 'react';
import { getNickColor } from '../utils/nickColor.js';

export default function GroupInfoPanel({ groupId, myNick, onClose, onGroupUpdated, onInvite }) {
  const [group,     setGroup]     = useState(null);
  const [editName,  setEditName]  = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    setGroup(null); setError('');
    fetch(`/groups/info/${groupId}`)
      .then(r => r.json())
      .then(data => { setGroup(data); setEditName(data.name || ''); })
      .catch(() => setError('Не удалось загрузить данные группы'));
  }, [groupId]);

  const isCreator = group && group.createdBy === myNick.toLowerCase();

  // ── Avatar upload ────────────────────────────────────────────────────────────
  const handleAvatarChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('Файл слишком большой (макс 2 МБ)'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result; // data:image/...;base64,...
      const b64 = dataUrl.split(',')[1];
      setSaving(true); setError('');
      try {
        const res = await fetch('/groups/set-avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId, nick: myNick, avatar: b64 }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Ошибка'); }
        setGroup(prev => ({ ...prev, avatar: b64 }));
        onGroupUpdated?.({ avatar: b64 });
      } catch (err) { setError(err.message); }
      finally { setSaving(false); }
    };
    reader.readAsDataURL(file);
  };

  // ── Rename ───────────────────────────────────────────────────────────────────
  const handleRename = async () => {
    const name = editName.trim();
    if (!name || name === group?.name) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/groups/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, nick: myNick, name }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Ошибка'); }
      setGroup(prev => ({ ...prev, name }));
      onGroupUpdated?.({ name });
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // ── Remove member ────────────────────────────────────────────────────────────
  const handleRemove = async (targetNick) => {
    if (!window.confirm(`Удалить @${targetNick} из группы?`)) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/groups/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, nick: myNick, targetNick }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Ошибка'); }
      setGroup(prev => ({
        ...prev,
        members: Object.fromEntries(Object.entries(prev.members).filter(([k]) => k !== targetNick.toLowerCase())),
      }));
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // ── Leave group (remove self) ────────────────────────────────────────────────
  const handleLeave = async () => {
    if (!window.confirm('Покинуть группу?')) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/groups/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, nick: myNick, targetNick: myNick }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Ошибка'); }
      onGroupUpdated?.({ left: true });
      onClose();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const avatarColor = getNickColor(group?.name || 'G');
  const members = group ? Object.entries(group.members) : [];

  return (
    <div className="group-info-panel glass">
      <div className="group-info-header">
        <span>Информация о группе</span>
        <button className="group-info-close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Avatar */}
      <div className="group-info-avatar-wrap">
        <div
          className="group-info-avatar"
          style={{ background: group?.avatar ? 'var(--surface-1)' : avatarColor, cursor: 'pointer' }}
          onClick={() => fileInputRef.current?.click()}
          title="Нажмите чтобы изменить фото"
        >
          {group?.avatar
            ? <img src={`data:image/jpeg;base64,${group.avatar}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            : (group?.name || 'G')[0].toUpperCase()
          }
          <div className="avatar-edit-overlay">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>
            </svg>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarChange} />
      </div>

      {/* Name */}
      <div className="group-info-name-row">
        <input
          className="group-info-name-input"
          value={editName}
          onChange={e => setEditName(e.target.value.slice(0, 64))}
          onBlur={handleRename}
          onKeyDown={e => e.key === 'Enter' && e.target.blur()}
          maxLength={64}
          readOnly={!isCreator && !group?.members?.[myNick.toLowerCase()]}
          placeholder="Название группы"
        />
        {saving && <span className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} />}
      </div>

      {/* Members */}
      <div className="group-info-section-label">
        Участники · {members.length}
      </div>
      <div className="group-info-members">
        {members.map(([nick]) => {
          const color = getNickColor(nick);
          const isMe = nick === myNick.toLowerCase();
          const isCr = nick === group?.createdBy;
          return (
            <div key={nick} className="group-info-member">
              <div className="group-info-member-avatar" style={{ background: color }}>
                {nick[0].toUpperCase()}
              </div>
              <div className="group-info-member-info">
                <span className="group-info-member-nick">@{nick}</span>
                {isCr && <span className="group-info-member-badge">создатель</span>}
                {isMe && !isCr && <span className="group-info-member-badge" style={{ color: 'var(--text-muted)' }}>вы</span>}
              </div>
              {isCreator && !isMe && (
                <button className="group-info-remove-btn" onClick={() => handleRemove(nick)} title="Удалить из группы">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="group-info-error">{error}</p>}

      <div className="group-info-actions">
        {onInvite && (
          <button className="group-info-action-btn" onClick={onInvite}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="8.5" cy="7" r="4"/>
              <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
            </svg>
            Добавить участника
          </button>
        )}
        {!isCreator && (
          <button className="group-info-action-btn group-info-action-btn--danger" onClick={handleLeave}>
            Покинуть группу
          </button>
        )}
      </div>
    </div>
  );
}
