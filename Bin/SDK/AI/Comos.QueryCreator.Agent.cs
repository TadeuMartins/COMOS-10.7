// ============================================================================
// Comos.QueryCreator.Agent — AI Tool para enumerar objetos COMOS
// (CDevices, Devices, Documents) diretamente via APIs Plt.
//
// v3 — Rewritten to use direct COMOS collection APIs instead of QCreator.
//       QCreator requires internal UI context that is not available from
//       AI tool execution. Direct APIs (AllCDevices, AllDevices, etc.)
//       work reliably from the MEF plugin context.
//
// Compilar com (.NET 4.0 csc, C# 5):
//   set BIN=C:\Program Files (x86)\COMOS\Team_AI\Bin
//   cd /d "%BIN%\SDK\AI"
//   "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" ^
//     /target:library /out:Comos.QueryCreator.Agent.dll ^
//     /reference:"%BIN%\Comos.Ai.Functions.dll" ^
//     /reference:"%BIN%\Comos.Ai.Contracts.dll" ^
//     /reference:"%BIN%\Interop.Plt.dll" ^
//     /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll" ^
//     /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll" ^
//     Comos.QueryCreator.Agent.cs
// ============================================================================

using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Comos.Ai.Functions;
using Plt;

namespace Comos.QueryCreator.Agent
{
    /// <summary>
    /// Tool que enumera objetos COMOS (CDevices, Devices, Documents)
    /// diretamente via APIs IComosDProject, sem depender do QCreator/QueryXObj.
    ///
    /// [Export] + AIComosTool = MEF auto-discovery by COMOS ChatControl.
    /// </summary>
    [Export(typeof(AIComosTool))]
    public class QueryCreatorAgent : AIComosTool
    {
        public string ToolScope { get { return "QueryCreator"; } }

        private static IComosDWorkset _workset;
        public static IComosDWorkset Workset
        {
            private get { return _workset; }
            set { _workset = value; }
        }

        private const int MAX_INLINE_ROWS = 500;
        private const int MAX_TOTAL_ROWS  = 50000;

        // =====================================================================
        // TOOL 1: create_and_run_query
        // Uses direct COMOS collection APIs (AllCDevices, AllDevices, etc.)
        // =====================================================================
        [AiFunction(
            "create_and_run_query",
            "Enumerates COMOS objects and returns structured results. " +
            "Supports: queryType 0=Devices (all project devices), " +
            "1=CDevices (base objects/catalog), 4=Documents. " +
            "Columns: Name, Description, SystemFullName, FullName, Label. " +
            "Use sfnPrefix to filter by SystemFullName prefix (e.g. '@30' for P&ID). " +
            "Use nameFilter to filter by Name (contains match). " +
            "Example: queryType=1, columns='Name,Description,SystemFullName', " +
            "sfnPrefix='@30' to list P&ID CDevices.")]
        public object CreateAndRunQuery(
            [DescribeParameter(
                "Query type: 0=Devices, 1=CDevices (base objects), 4=Documents",
                ExampleValue = "1")]
            string queryType,

            [DescribeParameter(
                "Comma-separated columns: Name, Description, SystemFullName, FullName, " +
                "Label, FullLabel, IsFolder. Default: Name,Description,SystemFullName",
                ExampleValue = "Name,Description,SystemFullName")]
            string columns,

            [DescribeParameter(
                "Optional SystemFullName prefix filter. " +
                "Example: '@30' for P&ID CDevices, '@10' for electrical. Empty = no filter.",
                ExampleValue = "@30")]
            string sfnPrefix,

            [DescribeParameter(
                "Optional Name contains filter. " +
                "Example: 'pump' matches any object whose Name contains 'pump'. Empty = no filter.",
                ExampleValue = "")]
            string nameFilter,

            [DescribeParameter(
                "Max rows to return (default 200, max 500 inline).",
                ExampleValue = "200")]
            string maxRows,

            [DescribeParameter(
                "Optional file path to export results as CSV. Leave empty for inline results.",
                ExampleValue = "")]
            string exportPath)
        {
            if (Workset == null)
                return new { success = false, error = "Workset not available. COMOS must be running with an open project." };

            int qType;
            if (!int.TryParse((queryType ?? "1").Trim(), out qType))
                qType = 1;

            int rowLimit;
            if (!int.TryParse((maxRows ?? "200").Trim(), out rowLimit))
                rowLimit = 200;
            if (rowLimit <= 0) rowLimit = MAX_TOTAL_ROWS;
            bool hasExport = !string.IsNullOrWhiteSpace(exportPath);
            if (!hasExport && rowLimit > MAX_INLINE_ROWS) rowLimit = MAX_INLINE_ROWS;

            string colStr = string.IsNullOrWhiteSpace(columns)
                ? "Name,Description,SystemFullName" : columns.Trim();
            string[] colNames = colStr.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < colNames.Length; i++) colNames[i] = colNames[i].Trim();

            string prefix = (sfnPrefix ?? "").Trim();
            string nameFlt = (nameFilter ?? "").Trim();

            try
            {
                var project = Workset.GetCurrentProject();
                if (project == null)
                    return new { success = false, error = "No project is currently open." };

                switch (qType)
                {
                    case 1:
                        return EnumCDevices(project, colNames, prefix, nameFlt, rowLimit, exportPath);
                    case 0:
                        return EnumDevices(project, colNames, prefix, nameFlt, rowLimit, exportPath);
                    case 4:
                        return EnumDocuments(project, colNames, prefix, nameFlt, rowLimit, exportPath);
                    default:
                        return new { success = false, error = "Unsupported queryType " + qType + ". Use 0=Devices, 1=CDevices, 4=Documents." };
                }
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Query failed: " + ex.Message, trace = ex.StackTrace };
            }
        }

        // =====================================================================
        // TOOL 2: list_all_cdevice_sfn — Shortcut for CDevice SFN listing
        // =====================================================================
        [AiFunction(
            "list_all_cdevice_sfn",
            "Lists CDevice (base object) SystemFullName values from the COMOS project catalog. " +
            "Useful for discovering valid SystemFullName values for equipment import. " +
            "Filter by prefix: '@30' = P&ID, '@10' = electrical, '' = all. " +
            "Returns Name, Description, SystemFullName for each CDevice.")]
        public object ListAllCDeviceSfn(
            [DescribeParameter(
                "SystemFullName prefix filter. '@30' = P&ID, '@10' = electrical, '' = all.",
                ExampleValue = "@30")]
            string rootPrefix,

            [DescribeParameter(
                "Max rows (default 200, max 500 inline).",
                ExampleValue = "200")]
            string maxRows,

            [DescribeParameter(
                "Optional CSV export file path. Empty = inline results only.",
                ExampleValue = "")]
            string exportPath)
        {
            if (Workset == null)
                return new { success = false, error = "Workset not available." };

            int rowLimit;
            if (!int.TryParse((maxRows ?? "200").Trim(), out rowLimit))
                rowLimit = 200;
            if (rowLimit <= 0) rowLimit = MAX_INLINE_ROWS;
            bool hasExport = !string.IsNullOrWhiteSpace(exportPath);
            if (!hasExport && rowLimit > MAX_INLINE_ROWS) rowLimit = MAX_INLINE_ROWS;

            try
            {
                var project = Workset.GetCurrentProject();
                if (project == null)
                    return new { success = false, error = "No project open." };

                string[] colNames = new[] { "Name", "Description", "SystemFullName" };
                return EnumCDevices(
                    project, colNames, (rootPrefix ?? "").Trim(), "",
                    hasExport ? MAX_TOTAL_ROWS : rowLimit, exportPath);
            }
            catch (Exception ex)
            {
                return new { success = false, error = "Failed: " + ex.Message, trace = ex.StackTrace };
            }
        }

        // =====================================================================
        // EnumCDevices — Enumerate via project.AllCDevices()
        // =====================================================================
        private object EnumCDevices(IComosDProject project, string[] colNames,
            string sfnPrefix, string nameFilter, int rowLimit, string exportPath)
        {
            IComosDCollection allCDevices = null;
            try
            {
                allCDevices = project.AllCDevices();
            }
            catch (Exception ex)
            {
                return new { success = false, error = "project.AllCDevices() failed: " + ex.Message };
            }

            if (allCDevices == null)
                return new { success = false, error = "project.AllCDevices() returned null." };

            int totalCount = 0;
            try { totalCount = allCDevices.Count(); } catch { }

            var sb = new StringBuilder();
            sb.AppendLine(string.Join("\t", colNames));

            int matchCount = 0;
            int scanned = 0;
            int errors = 0;
            bool hasPrefix = !string.IsNullOrEmpty(sfnPrefix);
            bool hasNameFlt = !string.IsNullOrEmpty(nameFilter);
            string nameFltLower = hasNameFlt ? nameFilter.ToLowerInvariant() : "";

            for (int i = 1; i <= totalCount && matchCount < rowLimit; i++)
            {
                scanned++;
                try
                {
                    object rawItem = allCDevices.Item(i);
                    if (rawItem == null) continue;

                    // Get properties using IComosBaseObject interface
                    IComosBaseObject baseObj = rawItem as IComosBaseObject;
                    if (baseObj == null)
                    {
                        errors++;
                        continue;
                    }

                    // ── Get SFN and Name for filtering ──
                    string sfn = "";
                    try { sfn = baseObj.SystemFullName(); } catch { }
                    string name = "";
                    try { name = baseObj.Name; } catch { }

                    // Apply prefix filter
                    if (hasPrefix)
                    {
                        if (string.IsNullOrEmpty(sfn) ||
                            !sfn.StartsWith(sfnPrefix, StringComparison.OrdinalIgnoreCase))
                            continue;
                    }

                    // Apply name filter
                    if (hasNameFlt)
                    {
                        if (string.IsNullOrEmpty(name) ||
                            name.ToLowerInvariant().IndexOf(nameFltLower) < 0)
                            continue;
                    }

                    // ── Build row ──
                    var rowVals = new List<string>();
                    foreach (string col in colNames)
                    {
                        rowVals.Add(GetBaseObjectProperty(baseObj, col, sfn, name));
                    }
                    sb.AppendLine(string.Join("\t", rowVals.ToArray()));
                    matchCount++;
                }
                catch { errors++; }
            }

            string resultText = sb.ToString();
            string exportResult = DoExport(exportPath, resultText);

            bool truncated = matchCount >= rowLimit && scanned < totalCount;
            string msg = string.Format(
                "CDevices enumerated. TotalInCatalog={0}, Scanned={1}, Matched={2}, Errors={3}{4}",
                totalCount, scanned, matchCount, errors,
                truncated ? ", TRUNCATED (increase maxRows or use exportPath)" : "");

            // Release COM
            try { Marshal.ReleaseComObject(allCDevices); } catch { }

            return new
            {
                success = true,
                message = msg,
                queryType = "CDevices",
                totalInCatalog = totalCount,
                returnedRows = matchCount,
                truncated = truncated,
                columns = string.Join(",", colNames),
                results = resultText,
                exportResult = exportResult
            };
        }

        // =====================================================================
        // EnumDevices — Enumerate via project.AllDevices()
        // =====================================================================
        private object EnumDevices(IComosDProject project, string[] colNames,
            string sfnPrefix, string nameFilter, int rowLimit, string exportPath)
        {
            IComosDCollection allDevices = null;
            try { allDevices = project.AllDevices(); }
            catch (Exception ex)
            {
                return new { success = false, error = "project.AllDevices() failed: " + ex.Message };
            }

            if (allDevices == null)
                return new { success = false, error = "project.AllDevices() returned null." };

            int totalCount = 0;
            try { totalCount = allDevices.Count(); } catch { }

            var sb = new StringBuilder();
            sb.AppendLine(string.Join("\t", colNames));

            int matchCount = 0;
            int scanned = 0;
            int errors = 0;
            bool hasPrefix = !string.IsNullOrEmpty(sfnPrefix);
            bool hasNameFlt = !string.IsNullOrEmpty(nameFilter);
            string nameFltLower = hasNameFlt ? nameFilter.ToLowerInvariant() : "";

            for (int i = 1; i <= totalCount && matchCount < rowLimit; i++)
            {
                scanned++;
                try
                {
                    object rawItem = allDevices.Item(i);
                    if (rawItem == null) continue;

                    IComosBaseObject baseObj = rawItem as IComosBaseObject;
                    if (baseObj == null) { errors++; continue; }

                    string sfn = "";
                    try { sfn = baseObj.SystemFullName(); } catch { }
                    string name = "";
                    try { name = baseObj.Name; } catch { }

                    if (hasPrefix && (string.IsNullOrEmpty(sfn) ||
                        !sfn.StartsWith(sfnPrefix, StringComparison.OrdinalIgnoreCase)))
                        continue;
                    if (hasNameFlt && (string.IsNullOrEmpty(name) ||
                        name.ToLowerInvariant().IndexOf(nameFltLower) < 0))
                        continue;

                    var rowVals = new List<string>();
                    foreach (string col in colNames)
                        rowVals.Add(GetBaseObjectProperty(baseObj, col, sfn, name));
                    sb.AppendLine(string.Join("\t", rowVals.ToArray()));
                    matchCount++;
                }
                catch { errors++; }
            }

            string resultText = sb.ToString();
            string exportResult = DoExport(exportPath, resultText);
            try { Marshal.ReleaseComObject(allDevices); } catch { }

            bool truncated = matchCount >= rowLimit && scanned < totalCount;
            return new
            {
                success = true,
                message = string.Format(
                    "Devices enumerated. Total={0}, Scanned={1}, Matched={2}, Errors={3}{4}",
                    totalCount, scanned, matchCount, errors, truncated ? ", TRUNCATED" : ""),
                queryType = "Devices",
                totalInProject = totalCount,
                returnedRows = matchCount,
                truncated = truncated,
                columns = string.Join(",", colNames),
                results = resultText,
                exportResult = exportResult
            };
        }

        // =====================================================================
        // EnumDocuments — Enumerate via project.AllDocuments()
        // =====================================================================
        private object EnumDocuments(IComosDProject project, string[] colNames,
            string sfnPrefix, string nameFilter, int rowLimit, string exportPath)
        {
            IComosDCollection allDocs = null;
            try { allDocs = project.AllDocuments(); }
            catch (Exception ex)
            {
                return new { success = false, error = "project.AllDocuments() failed: " + ex.Message };
            }

            if (allDocs == null)
                return new { success = false, error = "project.AllDocuments() returned null." };

            int totalCount = 0;
            try { totalCount = allDocs.Count(); } catch { }

            var sb = new StringBuilder();
            sb.AppendLine(string.Join("\t", colNames));

            int matchCount = 0;
            int scanned = 0;
            int errors = 0;
            bool hasNameFlt = !string.IsNullOrEmpty(nameFilter);
            string nameFltLower = hasNameFlt ? nameFilter.ToLowerInvariant() : "";

            for (int i = 1; i <= totalCount && matchCount < rowLimit; i++)
            {
                scanned++;
                try
                {
                    object rawItem = allDocs.Item(i);
                    if (rawItem == null) continue;

                    IComosBaseObject baseObj = rawItem as IComosBaseObject;
                    if (baseObj == null) { errors++; continue; }

                    string name = "";
                    try { name = baseObj.Name; } catch { }
                    string sfn = "";
                    try { sfn = baseObj.SystemFullName(); } catch { }

                    if (hasNameFlt && (string.IsNullOrEmpty(name) ||
                        name.ToLowerInvariant().IndexOf(nameFltLower) < 0))
                        continue;

                    var rowVals = new List<string>();
                    foreach (string col in colNames)
                        rowVals.Add(GetBaseObjectProperty(baseObj, col, sfn, name));
                    sb.AppendLine(string.Join("\t", rowVals.ToArray()));
                    matchCount++;
                }
                catch { errors++; }
            }

            string resultText = sb.ToString();
            string exportResult = DoExport(exportPath, resultText);
            try { Marshal.ReleaseComObject(allDocs); } catch { }

            bool truncated = matchCount >= rowLimit && scanned < totalCount;
            return new
            {
                success = true,
                message = string.Format(
                    "Documents enumerated. Total={0}, Scanned={1}, Matched={2}, Errors={3}{4}",
                    totalCount, scanned, matchCount, errors, truncated ? ", TRUNCATED" : ""),
                queryType = "Documents",
                totalInProject = totalCount,
                returnedRows = matchCount,
                truncated = truncated,
                columns = string.Join(",", colNames),
                results = resultText,
                exportResult = exportResult
            };
        }

        // =====================================================================
        // Unified property accessor — works with any IComosBaseObject
        // =====================================================================
        private string GetBaseObjectProperty(IComosBaseObject obj,
            string col, string sfn, string name)
        {
            switch (col.ToLowerInvariant())
            {
                case "name":
                    return name ?? TryGet(delegate { return obj.Name; });
                case "description":
                    return TryGet(delegate { return obj.Description; });
                case "systemfullname":
                    return sfn ?? TryGet(delegate { return obj.SystemFullName(); });
                case "fullname":
                    return TryGet(delegate { return obj.FullName(); });
                case "label":
                    return TryGet(delegate { return obj.Label; });
                case "fulllabel":
                    return TryGet(delegate { return obj.FullLabel(); });
                case "isfolder":
                    return TryGet(delegate
                    {
                        return obj.IsFolder ? "True" : "False";
                    });
                case "systemuid":
                    return TryGet(delegate { return obj.SystemUID(); });
                default:
                    return "";
            }
        }

        // =====================================================================
        // Helpers
        // =====================================================================
        private delegate string StringGetter();

        private string TryGet(StringGetter getter)
        {
            try { return getter() ?? ""; }
            catch { return ""; }
        }

        private string DoExport(string exportPath, string tsvText)
        {
            if (string.IsNullOrWhiteSpace(exportPath)) return "";

            string ep = exportPath.Trim();
            try
            {
                // Ensure directory exists
                string dir = Path.GetDirectoryName(ep);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);

                // Convert TSV to CSV
                string csvText = tsvText.Replace("\t", ",");

                if (ep.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                {
                    File.WriteAllText(ep, csvText, Encoding.UTF8);
                    return "Exported CSV: " + ep;
                }
                else if (ep.EndsWith(".tsv", StringComparison.OrdinalIgnoreCase) ||
                         ep.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
                {
                    File.WriteAllText(ep, tsvText, Encoding.UTF8);
                    return "Exported TSV: " + ep;
                }
                else
                {
                    // Default: export as CSV
                    string csvPath = Path.ChangeExtension(ep, ".csv");
                    File.WriteAllText(csvPath, csvText, Encoding.UTF8);
                    return "Exported CSV: " + csvPath;
                }
            }
            catch (Exception ex)
            {
                return "Export failed: " + ex.Message;
            }
        }
    }
}
