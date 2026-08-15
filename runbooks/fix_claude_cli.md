# Claude CLI 消失事故排查紀錄（2026-08-12）

放在 `runbooks/`，跟 `fix_clock_sync.bat` 同層 —— 這個資料夾收的是**本機環境層級**的
故障紀錄與修復腳本，跟 repo 本身的程式無關。（原本同層還有一份 `fix_iomap_bsod.ps1`，
2026-08-15 移除：那是 7/1 對半夜藍屏的錯誤假設，真凶 7/5 查出是 AMD 顯卡驅動
`amdkmdag.sys` 26.6.2，而且華碩 8/13 已自行更新該驅動。）

## 症狀

PowerShell 執行 `cc`（profile 裡定義為 `function cc { $env:CLAUDE_CODE_NO_FLICKER = '1'; claude @args }`）報錯：

```
The term 'claude' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

## 根因（兩層，會互相掩護）

這不是單一故障，修好第一層才會看見第二層。

### 第一層：npm shim 被改名，沒還原

`C:\Users\bigsh\AppData\Roaming\npm\` 底下三個啟動檔被改成暫存名稱：

| 應有檔名 | 實際殘留檔名 | 時間戳 |
|---|---|---|
| `claude` | `.claude-L4rPYsMf` | 2026/8/5 00:48:44 |
| `claude.cmd` | `.claude.cmd-NhahIEOw` | 2026/8/5 00:48:44 |
| `claude.ps1` | `.claude.ps1-ctd7Lypx` | 2026/8/5 00:48:44 |

npm 在 Windows 安裝全域套件時，會先把既有的 bin shim 改名成 `.<原名>-<亂碼>` 當備份，成功後再刪掉。安裝中途失敗 → 備份留在原地、正式檔名不存在 → PATH 找得到目錄卻找不到指令。

**三個檔案時間戳完全相同**，是判斷「同一次安裝被打斷」的關鍵證據。

### 第二層：原生執行檔從來沒下載

還原 shim 後，錯誤訊息變成：

```
The specified executable is not a valid application for this OS platform.
```

因為 `node_modules\@anthropic-ai\claude-code\bin\claude.exe` 只有 **500 bytes**，開頭不是 PE 檔的 `MZ`。它是套件自帶的佔位 stub，內容是一段 shell 錯誤訊息，直說 optional 依賴 `@anthropic-ai/claude-code-win32-x64` 沒裝成功。

排除過的方向（都不是主因）：

- `npm config get omit` → 空（沒有 `--omit=optional`）
- `npm config get ignore-scripts` → `false`
- `C:\Users\bigsh\.npmrc` → 不存在

所以不是設定問題，是當初安裝時 optional 原生套件下載失敗。

## 修復步驟

```powershell
# 1. 還原被改名的 shim
$n = "$env:APPDATA\npm"
Rename-Item "$n\.claude-L4rPYsMf"     "claude"
Rename-Item "$n\.claude.cmd-NhahIEOw" "claude.cmd"
Rename-Item "$n\.claude.ps1-ctd7Lypx" "claude.ps1"

# 2. 重裝以補回原生 binary
npm install -g @anthropic-ai/claude-code@latest

# 3. 驗證
claude --version
```

> 亂碼後綴每次都不一樣，不要照抄。先用
> `Get-ChildItem "$env:APPDATA\npm" -Force | Where-Object Name -like "*claude*"` 查出實際檔名。

## 收尾狀態

第 2 步途中撞到 `EBUSY: resource busy or locked`（鎖在 `bin\claude.exe`）——**跟當初把安裝打斷的是同一種錯**。當下 binary 雖已落地可用，但 wrapper `package.json` 寫 `2.1.228`、binary 自報 `2.1.221`，版本沒對齊。

後續補跑一次安裝後已收尾（2026-08-12 23:17 驗證）：

| 檢查項 | 現況 |
|---|---|
| `%APPDATA%\npm\` shim | `claude` / `claude.cmd` / `claude.ps1` 三個正常檔名，無 `.claude-<亂碼>` 殘留 |
| `bin\claude.exe` | 296,308,896 bytes（真 PE binary） |
| `claude --version` | `2.1.228`，與 `package.json` 一致 |

若日後又出現版本不一致，處置就是**關掉所有 claude 視窗**（含正在跑的 session；防毒即時掃描也可能持有鎖）再跑一次：

```powershell
npm i -g @anthropic-ai/claude-code
```

## 復發時的辨識法

依錯誤訊息分流，不要盲目重裝：

| 錯誤訊息 | 這是哪一層 | 處置 |
|---|---|---|
| `'claude' is not recognized` | shim 被改名 | 還原三個 shim |
| `not a valid application for this OS platform` | 原生 binary 是 500 bytes stub | 重裝補 optional 依賴 |
| `EBUSY: resource busy or locked` | 有程序鎖住 exe | 關掉所有 claude 視窗／暫停防毒即時掃描後再裝 |

**預防重點**：`npm i -g @anthropic-ai/claude-code` 執行時不要有任何 claude 程序在跑。一旦被 EBUSY 打斷，就會留下第一層那種改名殘留，下次開終端機才發現指令不見了——中間可能已經隔了一週（本次就是 8/05 壞、8/12 才發現）。
