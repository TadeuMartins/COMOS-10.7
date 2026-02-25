$bin = 'C:\Program Files (x86)\COMOS\Team_AI\Bin'
$out = @()

$api = [IO.File]::ReadAllBytes("$bin\Comos.Services.Ai.Api.dll")
$out += "Api.dll size: $($api.Length)"
$out += "TimeoutPerIteration @1762: $([BitConverter]::ToDouble($api,1762))"
$out += "TotalTimeout @1791: $([BitConverter]::ToDouble($api,1791))"

$cl = [IO.File]::ReadAllBytes("$bin\Comos.Ai.Client.dll")
$out += "Client.dll size: $($cl.Length)"
$out += "MaxIter @7696: 0x$($cl[7696].ToString('X2'))"
$out += "MaxIter @8003: 0x$($cl[8003].ToString('X2'))"

$out += "Api SHA256: $((Get-FileHash "$bin\Comos.Services.Ai.Api.dll" -Algorithm SHA256).Hash)"
$out += "Client SHA256: $((Get-FileHash "$bin\Comos.Ai.Client.dll" -Algorithm SHA256).Hash)"

$resultFile = "$bin\SDK\AI\_patch_verify.txt"
$out | Out-File -FilePath $resultFile -Encoding utf8
$out | ForEach-Object { Write-Host $_ }
Write-Host "`nAlso written to: $resultFile"
