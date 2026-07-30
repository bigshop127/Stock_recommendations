# 一鍵開啟「個股全面審視網」（VM＝production 那一份）
# 自動建立 SSH 通道（本機 localhost:3100 -> Oracle VM:3000），再開預設瀏覽器。
# 通道以最小化視窗常駐；看完把那個最小化的視窗關掉即可中斷連線。
#
# 為什麼是 3100 而不是 3000（2026-07-30 改）：
#   3000 已經被**本機**的 gateway 佔住了（工作排程器 PuhuiGateway 開機自動啟動，
#   見 review-web/docs/prompts/ops-local-gateway-autostart.md）。原本這支腳本用
#   3000 開通道，而且靠「/api/health 有沒有回 200」判斷通道是否已經通——本機
#   gateway 也會回 200，於是它會誤判成「通道已開」直接重用，結果瀏覽器開到的是
#   **本機**那個沒有 Python engine 的 gateway，大盤儀表板／資金潮汐／產業熱力圖
#   全部 503。改用一個專屬埠就沒有這個歧義。
#   本機 gateway 刻意留在 3000 不動：期貨頁與再平衡頁的設定存在 localStorage，
#   而 localStorage 綁 origin，換埠等於換一份空的。
$ErrorActionPreference = 'SilentlyContinue'

$Key  = Join-Path $HOME '.ssh\oracle_puhui.key'
$VM   = 'ubuntu@140.238.48.197'
$Port = 3100                                   # 通道專屬的本機埠
$Url  = "http://localhost:$Port/review/"

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
        $r = Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/health" -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# 通道還沒開才建立（已開就直接重用，避免重複連線）
if (-not (Test-LocalPort $Port)) {
    Start-Process -FilePath 'ssh' -WindowStyle Minimized -ArgumentList @(
        '-i', $Key,
        '-N',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-L', "${Port}:localhost:3000",
        $VM
    )
    # 先等本機埠綁起來（最多約 12 秒）
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-LocalPort $Port) { break }
    }
}

# 再等「真的能打到 gateway」才開瀏覽器，避免 PWA 殼先載、API 全撲空（最多約 24 秒）
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Gateway) { break }
    Start-Sleep -Milliseconds 400
}

Start-Process $Url
