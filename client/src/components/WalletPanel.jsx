import { useState, useEffect, useCallback } from 'react';
import { useAppKit, useAppKitAccount } from '@reown/appkit/react';
import {
  WC_CONFIGURED,
  saveWallet,
  fetchAllUsdtBalances,
} from '../lib/wallet.js';

function truncateAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function formatUsdt(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return n.toFixed(2);
}

/**
 * WalletPanel — two modes:
 *   mode="full"    → used in RoomScreen (full card with balance rows + Tron input)
 *   mode="compact" → used in ChatScreen header (pill badge)
 */
export default function WalletPanel({ mode = 'full' }) {
  // Graceful: hooks must always be called, but we guard rendering below
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  const [balances, setBalances] = useState({ eth: null, polygon: null, tron: null });
  const [loading, setLoading]   = useState(false);
  const [tronAddr, setTronAddr] = useState('');

  // Persist EVM address to localStorage
  useEffect(() => {
    if (isConnected && address) {
      saveWallet(address);
    } else if (!isConnected) {
      saveWallet(null);
      setBalances({ eth: null, polygon: null, tron: null });
    }
  }, [isConnected, address]);

  const fetchBalances = useCallback(async () => {
    if (!isConnected || !address) return;
    setLoading(true);
    const result = await fetchAllUsdtBalances(address, tronAddr.trim() || null);
    setBalances(result);
    setLoading(false);
  }, [isConnected, address, tronAddr]);

  // Auto-fetch when wallet connects or tronAddr changes
  useEffect(() => {
    if (isConnected && address) {
      fetchBalances();
    }
  }, [isConnected, address, fetchBalances]);

  // ── Not configured ────────────────────────────────────────────────────────
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

  // ── Compact mode (ChatScreen header) ─────────────────────────────────────
  if (mode === 'compact') {
    if (!isConnected) {
      return (
        <button className="wallet-connect-btn-compact" onClick={() => open()} title="Подключить кошелёк">
          Кошелёк
        </button>
      );
    }
    // Total EVM USDT (ETH + Polygon)
    const total = ['eth', 'polygon']
      .map(k => parseFloat(balances[k] || '0'))
      .filter(n => !isNaN(n))
      .reduce((a, b) => a + b, 0);
    return (
      <div
        className="wallet-badge-compact"
        title={`${address}\nEthereum: $${formatUsdt(balances.eth)}\nPolygon: $${formatUsdt(balances.polygon)}\nTron: $${formatUsdt(balances.tron)}`}
        onClick={() => open()}
        style={{ cursor: 'pointer' }}
      >
        <span className="wallet-icon">💎</span>
        <span className="wallet-addr">{truncateAddr(address)}</span>
        <span className="wallet-sep">·</span>
        <span className="wallet-usdt">{loading ? '...' : `$${total.toFixed(2)}`}</span>
      </div>
    );
  }

  // ── Full mode (RoomScreen) ────────────────────────────────────────────────
  return (
    <div className="wallet-panel glass">
      <div className="wallet-panel-header">
        <span className="wallet-panel-title">Кошелёк</span>
        {isConnected && (
          <button className="wallet-disconnect-btn" onClick={() => open()} title="Управление кошельком">
            {truncateAddr(address)} ✕
          </button>
        )}
      </div>

      {!isConnected ? (
        <button className="wallet-connect-btn" onClick={() => open()}>
          <span>🔗</span> Подключить кошелёк
        </button>
      ) : (
        <div className="wallet-balances">
          <div className="wallet-network-row">
            <span className="wallet-network-label">Ethereum USDT</span>
            <span className="wallet-network-value">
              {loading ? '...' : `$${formatUsdt(balances.eth)}`}
            </span>
          </div>
          <div className="wallet-network-row">
            <span className="wallet-network-label">Polygon USDT</span>
            <span className="wallet-network-value">
              {loading ? '...' : `$${formatUsdt(balances.polygon)}`}
            </span>
          </div>
          <div className="wallet-network-row wallet-network-tron">
            <span className="wallet-network-label">Tron USDT (TRC-20)</span>
            <div className="wallet-tron-input-row">
              <input
                className="wallet-tron-input"
                type="text"
                placeholder="Введите Tron адрес (T...)"
                value={tronAddr}
                onChange={e => setTronAddr(e.target.value)}
                maxLength={42}
                spellCheck={false}
              />
              <span className="wallet-network-value">
                {loading ? '...' : `$${formatUsdt(balances.tron)}`}
              </span>
            </div>
          </div>
          <button
            className="wallet-refresh-btn"
            onClick={fetchBalances}
            disabled={loading}
          >
            {loading ? 'Загрузка...' : '↻ Обновить балансы'}
          </button>
        </div>
      )}
    </div>
  );
}
