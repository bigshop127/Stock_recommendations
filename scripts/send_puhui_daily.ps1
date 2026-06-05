# 每日浦惠投顧報告發送腳本（Task Scheduler 排程用）
# 用途：自動發送當日報告（如不存在則略過）

Set-Location "C:\CC AI Agent"

# 取得今日日期（YYYY-MM-DD 格式）
$today = Get-Date -Format "yyyy-MM-dd"

# 執行發送腳本
Write-Host "[$today] 開始發送浦惠投顧報告..."
node scripts/send_puhui_email.cjs $today

# 檢查執行結果
if ($LASTEXITCODE -eq 0) {
    Write-Host "[$today] 報告發送完成 ✓"
} else {
    Write-Host "[$today] 發送失敗（Exit Code: $LASTEXITCODE）"
}
