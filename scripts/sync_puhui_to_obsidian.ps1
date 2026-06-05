#requires -Version 5.1
<#
Pulls latest puhui reports from origin/master and mirrors reports\YYYY-MM\WX\*.md
into the local Obsidian vault. Runs daily after Oracle VM (13:00 TW) finishes.

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
  [void](Invoke-Git fetch origin master)
  $pullCode = Invoke-Git pull --ff-only origin master
  $pullOk = ($pullCode -eq 0)
  if (-not $pullOk) {
    Write-Log 'WARN: git pull --ff-only failed (local likely diverged). Continuing with existing reports/.'
  }

  # 2) Mirror reports/YYYY-MM/WX/*.md -> Obsidian vault (only copy when missing or newer).
  if (-not (Test-Path -LiteralPath $ReportsDir)) {
    Write-Log "ERROR: reports dir missing: $ReportsDir"
    exit 2
  }

  $copied = 0
  $skipped = 0
  Get-ChildItem -LiteralPath $ReportsDir -Recurse -Filter '*.md' -File | ForEach-Object {
    $src = $_.FullName
    $rel = $src.Substring($ReportsDir.Length).TrimStart('\','/')
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

  Write-Log ("--- sync done: copied={0} skipped={1} pullOk={2} ---" -f $copied, $skipped, $pullOk)
  if (-not $pullOk) { exit 1 } else { exit 0 }
}
catch {
  Write-Log "FATAL: $($_.Exception.Message)"
  exit 2
}
