$out = @()

# Find ildasm
$paths = @(
    "C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8.1 Tools\ildasm.exe",
    "C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8 Tools\ildasm.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\SDK\ScopeCppSDK\vc15\VC\bin\ildasm.exe"
)
$ildasm = $null
foreach ($p in $paths) {
    if (Test-Path $p) { $ildasm = $p; break }
}
# Search recursively as last resort
if (-not $ildasm) {
    $ildasm = (Get-ChildItem "C:\Program Files*" -Recurse -Filter "ildasm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
$out += "ildasm: $ildasm"
$out += "dotnet: $(Test-Path 'C:\Program Files\dotnet\dotnet.exe')"

$hosting = "C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting"

# Use a comprehensive approach: search ALL DLLs in Hosting for strings containing "timeout" or "iteration"  
$out += ""
$out += "=== String search in Hosting DLLs ==="
foreach ($dll in (Get-ChildItem $hosting -Filter "Comos.*.dll")) {
    $bytes = [IO.File]::ReadAllBytes($dll.FullName)
    # Extract all readable strings (UTF-16 LE which .NET uses for metadata)
    $text = [System.Text.Encoding]::Unicode.GetString($bytes)
    
    # Look for timeout-related strings
    $timeoutMatches = [regex]::Matches($text, '[A-Za-z_]*[Tt]imeout[A-Za-z_]*')
    $iterMatches = [regex]::Matches($text, '[A-Za-z_]*[Ii]terat[A-Za-z_]*')
    $secondsMatches = [regex]::Matches($text, '[A-Za-z_]*[Ss]econds?[A-Za-z_]*')
    
    if ($timeoutMatches.Count -gt 0 -or $iterMatches.Count -gt 0 -or $secondsMatches.Count -gt 0) {
        $out += ""
        $out += "--- $($dll.Name) ($($dll.Length) bytes) ---"
        foreach ($m in $timeoutMatches) { $out += "  Timeout: $($m.Value)" }
        foreach ($m in $iterMatches) { $out += "  Iter: $($m.Value)" }
        foreach ($m in $secondsMatches) { $out += "  Seconds: $($m.Value)" }
    }
}

# Also search UTF-8
$out += ""
$out += "=== UTF-8 string search ==="
foreach ($dll in (Get-ChildItem $hosting -Filter "Comos.*.dll")) {
    $bytes = [IO.File]::ReadAllBytes($dll.FullName)
    $text8 = [System.Text.Encoding]::UTF8.GetString($bytes)
    
    $timeoutMatches = [regex]::Matches($text8, '[A-Za-z_.]*[Tt]imeout[A-Za-z_.]*')
    $iterMatches = [regex]::Matches($text8, '[A-Za-z_.]*[Ii]terat[A-Za-z_.]*')
    $maxMatches = [regex]::Matches($text8, '[A-Za-z_.]*MaxIt[A-Za-z_.]*')
    
    if ($timeoutMatches.Count -gt 0 -or $iterMatches.Count -gt 0 -or $maxMatches.Count -gt 0) {
        $out += ""
        $out += "--- $($dll.Name) (UTF-8) ---"
        $unique = @{}
        foreach ($m in ($timeoutMatches + $iterMatches + $maxMatches)) {
            $val = $m.Value
            if (-not $unique.ContainsKey($val) -and $val.Length -gt 4 -and $val.Length -lt 80) {
                $unique[$val] = $true
                $out += "  $val"
            }
        }
    }
}

$resultFile = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\_hosting_scan.txt"
$out | Out-File -FilePath $resultFile -Encoding utf8
$out | ForEach-Object { Write-Host $_ }
