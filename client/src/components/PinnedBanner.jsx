import { useMemo } from 'react';

/* ── SVG icons ── */
const IconPin = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z"/>
  </svg>
);
const IconImage = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);
const IconFile = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
    <polyline points="13 2 13 9 20 9"/>
  </svg>
);
const IconMic = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
    <path d="M19 10v2a7 7 0 01-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);

function getPreviewText(msg) {
  if (!msg) return '...';
  try {
    const parsed = JSON.parse(msg.text);
    if (parsed && parsed.type === 'image') return { icon: 'image', text: 'Фотография' };
    if (parsed && parsed.type === 'file') return { icon: 'file', text: parsed.file?.name || 'Файл' };
    if (parsed && parsed.type === 'voice') return { icon: 'voice', text: 'Голосовое сообщение' };
    if (parsed && parsed.text) return { icon: null, text: parsed.text };
  } catch { /* not JSON — plain text */ }
  return { icon: null, text: msg.text || '...' };
}

export default function PinnedBanner({ pins, messages, activePinIdx, onChangePin, onScrollToPin }) {
  if (!pins || pins.length === 0) return null;

  const activePin = pins[activePinIdx] ?? pins[0];

  // Find the message with matching ts
  const pinnedMsg = useMemo(
    () => messages.find(m => m.ts === activePin.ts),
    [messages, activePin.ts]
  );

  const { icon: previewIcon, text: previewText } = getPreviewText(pinnedMsg);
  const displayText = previewText.length > 60 ? previewText.slice(0, 60) + '...' : previewText;
  const senderNick = pinnedMsg?.nick || '';

  const handleClick = () => {
    if (pinnedMsg) onScrollToPin(pinnedMsg.id);
  };

  const handlePrev = (e) => {
    e.stopPropagation();
    onChangePin(-1);
  };

  const handleNext = (e) => {
    e.stopPropagation();
    onChangePin(+1);
  };

  return (
    <div className="pinned-banner" onClick={handleClick} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && handleClick()}>
      <span className="pinned-icon" style={{ color: 'var(--accent)' }}>
        <IconPin />
      </span>
      <div className="pinned-content">
        <span className="pinned-label">
          Закреплено {pins.length > 1 ? `(${activePinIdx + 1}/${pins.length})` : ''}
          {senderNick ? ' · ' + senderNick : ''}
        </span>
        <span className="pinned-text">
          {previewIcon === 'image' && <IconImage />}
          {previewIcon === 'file' && <IconFile />}
          {previewIcon === 'voice' && <IconMic />}
          {' '}{displayText}
        </span>
      </div>
      {pins.length > 1 && (
        <div className="pinned-nav" role="group" aria-label="Навигация по закреплённым">
          <button className="pinned-nav-btn" onClick={handlePrev} title="Предыдущее закреплённое">‹</button>
          <button className="pinned-nav-btn" onClick={handleNext} title="Следующее закреплённое">›</button>
        </div>
      )}
    </div>
  );
}
