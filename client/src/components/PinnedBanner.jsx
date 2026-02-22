import { useMemo } from 'react';

function getPreviewText(msg) {
  if (!msg) return '...';
  try {
    const parsed = JSON.parse(msg.text);
    if (parsed && parsed.type === 'image') return '📸 Фотография';
    if (parsed && parsed.type === 'file') return '📎 ' + (parsed.file?.name || 'Файл');
    if (parsed && parsed.type === 'voice') return '🎙 Голосовое сообщение';
    if (parsed && parsed.text) return parsed.text;
  } catch { /* not JSON — plain text */ }
  return msg.text || '...';
}

export default function PinnedBanner({ pins, messages, activePinIdx, onChangePin, onScrollToPin }) {
  if (!pins || pins.length === 0) return null;

  const activePin = pins[activePinIdx] ?? pins[0];

  // Find the message with matching ts
  const pinnedMsg = useMemo(
    () => messages.find(m => m.ts === activePin.ts),
    [messages, activePin.ts]
  );

  const previewText = getPreviewText(pinnedMsg);
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
      <span className="pinned-icon">📌</span>
      <div className="pinned-content">
        <span className="pinned-label">
          Закреплено {pins.length > 1 ? `(${activePinIdx + 1}/${pins.length})` : ''}
          {senderNick ? ' · ' + senderNick : ''}
        </span>
        <span className="pinned-text">{displayText}</span>
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
