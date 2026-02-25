# Find ALL occurrences of 30.0 as IEEE 754 double in Comos.Ai.Client.dll
$bin = 'C:\Program Files (x86)\COMOS\Team_AI\Bin'
$bytes = [IO.File]::ReadAllBytes("$bin\Comos.Ai.Client.dll")
$target = [BitConverter]::GetBytes([double]30.0)
$hex = ($target | ForEach-Object { $_.ToString("X2") }) -join " "
"Searching for 30.0 double: $hex"
"DLL size: $($bytes.Length)"
""

for ($i = 0; $i -lt $bytes.Length - 8; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$i + $j] -ne $target[$j]) { $match = $false; break }
    }
    if ($match) {
        $start = [Math]::Max(0, $i - 4)
        $end = [Math]::Min($bytes.Length - 1, $i + 12)
        $ctx = ($bytes[$start..$end] | ForEach-Object { $_.ToString("X2") }) -join " "
        "Found 30.0 at offset $i (0x$($i.ToString('X4'))): ...$ctx..."
        
        # Check if preceded by ldc.r8 opcode (0x23)
        if ($i -gt 0 -and $bytes[$i-1] -eq 0x23) {
            "  ^^^ Preceded by ldc.r8 opcode - THIS IS AN IL CONSTANT"
        }
    }
}

# Also find 5.0 double (for TotalTimeout = FromMinutes(5))
""
$target5 = [BitConverter]::GetBytes([double]5.0)
"Searching for 5.0 double: $(($target5 | ForEach-Object { $_.ToString("X2") }) -join ' ')"
for ($i = 0; $i -lt $bytes.Length - 8; $i++) {
    $match = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$i + $j] -ne $target5[$j]) { $match = $false; break }
    }
    if ($match) {
        $start = [Math]::Max(0, $i - 4)
        $end = [Math]::Min($bytes.Length - 1, $i + 12)
        $ctx = ($bytes[$start..$end] | ForEach-Object { $_.ToString("X2") }) -join " "
        "Found 5.0 at offset $i (0x$($i.ToString('X4'))): ...$ctx..."
        if ($i -gt 0 -and $bytes[$i-1] -eq 0x23) {
            "  ^^^ Preceded by ldc.r8 opcode - THIS IS AN IL CONSTANT"
        }
    }
}

# Verify current MaxIterations patches
""
"MaxIterations @7696: 0x$($bytes[7696].ToString('X2')) (expected 0x1E = ldc.i4.8)"
"MaxIterations @8003: 0x$($bytes[8003].ToString('X2')) (expected 0x1E = ldc.i4.8)"
