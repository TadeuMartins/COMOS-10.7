$bytes = [IO.File]::ReadAllBytes("C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.Ai.Client.dll")
$target = [BitConverter]::GetBytes([double]30.0)
$count = 0
for ($i = 0; $i -lt $bytes.Length - 8; $i++) {
    $m = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$i + $j] -ne $target[$j]) { $m = $false; break }
    }
    if ($m) { 
        $count++
        $isIL = ($i -gt 0 -and $bytes[$i-1] -eq 0x23)
        Write-Host "30.0 at offset $i - ldc.r8: $isIL"
    }
}
Write-Host "Total 30.0 occurrences: $count"

# Also check the Hosting API DLL for timeout
$apiBytes = [IO.File]::ReadAllBytes("C:\Program Files (x86)\COMOS\Team_AI\ComosServices\Ai\Hosting\Comos.Services.Ai.Api.dll")
Write-Host ""
Write-Host "Hosting Comos.Services.Ai.Api.dll ($($apiBytes.Length) bytes):"
$count2 = 0
for ($i = 0; $i -lt $apiBytes.Length - 8; $i++) {
    $m = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($apiBytes[$i + $j] -ne $target[$j]) { $m = $false; break }
    }
    if ($m) {
        $count2++
        $isIL = ($i -gt 0 -and $apiBytes[$i-1] -eq 0x23)
        Write-Host "30.0 at offset $i - ldc.r8: $isIL"
    }
}
Write-Host "Total 30.0 in Api: $count2"
