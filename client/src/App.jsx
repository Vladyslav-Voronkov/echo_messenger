import { useState, useCallback } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import RoomScreen from './components/RoomScreen.jsx';
import ChatScreen from './components/ChatScreen.jsx';
import { deriveRoomId, deriveKey } from './utils/crypto.js';

/**
 * Phases:
 *   'auth'     — account screen (register / login with password)
 *   'room'     — room selection (enter seed phrase)
 *   'deriving' — PBKDF2 running (~300ms)
 *   'chat'     — active chat
 */
export default function App() {
  const [phase, setPhase] = useState('auth');
  const [account, setAccount] = useState(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');

  const handleAuth = useCallback((accountData) => {
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
      setError('Ошибка генерации ключа. Попробуйте снова.');
      setPhase('room');
    }
  }, [account]);

  const handleLeaveRoom = useCallback(() => {
    setSession(null);
    setPhase('room');
  }, []);

  const handleLogout = useCallback(() => {
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
