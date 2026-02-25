# COMOS AI Engineering Assistant — Copilot Instructions

## Architecture

4-layer system communicating via HTTP/REST. All custom; COMOS Desktop is native.

```
COMOS Desktop (.NET/C#) + CefSharp Chat UI
    ↓ fetch()
AI API Shim (Node.js :56401) — smart proxy, tool fabrication, voice, P&ID digitization
    ↓                ↓
C# AI API (:56400)   COMOS Gateway (Python/FastAPI :8100) — MCP tool loop
  (native)               ↓
                    ServiceiPID Backend (Python/FastAPI :8000) — P&ID analysis, OpenCV, GPT-5.x
```

**Service startup order:** Backend :8000 → Gateway :8100 → Shim :56401 → COMOS Desktop (starts :56400 automatically).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/ai-api-shim.js` | Main shim — proxy, intent detection, tool fabrication, voice recording |
| `Bin/SDK/AI/Comos.ServiceiPID.Agent.cs` | C# AI tool DLL source — import, draw, connect objects on diagrams |
| `Bin/SDK/AI/compile.bat` | Roslyn compilation command for the agent DLL |
| `Bin/SDK/AI/README_COMOS_AI_Tools.md` | Complete guide to building COMOS AI tools (MEF, Workset pattern, pitfalls) |
| `Bin/ThirdParty/TwoDcChat/speech-polyfill.js` | Voice input polyfill (MCI + Azure Whisper) |
| `Bin/ThirdParty/TwoDcChat/chat-app.js` | Chat widget config (voiceInput: true) |
| `Bin/Comos.EngineeringAssistant.BasicFunctions.dll` | IL-patched native DLL (navigation/attribute tools) |
| `ARCHITECTURE.md` | Full architecture documentation in Portuguese |

## C# Agent DLL Development (Critical Patterns)

**MEF Discovery:** COMOS scans `Bin/SDK/AI/*.dll` at startup. Only flat directory — no subdirectories.

**Workset pattern — MUST match exactly or tool silently fails:**
```csharp
private static IComosDWorkset _workset;
public static IComosDWorkset Workset
{
    private get { return _workset; }  // MUST be private get
    set { _workset = value; }
}
```

**ToolScope:** Never use `"comos"` (reserved). Use unique names like `"ServiceiPID"`.

**Return values:** Use anonymous types with simple fields. Arrays serialize as type names — always `string.Join("; ", list)` instead of `.ToArray()`.

**Timeout:** 30s per tool call (hardcoded `TimeoutPerIteration`). Batch Report.Open/Save/Close — never per-object.

**Compilation:** Target .NET Framework 4.x only. Use `compile.bat` in `Bin/SDK/AI/`. Output name MUST match the DLL name in `Bin/SDK/AI/` (e.g., `Comos.ServiceiPID.Agent.dll`). **Never** output as `Comos.EngineeringAssistant.BasicFunctions.dll` — that's the native patched DLL in `Bin/`.

**Deployment:** Close COMOS → replace DLL → restart COMOS. DLLs are locked while COMOS runs. Always backup before overwriting: `copy X.dll X.dll.locked_YYYYMMDD_HHMMSS`.

## Shim Conventions (`ai-api-shim.js`)

- Bilingual intent detection (PT-BR + EN): count queries, attribute lookups, navigation
- Tool calls fabricated without LLM via `buildFabricatedToolCallResponse()` — PascalCase format for COMOS .NET
- Budget counter: max 2 fabricated tool calls per message (3rd iteration reserved for text response)
- `systemUID` stripped from attribute tool calls to force reliable path (navigator-selected object)
- Fuzzy matching: Levenshtein distance ≤ 2 for attribute name typos
- 120ms delay between `onresult` and `onend` in speech polyfill (React 18 batching fix)

## DLL Versioning & Backups — CRITICAL RULES (NEVER VIOLATE)

### Golden Rule: .cs ↔ DLL Sync

The `.cs` source and the active `.dll` MUST always be in perfect sync. **NEVER**:
- Edit the `.cs` without recompiling and deploying the DLL
- Deploy a DLL without updating the `.cs` to match
- Decompile a DLL and overwrite the hand-written `.cs` with decompiled IL output
- Assume they match — always verify with compilation + hash comparison

**Verification command** (run after every change):
```powershell
$CSC = "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
$BIN = "C:\Program Files (x86)\COMOS\Team_AI\Bin"
$SDK = "$BIN\SDK\AI"
& $CSC /target:library /optimize+ /out:"$env:TEMP\verify.dll" /reference:"$BIN\Comos.Ai.Functions.dll" /reference:"$BIN\Comos.Ai.Contracts.dll" /reference:"$BIN\Interop.Plt.dll" /reference:"$BIN\Interop.ComosQSGlobalObj.dll" /reference:"$BIN\Interop.ComosVBInterface.dll" /reference:"$BIN\Comos.WSP.RoUtilities.dll" /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll" /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll" /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.IO.Compression\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.dll" /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.IO.Compression.FileSystem\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.FileSystem.dll" "$SDK\Comos.ServiceiPID.Agent.cs"
# Must compile with ZERO errors. Deploy the output — never an older DLL.
```

### Two Separate DLLs — Never Confuse

| DLL | Location | Content |
|-----|----------|---------|
| `Comos.EngineeringAssistant.BasicFunctions.dll` | `Bin/` | **Native** IL-patched (navigation, attribute, count tools) |
| `Comos.ServiceiPID.Agent.dll` | `Bin/SDK/AI/` | **Custom** compiled from `.cs` (import, draw, connect) |

### Backup Naming Convention — MANDATORY

**Before ANY DLL replacement**, create a backup with this exact format:
```
<original_name>.dll.locked_YYYYMMDD_HHMMSS_<description>
```
Examples:
- `Comos.ServiceiPID.Agent.dll.locked_20260222_100900_before_resync`
- `Comos.ServiceiPID.Agent.dll.locked_20260220_150500_before_template_add`
- `Comos.ServiceiPID.Agent.dll.locked_autoconnect` (known-good with working connections)

**Rules:**
1. **Always include date+time** in `YYYYMMDD_HHMMSS` format
2. **Always include a purpose/comment** after the timestamp (e.g., `before_savefix`, `before_template_add`)
3. **Never delete backups** — disk space is cheap, recovery is priceless
4. **The `locked_autoconnect` backup** is the known-good version with working connections — treat as sacred
5. **Store all backups in `Bin/SDK/AI/_backups/`** — never clutter the main `SDK/AI/` folder
6. **Backup the .cs too** when making significant changes: `Comos.ServiceiPID.Agent.cs.backup_YYYYMMDD_HHMMSS_<description>`

### Source Save + SDK Folder Hygiene — MANDATORY

1. **Always save `Comos.ServiceiPID.Agent.cs` before compile/deploy** (no deploy from unsaved editor buffer)
2. **Always keep backups in `Bin/SDK/AI/_backups/` only** (both `.dll` and significant `.cs` snapshots)
3. **Never leave temporary/non-project files in `Bin/SDK/AI/` root**
    - compile outputs, verify DLLs, IL dumps, logs, and scratch files must stay in `%TEMP%` or `_backups/`
    - keep `Bin/SDK/AI/` root clean with only project source/artifacts required by COMOS loading
4. **If a temporary file is created in `Bin/SDK/AI/` by mistake, remove it after use** and keep only the canonical active files

### Deployment Checklist (Follow Every Time)

1. ✅ Backup current DLL: `copy active.dll _backups/active.dll.locked_YYYYMMDD_HHMMSS_<reason>`
2. ✅ Edit `.cs` source (NEVER decompiled IL)
3. ✅ Compile with `/optimize+` — must produce ZERO errors
4. ✅ Deploy compiled DLL to replace active (kill AI API if locked)
5. ✅ Verify hash: `certutil -hashfile <deployed.dll> SHA256` must match compiled output
6. ✅ Restart COMOS/AI API to load new DLL
7. ✅ Test functionality before considering done

## Temp Files

| Path | Purpose |
|------|---------|
| `%TEMP%/comos_ai_shim/ai_api_shim.log` | Shim HTTP traffic log |
| `%TEMP%/comos_ai_shim/requests.jsonl` | Raw request/response log |
| `%TEMP%/comos_ai_shim/completed_analyses.json` | P&ID analysis state |
| `%TEMP%/comos_ai_api-YYYYMMDD.log` | C# AI API log (locked while COMOS runs) |
| `%TEMP%/comos_ai_exports/` | Generated Excel/analysis files |

## Health Checks

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health     # Backend
Invoke-RestMethod http://127.0.0.1:8100/health     # Gateway
Invoke-RestMethod http://127.0.0.1:56401/api/ai/v1/shim-status  # Shim
netstat -ano | Select-String ":8000|:8100|:56400|:56401" | Select-String "LISTEN"
```

## Common Pitfalls

1. **Duplicate DLLs in `SDK/AI/`** — MEF loads ALL `.dll` files; two DLLs exporting the same class = silent conflict
2. **Compiling to wrong output name** — `compile.bat` output MUST be `Comos.ServiceiPID.Agent.dll`, not `Comos.EngineeringAssistant.BasicFunctions.dll`
3. **Public getter on Workset** — tool loads via MEF but never registers in FunctionRegistry
4. **Array return values** — use `string.Join()`, never `.ToArray()` in anonymous return types
5. **30s timeout** — batch all Report operations; cache COM objects and CDevice lookups
6. **COMOS max 3 iterations** — shim budget counter prevents infinite re-fabrication loops
7. **NEVER overwrite .cs with decompiled IL** — decompilers produce non-compilable output (variable name collisions, missing scopes). The hand-written `.cs` is the SINGLE SOURCE OF TRUTH. Edit the `.cs`, compile, deploy — never reverse the flow.
8. **NEVER deploy a DLL without backing up first** — use `_backups/` folder with `YYYYMMDD_HHMMSS_<description>` naming. No exceptions.
9. **NEVER assume .cs and DLL are in sync** — always verify by compiling .cs and comparing output hash with active DLL hash. If they differ, the .cs is the authority — recompile and redeploy.
