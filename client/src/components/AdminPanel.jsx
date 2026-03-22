import { useState } from 'react';
import AdminBadge from './AdminBadge.jsx';

export default function AdminPanel({ sessionToken, adminInfo, onClose, onUpdated }) {
  const [newAdmin, setNewAdmin] = useState('');
  const [loading, setLoading]  = useState(false);
  const [error, setError]      = useState('');

  const grant = async () => {
    const target = newAdmin.trim();
    if (!target) return;
    setLoading(true); setError('');
    try {
      const res = await fetch('/admin/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ targetNick: target }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Ошибка'); return; }
      setNewAdmin('');
      onUpdated();
    } catch { setError('Ошибка сети'); }
    finally { setLoading(false); }
  };

  const revoke = async (targetNick) => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/admin/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ targetNick }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Ошибка'); return; }
      onUpdated();
    } catch { setError('Ошибка сети'); }
    finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box admin-panel-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Управление администраторами</span>
          <button className="modal-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="admin-panel-section">
          <div className="admin-panel-row admin-panel-row--super">
            <AdminBadge type="super" size={16} />
            <span className="admin-panel-nick">{adminInfo.superAdmin}</span>
            <span className="admin-panel-label">Владелец</span>
          </div>
        </div>

        <div className="admin-panel-section">
          <div className="admin-panel-section-title">Администраторы</div>
          {adminInfo.admins.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>Нет администраторов</p>
          )}
          {adminInfo.admins.map(nick => (
            <div key={nick} className="admin-panel-row">
              <AdminBadge type="admin" size={14} />
              <span className="admin-panel-nick">{nick}</span>
              <button
                className="admin-panel-revoke-btn"
                onClick={() => revoke(nick)}
                disabled={loading}
                title="Забрать права"
              >
                Убрать
              </button>
            </div>
          ))}
        </div>

        <div className="admin-panel-section">
          <div className="admin-panel-section-title">Назначить администратора</div>
          <div className="admin-panel-add-row">
            <input
              className="input"
              style={{ flex: 1, fontSize: 13 }}
              type="text"
              placeholder="Никнейм..."
              value={newAdmin}
              onChange={e => setNewAdmin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && grant()}
            />
            <button
              className="btn"
              style={{ marginLeft: 8 }}
              onClick={grant}
              disabled={loading || !newAdmin.trim()}
            >
              Добавить
            </button>
          </div>
          {error && <p style={{ color: '#f87171', fontSize: 12, marginTop: 6 }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
