# ECHO MESSENGER

**Зашифрованный мессенджер с нулевым знанием сервера**
**End-to-end encrypted messenger with zero server knowledge**

---

## 🇷🇺 Русский

### Что это такое

Echo Messenger — приватный веб-чат с полным шифрованием на стороне клиента. Сервер хранит только зашифрованные данные и никогда не видит ни содержимое сообщений, ни ники пользователей.

### Как это работает

1. **Ключ шифрования** генерируется из секретной фразы (seed phrase) с помощью PBKDF2 (100 000 итераций, SHA-256). Ключ никогда не покидает браузер.
2. **Сообщения** шифруются алгоритмом AES-256-GCM прямо в браузере перед отправкой на сервер.
3. **Ники** тоже шифруются — сервер не знает, кто именно находится в чате.
4. **Комнаты** — у каждой своя seed phrase, и только те, кто знает фразу, могут прочитать сообщения.

### Безопасность

- 🔐 **AES-256-GCM** — симметричное шифрование с аутентификацией (AEAD)
- 🔑 **PBKDF2** с 100 000 итерациями — защита от брутфорса seed фразы
- 👤 **Нулевое знание** — сервер видит только случайные байты
- 📁 **Без базы данных** — сообщения хранятся в плоских файлах (`.txt`) в зашифрованном виде
- 🚫 **Без аккаунтов** — идентификация только через seed фразу

### Возможности

- Текстовые сообщения, фото, файлы, голосовые сообщения
- Ответы на сообщения, реакции (лайки), закрепление сообщений
- Индикатор печати, подтверждение прочтения (✓✓)
- Уведомления браузера и звук при новых сообщениях
- Счётчик непрочитанных на кнопке прокрутки
- Плавающая метка с датой при скролле (как в Telegram)

### Запуск локально

```bash
# Клонировать репозиторий
git clone <repo-url>
cd CHAT

# Установить зависимости и запустить
start.bat
# или:
cd client && npm install && npm run dev  # запускает Vite на :5173
cd server && npm install && node index.js  # запускает сервер на :3001
```

### Деплой на Railway

1. Подключить GitHub репозиторий к Railway
2. Добавить переменную: `DATA_DIR=/app/data`
3. Подключить Volume к `/app/data` (для хранения данных)
4. Деплой произойдёт автоматически при пуше в нужную ветку

---

## 🇬🇧 English

### What is this

Echo Messenger is a private web chat with full client-side encryption. The server only stores encrypted data and never sees message content or usernames.

### How it works

1. **Encryption key** is derived from a secret seed phrase using PBKDF2 (100,000 iterations, SHA-256). The key never leaves the browser.
2. **Messages** are encrypted with AES-256-GCM directly in the browser before being sent to the server.
3. **Nicknames** are also encrypted — the server doesn't know who is in the chat.
4. **Rooms** — each room has its own seed phrase; only those who know the phrase can read the messages.

### Security

- 🔐 **AES-256-GCM** — authenticated symmetric encryption (AEAD)
- 🔑 **PBKDF2** with 100,000 iterations — brute-force protection for seed phrases
- 👤 **Zero knowledge** — the server only sees random bytes
- 📁 **No database** — messages stored as encrypted flat files (`.txt`)
- 🚫 **No accounts** — authentication only via seed phrase

### Features

- Text messages, photos, files, voice messages
- Reply to messages, reactions (likes), pinned messages
- Typing indicator, read receipts (✓✓)
- Browser notifications and sound for new messages
- Unread counter on the scroll-to-bottom button
- Floating date label while scrolling (like Telegram)

### Run locally

```bash
# Clone the repository
git clone <repo-url>
cd CHAT

# Install dependencies and run
start.bat
# or:
cd client && npm install && npm run dev  # Vite on :5173
cd server && npm install && node index.js  # Server on :3001
```

### Deploy on Railway

1. Connect your GitHub repository to Railway
2. Add variable: `DATA_DIR=/app/data`
3. Attach a Volume to `/app/data` (for persistent storage)
4. Deploys automatically on push to the configured branch

---

### Architecture / Архитектура

```
Browser (React + Vite)
  │  AES-256-GCM encrypt/decrypt (Web Crypto API)
  │  PBKDF2 key derivation
  │  Socket.io client
  ▼
Node.js Server (Express + Socket.io)
  │  Receives/broadcasts only encrypted blobs
  │  Never decrypts anything
  │  Flat file storage: chats/<roomId>.txt
  ▼
Filesystem / Railway Volume
  │  Encrypted message lines (JSON)
  │  Encrypted nick in every line
```

---

*Echo Messenger — ваши слова остаются вашими.*
*Echo Messenger — your words stay yours.*
