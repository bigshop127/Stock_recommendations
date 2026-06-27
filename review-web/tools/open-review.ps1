# 一鍵開啟「個股全面審視網」
# 自動建立 SSH 通道（本機 localhost:3000 -> Oracle VM:3000），再開預設瀏覽器。
# 通道以最小化視窗常駐；看完把那個最小化的視窗關掉即可中斷連線。
$ErrorActionPreference = 'SilentlyContinue'

$Key = Join-Path $HOME '.ssh\oracle_puhui.key'
$VM  = 'ubuntu@140.238.48.197'
$Url = 'http://localhost:3000/review/'

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

# 真的能打到 VM 的 gateway 嗎？（ssh -L 會先綁本機埠、通道卻可能還沒接通，
# 所以光看埠綁好不夠，要等 /api/health 回 200，前端打 API 才不會撲空）
function Test-Gateway {
    try {
        $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/health' -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# 通道還沒開才建立（已開就直接重用，避免重複連線）
if (-not (Test-LocalPort 3000)) {
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
    # 先等本機 3000 埠綁起來（最多約 12 秒）
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-LocalPort 3000) { break }
    }
}

# 再等「真的能打到 gateway」才開瀏覽器，避免 PWA 殼先載、API 全撲空（最多約 24 秒）
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Gateway) { break }
    Start-Sleep -Milliseconds 400
}

Start-Process $Url
