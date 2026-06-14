# 前端 APP（階段 7：Vite + React 行動友善儀表板）

> 程式在 `web/`。**只透過 Node gateway `/api` 取數，絕不直接打 Python engine。**
> 數字全來自後端（engine + reports/）；前端**不重算分數、不重做融合、不碰回測**，只呈現。

## 技術選型
- Vite + React 18 + TypeScript + Tailwind v3 + `lightweight-charts` v4。
- 路由 `react-router-dom`（BrowserRouter；gateway 有 SPA fallback）。
- 報告渲染 `react-markdown` + `remark-gfm`（表格）+ `rehype-raw`（報告內嵌 `<span style>`/`<mark>` 原樣呈現；報告為自有可信內容）。

## 頁面（手機單欄 + 底部 4 分頁）
| 路由 | 頁面 | 來源端點 |
|---|---|---|
| `/` | 儀表板 | `/api/dashboard`（水位/情緒/regime/觀察清單），`/api/health` 驅動降級橫幅 |
| `/daytrade` | 當沖候選 | `/api/watchlist`（依 `rank_daytrade` 排序）+ 每列懶載 `/api/stocks/:code/book`（TWSE MIS 五檔/盤口強弱） |
| `/watchlist` | 觀察清單 | `/api/watchlist`，波段/當沖排序切換（MVP 唯讀） |
| `/reports` | 老王報告 | `/api/reports/list` + `/api/reports`（渲染每日 markdown，emoji 語意橫幅） |
| `/stock/:code` | 個股詳情 | `/api/stocks/:code` + `/ohlcv`（K線）+ `/agents/decide`（按鈕）+ `/api/backtest`（按鈕） |

## 關鍵設計
- **K 線**：個股頁三分頁——「日K·還原」（`?adjust=1`，**預設**）／「日K·原始」（FinMind 未還原，標註失真）／「盤中分K」。
- **盤中分K 優雅降級**：富果未設金鑰 → engine 502 `缺少 FUGLE_API_KEY` → 前端顯示「🔌 需富果金鑰」佔位，**不破圖**；日K 與五檔（MIS）不受影響。填入 `FUGLE_API_KEY`（`engine/.env`）即啟用。
- **多 agent 決策很貴**：`AgentsPanel` **只在按鈕觸發**，跑完落地 `localStorage`（`agents:decide:<code>`），重整不重算；長 loading 計時。**絕不**自動觸發。
- **emoji 語意相反**：🔴=看多／🟢=看空／🟠=中性（與股市紅漲綠跌相反）。報告原文用作者自有配色；量化 action badge 用直覺 UI 配色（買進=綠、賣出=紅），兩者分開不混。
- **降級**：`/api/health` engine:down → 全域降級橫幅；dashboard `degraded:true` → 降級卡；個股/清單拿到 503 → 友善錯誤卡（非白畫面）；報告頁不受 engine 影響。

## 開發 / 建置 / 部署
```powershell
# 開發（前端 5173，/api 代理到 gateway 3000）
cd "C:\CC AI Agent\web"; npm install; npm run dev
# 另開：engine（8000）+ gateway（3000）

# 建置 → web/dist（gateway 自動偵測並同源 serve，免 CORS）
cd "C:\CC AI Agent\web"; npm run build
cd "C:\CC AI Agent"; node server.cjs    # http://localhost:3000 直接看到 APP
```
- `server.cjs`：偵測到 `web/dist` 存在 → `express.static` + SPA fallback（非 `/api` 的 GET 回 `index.html`）。
- 階段8 雲端無頭部署：在 VM `npm run build` 後 gateway 同源 serve，無需另跑前端 server。
