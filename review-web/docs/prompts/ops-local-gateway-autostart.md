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

實作版見 `tools\start-gateway.ps1`（比本文原本的草稿多了 supervisor 迴圈）。有四件事是實作後才修掉的坑，改這支腳本時不要改回去：

1. **`while ($true)` 裡面要包 try/catch。** 腳本開頭是 `$ErrorActionPreference = 'Stop'`，所以任何一次例外（node 不見了、磁碟滿了）都會讓迴圈**直接斷掉**——supervisor 在最需要它的時候自己死掉。
2. **`node` 要用絕對路徑。** 排程器以 SYSTEM 在「開機時」跑，PATH 與你登入後的不一樣（nvm 之類裝在 user PATH 的話 `node` 根本找不到）。腳本會依序試 `Get-Command`、`C:\Program Files\nodejs\node.exe`、x86、`%LOCALAPPDATA%`，全都找不到就記 log 並 exit 1，不要靜默空轉。
3. **日誌編碼要統一。** 原本時間戳走 `Add-Content`（ANSI）、node 的 stdout 走 `*>>`（PS 5.1 預設 UTF-16LE），同一個檔案兩種編碼，中文全變 `??`、英文變成 `P u h u i`。改成兩邊都走 `Out-File -Append -Encoding utf8`。
4. **要自己輪替日誌。** 這是常駐程式，不轉檔就無限長——同目錄的 `data\server_ccb.log` 已經長到 2.3 GB。超過 5 MB 轉成 `.1`，只留一份舊的。

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

### 4.1b 舊的 pm2 殘留（2026-07-30 發現並清掉）

排這件事的時候翻到一個**已經跑了很久的當機迴圈**。`pm2` 裡有一筆 `ccb-server`，script path 指著 `C:\CC AI Agent\server.js`——**這個檔案不存在**（真正的檔案叫 `server.cjs`）。pm2 於是無止盡地重啟它，每次都吐一份 `ERR_MODULE_NOT_FOUND` 堆疊：

- 重啟次數 **7,421 → 7,493**（我查看的一分鐘內就跳了 72 次，約每秒一次）
- `data/server_ccb.log` **2.33 GB**、`~/.pm2/logs/ccb-server-error.log` **3.83 GB**，合計 **6.16 GB**，內容從頭到尾都是同一份堆疊（抽三個位移取樣確認過）
- 開機就開始：boot 12:09:29、log 12:13 就已經在寫

處置：`pm2 delete ccb-server` → `pm2 save --force`（dump 清空，日後就算 daemon 又被叫起來也沒東西可跑）→ `pm2 kill`（停 daemon）→ 兩個 log `Clear-Content` 清成 0（先留 4 KB 樣本在 `data/_archive/ccb-server-crashloop-sample.txt`）。

沒有找到讓 pm2 開機自啟的掛鉤——`HKCU`/`HKLM` 的 `Run`、兩個啟動資料夾、Windows 服務、工作排程器全查過都沒有 pm2 相關項目。dump 已空所以就算它回來也無害；**下次開機請順手確認 `data/server_ccb.log` 還是 0 bytes**，如果又長回來就得再找一次來源。

這也是「為什麼選工作排程器而不選 pm2」的現場證據——見 §2 的方案比較，pm2 在 Windows 上的 startup 掛載一向不穩，而且它壞掉的方式是**靜默地燒磁碟**。

### 4.2 這台機器只是備援

提醒一下定位（ROADMAP 與記憶都有記）：**production 是 Oracle VM，本機是備援 + 開發機**。手機走 Tailscale 連的是 VM 不是這台，所以這件事修好只影響你在這台桌機上開網頁的體驗，不影響手機、也不影響每日排程。

### 4.3 Python engine 要不要一起？

**不要**。`engine/.venv` 目前根本沒建過（`engine/README.md` 的快速啟動步驟從沒在這台跑過），而期貨頁與再平衡頁的核心功能都不依賴它。要用到 engine 的是大盤儀表板／資金潮汐／產業熱力圖那幾頁——那些頁面在本機本來就是看 VM 的資料比較準。真要在本機起 engine 是另一件事，別混進來。

---

## 5. 驗收標準

- [x] `tools\start-gateway.ps1` 存在且為 **UTF-8 with BOM**（前三 byte `239 187 191`）
- [x] 排程工作 `PuhuiGateway` 存在，觸發程序是「在啟動時」，以 SYSTEM／最高權限執行
      （**非提權的 shell 讀不到這個工作的定義**——`schtasks /query /tn PuhuiGateway` 回「存取被拒」、`Get-ScheduledTask` 直接當它不存在。所以驗證是走**行程樹＋時間戳**而不是讀工作定義，見下一項。）
- [x] 執行時間上限已取消勾選（`ExecutionTimeLimit = 0`）
- [x] 手動觸發後 `/api/health` 回 200
- [x] 殺掉 node 後自己回來（`data/gateway.log`：`exited with code -1` @22:58:57 → `starting` @22:59:02）
- [x] **真的重開機一次**後仍自動起來 —— 2026-07-30 驗證，行程樹時間戳完整對得上：
      `LastBootUpTime` **12:09:29** → 監控用的 `powershell.exe`（PID 2608）**12:09:44** → `node.exe`（PID 11420，port 3000 的 listener，父行程正是 PID 2608）**12:09:52**。開機後 23 秒服務就在跑，`/api/health` 同時可用。
- [x] `data/gateway.log` 有內容且看得懂（編碼統一成 UTF-8 之後才成立，見 §3.1 第 3 點）

> 📌 排程工作以 SYSTEM 執行，所以**非提權的 shell 查不到也殺不掉**（`schtasks /query` 會回「存取被拒」、`Stop-Process` 同）。要重啟本機 gateway 讓它吃到新的 `routes/*.js`，得用提權的 PowerShell：
> ```powershell
> Stop-ScheduledTask -TaskName PuhuiGateway; Start-ScheduledTask -TaskName PuhuiGateway
> ```
> 不重啟也沒關係——下次開機自然會吃到。**production 是 Oracle VM，本機只是備援。**
