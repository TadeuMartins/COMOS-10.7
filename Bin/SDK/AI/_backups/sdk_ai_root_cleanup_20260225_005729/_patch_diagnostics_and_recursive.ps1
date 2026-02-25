## _patch_diagnostics_and_setattr_recursive.ps1
## Two fixes:
## 1. Add diagnostics to ListObjectAttributes to see WHY AllDevices fails
## 2. Make SetAttributeValue spec search recursive (not just 1-level isFolder gate)
## Writes directly to disk via [IO.File]::WriteAllLines

$csPath = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\Comos.ServiceiPID.Agent.cs"
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI\_backups"

# Backup
Copy-Item $csPath "$backupDir\Comos.ServiceiPID.Agent.cs.backup_${ts}_before_diag_recursive"
Write-Host "Backup: $ts"

$content = [IO.File]::ReadAllText($csPath, [Text.Encoding]::UTF8)
$origLen = $content.Length
Write-Host "Original length: $origLen chars"

# ═══════════════════════════════════════════════════════════════════
# FIX 1: Add diagnostics to ListObjectAttributes error message
# Replace the "Could not find the object" block with one that includes
# diagnostic info about what each strategy encountered.
# ═══════════════════════════════════════════════════════════════════

# The current strategies + error block (lines 6171-6237 on disk)
# We replace EVERYTHING from "// Strategy 1 (BEST): AllDevices" to the end of
# the "if ((object)device == null)" error return block.

$oldStrategiesAndError = @'
			// Strategy 1 (BEST): AllDevices + DeviceMatchesTag (proven working pattern from old DLL)
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

			// Strategy 2: GetObjectBySystemUID
			if ((object)device == null && !string.IsNullOrWhiteSpace(systemUID) && currentProject != null)
			{
				try { device = ((dynamic)currentProject).GetObjectBySystemUID(systemUID); } catch { }
			}

			// Strategy 3: SelectedObject (last resort - CPLTWorksetClass may not expose it)
			if ((object)device == null)
			{
				try
				{
					dynamic ws = Workset;
					dynamic selObj = ws.SelectedObject;
					if ((object)selObj != null) device = selObj;
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
'@

$newStrategiesAndError = @'
			// Diagnostic info for all strategies
			string stratDiag = "";

			// Strategy 1 (BEST): AllDevices + DeviceMatchesTag (proven working pattern from old DLL)
			if ((object)device == null && !string.IsNullOrWhiteSpace(objectName) && currentProject != null)
			{
				try
				{
					dynamic allDevs = ((dynamic)currentProject).AllDevices();
					if (allDevs != null)
					{
						int count = allDevs.Count;
						int maxScan = (count < 10000) ? count : 10000;
						stratDiag += $"S1:AllDevices(count={count},scan={maxScan})";
						string firstFewNames = "";
						for (int i = 1; i <= maxScan; i++)
						{
							try
							{
								dynamic dev = allDevs.Item(i);
								if (dev != null)
								{
									// Log first 5 device names for debugging
									if (i <= 5)
									{
										try { firstFewNames += (firstFewNames.Length > 0 ? "," : "") + (string)dev.Name; } catch { }
									}
									if (ImportAgent.DeviceMatchesTag(dev, objectName))
									{
										device = dev;
										stratDiag += "=MATCH";
										break;
									}
								}
							}
							catch { }
						}
						if ((object)device == null)
							stratDiag += $"=NOMATCH(first5=[{firstFewNames}])";
					}
					else
					{
						stratDiag += "S1:AllDevices=null";
					}
				}
				catch (Exception s1ex) { stratDiag += $"S1:ex({s1ex.Message})"; }
			}
			else
			{
				stratDiag += $"S1:SKIP(objName={!string.IsNullOrWhiteSpace(objectName)},proj={currentProject != null})";
			}

			// Strategy 2: GetObjectBySystemUID
			if ((object)device == null && !string.IsNullOrWhiteSpace(systemUID) && currentProject != null)
			{
				try
				{
					device = ((dynamic)currentProject).GetObjectBySystemUID(systemUID);
					if ((object)device != null) stratDiag += " S2:UID=FOUND";
					else stratDiag += " S2:UID=null";
				}
				catch (Exception s2ex) { stratDiag += $" S2:ex({s2ex.Message})"; }
			}
			else if ((object)device == null)
			{
				stratDiag += $" S2:SKIP(uid={!string.IsNullOrWhiteSpace(systemUID)},proj={currentProject != null})";
			}

			// Strategy 3: SelectedObject (last resort - CPLTWorksetClass may not expose it)
			if ((object)device == null)
			{
				try
				{
					dynamic ws = Workset;
					dynamic selObj = ws.SelectedObject;
					if ((object)selObj != null)
					{
						device = selObj;
						stratDiag += " S3:SelObj=FOUND";
					}
					else
					{
						stratDiag += " S3:SelObj=null";
					}
				}
				catch (Exception s3ex) { stratDiag += $" S3:ex({s3ex.Message})"; }
			}

			if ((object)device == null)
			{
				string tried = "";
				if (!string.IsNullOrWhiteSpace(objectName)) tried += $" objectName='{objectName}'";
				if (!string.IsNullOrWhiteSpace(systemUID)) tried += $" systemUID='{systemUID}'";
				return new
				{
					success = false,
					error = $"Could not find the object.{tried} [DIAG: {stratDiag}] Provide the object name/tag (e.g. objectName=\"M001\")."
				};
			}
'@

if ($content.Contains($oldStrategiesAndError)) {
    $content = $content.Replace($oldStrategiesAndError, $newStrategiesAndError)
    Write-Host "FIX 1 (ListObjectAttributes diagnostics): APPLIED"
} else {
    Write-Host "FIX 1: EXACT MATCH NOT FOUND - dumping markers..."
    # Try to find strategy 1 comment
    if ($content.Contains("// Strategy 1 (BEST): AllDevices + DeviceMatchesTag")) {
        Write-Host "  Strategy 1 comment: FOUND"
    } else {
        Write-Host "  Strategy 1 comment: NOT FOUND"
    }
    if ($content.Contains('error = $"Could not find the object.{tried} [{selObjDiag}]')) {
        Write-Host "  Error msg with selObjDiag: FOUND"
    } else {
        Write-Host "  Error msg with selObjDiag: NOT FOUND"
    }
}


# ═══════════════════════════════════════════════════════════════════
# FIX 2: Make SetAttributeValue spec search actually recursive
# Replace the flat isFolder-gated search with a true recursive 
# SearchSpecsRecursive helper call.
# ═══════════════════════════════════════════════════════════════════

# First, we need to add the SearchSpecsRecursive method.
# We'll add it right after CollectSpecsRecursive.

# Find where CollectSpecsRecursive ends — look for the closing of the class or
# the start of SetAttributeValue comment block.
$setAttrMarker = @'
	// ══════════════════════════════════════════════════════════════════════
	// SET / WRITE ATTRIBUTE VALUE
	// ══════════════════════════════════════════════════════════════════════
'@

$searchSpecsMethod = @'
	/// <summary>
	/// Recursively searches specs to find the best matching attribute by name/description.
	/// ALWAYS recurses into child specs regardless of IsFolder (same as CollectSpecsRecursive).
	/// </summary>
	private static void SearchSpecsRecursive(
		dynamic specs, string searchLower, string parentLabel, int depth, int maxDepth,
		ref dynamic bestMatch, ref string bestName, ref string bestDesc,
		ref string bestOldValue, ref string bestTabLabel, ref int bestScore)
	{
		if (depth > maxDepth || bestScore == 0) return;
		if ((object)specs == null) return;

		int count = 0;
		try { count = (int)specs.Count; } catch { return; }

		for (int i = 1; i <= count; i++)
		{
			if (bestScore == 0) break;

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

				// Score non-folder nodes as potential matches
				if (!isFolder)
				{
					int score = ScoreAttributeMatch(searchLower, sName, sDesc);
					if (score < bestScore)
					{
						bestScore = score;
						bestMatch = spec;
						bestName = sName;
						bestDesc = sDesc;
						bestTabLabel = string.IsNullOrWhiteSpace(parentLabel) ? "(top-level)" : parentLabel;
						try { bestOldValue = (string)spec.DisplayValue; } catch { bestOldValue = ""; }
						if (string.IsNullOrWhiteSpace(bestOldValue))
						{
							try { bestOldValue = (string)spec.value; } catch { }
						}
					}
				}

				// ALWAYS recurse into children (same pattern as CollectSpecsRecursive)
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
							SearchSpecsRecursive(childSpecs, searchLower, fullLabel, depth + 1, maxDepth,
								ref bestMatch, ref bestName, ref bestDesc, ref bestOldValue, ref bestTabLabel, ref bestScore);
						}
					}
				}
				catch { }
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
								SearchSpecsRecursive(childSpecs2, searchLower, fullLabel, depth + 1, maxDepth,
									ref bestMatch, ref bestName, ref bestDesc, ref bestOldValue, ref bestTabLabel, ref bestScore);
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

if ($content.Contains($setAttrMarker)) {
    $content = $content.Replace($setAttrMarker, $searchSpecsMethod + $setAttrMarker)
    Write-Host "FIX 2a (SearchSpecsRecursive method): INSERTED"
} else {
    Write-Host "FIX 2a: SET ATTR marker NOT FOUND"
}

# Now replace the flat inline search in SetAttributeValue with a call to SearchSpecsRecursive.
# The old flat search block (lines ~6541-6635):
$oldFlatSearch = @'
		try
			{
				dynamic specs = device.Specifications;
				if (specs == null)
				{
					return new
					{
						success = false,
						error = "Object has no specifications.",
						objectName = objName
					};
				}

				int topCount = (int)specs.Count;
				for (int t = 1; t <= topCount; t++)
				{
					try
					{
						dynamic topSpec = specs.Item(t);
						if ((object)topSpec == null) continue;

						string tabName = "";
						string tabDesc = "";
						try { tabName = (string)topSpec.Name; } catch { }
						try { tabDesc = (string)topSpec.Description; } catch { }
						string tabLabel = string.IsNullOrWhiteSpace(tabDesc) ? tabName : tabDesc;

						bool isFolder = false;
						try { isFolder = (bool)topSpec.IsFolder; } catch { }

						if (isFolder)
						{
							try
							{
								dynamic childSpecs = topSpec.Specs;
								if (childSpecs != null)
								{
									int childCount = (int)childSpecs.Count;
									for (int c = 1; c <= childCount; c++)
									{
										try
										{
										dynamic childSpec = childSpecs.Item(c);
										if ((object)childSpec == null) continue;

										string cName = "";
										string cDesc = "";
										try { cName = (string)childSpec.Name; } catch { }
										try { cDesc = (string)childSpec.Description; } catch { }

										int score = ScoreAttributeMatch(searchLower, cName, cDesc);
										if (score < bestScore)
										{
										bestScore = score;
										bestMatch = childSpec;
										bestName = cName;
										bestDesc = cDesc;
										bestTabLabel = tabLabel;
										try { bestOldValue = (string)childSpec.DisplayValue; } catch { }
										if (string.IsNullOrWhiteSpace(bestOldValue))
										{
										try { bestOldValue = (string)childSpec.value; } catch { }
										}
										}
										if (score == 0) break; // exact match
										}
										catch { }
									}
								}
							}
							catch { }
						}
						else
						{
							// Top-level attribute
							int score = ScoreAttributeMatch(searchLower, tabName, tabDesc);
							if (score < bestScore)
							{
								bestScore = score;
								bestMatch = topSpec;
								bestName = tabName;
								bestDesc = tabDesc;
								bestTabLabel = "(top-level)";
								try { bestOldValue = (string)topSpec.DisplayValue; } catch { }
								if (string.IsNullOrWhiteSpace(bestOldValue))
								{
									try { bestOldValue = (string)topSpec.value; } catch { }
								}
							}
						}
						if (bestScore == 0) break; // exact match found
					}
					catch { }
				}
			}
			catch (Exception ex)
			{
				return new
				{
					success = false,
					error = $"Error searching specifications: {ex.Message}",
					objectName = objName
				};
			}
'@

$newRecursiveSearch = @'
		try
			{
				dynamic specs = device.Specifications;
				if (specs == null)
				{
					return new
					{
						success = false,
						error = "Object has no specifications.",
						objectName = objName
					};
				}

				// Recursive search through specs (up to 10 levels, always recurse regardless of IsFolder)
				SearchSpecsRecursive(specs, searchLower, "", 0, 10,
					ref bestMatch, ref bestName, ref bestDesc, ref bestOldValue, ref bestTabLabel, ref bestScore);
			}
			catch (Exception ex)
			{
				return new
				{
					success = false,
					error = $"Error searching specifications: {ex.Message}",
					objectName = objName
				};
			}
'@

if ($content.Contains($oldFlatSearch)) {
    $content = $content.Replace($oldFlatSearch, $newRecursiveSearch)
    Write-Host "FIX 2b (SetAttributeValue recursive search): APPLIED"
} else {
    Write-Host "FIX 2b: EXACT MATCH NOT FOUND for flat search block"
    # Debug: check if the opening exists
    if ($content.Contains("int topCount = (int)specs.Count;")) {
        Write-Host "  topCount line: FOUND"
    } else {
        Write-Host "  topCount line: NOT FOUND"
    }
    if ($content.Contains("// Top-level attribute")) {
        Write-Host "  Top-level attribute comment: FOUND"
    } else {
        Write-Host "  Top-level attribute comment: NOT FOUND"
    }
}

# Also remove the specDump variable that's no longer needed (if it exists)
# and fix the error message to not reference specDump
$oldSpecDump = 'var specDump = new System.Collections.Generic.List<string>();'
if ($content.Contains($oldSpecDump)) {
    # The specDump was used in the threshold check - simplify it
    $content = $content.Replace($oldSpecDump, '// specDump removed — using recursive search now')
    Write-Host "Removed specDump declaration"
}

# Fix error return that references specDump
$oldSpecTreeLine = @'
				string specTree = string.Join("; ", specDump.Count > 40 ? specDump.GetRange(0, 40) : specDump);
'@
if ($content.Contains($oldSpecTreeLine)) {
    $content = $content.Replace($oldSpecTreeLine, '				string specTree = "(use list_object_attributes to see all)";')
    Write-Host "Replaced specDump usage in error return"
}

# Also remove specsFound from the return
$oldSpecsFound = @'
					closestMatch = (object)bestMatch != null ? $"{bestName} ({bestDesc}) [score={bestScore}]" : "none",
					specsFound = specTree
'@
$newClosestMatch = @'
					closestMatch = (object)bestMatch != null ? $"{bestName} ({bestDesc}) [score={bestScore}]" : "none"
'@
if ($content.Contains($oldSpecsFound)) {
    $content = $content.Replace($oldSpecsFound, $newClosestMatch)
    Write-Host "Removed specsFound from error return"
}

# Write to disk
[IO.File]::WriteAllText($csPath, $content, [Text.Encoding]::UTF8)
$newLen = (Get-Item $csPath).Length
Write-Host "`nWritten to disk: $newLen bytes (was $origLen chars)"

# Verify
$v = [IO.File]::ReadAllLines($csPath)
Write-Host "Total lines: $($v.Length)"

# Check markers
$markers = @(
    "DIAG: {stratDiag}",
    "S1:AllDevices(count=",
    "SearchSpecsRecursive(specs, searchLower",
    "// ALWAYS recurse into children (same pattern as CollectSpecsRecursive)",
    "AllDevices + DeviceMatchesTag (proven working"
)
foreach ($m in $markers) {
    if ($content.Contains($m)) {
        Write-Host "  [OK] $m"
    } else {
        Write-Host "  [MISSING] $m"
    }
}

Write-Host "`n=== PATCH COMPLETE ==="
