# Single-shot test of the launch command to verify parameters. Reads config from env.
$env:SUPPRESS_LABEL_WARNING = 'True'

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

$required = @('OCI_COMPARTMENT_ID', 'OCI_AVAILABILITY_DOMAIN', 'OCI_SUBNET_ID', 'OCI_IMAGE_ID', 'OCI_SSH_PUBLIC_KEY')
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, 'Process') }
if ($missing) {
    Write-Error ("Missing required env vars: {0}" -f ($missing -join ', '))
    exit 1
}

$ociExe = $env:OCI_EXE
if (-not $ociExe) { $ociCmd = Get-Command oci -ErrorAction SilentlyContinue; if ($ociCmd) { $ociExe = $ociCmd.Source } }
if (-not $ociExe) { Write-Error 'OCI CLI not found'; exit 1 }

$compartmentId      = $env:OCI_COMPARTMENT_ID
$availabilityDomain = $env:OCI_AVAILABILITY_DOMAIN
$subnetId           = $env:OCI_SUBNET_ID
$imageId            = $env:OCI_IMAGE_ID
$sshKey             = $env:OCI_SSH_PUBLIC_KEY

$dataDir = Join-Path $projectRoot 'data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
@{ ssh_authorized_keys = $sshKey } | ConvertTo-Json -Compress | Out-File "$dataDir\oracle_metadata.json" -Encoding ASCII
@{ ocpus = 2; memoryInGBs = 12 } | ConvertTo-Json -Compress | Out-File "$dataDir\oracle_shape_config.json" -Encoding ASCII
@{ sourceType = 'image'; imageId = $imageId } | ConvertTo-Json -Compress | Out-File "$dataDir\oracle_source_details.json" -Encoding ASCII

Write-Host "Attempting single launch..."
$output = & $ociExe compute instance launch `
    --compartment-id $compartmentId `
    --availability-domain $availabilityDomain `
    --subnet-id $subnetId `
    --display-name 'puhui-daily' `
    --shape 'VM.Standard.A1.Flex' `
    --shape-config "file://$dataDir\oracle_shape_config.json" `
    --source-details "file://$dataDir\oracle_source_details.json" `
    --assign-public-ip true `
    --metadata "file://$dataDir\oracle_metadata.json" 2>&1 | Out-String

Write-Host "=== OUTPUT ==="
Write-Host $output
