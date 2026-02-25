$hosting = "C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting"
$dllPath = "$hosting\Comos.Services.Ai.Api.dll"
$bytes = [IO.File]::ReadAllBytes($dllPath)
Write-Host "DLL size: $($bytes.Length) bytes"
Write-Host "SHA256: $((Get-FileHash $dllPath -Algorithm SHA256).Hash)"

# IEEE 754 double for 30.0
$target30 = [BitConverter]::GetBytes([double]30.0)
$hex30 = ($target30 | ForEach-Object { $_.ToString("X2") }) -join " "
Write-Host "`nSearching for 30.0 (double): $hex30"

# Search for 30.0 occurrences
$found = @()
for ($i = 0; $i -lt $bytes.Length - 7; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$i + $j] -ne $target30[$j]) { $match = $false; break }
    }
    if ($match) {
        $found += $i
        Write-Host "  Found 30.0 at offset $i (0x$($i.ToString('X4')))"
    }
}
Write-Host "Total 30.0 occurrences: $($found.Count)"

# Also search for 60.0 (possible TotalTimeout)
$target60 = [BitConverter]::GetBytes([double]60.0)
Write-Host "`nSearching for 60.0 (double):"
for ($i = 0; $i -lt $bytes.Length - 7; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$i + $j] -ne $target60[$j]) { $match = $false; break }
    }
    if ($match) {
        Write-Host "  Found 60.0 at offset $i (0x$($i.ToString('X4')))"
    }
}

# Search for integer 3 as ldc.i4.3 (opcode 0x19) near "MaxIterations" context
# Also search for TimeSpan.FromSeconds patterns
$targetTF = [System.Text.Encoding]::UTF8.GetBytes("TimeSpan")
$targetTO = [System.Text.Encoding]::UTF8.GetBytes("Timeout")
$targetIT = [System.Text.Encoding]::UTF8.GetBytes("Iteration")
$targetMX = [System.Text.Encoding]::UTF8.GetBytes("MaxIteration")

Write-Host "`nSearching for string references:"
foreach ($pair in @(@("TimeSpan", $targetTF), @("Timeout", $targetTO), @("Iteration", $targetIT), @("MaxIteration", $targetMX))) {
    $name = $pair[0]
    $pattern = $pair[1]
    for ($i = 0; $i -lt $bytes.Length - $pattern.Length; $i++) {
        $match = $true
        for ($j = 0; $j -lt $pattern.Length; $j++) {
            if ($bytes[$i + $j] -ne $pattern[$j]) { $match = $false; break }
        }
        if ($match) {
            # Read surrounding context
            $start = [Math]::Max(0, $i - 2)
            $end = [Math]::Min($bytes.Length, $i + $pattern.Length + 20)
            $ctx = [System.Text.Encoding]::ASCII.GetString($bytes[$start..$end]) -replace '[^\x20-\x7E]', '.'
            Write-Host "  '$name' at offset $i (0x$($i.ToString('X4'))): $ctx"
        }
    }
}

Write-Host "`nDone."
