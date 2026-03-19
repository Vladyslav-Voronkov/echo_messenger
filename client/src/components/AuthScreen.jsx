import { useState } from 'react';
import BuildBadge from './BuildBadge.jsx';
import { useTranslation, LanguageSwitcher } from '../utils/i18n.jsx';
import {
  generateAuthSalt,
  derivePasswordHash,
  generateECDHKeyPair,
  exportPublicKey,
  encryptPrivateKey,
} from '../utils/crypto.js';

/**
 * AuthScreen — Register or Login with nickname + password.
 *
 * Security model:
 *  - Registration: generate ECDH P-256 key pair, random authSalt,
 *    PBKDF2(password, authSalt) → passwordHash sent to server.
 *    Encrypted private key stored in localStorage.
 *  - Login: GET /auth/salt/:nick → authSalt, compute PBKDF2, send to server.
 *    Retrieve private key from localStorage and return to caller.
 */

async function fetchAuthSalt(nickname) {
  try {
    const res = await fetch(`/auth/salt/${encodeURIComponent(nickname.trim())}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.authSalt || null;
  } catch {
    return null;
  }
}

export default function AuthScreen({ onAuth }) {
  const { t } = useTranslation();
  const [tab,             setTab]             = useState('login');
  const [nickname,        setNickname]        = useState('');
  const [password,        setPassword]        = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [showPass,        setShowPass]        = useState(false);
  const [error,           setError]           = useState('');
  const [loading,         setLoading]         = useState(false);
  const [statusMsg,       setStatusMsg]       = useState('');

  const switchTab = (newTab) => {
    setTab(newTab);
    setError('');
    setPassword('');
    setPasswordConfirm('');
    setStatusMsg('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatusMsg('');

    const nick = nickname.trim();
    if (!nick || !password) return;

    if (tab === 'register') {
      if (password.length < 6) { setError(t('auth.err_short_pass')); return; }
      if (password !== passwordConfirm) { setError(t('auth.err_pass_mismatch')); return; }
    }

    setLoading(true);
    try {
      if (tab === 'register') {
        setStatusMsg('Генерация ключей шифрования...');

        // 1. Generate authSalt and ECDH key pair
        const authSalt  = generateAuthSalt(); // base64 random 16 bytes
        const keyPair   = await generateECDHKeyPair();
        const pubKeyB64 = await exportPublicKey(keyPair.publicKey);

        // 2. Derive passwordHash using PBKDF2 + authSalt
        setStatusMsg('Хеширование пароля...');
        const passwordHash = await derivePasswordHash(password, authSalt);

        // 3. Register on server
        setStatusMsg('Регистрация на сервере...');
        const res = await fetch('/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: nick, passwordHash, authSalt, pubKey: pubKeyB64 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration error');

        // 4. Encrypt private key with password and store in localStorage
        setStatusMsg('Сохранение ключей...');
        const encryptedPrivKey = await encryptPrivateKey(keyPair.privateKey, password, authSalt);
        localStorage.setItem(`echo_privkey_${nick.toLowerCase()}`, encryptedPrivKey);

        onAuth({
          nickname:   data.nickname,
          createdAt:  data.createdAt,
          authSalt,
          pubKeyB64,
          privateKey: keyPair.privateKey, // pass in memory to App
        });

      } else {
        // Login
        setStatusMsg('Получение данных аккаунта...');

        // 1. Get authSalt from server
        const authSalt = await fetchAuthSalt(nick);

        // 2. Derive passwordHash
        setStatusMsg('Проверка пароля...');
        const passwordHash = await derivePasswordHash(password, authSalt);

        // 3. Login
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: nick, passwordHash }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login error');

        // 4. Try to decrypt private key from localStorage
        let privateKey = null;
        const storageKey = `echo_privkey_${nick.toLowerCase()}`;
        const encryptedJson = localStorage.getItem(storageKey);
        if (encryptedJson) {
          // Decrypt happens in UnlockScreen (so we don't do it here)
          // Just signal that we need unlock
          privateKey = '__needs_unlock__';
        }

        // If account has pubKey but no local private key → generate a warning
        if (data.pubKey && !encryptedJson) {
          console.warn('[auth] Server has pubKey but no local private key found. Messages may not decrypt.');
        }

        // Auto-upgrade: if account has NO ECDH keys (legacy account), generate them now
        if (!data.pubKey && !encryptedJson) {
          try {
            setStatusMsg('Генерация ключей шифрования...');
            const keyPair   = await generateECDHKeyPair();
            const pubKeyB64 = await exportPublicKey(keyPair.publicKey);
            const encPrivKey = await encryptPrivateKey(keyPair.privateKey, password, authSalt);
            localStorage.setItem(storageKey, encPrivKey);
            await fetch('/auth/update-pubkey', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nickname: nick, passwordHash, pubKey: pubKeyB64 }),
            });
            onAuth({
              nickname:  data.nickname,
              createdAt: data.createdAt,
              authSalt:  authSalt,
              pubKeyB64,
              privateKey: keyPair.privateKey,
            });
            return;
          } catch (upgradeErr) {
            console.warn('[auth] ECDH key upgrade failed:', upgradeErr);
            // Fall through to login without ECDH keys
          }
        }

        onAuth({
          nickname:   data.nickname,
          createdAt:  data.createdAt,
          authSalt:   data.authSalt,
          pubKeyB64:  data.pubKey || null,
          privateKey, // '__needs_unlock__' or null
        });
      }
    } catch (err) {
      setError(err.message || t('auth.err_generic'));
    } finally {
      setLoading(false);
      setStatusMsg('');
    }
  };

  return (
    <div className="login-container">
      <div className="login-card glass">

        <div className="login-logo">
          <span className="app-logo-text">EM</span>
        </div>

        <div className="login-header">
          <h1 className="login-title">ECHO MESSENGER</h1>
          <p className="login-subtitle">{t('auth.subtitle')}</p>
        </div>

        {/* Tabs */}
        <div className="auth-tabs">
          <button
            className={'auth-tab' + (tab === 'login' ? ' active' : '')}
            onClick={() => switchTab('login')}
            type="button"
          >
            {t('auth.tab_login')}
          </button>
          <button
            className={'auth-tab' + (tab === 'register' ? ' active' : '')}
            onClick={() => switchTab('register')}
            type="button"
          >
            {t('auth.tab_register')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="field-group">
            <label htmlFor="auth-nick">{t('auth.field_nickname')}</label>
            <input
              id="auth-nick"
              type="text"
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder={t('auth.placeholder_nickname')}
              maxLength={32}
              disabled={loading}
              autoComplete="username"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="field-group">
            <label htmlFor="auth-pass">{t('auth.field_password')}</label>
            <div className="seed-input-wrapper">
              <input
                id="auth-pass"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={tab === 'register' ? t('auth.placeholder_pass_new') : t('auth.placeholder_pass_existing')}
                disabled={loading}
                autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                autoFocus
              />
              <button
                type="button"
                className="toggle-seed"
                onClick={() => setShowPass(v => !v)}
                tabIndex={-1}
                aria-label={t('auth.aria_toggle_pass')}
              >
                {showPass ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {tab === 'register' && (
            <div className="field-group">
              <label htmlFor="auth-pass2">{t('auth.field_confirm')}</label>
              <input
                id="auth-pass2"
                type={showPass ? 'text' : 'password'}
                value={passwordConfirm}
                onChange={e => setPasswordConfirm(e.target.value)}
                placeholder={t('auth.placeholder_confirm')}
                disabled={loading}
                autoComplete="new-password"
              />
            </div>
          )}

          {tab === 'register' && (
            <div style={{
              fontSize: 12, color: 'var(--text-muted)',
              background: 'rgba(79,142,247,0.08)', borderRadius: 8,
              padding: '8px 12px', lineHeight: 1.5,
            }}>
              🔐 При регистрации генерируется ваша пара ключей ECDH P-256.
              Приватный ключ шифруется паролем и хранится только у вас.
            </div>
          )}

          {statusMsg && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', margin: 0 }}>
              <span className="spinner" style={{ width: 12, height: 12, marginRight: 6 }} />
              {statusMsg}
            </p>
          )}

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !nickname.trim() || !password}
          >
            {loading ? (
              <span className="btn-loading"><span className="spinner" /> {statusMsg || t('auth.loading')}</span>
            ) : tab === 'login' ? t('auth.btn_login') : t('auth.btn_register')}
          </button>
        </form>

        <div className="login-security-badges">
          <span className="badge">{t('auth.badge_server')}</span>
          <span className="badge">ECDH P-256</span>
          <span className="badge">AES-256-GCM</span>
          <span className="badge">Zero Knowledge</span>
        </div>

        <BuildBadge />
        <LanguageSwitcher />
      </div>
    </div>
  );
}
