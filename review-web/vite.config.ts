import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/review/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Vite 8/Rolldown 下 vite-plugin-pwa 無法 emit registerSW.js（"assigns to bundle
      // variable … This will be ignored"），導致注入的 <script> 404、SW 永不註冊。
      // 改成不注入、由 main.tsx 手動 register 已正確產生的 sw.js。
      injectRegister: false,
      manifest: {
        name: '個股全面審視網',
        short_name: '個股審視',
        description: '提供台股籌碼與多維度指標審查的專業交易輔助工具',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        start_url: '/review/',
        scope: '/review/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        navigateFallback: '/review/index.html',
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/,
            handler: 'NetworkOnly'
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lightweight-charts')) {
              return 'vendor-charts';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            return 'vendor';
          }
        }
      }
    }
  }
})
