import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // In dev: proxy API and WebSocket to the local Node server
      '/history': { target: 'http://localhost:3001', changeOrigin: true },
      '/auth':    { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true, // proxy WebSocket upgrades too
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
