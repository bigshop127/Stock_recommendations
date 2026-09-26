#requires -Version 5.1
<#
Pulls latest puhui reports from origin/master and mirrors reports\YYYY-MM\WX\*.md
into the local Obsidian vault. Runs daily after Oracle VM (13:00 TW) finishes.

Retention (2026-09-26 使用者規則)：Obsidian 只留「當月＋上個月」兩個月的報告。
  - 更早月份的報告不再複製進 Obsidian；
  - Obsidian 裡更早的 YYYY-MM 資料夾整個刪除（每天都檢查，所以效果＝每月 1 號自動清；
    那天沒開機就下次開機補做）。
  只清 Obsidian 副本；repo reports\ 保留完整歷史（engine 老王觀點與審視網報告月曆都讀它）。

Exit codes:
  0 = success (or already up to date)
  1 = git pull failed but copy still attempted
  2 = unexpected fatal error
#>

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:GIT_TERMINAL_PROMPT = '0'

$RepoDir     = 'C:\CC AI Agent'
$ReportsDir  = Join-Path $RepoDir 'reports'
$ObsidianDir = 'C:\obsidian\儲存庫\浦惠投顧報告整理'
$LogPath     = Join-Path $RepoDir 'data\sync_puhui_to_obsidian.log'

function Write-Log {
  param([string]$Message)
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
  # git writes progress to stderr; merge into stdout so it never raises in PS
  $out = & git @Args 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $out) { Write-Log "git: $line" }
  return $code
}

try {
  Set-Location -LiteralPath $RepoDir
  Write-Log '--- sync start ---'

  # 1) Fetch + fast-forward only. We only pull if FF is clean; otherwise just sync existing reports.
  #    Pull whatever branch this repo is on (VM 老王報告現走 phase3-chips，硬寫 master 會抓不到當日報告)。
  $Branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
  if (-not $Branch) { $Branch = 'master' }
  Write-Log "sync branch: $Branch"
  [void](Invoke-Git fetch origin $Branch)
  $pullCode = Invoke-Git pull --ff-only origin $Branch
  $pullOk = ($pullCode -eq 0)
  if (-not $pullOk) {
    Write-Log 'WARN: git pull --ff-only failed (local likely diverged). Continuing with existing reports/.'
  }

  # 2) Mirror reports/YYYY-MM/WX/*.md -> Obsidian vault (only copy when missing or newer).
  if (-not (Test-Path -LiteralPath $ReportsDir)) {
    Write-Log "ERROR: reports dir missing: $ReportsDir"
    exit 2
  }

  # 保留視窗：當月＋上個月（yyyy-MM 字串可直接比大小）
  $KeepFromMonth = (Get-Date).AddMonths(-1).ToString('yyyy-MM')
  $MonthDirPattern = '^\d{4}-\d{2}$'
  Write-Log "retention: keep months >= $KeepFromMonth"

  $copied = 0
  $skipped = 0
  $tooOld = 0
  Get-ChildItem -LiteralPath $ReportsDir -Recurse -Filter '*.md' -File | ForEach-Object {
    $src = $_.FullName
    $rel = $src.Substring($ReportsDir.Length).TrimStart('\','/')
    $top = ($rel -split '[\\/]')[0]
    if ($top -match $MonthDirPattern -and $top -lt $KeepFromMonth) {
      $tooOld++
      return   # ForEach-Object 內的 return＝跳過這一筆
    }
    $dst = Join-Path $ObsidianDir $rel
    $dstDir = Split-Path -Parent $dst

    if (-not (Test-Path -LiteralPath $dstDir)) {
      New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }

    $needCopy = $true
    if (Test-Path -LiteralPath $dst) {
      $srcInfo = Get-Item -LiteralPath $src
      $dstInfo = Get-Item -LiteralPath $dst
      if ($srcInfo.Length -eq $dstInfo.Length -and $srcInfo.LastWriteTimeUtc -le $dstInfo.LastWriteTimeUtc) {
        $needCopy = $false
      }
    }

    if ($needCopy) {
      Copy-Item -LiteralPath $src -Destination $dst -Force
      Write-Log "copied: $rel"
      $copied++
    } else {
      $skipped++
    }
  }

  # 3) Prune：Obsidian 裡早於保留視窗的 YYYY-MM 資料夾整個刪掉（只動第一層、名稱符合 YYYY-MM 的資料夾）
  $pruned = 0
  $pruneFailed = $false
  if (Test-Path -LiteralPath $ObsidianDir) {
    Get-ChildItem -LiteralPath $ObsidianDir -Directory | Where-Object {
      $_.Name -match $MonthDirPattern -and $_.Name -lt $KeepFromMonth
    } | ForEach-Object {
      $dir = $_   # catch 裡的 $_ 會變成錯誤物件，先存起來
      $n = (Get-ChildItem -LiteralPath $dir.FullName -Recurse -File | Measure-Object).Count
      try {
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop
        Write-Log ("pruned: {0} ({1} files)" -f $dir.Name, $n)
        $pruned++
      } catch {
        Write-Log ("ERROR: prune failed for {0}: {1}" -f $dir.Name, $_.Exception.Message)
        $pruneFailed = $true
      }
    }
  }

  Write-Log ("--- sync done: copied={0} skipped={1} tooOld={2} prunedMonths={3} pullOk={4} ---" -f $copied, $skipped, $tooOld, $pruned, $pullOk)
  if (-not $pullOk -or $pruneFailed) { exit 1 } else { exit 0 }
}
catch {
  Write-Log "FATAL: $($_.Exception.Message)"
  exit 2
}
