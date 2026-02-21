$dllPath = 'C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.DesktopCommunication.dll'
$outPath = 'C:\Program Files (x86)\COMOS\Team_AI\scripts\dll-strings.txt'

$bytes = [IO.File]::ReadAllBytes($dllPath)
$text = [Text.Encoding]::Unicode.GetString($bytes)

# Extract all strings of 4+ printable ASCII characters
$matches = [regex]::Matches($text, '[\x20-\x7E]{4,}')
$strings = $matches | ForEach-Object { $_.Value } | Sort-Object -Unique
$filtered = $strings | Where-Object { $_ -notmatch '^\s+$' -and $_ -notmatch '^[\.]+$' }

$filtered | Out-File -FilePath $outPath -Encoding utf8
Write-Host "Total strings found: $($filtered.Count)"
Write-Host "Output saved to: $outPath"
