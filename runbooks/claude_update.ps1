# Claude Code 更新修復腳本
# 用途：Windows 下 claude.exe 被自己鎖住導致 Auto-update failed 時，關掉所有 session 後跑這支。
# 用法：關閉全部 Claude Code 視窗（含 VS Code 內的） -> 雙擊 claude_update.cmd
# 建立：2026-08-20

$ErrorActionPreference = 'Stop'
Write-Host ""
Write-Host "===== Claude Code 更新修復 =====" -ForegroundColor Cyan
Write-Host ""

# ---- [1/4] 確認沒有任何 claude.exe 在執行 ----
$procs = @(Get-Process -Name claude -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
    Write-Host "[1/4] 失敗：還有 $($procs.Count) 個 Claude Code 在執行" -ForegroundColor Red
    $procs | Select-Object Id, Path | Format-Table -AutoSize
    Write-Host "Windows 會鎖住執行中的 .exe，必須全部關閉才能覆寫。" -ForegroundColor Yellow
    Write-Host "請關掉所有 Claude Code 視窗（含 VS Code 內的終端機）後重跑。" -ForegroundColor Yellow
    Read-Host "`n按 Enter 離開"
    exit 1
}
Write-Host "[1/4] OK - 沒有 claude.exe 在執行" -ForegroundColor Green

# ---- [2/4] 校正 installMethod（冪等；先備份） ----
$cfg = Join-Path $env:USERPROFILE '.claude.json'
if (Test-Path $cfg) {
    $raw = [IO.File]::ReadAllText($cfg)
    if ($raw -match '"installMethod":\s*"native"') {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $cfg "$cfg.bak-$stamp"
        $raw = $raw -replace '"installMethod":\s*"native"', '"installMethod": "npm-global"'
        try { $null = $raw | ConvertFrom-Json } catch { Write-Host "[2/4] 中止：改完不是合法 JSON，已還原" -ForegroundColor Red; Read-Host "按 Enter 離開"; exit 1 }
        [IO.File]::WriteAllText($cfg, $raw, (New-Object Text.UTF8Encoding($false)))
        Write-Host "[2/4] installMethod: native -> npm-global（備份 .bak-$stamp）" -ForegroundColor Green
    } else {
        Write-Host "[2/4] OK - installMethod 已是正確值，跳過" -ForegroundColor Green
    }
} else {
    Write-Host "[2/4] 找不到 .claude.json，跳過" -ForegroundColor Yellow
}

# ---- [3/4] 更新 ----
$pkgJson = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\package.json'
$before = if (Test-Path $pkgJson) { (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } else { '(unknown)' }
Write-Host "[3/4] 目前版本 $before，開始更新..." -ForegroundColor Cyan
npm install -g '@anthropic-ai/claude-code@latest'
if ($LASTEXITCODE -ne 0) {
    Write-Host "[3/4] npm 更新失敗（exit $LASTEXITCODE），詳見上方訊息" -ForegroundColor Red
    Read-Host "`n按 Enter 離開"
    exit 1
}

# ---- [4/4] 驗收 ----
$after = if (Test-Path $pkgJson) { (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } else { '(unknown)' }
Write-Host ""
if ($after -eq $before) {
    Write-Host "[4/4] 完成 - 版本 $after（本來就是最新，沒有可更新的版本）" -ForegroundColor Green
} else {
    Write-Host "[4/4] 完成 - $before -> $after" -ForegroundColor Green
}
Write-Host ""
Read-Host "按 Enter 離開"
