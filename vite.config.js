import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // xfwd: pass the browser's IP on as X-Forwarded-For, for the audit log.
      '/api': { target: 'http://localhost:4010', xfwd: true }
    }
  }
});
