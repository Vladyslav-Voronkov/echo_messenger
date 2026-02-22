import { useState, useEffect, useCallback } from 'react';
import { useAppKit, useAppKitAccount } from '@reown/appkit/react';
import { saveWallet, fetchAllUsdtBalances } from '../lib/wallet.js';
import { truncateAddr, formatUsdt } from './WalletPanel.jsx';

export default function WalletPanelActive({ mode }) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  const [balances, setBalances] = useState({ eth: null, polygon: null, tron: null });
  const [loading, setLoading]   = useState(false);
  const [tronAddr, setTronAddr] = useState('');

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

  useEffect(() => {
    if (isConnected && address) fetchBalances();
  }, [isConnected, address, fetchBalances]);

  if (mode === 'compact') {
    if (!isConnected) {
      return (
        <button className="wallet-connect-btn-compact" onClick={() => open()} title="Подключить кошелёк">
          Кошелёк
        </button>
      );
    }
    const total = ['eth', 'polygon']
      .map(k => parseFloat(balances[k] || '0'))
      .filter(n => !isNaN(n))
      .reduce((a, b) => a + b, 0);
    return (
      <div
        className="wallet-badge-compact"
        title={`${address}\nETH: $${formatUsdt(balances.eth)}\nPolygon: $${formatUsdt(balances.polygon)}\nTron: $${formatUsdt(balances.tron)}`}
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
            <span className="wallet-network-value">{loading ? '...' : `$${formatUsdt(balances.eth)}`}</span>
          </div>
          <div className="wallet-network-row">
            <span className="wallet-network-label">Polygon USDT</span>
            <span className="wallet-network-value">{loading ? '...' : `$${formatUsdt(balances.polygon)}`}</span>
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
              <span className="wallet-network-value">{loading ? '...' : `$${formatUsdt(balances.tron)}`}</span>
            </div>
          </div>
          <button className="wallet-refresh-btn" onClick={fetchBalances} disabled={loading}>
            {loading ? 'Загрузка...' : '↻ Обновить балансы'}
          </button>
        </div>
      )}
    </div>
  );
}
