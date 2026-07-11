import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 手動註冊 vite-plugin-pwa 產生的 sw.js（子路徑 /review/）。
// 不走 plugin 注入的 registerSW.js，因為 Rolldown 不會 emit 那支檔案（見 vite.config.ts）。
if ('serviceWorker' in navigator) {
  // 載入時本頁是否已有 SW 在控制：用來區分「首次安裝」與「版本更新」。
  const hadController = !!navigator.serviceWorker.controller
  let reloaded = false

  // sw.js 走 registerType:'autoUpdate'＋workbox skipWaiting+clientsClaim（見
  // vite.config.ts）：新版 SW 一接管就會觸發 controllerchange → 自動重整一次載入新
  // 資源，免去每次部署後手動 Ctrl+Shift+R。僅在「更新」情境重整（首次安裝不重整，
  // 避免多餘 reload），並用旗標防重複/迴圈。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return
    reloaded = true
    window.location.reload()
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/review/sw.js', { scope: '/review/' }).then((reg) => {
      // 手機 PWA 從背景切回來通常不會觸發真正的重新導覽（不會自動重新 register/
      // 檢查更新），主動在「頁面重新可見」時檢查一次，讓 clientsClaim 有機會接管、
      // 進而觸發上面的 controllerchange 自動重整。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {})
      })
    }).catch(() => {})
  })
}
