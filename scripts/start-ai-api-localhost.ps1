$ErrorActionPreference = "Stop"

$exe = "C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting\Comos.Services.Ai.Api.exe"
$workdir = Split-Path $exe
$logsDir = Join-Path $env:TEMP "comos_ai_api"
$stdout = Join-Path $logsDir "ai_api_stdout.log"
$stderr = Join-Path $logsDir "ai_api_stderr.log"
$shimScript = Join-Path $PSScriptRoot "ai-api-shim.js"
$shimLogDir = Join-Path $env:TEMP "comos_ai_shim"
$shimPidFile = Join-Path $shimLogDir "shim.pid"
$shimStdout = Join-Path $shimLogDir "shim_stdout.log"
$shimStderr = Join-Path $shimLogDir "shim_stderr.log"
$healthBody = '{"messages":[{"role":"user","content":"health"}],"tools":[],"sessionId":"startup-health"}'
$evalBody = '{"messages":[{"role":"user","content":"health-eval"}],"sessionId":"startup-health"}'

if (-not (Test-Path $exe)) {
    throw "Ai API executable not found: $exe"
}

if (-not (Test-Path $shimScript)) {
    throw "Shim script not found: $shimScript"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js executable not found in PATH"
}

if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}

if (-not (Test-Path $shimLogDir)) {
    New-Item -ItemType Directory -Path $shimLogDir | Out-Null
}

Get-Process -Name "Comos.Services.Ai.Api" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$oldPid = $null
if (Test-Path $shimPidFile) {
    $rawPid = Get-Content $shimPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($rawPid -match "^\d+$") {
        $oldPid = [int]$rawPid
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        }
    }
}
if (Test-Path $shimPidFile) {
    Remove-Item $shimPidFile -Force -ErrorAction SilentlyContinue
}

$env:ASPNETCORE_URLS = "http://localhost:56400"
$env:COMOS_LLM_MODEL = "serviceipid-gateway"

$proc = Start-Process -FilePath $exe `
    -ArgumentList @("--urls", "http://localhost:56400") `
    -WorkingDirectory $workdir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

Start-Sleep -Seconds 3

Write-Output ("ai_pid=" + $proc.Id)

$shimArgs = "`"$shimScript`" --listen-port 56401 --target-base http://localhost:56400 --default-model serviceipid-gateway"
$shimProc = Start-Process -FilePath "node" `
    -ArgumentList $shimArgs `
    -WindowStyle Hidden `
    -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput $shimStdout `
    -RedirectStandardError $shimStderr `
    -PassThru

Start-Sleep -Seconds 2
Set-Content -Path $shimPidFile -Value $shimProc.Id -Encoding ASCII

Write-Output ("shim_pid=" + $shimProc.Id)

$tests = @(
    @{
        Name = "HEAD through shim"
        Url = "http://localhost:56401/api/ai/v1/completions"
        Method = "Head"
        Body = $null
    },
    @{
        Name = "POST completions through shim"
        Url = "http://localhost:56401/api/ai/v1/completions"
        Method = "Post"
        Body = $healthBody
    },
    @{
        Name = "POST evaluation through shim without model"
        Url = "http://localhost:56401/api/ai/v1/completions/evaluation"
        Method = "Post"
        Body = $evalBody
    },
    @{
        Name = "POST completions direct AI API"
        Url = "http://localhost:56400/api/ai/v1/completions"
        Method = "Post"
        Body = $healthBody
    },
    @{
        Name = "GET gateway health"
        Url = "http://localhost:8100/health"
        Method = "Get"
        Body = $null
    }
)

foreach ($t in $tests) {
    try {
        if ($null -ne $t.Body) {
            $r = Invoke-WebRequest -Uri $t.Url -Method $t.Method -ContentType "application/json" -Body $t.Body -UseBasicParsing -TimeoutSec 20
        } else {
            $r = Invoke-WebRequest -Uri $t.Url -Method $t.Method -UseBasicParsing -TimeoutSec 20
        }
        Write-Output ("ok " + $t.Name + " => " + $r.StatusCode)
    } catch {
        $msg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        Write-Output ("err " + $t.Name + " => " + $msg)
    }
}

Write-Output ("stdout_log=" + $stdout)
Write-Output ("stderr_log=" + $stderr)
Write-Output ("shim_log=" + (Join-Path $shimLogDir "ai_api_shim.log"))
Write-Output ("shim_stdout=" + $shimStdout)
Write-Output ("shim_stderr=" + $shimStderr)
