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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/review/sw.js', { scope: '/review/' }).catch(() => {})
  })
}
