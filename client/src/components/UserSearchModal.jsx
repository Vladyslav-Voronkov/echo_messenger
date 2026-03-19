import { useState, useEffect, useRef, useCallback } from 'react';
import { getNickColor } from '../utils/nickColor.js';

/**
 * UserSearchModal — search users by @nick and start a DM.
 *
 * Props:
 *   onStartDM(toNick, pubKey) — called when user clicks "Написать"
 *   onClose()
 */
export default function UserSearchModal({ onStartDM, onClose, title = '💬 Новое сообщение', actionLabel = 'Написать' }) {
  const [query,   setQuery]   = useState('@');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const debounceRef = useRef(null);
  const inputRef    = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q) => {
    const clean = q.replace(/^@/, '').trim();
    if (clean.length < 2) { setResults([]); return; }

    setLoading(true);
    setError('');
    try {
      const res  = await fetch(`/users/search?q=${encodeURIComponent(clean)}&limit=10`);
      const data = await res.json();
      setResults(data.users || []);
    } catch {
      setError('Ошибка поиска');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (e) => {
    let val = e.target.value;
    // Always keep @ prefix
    if (!val.startsWith('@')) val = '@' + val.replace(/^@*/, '');
    setQuery(val);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  const handleStartDM = (user) => {
    onStartDM(user);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card glass"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 400, width: '95%' }}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 20px 12px' }}>
          <div className="field-group" style={{ margin: 0 }}>
            <label htmlFor="user-search-input" style={{ marginBottom: 6, display: 'block' }}>
              Поиск по нику
            </label>
            <input
              id="user-search-input"
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleInput}
              placeholder="@username"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ fontFamily: 'monospace', fontSize: 15 }}
            />
          </div>
        </div>

        <div style={{ minHeight: 120, maxHeight: 300, overflowY: 'auto', padding: '0 12px 12px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
              <span className="spinner" style={{ width: 20, height: 20 }} />
            </div>
          )}

          {!loading && error && (
            <p style={{ color: 'var(--error)', textAlign: 'center', padding: 16, fontSize: 13 }}>
              {error}
            </p>
          )}

          {!loading && !error && results.length === 0 && query.length > 2 && (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 16, fontSize: 13 }}>
              Пользователи не найдены
            </p>
          )}

          {!loading && results.map(user => (
            <UserRow key={user.nickname} user={user} onStartDM={handleStartDM} actionLabel={actionLabel} />
          ))}
        </div>
      </div>
    </div>
  );
}

function UserRow({ user, onStartDM, actionLabel = 'Написать' }) {
  const color = getNickColor(user.nickname);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 8px',
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{
        width: 38, height: 38, borderRadius: '50%',
        background: color, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontWeight: 700, fontSize: 16,
        color: '#fff', flexShrink: 0,
      }}>
        {user.nickname[0].toUpperCase()}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
          @{user.nickname}
        </div>
        {!user.pubKey && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Старый аккаунт (только legacy-чат)
          </div>
        )}
      </div>
      <button
        className="login-btn"
        onClick={() => onStartDM(user)}
        style={{ padding: '6px 16px', fontSize: 13, width: 'auto' }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
