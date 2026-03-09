import { getNickColor } from '../utils/nickColor.js';

function formatTime(ts) {
  if (!ts) return '';
  const now  = new Date();
  const d    = new Date(ts);
  const diff = now - d;
  if (diff < 60_000)    return 'сейчас';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' мин';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getPreview(text) {
  if (!text) return '';
  try {
    const p = JSON.parse(text);
    if (p.type === 'image')       return '🖼 Фото';
    if (p.type === 'album')       return `🖼 ${p.album?.images?.length || ''} фото`;
    if (p.type === 'file')        return '📎 ' + (p.file?.name || 'Файл');
    if (p.type === 'voice')       return '🎤 Голосовое';
    if (p.type === 'ai_command')  return '🤖 ' + (p.text || '');
    if (p.type === 'ai_response') return '🤖 ' + (p.text || '');
    if (typeof p.text === 'string') return p.text;
  } catch { /* plain text */ }
  return text;
}

const IconCompose = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>
);

const IconLogout = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);

const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

const IconEmpty = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
  </svg>
);

export default function Sidebar({ account, chatList, activeChatId, onSelectChat, onNewChat, onLogout, derivingId }) {
  const nickColor = getNickColor(account?.nickname || '');

  return (
    <aside className="sidebar">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="sidebar-header">
        <div className="sidebar-account">
          <div className="sidebar-avatar" style={{ background: nickColor }}>
            {account?.nickname?.[0]?.toUpperCase() || '?'}
          </div>
          <span className="sidebar-nickname">{account?.nickname}</span>
        </div>
        <div className="sidebar-header-btns">
          <button className="sidebar-icon-btn" onClick={onNewChat} title="Новый чат">
            <IconCompose />
          </button>
          <button className="sidebar-icon-btn sidebar-icon-btn--danger" onClick={onLogout} title="Выйти">
            <IconLogout />
          </button>
        </div>
      </div>

      {/* ── Search bar (cosmetic) ───────────────────────────────── */}
      <div className="sidebar-search">
        <div className="sidebar-search-wrap">
          <IconSearch />
          <input className="sidebar-search-input" placeholder="Поиск" readOnly />
        </div>
      </div>

      {/* ── Chat list ──────────────────────────────────────────── */}
      <div className="sidebar-list">
        {chatList.length === 0 ? (
          <div className="sidebar-empty">
            <IconEmpty />
            <p>Нет чатов</p>
            <p className="sidebar-empty-hint">Нажмите ✏️ чтобы создать</p>
          </div>
        ) : (
          chatList.map(chat => {
            const isActive  = chat.id === activeChatId;
            const isLoading = derivingId === chat.id;
            const color     = getNickColor(chat.name || chat.id);
            return (
              <button
                key={chat.id}
                className={'sidebar-item' + (isActive ? ' sidebar-item--active' : '')}
                onClick={() => onSelectChat(chat)}
              >
                <div className="sidebar-item-avatar" style={{ background: color }}>
                  {isLoading
                    ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                    : (chat.name || '#')[0].toUpperCase()
                  }
                </div>
                <div className="sidebar-item-body">
                  <div className="sidebar-item-top">
                    <span className="sidebar-item-name">{chat.name || 'Чат'}</span>
                    {chat.lastTs && (
                      <span className="sidebar-item-time">{formatTime(chat.lastTs)}</span>
                    )}
                  </div>
                  <div className="sidebar-item-bottom">
                    <span className="sidebar-item-preview">
                      {isLoading
                        ? 'Подключение...'
                        : (getPreview(chat.lastMessage) || 'Нет сообщений')}
                    </span>
                    {chat.unread > 0 && (
                      <span className="sidebar-unread">
                        {chat.unread > 99 ? '99+' : chat.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

    </aside>
  );
}
