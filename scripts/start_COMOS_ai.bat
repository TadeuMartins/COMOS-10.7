@echo off
:: ============================================================
:: start_COMOS_ai.bat — Start (or restart) COMOS AI API + Shim
:: Double-click or run from cmd. Safe to run repeatedly.
:: ============================================================
setlocal EnableDelayedExpansion

set "EXE=C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting\Comos.Services.Ai.Api.exe"
set "SHIMSCRIPT=C:\Program Files (x86)\COMOS\Team_AI\scripts\ai-api-shim.js"
set "LOGSDIR=%TEMP%\comos_ai_api"
set "SHIMLOGDIR=%TEMP%\comos_ai_shim"
set "SHIMPIDFILE=%SHIMLOGDIR%\shim.pid"

:: ---- Validate prerequisites ----
if not exist "%EXE%" (
    echo ERROR: AI API executable not found: %EXE%
    pause
    exit /b 1
)
if not exist "%SHIMSCRIPT%" (
    echo ERROR: Shim script not found: %SHIMSCRIPT%
    pause
    exit /b 1
)
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found in PATH
    pause
    exit /b 1
)

:: ---- Create log directories ----
if not exist "%LOGSDIR%" mkdir "%LOGSDIR%"
if not exist "%SHIMLOGDIR%" mkdir "%SHIMLOGDIR%"

:: ---- Kill existing AI API if running ----
echo Checking for running AI API processes...
tasklist /FI "IMAGENAME eq Comos.Services.Ai.Api.exe" 2>nul | find /I "Comos.Services.Ai.Api.exe" >nul
if %ERRORLEVEL%==0 (
    echo   Stopping existing AI API...
    taskkill /F /IM "Comos.Services.Ai.Api.exe" >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo   AI API stopped.
) else (
    echo   No existing AI API process found.
)

:: ---- Kill existing Shim if running ----
echo Checking for running Shim process...
set "OLDSHIMPID="
if exist "%SHIMPIDFILE%" (
    set /p OLDSHIMPID=<"%SHIMPIDFILE%"
)
if defined OLDSHIMPID (
    echo   Stopping existing Shim (PID: !OLDSHIMPID!)...
    taskkill /F /PID !OLDSHIMPID! >nul 2>&1
    del /f "%SHIMPIDFILE%" >nul 2>&1
    timeout /t 1 /nobreak >nul
    echo   Shim stopped.
) else (
    echo   No existing Shim PID file found.
)

:: ---- Set environment ----
set "ASPNETCORE_URLS=http://localhost:56400"
set "COMOS_LLM_MODEL=serviceipid-gateway"

:: ---- Start AI API ----
echo Starting AI API on port 56400...
start "" /B "%EXE%" --urls http://localhost:56400 >"%LOGSDIR%\ai_api_stdout.log" 2>"%LOGSDIR%\ai_api_stderr.log"
timeout /t 3 /nobreak >nul

:: Find the PID of the newly started AI API
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq Comos.Services.Ai.Api.exe" /NH 2^>nul ^| find /I "Comos.Services.Ai.Api.exe"') do (
    set "AI_PID=%%a"
)
if defined AI_PID (
    echo   AI API started (PID: !AI_PID!)
) else (
    echo   WARNING: AI API may not have started. Check logs at %LOGSDIR%
)

:: ---- Start Shim ----
echo Starting AI Shim on port 56401...
start "" /B node "%SHIMSCRIPT%" --listen-port 56401 --target-base http://localhost:56400 --default-model serviceipid-gateway >"%SHIMLOGDIR%\shim_stdout.log" 2>"%SHIMLOGDIR%\shim_stderr.log"
timeout /t 2 /nobreak >nul

:: Find the PID of the shim (newest node process running the shim script)
for /f "tokens=2" %%a in ('wmic process where "CommandLine like '%%ai-api-shim%%'" get ProcessId /value 2^>nul ^| find "="') do (
    set "SHIM_PID=%%a"
)
:: Remove trailing carriage return from wmic output
for /f "tokens=* delims=" %%b in ("!SHIM_PID!") do set "SHIM_PID=%%b"
if defined SHIM_PID (
    echo !SHIM_PID!>"%SHIMPIDFILE%"
    echo   Shim started (PID: !SHIM_PID!)
) else (
    echo   WARNING: Shim PID not detected. Check logs at %SHIMLOGDIR%
)

:: ---- Health checks ----
echo.
echo Running health checks...
timeout /t 2 /nobreak >nul

:: Check shim HEAD
curl -s -o nul -w "  Shim HEAD:         %%{http_code}\n" -X HEAD http://localhost:56401/api/ai/v1/completions

:: Check gateway health
curl -s -o nul -w "  Gateway health:    %%{http_code}\n" http://localhost:8100/health

:: Check direct AI API
curl -s -o nul -w "  AI API direct:     %%{http_code}\n" -X POST http://localhost:56400/api/ai/v1/completions -H "Content-Type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"health\"}],\"tools\":[],\"sessionId\":\"bat-health\"}"

echo.
echo ============================================================
echo   AI API PID:   !AI_PID!
echo   Shim PID:     !SHIM_PID!
echo   Logs:         %LOGSDIR%
echo   Shim logs:    %SHIMLOGDIR%
echo ============================================================
echo.
echo COMOS AI services ready. You can close this window.
pause
