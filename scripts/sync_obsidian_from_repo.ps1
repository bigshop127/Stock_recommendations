$ErrorActionPreference = 'Stop'

$repo = 'C:\CC AI Agent'
$obsidian = 'C:\obsidian\儲存庫\浦惠投顧報告整理'

Write-Host "[sync] git pull..."
Set-Location $repo
git pull --ff-only origin master

Write-Host "[sync] robocopy reports -> Obsidian..."
$rcArgs = @(
  "$repo\reports",
  $obsidian,
  '/E',
  '/XO',
  '/R:1', '/W:1',
  '/NFL', '/NDL',
  '/NJH', '/NJS'
)
& robocopy @rcArgs
$rc = $LASTEXITCODE

if ($rc -ge 8) {
  Write-Error "robocopy failed (exit code $rc)"
  exit 1
}

if ($rc -eq 0) {
  Write-Host "[sync] nothing new"
} else {
  Write-Host "[sync] done (exit code $rc)"
}
