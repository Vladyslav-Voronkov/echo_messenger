import { useState } from 'react';
import BuildBadge from './BuildBadge.jsx';
import {
  decryptPrivateKey,
  derivePasswordHash,
  generateECDHKeyPair,
  exportPublicKey,
  encryptPrivateKey,
} from '../utils/crypto.js';

/**
 * UnlockScreen — shown when a session exists but the ECDH private key
 * has not been decrypted yet. User must enter their password to unlock.
 *
 * If the encrypted key is missing from localStorage (e.g. new device),
 * we generate a fresh ECDH key pair, encrypt it, store it, and update
 * the server's public key — so the account works on this device.
 */
export default function UnlockScreen({ nickname, authSalt, onUnlocked, onLogout }) {
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleUnlock = async (e) => {
    e.preventDefault();
    if (!password) return;

    setLoading(true);
    setError('');
    setStatusMsg('');

    try {
      const storageKey    = `echo_privkey_${nickname.toLowerCase()}`;
      const encryptedJson = localStorage.getItem(storageKey);

      // Derive passwordHash upfront (needed in both branches)
      const salt = authSalt || await fetch(`/auth/salt/${encodeURIComponent(nickname)}`)
        .then(r => r.json()).then(d => d.authSalt);
      if (!salt) throw new Error('Не удалось получить данные аккаунта');
      const passwordHash = await derivePasswordHash(password, salt);

      if (!encryptedJson) {
        // No local key — generate a new ECDH key pair for this device
        setStatusMsg('Генерация ключей шифрования...');

        // Verify password against server before generating new keys
        setStatusMsg('Проверка пароля...');
        const loginRes = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, passwordHash }),
        });
        if (!loginRes.ok) {
          const d = await loginRes.json();
          throw new Error(d.error || 'Неверный пароль');
        }

        setStatusMsg('Генерация новых ключей...');
        const keyPair   = await generateECDHKeyPair();
        const pubKeyB64 = await exportPublicKey(keyPair.publicKey);
        const encPrivKey = await encryptPrivateKey(keyPair.privateKey, password, salt);
        localStorage.setItem(storageKey, encPrivKey);

        // Update public key and backup encrypted key on server
        await fetch('/auth/update-pubkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, passwordHash, pubKey: pubKeyB64 }),
        });
        fetch('/auth/save-encrypted-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, passwordHash, encryptedPrivKey: encPrivKey }),
        }).catch(() => {});

        onUnlocked(keyPair.privateKey, passwordHash);
        return;
      }

      const privateKey = await decryptPrivateKey(encryptedJson, password);
      onUnlocked(privateKey, passwordHash);
    } catch (err) {
      setError(err.message || 'Неверный пароль');
    } finally {
      setLoading(false);
      setStatusMsg('');
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

          {statusMsg && <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', margin: '4px 0' }}>{statusMsg}</p>}
          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !password}
          >
            {loading
              ? <span className="btn-loading"><span className="spinner" /> {statusMsg || 'Разблокировка...'}</span>
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
