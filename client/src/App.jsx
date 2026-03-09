import { useState, useCallback, useEffect } from 'react';
import AuthScreen    from './components/AuthScreen.jsx';
import ChatScreen    from './components/ChatScreen.jsx';
import Sidebar       from './components/Sidebar.jsx';
import NewChatModal  from './components/NewChatModal.jsx';
import { deriveRoomId, deriveKey } from './utils/crypto.js';
import { LangProvider } from './utils/i18n.jsx';

const SESSION_KEY = 'echo_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// Chats are stored per-account so different users don't share the same list
const chatsKey = (nickname) => 'echo_chats_' + nickname;

function loadSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.nickname || !parsed.expiresAt) return null;
    if (Date.now() > parsed.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}

function loadChats(nickname) {
  if (!nickname) return [];
  try { return JSON.parse(localStorage.getItem(chatsKey(nickname)) || '[]'); }
  catch { return []; }
}

function AppInner() {
  const [account,       setAccount]       = useState(loadSavedSession);
  const [chatList,      setChatList]       = useState(() => loadChats(loadSavedSession()?.nickname));
  const [activeChatId,  setActiveChatId]   = useState(null);
  const [activeSession, setActiveSession]  = useState(null);
  const [showNewChat,   setShowNewChat]    = useState(false);
  const [derivingId,    setDerivingId]     = useState(null); // chatId currently being derived
  const [deriveError,   setDeriveError]    = useState('');
  const [showSidebar,   setShowSidebar]    = useState(true); // mobile toggle

  // Persist chat list to localStorage (scoped per account nickname)
  useEffect(() => {
    if (account?.nickname) {
      localStorage.setItem(chatsKey(account.nickname), JSON.stringify(chatList));
    }
  }, [chatList, account?.nickname]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const handleAuth = useCallback((accountData) => {
    const toSave = { ...accountData, expiresAt: Date.now() + SESSION_TTL };
    localStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
    setAccount(accountData);
    // Load this account's own chat list
    setChatList(loadChats(accountData.nickname));
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setActiveSession(null);
    setActiveChatId(null);
    setChatList([]);
  }, []);

  // ── Open a chat (derive keys + activate) ──────────────────────────────────
  const deriveAndOpen = useCallback(async (chat, nickname) => {
    setDerivingId(chat.id);
    setDeriveError('');
    try {
      const [roomId, cryptoKey] = await Promise.all([
        deriveRoomId(chat.seedPhrase),
        deriveKey(chat.seedPhrase),
      ]);
      setActiveSession({ nickname: nickname || account?.nickname, roomId, cryptoKey, chatId: chat.id });
      setActiveChatId(chat.id);
      setDerivingId(null);
      setShowSidebar(false); // collapse sidebar on mobile after selecting
    } catch {
      setDeriveError('Ошибка ключа');
      setDerivingId(null);
    }
  }, [account]);

  const handleSelectChat = useCallback((chat) => {
    if (chat.id === activeChatId) {
      setShowSidebar(false);
      return;
    }
    deriveAndOpen(chat, account?.nickname);
  }, [activeChatId, deriveAndOpen, account]);

  // ── Create / join new chat ────────────────────────────────────────────────
  const handleNewChat = useCallback(async ({ seedPhrase, name }) => {
    setDerivingId('__new__');
    setDeriveError('');
    try {
      const [roomId, cryptoKey] = await Promise.all([
        deriveRoomId(seedPhrase),
        deriveKey(seedPhrase),
      ]);

      // Reuse if same key already saved
      let target = null;
      setChatList(prev => {
        const existing = prev.find(c => c.roomId === roomId);
        if (existing) { target = existing; return prev; }
        const newChat = {
          id:          'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2),
          seedPhrase,
          roomId,
          name:        name || 'Чат',
          lastMessage: '',
          lastTs:      null,
          unread:      0,
          addedAt:     Date.now(),
        };
        target = newChat;
        return [newChat, ...prev];
      });

      if (target) {
        setActiveSession({ nickname: account?.nickname, roomId, cryptoKey, chatId: target.id });
        setActiveChatId(target.id);
      }
      setShowNewChat(false);
      setDerivingId(null);
      setShowSidebar(false);
    } catch {
      setDeriveError('Ошибка ключа');
      setDerivingId(null);
    }
  }, [account]);

  // ── Sidebar preview update (called from ChatScreen on new messages) ────────
  const handleUpdateChat = useCallback((chatId, { lastMessage, lastTs }) => {
    setChatList(prev => prev.map(c =>
      c.id === chatId ? { ...c, lastMessage, lastTs, unread: 0 } : c
    ));
  }, []);

  // ── Auth screen ───────────────────────────────────────────────────────────
  if (!account) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  const activeChat = chatList.find(c => c.id === activeChatId);

  return (
    <div className="app-layout">

      {/* ── Sidebar wrapper (mobile: off-canvas) ── */}
      <div className={'sidebar-wrapper' + (showSidebar ? ' sidebar-wrapper--open' : '')}>
        <Sidebar
          account={account}
          chatList={chatList}
          activeChatId={activeChatId}
          onSelectChat={handleSelectChat}
          onNewChat={() => { setDeriveError(''); setShowNewChat(true); }}
          onLogout={handleLogout}
          derivingId={derivingId}
        />
      </div>

      {/* Mobile overlay — tap to close sidebar */}
      {showSidebar && (
        <div className="sidebar-overlay" onClick={() => setShowSidebar(false)} />
      )}

      {/* ── Main area ── */}
      <div className="app-main">
        {activeSession ? (
          <ChatScreen
            key={activeSession.chatId}
            session={activeSession}
            chatName={activeChat?.name}
            onLeaveRoom={() => { setActiveChatId(null); setActiveSession(null); setShowSidebar(true); }}
            onLogout={handleLogout}
            onUpdateChat={handleUpdateChat}
            onToggleSidebar={() => setShowSidebar(v => !v)}
          />
        ) : (
          <div className="app-welcome">
            <div className="app-welcome-inner">
              <div className="app-welcome-logo">EM</div>
              <h2 className="app-welcome-title">Echo Messenger</h2>
              <p className="app-welcome-sub">Выберите чат или создайте новый</p>
              <button
                className="login-btn"
                onClick={() => { setDeriveError(''); setShowNewChat(true); }}
                style={{ width: 'auto', paddingLeft: 28, paddingRight: 28 }}
              >
                ✏️ Новый чат
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── New chat modal ── */}
      {showNewChat && (
        <NewChatModal
          onJoin={handleNewChat}
          onClose={() => { setShowNewChat(false); setDeriveError(''); }}
          isLoading={derivingId === '__new__'}
          error={deriveError}
        />
      )}

    </div>
  );
}

export default function App() {
  return (
    <LangProvider>
      <AppInner />
    </LangProvider>
  );
}
