import { useState } from 'react';

const IconClose = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

export default function NewChatModal({ onJoin, onClose, isLoading, error }) {
  const [seedPhrase, setSeedPhrase] = useState('');
  const [chatName,   setChatName]   = useState('');
  const [showSeed,   setShowSeed]   = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!seedPhrase.trim() || isLoading) return;
    onJoin({ seedPhrase: seedPhrase.trim(), name: chatName.trim() });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card glass" onClick={e => e.stopPropagation()}>

        <div className="modal-header">
          <h2 className="modal-title">Новый чат</h2>
          <button className="modal-close-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="field-group">
            <label htmlFor="nc-name">Название чата</label>
            <input
              id="nc-name"
              type="text"
              value={chatName}
              onChange={e => setChatName(e.target.value)}
              placeholder="например: Мои коллеги"
              maxLength={32}
            />
          </div>

          <div className="field-group">
            <label htmlFor="nc-seed">
              Ключ канала <span className="label-hint">(seed phrase)</span>
            </label>
            <div className="seed-input-wrapper">
              <input
                id="nc-seed"
                type={showSeed ? 'text' : 'password'}
                value={seedPhrase}
                onChange={e => setSeedPhrase(e.target.value)}
                placeholder="Введите секретный ключ"
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
              >
                {showSeed ? '🙈' : '👁️'}
              </button>
            </div>
            <p className="field-hint">Все кто знают ключ — участники зашифрованного чата</p>
          </div>

          {error && <p className="login-error">{error}</p>}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-cancel-btn"
              onClick={onClose}
              disabled={isLoading}
            >
              Отмена
            </button>
            <button
              type="submit"
              className="login-btn"
              disabled={isLoading || !seedPhrase.trim()}
              style={{ flex: 1 }}
            >
              {isLoading ? (
                <span className="btn-loading">
                  <span className="spinner" /> Подключение...
                </span>
              ) : 'Открыть чат'}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
