<#
.SYNOPSIS
    COMOS AI Watcher - runs at logon, detects COMOS, manages AI services automatically.
    No user action required. Starts AI when COMOS opens, stops when COMOS closes. Loops forever.
#>
$ErrorActionPreference = "Continue"

$lifecycleScript = Join-Path $PSScriptRoot "comos-ai-lifecycle.ps1"
$logDir = Join-Path $env:TEMP "comos_ai_lifecycle"
$logFile = Join-Path $logDir "watcher.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Rotate log if > 2MB
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
    Move-Item $logFile ($logFile + ".bak") -Force -ErrorAction SilentlyContinue
}

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [watcher] $Message"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Write-Log "COMOS AI Watcher started. Waiting for Comos.exe..."

while ($true) {
    # Wait for COMOS to appear
    $comos = $null
    while (-not $comos) {
        Start-Sleep -Seconds 3
        $comos = Get-Process -Name "Comos" -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    $comosPid = $comos.Id
    Write-Log "COMOS detected: PID=$comosPid. Launching lifecycle manager..."

    # Run lifecycle manager (blocks until COMOS closes)
    try {
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $lifecycleScript -WaitForComos 0 -PollInterval 3 2>&1 |
            ForEach-Object { Add-Content -Path $logFile -Value $_ -ErrorAction SilentlyContinue }
    } catch {
        Write-Log "Lifecycle error: $($_.Exception.Message)"
    }

    Write-Log "Lifecycle manager exited. Waiting for next COMOS session..."

    # Brief cooldown to avoid rapid re-detection if COMOS restarts quickly
    Start-Sleep -Seconds 5
}
