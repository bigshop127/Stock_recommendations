# Sync real E.Sun (Fugle Trade) holdings into review-web's rebalance page.
# Opens the same SSH tunnel as the desktop shortcut (reused if already open),
# then runs the Python sync script. Trading credentials never leave this
# machine; only the resulting position snapshot is sent over the tunnel.
$ErrorActionPreference = 'SilentlyContinue'

$Key = Join-Path $HOME '.ssh\oracle_puhui.key'
$VM  = 'ubuntu@140.238.48.197'

function Test-LocalPort([int]$p) {
    try {
        $c   = New-Object Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok  = $iar.AsyncWaitHandle.WaitOne(400)
        $res = $ok -and $c.Connected
        $c.Close()
        return $res
    } catch { return $false }
}

function Test-Gateway {
    try {
        $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/health' -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

if (-not (Test-LocalPort 3000)) {
    Write-Output 'Opening SSH tunnel to VM...'
    Start-Process -FilePath 'ssh' -WindowStyle Minimized -ArgumentList @(
        '-i', $Key,
        '-N',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-L', '3000:localhost:3000',
        $VM
    )
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-LocalPort 3000) { break }
    }
}

for ($i = 0; $i -lt 60; $i++) {
    if (Test-Gateway) { break }
    Start-Sleep -Milliseconds 400
}

if (-not (Test-Gateway)) {
    Write-Output 'ERROR: could not reach the gateway through the SSH tunnel.'
    if (-not $env:GITHUB_ACTIONS) { Read-Host 'Press Enter to close' }
    exit 1
}

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $ScriptDir)
py "$RepoRoot\scripts\sync_fugle_holdings.py"
$exitCode = $LASTEXITCODE

# $env:GITHUB_ACTIONS is auto-set by the Actions runner — skip the interactive
# pause when triggered remotely (button on the website) via workflow_dispatch.
if (-not $env:GITHUB_ACTIONS) { Read-Host 'Done. Press Enter to close' }
exit $exitCode
