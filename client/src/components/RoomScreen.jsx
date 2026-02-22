import { useState } from 'react';
import WalletPanel from './WalletPanel.jsx';
import BuildBadge from './BuildBadge.jsx';

export default function RoomScreen({ account, onJoin, onLogout, isLoading, error }) {
  const [seedPhrase, setSeedPhrase] = useState('');
  const [showSeed, setShowSeed] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!seedPhrase.trim() || isLoading) return;
    onJoin({ seedPhrase: seedPhrase.trim() });
  };

  return (
    <div className="login-container">
      <div className="login-card glass">

        <div className="login-logo">
          <span className="app-logo-text">EM</span>
        </div>

        <div className="login-header">
          <h1 className="login-title">ECHO MESSENGER</h1>
          <div className="room-account-info">
            <span className="room-nick">👤 {account.nickname}</span>
            <button className="link-btn" onClick={onLogout}>Выйти</button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="field-group">
            <label htmlFor="seedphrase">
              Ключ чата
              <span className="label-hint"> — ключ доступа и шифрования</span>
            </label>
            <div className="seed-input-wrapper">
              <input
                id="seedphrase"
                type={showSeed ? 'text' : 'password'}
                value={seedPhrase}
                onChange={e => setSeedPhrase(e.target.value)}
                placeholder="Введите ключ для входа в чат"
                disabled={isLoading}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="toggle-seed"
                onClick={() => setShowSeed(v => !v)}
                tabIndex={-1}
                aria-label="Показать/скрыть фразу"
              >
                {showSeed ? '🙈' : '👁️'}
              </button>
            </div>
            <p className="field-hint">
              Любой с тем же ключом может войти в чат. Сервер видит только хэш.
            </p>
          </div>

          {error && <p className="login-error">{error}</p>}

          <button
            type="submit"
            className="login-btn"
            disabled={isLoading || !seedPhrase.trim()}
          >
            {isLoading ? (
              <span className="btn-loading">
                <span className="spinner" /> Генерация ключа...
              </span>
            ) : (
              'Войти в чат'
            )}
          </button>
        </form>

        <div className="login-security-badges">
          <span className="badge">AES-256-GCM</span>
          <span className="badge">PBKDF2 · 100k итераций</span>
          <span className="badge">Zero Knowledge</span>
        </div>

        <WalletPanel mode="full" />
        <BuildBadge />
      </div>
    </div>
  );
}
