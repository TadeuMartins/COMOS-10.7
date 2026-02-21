# Building Custom AI Tools for COMOS Engineering Assistant

> **Author:** Generated from reverse-engineering of the COMOS AI Tool framework  
> **Version:** COMOS 10.4.x with Engineering Assistant (ChatControl)  
> **Last updated:** February 2026

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [How Tool Discovery Works (MEF)](#2-how-tool-discovery-works-mef)
3. [Required Interfaces and Attributes](#3-required-interfaces-and-attributes)
4. [Step-by-Step: Creating a New Tool](#4-step-by-step-creating-a-new-tool)
5. [The Workset Pattern (Critical)](#5-the-workset-pattern-critical)
6. [Defining AI Functions](#6-defining-ai-functions)
7. [Working with COMOS APIs](#7-working-with-comos-apis)
8. [Drawing Objects on Diagrams](#8-drawing-objects-on-diagrams)
9. [Compilation and Deployment](#9-compilation-and-deployment)
10. [Timeout and Performance Constraints](#10-timeout-and-performance-constraints)
11. [Return Value Serialization](#11-return-value-serialization)
12. [Debugging and Diagnostics](#12-debugging-and-diagnostics)
13. [Complete Minimal Example](#13-complete-minimal-example)
14. [Complete Real-World Example](#14-complete-real-world-example)
15. [Known Pitfalls](#15-known-pitfalls)

---

## 1. Architecture Overview

The COMOS Engineering Assistant uses a plugin architecture to discover and register AI tools:

```
┌──────────────────────────────────────────────────────┐
│  COMOS Desktop (Comos.exe)                           │
│                                                      │
│  ┌─────────────────────────────────┐                 │
│  │ ChatControl (UI Panel)          │                 │
│  │  └─ DesktopCommunication.dll    │                 │
│  │      └─ ComosAiClient           │                 │
│  │          └─ FunctionRegistry    │                 │
│  │              ├─ Built-in tools  │                 │
│  │              └─ MEF plugins ◄───┼── SDK\AI\*.dll  │
│  └─────────────────────────────────┘                 │
│                          │                           │
│                          ▼                           │
│               AI Service API (:56400)                │
│                          │                           │
│                          ▼                           │
│                    LLM Backend                       │
└──────────────────────────────────────────────────────┘
```

**Key assemblies:**

| Assembly | Role |
|----------|------|
| `Comos.EngineeringAssistant.ChatControl.dll` | UI panel, orchestrates chat |
| `Comos.EngineeringAssistant.DesktopCommunication.dll` | Builds `ComosAiClient`, loads plugins |
| `Comos.Ai.Client.dll` | HTTP client, tool processing loop, timeout management |
| `Comos.Ai.Functions.dll` | Defines `AIComosTool`, `[AiFunction]`, `[DescribeParameter]` |
| `Comos.Ai.Contracts.dll` | Shared contracts/interfaces |

---

## 2. How Tool Discovery Works (MEF)

COMOS uses **MEF (Managed Extensibility Framework)** to discover tools at startup:

1. **`DesktopCommunication.dll`** creates a `DirectoryCatalog` pointing to `Bin\SDK\AI\`
2. It scans all `.dll` files in that folder for classes with `[Export(typeof(AIComosTool))]`
3. It calls `ComposeParts()` to instantiate all exported tools
4. Each tool's `[AiFunction]` methods are registered into the `FunctionRegistry`
5. The LLM receives the tool definitions as available functions

```
Bin\
  SDK\
    AI\
      YourTool.dll          ◄── Place your compiled DLL here
      YourTool.cs           ◄── Source (optional, for reference)
      Comos.Query.Agent.dll     (built-in: query tools)
      Comos.Report.Agent.dll    (built-in: report tools)
      Comos.Revision.Agent.dll  (built-in: revision tools)
```

**Important:** Only DLLs placed in `Bin\SDK\AI\` are discovered. Subdirectories are NOT scanned.

---

## 3. Required Interfaces and Attributes

### Interface: `AIComosTool`

Defined in `Comos.Ai.Functions.dll`:

```csharp
public interface AIComosTool
{
    string ToolScope { get; }
}
```

- `ToolScope` — A string identifier for your tool group. Must NOT be `"comos"` (reserved for built-in tools). Use a unique name like `"MyProject"`, `"ServiceiPID"`, etc.

### Attribute: `[AiFunction]`

Marks a method as an AI-callable function:

```csharp
[AiFunction("function_name", "Description of what the function does")]
public object MyFunction(parameters...) { ... }
```

- First parameter: function name (used in OpenAI-style tool_calls)
- Second parameter: description (sent to the LLM to help it decide when to call the function)

### Attribute: `[DescribeParameter]`

Describes a function parameter for the LLM:

```csharp
[DescribeParameter("Description of the parameter", ExampleValue = "example")]
string paramName
```

### Attribute: `[Export]`

Standard MEF export attribute:

```csharp
[Export(typeof(AIComosTool))]
public class MyAgent : AIComosTool { ... }
```

---

## 4. Step-by-Step: Creating a New Tool

### Step 1: Create the C# source file

Create `MyTool.Agent.cs` in `Bin\SDK\AI\`:

```csharp
using System;
using System.ComponentModel.Composition;
using Comos.Ai.Functions;
using Plt;

namespace MyTool.Agent
{
    [Export(typeof(AIComosTool))]
    public class MyToolAgent : AIComosTool
    {
        public string ToolScope { get { return "MyTool"; } }

        private static IComosDWorkset _workset;
        public static IComosDWorkset Workset
        {
            private get { return _workset; }
            set { _workset = value; }
        }

        [AiFunction("my_function", "Description for the LLM")]
        public object MyFunction(
            [DescribeParameter("What this parameter is for")]
            string input)
        {
            // Your logic here
            return new { success = true, result = "Hello from MyTool!" };
        }
    }
}
```

### Step 2: Compile

```batch
"C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe" ^
  /target:library ^
  /out:MyTool.Agent.dll ^
  /reference:..\..\Comos.Ai.Functions.dll ^
  /reference:..\..\Comos.Ai.Contracts.dll ^
  /reference:..\..\Interop.Plt.dll ^
  /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll ^
  /reference:C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll ^
  MyTool.Agent.cs
```

### Step 3: Deploy

1. Close COMOS (it locks loaded DLLs)
2. Copy the `.dll` to `Bin\SDK\AI\`
3. Restart COMOS

### Step 4: Verify

The tool count in the AI chat logs should increase. You can also check by looking at the number of registered tools in the Engineering Assistant initialization.

---

## 5. The Workset Pattern (Critical)

**This is the most important detail and the most common source of bugs.**

COMOS injects the `IComosDWorkset` into your tool via reflection. The pattern MUST match exactly:

```csharp
private static IComosDWorkset _workset;
public static IComosDWorkset Workset
{
    private get { return _workset; }   // ← MUST be private get
    set { _workset = value; }          // ← MUST be public set
}
```

### Why this exact pattern?

| Aspect | Requirement | Reason |
|--------|-------------|--------|
| `static` | **Required** | COMOS uses `Type.InvokeMember()` with `BindingFlags.Static` |
| `private get` | **Required** | If the getter is `public`, COMOS's tool registration silently fails — the tool loads but is NOT registered in the FunctionRegistry |
| `public set` | **Required** | COMOS needs to inject the Workset from outside |
| Backing field | Recommended | Ensures the property has real storage |

### What happens with a public getter?

The tool DLL is found by MEF, the class is instantiated, but when COMOS tries to register the `[AiFunction]` methods, the registration silently skips the tool. It appears in the MEF catalog but NOT in the FunctionRegistry. The tool count does not increase.

**This was discovered by comparing the IL of working built-in agents (Query, Report, Revision) against a non-working custom agent.**

---

## 6. Defining AI Functions

### Basic function

```csharp
[AiFunction(
    "get_project_info",
    "Returns information about the currently open COMOS project")]
public object GetProjectInfo()
{
    if (Workset == null)
        return new { success = false, error = "No workset available" };

    var project = Workset.GetCurrentProject();
    if (project == null)
        return new { success = false, error = "No project open" };

    return new {
        success = true,
        name = project.Name,
        description = project.Description
    };
}
```

### Function with parameters

```csharp
[AiFunction(
    "find_device",
    "Finds a device in COMOS by its tag name")]
public object FindDevice(
    [DescribeParameter(
        "The tag name of the device to find",
        ExampleValue = "=M01.Q01")]
    string tagName,

    [DescribeParameter(
        "Maximum number of results to return",
        ExampleValue = "10")]
    int maxResults)
{
    // Implementation...
}
```

### Parameter types

The LLM sends parameters as JSON. Supported types:
- `string` — Most common, always works
- `int` / `double` — Numeric types (parsed from JSON numbers)
- `bool` — Boolean values

**Recommendation:** Prefer `string` parameters and parse internally for maximum reliability.

---

## 7. Working with COMOS APIs

### Getting the current project

```csharp
var project = Workset.GetCurrentProject();
// Returns IComosDProject
```

### Loading an object by type and UID

```csharp
// documentType: 29 for electrical/P&ID diagrams
object obj = Workset.LoadObjectByType(29, "A5B4Z726ZU");
```

### Finding CDevices (base objects) by SystemFullName

```csharp
IComosDCDevice baseObj = project.GetCDeviceBySystemFullname(
    "@30|M41|A50|A10|A20|A20|A20|A10",  // pipe-delimited SFN
    3                                     // search depth
);
```

### Creating objects with QsGlobalObj

```csharp
using ComosQSGlobalObj;

_QsGlobalObj qsGlobal = (_QsGlobalObj)(new QsGlobalObjClass());
object deviceObj = qsGlobal.GetOrCreateObject(
    docObj,     // target document
    "=M01.Q01", // tag name
    baseObj,    // CDevice template
    null        // parent (null = document root)
);
```

### Working with devices

```csharp
var dev = deviceObj as IComosDDevice;
if (dev != null)
{
    dev.Description = "My Device";

    // Check connectors
    var connectors = dev.Connectors();
    var pin = connectors.Item("EB01") as IComosDConnector;

    // Connect two devices
    pin.Connect(otherPin);
}
```

---

## 8. Drawing Objects on Diagrams

To visually place objects on a COMOS diagram (Report), use the Report COM API:

### Batch drawing pattern (recommended)

```csharp
// 1. Get the document's Report
var doc = docObj as IComosDDocument;
dynamic report = doc.Report();

// 2. Create GlobalCastings ONCE
Type gcType = Type.GetTypeFromProgID("ComosRoUtilities.GlobalCastings");
dynamic gc = Activator.CreateInstance(gcType);

// 3. Open the Report ONCE
report.Open();
dynamic repDoc = report.ReportDocument;

// 4. Draw each object at its coordinates (x, y in mm)
foreach (var item in objectsToDraw)
{
    // CreateReportObject(x1, y1, x2, y2) — all in mm
    dynamic ro = repDoc.CreateReportObject(item.X, item.Y, item.X, item.Y);
    dynamic xObj = ro.CreateXObj("ComosWspRoDevice.WspRoDevice");

    // Link to the logical device
    dynamic iroDev = gc.GC_GetIRoDevice(ro);
    iroDev.Determination = 1;    // 1 = fully determined
    iroDev.Device = item.DeviceObj;
}

// 5. Save and Close ONCE
report.Save();
report.Close();

// 6. Release COM objects
Marshal.ReleaseComObject(gc);
```

### Coordinate system

- **Units:** Millimeters (mm)
- **Origin:** Top-left corner of the diagram page
- **X axis:** Left to right (increasing)
- **Y axis:** Top to bottom (increasing)
- **No Y-flip needed** — use coordinates as-is

### Performance note

**CRITICAL:** Always open/save/close the Report **once** for all objects. Opening and closing per object is extremely slow (can take 3-5 seconds per object) and will easily exceed the 30-second per-iteration timeout.

---

## 9. Compilation and Deployment

### Required references

| Reference | Source |
|-----------|--------|
| `Comos.Ai.Functions.dll` | `Bin\` — Defines `AIComosTool`, `[AiFunction]`, `[DescribeParameter]` |
| `Comos.Ai.Contracts.dll` | `Bin\` — Shared contracts |
| `Interop.Plt.dll` | `Bin\` — `IComosDWorkset`, `IComosDDevice`, etc. |
| `Interop.ComosQSGlobalObj.dll` | `Bin\` — `QsGlobalObjClass` (if creating objects) |
| `Microsoft.CSharp.dll` | GAC — Required if using `dynamic` keyword |
| `System.ComponentModel.Composition.dll` | GAC — MEF `[Export]` attribute |

### Full compilation command

```batch
SET CSC="C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
SET BIN="C:\Program Files (x86)\COMOS\Team_AI\Bin"
SET SDK="C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI"

%CSC% /target:library /out:%SDK%\MyTool.Agent.dll ^
  /reference:%BIN%\Comos.Ai.Functions.dll ^
  /reference:%BIN%\Comos.Ai.Contracts.dll ^
  /reference:%BIN%\Interop.Plt.dll ^
  /reference:%BIN%\Interop.ComosQSGlobalObj.dll ^
  /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll ^
  /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll" ^
  %SDK%\MyTool.Agent.cs
```

### Target framework

Tools must target **.NET Framework 4.x** (not .NET Core/.NET 5+). COMOS runs on the full .NET Framework CLR.

### Deployment

1. **Close COMOS** — it loads and locks DLLs at startup via MEF
2. Copy the `.dll` to `Bin\SDK\AI\`
3. Restart COMOS
4. Open the Engineering Assistant chat panel — tools are registered during initialization

---

## 10. Timeout and Performance Constraints

The COMOS AI Client enforces strict timeouts:

| Setting | Default | Description |
|---------|---------|-------------|
| `TimeoutPerIteration` | **30 seconds** | Maximum time for a single tool call to complete |
| `TotalTimeout` | **5 minutes** | Maximum time for the entire tool processing loop |
| `MaxIterations` | **3** | Maximum number of tool call rounds |
| `HTTP Timeout` | **60 seconds** | HTTP request timeout to the AI service |

### TimeoutPerIteration (30s) — The critical constraint

This is the **maximum time your tool function can execute** before COMOS aborts it with a `TIMEOUT_ERROR`. This value is hardcoded in `DesktopCommunication.dll` and **cannot be configured** via XML or config files.

The defaults are set in the `ToolConfig` constructor:
```csharp
// From Comos.Ai.Client.Configuration.ToolConfig::.ctor()
MaxIterations = 3;
DuplicateDetectionEnabled = true;
TimeoutPerIteration = TimeSpan.FromSeconds(30);
TotalTimeout = TimeSpan.FromMinutes(5);
```

And the client is built without overriding TimeoutPerIteration:
```csharp
// From ChatCommunication.InitEngineeringAssistantClient()
ComosAiClient.Configure()
    .WithAIService(aiServiceUrl)
    .WithTimeout(TimeSpan.FromSeconds(60))
    .WithRetryPolicy(3, TimeSpan.FromSeconds(2))
    .WithMaxIterations(3)
    // NOTE: No .WithTimeoutPerIteration() call — uses default 30s
    .Build();
```

### Performance tips

1. **Avoid per-object Report.Open()/Save()/Close()** — batch all drawing operations
2. **Cache COM objects** — create `GlobalCastings`, `QsGlobalObjClass` once, reuse for all operations
3. **Cache CDevice lookups** — use a `Dictionary<string, IComosDCDevice>` to avoid redundant `GetCDeviceBySystemFullname` calls
4. **Excel COM is slow** — `Activator.CreateInstance(Excel.Application)` can take 10-20 seconds alone. For simple XLSX reading, consider parsing the XML directly with `System.IO.Compression.ZipArchive`

---

## 11. Return Value Serialization

Tool functions return `object` (typically anonymous types). COMOS serializes the return value using `.ToString()` on the anonymous type, which produces a format like:

```
{ success = True, created = 5, message = Import complete }
```

### Important rules

1. **Use simple types** — `string`, `int`, `double`, `bool`
2. **Do NOT return arrays** — `string[]` will serialize as `System.String[]` instead of the actual values
3. **Join arrays into strings:**
   ```csharp
   // BAD — serializes as "System.String[]"
   errors = errors.Count > 0 ? errors.ToArray() : null

   // GOOD — serializes as the actual error text
   errors = errors.Count > 0 ? string.Join("; ", errors) : ""
   ```
4. **Return structured anonymous types:**
   ```csharp
   return new {
       success = true,
       count = 42,
       message = "Operation completed"
   };
   ```

---

## 12. Debugging and Diagnostics

### Log files

| Log | Location | Contents |
|-----|----------|----------|
| AI Shim log | `%TEMP%\comos_ai_shim\ai_api_shim.log` | HTTP proxy traffic, tool calls |
| ChatControl debug | `%TEMP%\AIChatControl_Debug_*.log` | Chat UI events |
| COMOS Services AI API | `Bin\Comos.Services.Ai.Api.exe` console | AI service requests |

### Verifying tool registration

After COMOS starts, check the tool count in the AI service logs. Each registered `[AiFunction]` method adds one tool. Built-in COMOS has ~15 tools. Your tools add to this count.

### IL disassembly for debugging

If you need to understand how built-in COMOS DLLs work:

```powershell
$ildasm = "C:\Program Files (x86)\Microsoft SDKs\Windows\v10.0A\bin\NETFX 4.8.1 Tools\ildasm.exe"
& $ildasm /text "Bin\Comos.Ai.Client.dll" > "$env:TEMP\aiclient_il.txt"
```

### Common diagnostic checks

```powershell
# Check DLL is in the right place
Get-ChildItem "Bin\SDK\AI\*.dll" | Select-Object Name, Length

# Check DLL is valid .NET assembly
[System.Reflection.Assembly]::LoadFile("C:\full\path\to\YourTool.dll")

# Check exports
[System.Reflection.Assembly]::LoadFile("C:\full\path\to\YourTool.dll").GetExportedTypes()
```

---

## 13. Complete Minimal Example

A "hello world" tool that verifies the entire pipeline:

```csharp
using System;
using System.ComponentModel.Composition;
using Comos.Ai.Functions;
using Plt;

namespace Comos.TestTool.Agent
{
    [Export(typeof(AIComosTool))]
    public class TestToolAgent : AIComosTool
    {
        public string ToolScope { get { return "TestTool"; } }

        private static IComosDWorkset _workset;
        public static IComosDWorkset Workset
        {
            private get { return _workset; }
            set { _workset = value; }
        }

        [AiFunction(
            "test_hello_world",
            "A simple test tool that returns a greeting. Use this to verify the AI tool pipeline is working.")]
        public object TestHelloWorld(
            [DescribeParameter("Your name", ExampleValue = "Engineer")]
            string name)
        {
            bool hasWorkset = Workset != null;
            string projectName = "";

            if (hasWorkset)
            {
                try
                {
                    var proj = Workset.GetCurrentProject();
                    if (proj != null) projectName = proj.Name;
                }
                catch { }
            }

            return new
            {
                success = true,
                greeting = string.Format("Hello {0}! Tool pipeline is working.", name),
                worksetAvailable = hasWorkset,
                currentProject = projectName,
                timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
            };
        }
    }
}
```

---

## 14. Complete Real-World Example

See `Comos.ServiceiPID.Agent.cs` in this directory for a full production tool that:

- Reads Excel files via COM automation
- Creates COMOS devices from CDevice templates
- Draws objects on diagrams at specific X/Y coordinates (mm)
- Creates electrical connections between devices
- Returns detailed success/error reporting
- Uses batch Report operations for performance

---

## 15. Known Pitfalls

### 1. Tool compiles but doesn't appear in COMOS

**Cause:** `Workset` property has a `public get` instead of `private get`.  
**Fix:** Change to `private get { return _workset; }`

### 2. Tool appears but gets TIMEOUT_ERROR

**Cause:** Execution exceeds 30 seconds (hardcoded `TimeoutPerIteration`).  
**Fix:** Optimize your code — batch operations, cache COM objects, avoid per-item Report.Open/Close.

### 3. Return value shows `System.String[]` instead of actual values

**Cause:** COMOS uses `.ToString()` on anonymous types, which doesn't serialize arrays.  
**Fix:** Use `string.Join("; ", myList)` instead of `myList.ToArray()`.

### 4. ToolScope = "comos" causes silent registration failure

**Cause:** `"comos"` is reserved for built-in tools. Using it conflicts with the built-in scope.  
**Fix:** Use a unique scope name.

### 5. DLL is locked and cannot be replaced

**Cause:** COMOS loads DLLs at startup and holds locks.  
**Fix:** Close COMOS before replacing the DLL, then restart.

### 6. `Workset` is null at runtime

**Cause:** COMOS hasn't injected the Workset yet, or the property pattern doesn't match.  
**Fix:** Always check `if (Workset == null)` and return an error message.

### 7. COM objects leak memory

**Cause:** Not calling `Marshal.ReleaseComObject()` on COM instances.  
**Fix:** Always release COM objects (Excel, GlobalCastings, etc.) in a `finally` block.

---

## Reference: Built-in Tool Agents

| Agent DLL | ToolScope | Functions |
|-----------|-----------|-----------|
| `Comos.Query.Agent.dll` | `"Query"` | Database queries, object search |
| `Comos.Report.Agent.dll` | `"Report"` | Report generation |
| `Comos.Revision.Agent.dll` | `"Revsion"` | Revision management (note: typo is intentional in COMOS) |

---

## Reference: Key COMOS COM Interfaces

| Interface | Assembly | Purpose |
|-----------|----------|---------|
| `IComosDWorkset` | `Interop.Plt.dll` | Main entry point — project access, object loading |
| `IComosDProject` | `Interop.Plt.dll` | Project-level operations |
| `IComosDDevice` | `Interop.Plt.dll` | Logical device (equipment) |
| `IComosDCDevice` | `Interop.Plt.dll` | Base object / template in catalog |
| `IComosDDocument` | `Interop.Plt.dll` | Document (diagram) |
| `IComosDConnector` | `Interop.Plt.dll` | Connection point on a device |
| `_QsGlobalObj` | `Interop.ComosQSGlobalObj.dll` | Helper for creating/finding objects |

---

*This document was created by analyzing the IL (Intermediate Language) of COMOS internal assemblies, comparing working built-in agents, and iterative testing of the MEF plugin discovery mechanism.*
