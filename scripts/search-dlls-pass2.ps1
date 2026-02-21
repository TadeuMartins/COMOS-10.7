Write-Output "=== PASS 2: Deep search ==="

$dlls = @(
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.ChatBotInDesktop.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.ChatControl.dll', 
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.HttpClient.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.Ai.Http.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.WPF.ExtendedControls.dll'
)

# Search 1: case-sensitive "Oops" in UTF16
Write-Output ""
Write-Output "--- CASE-SENSITIVE 'Oops' search (UTF16) ---"
foreach ($dll in $dlls) {
    $leaf = Split-Path $dll -Leaf
    if (Test-Path $dll) {
        $bytes = [IO.File]::ReadAllBytes($dll)
        $u16 = [Text.Encoding]::Unicode.GetString($bytes)
        $idx = $u16.IndexOf('Oops', [StringComparison]::Ordinal)
        if ($idx -ge 0) {
            $s = [Math]::Max(0, $idx - 80)
            $l = [Math]::Min(400, $u16.Length - $s)
            $ctx = $u16.Substring($s, $l) -replace '[^\x20-\x7E]', '.'
            Write-Output "FOUND in $leaf at idx=$idx"
            Write-Output "  $ctx"
        } else {
            Write-Output "Not in $leaf"
        }
    }
}

# Search 2: "failed" in UTF16
Write-Output ""
Write-Output "--- 'failed' search (UTF16) ---"
foreach ($dll in $dlls) {
    $leaf = Split-Path $dll -Leaf
    if (Test-Path $dll) {
        $bytes = [IO.File]::ReadAllBytes($dll)
        $u16 = [Text.Encoding]::Unicode.GetString($bytes)
        $searchFrom = 0
        $count = 0
        while ($searchFrom -lt $u16.Length -and $count -lt 8) {
            $idx = $u16.IndexOf('failed', $searchFrom, [StringComparison]::OrdinalIgnoreCase)
            if ($idx -lt 0) { break }
            $count++
            $s = [Math]::Max(0, $idx - 60)
            $l = [Math]::Min(250, $u16.Length - $s)
            $ctx = $u16.Substring($s, $l) -replace '[^\x20-\x7E]', '.'
            Write-Output "  HIT #$count in $leaf idx=$idx"
            Write-Output "    $ctx"
            $searchFrom = $idx + 6
        }
        if ($count -eq 0) { Write-Output "  None in $leaf" }
    }
}

# Search 3: Full error message extraction from HttpClient and Ai.Http
Write-Output ""
Write-Output "--- Full message strings in HttpClient and Ai.Http (UTF16) ---"
foreach ($dllPath in @(
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.HttpClient.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.Ai.Http.dll'
)) {
    $leaf = Split-Path $dllPath -Leaf
    Write-Output ""
    Write-Output "== $leaf =="
    $bytes = [IO.File]::ReadAllBytes($dllPath)
    $u16 = [Text.Encoding]::Unicode.GetString($bytes)
    
    # Extract all readable strings around "AI Service"
    $searchFrom = 0
    while ($searchFrom -lt $u16.Length) {
        $idx = $u16.IndexOf('AI Service', $searchFrom, [StringComparison]::OrdinalIgnoreCase)
        if ($idx -lt 0) { break }
        $s = [Math]::Max(0, $idx - 20)
        $l = [Math]::Min(400, $u16.Length - $s)
        $ctx = $u16.Substring($s, $l) -replace '[^\x20-\x7E]', '.'
        Write-Output "  AI_SVC at idx=$idx"
        Write-Output "    $ctx"
        $searchFrom = $idx + 10
    }

    # Extract around "Error"
    $searchFrom = 0
    $ecount = 0
    while ($searchFrom -lt $u16.Length -and $ecount -lt 5) {
        $idx = $u16.IndexOf('Error', $searchFrom, [StringComparison]::OrdinalIgnoreCase)
        if ($idx -lt 0) { break }
        $ecount++
        $s = [Math]::Max(0, $idx - 30)
        $l = [Math]::Min(300, $u16.Length - $s)
        $ctx = $u16.Substring($s, $l) -replace '[^\x20-\x7E]', '.'
        Write-Output "  ERROR at idx=$idx"
        Write-Output "    $ctx"
        $searchFrom = $idx + 5
    }
}

# Search 4: Look for "Oops" in ALL Bin DLLs (broader search)
Write-Output ""
Write-Output "--- Broad 'Oops' case-sensitive search across ALL chatbot+AI DLLs ---"
$allDlls = Get-ChildItem "C:\Program Files (x86)\COMOS\Team_AI\Bin\*.dll" | Where-Object { 
    $_.Name -match 'Chat|Assistant|Ai\.Http|WPF|Engineering' 
}
foreach ($f in $allDlls) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $u16 = [Text.Encoding]::Unicode.GetString($bytes)
    $idx = $u16.IndexOf('Oops', [StringComparison]::Ordinal)
    if ($idx -ge 0) {
        $s = [Math]::Max(0, $idx - 80)
        $l = [Math]::Min(400, $u16.Length - $s)
        $ctx = $u16.Substring($s, $l) -replace '[^\x20-\x7E]', '.'
        Write-Output "FOUND 'Oops' in $($f.Name) at idx=$idx"
        Write-Output "  $ctx"
    }
}

# Also check the JS/HTML files in Web folder
Write-Output ""
Write-Output "--- Checking Web folder for 'Oops' ---"
$webFiles = Get-ChildItem "C:\Program Files (x86)\COMOS\Team_AI\Web" -Recurse -Include *.js,*.html,*.htm,*.json -ErrorAction SilentlyContinue
$webCount = 0
foreach ($f in $webFiles) {
    $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($content -match 'Oops') {
        $webCount++
        Write-Output "FOUND 'Oops' in $($f.FullName)"
        $idx = $content.IndexOf('Oops')
        $s = [Math]::Max(0, $idx - 80)
        $l = [Math]::Min(300, $content.Length - $s)
        Write-Output "  $($content.Substring($s, $l))"
    }
}
if ($webCount -eq 0) { Write-Output "  No 'Oops' in Web folder" }

Write-Output ""
Write-Output "=== PASS 2 COMPLETE ==="
