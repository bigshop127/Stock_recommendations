# 運維事項 — 本機 gateway 開機自動啟動（不佔 opt 編號）

> 這不是功能開發，是**修掉一個會重複發生的故障**。故不編 optN，放在 prompts 目錄供日後查閱。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\ops-local-gateway-autostart.md`，然後根據裡面的說明進行」。
> **範圍**：🔵 純本機 Windows 設定，零程式碼改動、零部署。

---

## 0. 故障現場（2026-07-29 實際發生）

使用者開 `localhost:3000/review/futures?tab=positions`，畫面正常畫出來，但：

```
Failed to load resource: net::ERR_CONNECTION_REFUSED  :3000/api/health
Failed to load resource: net::ERR_CONNECTION_REFUSED  :3000/api/futures/positions
Failed to load resource: net::ERR_CONNECTION_REFUSED  :3000/api/futures/quote?contract=SRF
```

頁面上顯示「後端運算引擎異常斷線，目前使用降級模式」與「行情抓取失敗」。

**根因：`node server.cjs` 根本沒在跑**，`Get-NetTCPConnection -State Listen` 確認 3000 埠沒有任何行程監聽。

**為什麼畫面還畫得出來**：`review-web` 是 PWA，`vite-plugin-pwa` 的 service worker 已經把 app shell 預快取了（`navigateFallback: '/review/index.html'`），所以 HTML/JS/CSS 從快取吐出來，只有 `/api/*` 打不到（`runtimeCaching` 對 `/api/` 設的是 `NetworkOnly`，這是對的——快取舊的持倉資料比報錯更危險）。

**這個誤導是真實成本**：使用者看到的是「後端運算引擎異常」，會去查 Python engine，但真正沒跑的是 Node gateway。
（2026-07-29 已順手改掉這個文案——現在 gateway 連不上會顯示「連不上後端 gateway——請確認 server.cjs 有在跑」，engine 掛掉才顯示原本那句。但**根本解法是讓它不要沒在跑**。）

---

## 1. 目標

Windows 開機後 `node server.cjs`（port 3000）自動起來，當掉會自己重啟，不需要記得手動開終端機。

---

## 2. 方案比較（選一個，建議 A）

| 方案 | 優點 | 缺點 |
|---|---|---|
| **A. 工作排程器（Task Scheduler）** | 內建、不用裝東西、可設「開機時」＋「失敗重試」 | 沒有真正的 supervisor 語意；當掉後靠重試間隔補 |
| B. NSSM / WinSW 包成 Windows 服務 | 真正的服務，崩潰自動重啟 | 要裝第三方工具 |
| C. pm2 + pm2-windows-startup | Node 生態熟悉 | 多一層依賴；Windows 上的 startup 掛載一向不穩 |

**建議 A**。這台機器的定位是「VM 的備援 + 開發機」，不需要 production 級的 supervisor；而且 A 完全不引入新東西，符合本專案一貫「零新依賴」的取向。

---

## 3. 方案 A 實作

### 3.1 包一支啟動腳本

`C:\CC AI Agent\tools\start-gateway.ps1`（**必須存成 UTF-8 with BOM**——這是本專案踩過的坑，`review-web\tools\open-review.ps1` 就是因為沒有 BOM 導致雙擊無反應，記憶裡有記）：

```powershell
# 本機 gateway 常駐啟動。工作排程器在「開機時」呼叫。
# 日誌輪替交給排程器的「僅保留最新」策略，這裡只單純附加。
$ErrorActionPreference = 'Stop'
Set-Location 'C:\CC AI Agent'
$log = 'C:\CC AI Agent\data\gateway.log'
New-Item -ItemType Directory -Force -Path 'C:\CC AI Agent\data' | Out-Null
"[$(Get-Date -Format o)] starting server.cjs" | Add-Content $log
node server.cjs *>> $log
```

> 注意 `node` 要在 PATH 裡。排程器以「開機時」執行時的 PATH 可能與登入後的不同——如果起不來，改成 node 的絕對路徑（`where.exe node` 查）。

### 3.2 建立排程工作

用 GUI（工作排程器）或 PowerShell 皆可。關鍵設定：

| 項目 | 值 |
|---|---|
| 名稱 | `PuhuiGateway` |
| 觸發程序 | **在啟動時**（不是「登入時」——後者要等你登入才起） |
| 動作 | 啟動程式 `powershell.exe`，引數 `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\CC AI Agent\tools\start-gateway.ps1"` |
| 以最高權限執行 | ✅（綁 3000 埠不需要，但避免權限雜訊） |
| 不論使用者是否登入均執行 | ✅ |
| 設定 → 如果工作失敗，每隔 | **1 分鐘**，重試 **3** 次 |
| 設定 → 如果工作執行超過 | **取消勾選**（這是常駐程式，不能被時間上限砍掉） |
| 條件 → 只有在電腦使用 AC 電源時才啟動 | ❌ 取消（桌機沒差，但取消比較保險） |

PowerShell 版本（**這條命令會建立系統層級排程，請先確認上面的路徑正確再執行**）：

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\CC AI Agent\tools\start-gateway.ps1"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'PuhuiGateway' -Action $action -Trigger $trigger -Settings $settings `
  -User 'SYSTEM' -RunLevel Highest
```

### 3.3 驗收

```powershell
# 1. 手動觸發一次，不用真的重開機
Start-ScheduledTask -TaskName 'PuhuiGateway'
Start-Sleep 3
Invoke-WebRequest http://localhost:3000/api/health -UseBasicParsing | Select-Object -Expand Content
# 期望：{"gateway":"ok","engine":"down"|"ok",...}

# 2. 確認真的在監聽
Get-NetTCPConnection -State Listen -LocalPort 3000

# 3. 殺掉行程，等 1 分鐘看有沒有自己回來
Stop-Process -Name node -Force
Start-Sleep 70
Invoke-WebRequest http://localhost:3000/api/health -UseBasicParsing

# 4. 真的重開機一次再驗一遍（這步不能跳過——「開機時」觸發程序常常是設了但沒生效）
```

---

## 4. 附帶事項

### 4.1 埠位衝突

如果 3000 已被別的東西佔用，`server.cjs` 會直接崩掉並被排程器反覆重試。先確認：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

`server.cjs` 讀 `process.env.PORT`，真要換埠的話在 `.env` 設 `PORT=3001`，但**前端 `vite.config.ts` 的 proxy target 與 PWA 的絕對路徑都指著 3000**，換埠要一起改，不建議。

### 4.2 這台機器只是備援

提醒一下定位（ROADMAP 與記憶都有記）：**production 是 Oracle VM，本機是備援 + 開發機**。手機走 Tailscale 連的是 VM 不是這台，所以這件事修好只影響你在這台桌機上開網頁的體驗，不影響手機、也不影響每日排程。

### 4.3 Python engine 要不要一起？

**不要**。`engine/.venv` 目前根本沒建過（`engine/README.md` 的快速啟動步驟從沒在這台跑過），而期貨頁與再平衡頁的核心功能都不依賴它。要用到 engine 的是大盤儀表板／資金潮汐／產業熱力圖那幾頁——那些頁面在本機本來就是看 VM 的資料比較準。真要在本機起 engine 是另一件事，別混進來。

---

## 5. 驗收標準

- [ ] `tools\start-gateway.ps1` 存在且為 **UTF-8 with BOM**
- [ ] 排程工作 `PuhuiGateway` 存在，觸發程序是「在啟動時」
- [ ] 執行時間上限已取消勾選（否則常駐程式會被砍）
- [ ] 手動觸發後 `/api/health` 回 200
- [ ] 殺掉 node 後 1~2 分鐘內自己回來
- [ ] **真的重開機一次**後，不登入任何帳號的情況下 `/api/health` 仍回 200
- [ ] `data/gateway.log` 有內容且看得懂
