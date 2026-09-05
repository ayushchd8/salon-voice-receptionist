import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied rather than called cross-origin so the staff session
    // cookie is same-origin, httpOnly and never exposed to page scripts.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  // Workspace packages ship TypeScript source; let Vite compile them rather
  // than pre-bundling stale copies.
  optimizeDeps: { exclude: ['@salon/contracts'] },
});
