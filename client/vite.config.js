import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

function getBuildInfo() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const date = new Date().toISOString().slice(0, 10);
    return `${sha} · ${date}`;
  } catch { return 'dev'; }
}

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(getBuildInfo()),
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // In dev: proxy API and WebSocket to the local Node server
      '/history':  { target: 'http://localhost:3001', changeOrigin: true },
      '/auth':     { target: 'http://localhost:3001', changeOrigin: true },
      '/upload':   { target: 'http://localhost:3001', changeOrigin: true },
      '/files':    { target: 'http://localhost:3001', changeOrigin: true },
      '/users':    { target: 'http://localhost:3001', changeOrigin: true },
      '/dm':       { target: 'http://localhost:3001', changeOrigin: true },
      '/groups':   { target: 'http://localhost:3001', changeOrigin: true },
      '/push':     { target: 'http://localhost:3001', changeOrigin: true },
      '/apns':     { target: 'http://localhost:3001', changeOrigin: true },
      '/admin':    { target: 'http://localhost:3001', changeOrigin: true },
      '/vault':    { target: 'http://localhost:3001', changeOrigin: true },
      '/likes':    { target: 'http://localhost:3001', changeOrigin: true },
      '/pins':     { target: 'http://localhost:3001', changeOrigin: true },
      '/reads':    { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
