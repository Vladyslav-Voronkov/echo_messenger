import { useState, useCallback, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;
import AuthScreen       from './components/AuthScreen.jsx';
import UnlockScreen     from './components/UnlockScreen.jsx';
import ChatScreen       from './components/ChatScreen.jsx';
import Sidebar          from './components/Sidebar.jsx';
import NewChatModal     from './components/NewChatModal.jsx';
import UserSearchModal  from './components/UserSearchModal.jsx';
import GroupCreateModal from './components/GroupCreateModal.jsx';
import GroupInfoPanel   from './components/GroupInfoPanel.jsx';
import ProfileModal     from './components/ProfileModal.jsx';
import {
  deriveRoomId, deriveKey,
  importPublicKey, exportPublicKey, generateECDHKeyPair, encryptPrivateKey,
  deriveDMKey, deriveGroupWrapKey, unwrapGroupKey, wrapGroupKey,
  decryptMessageObject,
  exportPrivateKeyJwk, importPrivateKeyJwk,
} from './utils/crypto.js';
import { registerServiceWorker, subscribeToPush } from './utils/pushClient.js';
import { registerNativePush, isRunningNative } from './utils/nativePush.js';
import { LangProvider } from './utils/i18n.jsx';

const SESSION_KEY  = 'echo_session';
const SESSION_TTL  = 30 * 24 * 60 * 60 * 1000;
const legacyKey    = (nick) => 'echo_chats_' + nick;
const getLastSeen = (chatId) => parseInt(localStorage.getItem('echo_ls_' + chatId) || '0', 10);
const markSeen   = (chatId, ts) => { if (chatId && ts) localStorage.setItem('echo_ls_' + chatId, String(ts)); };

// ── Preview decryption helper ─────────────────────────────────────────────────
async function extractPreviewText(encObj, key) {
  try {
    const msg = await decryptMessageObject(key, encObj);
    if (!msg) return null;
    let text = msg.text || '';
    try {
      const p = JSON.parse(text);
      if (p.type === 'image')  return '🖼 Фото';
      if (p.type === 'album')  return `🖼 ${p.album?.images?.length || ''} фото`;
      if (p.type === 'file')   return '📎 ' + (p.file?.name || 'Файл');
      if (p.type === 'voice')  return '🎤 Голосовое';
      if (typeof p.text === 'string') text = p.text;
    } catch {}
    return text || null;
  } catch { return null; }
}

// ── Session helpers ────────────────────────────────────────────────────────────

function loadSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.nickname || !parsed.expiresAt) return null;
    if (Date.now() > parsed.expiresAt) { localStorage.removeItem(SESSION_KEY); return null; }
    return parsed;
  } catch { return null; }
}

function saveSavedSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...data, expiresAt: Date.now() + SESSION_TTL }));
}

function loadLegacyChats(nickname) {
  if (!nickname) return [];
  try { return JSON.parse(localStorage.getItem(legacyKey(nickname)) || '[]'); }
  catch { return []; }
}

function AppInner() {
  const [account,      setAccount]      = useState(loadSavedSession);
  const [privateKey,   setPrivateKey]   = useState(null);  // ECDH CryptoKey in memory
  const [needsUnlock,  setNeedsUnlock]  = useState(false); // session exists, key not yet unlocked

  // Chat lists
  const [dmList,       setDmList]       = useState([]);
  const [groupList,    setGroupList]    = useState([]);
  const [legacyList,   setLegacyList]   = useState(() => loadLegacyChats(loadSavedSession()?.nickname));
  const [dmRequests,   setDmRequests]   = useState([]);

  // Active chat
  const [activeChatId,  setActiveChatId]  = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const activeChatIdRef = useRef(null);

  // UI state
  const [showSidebar,   setShowSidebar]   = useState(true);
  const [showNewLegacy,   setShowNewLegacy]   = useState(false);
  const [showNewDM,       setShowNewDM]       = useState(false);
  const [showNewGroup,    setShowNewGroup]    = useState(false);
  const [showGroupInvite, setShowGroupInvite] = useState(false);
  const [showGroupInfo,   setShowGroupInfo]   = useState(false);
  const [showProfile,     setShowProfile]     = useState(false);
  const [myAvatar,        setMyAvatar]        = useState(() => {
    const session = loadSavedSession();
    if (!session?.nickname) return null;
    return localStorage.getItem(`echo_avatar_${session.nickname.toLowerCase()}`) || null;
  });
  const [derivingId,    setDerivingId]    = useState(null);
  const [deriveError,   setDeriveError]   = useState('');

  // Keep activeChatIdRef in sync for use inside socket callbacks
  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);

  // Determine unlock state after mount
  useEffect(() => {
    const session = loadSavedSession();
    if (!session) return;
    if (!session.pubKeyB64) return; // legacy account, no ECDH keys

    const cacheKey = `echo_rawkey_${session.nickname.toLowerCase()}`;
    const cachedJwk = localStorage.getItem(cacheKey);

    if (cachedJwk) {
      // Auto-load from cache — no password prompt (Telegram-style)
      importPrivateKeyJwk(cachedJwk)
        .then(privKey => {
          setPrivateKey(privKey);
          setNeedsUnlock(false);
          afterKeyUnlocked(session.nickname, privKey);
        })
        .catch(() => {
          // Cache corrupted — fall back to password
          localStorage.removeItem(cacheKey);
          setNeedsUnlock(true);
        });
    } else {
      setNeedsUnlock(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Global notification socket ─────────────────────────────────────────────
  // Connects as soon as the user is logged in.
  // Receives group_invite_notify and dm_request_notify regardless of which chat is open.
  useEffect(() => {
    if (!account?.nickname) return;
    const socket = io(SOCKET_URL, {
      transports: ['polling', 'websocket'],
      query: { nick: account.nickname },
    });

    socket.on('group_invite_notify', ({ groupId, groupName, fromNick, encryptedGroupKey, encryptedBy, alreadyMember }) => {
      setGroupList(prev => {
        if (prev.find(g => g.id === groupId)) return prev;
        return [{
          id: groupId, type: 'group',
          name: groupName || 'Группа',
          groupId,
          encryptedGroupKey,
          encryptedBy: encryptedBy || fromNick,
          isPending: !alreadyMember,
          lastMessage: '', lastTs: null, unread: 0,
        }, ...prev];
      });
    });

    socket.on('dm_request_notify', ({ dmId, fromNick }) => {
      setDmRequests(prev => {
        if (prev.find(r => r.dmId === dmId)) return prev;
        return [...prev, { dmId, from: fromNick }];
      });
    });

    // Sidebar timestamp updates when messages arrive in non-active chats
    socket.on('sidebar_update', ({ type, id, lastTs }) => {
      const isActive = activeChatIdRef.current === id;
      if (type === 'dm') {
        setDmList(prev => prev.map(c => c.id === id
          ? { ...c, lastTs, unread: isActive ? 0 : 1 } : c));
      } else if (type === 'group') {
        setGroupList(prev => prev.map(c => c.id === id
          ? { ...c, lastTs, unread: isActive ? 0 : 1 } : c));
      }
    });

    // Real-time avatar updates from other users
    socket.on('user_avatar_updated', ({ nick, avatar }) => {
      // Update localStorage cache
      localStorage.setItem('echo_avatar_' + nick.toLowerCase(), avatar || '');
      // Update DM list peer avatars
      setDmList(prev => prev.map(c =>
        c.otherNick?.toLowerCase() === nick.toLowerCase()
          ? { ...c, peerAvatar: avatar || null } : c));
    });

    // Group avatar broadcast (already handled per-group via group_updated in ChatScreen,
    // but update the sidebar list here too)
    socket.on('group_updated', ({ groupId: gId, name, avatar }) => {
      setGroupList(prev => prev.map(g => g.id === gId
        ? { ...g, ...(name && { name }), ...(avatar !== undefined && { avatar }) } : g));
    });

    return () => socket.disconnect();
  }, [account?.nickname]);

  // Persist legacy chats
  useEffect(() => {
    if (account?.nickname) {
      localStorage.setItem(legacyKey(account.nickname), JSON.stringify(legacyList));
    }
  }, [legacyList, account?.nickname]);

  // ── Load DMs and Groups from server ──────────────────────────────────────────
  const loadDMsAndGroups = useCallback(async (nick, privKey = null) => {
    if (!nick) return;
    try {
      const [dmRes, grpRes, reqRes] = await Promise.all([
        fetch(`/dm/list?nick=${encodeURIComponent(nick)}`),
        fetch(`/groups/list?nick=${encodeURIComponent(nick)}`),
        fetch(`/dm/requests?nick=${encodeURIComponent(nick)}`),
      ]);

      let dmsData = [], grpsData = [];

      if (dmRes.ok) {
        const { dms, pending } = await dmRes.json();
        dmsData = dms || [];
        setDmList(dmsData.map(d => ({
          id:          d.dmId,
          type:        'dm',
          name:        '@' + d.other,
          dmId:        d.dmId,
          otherNick:   d.other,
          lastMessage: d.msgCount > 0 ? '...' : '',
          lastTs:      d.lastTs || null,
          unread:      (d.lastTs || 0) > getLastSeen(d.dmId) ? 1 : 0,
        })));
        if (pending?.length) {
          setDmList(prev => [
            ...prev,
            ...pending.map(p => ({
              id: p.dmId, type: 'dm', name: '@' + p.other,
              dmId: p.dmId, otherNick: p.other,
              isPendingSent: true, lastMessage: '', lastTs: null, unread: 0,
            })),
          ]);
        }
      }

      if (grpRes.ok) {
        const { groups } = await grpRes.json();
        grpsData = groups || [];
        setGroupList(grpsData.map(g => ({
          id:                g.groupId,
          type:              'group',
          name:              g.name,
          groupId:           g.groupId,
          encryptedGroupKey: g.encryptedGroupKey,
          encryptedBy:       g.encryptedBy,
          isPending:         g.isPending,
          avatar:            g.avatar || null,
          lastMessage:       g.msgCount > 0 ? '...' : '',
          lastTs:            g.lastTs || null,
          unread:            (g.lastTs || 0) > getLastSeen(g.groupId) ? 1 : 0,
        })));
      }

      if (reqRes.ok) {
        const { requests } = await reqRes.json();
        setDmRequests(requests || []);
      }

      // ── Background decrypt previews + avatars (parallel, one pubkey fetch per DM) ──
      if (privKey) {
        // DM: one pubkey fetch per contact, do preview + avatar together
        Promise.all(dmsData.map(async (d) => {
          try {
            const cached = localStorage.getItem('echo_avatar_' + d.other.toLowerCase());
            if (cached) setDmList(prev => prev.map(c => c.id === d.dmId ? { ...c, peerAvatar: cached } : c));

            if (!d.lastEncrypted && cached) return; // nothing more to do

            const pubRes  = await fetch(`/users/pubkey/${encodeURIComponent(d.other)}`);
            const pubData = await pubRes.json();
            if (!pubData.pubKey) return;

            const theirPub = await importPublicKey(pubData.pubKey);

            // Avatar
            if (!cached && pubData.avatar) {
              localStorage.setItem('echo_avatar_' + d.other.toLowerCase(), pubData.avatar);
              setDmList(prev => prev.map(c => c.id === d.dmId ? { ...c, peerAvatar: pubData.avatar } : c));
            }

            // Preview
            if (d.lastEncrypted) {
              const key  = await deriveDMKey(privKey, theirPub, nick, d.other);
              const text = await extractPreviewText(d.lastEncrypted, key);
              if (text) setDmList(prev => prev.map(c => c.id === d.dmId ? { ...c, lastMessage: text } : c));
            }
          } catch { /* skip */ }
        }));

        // Group previews (parallel)
        Promise.all(grpsData.map(async (g) => {
          if (!g.lastEncrypted || !g.encryptedGroupKey) return;
          try {
            const session = loadSavedSession();
            const encBy  = (g.encryptedBy || '').toLowerCase();
            const myNick = nick.toLowerCase();
            let wrapKey;
            if (encBy === myNick) {
              if (session?.pubKeyB64) {
                const myPub = await importPublicKey(session.pubKeyB64);
                wrapKey = await deriveGroupWrapKey(privKey, myPub);
              }
            } else {
              const pubRes = await fetch(`/users/pubkey/${encodeURIComponent(encBy)}`);
              const pubData = await pubRes.json();
              if (pubData.pubKey) {
                const encPub = await importPublicKey(pubData.pubKey);
                wrapKey = await deriveGroupWrapKey(privKey, encPub);
              }
            }
            if (!wrapKey) return;
            const groupKey = await unwrapGroupKey(g.encryptedGroupKey, wrapKey);
            const text = await extractPreviewText(g.lastEncrypted, groupKey);
            if (text) setGroupList(prev => prev.map(c => c.id === g.groupId ? { ...c, lastMessage: text } : c));
          } catch { /* skip */ }
        }));
      }
    } catch (err) {
      console.warn('[app] Failed to load DMs/Groups:', err);
    }
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────────
  const handleAuth = useCallback((accountData) => {
    const toSave = {
      nickname:   accountData.nickname,
      createdAt:  accountData.createdAt,
      authSalt:   accountData.authSalt  || null,
      pubKeyB64:  accountData.pubKeyB64 || null,
    };
    saveSavedSession(toSave);
    setAccount(toSave);
    setLegacyList(loadLegacyChats(accountData.nickname));

    // If registration — private key is already in memory
    if (accountData.privateKey && accountData.privateKey !== '__needs_unlock__') {
      setPrivateKey(accountData.privateKey);
      setNeedsUnlock(false);
      // Cache so page refresh skips unlock screen
      exportPrivateKeyJwk(accountData.privateKey)
        .then(jwk => localStorage.setItem(`echo_rawkey_${toSave.nickname.toLowerCase()}`, jwk))
        .catch(() => {});
      afterKeyUnlocked(toSave.nickname, accountData.privateKey);
    } else if (accountData.privateKey === '__needs_unlock__') {
      // Login — has a stored private key, needs unlock
      setNeedsUnlock(true);
    } else {
      // Legacy account with no ECDH keys
      setNeedsUnlock(false);
      loadDMsAndGroups(accountData.nickname);
    }
  }, [loadDMsAndGroups]);

  const afterKeyUnlocked = useCallback(async (nick, privKey) => {
    // Register for push notifications (native iOS or web)
    if (isRunningNative()) {
      registerNativePush(nick).catch(() => {});
    } else {
      await registerServiceWorker();
      subscribeToPush(nick).catch(() => {});
    }
    // Load DMs and groups with key for preview decryption
    await loadDMsAndGroups(nick, privKey);
  }, [loadDMsAndGroups]);

  const cachePrivateKey = useCallback((nick, privKey) => {
    if (!nick || !privKey) return;
    exportPrivateKeyJwk(privKey)
      .then(jwk => localStorage.setItem(`echo_rawkey_${nick.toLowerCase()}`, jwk))
      .catch(() => {});
  }, []);

  const handleUnlocked = useCallback(async (privKey) => {
    setPrivateKey(privKey);
    setNeedsUnlock(false);
    if (privKey) cachePrivateKey(account?.nickname, privKey);
    await afterKeyUnlocked(account?.nickname, privKey);
  }, [account, afterKeyUnlocked, cachePrivateKey]);

  const handleLogout = useCallback(() => {
    const nick = account?.nickname?.toLowerCase();
    if (nick) localStorage.removeItem(`echo_rawkey_${nick}`);
    localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setPrivateKey(null);
    setNeedsUnlock(false);
    setActiveSession(null);
    setActiveChatId(null);
    setDmList([]);
    setGroupList([]);
    setDmRequests([]);
    setLegacyList([]);
  }, [account]);

  // ── Open a Legacy chat (seed-phrase) ──────────────────────────────────────────
  const deriveAndOpenLegacy = useCallback(async (chat) => {
    setDerivingId(chat.id);
    setDeriveError('');
    try {
      const [roomId, cryptoKey] = await Promise.all([
        deriveRoomId(chat.seedPhrase),
        deriveKey(chat.seedPhrase),
      ]);
      setActiveSession({ type: 'legacy', nickname: account?.nickname, roomId, cryptoKey, chatId: chat.id });
      setActiveChatId(chat.id);
      markSeen(chat.id, Date.now());
      setDerivingId(null);
      setShowSidebar(false);
    } catch {
      setDeriveError('Ошибка ключа');
      setDerivingId(null);
    }
  }, [account]);

  // ── Open a DM chat ────────────────────────────────────────────────────────────
  const openDM = useCallback(async (dmChatInfo, myPrivKey) => {
    const effKey = myPrivKey || privateKey;
    setDerivingId(dmChatInfo.id);
    setDeriveError('');
    try {
      let cryptoKey;
      if (effKey && dmChatInfo.otherNick) {
        // Fetch other person's public key
        const res      = await fetch(`/users/pubkey/${encodeURIComponent(dmChatInfo.otherNick)}`);
        const data     = await res.json();
        if (data.pubKey) {
          const theirPubKey = await importPublicKey(data.pubKey);
          cryptoKey = await deriveDMKey(effKey, theirPubKey, account.nickname, dmChatInfo.otherNick);
        }
      }
      setActiveSession({
        type:       'dm',
        nickname:   account?.nickname,
        dmId:       dmChatInfo.dmId,
        chatId:     dmChatInfo.id,
        cryptoKey:  cryptoKey || null,
        otherNick:  dmChatInfo.otherNick,
        isPending:  dmChatInfo.isPending || false,
      });
      setActiveChatId(dmChatInfo.id);
      markSeen(dmChatInfo.id, Date.now());
      setDerivingId(null);
      setShowSidebar(false);
    } catch (err) {
      console.error('[app] DM open error:', err);
      setDeriveError('Ошибка ключа DM');
      setDerivingId(null);
    }
  }, [privateKey, account]);

  // ── Open a Group chat ────────────────────────────────────────────────────────
  const openGroup = useCallback(async (groupChatInfo, myPrivKey) => {
    const effKey = myPrivKey || privateKey;
    setDerivingId(groupChatInfo.id);
    setDeriveError('');
    try {
      let cryptoKey;
      if (effKey && groupChatInfo.encryptedGroupKey && groupChatInfo.encryptedBy) {
        // Fetch the encryptor's public key (who encrypted the group key for us)
        const encBy = groupChatInfo.encryptedBy.toLowerCase();
        const myNick = account.nickname.toLowerCase();

        let wrapKey;
        if (encBy === myNick) {
          // Self-encrypted (creator): ECDH(myPriv, myPub)
          const session = loadSavedSession();
          if (session?.pubKeyB64) {
            const myPubKey = await importPublicKey(session.pubKeyB64);
            wrapKey = await deriveGroupWrapKey(effKey, myPubKey);
          }
        } else {
          // Encrypted by someone else
          const res  = await fetch(`/users/pubkey/${encodeURIComponent(encBy)}`);
          const data = await res.json();
          if (data.pubKey) {
            const encryptorPubKey = await importPublicKey(data.pubKey);
            wrapKey = await deriveGroupWrapKey(effKey, encryptorPubKey);
          }
        }

        if (wrapKey) {
          cryptoKey = await unwrapGroupKey(groupChatInfo.encryptedGroupKey, wrapKey);
        }
      }

      setActiveSession({
        type:      'group',
        nickname:  account?.nickname,
        groupId:   groupChatInfo.groupId,
        chatId:    groupChatInfo.id,
        cryptoKey: cryptoKey || null,
        groupName: groupChatInfo.name,
        isPending: groupChatInfo.isPending || false,
      });
      setActiveChatId(groupChatInfo.id);
      markSeen(groupChatInfo.id, Date.now());
      setDerivingId(null);
      setShowSidebar(false);
    } catch (err) {
      console.error('[app] Group open error:', err);
      setDeriveError('Ошибка ключа группы');
      setDerivingId(null);
    }
  }, [privateKey, account]);

  // ── Select chat from sidebar ──────────────────────────────────────────────────
  const handleSelectChat = useCallback((chat) => {
    if (chat.id === activeChatId) { setShowSidebar(false); return; }
    if (chat.type === 'dm')     return openDM(chat);
    if (chat.type === 'group')  return openGroup(chat);
    // Legacy
    deriveAndOpenLegacy(chat);
  }, [activeChatId, openDM, openGroup, deriveAndOpenLegacy]);

  // ── New Legacy chat ───────────────────────────────────────────────────────────
  const handleNewLegacy = useCallback(async ({ seedPhrase, name }) => {
    setDerivingId('__new__');
    setDeriveError('');
    try {
      const [roomId, cryptoKey] = await Promise.all([
        deriveRoomId(seedPhrase),
        deriveKey(seedPhrase),
      ]);
      let target = null;
      setLegacyList(prev => {
        const existing = prev.find(c => c.roomId === roomId);
        if (existing) { target = existing; return prev; }
        const newChat = {
          id: 'legacy-' + Date.now() + '-' + Math.random().toString(36).slice(2),
          type: 'legacy', seedPhrase, roomId,
          name: name || 'Канал', lastMessage: '', lastTs: null, unread: 0, addedAt: Date.now(),
        };
        target = newChat;
        return [newChat, ...prev];
      });
      if (target) {
        setActiveSession({ type: 'legacy', nickname: account?.nickname, roomId, cryptoKey, chatId: target.id });
        setActiveChatId(target.id);
      }
      setShowNewLegacy(false);
      setDerivingId(null);
      setShowSidebar(false);
    } catch {
      setDeriveError('Ошибка ключа');
      setDerivingId(null);
    }
  }, [account]);

  // ── New DM (from user search) ─────────────────────────────────────────────────
  const handleStartDM = useCallback(async (user) => {
    setShowNewDM(false);
    // Create DM request on server
    try {
      const res = await fetch('/dm/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromNick: account.nickname, toNick: user.nickname }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }

      const { dmId } = data;
      const dmChatInfo = {
        id: dmId, type: 'dm',
        name: '@' + user.nickname,
        dmId, otherNick: user.nickname,
        isPending: false, lastMessage: '', lastTs: null, unread: 0,
      };

      setDmList(prev => {
        const exists = prev.find(c => c.id === dmId);
        if (exists) return prev;
        return [dmChatInfo, ...prev];
      });

      openDM(dmChatInfo);
    } catch (err) {
      console.error('[app] DM request error:', err);
    }
  }, [account, openDM]);

  // ── New Group (from group create modal) ───────────────────────────────────────
  const handleGroupCreated = useCallback((groupId, groupKey, groupName) => {
    setShowNewGroup(false);
    const groupChatInfo = {
      id: groupId, type: 'group',
      name: groupName, groupId,
      encryptedGroupKey: null, // key is already in memory
      isPending: false, lastMessage: '', lastTs: null, unread: 0,
    };
    setGroupList(prev => [groupChatInfo, ...prev]);
    // Open directly (groupKey already derived)
    setActiveSession({ type: 'group', nickname: account?.nickname, groupId, chatId: groupId, cryptoKey: groupKey, groupName });
    setActiveChatId(groupId);
    setShowSidebar(false);
  }, [account]);

  // ── Invite user to existing group (called from ChatScreen header button) ─────
  const handleGroupInvite = useCallback(async (user) => {
    setShowGroupInvite(false);
    if (!activeSession || activeSession.type !== 'group') return;
    if (!privateKey) return;
    try {
      let encryptedGroupKey = null;
      if (user.pubKey && activeSession.cryptoKey) {
        const theirPubKey = await importPublicKey(user.pubKey);
        const wrapKey     = await deriveGroupWrapKey(privateKey, theirPubKey);
        encryptedGroupKey = await wrapGroupKey(activeSession.cryptoKey, wrapKey);
      }
      const res = await fetch('/groups/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId:          activeSession.groupId,
          toNick:           user.nickname,
          encryptedGroupKey,
          fromNick:         account.nickname,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Ошибка при приглашении');
      }
    } catch (err) {
      console.error('[app] Group invite error:', err);
      alert('Ошибка при приглашении');
    }
  }, [activeSession, privateKey, account]);

  // ── Update chat preview (called from ChatScreen) ──────────────────────────────
  const handleUpdateChat = useCallback((chatId, updates) => {
    const { lastMessage, lastTs, name } = updates;
    if (lastTs) markSeen(chatId, lastTs);
    setDmList    (prev => prev.map(c => c.id === chatId ? { ...c, ...(lastMessage !== undefined && { lastMessage }), ...(lastTs !== undefined && { lastTs }), ...(name !== undefined && { name }), unread: 0 } : c));
    setGroupList (prev => prev.map(c => c.id === chatId ? { ...c, ...(lastMessage !== undefined && { lastMessage }), ...(lastTs !== undefined && { lastTs }), ...(name !== undefined && { name }), unread: 0 } : c));
    setLegacyList(prev => prev.map(c => c.id === chatId ? { ...c, ...(lastMessage !== undefined && { lastMessage }), ...(lastTs !== undefined && { lastTs }), unread: 0 } : c));
  }, []);

  // ── Group info panel callbacks ────────────────────────────────────────────────
  const handleGroupInfoUpdated = useCallback(({ name, avatar, left }) => {
    if (left) {
      setGroupList(prev => prev.filter(g => g.id !== activeSession?.groupId));
      setActiveSession(null);
      setActiveChatId(null);
      setShowGroupInfo(false);
      setShowSidebar(true);
      return;
    }
    if (name) {
      setGroupList(prev => prev.map(g => g.id === activeSession?.groupId ? { ...g, name } : g));
      setActiveSession(prev => prev ? { ...prev, groupName: name } : prev);
    }
    if (avatar !== undefined) {
      setGroupList(prev => prev.map(g => g.id === activeSession?.groupId ? { ...g, avatar } : g));
    }
  }, [activeSession]);

  // ── DM Request accepted by me (recipient side) ────────────────────────────────
  const handleDMRequestAccepted = useCallback((dmId, fromNick) => {
    setDmRequests(prev => prev.filter(r => r.dmId !== dmId));
    // Move to DM list if not already there
    setDmList(prev => {
      if (prev.find(d => d.id === dmId)) return prev;
      return [{ id: dmId, type: 'dm', name: '@' + fromNick, dmId, otherNick: fromNick, lastMessage: '', lastTs: null, unread: 0 }, ...prev];
    });
  }, []);

  // ── DM accepted by other party (sender side) ──────────────────────────────────
  // Called when the recipient accepts our DM request — remove isPendingSent flag
  const handleDMAccepted = useCallback((dmId) => {
    setDmList(prev => prev.map(d =>
      d.id === dmId ? { ...d, isPendingSent: false } : d
    ));
  }, []);

  // ── Group invite accepted ─────────────────────────────────────────────────────
  const handleGroupInviteAccepted = useCallback(async (groupId, encryptedGroupKey, encryptedBy, groupName) => {
    // Re-derive the group key
    const chat = { id: groupId, type: 'group', name: groupName, groupId, encryptedGroupKey, encryptedBy, isPending: false };
    setGroupList(prev => {
      const idx = prev.findIndex(g => g.id === groupId);
      if (idx >= 0) return prev.map((g, i) => i === idx ? { ...g, isPending: false } : g);
      return [chat, ...prev];
    });
    openGroup(chat);
  }, [openGroup]);

  // ── Render ─────────────────────────────────────────────────────────────────────

  if (!account) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  if (needsUnlock && !privateKey) {
    return (
      <UnlockScreen
        nickname={account.nickname}
        authSalt={account.authSalt}
        onUnlocked={handleUnlocked}
        onLogout={handleLogout}
      />
    );
  }

  const activeChat = (
    dmList.find(c => c.id === activeChatId) ||
    groupList.find(c => c.id === activeChatId) ||
    legacyList.find(c => c.id === activeChatId)
  );

  return (
    <div className="app-layout">

      {/* ── Sidebar wrapper ── */}
      <div className={'sidebar-wrapper' + (showSidebar ? ' sidebar-wrapper--open' : '')}>
        <Sidebar
          account={account}
          myAvatar={myAvatar}
          dmList={dmList}
          groupList={groupList}
          legacyList={legacyList}
          dmRequests={dmRequests}
          activeChatId={activeChatId}
          derivingId={derivingId}
          onSelectChat={handleSelectChat}
          onNewDM={() => setShowNewDM(true)}
          onNewGroup={() => setShowNewGroup(true)}
          onNewLegacy={() => { setDeriveError(''); setShowNewLegacy(true); }}
          onLogout={handleLogout}
          onOpenProfile={() => setShowProfile(true)}
        />
      </div>

      {/* Mobile overlay */}
      {showSidebar && (
        <div className="sidebar-overlay" onClick={() => setShowSidebar(false)} />
      )}

      {/* ── Main area ── */}
      <div className="app-main">
        {activeSession ? (
          <ChatScreen
            key={activeSession.chatId}
            session={activeSession}
            chatName={activeSession.type === 'dm' ? activeSession.otherNick : activeChat?.name}
            onLeaveRoom={() => { setActiveChatId(null); setActiveSession(null); setShowSidebar(true); }}
            onLogout={handleLogout}
            onUpdateChat={handleUpdateChat}
            onToggleSidebar={() => setShowSidebar(v => !v)}
            onDMRequestAccepted={handleDMRequestAccepted}
            onDMAccepted={handleDMAccepted}
            onInviteToGroup={activeSession.type === 'group' ? () => setShowGroupInvite(true) : undefined}
            onOpenGroupInfo={activeSession.type === 'group' ? () => setShowGroupInfo(true) : undefined}
            chatAvatar={activeSession.type === 'dm'
              ? (dmList.find(c => c.id === activeChatId)?.peerAvatar || null)
              : activeSession.type === 'group'
              ? (groupList.find(c => c.id === activeChatId)?.avatar || null)
              : null
            }
          />
        ) : (
          <div className="app-welcome">
            <div className="app-welcome-inner">
              <div className="app-welcome-logo">EM</div>
              <h2 className="app-welcome-title">Echo Messenger</h2>
              <p className="app-welcome-sub">Выберите чат или начните новый</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="login-btn" onClick={() => setShowNewDM(true)}
                  style={{ width: 'auto', paddingLeft: 20, paddingRight: 20, fontSize: 13 }}>
                  💬 Написать
                </button>
                <button className="login-btn" onClick={() => setShowNewGroup(true)}
                  style={{ width: 'auto', paddingLeft: 20, paddingRight: 20, fontSize: 13, background: 'rgba(79,142,247,0.15)' }}>
                  👥 Группа
                </button>
              </div>
              {deriveError && <p className="login-error" style={{ marginTop: 12 }}>{deriveError}</p>}
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {showNewLegacy && (
        <NewChatModal
          onJoin={handleNewLegacy}
          onClose={() => { setShowNewLegacy(false); setDeriveError(''); }}
          isLoading={derivingId === '__new__'}
          error={deriveError}
        />
      )}

      {showNewDM && (
        <UserSearchModal
          onStartDM={handleStartDM}
          onClose={() => setShowNewDM(false)}
        />
      )}

      {showGroupInvite && activeSession?.type === 'group' && (
        <UserSearchModal
          title="👥 Добавить в группу"
          actionLabel="Добавить"
          onStartDM={handleGroupInvite}
          onClose={() => setShowGroupInvite(false)}
        />
      )}

      {showNewGroup && (
        <GroupCreateModal
          myNick={account.nickname}
          myPrivKey={privateKey}
          myPubKeyB64={account.pubKeyB64}
          onCreated={handleGroupCreated}
          onClose={() => setShowNewGroup(false)}
        />
      )}

      {showGroupInfo && activeSession?.type === 'group' && (
        <GroupInfoPanel
          groupId={activeSession.groupId}
          myNick={account.nickname}
          onClose={() => setShowGroupInfo(false)}
          onGroupUpdated={handleGroupInfoUpdated}
          onInvite={() => { setShowGroupInfo(false); setShowGroupInvite(true); }}
        />
      )}

      {showProfile && (
        <ProfileModal
          nickname={account.nickname}
          currentAvatar={myAvatar}
          onClose={() => setShowProfile(false)}
          onAvatarUpdated={(b64) => setMyAvatar(b64)}
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
