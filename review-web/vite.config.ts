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
        // skipWaiting 只讓新 SW 自己提前 activate，沒有 clientsClaim 的話它不會接管
        // 「已經開著」的分頁/手機 PWA（要等那個分頁自己整個重新導覽才會換手）——
        // 這正是 src/main.tsx 的 controllerchange 監聽器實測失靈的根因：沒有
        // clientsClaim，controllerchange 在已開啟的分頁上根本不會觸發。
        // cleanupOutdatedCaches 順手清舊版 precache，避免快取膨脹。
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
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
