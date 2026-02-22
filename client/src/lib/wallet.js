import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, polygon } from '@reown/appkit/networks';
import { createPublicClient, http, formatUnits } from 'viem';

// ── Config ──────────────────────────────────────────────────────────────────
export const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID || '';
export const WC_CONFIGURED = Boolean(WC_PROJECT_ID);

// ── USDT contract addresses ──────────────────────────────────────────────────
export const USDT_ETH          = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const USDT_POLYGON      = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
export const USDT_TRON         = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Minimal ERC-20 ABI (balanceOf only)
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

// ── Networks ─────────────────────────────────────────────────────────────────
export const supportedNetworks = [mainnet, polygon];

// ── Wagmi adapter ────────────────────────────────────────────────────────────
export const wagmiAdapter = WC_CONFIGURED
  ? new WagmiAdapter({
      projectId: WC_PROJECT_ID,
      networks: supportedNetworks,
    })
  : null;

// ── AppKit (WalletConnect modal) ─────────────────────────────────────────────
// Initialized once at module load time — safe as a side effect.
export let appKit = null;
if (WC_CONFIGURED && wagmiAdapter) {
  appKit = createAppKit({
    adapters: [wagmiAdapter],
    networks: supportedNetworks,
    projectId: WC_PROJECT_ID,
    metadata: {
      name: 'Echo Messenger',
      description: 'Зашифрованный мессенджер',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://echo.app',
      icons: [],
    },
    features: { analytics: false },
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#4f8ef7',
      '--w3m-border-radius-master': '4px',
    },
  });
}

// ── LocalStorage helpers ─────────────────────────────────────────────────────
export const WALLET_STORAGE_KEY = 'echo_wallet_address';

export function getSavedWallet() {
  try { return localStorage.getItem(WALLET_STORAGE_KEY) || null; } catch { return null; }
}

export function saveWallet(address) {
  try {
    if (address) localStorage.setItem(WALLET_STORAGE_KEY, address);
    else localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch { /* ignore */ }
}

// ── Public viem clients (no API key needed for read-only) ────────────────────
const ethClient  = createPublicClient({ chain: mainnet, transport: http() });
const polyClient = createPublicClient({ chain: polygon,  transport: http() });

async function fetchErc20Balance(publicClient, contractAddress, walletAddress) {
  try {
    const raw = await publicClient.readContract({
      address: contractAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    });
    // USDT on both ETH and Polygon uses 6 decimals
    return formatUnits(raw, 6);
  } catch {
    return null;
  }
}

async function fetchTronUsdtBalance(tronAddress) {
  // TronScan public API — no auth key, CORS open
  try {
    const url = `https://apilist.tronscanapi.com/api/account/tokens?address=${encodeURIComponent(tronAddress)}&start=0&limit=20&token=${USDT_TRON}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const token = (data?.data ?? []).find(t => t.tokenId === USDT_TRON);
    if (!token) return '0';
    return formatUnits(BigInt(String(token.quantity || 0)), token.tokenDecimal ?? 6);
  } catch {
    return null;
  }
}

/**
 * Fetch USDT balances across ETH, Polygon, and (optionally) Tron in parallel.
 * Returns { eth, polygon, tron } — each is a decimal string like "12.34" or null on error.
 */
export async function fetchAllUsdtBalances(evmAddress, tronAddress) {
  const [eth, poly, tron] = await Promise.allSettled([
    fetchErc20Balance(ethClient,  USDT_ETH,     evmAddress),
    fetchErc20Balance(polyClient, USDT_POLYGON, evmAddress),
    tronAddress ? fetchTronUsdtBalance(tronAddress) : Promise.resolve(null),
  ]);
  return {
    eth:     eth.status     === 'fulfilled' ? eth.value     : null,
    polygon: poly.status    === 'fulfilled' ? poly.value    : null,
    tron:    tron.status    === 'fulfilled' ? tron.value    : null,
  };
}
