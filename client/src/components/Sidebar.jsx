import { useState } from 'react';
import { getNickColor } from '../utils/nickColor.js';

function formatTime(ts) {
  if (!ts) return '';
  const now  = new Date();
  const d    = new Date(ts);
  const diff = now - d;
  if (diff < 60_000)    return 'сейчас';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' мин';
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  } catch {}
  return text;
}

const IconCompose = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>
);

const IconLogout = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

const IconPlus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const IconChevron = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
    style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

function SectionHeader({ label, icon, onAdd, addTitle, collapsible, open, onToggle, pendingCount }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 14px 4px',
        cursor: collapsible ? 'pointer' : 'default',
      }}
      onClick={collapsible ? onToggle : undefined}
    >
      {collapsible && <IconChevron open={open} />}
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', flex: 1 }}>
        {icon} {label}
      </span>
      {pendingCount > 0 && (
        <span style={{
          background: '#f59e0b', color: '#000', borderRadius: 10,
          padding: '1px 6px', fontSize: 10, fontWeight: 700, marginRight: 4,
        }}>{pendingCount}</span>
      )}
      {onAdd && (
        <button
          className="sidebar-icon-btn"
          onClick={e => { e.stopPropagation(); onAdd(); }}
          title={addTitle}
          style={{ width: 22, height: 22 }}
        >
          <IconPlus />
        </button>
      )}
    </div>
  );
}

function ChatItem({ chat, isActive, isLoading, onSelect }) {
  const isPending = chat.isPending;
  const color = getNickColor(chat.name || chat.id);
  return (
    <button
      className={'sidebar-item' + (isActive ? ' sidebar-item--active' : '')}
      onClick={() => onSelect(chat)}
    >
      <div className="sidebar-item-avatar" style={{
        background: color,
        opacity: isPending ? 0.7 : 1,
      }}>
        {isLoading
          ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
          : (chat.name || '#')[0].toUpperCase()}
      </div>
      <div className="sidebar-item-body">
        <div className="sidebar-item-top">
          <span className="sidebar-item-name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {isPending && <span style={{ fontSize: 9, background: '#f59e0b', color: '#000', borderRadius: 4, padding: '1px 4px', fontWeight: 700 }}>?</span>}
            {chat.name || 'Чат'}
          </span>
          {chat.lastTs && <span className="sidebar-item-time">{formatTime(chat.lastTs)}</span>}
        </div>
        <div className="sidebar-item-bottom">
          <span className="sidebar-item-preview">
            {isLoading ? 'Подключение...' : (getPreview(chat.lastMessage) || (isPending ? 'Запрос на переписку' : 'Нет сообщений'))}
          </span>
          {chat.unread > 0 && (
            <span className="sidebar-unread-dot" />
          )}
        </div>
      </div>
    </button>
  );
}

export default function Sidebar({
  account,
  dmList,
  groupList,
  legacyList,
  dmRequests,
  activeChatId,
  derivingId,
  onSelectChat,
  onNewDM,
  onNewGroup,
  onNewLegacy,
  onLogout,
}) {
  const nickColor = getNickColor(account?.nickname || '');
  const [showLegacy, setShowLegacy] = useState(true);

  return (
    <aside className="sidebar">

      {/* ── Header ── */}
      <div className="sidebar-header">
        <div className="sidebar-account">
          <div className="sidebar-avatar" style={{ background: nickColor }}>
            {account?.nickname?.[0]?.toUpperCase() || '?'}
          </div>
          <span className="sidebar-nickname">{account?.nickname}</span>
        </div>
        <div className="sidebar-header-btns">
          <button className="sidebar-icon-btn sidebar-icon-btn--danger" onClick={onLogout} title="Выйти">
            <IconLogout />
          </button>
        </div>
      </div>

      {/* ── Search bar ── */}
      <div className="sidebar-search">
        <div className="sidebar-search-wrap">
          <IconSearch />
          <input
            className="sidebar-search-input"
            placeholder="Поиск"
            readOnly
            onClick={onNewDM}
            style={{ cursor: 'pointer' }}
          />
        </div>
      </div>

      {/* ── Scrollable list ── */}
      <div className="sidebar-list" style={{ overflowY: 'auto', flex: 1 }}>

        {/* DM Section */}
        <SectionHeader
          label="Личные сообщения"
          icon="💬"
          onAdd={onNewDM}
          addTitle="Написать @нику"
          pendingCount={dmRequests?.length || 0}
        />
        {(dmList?.length > 0 || dmRequests?.length > 0) ? (
          <>
            {/* Pending DM requests first */}
            {dmRequests?.map(req => (
              <ChatItem
                key={req.dmId}
                chat={{
                  id:          req.dmId,
                  type:        'dm',
                  name:        '@' + (req.fromNickDisplay || req.from),
                  dmId:        req.dmId,
                  otherNick:   req.from,
                  isPending:   true,
                  lastMessage: '',
                  lastTs:      req.createdAt,
                  unread:      1,
                }}
                isActive={activeChatId === req.dmId}
                isLoading={derivingId === req.dmId}
                onSelect={onSelectChat}
              />
            ))}
            {/* Accepted DMs */}
            {dmList?.map(chat => (
              <ChatItem
                key={chat.id}
                chat={chat}
                isActive={activeChatId === chat.id}
                isLoading={derivingId === chat.id}
                onSelect={onSelectChat}
              />
            ))}
          </>
        ) : (
          <div style={{ padding: '8px 14px 4px', color: 'var(--text-muted)', fontSize: 12 }}>
            Нажмите + чтобы написать
          </div>
        )}

        {/* Groups Section */}
        <SectionHeader
          label="Группы"
          icon="👥"
          onAdd={onNewGroup}
          addTitle="Создать группу"
        />
        {groupList?.length > 0 ? (
          groupList.map(chat => (
            <ChatItem
              key={chat.id}
              chat={chat}
              isActive={activeChatId === chat.id}
              isLoading={derivingId === chat.id}
              onSelect={onSelectChat}
            />
          ))
        ) : (
          <div style={{ padding: '8px 14px 4px', color: 'var(--text-muted)', fontSize: 12 }}>
            Нажмите + чтобы создать
          </div>
        )}

        {/* Legacy Channels Section */}
        <SectionHeader
          label="Каналы (Legacy)"
          icon="🔑"
          onAdd={onNewLegacy}
          addTitle="Войти по ключу"
          collapsible
          open={showLegacy}
          onToggle={() => setShowLegacy(v => !v)}
        />
        {showLegacy && (
          legacyList?.length > 0 ? (
            legacyList.map(chat => (
              <ChatItem
                key={chat.id}
                chat={chat}
                isActive={activeChatId === chat.id}
                isLoading={derivingId === chat.id}
                onSelect={onSelectChat}
              />
            ))
          ) : (
            <div style={{ padding: '8px 14px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
              Старые seed-phrase комнаты
            </div>
          )
        )}

      </div>
    </aside>
  );
}
