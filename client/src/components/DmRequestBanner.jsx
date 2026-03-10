import { useState } from 'react';

/**
 * DmRequestBanner — shown at top of ChatScreen when viewing an unaccepted DM request.
 *
 * Props:
 *   fromNick    string — who sent the request
 *   dmId        string — conversation ID
 *   onAccept()
 *   onDecline()
 */
export default function DmRequestBanner({ fromNick, dmId, onAccept, onDecline }) {
  const [acting, setActing] = useState(false);

  const handleAccept = async () => {
    setActing(true);
    try {
      await fetch('/dm/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dmId, nick: fromNick }),
      });
      onAccept();
    } catch {
      setActing(false);
    }
  };

  const handleDecline = async () => {
    setActing(true);
    try {
      await fetch('/dm/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dmId, nick: fromNick }),
      });
      onDecline();
    } catch {
      setActing(false);
    }
  };

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(79,142,247,0.12), rgba(79,142,247,0.06))',
      border: '1px solid rgba(79,142,247,0.25)',
      borderRadius: 10,
      padding: '12px 16px',
      margin: '8px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 20 }}>✉️</span>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>
            Запрос на переписку от @{fromNick}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Примите запрос, чтобы начать общение
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleAccept}
          disabled={acting}
          style={{
            flex: 1, padding: '8px 0', borderRadius: 8,
            background: 'var(--accent)', color: '#fff', border: 'none',
            fontWeight: 600, fontSize: 13, cursor: 'pointer',
          }}
        >
          ✅ Принять
        </button>
        <button
          onClick={handleDecline}
          disabled={acting}
          style={{
            flex: 1, padding: '8px 0', borderRadius: 8,
            background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',
            border: '1px solid rgba(255,255,255,0.1)', fontWeight: 600,
            fontSize: 13, cursor: 'pointer',
          }}
        >
          ✕ Отклонить
        </button>
      </div>
    </div>
  );
}
