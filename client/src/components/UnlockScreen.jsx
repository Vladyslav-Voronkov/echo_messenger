import { useState } from 'react';
import { decryptPrivateKey } from '../utils/crypto.js';
import BuildBadge from './BuildBadge.jsx';

/**
 * UnlockScreen — shown when a session exists but the ECDH private key
 * has not been decrypted yet. User must enter their password to unlock.
 */
export default function UnlockScreen({ nickname, onUnlocked, onLogout }) {
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const handleUnlock = async (e) => {
    e.preventDefault();
    if (!password) return;

    setLoading(true);
    setError('');

    try {
      const storageKey    = `echo_privkey_${nickname.toLowerCase()}`;
      const encryptedJson = localStorage.getItem(storageKey);

      if (!encryptedJson) {
        // No local key — could be old account without ECDH keys.
        // Unlock without key (legacy mode).
        onUnlocked(null);
        return;
      }

      const privateKey = await decryptPrivateKey(encryptedJson, password);
      onUnlocked(privateKey);
    } catch {
      setError('Неверный пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card glass">

        <div className="login-logo">
          <span style={{ fontSize: 32 }}>🔒</span>
        </div>

        <div className="login-header">
          <h1 className="login-title">ECHO MESSENGER</h1>
          <p className="login-subtitle">
            Привет, <strong>@{nickname}</strong>! Введите пароль для разблокировки.
          </p>
        </div>

        <form onSubmit={handleUnlock} className="login-form">
          <div className="field-group">
            <label htmlFor="unlock-pass">Пароль</label>
            <div className="seed-input-wrapper">
              <input
                id="unlock-pass"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Введите пароль..."
                disabled={loading}
                autoComplete="current-password"
                autoFocus
              />
              <button
                type="button"
                className="toggle-seed"
                onClick={() => setShowPass(v => !v)}
                tabIndex={-1}
              >
                {showPass ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !password}
          >
            {loading
              ? <span className="btn-loading"><span className="spinner" /> Разблокировка...</span>
              : '🔓 Разблокировать'}
          </button>
        </form>

        <button
          onClick={onLogout}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 13,
            marginTop: 8,
            padding: '4px 8px',
          }}
        >
          Выйти из аккаунта
        </button>

        <div className="login-security-badges" style={{ marginTop: 16 }}>
          <span className="badge">🔐 E2E Шифрование</span>
          <span className="badge">ECDH P-256</span>
          <span className="badge">AES-256-GCM</span>
        </div>

        <BuildBadge />
      </div>
    </div>
  );
}
