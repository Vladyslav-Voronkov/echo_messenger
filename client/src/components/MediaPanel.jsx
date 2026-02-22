import { useState, useMemo } from 'react';

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

function getFileIcon(mime) {
  if (!mime) return '📄';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('video')) return '🎬';
  if (mime.includes('audio')) return '🎵';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return '🗜️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('excel') || mime.includes('spreadsheet')) return '📊';
  if (mime.includes('text')) return '📃';
  return '📄';
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
    { id: 'photos', label: '🖼️ Фото', count: photos.length },
    { id: 'files', label: '📎 Файлы', count: files.length },
    { id: 'voices', label: '🎙 Голосовые', count: voices.length },
  ];

  return (
    <div className="media-panel glass">
      {/* Header */}
      <div className="media-panel-header">
        <span className="media-panel-title">Медиафайлы</span>
        <button className="media-panel-close" onClick={onClose} aria-label="Закрыть">✕</button>
      </div>

      {/* Tabs */}
      <div className="media-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={'media-tab' + (activeTab === tab.id ? ' active' : '')}
            onClick={() => setActiveTab(tab.id)}
          >
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
                    <span className="media-grid-thumb-icon">🖼️</span>
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
                  <span className="media-file-icon">{getFileIcon(data.mime)}</span>
                  <div className="media-file-info">
                    <span className="media-file-name">{data.name || 'Файл'}</span>
                    <span className="media-file-meta">
                      {formatSize(data.size)} · {formatDate(msg.ts)} · {msg.nick}
                    </span>
                  </div>
                  <span className="media-file-arrow">›</span>
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
                  <span className="media-file-icon">🎙</span>
                  <div className="media-file-info">
                    <span className="media-file-name">Голосовое сообщение</span>
                    <span className="media-file-meta">
                      {formatDuration(data.duration)} · {formatDate(msg.ts)} · {msg.nick}
                    </span>
                  </div>
                  <span className="media-file-arrow">›</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
