$bin = 'C:\Program Files (x86)\COMOS\Team_AI\Bin'
$backups = "$bin\SDK\AI\_backups"
$dllPath = "$bin\Comos.Ai.Client.dll"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# Backup first
$backupName = "Comos.Ai.Client.dll.locked_${timestamp}_before_timeout_patch"
Copy-Item $dllPath "$backups\$backupName" -Force
"Backup: $backupName"

$bytes = [IO.File]::ReadAllBytes($dllPath)
$old30 = [BitConverter]::GetBytes([double]30.0)
$new100 = [BitConverter]::GetBytes([double]100.0)

# Patch TimeoutPerIteration: 30.0 → 100.0 at offsets 7677 and 8018
foreach ($offset in @(7677, 8018)) {
    # Verify it's still 30.0
    $current = [BitConverter]::ToDouble($bytes, $offset)
    if ($current -ne 30.0) {
        "ERROR: Offset $offset has value $current, expected 30.0. Aborting!"
        exit 1
    }
    # Verify preceded by ldc.r8 (0x23)
    if ($bytes[$offset - 1] -ne 0x23) {
        "ERROR: Offset $offset not preceded by ldc.r8 (0x23). Got 0x$($bytes[$offset-1].ToString('X2')). Aborting!"
        exit 1
    }
    
    [Array]::Copy($new100, 0, $bytes, $offset, 8)
    "Patched offset ${offset}: 30.0 -> 100.0 (TimeoutPerIteration)"
}

# Patch TotalTimeout: 5.0 minutes → 20.0 minutes at offset 8038
$offset = 8038
$current = [BitConverter]::ToDouble($bytes, $offset)
if ($current -ne 5.0) {
    "ERROR: Offset $offset has value $current, expected 5.0. Aborting!"
    exit 1
}
if ($bytes[$offset - 1] -ne 0x23) {
    "ERROR: Offset $offset not preceded by ldc.r8 (0x23). Got 0x$($bytes[$offset-1].ToString('X2')). Aborting!"
    exit 1
}
$new20 = [BitConverter]::GetBytes([double]20.0)
[Array]::Copy($new20, 0, $bytes, $offset, 8)
"Patched offset ${offset}: 5.0 -> 20.0 (TotalTimeout in minutes)"

# Write patched DLL
[IO.File]::WriteAllBytes($dllPath, $bytes)

# Verify
$verify = [IO.File]::ReadAllBytes($dllPath)
""
"=== Verification ==="
"TimeoutPerIteration @7677: $([BitConverter]::ToDouble($verify, 7677))s (target: 100)"
"TimeoutPerIteration @8018: $([BitConverter]::ToDouble($verify, 8018))s (target: 100)"
"TotalTimeout @8038: $([BitConverter]::ToDouble($verify, 8038)) min (target: 20)"
"MaxIterations @7696: 0x$($verify[7696].ToString('X2')) (target: 0x1E = 8)"
"MaxIterations @8003: 0x$($verify[8003].ToString('X2')) (target: 0x1E = 8)"
"SHA256: $((Get-FileHash $dllPath -Algorithm SHA256).Hash)"
""
"SUCCESS: Comos.Ai.Client.dll patched. Restart COMOS to apply."
