# 一次性註冊：以「最高權限」執行的排程工作 GatewayRestart。
#
# 為什麼要它：本機 gateway（server.cjs）由 tools\start-gateway.ps1 這支 supervisor 帶起來，
# 而 supervisor 是排程器以 SYSTEM 身分跑的，所以那個 node 行程**非提權的 shell 砍不掉**。
# 改了路由要生效就只能重開機，或每次手動開一個系統管理員視窗。
#
# 註冊之後，任何非提權的 shell 只要下：
#     schtasks /Run /TN GatewayRestart
# 就能重啟 gateway，不會再跳 UAC。
#
# 被提權的**只有這一件事**：砍掉佔用 3000 埠的行程（supervisor 會在 5 秒內自動拉起新的）。
# 指令是寫死在工作定義裡的，要改它本身也需要管理員權限。
#
# 用法（必須在「系統管理員」PowerShell 視窗執行一次）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\CC AI Agent\tools\register-gateway-restart-task.ps1"
#
# 這個檔案必須存成 UTF-8 with BOM，否則中文會變亂碼（同 start-gateway.ps1 的坑）。
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '這支腳本必須在「系統管理員」PowerShell 視窗執行。' -ForegroundColor Red
    Write-Host 'Win+X →「終端機（系統管理員）」→ 按「是」→ 再貼一次上面那行指令。' -ForegroundColor Yellow
    exit 1
}

$cmd = 'Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }'
$arg = '-NoProfile -WindowStyle Hidden -Command "' + $cmd + '"'

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                          -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'GatewayRestart' -Action $action -Principal $principal -Settings $settings `
    -Description '重啟本機 Puhui gateway：砍掉 3000 埠上的 node，start-gateway.ps1 的 supervisor 會在 5 秒內重新拉起。' `
    -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'GatewayRestart'
Write-Host ''
Write-Host '已註冊 GatewayRestart' -ForegroundColor Green
Write-Host "  以誰的身分 : $($t.Principal.UserId)"
Write-Host "  權限等級   : $($t.Principal.RunLevel)   （Highest = 以最高權限執行）"
Write-Host "  執行       : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
Write-Host ''
Write-Host '之後重啟 gateway（一般視窗就行，不會跳 UAC）：' -ForegroundColor Cyan
Write-Host '  schtasks /Run /TN GatewayRestart'
Write-Host ''
Write-Host '不想要了就移除：' -ForegroundColor Cyan
Write-Host '  Unregister-ScheduledTask -TaskName GatewayRestart -Confirm:$false   （需系統管理員）'
