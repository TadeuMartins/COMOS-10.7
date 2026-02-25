###############################################################################
# Patch: Replace ListObjectAttributes method (lines 6147-6373) + add
#        CollectSpecsRecursive helper after it.
# 
# This script reads the .cs from disk, replaces the old method, writes back.
# Run from PowerShell directly — does NOT rely on VS Code.
###############################################################################

$csPath = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\Comos.ServiceiPID.Agent.cs"

# ─── Safety: backup first ───────────────────────────────────────────────
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\_backups"
Copy-Item $csPath "$backupDir\Comos.ServiceiPID.Agent.cs.backup_${ts}_before_patch_reapply"
Write-Host "Backed up .cs to _backups (timestamp $ts)"

# ─── Read ALL lines ─────────────────────────────────────────────────────
$lines = [System.IO.File]::ReadAllLines($csPath)
$totalLines = $lines.Length
Write-Host "Read $totalLines lines from disk"

# ─── Find the method boundaries ─────────────────────────────────────────
# Line 6147 (index 6146) should start with [AiFunction("list_object_attributes"
# Line 6373 (index 6372) should be the closing "}" of the method

$startIdx = -1
$endIdx = -1

for ($i = 6140; $i -lt [Math]::Min(6160, $totalLines); $i++) {
    if ($lines[$i] -match 'AiFunction\("list_object_attributes"') {
        $startIdx = $i
        Write-Host "Found method start at line $($i+1): $($lines[$i].Trim().Substring(0, [Math]::Min(60, $lines[$i].Trim().Length)))"
        break
    }
}

if ($startIdx -lt 0) {
    Write-Error "Could not find list_object_attributes method start!"
    exit 1
}

# Find the method end — look for the closing brace followed by set_attribute_value
for ($i = $startIdx + 50; $i -lt [Math]::Min($startIdx + 300, $totalLines); $i++) {
    if ($lines[$i] -match 'SET / WRITE ATTRIBUTE VALUE' -or $lines[$i] -match 'AiFunction\("set_attribute_value"') {
        # Go back to find the comment separator line or blank lines before it
        $endIdx = $i - 1
        while ($endIdx -gt $startIdx -and $lines[$endIdx].Trim() -eq '') { $endIdx-- }
        # endIdx should now be on "// ═══..." or end of method "}"
        # Make sure we include up to the closing brace
        while ($endIdx -gt $startIdx -and $lines[$endIdx].Trim() -notmatch '^\}$' -and $lines[$endIdx].Trim() -notmatch '^// ') { $endIdx-- }
        if ($lines[$endIdx].Trim() -match '^//') { $endIdx-- }
        while ($endIdx -gt $startIdx -and $lines[$endIdx].Trim() -eq '') { $endIdx-- }
        Write-Host "Found method end at line $($endIdx+1): $($lines[$endIdx].Trim())"
        break
    }
}

if ($endIdx -lt 0) {
    Write-Error "Could not find list_object_attributes method end!"
    exit 1
}

Write-Host "Replacing lines $($startIdx+1) to $($endIdx+1) ($(($endIdx - $startIdx + 1)) lines)"

# ─── The NEW method (with all improvements) ─────────────────────────────

$newMethod = @'
	[AiFunction("list_object_attributes",
		"Lists ALL filled specification attributes of a COMOS object, including Name, Description, Value, SpecValue and SpecUnit. " +
		"Recursively searches up to 10 spec levels (same depth as set_attribute_value). " +
		"Only returns attributes that have at least one non-blank value. " +
		"Use when the user asks to see/list attributes, or when an attribute was not found.")]
	public object ListObjectAttributes(
		[DescribeParameter("Optional: SystemUID of the COMOS object.", ExampleValue = "")] string systemUID,
		[DescribeParameter("Optional: Name/tag of the COMOS object (e.g. M001, PC001). Preferred way to identify the object.", ExampleValue = "")] string objectName)
	{
		if (Workset == null)
		{
			return new
			{
				success = false,
				error = "Workset not available. COMOS must be running with an open project."
			};
		}

		try
		{
			dynamic device = null;
			IComosDProject currentProject = null;
			try { currentProject = Workset.GetCurrentProject(); } catch { }

			// Strategy 1 (BEST): SelectedObject — the shim ALWAYS fabricates a
			// navigate_to_comos_object call before list_object_attributes, so the
			// navigator already points to the correct object.  Trust it
			// unconditionally (same as set_attribute_value with systemUID).
			// DeviceMatchesTag is NOT reliable here because the shim may pass
			// objectName="PC001" while the COMOS Name is "=A10+PC001".
			if ((object)device == null)
			{
				try
				{
					dynamic ws = Workset;
					dynamic selObj = ws.SelectedObject;
					if ((object)selObj != null)
					{
						device = selObj;
					}
				}
				catch { }
			}

			// Strategy 2: LoadObjectByType with NAME (NOT SystemUID — LoadObjectByType
			// expects an object Name/Label like "PC001" or "=A10+PC001", not an UID).
			if ((object)device == null && !string.IsNullOrWhiteSpace(objectName))
			{
				int[] deviceTypes = new[] { 8, 1, 29, 2, 3, 4, 5, 6, 7, 9, 10 };
				var candidates = ImportAgent.BuildTagCandidates(objectName);
				foreach (string cand in candidates)
				{
					if ((object)device != null) break;
					foreach (int dt in deviceTypes)
					{
						try
						{
							object loaded = Workset.LoadObjectByType(dt, cand);
							if (loaded != null) { device = (dynamic)loaded; break; }
						}
						catch { }
					}
				}
				// Also try LoadObject (dynamic) with each candidate
				if ((object)device == null)
				{
					foreach (string cand in candidates)
					{
						if ((object)device != null) break;
						foreach (int dt in deviceTypes)
						{
							try
							{
								object loaded = ((dynamic)Workset).LoadObject(dt.ToString(), cand);
								if (loaded != null) { device = (dynamic)loaded; break; }
							}
							catch { }
						}
					}
				}
			}

			// Strategy 2b: GetObjectBySystemUID (only method that takes a SystemUID)
			if ((object)device == null && !string.IsNullOrWhiteSpace(systemUID) && currentProject != null)
			{
				try { device = ((dynamic)currentProject).GetObjectBySystemUID(systemUID); } catch { }
			}

			// Strategy 3: Find by objectName via AllDevices scan (slowest)
			if ((object)device == null && !string.IsNullOrWhiteSpace(objectName) && currentProject != null)
			{
				try
				{
					dynamic allDevs = ((dynamic)currentProject).AllDevices();
					if (allDevs != null)
					{
						int count = allDevs.Count;
						int maxScan = (count < 10000) ? count : 10000;
						for (int i = 1; i <= maxScan; i++)
						{
							try
							{
								dynamic dev = allDevs.Item(i);
								if (dev != null && ImportAgent.DeviceMatchesTag(dev, objectName))
								{
									device = dev;
									break;
								}
							}
							catch { }
						}
					}
				}
				catch { }
			}

			if ((object)device == null)
			{
				string tried = "";
				if (!string.IsNullOrWhiteSpace(objectName)) tried += $" objectName='{objectName}'";
				if (!string.IsNullOrWhiteSpace(systemUID)) tried += $" systemUID='{systemUID}'";
				// Diagnostic: capture SelectedObject status for debugging
				string selObjDiag = "SelObj=?";
				try
				{
					dynamic _ws = Workset;
					dynamic _so = _ws.SelectedObject;
					if ((object)_so == null) selObjDiag = "SelObj=null";
					else
					{
						try { selObjDiag = $"SelObj={_so.Name}"; }
						catch { selObjDiag = "SelObj=non-null(Name unreadable)"; }
					}
				}
				catch (Exception _ex) { selObjDiag = $"SelObj=error({_ex.Message})"; }
				return new
				{
					success = false,
					error = $"Could not find the object.{tried} [{selObjDiag}] Provide the object name/tag (e.g. objectName=\"M001\")."
				};
			}

			string objName = "";
			string objLabel = "";
			string objUID = "";
			try { objName = (string)device.Name; } catch { }
			try { objLabel = (string)device.Label; } catch { }
			try { objUID = (string)device.SystemUID; } catch { }

			// Enumerate specifications recursively (same depth as set_attribute_value)
			var results = new List<string>();
			int totalAttrs = 0;
			const int MAX_ATTRS = 500;  // Only filled attributes now, so count is much lower
			const int MAX_DEPTH = 10;

			try
			{
				dynamic specs = device.Specifications;
				if (specs == null)
				{
					return new
					{
						success = true,
						objectName = objName,
						objectLabel = objLabel,
						systemUID = objUID,
						message = "Object has no specifications.",
						attributes = ""
					};
				}

				CollectSpecsRecursive(specs, "", 0, MAX_DEPTH, results, ref totalAttrs, MAX_ATTRS);
			}
			catch (Exception ex)
			{
				return new
				{
					success = false,
					error = $"Error enumerating specifications: {ex.Message}",
					objectName = objName,
					objectLabel = objLabel
				};
			}

			string allAttributes = string.Join("; ", results);
			return new
			{
				success = true,
				objectName = objName,
				objectLabel = objLabel,
				systemUID = objUID,
				attributeCount = totalAttrs,
				filledOnly = true,
				truncated = totalAttrs >= MAX_ATTRS,
				attributes = allAttributes
			};
		}
		catch (Exception ex)
		{
			return new
			{
				success = false,
				error = $"Unexpected error: {ex.Message}"
			};
		}
	}

	/// <summary>
	/// Recursively collects filled spec attributes with Name, Description, Value, SpecValue and SpecUnit.
	/// Uses the same traversal pattern as SearchSpecsRecursive (tries .Specs then .Specifications).
	/// Only includes attributes where at least one value field is non-blank.
	/// </summary>
	private static void CollectSpecsRecursive(
		dynamic specs, string parentLabel, int depth, int maxDepth,
		List<string> results, ref int totalAttrs, int maxAttrs)
	{
		if (depth > maxDepth || totalAttrs >= maxAttrs) return;
		if ((object)specs == null) return;

		int count = 0;
		try { count = (int)specs.Count; } catch { return; }

		for (int i = 1; i <= count && totalAttrs < maxAttrs; i++)
		{
			try
			{
				dynamic spec = specs.Item(i);
				if ((object)spec == null) continue;

				string sName = "";
				string sDesc = "";
				try { sName = (string)spec.Name; } catch { }
				try { sDesc = (string)spec.Description; } catch { }
				string sLabel = string.IsNullOrWhiteSpace(sDesc) ? sName : sDesc;
				string fullLabel = string.IsNullOrWhiteSpace(parentLabel) ? sLabel : parentLabel + " > " + sLabel;

				bool isFolder = false;
				try { isFolder = (bool)spec.IsFolder; } catch { }

				// Collect this node as an attribute if it's NOT a folder
				if (!isFolder)
				{
					string displayValue = "";
					string specValue = "";
					string specUnit = "";
					try { displayValue = (string)spec.DisplayValue; } catch { }
					if (string.IsNullOrWhiteSpace(displayValue))
					{
						try { displayValue = (string)spec.value; } catch { }
					}
					try { specValue = Convert.ToString(((dynamic)spec).SpecValue); } catch { }
					try { specUnit = (string)spec.Unit; } catch { }
					if (string.IsNullOrWhiteSpace(specUnit))
					{
						try { specUnit = (string)((dynamic)spec).SpecUnit; } catch { }
					}

					// Only include attributes that have at least one filled value
					bool hasAnyValue = !string.IsNullOrWhiteSpace(displayValue)
						|| !string.IsNullOrWhiteSpace(specValue);
					if (!hasAnyValue) continue; // skip blank attributes

					// Build attribute entry: [Tab > SubTab] Name (Description) = Value | SV=specValue U=unit
					string entry = $"[{(string.IsNullOrWhiteSpace(parentLabel) ? "(root)" : parentLabel)}] ";
					entry += string.IsNullOrWhiteSpace(sDesc) ? sName : $"{sName} ({sDesc})";
					if (!string.IsNullOrWhiteSpace(displayValue))
						entry += $" = {displayValue}";
					// Append SpecValue if different from DisplayValue
					if (!string.IsNullOrWhiteSpace(specValue) && specValue != displayValue)
						entry += $" | SV={specValue}";
					if (!string.IsNullOrWhiteSpace(specUnit))
						entry += $" | U={specUnit}";

					results.Add(entry);
					totalAttrs++;
				}

				// ALWAYS recurse into children — same as SearchSpecsRecursive:
				// some COMOS spec nodes have sub-specs even when IsFolder is false.
				bool recursed = false;
				try
				{
					dynamic childSpecs = spec.Specs;
					if ((object)childSpecs != null)
					{
						int childCount = 0;
						try { childCount = (int)childSpecs.Count; } catch { }
						if (childCount > 0)
						{
							recursed = true;
							CollectSpecsRecursive(childSpecs, fullLabel, depth + 1, maxDepth,
								results, ref totalAttrs, maxAttrs);
						}
					}
				}
				catch { }
				// Fallback: try .Specifications
				if (!recursed)
				{
					try
					{
						dynamic childSpecs2 = spec.Specifications;
						if ((object)childSpecs2 != null)
						{
							int childCount2 = 0;
							try { childCount2 = (int)childSpecs2.Count; } catch { }
							if (childCount2 > 0)
							{
								CollectSpecsRecursive(childSpecs2, fullLabel, depth + 1, maxDepth,
									results, ref totalAttrs, maxAttrs);
							}
						}
					}
					catch { }
				}
			}
			catch { }
		}
	}
'@

# ─── Build new file content ─────────────────────────────────────────────
$before = $lines[0..($startIdx - 1)]
$after  = $lines[($endIdx + 1)..($totalLines - 1)]
$newMethodLines = $newMethod -split "`n" | ForEach-Object { $_.TrimEnd("`r") }

$newContent = @()
$newContent += $before
$newContent += $newMethodLines
$newContent += $after

# ─── Write to disk ──────────────────────────────────────────────────────
[System.IO.File]::WriteAllLines($csPath, $newContent)
$newFile = Get-Item $csPath
Write-Host "SUCCESS: Written $($newContent.Length) lines ($($newFile.Length) bytes) to $csPath"
Write-Host "LastWriteTime: $($newFile.LastWriteTime)"

# ─── Verify key markers are present ─────────────────────────────────────
$verify = [System.IO.File]::ReadAllText($csPath)
$checks = @("hasAnyValue", "selObjDiag", "CollectSpecsRecursive", "filledOnly = true", "MAX_ATTRS = 500", "SelObj=null")
foreach ($c in $checks) {
    if ($verify.Contains($c)) { Write-Host "  OK: '$c' found" }
    else { Write-Host "  MISSING: '$c' NOT FOUND!" -ForegroundColor Red }
}
