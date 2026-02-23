import { useState, useCallback } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import RoomScreen from './components/RoomScreen.jsx';
import ChatScreen from './components/ChatScreen.jsx';
import { deriveRoomId, deriveKey } from './utils/crypto.js';
import { LangProvider, useTranslation } from './utils/i18n.js';

const SESSION_KEY = 'echo_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

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
  } catch {
    return null;
  }
}

/**
 * Phases:
 *   'auth'     — account screen (register / login)
 *   'room'     — enter channel key (seed phrase)
 *   'deriving' — PBKDF2 key derivation running
 *   'chat'     — active encrypted chat
 */
function AppInner() {
  const { t } = useTranslation();
  // Lazy initializers: read localStorage once on mount
  const [phase, setPhase] = useState(() => loadSavedSession() ? 'room' : 'auth');
  const [account, setAccount] = useState(() => loadSavedSession());
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  const handleAuth = useCallback((accountData) => {
    // Save session for 30 days (nickname only, never password)
    const toSave = { ...accountData, expiresAt: Date.now() + SESSION_TTL };
    localStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
    setAccount(accountData);
    setPhase('room');
  }, []);

  const handleRoomJoin = useCallback(async ({ seedPhrase }) => {
    setPhase('deriving');
    setError('');
    try {
      const [roomId, cryptoKey] = await Promise.all([
        deriveRoomId(seedPhrase),
        deriveKey(seedPhrase),
      ]);
      setSession({ nickname: account.nickname, roomId, cryptoKey });
      setPhase('chat');
    } catch (err) {
      console.error(err);
      setError(t('app.key_error'));
      setPhase('room');
    }
  }, [account, t]);

  const handleLeaveRoom = useCallback(() => {
    setSession(null);
    setPhase('room');
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setSession(null);
    setPhase('auth');
  }, []);

  if (phase === 'auth') {
    return <AuthScreen onAuth={handleAuth} />;
  }

  if (phase === 'room' || phase === 'deriving') {
    return (
      <RoomScreen
        account={account}
        onJoin={handleRoomJoin}
        onLogout={handleLogout}
        isLoading={phase === 'deriving'}
        error={error}
      />
    );
  }

  return (
    <ChatScreen
      session={session}
      onLeaveRoom={handleLeaveRoom}
      onLogout={handleLogout}
    />
  );
}

export default function App() {
  return (
    <LangProvider>
      <AppInner />
    </LangProvider>
  );
}
