import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發時前端跑 5173，/api 代理到 Node gateway 3000（同一份相對路徑，build 後由 gateway 同源 serve）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
