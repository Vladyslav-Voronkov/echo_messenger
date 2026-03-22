import { useState, useRef } from 'react';
import { getNickColor } from '../utils/nickColor.js';

export default function ProfileModal({ nickname, currentAvatar, onClose, onAvatarUpdated }) {
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState('');
  const [preview, setPreview] = useState(currentAvatar || null);
  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('Файл слишком большой (макс 2 МБ)'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const b64 = dataUrl.split(',')[1];
      setPreview(b64);
      setSaving(true); setError('');
      try {
        const res = await fetch('/users/set-avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick: nickname, avatar: b64 }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Ошибка'); }
        onAvatarUpdated?.(b64);
      } catch (err) { setError(err.message); setPreview(currentAvatar || null); }
      finally { setSaving(false); }
    };
    reader.readAsDataURL(file);
  };

  const avatarColor = getNickColor(nickname || '');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="profile-modal glass" onClick={e => e.stopPropagation()}>
        <div className="profile-modal-header">
          <span>Профиль</span>
          <button className="group-info-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="profile-modal-avatar-wrap">
          <div
            className="profile-modal-avatar"
            style={{ background: preview ? 'var(--surface-1)' : avatarColor, cursor: 'pointer' }}
            onClick={() => fileInputRef.current?.click()}
            title="Нажмите чтобы изменить фото"
          >
            {preview
              ? <img src={`data:image/jpeg;base64,${preview}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
              : (nickname || '?')[0].toUpperCase()
            }
            <div className="avatar-edit-overlay">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>
              </svg>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
        </div>

        <div className="profile-modal-nick">@{nickname}</div>
        {saving && <div style={{ textAlign: 'center', marginTop: 8 }}><span className="spinner" style={{ width: 16, height: 16 }} /></div>}
        {error && <p className="group-info-error">{error}</p>}
        <p style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          Нажмите на аватарку чтобы изменить фото
        </p>
      </div>
    </div>
  );
}
