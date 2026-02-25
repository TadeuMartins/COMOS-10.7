## _patch_setattr_recursive_linebased.ps1
## Replaces SetAttributeValue's flat 1-level spec search (lines 6662-6765) with
## a call to SearchSpecsRecursive. Uses line-based replacement to avoid whitespace mismatches.

$csPath = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\Comos.ServiceiPID.Agent.cs"
$lines = [IO.File]::ReadAllLines($csPath)
Write-Host "Total lines: $($lines.Length)"

# Verify boundaries
$line6662 = $lines[6661].Trim()  # Should be "try"
$line6665 = $lines[6664].Trim()  # Should be "if (specs == null)"
$line6675 = $lines[6674].Trim()  # Should be "int topCount = (int)specs.Count;"
$line6765 = $lines[6764].Trim()  # Should be "}"
$line6767 = $lines[6766].Trim()  # Should be "// Threshold..."

Write-Host "6662: '$line6662'"
Write-Host "6665: '$line6665'"
Write-Host "6675: '$line6675'"
Write-Host "6765: '$line6765'"
Write-Host "6767: '$line6767'"

if ($line6662 -ne "try" -or $line6675 -ne "int topCount = (int)specs.Count;" -or $line6767 -eq "") {
    Write-Host "ERROR: Boundaries don't match expected values. Aborting."
    exit 1
}
Write-Host "Boundaries verified."

# Build replacement block (lines 6662-6765 will be replaced)
$newBlock = @(
    "`t`t`ttry"
    "`t`t`t{"
    "`t`t`t`tdynamic specs = device.Specifications;"
    "`t`t`t`tif (specs == null)"
    "`t`t`t`t{"
    "`t`t`t`t`treturn new"
    "`t`t`t`t`t{"
    "`t`t`t`t`t`tsuccess = false,"
    "`t`t`t`t`t`terror = `"Object has no specifications.`","
    "`t`t`t`t`t`tobjectName = objName"
    "`t`t`t`t`t};"
    "`t`t`t`t}"
    ""
    "`t`t`t`t// Recursive search through specs (up to 10 levels, always recurse regardless of IsFolder)"
    "`t`t`t`tSearchSpecsRecursive(specs, searchLower, `"`", 0, 10,"
    "`t`t`t`t`tref bestMatch, ref bestName, ref bestDesc, ref bestOldValue, ref bestTabLabel, ref bestScore);"
    "`t`t`t}"
    "`t`t`tcatch (Exception ex)"
    "`t`t`t{"
    "`t`t`t`treturn new"
    "`t`t`t`t{"
    "`t`t`t`t`tsuccess = false,"
    "`t`t`t`t`terror = `$`"Error searching specifications: {ex.Message}`","
    "`t`t`t`t`tobjectName = objName"
    "`t`t`t`t};"
    "`t`t`t}"
)

# Build new file: before + newBlock + after
$before = $lines[0..6660]         # Lines 1-6661 (indices 0-6660)
$after  = $lines[6765..($lines.Length-1)]  # Line 6766+ (index 6765+)

$newLines = $before + $newBlock + $after

Write-Host "Old lines: $($lines.Length)"
Write-Host "New lines: $($newLines.Length)"
Write-Host "Removed: $(6765-6661) lines, added: $($newBlock.Length) lines"

[IO.File]::WriteAllLines($csPath, $newLines)
$newSize = (Get-Item $csPath).Length
Write-Host "Written: $newSize bytes"

# Verify
$v = [IO.File]::ReadAllLines($csPath)
Write-Host "Verification lines: $($v.Length)"

# Check that SearchSpecsRecursive call exists in SetAttributeValue area
$found = $false
for ($i = 6650; $i -lt 6700; $i++) {
    if ($v[$i] -match "SearchSpecsRecursive") {
        Write-Host "SearchSpecsRecursive call at line $($i+1): $($v[$i].Trim())"
        $found = $true
        break
    }
}
if (-not $found) { Write-Host "WARNING: SearchSpecsRecursive call NOT FOUND in expected range" }

# Check that topCount (old flat search) is gone
$topCountGone = $true
for ($i = 6650; $i -lt 6700; $i++) {
    if ($v[$i] -match "topCount") {
        Write-Host "WARNING: 'topCount' still present at line $($i+1)"
        $topCountGone = $false
    }
}
if ($topCountGone) { Write-Host "OK: 'topCount' removed from SetAttributeValue" }

Write-Host "`n=== LINE-BASED PATCH COMPLETE ==="
