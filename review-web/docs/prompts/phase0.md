# Phase 0 — 骨架與契約盤點（個股全面審視網）

> 你（Claude）正在協助使用者開發新專案「**個股全面審視網**」。本檔是 Phase 0 的工作說明。
> **互動模式：你提供「本階段希望看到的內容＋驗收標準」並解答疑問；使用者自己寫 code；寫完後你做 review。本階段不要你直接寫產品程式碼。**

## 0. 先讀（建立脈絡）

- 專案總綱（SSOT）：`C:\CC AI Agent\review-web\docs\ROADMAP.md` ← **務必先讀**
- 既有後端 API：`C:\CC AI Agent\docs\api.md`、`C:\CC AI Agent\web\src\lib\api.ts`
- 既有前端可借用元件：`C:\CC AI Agent\web\src\`（`components/`、`lib/`）

一句話定位：**新前端 `review-web/`（Vite+React+TS+Tailwind+lightweight-charts，桌面優先 RWD + PWA，個人自用），資料/AI 沿用既有 engine(8000)+gateway(3000) 的 `/api`，缺口才在既有 repo 補新端點。**

## 1. 本階段目標

把專案地基打好，並把「要打哪些 API、缺哪些」釘死成文件，避免後續階段才發現要動後端。

## 2. 希望看到的內容（交付物）

**A. 前端腳手架 `review-web/`**
1. Vite + React + TypeScript 專案（`npm create vite`），裝 Tailwind、lightweight-charts。
2. **設計系統雛形**：Tailwind 設定（深色為主的金融配色 token、漲跌色、字級/間距）、共用排版容器。
3. **RWD 策略定稿**：桌面優先的多欄 dashboard 斷點（建議 `lg/xl` 多欄、`md` 以下收合單欄），寫成一份說明 + 一個示範頁驗證。
4. **路由**：`/`（盤勢總覽首頁，先放佔位）、`/stock/:code`（個股頁，先放佔位）。
5. **API client**：`src/lib/api.ts`，**只打 `/api`**（dev 用 Vite proxy 轉到 `http://localhost:3000`），沿用既有錯誤格式 `{ error:{ code,message,detail? } }` 與 `ApiError`。可直接借用既有 `web/src/lib/api.ts` 的型別。
6. **PWA 殼**：`manifest.webmanifest` + 基本 service worker（`vite-plugin-pwa` 可），確保「加到主畫面」可行（圖示先用佔位）。
7. 健康檢查：首頁能成功打 `GET /api/health` 並顯示 engine up/down。

**B. 正式版「API 契約盤點」文件**（放 `review-web/docs/contracts.md`，並同步 Obsidian `5_API與契約`）
- 逐模組列出：需要的資料 → 既有端點(有/無) → 缺口 → 預計新端點的 **request/response 草案 schema**。
- 重點把這 7 個新端點的契約先草擬（欄位、型別、來源）：
  - `/api/market/indices`、`/api/market/breadth`、`/api/market/sectors`、`/api/market/institutional`
  - `/api/stocks/:code/chips`、`/api/stocks/:code/fundamentals`、`/api/stocks/:code/news`
- 標明各端點的資料源（FinMind / 富果 / TWSE MIS / TAIFEX / yfinance）與 live-only 與否。

## 3. 技術約束

- 只打 gateway `/api`，**絕不直連 engine、不在前端重算分數**。
- 沿用既有錯誤格式與降級觀念；engine down 要能優雅顯示而非白屏。
- 不動既有 `web/`、`engine/`、`gateway`（Phase 0 純前端骨架 + 文件，**不需新增後端端點**，端點實作留 Phase 1+）。
- 桌面優先，但 `md` 以下不可破版。

## 4. 驗收標準

- [ ] `cd review-web && npm i && npm run dev` 起得來，`tsc` 零錯、`npm run build` 過。
- [ ] 首頁打得到 `/api/health`（dev proxy 設好），engine 開/關都不白屏。
- [ ] `/` 與 `/stock/2330` 路由可走，RWD 在桌面多欄、手機單欄各截一張驗證。
- [ ] PWA 可「加到主畫面」（Lighthouse PWA 基本項或手動驗證）。
- [ ] `review-web/docs/contracts.md` 完成，7 個新端點皆有 request/response 草案與資料源標註。

## 5. 你（Claude）本階段要做的事

1. 讀完上面「先讀」清單，向使用者**複述 Phase 0 希望看到的內容**，確認共識、列出你建議的目錄結構與 npm 套件清單。
2. 解答使用者實作中的疑問（Vite proxy、Tailwind 設定、PWA 套件選擇、要借用哪些既有元件等）。
3. 使用者寫完後，**對照第 4 節驗收標準 review**：跑得起來嗎？型別過嗎？只打 `/api` 嗎？契約盤點完整嗎？
4. 通過後提醒使用者更新 `ROADMAP.md` 狀態、Obsidian、記憶，並請我校正 `phase1.md` 與現況的落差再進 Phase 1。

## 6. 帶進 review 的既有坑（見 ROADMAP §7）

老王 emoji 相反、型別分歧（water_level 0~1 / sentiment 0~100）、K線預設還原價、分K/內外盤需富果金鑰且要降級、`agents/decide` 很貴、engine down 要降級。Phase 0 多數還用不到，但 API client 與契約盤點要先把這些註記寫進去。
