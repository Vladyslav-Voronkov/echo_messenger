import { lazy, Suspense } from 'react';
import { WC_CONFIGURED } from '../lib/wallet.js';

// Lazily loaded — only imported when WC_CONFIGURED=true and WagmiProvider is in tree
// This avoids importing AppKit hooks before the provider is mounted
const WalletPanelActive = lazy(() => import('./WalletPanelActive.jsx'));

/**
 * WalletPanel — two modes:
 *   mode="full"    → RoomScreen (full card with balance rows + Tron input)
 *   mode="compact" → ChatScreen header (pill badge)
 */
export default function WalletPanel({ mode = 'full' }) {
  if (!WC_CONFIGURED) {
    if (mode === 'compact') return null;
    return (
      <div className="wallet-panel wallet-panel--unconfigured">
        <span className="wallet-unconfigured-text">
          WalletConnect не настроен — укажите VITE_WC_PROJECT_ID
        </span>
      </div>
    );
  }
  return (
    <Suspense fallback={mode === 'compact' ? null : <div className="wallet-panel" />}>
      <WalletPanelActive mode={mode} />
    </Suspense>
  );
}
