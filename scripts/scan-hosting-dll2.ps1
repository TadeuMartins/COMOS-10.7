$hosting = "C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting"
$dllPath = "$hosting\Comos.Services.Ai.Api.dll"
$bytes = [IO.File]::ReadAllBytes($dllPath)

# In .NET Core IL, TimeSpan.FromSeconds(30) might use:
# ldc.i4.s 30 = 0x1F 0x1E
# or ldc.r8 30.0 = 00 00 00 00 00 00 3E 40
# or ldc.i4 30 = 0x20 0x1E 0x00 0x00 0x00

# Search for ldc.i4.s 30 (0x1F 0x1E) which is very common
Write-Host "=== Searching ldc.i4.s 30 (0x1F 0x1E) ==="
for ($i = 0; $i -lt $bytes.Length - 1; $i++) {
    if ($bytes[$i] -eq 0x1F -and $bytes[$i+1] -eq 0x1E) {
        # Check context - show surrounding bytes
        $start = [Math]::Max(0, $i - 4)
        $end = [Math]::Min($bytes.Length - 1, $i + 6)
        $hex = ($bytes[$start..$end] | ForEach-Object { $_.ToString("X2") }) -join " "
        Write-Host "  Offset $i (0x$($i.ToString('X4'))): $hex"
    }
}

# Search for ldc.i4 30 (0x20 0x1E 0x00 0x00 0x00) 
Write-Host "`n=== Searching ldc.i4 30 (0x20 0x1E 0x00 0x00 0x00) ==="
for ($i = 0; $i -lt $bytes.Length - 4; $i++) {
    if ($bytes[$i] -eq 0x20 -and $bytes[$i+1] -eq 0x1E -and $bytes[$i+2] -eq 0x00 -and $bytes[$i+3] -eq 0x00 -and $bytes[$i+4] -eq 0x00) {
        $start = [Math]::Max(0, $i - 4)
        $end = [Math]::Min($bytes.Length - 1, $i + 8)
        $hex = ($bytes[$start..$end] | ForEach-Object { $_.ToString("X2") }) -join " "        
        Write-Host "  Offset $i (0x$($i.ToString('X4'))): $hex"
    }
}

# Also try: maybe it's a TimeSpan stored in ticks or something. Check for 30.0 as float32 
$float30 = [BitConverter]::GetBytes([float]30.0)
$hexF = ($float30 | ForEach-Object { $_.ToString("X2") }) -join " "
Write-Host "`n=== Searching 30.0 as float32: $hexF ==="
for ($i = 0; $i -lt $bytes.Length - 3; $i++) {
    $match = $true
    for ($j = 0; $j -lt 4; $j++) {
        if ($bytes[$i + $j] -ne $float30[$j]) { $match = $false; break }
    }
    if ($match) {
        Write-Host "  Offset $i (0x$($i.ToString('X4')))"
    }
}

# Let's also check the other DLL: Comos.Services.Ai.dll (25088 bytes) — might contain the actual timeout logic
$aiDll = "$hosting\Comos.Services.Ai.dll"
$aibytes = [IO.File]::ReadAllBytes($aiDll)
Write-Host "`n=== Comos.Services.Ai.dll ($($aibytes.Length) bytes) ==="

# Search for 30.0 double
$target30 = [BitConverter]::GetBytes([double]30.0)
Write-Host "Searching 30.0 double:"
for ($i = 0; $i -lt $aibytes.Length - 7; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($aibytes[$i + $j] -ne $target30[$j]) { $match = $false; break }
    }
    if ($match) { Write-Host "  Found at offset $i (0x$($i.ToString('X4')))" }
}

# Search for 60.0 double  
$target60 = [BitConverter]::GetBytes([double]60.0)
Write-Host "Searching 60.0 double:"
for ($i = 0; $i -lt $aibytes.Length - 7; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($aibytes[$i + $j] -ne $target60[$j]) { $match = $false; break }
    }
    if ($match) { Write-Host "  Found at offset $i (0x$($i.ToString('X4')))" }
}

# Search ldc.i4.s 30 in Ai.dll
Write-Host "Searching ldc.i4.s 30:"
for ($i = 0; $i -lt $aibytes.Length - 1; $i++) {
    if ($aibytes[$i] -eq 0x1F -and $aibytes[$i+1] -eq 0x1E) {
        $start = [Math]::Max(0, $i - 4)
        $end = [Math]::Min($aibytes.Length - 1, $i + 6)
        $hex = ($aibytes[$start..$end] | ForEach-Object { $_.ToString("X2") }) -join " "
        Write-Host "  Offset $i (0x$($i.ToString('X4'))): $hex"
    }
}

Write-Host "`n=== Also checking for config-based timeout ==="
# The .NET Core app might load timeout from config
$configPath = "$hosting\Comos.Services.Ai.Api.exe.config"
if (Test-Path $configPath) { Get-Content $configPath }
$runtimeConfig = "$hosting\Comos.Services.Ai.Api.runtimeconfig.json"
if (Test-Path $runtimeConfig) { Get-Content $runtimeConfig }

Write-Host "`nDone."
