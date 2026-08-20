# Claude Code 更新修復腳本
# 用途：Windows 下 claude.exe 被自己鎖住導致 Auto-update failed 時，關掉所有 session 後跑這支。
# 用法：關閉全部 Claude Code 視窗（含 VS Code 內的） -> 雙擊 claude_update.cmd
# 建立：2026-08-20
# 修訂：2026-08-20 版本判斷改看 binary 自報版本（wrapper package.json 在更新失敗時會超前，會誤報「已是最新」）

$ErrorActionPreference = 'Stop'

$npmRoot = Join-Path $env:APPDATA 'npm'
$scopeDir = Join-Path $npmRoot 'node_modules\@anthropic-ai'
$pkgDir   = Join-Path $scopeDir 'claude-code'
$pkgJson  = Join-Path $pkgDir 'package.json'
$exe      = Join-Path $pkgDir 'bin\claude.exe'

function Get-WrapperVersion {
    if (Test-Path $pkgJson) { try { return (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } catch { return '(讀取失敗)' } }
    return '(不存在)'
}
function Get-BinaryVersion {
    if (-not (Test-Path $exe)) { return '(不存在)' }
    try { $v = & $exe --version 2>&1 | Select-Object -First 1; return ($v -replace '\s*\(Claude Code\)\s*$', '').Trim() }
    catch { return '(執行失敗)' }
}

Write-Host ""
Write-Host "===== Claude Code 更新修復 =====" -ForegroundColor Cyan
Write-Host ""

# ---- [1/5] 確認沒有任何 claude.exe 在執行 ----
$procs = @(Get-Process -Name claude -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
    Write-Host "[1/5] 失敗：還有 $($procs.Count) 個 Claude Code 在執行" -ForegroundColor Red
    $procs | Select-Object Id, Path | Format-Table -AutoSize
    Write-Host "Windows 會鎖住執行中的 .exe，必須全部關閉才能覆寫。" -ForegroundColor Yellow
    Write-Host "請關掉所有 Claude Code 視窗（含 VS Code 內的終端機）後重跑。" -ForegroundColor Yellow
    Read-Host "`n按 Enter 離開"
    exit 1
}
Write-Host "[1/5] OK - 沒有 claude.exe 在執行" -ForegroundColor Green

# ---- [2/5] 校正 installMethod（冪等；先備份） ----
$cfg = Join-Path $env:USERPROFILE '.claude.json'
if (Test-Path $cfg) {
    $raw = [IO.File]::ReadAllText($cfg)
    if ($raw -match '"installMethod":\s*"native"') {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $cfg "$cfg.bak-$stamp"
        $raw = $raw -replace '"installMethod":\s*"native"', '"installMethod": "npm-global"'
        try { $null = $raw | ConvertFrom-Json } catch { Write-Host "[2/5] 中止：改完不是合法 JSON，未寫入" -ForegroundColor Red; Read-Host "按 Enter 離開"; exit 1 }
        [IO.File]::WriteAllText($cfg, $raw, (New-Object Text.UTF8Encoding($false)))
        Write-Host "[2/5] installMethod: native -> npm-global（備份 .bak-$stamp）" -ForegroundColor Green
    } else {
        Write-Host "[2/5] OK - installMethod 已是正確值，跳過" -ForegroundColor Green
    }
} else {
    Write-Host "[2/5] 找不到 .claude.json，跳過" -ForegroundColor Yellow
}

# ---- [3/5] 清掉更新失敗留下的暫存殘留 ----
# npm 全域安裝會先把舊檔搬成 .<原名>-<亂碼> 當備份，成功後刪掉；
# 被 EBUSY/EPERM 打斷就會留在原地（2026-08-12 事故的元凶）。
# 保險：只有在「正式檔還在」時才刪殘留，否則殘留就是唯一的還原來源，不能動。
$removed = 0
if (Test-Path $scopeDir) {
    foreach ($d in @(Get-ChildItem $scopeDir -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.claude-code-*' })) {
        if (Test-Path $pkgDir) {
            Write-Host "       移除殘留目錄 $($d.Name)" -ForegroundColor DarkGray
            Remove-Item $d.FullName -Recurse -Force
            $removed++
        } else {
            Write-Host "       發現 $($d.Name) 但正式套件目錄不存在 -> 不動它，見 claude修復計畫.md" -ForegroundColor Yellow
        }
    }
}
foreach ($f in @(Get-ChildItem $npmRoot -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.claude*' })) {
    if (Test-Path (Join-Path $npmRoot 'claude.cmd')) {
        Write-Host "       移除殘留 shim $($f.Name)" -ForegroundColor DarkGray
        Remove-Item $f.FullName -Force
        $removed++
    } else {
        Write-Host "       發現 shim 殘留 $($f.Name) 但正式 shim 不存在 -> 不動它，見 claude修復計畫.md" -ForegroundColor Yellow
    }
}
if ($removed -gt 0) { Write-Host "[3/5] 清掉 $removed 個殘留" -ForegroundColor Green }
else { Write-Host "[3/5] OK - 沒有殘留" -ForegroundColor Green }

# ---- [4/5] 更新 ----
$binBefore = Get-BinaryVersion
$stampBefore = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { $null }
Write-Host "[4/5] 目前 binary 版本 $binBefore（wrapper 記載 $(Get-WrapperVersion)），開始更新..." -ForegroundColor Cyan
npm install -g '@anthropic-ai/claude-code@latest'
if ($LASTEXITCODE -ne 0) {
    Write-Host "[4/5] npm 更新失敗（exit $LASTEXITCODE），詳見上方訊息" -ForegroundColor Red
    Read-Host "`n按 Enter 離開"
    exit 1
}

# ---- [5/5] 驗收（以 binary 自報版本為準） ----
$binAfter = Get-BinaryVersion
$wrapAfter = Get-WrapperVersion
$stampAfter = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { $null }
$swapped = ($stampBefore -ne $stampAfter)
Write-Host ""
if ($binAfter -ne $binBefore) {
    Write-Host "[5/5] 完成 - binary $binBefore -> $binAfter" -ForegroundColor Green
} elseif ($swapped) {
    Write-Host "[5/5] 完成 - binary 已重新置換（版本同為 $binAfter，檔案時間 $stampAfter）" -ForegroundColor Green
} else {
    Write-Host "[5/5] 完成 - binary 維持 $binAfter，檔案未變動（確實已是最新）" -ForegroundColor Green
}
if ($wrapAfter -ne $binAfter) {
    Write-Host "警告：wrapper package.json 記載 $wrapAfter 與 binary $binAfter 不一致 —— 這是安裝被打斷的徵兆，請再跑一次本腳本。" -ForegroundColor Yellow
}
Write-Host ""
Read-Host "按 Enter 離開"
