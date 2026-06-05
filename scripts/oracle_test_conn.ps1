# Oracle CLI connectivity smoke test. Reads OCI_EXE + OCI_COMPARTMENT_ID from env (.env at project root).
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

$ociExe = $env:OCI_EXE
if (-not $ociExe) { $ociCmd = Get-Command oci -ErrorAction SilentlyContinue; if ($ociCmd) { $ociExe = $ociCmd.Source } }
$compartmentId = $env:OCI_COMPARTMENT_ID
if (-not $ociExe -or -not $compartmentId) {
    Write-Error 'Need OCI_EXE (or oci on PATH) and OCI_COMPARTMENT_ID in .env'
    exit 1
}

Write-Host "Test 1: identity availability domains list"
& $ociExe iam availability-domain list --compartment-id $compartmentId 2>&1 | Select-String -Pattern '"name"|error|timed out' | Select-Object -First 5

Write-Host "`nTest 2: compute image list (just 1)"
& $ociExe compute image list --compartment-id $compartmentId --shape 'VM.Standard.A1.Flex' --limit 1 2>&1 | Select-String -Pattern '"display-name"|error|timed out' | Select-Object -First 3
