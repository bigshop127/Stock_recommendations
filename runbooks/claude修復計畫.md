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
| `Auto-update failed: claude.exe in use` | **不是故障**，是自動更新撞到 Windows 檔案鎖 | 見下方 §2026-08-20，跑 `runbooks\claude_update.cmd` |

**預防重點**：`npm i -g @anthropic-ai/claude-code` 執行時不要有任何 claude 程序在跑。一旦被 EBUSY 打斷，就會留下第一層那種改名殘留，下次開終端機才發現指令不見了——中間可能已經隔了一週（本次就是 8/05 壞、8/12 才發現）。

---

## 2026-08-20 — 後續：`Auto-update failed: claude.exe in use`

### 症狀

CLI 右下角持續跳紅字：

```
Auto-update failed: claude.exe in use (close other Claude Code sessions, including VS Code) - Run claude doctor
```

### 判定：不是故障

Claude Code 背景下載新版後要覆蓋 `claude.exe`，但 **Windows 會鎖住執行中的 .exe**。當天查證：

```
claude.exe  PID 5260  （全機只有這一個）
Path: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
```

**擋住更新的就是當下正在用的那個 session 本身** —— 它執行的檔案正是更新程式要覆寫的目標。訊息叫人「關掉其他 session」是通用提示，實際上這台沒有其他 session，是自己鎖自己。功能完全不受影響，只是版本停著不往上跳。

### 順帶清掉 8/12 修復留下的兩個殘留

| 項目 | 修前 | 修後 |
|---|---|---|
| `~/.claude.json` 的 `installMethod` | `"native"`（5/20 寫入時確實是原生安裝） | `"npm-global"`（實際已改由 npm 管理） |
| `~/.local/share/claude/versions/` | 2.1.140（5/13）、2.1.173（6/11）兩顆舊 binary，450 MB | 丟回收桶（可還原） |

判定依據：`npm ls -g` 有 `@anthropic-ai/claude-code@2.1.237`、prefix = `%APPDATA%\npm`，且執行中的 exe 就在該 npm 目錄下 → 更新管道是 npm，`installMethod` 應為 `npm-global`。合法值從 binary 撈出來確認過：`native` / `npm-global` / `npm-local` / `global` / `local` / `brew` / `homebrew` / `unknown`。

`autoUpdates: false` 與 `autoUpdatesProtectedForNative: true` **刻意不動** —— 在 binary 裡只看得到欄位名、看不出實際邏輯，對 npm 安裝本來就是失效欄位，亂改風險大於效益。

### 處置腳本

`runbooks\claude_update.cmd`（雙擊執行，包 `claude_update.ps1`）。**先關閉所有 Claude Code 視窗再跑**，腳本本身也會擋：

1. 偵測還有 `claude.exe` 在跑就中止並列出 PID/Path（不會硬幹）
2. 校正 `installMethod`（冪等，改前自動備份 `.claude.json.bak-<timestamp>`，改後驗證仍是合法 JSON）
3. `npm install -g @anthropic-ai/claude-code@latest`
4. 印出版本前後對照

腳本用 `$env:USERPROFILE` / `$env:APPDATA`，沒有寫死個人路徑（本 repo 是公開的）。`.ps1` 存成 **UTF-8 with BOM**、`.cmd` 內含 `chcp 65001`，否則中文輸出會變亂碼。

### `claude doctor`

CLI 內建自我診斷，印出安裝方式／版本／更新管道狀態，**只讀不改**，卡更新時官方建議先跑這個。

### 避坑（這次踩到的）

用 `python - <<'EOF'` heredoc 寫含 Windows 路徑的 markdown 時，反斜線會被吃掉一層，`\n` 直接變成換行、`\b` 變成 0x08 控制字元，檔案靜靜壞掉。改用編輯工具直接寫，或先驗 `ord(c) < 32` 有沒有異常字元。
