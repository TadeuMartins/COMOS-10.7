# Decompile ValueOfAttributeWithNameOrDescription IL to understand systemUID usage
$asm = [System.Reflection.Assembly]::LoadFrom("C:\Program Files (x86)\COMOS\Team_AI\Bin\Comos.EngineeringAssistant.BasicFunctions.dll")
$type = $asm.GetType("Comos.EngineeringAssistant.BasicFunctions.ComosChatFunctions")
$m = $type.GetMethod("ValueOfAttributeWithNameOrDescription")

$body = $m.GetMethodBody()
$il = $body.GetILAsByteArray()

Write-Output "=== ValueOfAttributeWithNameOrDescription ==="
Write-Output "IL Size: $($il.Length) bytes"
Write-Output "Local vars: $($body.LocalVariables.Count)"
foreach ($v in $body.LocalVariables) {
    Write-Output "  [$($v.LocalIndex)] $($v.LocalType.FullName)"
}

# Resolve method tokens to names
$mod = $type.Module
Write-Output ""
Write-Output "=== Method calls (callvirt/call opcodes) ==="
for ($i = 0; $i -lt $il.Length; $i++) {
    $op = $il[$i]
    # 0x6F = callvirt, 0x28 = call
    if ($op -eq 0x6F -or $op -eq 0x28) {
        if (($i + 4) -lt $il.Length) {
            $token = [BitConverter]::ToInt32($il, $i + 1)
            try {
                $calledMethod = $mod.ResolveMethod($token)
                $opName = if ($op -eq 0x6F) { "callvirt" } else { "call" }
                Write-Output "  IL_$('{0:X4}' -f $i): $opName $($calledMethod.DeclaringType.Name)::$($calledMethod.Name)"
            } catch {
                Write-Output "  IL_$('{0:X4}' -f $i): opcode=0x$('{0:X2}' -f $op) token=0x$('{0:X8}' -f $token) (unresolvable)"
            }
            $i += 4
        }
    }
    # 0xFE prefix for 2-byte opcodes
    elseif ($op -eq 0xFE -and ($i + 1) -lt $il.Length) {
        $i += 1
    }
    # 0x72 = ldstr
    elseif ($op -eq 0x72) {
        if (($i + 4) -lt $il.Length) {
            $strToken = [BitConverter]::ToInt32($il, $i + 1)
            try {
                $str = $mod.ResolveString($strToken)
                Write-Output "  IL_$('{0:X4}' -f $i): ldstr `"$str`""
            } catch {}
            $i += 4
        }
    }
}

# Also dump the NavigateToAttributeByNameOrDescription for comparison
Write-Output ""
Write-Output "=== NavigateToAttributeByNameOrDescription ==="
$m2 = $type.GetMethod("NavigateToAttributeByNameOrDescription")
if ($m2) {
    $body2 = $m2.GetMethodBody()
    $il2 = $body2.GetILAsByteArray()
    Write-Output "IL Size: $($il2.Length) bytes"
    
    for ($i = 0; $i -lt $il2.Length; $i++) {
        $op = $il2[$i]
        if ($op -eq 0x6F -or $op -eq 0x28) {
            if (($i + 4) -lt $il2.Length) {
                $token = [BitConverter]::ToInt32($il2, $i + 1)
                try {
                    $calledMethod = $mod.ResolveMethod($token)
                    $opName = if ($op -eq 0x6F) { "callvirt" } else { "call" }
                    Write-Output "  IL_$('{0:X4}' -f $i): $opName $($calledMethod.DeclaringType.Name)::$($calledMethod.Name)"
                } catch {}
                $i += 4
            }
        }
        elseif ($op -eq 0x72) {
            if (($i + 4) -lt $il2.Length) {
                $strToken = [BitConverter]::ToInt32($il2, $i + 1)
                try {
                    $str = $mod.ResolveString($strToken)
                    Write-Output "  IL_$('{0:X4}' -f $i): ldstr `"$str`""
                } catch {}
                $i += 4
            }
        }
        elseif ($op -eq 0xFE -and ($i + 1) -lt $il2.Length) { $i += 1 }
    }
}
