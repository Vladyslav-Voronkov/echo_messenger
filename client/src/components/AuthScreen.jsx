import { useState } from 'react';
import BuildBadge from './BuildBadge.jsx';
import { useTranslation, LanguageSwitcher } from '../utils/i18n.js';

/**
 * AuthScreen — Register or Login with nickname + password.
 * Accounts are stored on the server (password double-hashed, server sees only sha256(sha256(pass))).
 * localStorage is NOT used for account storage.
 */

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Double-hash: sha256(sha256(password)) — what gets sent to server
async function makeServerHash(password) {
  const clientHash = await sha256(password);
  return sha256(clientHash);
}

async function registerOnServer(nickname, serverHash) {
  const res = await fetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, passwordHash: serverHash }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration error');
  return data; // { ok, nickname, createdAt }
}

async function loginOnServer(nickname, serverHash) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, passwordHash: serverHash }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login error');
  return data; // { ok, nickname, createdAt }
}

export default function AuthScreen({ onAuth }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('login');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const switchTab = (newTab) => {
    setTab(newTab);
    setError('');
    setPassword('');
    setPasswordConfirm('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const nick = nickname.trim();
    if (!nick || !password) return;

    // Client-side validation before hitting server
    if (tab === 'register') {
      if (password.length < 6) {
        setError(t('auth.err_short_pass'));
        return;
      }
      if (password !== passwordConfirm) {
        setError(t('auth.err_pass_mismatch'));
        return;
      }
    }

    setLoading(true);
    try {
      const serverHash = await makeServerHash(password);

      if (tab === 'register') {
        const data = await registerOnServer(nick, serverHash);
        onAuth({ nickname: data.nickname, createdAt: data.createdAt });
      } else {
        const data = await loginOnServer(nick, serverHash);
        onAuth({ nickname: data.nickname, createdAt: data.createdAt });
      }
    } catch (err) {
      setError(err.message || t('auth.err_generic'));
    } finally {
      setLoading(false);
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

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !nickname.trim() || !password}
          >
            {loading ? (
              <span className="btn-loading"><span className="spinner" /> {t('auth.loading')}</span>
            ) : tab === 'login' ? t('auth.btn_login') : t('auth.btn_register')}
          </button>
        </form>

        <div className="login-security-badges">
          <span className="badge">{t('auth.badge_server')}</span>
          <span className="badge">AES-256-GCM</span>
          <span className="badge">Zero Knowledge</span>
        </div>

        <BuildBadge />
        <LanguageSwitcher />
      </div>
    </div>
  );
}
