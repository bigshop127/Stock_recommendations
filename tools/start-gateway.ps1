# 本機 gateway 常駐啟動。工作排程器在「開機時」呼叫（工作名稱 PuhuiGateway）。
# 這個檔案必須存成 UTF-8 with BOM，否則中文會變亂碼、PowerShell 也可能直接不吃。
$ErrorActionPreference = 'Stop'
Set-Location 'C:\CC AI Agent'

$log = 'C:\CC AI Agent\data\gateway.log'
New-Item -ItemType Directory -Force -Path 'C:\CC AI Agent\data' | Out-Null

# 全部走同一個寫入函式，編碼才會一致。原本時間戳走 Add-Content（ANSI）、node 的
# stdout 走 *>>（PS 5.1 預設 UTF-16LE），同一個檔案兩種編碼，中文全變問號。
function Write-Log([string]$msg) {
    "[$(Get-Date -Format o)] $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

# 輪替：這是常駐程式，不轉檔的話 log 會無限長（本 repo 的 data\server_ccb.log
# 就長到 2.3 GB）。超過 5 MB 就轉成 .1，只留一份舊的。
function Rotate-Log {
    try {
        if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
            Move-Item $log "$log.1" -Force
        }
    } catch { }
}

# node 的絕對路徑：排程器以 SYSTEM 在「開機時」跑，PATH 跟你登入後的不一樣
# （nvm 之類裝在 user PATH 的情況下 `node` 根本找不到）。找不到就記進 log 並退出，
# 不要靜默地空轉。
$node = $null
foreach ($cand in @(
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe',
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)) {
    if ($cand -and (Test-Path $cand)) { $node = $cand; break }
}
if (-not $node) {
    Rotate-Log
    Write-Log 'FATAL: 找不到 node.exe，請把絕對路徑寫進本腳本的 $node。'
    exit 1
}

Rotate-Log
Write-Log "supervisor 啟動，node = $node"

while ($true) {
    Write-Log 'starting server.cjs'
    try {
        # 2>&1 併進 stdout 再交給 Out-File，編碼與上面的 Write-Log 一致。
        & $node server.cjs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
        Write-Log "server.cjs exited with code $LASTEXITCODE. Restarting in 5 seconds..."
    } catch {
        # 這個 catch 是整支腳本的重點：$ErrorActionPreference = 'Stop' 之下，任何一次
        # 例外（node 不見了、磁碟滿了）都會讓 while 迴圈直接斷掉，supervisor 就在最
        # 需要它的時候自己死掉。攔下來、記錄、繼續重試。
        Write-Log "supervisor 攔到例外: $($_.Exception.Message). Restarting in 5 seconds..."
    }
    Rotate-Log
    Start-Sleep -Seconds 5
}
