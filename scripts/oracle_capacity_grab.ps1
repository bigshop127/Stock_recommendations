# Oracle A1.Flex Capacity Grab — auto-retry instance launch until success
# Runs `oci compute instance launch` in a loop; on success sends Telegram notification.
#
# Configuration: reads all secrets / identifiers from environment variables.
# Loads .env file (sibling of project root) if env vars are not already set.
#
# Required env vars:
#   OCI_COMPARTMENT_ID, OCI_AVAILABILITY_DOMAIN, OCI_SUBNET_ID, OCI_IMAGE_ID,
#   OCI_SSH_PUBLIC_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Optional env vars:
#   OCI_EXE                 path to oci.exe (default: looks up in PATH)
#   OCI_DISPLAY_NAME        instance display name (default: puhui-daily)
#   OCI_SHAPE               shape (default: VM.Standard.A1.Flex)
#   OCI_OCPUS               OCPU count (default: 2)
#   OCI_MEMORY_GB           memory in GB (default: 12)
#   ORACLE_GRAB_INTERVAL    seconds between retries (default: 60)

$ErrorActionPreference = 'Continue'
$env:SUPPRESS_LABEL_WARNING = 'True'

# === Load .env (project root) if values are not already set ===
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim('"').Trim("'")
            if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) {
                [Environment]::SetEnvironmentVariable($key, $val, 'Process')
            }
        }
    }
}

# === Required vars ===
$required = @(
    'OCI_COMPARTMENT_ID', 'OCI_AVAILABILITY_DOMAIN', 'OCI_SUBNET_ID',
    'OCI_IMAGE_ID', 'OCI_SSH_PUBLIC_KEY',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'
)
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, 'Process') }
if ($missing) {
    Write-Error ("Missing required environment variables: {0}`nSet them in .env at project root or in the shell." -f ($missing -join ', '))
    exit 1
}

# === Paths (project-relative) ===
$dataDir = Join-Path $projectRoot 'data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
$logFile           = Join-Path $dataDir 'oracle_grab.log'
$stateFile         = Join-Path $dataDir 'oracle_grab_state.json'
$metadataFile      = Join-Path $dataDir 'oracle_metadata.json'
$shapeConfigFile   = Join-Path $dataDir 'oracle_shape_config.json'
$sourceDetailsFile = Join-Path $dataDir 'oracle_source_details.json'

# === OCI CLI ===
$ociExe = $env:OCI_EXE
if (-not $ociExe) {
    $ociCmd = Get-Command oci -ErrorAction SilentlyContinue
    if ($ociCmd) { $ociExe = $ociCmd.Source }
}
if (-not $ociExe -or -not (Test-Path -LiteralPath $ociExe)) {
    Write-Error 'OCI CLI not found. Set $env:OCI_EXE or ensure oci is on PATH.'
    exit 1
}

# === Instance config ===
$compartmentId      = $env:OCI_COMPARTMENT_ID
$availabilityDomain = $env:OCI_AVAILABILITY_DOMAIN
$subnetId           = $env:OCI_SUBNET_ID
$imageId            = $env:OCI_IMAGE_ID
$sshKey             = $env:OCI_SSH_PUBLIC_KEY
$displayName        = if ($env:OCI_DISPLAY_NAME) { $env:OCI_DISPLAY_NAME } else { 'puhui-daily' }
$shape              = if ($env:OCI_SHAPE) { $env:OCI_SHAPE } else { 'VM.Standard.A1.Flex' }
$ocpus              = if ($env:OCI_OCPUS) { [int]$env:OCI_OCPUS } else { 2 }
$memoryGb           = if ($env:OCI_MEMORY_GB) { [int]$env:OCI_MEMORY_GB } else { 12 }

# === Telegram ===
$tgToken = $env:TELEGRAM_BOT_TOKEN
$tgChat  = $env:TELEGRAM_CHAT_ID

# === Retry settings ===
$intervalSeconds = if ($env:ORACLE_GRAB_INTERVAL) { [int]$env:ORACLE_GRAB_INTERVAL } else { 60 }
$maxAttempts = 0            # 0 = unlimited
$progressEveryN = 10        # Telegram heartbeat every N attempts

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "$ts $msg" | Tee-Object -FilePath $logFile -Append
}

function Send-Telegram($text) {
    try {
        $body = @{ chat_id = $tgChat; text = $text; parse_mode = 'Markdown' }
        Invoke-RestMethod -Uri "https://api.telegram.org/bot$tgToken/sendMessage" -Method Post -Body $body -TimeoutSec 10 | Out-Null
    } catch {
        Write-Log "[Telegram] Send failed: $_"
    }
}

# Build metadata JSON file for ssh_authorized_keys (CLI requires file path)
$metadataJson = @{ ssh_authorized_keys = $sshKey } | ConvertTo-Json -Compress
$metadataJson | Out-File -FilePath $metadataFile -Encoding ASCII

# Shape config JSON
$shapeConfigJson = @{ ocpus = $ocpus; memoryInGBs = $memoryGb } | ConvertTo-Json -Compress
$shapeConfigJson | Out-File -FilePath $shapeConfigFile -Encoding ASCII

# Source details JSON
$sourceDetailsJson = @{ sourceType = 'image'; imageId = $imageId } | ConvertTo-Json -Compress
$sourceDetailsJson | Out-File -FilePath $sourceDetailsFile -Encoding ASCII

Write-Log "=== Oracle Capacity Grab started ==="
Write-Log "Shape: $shape ($ocpus OCPU / $memoryGb GB)"
Write-Log "AD: $availabilityDomain"
Write-Log "Interval: ${intervalSeconds}s"
Send-Telegram "Oracle capacity grab started ($shape $ocpus/$memoryGb GB, ${intervalSeconds}s interval)"

$attempt = 0
$startTime = Get-Date

while ($true) {
    $attempt++

    $output = & $ociExe compute instance launch `
        --compartment-id $compartmentId `
        --availability-domain $availabilityDomain `
        --subnet-id $subnetId `
        --display-name $displayName `
        --shape $shape `
        --shape-config "file://$shapeConfigFile" `
        --source-details "file://$sourceDetailsFile" `
        --assign-public-ip true `
        --metadata "file://$metadataFile" `
        --wait-for-state RUNNING `
        --max-wait-seconds 600 2>&1 | Out-String

    if ($output -match '"lifecycle-state":\s*"RUNNING"') {
        # SUCCESS — extract instance OCID + public IP
        $instanceId = ([regex]::Match($output, '"id":\s*"(ocid1\.instance\.[^"]+)"')).Groups[1].Value
        Write-Log "[SUCCESS] Instance launched! id=$instanceId"

        # Get public IP via VNIC
        Start-Sleep -Seconds 5
        $vnicJson = & $ociExe compute instance list-vnics --instance-id $instanceId 2>&1 | Out-String
        $publicIp = ([regex]::Match($vnicJson, '"public-ip":\s*"([^"]+)"')).Groups[1].Value

        $duration = (Get-Date) - $startTime
        $msg = "Oracle VM $displayName RUNNING`nPublic IP: $publicIp`nInstance: $instanceId`nAttempts: $attempt`nDuration: $([int]$duration.TotalMinutes) min"
        Write-Log $msg
        Send-Telegram $msg

        # Save state
        @{
            instance_id = $instanceId
            public_ip = $publicIp
            attempts = $attempt
            launched_at = (Get-Date).ToString('o')
        } | ConvertTo-Json | Out-File -FilePath $stateFile -Encoding UTF8

        break
    }
    elseif ($output -match 'Out of host capacity') {
        if ($attempt % $progressEveryN -eq 0) {
            $elapsed = [int]((Get-Date) - $startTime).TotalMinutes
            Write-Log "[#$attempt] Out of capacity (${elapsed}min elapsed)"
            Send-Telegram "Oracle grab heartbeat: attempt #$attempt, ${elapsed}min elapsed, still out of capacity"
        } else {
            Write-Log "[#$attempt] Out of capacity"
        }
    }
    elseif ($output -match 'TooManyRequests|rate limit') {
        Write-Log "[#$attempt] Rate limited, backing off 5 min"
        Start-Sleep -Seconds 300
        continue
    }
    elseif ($output -match 'LimitExceeded|QuotaExceeded') {
        Write-Log "[#$attempt] QUOTA EXCEEDED — stopping"
        Send-Telegram "Oracle grab STOPPED: quota exceeded`n$output"
        break
    }
    else {
        # Unknown error — log and continue (but slow down)
        Write-Log "[#$attempt] Unknown response (first 500 chars): $($output.Substring(0, [Math]::Min(500, $output.Length)))"
        Start-Sleep -Seconds 30
    }

    if ($maxAttempts -gt 0 -and $attempt -ge $maxAttempts) {
        Write-Log "Max attempts reached, stopping"
        Send-Telegram "Oracle grab stopped: max attempts ($maxAttempts) reached"
        break
    }

    Start-Sleep -Seconds $intervalSeconds
}

Write-Log "=== Done ==="
