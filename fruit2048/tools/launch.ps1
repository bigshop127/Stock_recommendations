# 一鍵啟動「水果 2048 輔助器」（桌面捷徑指向這支）
#
# 用 pythonw.exe 啟動，所以不會留一個黑色主控台視窗在工作列。
# 代價是啟動失敗時錯誤訊息會不見，所以這裡把 stderr 導到暫存檔，
# 程式如果一啟動就掛掉，就把那份錯誤用對話框顯示出來。
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $PSScriptRoot
$Log    = Join-Path $env:TEMP 'fruit2048-launch.log'

Add-Type -AssemblyName System.Windows.Forms

function Show-Error([string]$text) {
    [System.Windows.Forms.MessageBox]::Show(
        $text, '水果 2048 輔助器',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

# --- 找 Python ---
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
    Show-Error "找不到 Python。`n`n請到 python.org 安裝 Python 3.9 以上，安裝時記得勾選 `"Add Python to PATH`"。"
    exit 1
}
# pythonw 跟 python 放在同一個資料夾
$pyw = Join-Path (Split-Path -Parent $py.Source) 'pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = $py.Source }

# --- 相依套件 ---
& $py.Source -c "import numpy, PIL, mss" 2>$null
if ($LASTEXITCODE -ne 0) {
    # 這一段要讓使用者看得到進度，所以刻意開一個看得見的視窗
    $install = Start-Process -FilePath $py.Source -Wait -PassThru -WorkingDirectory $AppDir `
        -ArgumentList @('-m', 'pip', 'install', '-r', 'requirements.txt')
    if ($install.ExitCode -ne 0) {
        Show-Error "安裝相依套件失敗（pip 回傳 $($install.ExitCode)）。`n`n請手動執行：`npip install -r `"$AppDir\requirements.txt`""
        exit 1
    }
}

# --- 啟動 ---
if (Test-Path $Log) { Remove-Item $Log -Force -ErrorAction SilentlyContinue }
# -WindowStyle 一定要明確寫 Normal，不能省略也不能寫 Hidden：
#   * 寫 Hidden → STARTUPINFO 傳 SW_HIDE，Tk 的第一個視窗會照做，程式在跑但看不到。
#   * 省略不寫 → 子行程會「繼承」啟動這條鏈的顯示狀態，而桌面捷徑本身是
#     WindowStyle=7（最小化，用來壓掉 PowerShell 的黑視窗），結果輔助器一開就縮在工作列。
# 明確指定 Normal 會設定 STARTF_USESHOWWINDOW，把繼承來的值蓋掉。
$proc = Start-Process -FilePath $pyw -PassThru -WorkingDirectory $AppDir `
    -ArgumentList 'app.py' -RedirectStandardError $Log -WindowStyle Normal

# 開得起來的話會一直跑；三秒內就死掉代表啟動時就出事了
if ($proc.WaitForExit(3000)) {
    $detail = ''
    if (Test-Path $Log) { $detail = (Get-Content $Log -Raw).Trim() }
    if (-not $detail) { $detail = "（沒有錯誤訊息，結束代碼 $($proc.ExitCode)）" }
    Show-Error "程式啟動後隨即結束：`n`n$detail"
    exit 1
}
