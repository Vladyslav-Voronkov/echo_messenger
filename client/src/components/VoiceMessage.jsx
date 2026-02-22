import { useState, useRef, useEffect, useCallback } from 'react';
import { decryptFileFromBinary } from '../utils/crypto.js';

// Pseudo-random waveform heights (decorative, not actual audio data)
const WAVE_HEIGHTS = [6, 10, 16, 22, 18, 12, 24, 20, 8, 14, 22, 16, 10, 20, 24, 12, 18, 8, 14, 6];
const WAVE_BARS = 20;

function formatTime(secs) {
  if (!secs || !isFinite(secs)) return '0:00';
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export default function VoiceMessage({ fileId, mime, duration, cryptoKey, roomId }) {
  const [audioUrl, setAudioUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [realDuration, setRealDuration] = useState(duration || 0);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const loadAudio = useCallback(async () => {
    if (audioUrl) return audioUrl; // already loaded
    setIsLoading(true);
    setError(null);
    try {
      // 1. Fetch encrypted file
      const [encRes, metaRes] = await Promise.all([
        fetch('/files/' + roomId + '/' + fileId),
        fetch('/files/' + roomId + '/' + fileId + '/meta'),
      ]);
      if (!encRes.ok) throw new Error('Ошибка загрузки аудио');
      if (!metaRes.ok) throw new Error('Ошибка загрузки мета');

      const [cipherBuffer, meta] = await Promise.all([
        encRes.arrayBuffer(),
        metaRes.json(),
      ]);

      // 2. Decrypt
      const decrypted = await decryptFileFromBinary(cryptoKey, meta.iv, cipherBuffer);

      // 3. Create blob URL
      const mimeType = mime || meta.mime || 'audio/webm';
      const blob = new Blob([decrypted], { type: mimeType });
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setAudioUrl(url);
      return url;
    } catch (err) {
      console.error('Voice load error:', err);
      setError(err.message || 'Ошибка загрузки');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [audioUrl, cryptoKey, fileId, mime, roomId]);

  const handlePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    // Load first if needed
    const url = audioUrl || await loadAudio();
    if (!url) return;

    // If url was just set, audio.src may not be set yet — set it now
    if (audio.src !== url) {
      audio.src = url;
    }

    try {
      await audio.play();
      setIsPlaying(true);
    } catch (err) {
      console.error('Playback error:', err);
      setError('Ошибка воспроизведения');
    }
  }, [audioUrl, isPlaying, loadAudio]);

  const handleSeek = useCallback((e) => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    const newTime = parseFloat(e.target.value);
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  }, [audioUrl]);

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio) setCurrentTime(audio.currentTime);
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (audio && isFinite(audio.duration) && audio.duration > 0) {
      setRealDuration(audio.duration);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
    if (audioRef.current) audioRef.current.currentTime = 0;
  };

  const displayDuration = realDuration || duration || 0;
  const progress = displayDuration > 0 ? currentTime / displayDuration : 0;

  return (
    <div className="voice-message">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        preload="none"
      />

      {/* Play / Pause button */}
      <button
        className={'voice-play-btn' + (isPlaying ? ' playing' : '')}
        onClick={handlePlayPause}
        disabled={isLoading || !!error}
        aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
      >
        {isLoading ? (
          <span className="spinner" style={{ width: '16px', height: '16px' }} />
        ) : isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="4" width="4" height="16" rx="1" />
            <rect x="15" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Waveform + progress */}
      <div className="voice-body">
        {error ? (
          <span className="voice-error">{error}</span>
        ) : (
          <>
            {/* Waveform bars (decorative) */}
            <div className="voice-waveform" onClick={async (e) => {
              // Click on waveform to seek
              const audio = audioRef.current;
              if (!audio || !audioUrl) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              const newTime = ratio * displayDuration;
              audio.currentTime = newTime;
              setCurrentTime(newTime);
            }}>
              {WAVE_HEIGHTS.slice(0, WAVE_BARS).map((h, i) => (
                <span
                  key={i}
                  style={{
                    height: h + 'px',
                    opacity: progress > i / WAVE_BARS ? 1 : 0.3,
                  }}
                />
              ))}
            </div>

            {/* Progress scrubber */}
            <input
              type="range"
              className="voice-progress"
              min={0}
              max={displayDuration || 1}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              disabled={!audioUrl}
            />
          </>
        )}

        {/* Timer */}
        <div className="voice-footer">
          <span className="voice-timer">
            {audioUrl ? formatTime(currentTime) : formatTime(0)} / {formatTime(displayDuration)}
          </span>
        </div>
      </div>
    </div>
  );
}
