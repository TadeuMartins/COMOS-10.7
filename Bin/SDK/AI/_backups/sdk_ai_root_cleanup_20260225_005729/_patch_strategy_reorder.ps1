## _patch_strategy_reorder.ps1
## Fixes ListObjectAttributes strategy order back to the old working pattern:
## Strategy 1 = AllDevices + DeviceMatchesTag (proven working)
## Strategy 2 = GetObjectBySystemUID
## Strategy 3 = SelectedObject (last resort)
## Writes directly to disk via [IO.File]::WriteAllLines - bypasses VS Code buffer.

$csPath = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\Comos.ServiceiPID.Agent.cs"
$lines = [IO.File]::ReadAllLines($csPath)
Write-Host "Read $($lines.Length) lines from disk"

# Verify the broken strategy is at the expected location (line 6171 = index 6170)
$marker = $lines[6170].Trim()
if (-not $marker.StartsWith("// Strategy 1 (BEST): SelectedObject")) {
    Write-Host "ERROR: Expected '// Strategy 1 (BEST): SelectedObject' at index 6170, got: $marker"
    Write-Host "Aborting - file structure doesn't match expected layout."
    exit 1
}
Write-Host "Marker verified at index 6170: $marker"

# Verify end of block (line 6261 = index 6260 should be closing brace of Strategy 3)
$endMarker = $lines[6260].Trim()
if ($endMarker -ne "}") {
    Write-Host "WARNING: Expected '}' at index 6260, got: $endMarker"
    # Try to find the actual end
    for ($i = 6255; $i -lt 6270; $i++) {
        Write-Host "  $($i+1): $($lines[$i])"
    }
}
Write-Host "End marker at index 6260: $endMarker"

# Verify what follows (line 6262 = index 6261 should be blank, 6263 = index 6262 should be if device==null)
$afterBlank = $lines[6261].Trim()
$afterCheck = $lines[6262].Trim()
Write-Host "After block: blank='$afterBlank', check='$afterCheck'"
if (-not $afterCheck.StartsWith("if ((object)device == null)")) {
    Write-Host "ERROR: Expected 'if ((object)device == null)' at index 6262, got: $afterCheck"
    exit 1
}

# Build the new strategy block (lines to replace indices 6170-6260)
$newBlock = @(
    '			// Strategy 1 (BEST): AllDevices + DeviceMatchesTag (proven working pattern from old DLL)'
    '			if ((object)device == null && !string.IsNullOrWhiteSpace(objectName) && currentProject != null)'
    '			{'
    '				try'
    '				{'
    '					dynamic allDevs = ((dynamic)currentProject).AllDevices();'
    '					if (allDevs != null)'
    '					{'
    '						int count = allDevs.Count;'
    '						int maxScan = (count < 10000) ? count : 10000;'
    '						for (int i = 1; i <= maxScan; i++)'
    '						{'
    '							try'
    '							{'
    '								dynamic dev = allDevs.Item(i);'
    '								if (dev != null && ImportAgent.DeviceMatchesTag(dev, objectName))'
    '								{'
    '									device = dev;'
    '									break;'
    '								}'
    '							}'
    '							catch { }'
    '						}'
    '					}'
    '				}'
    '				catch { }'
    '			}'
    ''
    '			// Strategy 2: GetObjectBySystemUID'
    '			if ((object)device == null && !string.IsNullOrWhiteSpace(systemUID) && currentProject != null)'
    '			{'
    '				try { device = ((dynamic)currentProject).GetObjectBySystemUID(systemUID); } catch { }'
    '			}'
    ''
    '			// Strategy 3: SelectedObject (last resort - CPLTWorksetClass may not expose it)'
    '			if ((object)device == null)'
    '			{'
    '				try'
    '				{'
    '					dynamic ws = Workset;'
    '					dynamic selObj = ws.SelectedObject;'
    '					if ((object)selObj != null) device = selObj;'
    '				}'
    '				catch { }'
    '			}'
)

# Build the new file: lines before + new block + lines after
$before = $lines[0..6169]         # Everything up to and including the blank line before strategies
$after  = $lines[6261..($lines.Length-1)]  # From the blank line after strategies onward

$newLines = $before + $newBlock + $after

Write-Host "Old line count: $($lines.Length)"
Write-Host "New line count: $($newLines.Length)"
Write-Host "Removed $(6261-6170) lines, added $($newBlock.Length) lines"

# Write to disk
[IO.File]::WriteAllLines($csPath, $newLines)
$newSize = (Get-Item $csPath).Length
Write-Host "Written to disk: $newSize bytes"

# Verify the fix
$verify = [IO.File]::ReadAllLines($csPath)
Write-Host "Verification - total lines: $($verify.Length)"

# Check that Strategy 1 is now AllDevices
$s1 = $verify[6170].Trim()
Write-Host "New Strategy 1 (index 6170): $s1"

# Check that Strategy 2 is GetObjectBySystemUID
for ($i = 6170; $i -lt 6220; $i++) {
    if ($verify[$i].Trim().StartsWith("// Strategy 2")) {
        Write-Host "New Strategy 2 (index $i): $($verify[$i].Trim())"
        break
    }
}

# Check that Strategy 3 is SelectedObject
for ($i = 6170; $i -lt 6220; $i++) {
    if ($verify[$i].Trim().StartsWith("// Strategy 3")) {
        Write-Host "New Strategy 3 (index $i): $($verify[$i].Trim())"
        break
    }
}

# Check that LoadObjectByType is GONE
$loadByType = Select-String -Path $csPath -Pattern "LoadObjectByType" -SimpleMatch
if ($loadByType) {
    Write-Host "WARNING: LoadObjectByType still found at: $($loadByType | ForEach-Object { $_.LineNumber })"
} else {
    Write-Host "OK: LoadObjectByType removed (not found anywhere)"
}

# Check that BuildTagCandidates is not called in ListObjectAttributes area
$btc = Select-String -Path $csPath -Pattern "BuildTagCandidates"
if ($btc) {
    $btcLines = $btc | ForEach-Object { $_.LineNumber }
    Write-Host "BuildTagCandidates found at lines: $($btcLines -join ', ')"
    # Check if any are in ListObjectAttributes range (6147-6460)
    $inRange = $btcLines | Where-Object { $_ -ge 6147 -and $_ -le 6460 }
    if ($inRange) {
        Write-Host "WARNING: BuildTagCandidates in ListObjectAttributes range at: $($inRange -join ', ')"
    } else {
        Write-Host "OK: BuildTagCandidates only in helper methods (outside ListObjectAttributes)"
    }
} else {
    Write-Host "BuildTagCandidates: not found anywhere"
}

Write-Host "`n=== PATCH COMPLETE ==="
