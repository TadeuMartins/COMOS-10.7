<#
.SYNOPSIS
    COMOS AI Lifecycle Manager
    Starts AI services (AI API + shim) when COMOS opens, stops them when COMOS closes.

.DESCRIPTION
    This script manages the full lifecycle of AI backend services tied to COMOS:
      1. Starts Comos.Services.Ai.Api.exe on port 56400
      2. Starts Node.js shim on port 56401 (HEAD support + model injection)
      3. Monitors Comos.exe process
      4. When Comos.exe exits, gracefully shuts down AI services

.PARAMETER WaitForComos
    If set, waits up to this many seconds for Comos.exe to appear before giving up.
    Default: 120 (2 minutes). Set to 0 to require COMOS to already be running.

.PARAMETER SkipValidation
    If set, skips the health-check validation after starting services.

.PARAMETER PollInterval
    How often (in seconds) to check if Comos.exe is still running. Default: 3.

.EXAMPLE
    .\comos-ai-lifecycle.ps1
    .\comos-ai-lifecycle.ps1 -WaitForComos 0
    .\comos-ai-lifecycle.ps1 -SkipValidation -PollInterval 5
#>
param(
    [int]$WaitForComos = 120,
    [switch]$SkipValidation,
    [int]$PollInterval = 3
)

$ErrorActionPreference = "Stop"

# ── Paths ──────────────────────────────────────────────────────────────────────
$aiExe       = "C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting\Comos.Services.Ai.Api.exe"
$aiWorkdir   = Split-Path $aiExe
$shimScript  = Join-Path $PSScriptRoot "ai-api-shim.js"
$logDir      = Join-Path $env:TEMP "comos_ai_lifecycle"
$aiStdout    = Join-Path $logDir "ai_api_stdout.log"
$aiStderr    = Join-Path $logDir "ai_api_stderr.log"
$shimStdout  = Join-Path $logDir "shim_stdout.log"
$shimStderr  = Join-Path $logDir "shim_stderr.log"
$pidFile     = Join-Path $logDir "lifecycle.pids"
$lifecycleLog = Join-Path $logDir "lifecycle.log"

# ── Helpers ────────────────────────────────────────────────────────────────────
function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Write-Host $line
    Add-Content -Path $lifecycleLog -Value $line -ErrorAction SilentlyContinue
}

function Stop-TrackedProcesses {
    Write-Log "Stopping AI services..."
    if (Test-Path $pidFile) {
        $pids = Get-Content $pidFile -ErrorAction SilentlyContinue
        foreach ($id in $pids) {
            if ($id -match "^\d+$") {
                $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
                if ($p -and -not $p.HasExited) {
                    Write-Log "  Killing PID $id ($($p.ProcessName))"
                    Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue
                }
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    # Also kill by name as safety net
    Get-Process -Name "Comos.Services.Ai.Api" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    # Kill node shim by command line match
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'ai-api-shim' } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Log "  Killed shim node PID $($_.ProcessId)"
        }
    Write-Log "AI services stopped."
}

function Test-Endpoint {
    param([string]$Name, [string]$Url, [string]$Method = "Head", [string]$Body = $null)
    try {
        if ($Body) {
            $r = Invoke-WebRequest -Uri $Url -Method $Method -ContentType 'application/json' -Body $Body -UseBasicParsing -TimeoutSec 20
        } else {
            $r = Invoke-WebRequest -Uri $Url -Method $Method -UseBasicParsing -TimeoutSec 20
        }
        Write-Log "  OK  $Name => $($r.StatusCode)"
        return $true
    } catch {
        $msg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        Write-Log "  ERR $Name => $msg"
        return $false
    }
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────
if (-not (Test-Path $aiExe)) { throw "AI API executable not found: $aiExe" }
if (-not (Test-Path $shimScript)) { throw "Shim script not found: $shimScript" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found in PATH" }

# Create log directory
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Rotate lifecycle log if > 5MB
if ((Test-Path $lifecycleLog) -and (Get-Item $lifecycleLog).Length -gt 5MB) {
    $bak = $lifecycleLog + ".bak"
    Move-Item $lifecycleLog $bak -Force -ErrorAction SilentlyContinue
}

Write-Log "=========================================="
Write-Log "COMOS AI Lifecycle Manager starting"
Write-Log "=========================================="

# ── Wait for COMOS to be running ──────────────────────────────────────────────
$comosProc = Get-Process -Name "Comos" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $comosProc) {
    if ($WaitForComos -le 0) {
        throw "Comos.exe is not running and WaitForComos=0. Start COMOS first."
    }
    Write-Log "Waiting up to ${WaitForComos}s for Comos.exe to start..."
    $waited = 0
    while ($waited -lt $WaitForComos) {
        Start-Sleep -Seconds 2
        $waited += 2
        $comosProc = Get-Process -Name "Comos" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($comosProc) { break }
        if ($waited % 20 -eq 0) { Write-Log "  Still waiting... (${waited}s)" }
    }
    if (-not $comosProc) {
        throw "Comos.exe did not start within ${WaitForComos}s. Aborting."
    }
}

$comosPid = $comosProc.Id
Write-Log "COMOS detected: PID=$comosPid (started $($comosProc.StartTime.ToString('HH:mm:ss')))"

# ── Stop any previous AI services ─────────────────────────────────────────────
Stop-TrackedProcesses

# Wait for ports to be released
Write-Log "Waiting for ports to be free..."
$portWait = 0
while ($portWait -lt 15) {
    $busy = netstat -ano 2>$null | Select-String -Pattern ':56400\s.*LISTENING|:56401\s.*LISTENING'
    if (-not $busy) { break }
    Start-Sleep -Seconds 1
    $portWait++
}
if ($portWait -ge 15) { Write-Log "WARNING: Ports may still be in use after 15s wait" }

# ── Start AI API ───────────────────────────────────────────────────────────────
Write-Log "Starting AI API on port 56400..."

$env:ASPNETCORE_URLS = "http://localhost:56400"
$env:COMOS_LLM_MODEL = "serviceipid-gateway"

$aiProc = Start-Process -FilePath $aiExe `
    -ArgumentList @("--urls", "http://localhost:56400") `
    -WorkingDirectory $aiWorkdir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $aiStdout `
    -RedirectStandardError $aiStderr `
    -PassThru

Start-Sleep -Seconds 3

if ($aiProc.HasExited) {
    $errContent = if (Test-Path $aiStderr) { Get-Content $aiStderr -Raw } else { "no stderr" }
    throw "AI API exited immediately. stderr: $errContent"
}

Write-Log "AI API started: PID=$($aiProc.Id)"

# ── Start Node.js shim (with retry) ───────────────────────────────────────────
$shimArgs = "`"$shimScript`" --listen-port 56401 --target-base http://localhost:56400 --gateway-base http://localhost:8100 --default-model serviceipid-gateway"
$shimProc = $null
$shimRetries = 0
$shimMaxRetries = 3

while ($shimRetries -lt $shimMaxRetries) {
    $shimRetries++
    Write-Log "Starting Node.js shim on port 56401 (attempt $shimRetries/$shimMaxRetries)..."

    if (Test-Path $shimStderr) { Remove-Item $shimStderr -Force -ErrorAction SilentlyContinue }

    $shimProc = Start-Process -FilePath "node" `
        -ArgumentList $shimArgs `
        -WindowStyle Hidden `
        -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $shimStdout `
        -RedirectStandardError $shimStderr `
        -PassThru

    Start-Sleep -Seconds 2

    if (-not $shimProc.HasExited) {
        Write-Log "Shim started: PID=$($shimProc.Id)"
        break
    }

    $errContent = if (Test-Path $shimStderr) { Get-Content $shimStderr -Raw } else { "no stderr" }
    Write-Log "Shim attempt $shimRetries failed: $errContent"

    if ($shimRetries -lt $shimMaxRetries) { Start-Sleep -Seconds 3 }
}

if ($null -eq $shimProc -or $shimProc.HasExited) {
    Stop-Process -Id $aiProc.Id -Force -ErrorAction SilentlyContinue
    throw "Shim failed after $shimMaxRetries attempts"
}

# ── Save PIDs for cleanup ─────────────────────────────────────────────────────
Set-Content -Path $pidFile -Value @($aiProc.Id, $shimProc.Id) -Encoding ASCII

# ── Validation ─────────────────────────────────────────────────────────────────
if (-not $SkipValidation) {
    Write-Log "Validating endpoints..."
    $body = '{"messages":[{"role":"user","content":"health"}],"tools":[],"sessionId":"lifecycle-check"}'
    $allOk = $true
    $allOk = (Test-Endpoint "HEAD completions (shim)" "http://localhost:56401/api/ai/v1/completions" "Head") -and $allOk
    $allOk = (Test-Endpoint "POST completions (shim)" "http://localhost:56401/api/ai/v1/completions" "Post" $body) -and $allOk
    $allOk = (Test-Endpoint "POST evaluation (shim)" "http://localhost:56401/api/ai/v1/completions/evaluation" "Post" '{"messages":[{"role":"user","content":"health"}],"sessionId":"lc-eval"}') -and $allOk
    if ($allOk) {
        Write-Log "All endpoints healthy."
    } else {
        Write-Log "WARNING: Some endpoints failed. Chatbot may not work correctly."
    }
}

# ── Monitor COMOS ──────────────────────────────────────────────────────────────
Write-Log "Monitoring COMOS (PID=$comosPid) - AI services will stop when COMOS closes."
Write-Log "Press Ctrl+C to stop manually (services will also be stopped)."
Write-Log "------------------------------------------"

try {
    while ($true) {
        Start-Sleep -Seconds $PollInterval

        # Check if COMOS is still running
        $comos = Get-Process -Id $comosPid -ErrorAction SilentlyContinue
        if (-not $comos -or $comos.HasExited) {
            Write-Log "COMOS (PID=$comosPid) has exited."
            break
        }

        # Check if AI services are still alive, restart if needed
        $aiAlive = Get-Process -Id $aiProc.Id -ErrorAction SilentlyContinue
        if (-not $aiAlive -or $aiAlive.HasExited) {
            Write-Log "WARNING: AI API died, restarting..."
            $aiProc = Start-Process -FilePath $aiExe `
                -ArgumentList @("--urls", "http://localhost:56400") `
                -WorkingDirectory $aiWorkdir `
                -WindowStyle Hidden `
                -RedirectStandardOutput $aiStdout `
                -RedirectStandardError $aiStderr `
                -PassThru
            Start-Sleep -Seconds 2
            Write-Log "AI API restarted: PID=$($aiProc.Id)"
            Set-Content -Path $pidFile -Value @($aiProc.Id, $shimProc.Id) -Encoding ASCII
        }

        $shimAlive = Get-Process -Id $shimProc.Id -ErrorAction SilentlyContinue
        if (-not $shimAlive -or $shimAlive.HasExited) {
            Write-Log "WARNING: Shim died, restarting..."
            $shimProc = Start-Process -FilePath "node" `
                -ArgumentList $shimArgs `
                -WindowStyle Hidden `
                -WorkingDirectory $PSScriptRoot `
                -RedirectStandardOutput $shimStdout `
                -RedirectStandardError $shimStderr `
                -PassThru
            Start-Sleep -Seconds 1
            Write-Log "Shim restarted: PID=$($shimProc.Id)"
            Set-Content -Path $pidFile -Value @($aiProc.Id, $shimProc.Id) -Encoding ASCII
        }
    }
} finally {
    # Cleanup on exit (Ctrl+C or COMOS closed)
    Stop-TrackedProcesses
    Write-Log "COMOS AI Lifecycle Manager finished."
    Write-Log "=========================================="
}
