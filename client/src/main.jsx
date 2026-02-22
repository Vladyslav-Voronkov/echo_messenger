import React from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './index.css';
import { wagmiAdapter, WC_CONFIGURED } from './lib/wallet.js';

const queryClient = new QueryClient();

function Providers({ children }) {
  // Always wrap with WagmiProvider when adapter exists so AppKit hooks work
  if (WC_CONFIGURED && wagmiAdapter) {
    return (
      <WagmiProvider config={wagmiAdapter.wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </WagmiProvider>
    );
  }
  // No WalletConnect configured — still need QueryClientProvider for wagmi internals
  // but skip WagmiProvider entirely so we don't crash without a valid config
  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>
);
