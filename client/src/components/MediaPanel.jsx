import { useState, useMemo } from 'react';

/* ── SVG icons ── */
const IconImage = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);
const IconFile = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
    <polyline points="13 2 13 9 20 9"/>
  </svg>
);
const IconMic = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
    <path d="M19 10v2a7 7 0 01-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);
const IconFilePdf = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);
const IconVideo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="23 7 16 12 23 17 23 7"/>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
  </svg>
);
const IconMusic = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>
);
const IconArchive = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="21 8 21 21 3 21 3 8"/>
    <rect x="1" y="3" width="22" height="5"/>
    <line x1="10" y1="12" x2="14" y2="12"/>
  </svg>
);
const IconFileText = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);
const IconGridImage = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);
const IconVoiceItem = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
    <path d="M19 10v2a7 7 0 01-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);
const IconClose = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const IconChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

function formatDuration(secs) {
  if (!secs) return '0:00';
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function getFileIconComp(mime) {
  if (!mime) return <IconFileText />;
  if (mime.includes('pdf')) return <IconFilePdf />;
  if (mime.includes('video')) return <IconVideo />;
  if (mime.includes('audio')) return <IconMusic />;
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return <IconArchive />;
  if (mime.includes('word') || mime.includes('document')) return <IconFileText />;
  if (mime.includes('excel') || mime.includes('spreadsheet')) return <IconFileText />;
  if (mime.includes('text')) return <IconFileText />;
  return <IconFile />;
}

// Parse message text to extract media info
function parseMediaMsg(msg) {
  try {
    const parsed = JSON.parse(msg.text);
    if (parsed && parsed.type) return parsed;
  } catch { /* not JSON */ }
  return null;
}

export default function MediaPanel({ messages, cryptoKey, roomId, onClose, onScrollToMessage }) {
  const [activeTab, setActiveTab] = useState('photos');

  // Split messages into categories
  const { photos, files, voices } = useMemo(() => {
    const photos = [];
    const files = [];
    const voices = [];
    for (const msg of [...messages].reverse()) {
      const parsed = parseMediaMsg(msg);
      if (!parsed) continue;
      if (parsed.type === 'image' && parsed.image) photos.push({ msg, data: parsed.image });
      else if (parsed.type === 'file' && parsed.file) files.push({ msg, data: parsed.file });
      else if (parsed.type === 'voice' && parsed.voice) voices.push({ msg, data: parsed.voice });
    }
    return { photos, files, voices };
  }, [messages]);

  const tabs = [
    { id: 'photos', icon: <IconImage />, label: 'Фото', count: photos.length },
    { id: 'files', icon: <IconFile />, label: 'Файлы', count: files.length },
    { id: 'voices', icon: <IconMic />, label: 'Голосовые', count: voices.length },
  ];

  return (
    <div className="media-panel glass">
      {/* Header */}
      <div className="media-panel-header">
        <span className="media-panel-title">Медиафайлы</span>
        <button className="media-panel-close" onClick={onClose} aria-label="Закрыть">
          <IconClose />
        </button>
      </div>

      {/* Tabs */}
      <div className="media-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={'media-tab' + (activeTab === tab.id ? ' active' : '')}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
            {tab.count > 0 && <span className="media-tab-count">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="media-panel-content">
        {activeTab === 'photos' && (
          photos.length === 0 ? (
            <div className="media-empty">Нет фотографий</div>
          ) : (
            <div className="media-grid">
              {photos.map(({ msg, data }) => (
                <div
                  key={msg.id}
                  className="media-grid-item"
                  onClick={() => onScrollToMessage(msg.id)}
                  title={'От ' + msg.nick + ' · ' + formatDate(msg.ts)}
                >
                  {/* Thumbnail placeholder — clicking scrolls to the message in chat */}
                  <div className="media-grid-thumb">
                    <span className="media-grid-thumb-icon"><IconGridImage /></span>
                    <span className="media-grid-thumb-date">{formatDate(msg.ts)}</span>
                    <span className="media-grid-thumb-nick">{msg.nick}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'files' && (
          files.length === 0 ? (
            <div className="media-empty">Нет файлов</div>
          ) : (
            <div className="media-file-list">
              {files.map(({ msg, data }) => (
                <div
                  key={msg.id}
                  className="media-file-item"
                  onClick={() => onScrollToMessage(msg.id)}
                >
                  <span className="media-file-icon">{getFileIconComp(data.mime)}</span>
                  <div className="media-file-info">
                    <span className="media-file-name">{data.name || 'Файл'}</span>
                    <span className="media-file-meta">
                      {formatSize(data.size)} · {formatDate(msg.ts)} · {msg.nick}
                    </span>
                  </div>
                  <span className="media-file-arrow"><IconChevronRight /></span>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'voices' && (
          voices.length === 0 ? (
            <div className="media-empty">Нет голосовых сообщений</div>
          ) : (
            <div className="media-file-list">
              {voices.map(({ msg, data }) => (
                <div
                  key={msg.id}
                  className="media-file-item"
                  onClick={() => onScrollToMessage(msg.id)}
                >
                  <span className="media-file-icon"><IconVoiceItem /></span>
                  <div className="media-file-info">
                    <span className="media-file-name">Голосовое сообщение</span>
                    <span className="media-file-meta">
                      {formatDuration(data.duration)} · {formatDate(msg.ts)} · {msg.nick}
                    </span>
                  </div>
                  <span className="media-file-arrow"><IconChevronRight /></span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
