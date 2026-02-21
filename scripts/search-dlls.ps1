Write-Output "--- START DLL STRING SEARCH ---"

$dlls = @(
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.ChatBotInDesktop.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.ChatControl.dll', 
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.HttpClient.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.Ai.Http.dll',
    'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.WPF.ExtendedControls.dll'
)

# Primary search terms
$primaryTerms = @('Oops', "couldn't connect", 'could not connect', 'AI service', 'connection failed', 'service error', 'error connecting')

# Secondary search terms
$secondaryTerms = @('ValidateConnection', 'InitializeAsync', 'error', 'failed')

Write-Output ""
Write-Output "========== PRIMARY SEARCH (error messages) =========="

foreach ($dll in $dlls) {
    $leaf = Split-Path $dll -Leaf
    if (Test-Path $dll) {
        Write-Output ""
        Write-Output "CHECKING: $leaf"
        $bytes = [IO.File]::ReadAllBytes($dll)
        $utf16text = [Text.Encoding]::Unicode.GetString($bytes)
        $utf8text = [Text.Encoding]::UTF8.GetString($bytes)
        $found = $false
        
        foreach ($term in $primaryTerms) {
            # UTF-16 search
            $idx = $utf16text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase)
            if ($idx -ge 0) {
                $found = $true
                Write-Output "  FOUND '$term' (UTF16) at index $idx"
                $start = [Math]::Max(0, $idx - 60)
                $len = [Math]::Min(300, $utf16text.Length - $start)
                $context = $utf16text.Substring($start, $len) -replace '[^\x20-\x7E]', '.'
                Write-Output "  Context: $context"
            }
            
            # UTF-8 search
            $idx8 = $utf8text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase)
            if ($idx8 -ge 0) {
                $found = $true
                Write-Output "  FOUND '$term' (UTF8) at index $idx8"
                $start = [Math]::Max(0, $idx8 - 60)
                $len = [Math]::Min(300, $utf8text.Length - $start)
                $context = $utf8text.Substring($start, $len) -replace '[^\x20-\x7E]', '.'
                Write-Output "  Context: $context"
            }
        }
        if (-not $found) {
            Write-Output "  (no primary matches)"
        }
    } else {
        Write-Output "NOT FOUND: $leaf"
    }
}

Write-Output ""
Write-Output "========== SECONDARY SEARCH (code identifiers) =========="

foreach ($dll in $dlls) {
    $leaf = Split-Path $dll -Leaf
    if (Test-Path $dll) {
        Write-Output ""
        Write-Output "CHECKING: $leaf"
        $bytes = [IO.File]::ReadAllBytes($dll)
        $utf8text = [Text.Encoding]::UTF8.GetString($bytes)
        $found = $false
        
        foreach ($term in $secondaryTerms) {
            $searchFrom = 0
            $matchCount = 0
            while ($searchFrom -lt $utf8text.Length -and $matchCount -lt 5) {
                $idx = $utf8text.IndexOf($term, $searchFrom, [StringComparison]::OrdinalIgnoreCase)
                if ($idx -lt 0) { break }
                $matchCount++
                $found = $true
                $start = [Math]::Max(0, $idx - 40)
                $len = [Math]::Min(200, $utf8text.Length - $start)
                $context = $utf8text.Substring($start, $len) -replace '[^\x20-\x7E]', '.'
                Write-Output "  MATCH '$term' #$matchCount (UTF8) idx=$idx"
                Write-Output "    $context"
                $searchFrom = $idx + $term.Length
            }
            if ($matchCount -ge 5) {
                # Count remaining
                $remaining = 0
                while ($searchFrom -lt $utf8text.Length) {
                    $idx = $utf8text.IndexOf($term, $searchFrom, [StringComparison]::OrdinalIgnoreCase)
                    if ($idx -lt 0) { break }
                    $remaining++
                    $searchFrom = $idx + $term.Length
                }
                if ($remaining -gt 0) {
                    Write-Output "  ... and $remaining more matches for '$term'"
                }
            }
        }
        if (-not $found) {
            Write-Output "  (no secondary matches)"
        }
    } else {
        Write-Output "MISSING: $leaf"
    }
}

Write-Output ""
Write-Output "=== ALL SEARCHES COMPLETE ==="
