#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// COMOS AI API Shim — Dual-mode proxy with two-step digitization
//
//  Mode 1 (Normal chat):  COMOS tool-calling → AI API (:56400) → vLLM (:8100)
//  Mode 2 (Digitization): Two-step flow:
//    Step A: PDF detected → ask user: "P&ID ou Diagrama Elétrico?"
//    Step B: User answers → route PDF + type to Gateway analyze_pdf
//
//  The shim sits on :56401 and the COMOS desktop client talks exclusively to it.
// ─────────────────────────────────────────────────────────────────────────────

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const { Agent, setGlobalDispatcher } = require("undici");
// Override the default undici dispatcher so that fetch() doesn't time out at
// the built-in 5-minute headersTimeout when the backend takes 6-10 minutes.
setGlobalDispatcher(new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 }));
const path = require("node:path");

// ── CLI arguments ──────────────────────────────────────────────────────────
function getArg(name, fallback) {
  const key = `--${name}`;
  const idx = process.argv.indexOf(key);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const listenPort   = Number(getArg("listen-port", "56401"));
const targetBase   = String(getArg("target-base", "http://localhost:56400")).replace(/\/+$/, "");
const gatewayBase  = String(getArg("gateway-base", "http://localhost:8100")).replace(/\/+$/, "");
const defaultModel = String(getArg("default-model", "serviceipid-gateway"));

// ── Logging ────────────────────────────────────────────────────────────────
const logDir  = path.join(os.tmpdir(), "comos_ai_shim");
const logFile = path.join(logDir, "ai_api_shim.log");
const reqLogFile = path.join(logDir, "requests.jsonl"); // full request body log
fs.mkdirSync(logDir, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(logFile, line);
}

// Log full request bodies (truncated base64) for debugging
function logRequest(urlPath, parsed) {
  try {
    const clone = JSON.parse(JSON.stringify(parsed));
    // Truncate any base64 fields to avoid multi-MB logs
    const truncateB64 = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "string" && obj[key].length > 500 &&
            /^[A-Za-z0-9+/=\r\n]+$/.test(obj[key].substring(0, 200))) {
          obj[key] = obj[key].substring(0, 80) + `...[${obj[key].length} chars]`;
        } else if (typeof obj[key] === "object") {
          truncateB64(obj[key]);
        }
      }
    };
    truncateB64(clone);
    const entry = JSON.stringify({ ts: new Date().toISOString(), url: urlPath, body: clone });
    fs.appendFileSync(reqLogFile, entry + "\n");
  } catch { /* ignore logging errors */ }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    if (["host", "connection", "content-length", "expect", "proxy-connection"].includes(key)) {
      continue;
    }
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getAllowedToolInfo(parsed) {
  const tools = parsed.tools || parsed.Tools || [];
  const names = tools
    .map((t) => t?.function?.name || t?.Function?.Name || "")
    .filter(Boolean);
  const byLower = new Map(names.map((n) => [String(n).toLowerCase(), n]));
  return { names, byLower };
}

function normalizeArgumentsString(rawArgs) {
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (!trimmed) return "{}";
    try {
      // Canonicalize JSON argument strings.
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      // Preserve provider output if not valid JSON; COMOS may still parse it downstream.
      return trimmed;
    }
  }

  if (rawArgs && typeof rawArgs === "object") {
    try {
      return JSON.stringify(rawArgs);
    } catch {
      return "{}";
    }
  }

  return "{}";
}

function normalizeToolName(rawName, allowedToolsMap) {
  const name = String(rawName || "").trim();
  if (!name) return null;
  if (!allowedToolsMap.size) return null;
  return allowedToolsMap.get(name.toLowerCase()) || null;
}

function normalizeFunctionCall(rawCall, allowedToolsMap) {
  if (!rawCall || typeof rawCall !== "object") return null;
  const name = normalizeToolName(rawCall.name, allowedToolsMap);
  if (!name) return null;
  return {
    name,
    arguments: normalizeArgumentsString(rawCall.arguments),
  };
}

function normalizeToolCall(rawCall, index, allowedToolsMap, idPrefix) {
  if (!rawCall || typeof rawCall !== "object") return null;

  const rawFn = rawCall.function && typeof rawCall.function === "object" ? rawCall.function : rawCall;
  const name = normalizeToolName(rawFn.name, allowedToolsMap);
  if (!name) return null;

  const id = String(rawCall.id || "").trim() || `${idPrefix}_${index}`;
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: normalizeArgumentsString(rawFn.arguments),
    },
  };
}

function isToolIterationTimeoutText(text) {
  const msg = String(text || "");
  return /TIMEOUT_ERROR|Tool processing iteration|per-iteration timeout|Unexpected error processing message for session/i.test(msg);
}

// ── Extract last-known SystemUID from conversation (tool results) ──────────
// Scans tool result messages for SystemUID patterns (A followed by 9 chars).
// Returns the MOST RECENT one, as that corresponds to the currently active object.
function extractLastSystemUidFromConversation(messages) {
  if (!Array.isArray(messages)) return null;
  let lastUid = null;
  for (const m of messages) {
    const role = String((m || {}).role || (m || {}).Role || "").toLowerCase();
    if (role !== "tool" && role !== "function") continue;
    const content = String(m.content || m.Content || "");
    // Match SystemUID = AXXXXXXXXX (exactly A + 9 alpha-numeric chars)
    const match = content.match(/SystemUID\s*=\s*(A[A-Z0-9]{9})\b/i);
    if (match) lastUid = match[1];
  }
  // Also check assistant messages that might mention SystemUID
  for (const m of messages) {
    const role = String((m || {}).role || (m || {}).Role || "").toLowerCase();
    if (role !== "assistant") continue;
    const content = String(m.content || m.Content || "");
    const match = content.match(/SystemUID[:\s]+\**(A[A-Z0-9]{9})\b/i);
    if (match) lastUid = match[1];
  }
  return lastUid;
}

// ── Enrich attribute tool_calls: strip systemUID so DLL uses selected object ──
// The COMOS DLL's NavigateToAttributeByNameOrDescription has two paths:
//   1. If systemUID is provided → LoadObjectByType(systemUID) — often fails
//   2. If systemUID is empty → get_navigator_selected_object() — works after nav
// Since we always navigate to the object first (setting the COMOS navigator
// selection), we REMOVE any systemUID the LLM may have hallucinated so the
// DLL uses path 2 (the currently selected object).
function enrichAttributeToolCalls(parsed, messages, sessionKey) {
  if (!parsed || !Array.isArray(parsed.choices)) return false;

  let enriched = false;

  for (const choice of parsed.choices) {
    const msg = choice && choice.message;
    if (!msg) continue;
    const toolCalls = msg.tool_calls || msg.toolCalls;
    if (!Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      const fn = tc.function;
      if (!fn) continue;
      const name = String(fn.name || "");
      if (!name.includes("attribute_by_name_or_description")) continue;

      // Parse arguments
      let args;
      try {
        args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
      } catch (_) { continue; }
      if (!args || typeof args !== "object") continue;

      // REMOVE systemUID so DLL uses get_navigator_selected_object() path
      if (args.systemUID) {
        log(`attribute_tool_strip_uid session=${sessionKey} tool=${name} removed_systemUID=${args.systemUID}`);
        delete args.systemUID;
        const enrichedArgs = JSON.stringify(args);
        fn.arguments = enrichedArgs;
        if (msg.function_call && msg.function_call.name === name) {
          msg.function_call.arguments = enrichedArgs;
        }
        if (msg.FunctionCall && msg.FunctionCall.name === name) {
          msg.FunctionCall.arguments = enrichedArgs;
        }
        enriched = true;
      }
    }
  }
  return enriched;
}

// ── Shared: Normalize COMOS conversation history to clean OpenAI format ────
// COMOS caches the full assistant response (including PascalCase aliases,
// legacy function_call, and toolCalls added by adaptRawCompletionForComos)
// and sends it all back in subsequent requests.  OpenAI rejects mixed formats,
// so we must strip legacy / alias fields and ensure every tool-response
// message is preceded by an assistant message with a matching tool_calls[].id.
function normalizeMessagesForOpenAI(messages) {
  const normalized = [];
  let pendingId = null;
  let idCounter = 0;
  const baseId = `call_${Date.now()}`;

  for (const msg of messages) {
    const role = (msg.role || msg.Role || "").toLowerCase();

    // ── Assistant with legacy function_call / FunctionCall ────────────
    if (role === "assistant" && (msg.function_call || msg.FunctionCall)) {
      const fc = msg.function_call || msg.FunctionCall;
      const fcName = fc.name || fc.Name || "";
      const fcArgs = fc.arguments || fc.Arguments || "{}";

      // If the message ALSO carries tool_calls with a real ID, prefer that ID
      const existingTC = msg.tool_calls || msg.toolCalls;
      let tcId;
      if (Array.isArray(existingTC) && existingTC.length > 0 && existingTC[0].id) {
        tcId = existingTC[0].id;
      } else {
        tcId = `${baseId}_${idCounter++}`;
      }
      pendingId = tcId;

      normalized.push({
        role: "assistant",
        content: msg.content || msg.Content || null,
        tool_calls: [{
          id: tcId,
          type: "function",
          function: {
            name: fcName,
            arguments: typeof fcArgs === "string" ? fcArgs : JSON.stringify(fcArgs),
          },
        }],
      });
      continue;
    }

    // ── Assistant with tool_calls / toolCalls (already OpenAI format) ─
    if (role === "assistant" && (msg.tool_calls || msg.toolCalls)) {
      const tc = msg.tool_calls || msg.toolCalls;
      if (Array.isArray(tc) && tc.length > 0) {
        const cleanTC = tc.map((t, idx) => ({
          id: t.id || `${baseId}_${idCounter++}`,
          type: t.type || "function",
          function: t.function || { name: "", arguments: "{}" },
        }));
        pendingId = cleanTC[cleanTC.length - 1].id;
        normalized.push({
          role: "assistant",
          content: msg.content || msg.Content || null,
          tool_calls: cleanTC,
        });
        continue;
      }
      // toolCalls was null / empty → treat as plain assistant
    }

    // ── Tool / function response ─────────────────────────────────────
    if (role === "function" || role === "tool") {
      const existingId = msg.tool_call_id || msg.toolCallId || null;
      const resolvedId = pendingId || existingId || `${baseId}_fb_${idCounter++}`;
      const rawContent = msg.content ?? msg.Content;
      normalized.push({
        role: "tool",
        tool_call_id: resolvedId,
        content: typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? ""),
      });
      pendingId = null; // consumed
      continue;
    }

    // ── system / user / plain assistant ──────────────────────────────
    // Strip any stale PascalCase or legacy fields
    const clean = {
      role: role || msg.role || msg.Role,
      content: msg.content ?? msg.Content ?? "",
    };
    // For plain assistant messages (no tool_calls), content MUST be a string.
    // OpenAI rejects { role: "assistant", content: null } when tool_calls is absent.
    // Sanitize timeout/error texts that would otherwise poison the session.
    if (role === "assistant") {
      clean.content = msg.content ?? msg.Content ?? "";
      if (isToolIterationTimeoutText(clean.content)) {
        clean.content = "(previous action timed out or encountered an error)";
      }
    }
    normalized.push(clean);
  }

  // ── Post-processing: heal orphaned tool messages ───────────────────
  // The COMOS .NET client STRIPS tool_calls/function_call from assistant
  // messages when echoing them back in conversation history.  This leaves
  // "naked" assistant messages followed by tool responses — OpenAI rejects
  // these because every role:"tool" must follow an assistant with matching
  // tool_calls[].id.  We fix this by scanning for orphaned tool messages
  // and retroactively inserting tool_calls into the nearest preceding
  // assistant message.
  const placedIds = new Set();
  for (const m of normalized) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) placedIds.add(tc.id);
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].role !== "tool") continue;
    const tcId = normalized[i].tool_call_id;
    if (placedIds.has(tcId)) continue; // already linked

    // Orphaned tool message — find nearest preceding assistant
    for (let j = i - 1; j >= 0; j--) {
      if (normalized[j].role !== "assistant") continue;

      const syntheticCall = {
        id: tcId,
        type: "function",
        function: { name: "_comos_executed_tool", arguments: "{}" },
      };

      if (!normalized[j].tool_calls) {
        // Naked assistant — add tool_calls
        normalized[j].tool_calls = [syntheticCall];
        // Ensure content is null when tool_calls is present (some providers require this)
        if (normalized[j].content === "") normalized[j].content = null;
      } else {
        // Assistant already has tool_calls — append this one
        normalized[j].tool_calls.push(syntheticCall);
      }
      placedIds.add(tcId);
      log(`heal_orphan_tool msg[${i}] tool_call_id=${tcId} → assistant[${j}]`);
      break;
    }
  }

  // ── Safety net: ensure no assistant message has null content without tool_calls ──
  // OpenAI requires content to be a string for assistant messages without tool_calls.
  // After orphan-healing, some assistant messages may still have null content if their
  // tool_calls were stripped by COMOS and no matching tool result was found.
  for (const m of normalized) {
    if (m.role === "assistant" && m.content == null && !m.tool_calls) {
      m.content = "";
    }
  }

  return normalized;
}

/**
 * Build a fabricated tool-call response in the exact format COMOS .NET expects.
 * Includes PascalCase aliases (Role, Content, FunctionCall, toolCalls) and
 * legacy function_call, plus finish_reason="function_call" (not "tool_calls").
 */
function buildFabricatedToolCallResponse(toolName, toolArgs, model) {
  const toolCallId = `call_shim_${Date.now()}`;
  const argsStr = typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs);
  return {
    id: `chatcmpl-shim-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "serviceipid-gateway",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        Role: "assistant",
        content: "",
        Content: "",
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: { name: toolName, arguments: argsStr },
        }],
        toolCalls: [{
          id: toolCallId,
          type: "function",
          function: { name: toolName, arguments: argsStr },
        }],
        function_call: { name: toolName, arguments: argsStr },
        FunctionCall: { name: toolName, arguments: argsStr },
      },
      finish_reason: "function_call",
    }],
  };
}

function adaptRawCompletionForComos(rawBuffer, parsedRequest, sessionKey) {
  try {
    const parsed = JSON.parse(rawBuffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.choices)) {
      return { buffer: rawBuffer, changed: false };
    }

    const { names: allowedNames, byLower: allowedToolsMap } = getAllowedToolInfo(parsedRequest || {});
    const idPrefix = `call_${Date.now()}`;
    let changed = false;
    let choicesWithToolCalls = 0;
    let droppedToolCalls = 0;

    for (let i = 0; i < parsed.choices.length; i++) {
      const choice = parsed.choices[i];
      if (!choice || typeof choice !== "object") continue;
      const msg = choice.message;
      if (!msg || typeof msg !== "object") continue;

      let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;

      // If provider returned only legacy function_call, mirror it to tool_calls.
      if ((!toolCalls || toolCalls.length === 0) && msg.function_call) {
        const normalizedLegacy = normalizeFunctionCall(msg.function_call, allowedToolsMap);
        if (normalizedLegacy) {
          toolCalls = [{
            id: `${idPrefix}_${i}_0`,
            type: "function",
            function: normalizedLegacy,
          }];
          msg.tool_calls = toolCalls;
          changed = true;
        } else {
          delete msg.function_call;
          changed = true;
        }
      }

      if (!toolCalls || toolCalls.length === 0) {
        // Even without tool_calls, add PascalCase aliases for COMOS .NET
        if (!("Role" in msg)) { msg.Role = msg.role; changed = true; }
        if (!("Content" in msg)) { msg.Content = msg.content; changed = true; }
        continue;
      }

      const normalizedToolCalls = [];
      for (let j = 0; j < toolCalls.length; j++) {
        const normalized = normalizeToolCall(toolCalls[j], `${i}_${j}`, allowedToolsMap, idPrefix);
        if (normalized) {
          normalizedToolCalls.push(normalized);
        } else {
          droppedToolCalls++;
        }
      }

      if (!normalizedToolCalls.length) {
        // Provider requested tools that are not in COMOS native tools for this turn.
        delete msg.tool_calls;
        delete msg.function_call;
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
          choice.finish_reason = "stop";
        }
        if (typeof msg.content !== "string" || !msg.content.trim()) {
          msg.content = "Could not map the call to a valid native COMOS function.";
        }
        changed = true;
        continue;
      }

      const firstCall = normalizedToolCalls[0].function;
      msg.tool_calls = normalizedToolCalls;
      msg.toolCalls = normalizedToolCalls; // PascalCase alias for .NET
      msg.function_call = {
        name: firstCall.name,
        arguments: firstCall.arguments,
      };
      msg.FunctionCall = msg.function_call; // PascalCase alias for .NET
      if (msg.content == null) {
        msg.content = "";
      }
      msg.Content = msg.content; // PascalCase alias
      msg.Role = msg.role;       // PascalCase alias

      // Old COMOS clients may expect legacy finish_reason.
      if (choice.finish_reason === "tool_calls" || !choice.finish_reason) {
        choice.finish_reason = "function_call";
      }

      choicesWithToolCalls++;
      changed = true;
    }

    if (!changed) {
      return { buffer: rawBuffer, changed: false };
    }

    // ── Enrich attribute tool_calls with systemUID from conversation context ──
    const requestMessages = (parsedRequest && (parsedRequest.messages || parsedRequest.Messages)) || [];
    if (enrichAttributeToolCalls(parsed, requestMessages, sessionKey)) {
      changed = true;
    }

    // ── Log detailed tool_call arguments for diagnostics ──────────
    for (const choice of parsed.choices) {
      const m = choice && choice.message;
      if (!m || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        log(`outgoing_tool_call session=${sessionKey} id=${tc.id} name=${fn.name} args=${String(fn.arguments || "{}").substring(0, 300)}`);
      }
    }

    const outBuffer = Buffer.from(JSON.stringify(parsed), "utf8");
    log(
      `raw_llm_compat_applied session=${sessionKey} ` +
      `tool_choices=${choicesWithToolCalls} dropped=${droppedToolCalls} ` +
      `allowed=[${allowedNames.join(",")}]`
    );
    return { buffer: outBuffer, changed: true };
  } catch (err) {
    log(`raw_llm_compat_skip session=${sessionKey} err=${err.message}`);
    return { buffer: rawBuffer, changed: false };
  }
}

// ── Pending PDF sessions (two-step digitization) ───────────────────────────
// Map<sessionId, { pdfAttachment, filename, userMessage, storedAt }>
const pendingPdfs = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min expiry

// ── Pending push results (auto-deliver on next /completions) ─────────────
// Map<sessionId, { body, header, storedAt }>
// When a background job finishes while the user isn't polling, we queue the
// result here.  The next /completions call from that session dequeues and
// returns it immediately without forwarding to the LLM.
const pendingPushResults = new Map();
const PUSH_TTL_MS = 20 * 60 * 1000; // 20 min — keeps result available after restart

// ── Active digitization jobs (background processing) ───────────────────────
// Map<sessionId, { filename, diagramType, startedAt, status, result, error }>
// status: "processing" | "completed" | "error"
const activeDigitizations = new Map();
const ACTIVE_TTL_MS = 15 * 60 * 1000; // 15 min expiry
const stateFile = path.join(logDir, "active_digitizations.json");

// ── Completed analysis cache — stores data for post-analysis import ────────
// Map<sessionId, { analysisId, excelUrl, excelFileId, excelLocalPath, items, diagramType, storedAt }>
const completedAnalyses = new Map();
const analysisStateFile = path.join(logDir, "completed_analyses.json");

// ── Power Automate Bridge — command queue ─────────────────────────────────
// Map<commandId, { id, status, command, sessionId, result, error, created, callbackUrl }>
// status: "pending" | "executing" | "done" | "error"
// Used exclusively by comos-pa-bridge.js — no existing routes read this Map.
const bridgeCommandQueue = new Map();
const BRIDGE_TTL_MS = 60 * 60 * 1000; // 1 hour — auto-expire stale entries

// ── Pending navigation: tracks sessions where we fabricated objects_with_name
//    as a fast search step for a "Go to X" intent. The eval handler will
//    chain into navigate_to_comos_object_by_systemUID when the result arrives.
const pendingNavigation = new Map();
const NAV_TTL_MS = 60 * 1000; // 1 minute — auto-expire stale entries

function buildCachedImportPayload(cached) {
  const items = Array.isArray(cached && cached.items) ? cached.items : [];
  if (items.length === 0) return "";
  const isElectrical = String(cached && cached.diagramType || "").toLowerCase() === "electrical";

  // TSV line format per row:
  // tag \t descricao \t SystemFullName \t x_mm \t y_mm \t from \t to
  const lines = items.map((it) => {
    const descriptionValue = isElectrical ? "" : (it.descricao || "");
    const cols = [
      it.tag || "",
      descriptionValue,
      it.SystemFullName || "",
      Number.isFinite(Number(it.x_mm)) ? String(it.x_mm) : "0",
      Number.isFinite(Number(it.y_mm)) ? String(it.y_mm) : "0",
      it.from || "",
      it.to || "",
    ];
    return cols
      .map((v) => String(v).replace(/\t/g, " ").replace(/[\r\n]/g, " "))
      .join("\t");
  });

  const payload = Buffer.from(lines.join("\n"), "utf8").toString("base64");
  return `__CACHE_TSV_B64__:${payload}`;
}

/**
 * Build TSV payload for tags-only hierarchy creation.
 * Format: tag \t descricao \t SystemFullName (3 columns, no coordinates)
 */
function buildTagsOnlyPayload(cached) {
  const items = Array.isArray(cached && cached.items) ? cached.items : [];
  if (items.length === 0) return "";

  const lines = items
    .filter((it) => it.tag && it.SystemFullName)
    .map((it) => {
      const cols = [
        it.tag || "",
        it.descricao || "",
        it.SystemFullName || "",
      ];
      return cols
        .map((v) => String(v).replace(/\t/g, " ").replace(/[\r\n]/g, " "))
        .join("\t");
    });

  if (lines.length === 0) return "";

  const payload = Buffer.from(lines.join("\n"), "utf8").toString("base64");
  return `__TAGS_TSV_B64__:${payload}`;
}

function assistantAskedImportConfirmation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "assistant") continue;
    const txt = String(m.content || m.Content || "").toLowerCase();
    if ((txt.includes("confirma") || txt.includes("confirm")) &&
        (txt.includes("importa") || txt.includes("import"))) {
      return true;
    }
    break;
  }
  return false;
}

/**
 * Extract a document identifier (SystemUID or human name like FA.020 / =A1.10)
 * from the current message and conversation history.
 * Returns the raw string as-is — COMOS DLL's ResolveDocument handles both.
 */
function extractRecentDocumentUid(rawMsg, messages) {
  const uidRegex = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])([A-Z0-9]{8,12})\b/i;

  // Pattern: "diagrama FA.020", "document GTA-F265-EL-EF-H1-0001", "diagram =A1.10", etc.
  // Limit raised to 80 chars to handle long hyphenated names like GTA-F265-EL-EF-H1-0001-REV5.00
  const namedDocRegex = /(?:diagrama|diagram[ao]?|documento|document|drawing|desenho|folha|sheet)\s*[:=]?\s*([=A-Za-z0-9_.\-\/]{2,80})/i;
  // Direct standalone pattern: =FA.020, FA.020, GTA-F265-EL-EF-H1-0001-REV5.00
  // Initial letter block up to 8 chars, rest up to 60 chars to cover long hyphenated names
  const standaloneDocRegex = /\b(=?[A-Za-z]{1,8}[._\-][A-Za-z0-9._\-]{1,60})\b/;

  function tryExtract(text) {
    const t = String(text || "");
    // 1. SystemUID (alphanumeric mixed 8-12)
    const uid = t.match(uidRegex);
    if (uid) return uid[1];
    // 2. Named pattern: "diagram FA.020"
    const named = t.match(namedDocRegex);
    if (named) return named[1].replace(/[,;]$/, "")
    // 3. Standalone doc name like FA.020 or =A1.10
    const standalone = t.match(standaloneDocRegex);
    if (standalone) return standalone[1];
    return null;
  }

  const direct = tryExtract(rawMsg);
  if (direct) return direct;

  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "user") continue;
    const txt = String(m.content || m.Content || "");
    const match = tryExtract(txt);
    if (match) return match;
  }
  return "";
}

function detectPortugueseText(text) {
  const t = String(text || "").toLowerCase();
  return /\b(qual|valor|atributo|navegue|navegar|altere|alterar|mude|modifique|objeto|documento|bomba|pot[eê]ncia)\b/.test(t);
}

function extractRecentObjectSystemUID(rawMsg, messages) {
  const uidRegex = /\bA[A-Z0-9]{9}\b/i;
  const withLabelRegex = /SystemUID\s*[:=]\s*([A-Z0-9]{8,12})/i;

  const directLabel = String(rawMsg || "").match(withLabelRegex);
  if (directLabel) return directLabel[1];
  const directUid = String(rawMsg || "").match(uidRegex);
  if (directUid) return directUid[0];
  return "";
}

function isAttributeValueIntent(text) {
  const t = String(text || "").toLowerCase();
  // Broad detection: user asks for an attribute value of an object
  // Pattern 1: explicit ask verb + attribute keyword
  const asksValue = /\b(qual|value|valor|what\s+is|what's|whats|show|get|read|ler|obter|consulte|consultar|me\s+diga|tell\s+me|retrieve|fetch|buscar)\b/.test(t);
  const hasAttrSignal = /\b(attribute|atribut|shaft\s*power|pot[eê]ncia|power|modelo|model|rated|general\s*notes?|notas?\s*gerais?|pressure|press[aã]o|voltage|tens[aã]o|current|corrente|flow|vaz[aã]o|temperature|temperatura|speed|velocidade|efficiency|efici[eê]ncia|weight|peso|diameter|di[aâ]metro|capacity|capacidade|head|height|material|design\s*data|dados\s*de\s*projeto)\b/.test(t);
  // Pattern 2: "what's the X of Y" where Y is an object tag — GENERIC (no keyword list needed)
  // Matches: "what's the operation mode of PC001", "qual o tipo de operação de P-101", etc.
  const asksAboutTag = /\b(what|qual|whats|what's)\b.*\b[A-Z]{1,4}[- ]?\d{2,5}\b/i.test(String(text || ""));
  // Pattern 3: "X of TAG" with an ask verb — detects any attribute name before an object tag
  const genericAttrOfTag = asksValue && /\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/i.test(String(text || ""));
  return (asksValue && hasAttrSignal) || asksAboutTag || genericAttrOfTag;
}

// Extract attribute name and object tag from a user query
// e.g. "Whats the Shaft Power of pump P-101?" → { objectTag: "P-101", attributeName: "Shaft Power" }
function extractAttributeAndObject(text) {
  const t = String(text || "").trim().replace(/[?!]+$/g, "");
  // Extract object tag: P-101, B-6506, XV-101, etc.
  const tagMatch = t.match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
  const objectTag = tagMatch ? tagMatch[1] : "";
  // Remove ask verbs, articles, object references to isolate attribute name
  let attrPart = t
    .replace(/^(what(s|\s+is|['’]s)?|qual\s*([eéoa]\s+)?|show(\s+me)?|get|read|ler|obter|tell\s+me|navigate\s+to(\s+the)?|ir\s+para|retrieve|fetch|buscar)\s+/i, "")
    .replace(/\b(the|o|a|os|as)\s+/gi, "")
    .replace(/\b(of|from|da|do|de|para|on)\s+(the\s+)?(pump|bomba|motor|valve|válvula|equipment|objeto|object|equipamento)?\s*[A-Z]{0,4}[- ]?\d{0,5}[A-Z]?\s*$/i, "")
    .replace(/\b(attribute|atributo)\b\s*/gi, "")
    .trim();
  return { objectTag, attributeName: attrPart };
}

function isAttributeNavigationIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\b(navigate|go\s+to|open|ir|naveg|abra|mostrar)\b/.test(t) && /\b(attribute|atribut)\b/.test(t);
}

// ── Pure navigation intent: "Go to AG005", "Navegar para P-101" ──────────
// Detects requests to navigate to an object (NOT attribute navigation).
// Used to fabricate fast objects_with_name → navigate_by_systemUID chain
// instead of the slow navigate_to_comos_object_by_name tree scan.
function isPureNavigationIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  // Must have a navigation verb
  const hasNavVerb = /\b(go\s+to|navigate\s+to|ir\s+para|v[aá]\s+para|navegu?e?\s*(para|at[eé])|abr[ai]r?|open|select|selecionar?)\b/i.test(t);
  if (!hasNavVerb) return false;
  // Must NOT be about attributes
  if (/\b(attribute|atribut|valor|value)\b/i.test(t)) return false;
  // Must NOT be about documents/reports (different tool)
  if (/\b(document|documento|report|relatório|diagram|diagrama)\b/i.test(t)) return false;
  // Must have an object tag to navigate to
  return /\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/i.test(t);
}

// Extract the navigation target tag from text like "Go to AG005" → "AG005"
function extractNavigationTarget(text) {
  const t = String(text || "").trim();
  const tagMatch = t.match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
  return tagMatch ? tagMatch[1] : "";
}

// Generate name variations for navigation retries.
// COMOS object names may differ from how users type them:
//   "PC-001" in hierarchy display → "PC001" in Name property (or vice-versa)
// Given a tag, returns alternative forms with different separators.
function generateNavigationNameVariations(tag) {
  const t = String(tag || "").trim();
  const m = t.match(/^([A-Za-z]+)([- ]?)(\d+[A-Za-z]?)$/);
  if (!m) return [];
  const prefix = m[1].toUpperCase();
  const digits = m[3];
  const sep = m[2]; // current separator: "", "-", or " "
  const variations = [];
  // Priority: if has separator, try without first; if no separator, try with hyphen first
  if (sep) {
    variations.push(prefix + digits);                                    // PC-001 → PC001
    variations.push(prefix + (sep === "-" ? " " : "-") + digits);   // other separator
  } else {
    variations.push(prefix + "-" + digits);  // PC001 → PC-001
    variations.push(prefix + " " + digits);  // PC001 → PC 001
  }
  return variations;
}

function isAttributeWriteIntent(text) {
  const t = String(text || "").toLowerCase();
  const writeVerb = /\b(set|update|change|edit|alter|altere|alterar|mude|modifique|defina|ajuste)\b/.test(t) || /\bpara\b/.test(t);
  const attrSignal = /\b(attribute|atribut|valor|value|shaft\s*power|pot[eê]ncia|power|modelo|model|transmission|transmiss[aã]o)\b/.test(t);
  return writeVerb && attrSignal;
}

// ── Extract write parameters from user text ──────────────────────────
// "Set Power transmission of PC001 to 75" → { objectTag:"PC001", attributeName:"Power transmission", newValue:"75" }
function extractWriteParams(text) {
  const t = String(text || "").trim();
  // 1. Extract object tag (e.g. PC001, P-101, M001)
  const tagMatch = t.match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
  const objectTag = tagMatch ? tagMatch[1] : "";
  // 2. Extract newValue: everything after the LAST "to"/"para"/"=" before end
  const parts = t.split(/\b(?:to|para)\s+/i);
  const newValue = parts.length > 1 ? parts[parts.length - 1].trim().replace(/\.$/, "") : "";
  // 3. Extract attributeName: strip write verb, "attribute/atributo", "of TAG…" and "to VALUE"
  let rest = t
    .replace(/^(set|update|change|edit|alter[ea]?r?|mude|modifique|defina|ajust[ea]r?)\s+(the\s+|o\s+|a\s+)?/i, "")
    .trim();
  rest = rest.replace(/\b(attribute|atributo)\s*/gi, "").trim();
  rest = rest.replace(/\b(of|de|from|da|do)\s+(the\s+)?(pump\s+|motor\s+|valve\s+|bomba\s+)?[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b.*/i, "").trim();
  rest = rest.replace(/\b(to|para|=)\s+.*$/i, "").trim();
  return { objectTag, attributeName: rest, newValue };
}

// ── Multi-step intent detection ──────────────────────────────────────
// Detects requests with multiple actions/steps joined by connectors.
// These MUST go to the agentic LLM for reasoning — fabrication can only
// handle a single action per request.
// Examples: "Navigate to GM-015 and then to PC-001"
//           "Open P-101 and get its shaft power"
//           "Go to B-6506, then list its attributes"
function isMultiStepIntent(text) {
  const t = String(text || "").trim();
  // Count distinct object tags (A-Z prefix + digits) in the text
  const tagMatches = t.match(/\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/gi) || [];
  // Deduplicate tags (case-insensitive, ignoring separators)
  const uniqueTags = [...new Set(tagMatches.map(tag => tag.replace(/[-\s]/g, "").toUpperCase()))];
  // Multi-step connectors (EN + PT-BR)
  const hasConnector = /\b(and\s+then|then|after\s+that|afterwards|next|also|e\s+depois|depois|em\s+seguida|e\s+tamb[eé]m|tamb[eé]m|ap[oó]s\s+isso|a\s+seguir)\b/i.test(t);
  // Multiple action verbs separated by connectors/commas
  const multiVerb = /\b(navigate|go|open|get|show|list|read|set|ir|naveg|abr|obter|mostr|ler|defin)\b.*\b(and|then|,|e\s+depois|depois|e\s+tamb[eé]m|em\s+seguida)\b.*\b(navigate|go|open|get|show|list|read|set|ir|naveg|abr|obter|mostr|ler|defin|to)\b/i.test(t);
  // 2+ unique tags with a connector → multi-step
  if (uniqueTags.length >= 2 && hasConnector) return true;
  // Multiple verbs with connectors → multi-step
  if (multiVerb) return true;
  // Comma-separated commands: "navigate to X, navigate to Y"
  const commaActions = t.split(/[,;]/).filter(p => p.trim().length > 5);
  if (commaActions.length >= 2) {
    const actionCount = commaActions.filter(p =>
      /\b(navigate|go|open|get|show|list|read|set|ir|naveg|abr|obter|mostr|ler|defin|what|qual)\b/i.test(p)
    ).length;
    if (actionCount >= 2) return true;
  }
  return false;
}

// ── Document navigation intent: "open document X", "abrir documento X" ──
// Different from isPureNavigationIntent because documents use navigate_to_comos_document_by_name.
function isDocumentNavigationIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasNavVerb = /\b(go\s+to|navigate\s+to|open|ir\s+para|v[aá]\s+para|navegu?e?\s*(para|at[eé])|abr[ai]r?|select|selecionar?)\b/i.test(t);
  const hasDocSignal = /\b(document|documento|diagram|diagrama|drawing|desenho|p&id|pid|folha|sheet)\b/i.test(t);
  if (!hasNavVerb || !hasDocSignal) return false;
  // Exclude attribute intents
  if (/\b(attribute|atribut|valor|value)\b/i.test(t)) return false;
  return true;
}

// Extract document name from text like "open document AA_001" → "AA_001"
function extractDocumentTarget(text) {
  const t = String(text || "").trim();
  // Try quoted name first
  const quoted = t.match(/["""']([^"""']{1,80})["""']/);
  if (quoted) return quoted[1].trim();
  // Try after "document/documento" keyword
  const afterKeyword = t.match(/\b(?:document|documento|diagram[ae]?|drawing|desenho|folha|sheet|p&id|pid)\s+([A-Za-z0-9_\-.]+(?:\s+[A-Za-z0-9_\-.]+)?)/i);
  if (afterKeyword) return afterKeyword[1].trim();
  // Try alphanumeric tag pattern
  const tag = t.match(/\b([A-Z]{1,6}[_-]?\d{2,5}[A-Za-z_-]*)\b/i);
  return tag ? tag[1] : "";
}

// ── Report intent: "open report X", "abrir relatório X" ──
function isReportOpenIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasReportSignal = /\b(report|relat[oó]rio|gerar\s+relat[oó]rio|generate\s+report)\b/i.test(t);
  const hasAction = /\b(open|abr[ai]r?|gerar|generate|run|executar|rodar|show|mostrar|exibir)\b/i.test(t);
  return hasReportSignal && hasAction;
}

// ── Report TwoDC intent: "open report in TwoDC", "abrir relatório no TwoDC" ──
function isReportTwoDCIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\b(twodc|two\s*dc|2dc)\b/i.test(t) && /\b(report|relat[oó]rio)\b/i.test(t);
}

// Extract report name from text
function extractReportTarget(text) {
  const t = String(text || "").trim();
  const quoted = t.match(/["""']([^"""']{1,80})["""']/);
  if (quoted) return quoted[1].trim();
  const afterKeyword = t.match(/\b(?:report|relat[oó]rio)\s+([A-Za-z0-9_\-.]+(?:\s+[A-Za-z0-9_\-.]+)?)/i);
  if (afterKeyword) return afterKeyword[1].trim();
  return "";
}

// ── Revision intents ──
function isShowRevisionIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasRevision = /\b(revis[ãa]o|revision|rev)\b/i.test(t);
  const hasShow = /\b(show|mostrar|exibir|last|[uú]ltim[ao]|current|atual|ver|see|check|checar|consultar)\b/i.test(t);
  return hasRevision && hasShow;
}

function isCreateRevisionIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasRevision = /\b(revis[ãa]o|revision|rev)\b/i.test(t);
  const hasCreate = /\b(create|criar|nova?|new|gerar|generate|iniciar|start)\b/i.test(t);
  return hasRevision && hasCreate;
}

// ── Printer intent: "list printers", "listar impressoras" ──
function isPrinterIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\b(printer|impressora|paper|papel|printers|impressoras)\b/i.test(t);
}

// ── Query export intent: "export query X", "exportar consulta" ──
function isQueryExportIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasExport = /\b(export|exportar|download|baixar|gerar\s+excel)\b/i.test(t);
  const hasQuery = /\b(query|consulta|queries|relat[oó]rio.*excel|excel)\b/i.test(t);
  return hasExport && hasQuery;
}

// Extract query name from text
function extractQueryTarget(text) {
  const t = String(text || "").trim();
  const quoted = t.match(/["""']([^"""']{1,80})["""']/);
  if (quoted) return quoted[1].trim();
  const afterKeyword = t.match(/\b(?:query|consulta)\s+([A-Za-z0-9_\-.]+(?:\s+[A-Za-z0-9_\-.]+)?)/i);
  if (afterKeyword) return afterKeyword[1].trim();
  return "";
}

// ── SystemUID navigation intent: detects hex-like COMOS SystemUIDs ──
function isSystemUIDNavigationIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasNavVerb = /\b(go\s+to|navigate\s+to|ir\s+para|v[aá]\s+para|navegu?e?\s*(?:para|at[eé])|abr[ai]r?|open|select|selecionar?)\b/i.test(t);
  if (!hasNavVerb) return false;
  // SystemUID pattern: alphanumeric, typically 8+ chars, mix of letters and numbers (e.g. A541598NS5)
  return /\b[A-Z0-9]{6,20}\b/i.test(t) && /\b(?:systemuid|uid|system\s+uid)\b/i.test(t);
}

function extractAttributeQueryText(text) {
  const raw = String(text || "").trim().replace(/[?]+$/g, "");
  const cleaned = raw
    .replace(/^(qual(\s+é|\s+o|\s+a)?|what(\s+is|['’]s)?|show|get|obter|me\s+diga|diga|tell\s+me)\s+/i, "")
    .replace(/\b(do|da|de|of)\s+(objeto|equipamento|object|pump|p-?\d+)\b/ig, "")
    .trim();
  return cleaned || raw;
}

function hasAttributeWriteTool(toolNames) {
  const list = Array.isArray(toolNames) ? toolNames : [];
  return list.some((name) => /(?:set|update|change|edit).*(?:attribute|attr)|(?:attribute|attr).*(?:set|update|change|edit)/i.test(String(name || "")));
}

// ── Detect when user explicitly asks to see/list attributes of an object ────
// "list attributes of PC001", "show me the attributes", "provide a list of attributes",
// "quais atributos", "listar atributos", "mostra os atributos preenchidos", etc.
function isListAttributesIntent(text) {
  const t = String(text || "").toLowerCase();
  // EN patterns
  const enList = /\b(list|show|give|provide|get|display|what\s+are|bring)\b.*\b(attributes?|specs?|specifications?|properties?)\b/.test(t);
  const enReverse = /\b(attributes?|specs?|specifications?|properties?)\b.*\b(list|show|give|provide|get|display|bring)\b/.test(t);
  // PT patterns
  const ptList = /\b(list[ae]r?|mostr[ae]r?|exib[ie]r?|tra(?:ga|zer)|fornec|quais?|d[eê]\s*(?:me|a|o))\b.*\b(atribut|especifica[çc]|propriedade)/.test(t);
  const ptReverse = /\b(atribut|especifica[çc]|propriedade).*\b(list[ae]r?|mostr[ae]r?|exib[ie]r?|tra(?:ga|zer)|fornec|quais?)\b/.test(t);
  // Direct: "attributes of X", "atributos de X"
  const directAsk = /\b(attributes?|atributos?)\b.*\b(of|d[eoa])\b.*\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/i.test(String(text || ""));
  return enList || enReverse || ptList || ptReverse || directAsk;
}

function isObjectCountIntent(text) {
  const t = String(text || "").toLowerCase();
  const hasCountSignal =
    /\b(how\s+many|how\s+much|quant(?:os|as)?|quantidade\s+de|quantity|count|number\s+of|n[uú]mero\s+de|numero\s+de|contagem|qtd\.?|qtde\.?|total\s+de|total)\b/.test(t);
  const hasObjectSignal =
    /\b(objects?|objetos?|object|objeto|equipment|equipamentos?|items?|itens?|tags?)\b/.test(t);
  const hasQuotedTarget = /["“”'][^"“”']{1,80}["“”']/.test(t);
  const inferredTarget = extractLooseObjectNameForCountQuery(t) || extractObjectNameForCountQuery(t);
  return hasCountSignal && (hasObjectSignal || hasQuotedTarget || Boolean(inferredTarget));
}

function sanitizeCountObjectNameCandidate(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^["“”'`]+|["“”'`]+$/g, "")
    .replace(/[?.,;:!]+$/g, "")
    .trim();
  if (!cleaned) return "";

  const lower = cleaned.toLowerCase();
  const stop = new Set([
    "object", "objects", "objeto", "objetos", "item", "items", "itens", "tag", "tags",
    "project", "projeto", "plant", "planta", "this", "this project", "this plant",
    "nesse", "neste", "nesta", "projeto", "planta", "de", "named", "called",
    "com", "nome", "chamado", "chamados", "do", "we", "have", "there", "are",
    "how", "many", "count", "number", "of", "quantos", "quantas", "temos", "existem",
    "ha", "há", "in", "this", "nesse", "neste", "na", "no", "da", "do",
  ]);
  if (stop.has(lower)) return "";

  return cleaned;
}

function normalizeLooseCountTarget(value) {
  const raw = sanitizeCountObjectNameCandidate(value);
  if (!raw) return "";
  const lower = raw.toLowerCase();

  const directMap = {
    "pumps": "pump",
    "pump": "pump",
    "bombas": "bomba",
    "bomba": "bomba",
    "valves": "valve",
    "valve": "valve",
    "válvulas": "válvula",
    "valvulas": "valvula",
    "válvula": "válvula",
    "valvula": "valvula",
    "motors": "motor",
    "motor": "motor",
    "motores": "motor",
    "instruments": "instrument",
    "instrument": "instrument",
    "instrumentos": "instrumento",
    "instrumento": "instrumento",
    "equipments": "equipment",
    "equipment": "equipment",
    "equipamentos": "equipamento",
    "equipamento": "equipamento",
  };
  if (directMap[lower]) return directMap[lower];

  if (lower.length > 3 && /s$/.test(lower)) {
    return lower.slice(0, -1);
  }
  return lower;
}

function extractLooseObjectNameForCountQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const candidates = [
    /(?:how\s+many|number\s+of|count\s+of)\s+([A-Za-zÀ-ÿ0-9_.\-/]{2,60})\b/i,
    /(?:quant(?:os|as)?|quantidade\s+de|n[uú]mero\s+de|numero\s+de|qtd\.?|qtde\.?)\s+([A-Za-zÀ-ÿ0-9_.\-/]{2,60})\b/i,
    /\b([A-Za-zÀ-ÿ0-9_.\-/]{2,60})\s+(?:do\s+we\s+have|are\s+there|temos|existem?|h[aá])\b/i,
    /\bcount\s+([A-Za-zÀ-ÿ0-9_.\-/]{2,60})\b/i,
    /\bcontar\s+([A-Za-zÀ-ÿ0-9_.\-/]{2,60})\b/i,
  ];

  for (const re of candidates) {
    const m = raw.match(re);
    if (!m || !m[1]) continue;
    const normalized = normalizeLooseCountTarget(m[1]);
    if (normalized) return normalized;
  }
  return "";
}

function extractObjectNameForCountQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const genericNoTarget = /(?:how\s+many|count|number\s+of|quant(?:os|as)?|quantidade\s+de|n[uú]mero\s+de|numero\s+de|qtd\.?|qtde\.?).*(?:objects?|objetos?)\s*(?:do\s+we\s+have\??|temos\??|existem\??|h[aá]\??|in\s+this\s+(?:project|plant)\??|nesse\s+(?:projeto|planta)\??|neste\s+(?:projeto|planta)\??)$/i.test(raw);
  if (genericNoTarget) return "";

  const quoted = raw.match(/["“”']([^"“”']{1,80})["“”']/);
  if (quoted && quoted[1]) {
    const v = sanitizeCountObjectNameCandidate(quoted[1]);
    if (v) return v;
  }

  const patterns = [
    /(?:qtd\.?|qtde\.?)\s+de\s+(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})/i,
    /(?:objects?|objetos?)\s+(?:named|called|com\s+nome|chamados?)\s+([A-Za-z0-9_.\-/]{2,60})/i,
    /(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})\s+(?:exist|do\s+we\s+have|there\s+are|in\s+this\s+project|in\s+this\s+plant)/i,
    /(?:quant(?:os|as)?|n[uú]mero\s+de|numero\s+de|total\s+de)\s+(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})/i,
    /(?:how\s+many|count\s+of)\s+(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})/i,
    /(?:existem?|have)\s+(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})/i,
    /(?:how\s+many|count|number\s+of)\s+([A-Za-z0-9_.\-/]{2,60})\s+(?:objects?|items?|tags?)/i,
    /(?:quant(?:os|as)?|quantidade\s+de|n[uú]mero\s+de|numero\s+de|qtd\.?|qtde\.?|total\s+de)\s+([A-Za-z0-9_.\-/]{2,60})\s+(?:objetos?|itens?|tags?)/i,
    /(?:how\s+many)\s+([A-Za-z0-9_.\-/]{2,60})\s+(?:do\s+we\s+have|are\s+there)/i,
    /(?:quant(?:os|as)?)\s+([A-Za-z0-9_.\-/]{2,60})\s+(?:temos|existem?|h[aá])/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      const v = sanitizeCountObjectNameCandidate(m[1]);
      if (v) return v;
    }
  }

  const tail = raw.match(/(?:objects?|objetos?)\s+([A-Za-z0-9_.\-/]{2,60})\??$/i);
  if (tail && tail[1]) {
    const v = sanitizeCountObjectNameCandidate(tail[1]);
    if (v) return v;
  }

  return "";
}

function isFilteredObjectCountIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!isObjectCountIntent(t)) return false;
  const hasNumericUnit = /\b\d+(?:[.,]\d+)?\s*(kw|hp|bar|v|a|m3\/h|m³\/h|kg\/h|kgh|°c|c)\b/i.test(t);
  const hasAttributeWord = /\b(power|pot[eê]ncia|pressure|press[aã]o|voltage|tens[aã]o|current|corrente|flow|vaz[aã]o|model|modelo|type|tipo|class|classe)\b/i.test(t);
  const hasFilterConnector = /\b(with|where|whose|that\s+have|de|com|cuja|cujas|que\s+tem|que\s+tenham)\b/i.test(t);
  return hasNumericUnit || (hasAttributeWord && hasFilterConnector);
}

function extractAttributeFilterFromCountQuery(text) {
  const raw = String(text || "");
  const numUnit = raw.match(/\b(\d+(?:[.,]\d+)?)\s*(kw|hp|bar|v|a|m3\/h|m³\/h|kg\/h|kgh|°c|c)\b/i);
  const normalizedValue = numUnit ? `${numUnit[1].replace(',', '.')} ${String(numUnit[2]).toLowerCase()}` : "";

  const lower = raw.toLowerCase();
  let attr = "";
  if (/\b(power|pot[eê]ncia)\b/.test(lower) || /\b(kw|hp)\b/.test(lower)) attr = "power";
  else if (/\b(pressure|press[aã]o|bar)\b/.test(lower)) attr = "pressure";
  else if (/\b(flow|vaz[aã]o|m3\/h|m³\/h|kg\/h|kgh)\b/.test(lower)) attr = "flow";
  else if (/\b(voltage|tens[aã]o|\bv\b)\b/.test(lower)) attr = "voltage";
  else if (/\b(current|corrente|\ba\b)\b/.test(lower)) attr = "current";
  else if (/\b(model|modelo)\b/.test(lower)) attr = "model";

  if (attr && normalizedValue) return `${attr} = ${normalizedValue}`;
  if (attr) return attr;
  if (normalizedValue) return normalizedValue;
  return "";
}

function hasFilterCapableTools(toolNames) {
  const list = Array.isArray(toolNames) ? toolNames.map((n) => String(n || "").toLowerCase()) : [];
  const hasObjects = list.includes("objects_with_name");
  const hasAttributeRead = list.includes("value_of_attribute_by_name_or_description");
  const hasDirectFilter = list.some((n) => /query|filter|where|search|count_.*attribute|attribute_.*count/.test(n));
  return hasDirectFilter || (hasObjects && hasAttributeRead);
}

// ── RAG (Document knowledge) integration ─────────────────────────────────
/**
 * Detect EXPLICIT document/RAG signals — phrases that unambiguously mean
 * the user wants RAG knowledge, not a COMOS tool/attribute lookup.
 * This is checked BEFORE attribute fabrication to prevent false routing.
 * Examples:
 *   "according to the documents, what is PC-001?" → true
 *   "in the documents, what is the pressure of P-201?" → true
 *   "what is the shaft power of P-101?" → false (no doc signal)
 */
function hasExplicitDocumentSignals(text) {
  const t = String(text || "").toLowerCase();
  return /\b(according\s+to\s+(the\s+)?(documents?|documentos?|manual|manuai?s?|specification|especifica[çc])|in\s+the\s+(documents?|manual|files?)|n[oa]s?\s+(documentos?|manuai?s?|arquivos?)|segundo\s+(os?\s+)?(documentos?|manual)|conforme\s+(os?\s+)?(documentos?|manual)|de\s+acordo\s+com\s+(os?\s+)?(documentos?|manual)|com\s+base\s+n[oa]s?\s+(documentos?|manual)|search\s+(the\s+)?documents?|buscar?\s+(nos?\s+)?documentos?|pesquisar?\s+(nos?\s+)?documentos?|consult[ae]r?\s+(os?\s+)?documentos?|consult\s+(the\s+)?documents?)\b/i.test(t);
}

/**
 * Detect if the user is asking a question that should be answered from
 * project documents (RAG).  Returns true for knowledge/content questions
 * that are NOT tool-actionable (not navigation, not attribute lookup, not count).
 */
function isDocumentKnowledgeIntent(text) {
  const t = String(text || "").toLowerCase();

  // PRIORITY: explicit document signals always win, even if the query
  // also looks like an attribute request (e.g. "get PC-001 according to the documents")
  if (hasExplicitDocumentSignals(t)) return true;

  // Exclude clearly tool-actionable intents (only when NO explicit doc signals)
  if (isAttributeValueIntent(t)) return false;
  if (isAttributeNavigationIntent(t)) return false;
  if (isObjectCountIntent(t)) return false;
  if (isAttributeWriteIntent(t)) return false;
  if (detectCircuitGenerationIntent(t)) return false;
  if (detectConnectionIntent(t)) return false;
  if (detectInteractiveDrawingIntent(t)) return false;
  // Exclude new tool-actionable intents (documents, reports, revisions, printers, queries)
  if (isDocumentNavigationIntent(t)) return false;
  if (isReportOpenIntent(t)) return false;
  if (isReportTwoDCIntent(t)) return false;
  if (isShowRevisionIntent(t)) return false;
  if (isCreateRevisionIntent(t)) return false;
  if (isPrinterIntent(t)) return false;
  if (isQueryExportIntent(t)) return false;
  if (isListAttributesIntent(t)) return false;

  // Direct RAG triggers — user explicitly asking for RAG / document search
  const ragDirect = /\b(rag|search\s+rag|buscar?\s+rag|pesquisar?\s+rag|search\s+documents?|buscar?\s+documentos?|pesquisar?\s+documentos?|consult[ae]r?\s+documentos?|consult\s+documents?)\b/i.test(t);
  if (ragDirect) return true;

  // Meta-questions about available documents ("which documents", "list documents", etc.)
  const ragMeta = /\b(which\s+documents?|quais\s+documentos?|list\s+(?:the\s+)?documents?|list[ae]r?\s+(?:os\s+)?documentos?|what\s+documents?\s+(?:do|are|can)|que\s+documentos?\s+(?:tem|tenho|temos|possu[io])|have\s+access|tem\s+acesso|documentos?\s+dispon[ií]ve(?:l|is)|available\s+documents?)\b/i.test(t);
  if (ragMeta) return true;

  // Positive signals — user asking about document content / specifications / procedures
  // NOTE: plurals (documentos, especificações, etc.) handled with optional "s"/"es"
  const docSignals = /\b(documents?|documentos?|especifica[çc][ãa]o|especifica[çc][õo]es|specifications?|datasheets?|data\s*sheets?|procedimentos?|procedures?|manuai?s?|normas?|standards?|requisitos?|requirements?|relat[oó]rios?|reports?|memorial|descritivos?|list[ae]\s+de\s+materi(?:al|ais)|material\s+list|scope|escopo|folha\s+de\s+dados|drawing\s+list|lista\s+de\s+desenhos|projeto\s+b[aá]sico|basic\s+design|detail\s+design|projeto\s+detalhado|p&id\s+description|descri[çc][ãa]o|diz\s+o\s+documento|conte[uú]dos?|contents?|what\s+does.*say|o\s+que.*diz|segundo\s+o|according\s+to|conforme|de\s+acordo\s+com|menciona|mentions?|refer[eê]ncias?|references?|rag\s+doc|n[oa]s?\s+documentos?|in\s+the\s+documents?|n[oa]s?\s+arquivos?|in\s+the\s+files?|baseado\s+n[oa]s?|com\s+base\s+n[oa]s?|vari[aá]ve(?:l|is)\s+de\s+opera[çc][ãa]o|opera[çc][ãa]o\s+d[aoe]|condi[çc][õo]es\s+de\s+opera[çc][ãa]o|operating\s+conditions?)\b/i.test(t);
  // General knowledge questions (that mention equipment tags like P-201)
  const hasEquipmentTag = /\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/i.test(t);
  const knowledgeSignals = /\b(what\s+is|o\s+que\s+[eé]|quais?\s+(?:[eé]|s[ãa]o)|how\s+does|como\s+funciona|explain|explique|qual\s+[eé]\s+a?\s*(?:press[ãa]o|temperatura|vaz[ãa]o|pot[eê]ncia|capacidade|voltagem)|what\s+(?:is\s+the|are\s+the)\s+(?:pressure|temperature|flow|power|capacity|voltage|specification)|quais\s+(?:s[ãa]o\s+)?(?:as|os)\s+(?:vari[aá]ve|par[aâ]metro|dados?|condi[çc][õo]es))\b/i.test(t) && !/\b(navigate|navegar|abrir|open|go\s+to|ir\s+para|v[aá]\s+para)\b/i.test(t);

  return docSignals || knowledgeSignals;
}

/**
 * Detect meta-questions asking what documents are available / indexed.
 * These need a different handler — list files instead of vector search.
 */
function isRagDocumentListIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\b(which\s+documents?|quais\s+documentos?|list\s+(?:the\s+)?documents?|list[ae]r?\s+(?:os\s+)?documentos?|what\s+documents?\s+(?:do|are|can)|que\s+documentos?\s+(?:tem|tenho|temos|possu[io])|have\s+access|tem\s+acesso|documentos?\s+dispon[ií]ve(?:l|is)|available\s+documents?|indexed\s+documents?|documentos?\s+indexados?)\b/i.test(t);
}

/**
 * Fetch the list of indexed RAG documents from the gateway.
 * Returns a formatted string for the system prompt, or empty on failure.
 */
async function fetchRagDocumentList(gatewayBase) {
  try {
    const resp = await fetch(`${gatewayBase}/comos/rag-documents`, { method: "GET" });
    if (!resp.ok) return "";
    const data = await resp.json();
    const docs = data.documents || data;
    if (!Array.isArray(docs) || docs.length === 0) return "";
    let ctx = "\n\nINDEXED DOCUMENTS (available for knowledge queries):\n";
    ctx += "The following documents are indexed and searchable. The user can ask questions about their content.\n\n";
    for (const d of docs) {
      const name = d.file || d.name || "unknown";
      const size = d.size_kb ? ` (${d.size_kb} KB)` : "";
      const chunks = d.chunks ? ` — ${d.chunks} chunks` : "";
      ctx += `  • ${name}${size}${chunks}\n`;
    }
    ctx += "\nTell the user which documents are available and suggest they ask specific questions about the content.\n";
    return ctx;
  } catch (err) {
    log(`rag_doclist_error: ${err.message}`);
    return "";
  }
}

/**
 * Build an enriched RAG query from the current user text + conversation context.
 * For follow-up questions ("when was it developed?"), pull key topics from
 * recent assistant/user messages so the vector search has useful terms.
 */
function buildEnrichedRagQuery(currentText, messages) {
  const t = String(currentText || "");
  // If the current query is already long enough (>40 chars) or has specific
  // terms, use it as-is — it likely has enough context.
  if (t.length > 40) return t;
  if (/\b[A-Z]{2,}[- ]?\d+|IEEE|ASME|API|NFPA|IEC|ASTM|DIN|ABNT/i.test(t)) return t;

  // Collect topic keywords from recent conversation (last 6 messages)
  const list = Array.isArray(messages) ? messages : [];
  const recentMsgs = list.slice(-6);
  const topics = [];
  for (const m of recentMsgs) {
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const content = String(m.content || m.Content || "");
    if (!content) continue;
    // Extract standard references (IEEE C2, API 610, etc.)
    const stdMatches = content.match(/\b(?:IEEE|ASME|API|NFPA|IEC|ASTM|DIN|ABNT|NBR|NESC)\s*[A-Z]?\d*[A-Z]?\b/gi);
    if (stdMatches) topics.push(...stdMatches);
    // Extract equipment tags (P-201, PC001, etc.)
    const tagMatches = content.match(/\b[A-Z]{1,4}[- ]?\d{2,5}[A-Z]?\b/g);
    if (tagMatches) topics.push(...tagMatches);
    // Extract quoted terms
    const quotedMatches = content.match(/"([^"]{3,40})"/g);
    if (quotedMatches) topics.push(...quotedMatches.map(q => q.replace(/"/g, "")));
    // Extract capitalized proper nouns from assistant responses
    if (role === "assistant") {
      const nounMatches = content.match(/\b(?:National|Electrical|Safety|Code|Engineering|Specification|Procedure|Cooling|Water|Centrifugal|Pump)\b/gi);
      if (nounMatches) topics.push(...nounMatches.slice(0, 3));
    }
  }
  if (topics.length === 0) return t;
  // Deduplicate and limit
  const unique = [...new Set(topics.map(x => x.trim()))].slice(0, 5);
  const enriched = `${t} (context: ${unique.join(", ")})`;
  return enriched;
}

/**
 * Fetch relevant document chunks from the RAG gateway endpoint.
 * Returns the context string to inject, or empty string on failure.
 */
async function fetchRagContext(query, gatewayBase, topK = 5) {
  try {
    const resp = await fetch(`${gatewayBase}/comos/rag-query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK, min_score: 0.3 }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return "";

    let ctx = "\n\nDOCUMENT KNOWLEDGE (from indexed COMOS project documents):\n";
    ctx += "Use the following excerpts to answer the user's question. Cite the source file and page.\n\n";
    for (const r of data.results) {
      const src = r.source_file || "unknown";
      const page = r.page ? ` (page ${r.page})` : "";
      const score = r.score ? ` [relevance: ${r.score}]` : "";
      ctx += `--- [${src}${page}]${score} ---\n${r.text}\n\n`;
    }
    return ctx;
  } catch (err) {
    log(`rag_fetch_error: ${err.message}`);
    return "";
  }
}

function getLastUserMessageText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "user") continue;
    const c = m.content ?? m.Content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const txt = c
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") return String(part.text || part.content || "");
          return "";
        })
        .join(" ")
        .trim();
      if (txt) return txt;
    }
  }
  return "";
}

/** Check if text is a simple follow-up confirmation ("yes", "sim", "make it now", etc.) */
function isFollowUpConfirmation(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(sim|yes|ok|okay|pode|pode\s+sim|confirmo|confirm|faz|faça|faz\s+agora|faça\s+agora|do\s+it|make\s+it|make\s+it\s+now|go\s+ahead|execute|run|run\s+it|roda|executa|vai|go|please|por\s+favor|1)$/i.test(t);
}

/**
 * Scan earlier user messages (not just the last) for a pending count intent
 * that was never successfully resolved. Returns the count target if found.
 * IMPORTANT: If any tool/function result exists AFTER the count intent message,
 * the intent is considered already satisfied and is skipped.
 */
function scanPendingCountIntentInHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  // Walk backwards through user messages looking for count intent
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "user") continue;
    const c = typeof (m.content ?? m.Content) === "string" ? (m.content ?? m.Content) : "";
    if (!c) continue;
    if (isObjectCountIntent(c)) {
      // Check if a tool result exists AFTER this message (intent already satisfied)
      let alreadySatisfied = false;
      for (let j = i + 1; j < list.length; j++) {
        const jr = String((list[j] || {}).role || (list[j] || {}).Role || "").toLowerCase();
        if (jr === "tool" || jr === "function") {
          alreadySatisfied = true;
          break;
        }
      }
      if (alreadySatisfied) continue; // skip — this count was already executed
      const exact = extractObjectNameForCountQuery(c);
      const loose = extractLooseObjectNameForCountQuery(c);
      const target = exact || loose;
      if (target) return target;
    }
  }
  return "";
}

function parseLatestToolResult(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "tool" && role !== "function") continue;
    const content = String(m.content || m.Content || "").trim();

    // Try JSON-like payload first
    try {
      const normalized = content
        .replace(/^\{\s*/, "{")
        .replace(/\s*=\s*/g, ":")
        .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, "$1\"$2\":")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      const obj = JSON.parse(normalized);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const key of Object.keys(obj)) {
          out[String(key)] = obj[key];
          out[String(key).toLowerCase()] = obj[key];
        }
        const successVal = typeof out.success !== "undefined" ? out.success : out["success"];
        const sourceTagVal = out.sourcetag || out.sourceTag || out.SourceTag || out["source_tag"];
        const targetTagVal = out.targettag || out.targetTag || out.TargetTag || out["target_tag"];
        const connectedVal = out.connected;
        const errorVal = out.error || out.Error || "";

        if (
          typeof successVal !== "undefined" ||
          typeof connectedVal !== "undefined" ||
          typeof sourceTagVal !== "undefined" ||
          typeof targetTagVal !== "undefined"
        ) {
          return {
            success: typeof successVal === "boolean" ? successVal : undefined,
            connected: typeof connectedVal === "boolean" ? connectedVal : undefined,
            sourceTag: typeof sourceTagVal !== "undefined" ? String(sourceTagVal).trim() : "",
            targetTag: typeof targetTagVal !== "undefined" ? String(targetTagVal).trim() : "",
            error: String(errorVal || "").trim(),
            message: String(out.message || out.Message || "").trim(),
          };
        }
      }
    } catch { }

    // Fallback for COMOS text style: supports '=' or ':' and mixed key casing.
    const successFalse = /\bsuccess\s*[:=]\s*false\b/i.test(content);
    const successTrue = /\bsuccess\s*[:=]\s*true\b/i.test(content);
    const connectedFalse = /\bconnected\s*[:=]\s*false\b/i.test(content);
    const connectedTrue = /\bconnected\s*[:=]\s*true\b/i.test(content);

    const srcMatch = content.match(/\bsourceTag\b\s*[:=]\s*([^,}\n]+)/i);
    const tgtMatch = content.match(/\btargetTag\b\s*[:=]\s*([^,}\n]+)/i);
    const errMatch = content.match(/\berror\b\s*[:=]\s*([^,}\n]+)/i);
    const msgMatch = content.match(/\bmessage\b\s*[:=]\s*([^}\n]+)/i);

    if (
      successFalse || successTrue || connectedFalse || connectedTrue ||
      srcMatch || tgtMatch || errMatch
    ) {
      return {
        success: successTrue ? true : (successFalse ? false : undefined),
        connected: connectedTrue ? true : (connectedFalse ? false : undefined),
        sourceTag: srcMatch ? srcMatch[1].trim().replace(/^['"`]|['"`]$/g, "") : "",
        targetTag: tgtMatch ? tgtMatch[1].trim().replace(/^['"`]|['"`]$/g, "") : "",
        error: errMatch ? errMatch[1].trim().replace(/^['"`]|['"`]$/g, "") : "",
        message: msgMatch ? msgMatch[1].trim().replace(/^['"`]|['"`]$/g, "") : "",
      };
    }
  }
  return null;
}

function normalizeTagForCompare(tag) {
  return String(tag || "").trim().toLowerCase();
}

function parseLatestConnectToolResult(messages, pendingConnection) {
  const list = Array.isArray(messages) ? messages : [];
  const pendingSrc = normalizeTagForCompare(pendingConnection && pendingConnection.sourceTag);
  const pendingTgt = normalizeTagForCompare(pendingConnection && pendingConnection.targetTag);
  const pendingCallId = String((pendingConnection && pendingConnection.toolCallId) || "").trim();

  function parseCandidateMessage(m, allowLooseForMatchedCallId) {
    const raw = String(m.content || m.Content || "").trim();
    if (!raw) return null;

    const parsed = parseLatestToolResult([m]);
    const msgText = String((parsed && (parsed.message || parsed.error)) || "");
    const fullText = `${msgText} ${raw}`;

    const hasConnectSignature =
      !!(parsed && (parsed.sourceTag || parsed.targetTag || parsed.connected)) ||
      /\bconnect(?:ed|ion|objects)?\b|\bconnector\b|\bEB0[12]\b|\bsourceTag\b|\btargetTag\b/i.test(fullText);

    if (!parsed) return null;

    if (!hasConnectSignature) {
      const hasFailureShape =
        typeof parsed.success !== "undefined" ||
        !!String(parsed.error || "").trim();
      if (!(allowLooseForMatchedCallId && hasFailureShape)) {
        return null;
      }
    }

    const src = normalizeTagForCompare(parsed.sourceTag);
    const tgt = normalizeTagForCompare(parsed.targetTag);

    if (pendingSrc && src && src !== pendingSrc) return null;
    if (pendingTgt && tgt && tgt !== pendingTgt) return null;

    const hasExplicitTags = !!(parsed.sourceTag && parsed.targetTag);
    const isConnected = !!(
      parsed.connected === true ||
      (parsed.success === true && hasExplicitTags && !/not\s+persisted|could\s+not\s+be\s+created/i.test(fullText))
    );

    return {
      success: parsed.success === true,
      connected: isConnected,
      sourceTag: parsed.sourceTag || "",
      targetTag: parsed.targetTag || "",
      error: parsed.error || (isConnected ? "" : "Connection was not confirmed by tool result."),
    };
  }

  if (pendingCallId) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i] || {};
      const role = String(m.role || m.Role || "").toLowerCase();
      if (role !== "tool" && role !== "function") continue;
      const tcid = String(m.tool_call_id || m.toolCallId || m.ToolCallId || "").trim();
      if (!tcid || tcid !== pendingCallId) continue;
      const candidate = parseCandidateMessage(m, true);
      if (candidate) return candidate;
      return {
        success: false,
        connected: false,
        sourceTag: pendingConnection?.sourceTag || "",
        targetTag: pendingConnection?.targetTag || "",
        error: "Connection tool result found, but could not be interpreted.",
      };
    }
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "tool" && role !== "function") continue;
    const candidate = parseCandidateMessage(m, false);
    if (!candidate) continue;
    return candidate;
  }

  return null;
}

function hasImportToolInMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const role = String(m?.role || m?.Role || "").toLowerCase();

    if (role === "assistant") {
      const tc = m?.tool_calls || m?.toolCalls;
      if (Array.isArray(tc) && tc.some(c => (c?.function?.name || "") === "import_equipment_from_excel")) {
        return true;
      }
      const fcName = m?.function_call?.name || m?.FunctionCall?.Name || m?.FunctionCall?.name || "";
      if (fcName === "import_equipment_from_excel") return true;
    }

    if (role === "tool" || role === "function") {
      const txt = JSON.stringify(m || {});
      if (txt.includes("import_equipment_from_excel")) return true;
    }
  }
  return false;
}

function parseImportCount(result) {
  if (!result || typeof result !== "object") return null;
  const candidateKeys = [
    "createdCount", "created", "importedCount", "imported", "totalCreated", "count", "itemsCount",
  ];
  for (const key of candidateKeys) {
    const val = result[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string" && /^\d+$/.test(val)) return Number(val);
  }
  return null;
}

function parseImportDiagnosticsFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "tool" && role !== "function") continue;

    const tcId = String(m.tool_call_id || m.toolCallId || m.ToolCallId || "").trim();
    const content = String(m.content || m.Content || "");
    const text = `${tcId} ${content}`;

    const hasImportSignal =
      /import_equipment_from_excel|extract_and_create_tags/i.test(text) ||
      (/\bcreated\s*[:=]\s*\d+/i.test(content) && /\berrorCount\s*[:=]\s*\d+/i.test(content));
    if (!hasImportSignal) continue;

    const createdMatch = content.match(/\bcreated\s*[:=]\s*(\d+)/i);
    const errorCountMatch = content.match(/\berrorCount\s*[:=]\s*(\d+)/i);
    const cdeviceMatch = /CDevice\s+not\s+found\s+for\s+SFN\s+'?([^'\n;]+)'?/i.exec(content);

    return {
      hasImportSignal: true,
      created: createdMatch ? Number(createdMatch[1]) : null,
      errorCount: errorCountMatch ? Number(errorCountMatch[1]) : null,
      cdeviceNotFound: !!cdeviceMatch,
      missingSfn: cdeviceMatch ? String(cdeviceMatch[1] || "").trim() : "",
    };
  }
  return null;
}

function hasAnyToolResultMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    const role = String(m?.role || m?.Role || "").toLowerCase();
    return role === "tool" || role === "function";
  });
}

function hasImportToolRegistered(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list.some((t) => {
    const name = t?.function?.name || t?.Function?.Name || t?.Function?.name || "";
    return String(name).trim() === "import_equipment_from_excel";
  });
}
const ANALYSIS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Interactive Drawing sessions ─────────────────────────────────────────────
// Map<sessionId, { step, docUID, docType, diagramType, drawnObjects[], connections[], storedAt }>
//   step: "ask_document" | "ask_component" | "confirm_match" | "drawing" | "connecting"
const drawingSessions = new Map();
const DRAWING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

// ── NL Circuit Generation sessions (two-step: ask diagram type then generate) ─
// Map<sessionId, { prompt, storedAt }>
const pendingCircuits = new Map();
const PENDING_CIRCUIT_TTL_MS = 10 * 60 * 1000; // 10 min

// ── Active circuit generation jobs (background) ─────────────────────────────
// Map<sessionId, { prompt, diagramType, startedAt, status, result, error }>
const activeCircuitGenerations = new Map();
const CIRCUIT_GEN_TTL_MS = 15 * 60 * 1000; // 15 min

// Persist completedAnalyses to disk so they survive shim restarts
function saveAnalysisCache() {
  try {
    const data = {};
    for (const [key, val] of completedAnalyses) {
      data[key] = val;
    }
    fs.writeFileSync(analysisStateFile, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`analysis_cache_save_error ${err.message}`);
  }
}

function loadAnalysisCache() {
  try {
    if (!fs.existsSync(analysisStateFile)) return;
    const raw = fs.readFileSync(analysisStateFile, "utf-8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [key, val] of Object.entries(data)) {
      if (now - val.storedAt > ANALYSIS_CACHE_TTL_MS) {
        log(`analysis_cache_load_skip_expired session=${key}`);
        continue;
      }
      completedAnalyses.set(key, val);
      const itemCount = Array.isArray(val.items) ? val.items.length : 0;
      log(`analysis_cache_load_restored session=${key} items=${itemCount}`);
    }
  } catch (err) {
    log(`analysis_cache_load_error ${err.message}`);
  }
}

// Persist activeDigitizations to disk so they survive shim restarts
function saveDigitizationState() {
  try {
    const data = {};
    for (const [key, val] of activeDigitizations) {
      data[key] = val;
    }
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`state_save_error ${err.message}`);
  }
}

// Load persisted state from disk on startup
function loadDigitizationState() {
  try {
    if (!fs.existsSync(stateFile)) return;
    const raw = fs.readFileSync(stateFile, "utf-8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [key, val] of Object.entries(data)) {
      // Skip expired entries
      if (now - val.startedAt > ACTIVE_TTL_MS) {
        log(`state_load_skip_expired session=${key}`);
        continue;
      }
      // Jobs that were "processing" when shim died cannot resume — mark as error
      if (val.status === "processing") {
        val.status = "error";
        val.result = {
          error: true,
          message: "⚠️ The analysis was interrupted because the service restarted. " +
                   "Please send the PDF again to restart digitization.",
        };
        log(`state_load_interrupted session=${key} file=${val.filename}`);
      }
      activeDigitizations.set(key, val);
      log(`state_load_restored session=${key} status=${val.status} file=${val.filename}`);
    }
  } catch (err) {
    log(`state_load_error ${err.message}`);
  }
}

function cleanExpiredPending() {
  const now = Date.now();
  for (const [key, val] of pendingPdfs) {
    if (now - val.storedAt > PENDING_TTL_MS) {
      pendingPdfs.delete(key);
      log(`pending_expired session=${key}`);
    }
  }
  let changed = false;
  for (const [key, val] of activeDigitizations) {
    if (now - val.startedAt > ACTIVE_TTL_MS) {
      activeDigitizations.delete(key);
      log(`active_digitization_expired session=${key}`);
      changed = true;
    }
  }
  if (changed) saveDigitizationState();

  // Clean expired analysis caches
  for (const [key, val] of completedAnalyses) {
    if (now - val.storedAt > ANALYSIS_CACHE_TTL_MS) {
      completedAnalyses.delete(key);
      log(`analysis_cache_expired session=${key}`);
    }
  }

  // Clean expired interactive drawing sessions
  for (const [key, val] of drawingSessions) {
    if (now - val.storedAt > DRAWING_SESSION_TTL_MS) {
      drawingSessions.delete(key);
      log(`drawing_session_expired session=${key}`);
    }
  }

  // Clean expired pending navigation entries
  for (const [key, val] of pendingNavigation) {
    if (now - val.timestamp > NAV_TTL_MS) {
      pendingNavigation.delete(key);
    }
  }

  // Clean expired pending circuit generation requests
  for (const [key, val] of pendingCircuits) {
    if (now - val.storedAt > PENDING_CIRCUIT_TTL_MS) {
      pendingCircuits.delete(key);
      log(`pending_circuit_expired session=${key}`);
    }
  }

  // Clean expired active circuit generation jobs
  for (const [key, val] of activeCircuitGenerations) {
    if (now - val.startedAt > CIRCUIT_GEN_TTL_MS) {
      activeCircuitGenerations.delete(key);
      log(`active_circuit_gen_expired session=${key}`);
    }
  }

  // Clean expired pending push results
  for (const [key, val] of pendingPushResults) {
    if (now - val.storedAt > PUSH_TTL_MS) {
      pendingPushResults.delete(key);
      log(`pending_push_expired session=${key}`);
    }
  }
}

function formatElapsed(startedAt) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

/**
 * Wait for a background job (entry in activeDigitizations) to leave "processing"
 * state, polling every second up to maxWaitMs (default 30s).
 * Returns true if the job finished (completed/error) within the time window.
 */
function waitForJobCompletion(job, maxWaitMs = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxWaitMs;
    function poll() {
      if (!job || job.status !== "processing") { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(poll, 1000);
    }
    poll();
  });
}

// Start digitization in the background and track it
function startBackgroundDigitization(sessionKey, pdfAttachment, diagramType, userMessage) {
  const filename = pdfAttachment.fileName || pdfAttachment.filename || pdfAttachment.name || "document.pdf";

  const job = {
    filename,
    diagramType,
    startedAt: Date.now(),
    status: "processing",
    result: null,
    error: null,
  };
  activeDigitizations.set(sessionKey, job);
  saveDigitizationState();

  log(`bg_digitize_start session=${sessionKey} file=${filename} type=${diagramType}`);

  // Fire-and-forget — the promise updates job.status when done
  handleDigitization(pdfAttachment, diagramType, userMessage, sessionKey)
    .then((result) => {
      job.status = result.error ? "error" : "completed";
      job.result = result;
      saveDigitizationState();
      log(`bg_digitize_done session=${sessionKey} status=${job.status} elapsed=${formatElapsed(job.startedAt)}`);
      // Queue result for auto-delivery on next /completions call
      activeDigitizations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "digitize-autopush" },
        storedAt: Date.now(),
      });
    })
    .catch((err) => {
      job.status = "error";
      job.result = {
        error: true,
        message: `❌ Unexpected digitization error: ${err.message}`,
      };
      saveDigitizationState();
      log(`bg_digitize_crash session=${sessionKey} err=${err.message}`);
      // Queue error for auto-delivery on next /completions call
      activeDigitizations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(job.result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "digitize-autopush-error" },
        storedAt: Date.now(),
      });
    });

  return job;
}

// ── Background TAG Extraction (option 3) ───────────────────────────────────
function startBackgroundTagExtraction(sessionKey, pdfAttachment, userMessage, diagramType) {
  const filename = pdfAttachment.fileName || pdfAttachment.filename || pdfAttachment.name || "document.pdf";
  // "document" means general doc mode; "tags-only"/"pid" means diagram tag extraction
  const effectiveDiagramType = diagramType === "document" ? "document" : "pid";

  const job = {
    filename,
    diagramType: effectiveDiagramType,
    startedAt: Date.now(),
    status: "processing",
    result: null,
    error: null,
  };
  activeDigitizations.set(sessionKey, job);
  saveDigitizationState();

  log(`bg_tag_extract_start session=${sessionKey} file=${filename} type=${effectiveDiagramType}`);

  handleTagExtraction(pdfAttachment, userMessage, sessionKey, effectiveDiagramType)
    .then((result) => {
      job.status = result.error ? "error" : "completed";
      job.result = result;
      saveDigitizationState();
      log(`bg_tag_extract_done session=${sessionKey} status=${job.status} elapsed=${formatElapsed(job.startedAt)}`);
      // Queue result for auto-delivery on next /completions call
      activeDigitizations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "tags-extract-autopush" },
        storedAt: Date.now(),
      });
    })
    .catch((err) => {
      job.status = "error";
      job.result = {
        error: true,
        message: `❌ Unexpected tag extraction error: ${err.message}`,
      };
      saveDigitizationState();
      log(`bg_tag_extract_crash session=${sessionKey} err=${err.message}`);
      // Queue error for auto-delivery on next /completions call
      activeDigitizations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(job.result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "tags-extract-autopush-error" },
        storedAt: Date.now(),
      });
    });

  return job;
}

async function handleTagExtraction(pdfAttachment, userMessage, sessionKey, diagramType) {
  const filename = pdfAttachment.fileName || pdfAttachment.filename || pdfAttachment.name || "document.pdf";
  const pdfBase64 = pdfAttachment.contentBase64 || pdfAttachment.content_base64 ||
                    pdfAttachment.data || "";
  const effectiveType = diagramType || "pid";

  if (!pdfBase64) {
    return {
      error: true,
      message: "❌ Could not read the PDF content. Please try attaching the file again.",
    };
  }

  log(`tag_extract_start file=${filename} base64_len=${pdfBase64.length} type=${effectiveType}`);

  // Save PDF to temp file
  const tempDir = path.join(os.tmpdir(), "comos_ai_digitize");
  fs.mkdirSync(tempDir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tempPath = path.join(tempDir, `${Date.now()}_tags_${safeName}`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(pdfBase64, "base64"));
    log(`tag_extract_saved_temp ${tempPath}`);
  } catch (err) {
    log(`tag_extract_save_error ${err.message}`);
  }

  const directPayload = fs.existsSync(tempPath)
    ? {
        file_path: tempPath.replace(/\\/g, "/"),
        diagram_type: effectiveType,
        filename,
        use_vector: effectiveType !== "document",
        use_llm_descriptions: true,
      }
    : {
        pdf_base64: pdfBase64,
        diagram_type: effectiveType,
        filename,
        use_vector: effectiveType !== "document",
        use_llm_descriptions: true,
      };

  const method = directPayload.file_path ? "file_path" : "base64";
  log(`tag_extract_call method=${method}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000); // 8 min timeout

    const resp = await fetch(`${gatewayBase}/comos/extract-tags-direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(directPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      log(`tag_extract_error status=${resp.status} body=${errText.substring(0, 500)}`);
      return {
        error: true,
        message: `❌ Tag extraction error: service returned status ${resp.status}.\n` +
                 `Details: ${errText.substring(0, 300)}`,
      };
    }

    const result = await resp.json();
    log(`tag_extract_ok pages=${Array.isArray(result) ? result.length : "?"}`);
    fs.unlink(tempPath, () => {});

    return formatTagExtractionResult(result, filename, sessionKey);
  } catch (err) {
    log(`tag_extract_error ${err.message}`);
    fs.unlink(tempPath, () => {});
    return {
      error: true,
      message: `❌ Tag extraction error: ${err.message}.\n` +
               `Please verify that the ServiceiPID gateway is running on port 8100.`,
    };
  }
}

function formatTagExtractionResult(result, filename, sessionKey) {
  if (!result || (Array.isArray(result) && result.length === 0)) {
    return {
      error: false,
      message: `✅ **Tag extraction complete** — **${filename}**\n\nNo tags were found in the document.`,
    };
  }

  const pages = Array.isArray(result) ? result : [result];
  let totalTags = 0;
  let totalMatched = 0;
  let pidId = null;
  const allItems = [];

  for (const page of pages) {
    const items = page.resultado || page.result || [];
    totalTags += page.tags_found || items.length;
    totalMatched += page.tags_matched || 0;
    if (page.pid_id && !pidId) pidId = page.pid_id;
    for (const item of items) {
      allItems.push(item);
    }
  }

  let msg = `✅ **TAG extraction complete** — **${filename}**\n\n`;
  msg += `🏷️ **Results:**\n`;
  msg += `- Pages analyzed: **${pages.length}**\n`;
  msg += `- Tags found: **${totalTags}**\n`;
  const untaggedCount = allItems.filter(it => (it.is_untagged === true) || String(it.tag || "").startsWith("UNTAGGED-")).length;
  const taggedCount = totalTags - untaggedCount;
  if (untaggedCount > 0) {
    msg += `  - Tagged equipment: **${taggedCount}**\n`;
    msg += `  - Untagged equipment (from text): **${untaggedCount}**\n`;
  }
  msg += `- Tags matched (System): **${totalMatched}**\n`;
  if (pidId) msg += `- Knowledge base ID: **${pidId}**\n`;

  // List sample tags with descriptions
  const sampleItems = [];
  for (const item of allItems) {
    const tag = item.tag || item.TAG || "";
    const desc = item.descricao || item.description || "";
    const sfn = item.SystemFullName || "";
    if (tag && sampleItems.length < 10) {
      let entry = `\`${tag}\``;
      if (desc) entry += ` — ${desc}`;
      if (sfn) entry += ` → \`${sfn}\``;
      sampleItems.push(entry);
    }
  }
  if (sampleItems.length > 0) {
    msg += `\n📋 **Extracted tags:**\n`;
    for (const s of sampleItems) {
      msg += `- ${s}\n`;
    }
    if (allItems.length > sampleItems.length) {
      msg += `- ... and ${allItems.length - sampleItems.length} more\n`;
    }
  }

  // Embed confidence data for interactive table
  const itemsForTable = allItems.filter(
    (it) => it.SystemFullName && it.SystemFullName !== "null"
  );

  const analysisId = `tags-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

  if (itemsForTable.length > 0) {
    const confidenceData = {
      analysisId,
      excelUrl: "",
      items: itemsForTable.map((it) => ({
        tag: it.tag || it.TAG || "",
        descricao: it.descricao || it.Descricao || it.description || "",
        SystemFullName: it.SystemFullName || "",
        "Confiança": it["Confiança"] || it.Confianca || 0,
        Tipo_ref: it.Tipo_ref || "",
        alternatives: (it.alternatives || []).map((alt) => ({
          SystemFullName: alt.SystemFullName || "",
          "Confiança": alt["Confiança"] || alt.Confianca || 0,
          Tipo_ref: alt.Tipo_ref || "",
          Descricao_ref: alt.Descricao_ref || "",
        })),
      })),
    };

    msg += "\n\n```comos-data\n" + JSON.stringify(confidenceData) + "\n```";
  }

  // Store analysis for later import (tags-only = hierarchy only, no drawing)
  if (sessionKey && allItems.length > 0) {
    completedAnalyses.set(sessionKey, {
      analysisId,
      excelUrl: "",
      excelFileId: null,
      excelLocalPath: "",
      items: allItems.map((it) => ({
        tag: it.tag || it.TAG || "",
        descricao: it.descricao || it.Descricao || it.description || "",
        SystemFullName: it.SystemFullName || "",
        Tipo_ref: it.Tipo_ref || "",
        x_mm: 0,
        y_mm: 0,
        from: "",
        to: "",
      })),
      diagramType: "tags-only",
      extractionMode: "tags_only",
      storedAt: Date.now(),
    });
    log(`tags_cached session=${sessionKey} items=${allItems.length}`);
    saveAnalysisCache();
  }

  // Import offer
  msg += "\n\n---\n";
  msg += "🏭 **Would you like to create these objects in the COMOS hierarchy?**\n\n";
  msg += "Since this is a TAG extraction, creation will be **hierarchy only** (no diagram drawing).\n\n";
  msg += "1. **Create automatically** — Uses the native tool to create objects in the COMOS hierarchy\n";
  msg += "2. **Generate VBS script** — I generate a script that creates the objects (run in Object Debugger)\n\n";
  msg += "Just tell me **which diagram** you want to use and which option you prefer.\n";
  msg += "_Example: \"Create in hierarchy, option 1\" or \"Automatic, FA.009\" (automatic import to diagram FA.009)_";

  return { error: false, message: msg };
}

// Check if there's an active digitization and return a status/result message
function checkActiveDigitization(sessionKey, model) {
  if (!activeDigitizations.has(sessionKey)) return null;

  const job = activeDigitizations.get(sessionKey);

  if (job.status === "processing") {
    const elapsed = formatElapsed(job.startedAt);
    const dtLabel = job.diagramType === "tags-only"
      ? "TAG Extraction"
      : (job.diagramType === "electrical" ? "Electrical Diagram" : "P&ID");
    const processLabel = job.diagramType === "tags-only" ? "Tag extraction" : "PDF analysis";
    const msg =
      `⏳ **${dtLabel} in progress...**\n\n` +
      `File **${job.filename}** is being processed.\n` +
      `Elapsed time: **${elapsed}**\n\n` +
      `${processLabel} may take 1 to 5 minutes depending on document complexity. ` +
      `Send any message to check status again.`;
    return { type: "progress", body: buildCompletionResponse(msg, model) };
  }

  if (job.status === "completed" || job.status === "error") {
    const result = job.result;
    activeDigitizations.delete(sessionKey);
    saveDigitizationState();
    return { type: "result", body: buildCompletionResponse(result.message, model) };
  }

  return null;
}

// ── Extract info from parsed request ───────────────────────────────────────
function extractRequestInfo(parsed) {
  const messages = parsed.messages || parsed.Messages || [];
  const sessionId = parsed.sessionId || parsed.SessionId || parsed.session_id ||
                    parsed.conversationId || parsed.ConversationId || null;
  let lastUserMsg = null;
  let attachments = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = (msg.role || msg.Role || "").toLowerCase();
    if (role !== "user") continue;

    const content = msg.content || msg.Content || "";
    if (typeof content === "string") {
      lastUserMsg = content;
    } else if (Array.isArray(content)) {
      const textParts = content.filter(p => p.type === "text").map(p => p.text);
      lastUserMsg = textParts.join(" ");
      // Check for base64 PDF inline (OpenAI multimodal)
      const fileParts = content.filter(p =>
        p.type === "file" || p.type === "document" ||
        (p.type === "image_url" && p.image_url && p.image_url.url &&
         p.image_url.url.includes("application/pdf"))
      );
      attachments.push(...fileParts);
    }

    // COMOS-style per-message attachments
    const msgAtt = msg.attachments || msg.Attachments || [];
    if (msgAtt.length) attachments.push(...msgAtt);
    break;
  }

  // Top-level attachments
  const topAtt = parsed.attachments || parsed.Attachments || [];
  if (topAtt.length) attachments.push(...topAtt);

  // Find PDF among attachments
  const pdfAttachment = attachments.find(a => {
    const name = (a.fileName || a.filename || a.name || "").toLowerCase();
    const mime = (a.mimeType || a.mime_type || a.type || "").toLowerCase();
    return name.endsWith(".pdf") || mime === "application/pdf";
  });

  return { messages, sessionId, lastUserMsg, attachments, pdfAttachment };
}

// ── Extract local PDF file path from message text ──────────────────────────
// Users may type: "Analise o documento C:\Users\foo\bar.pdf" or paste a path
const PDF_PATH_REGEX = /(?:^|[\s"':(])([A-Za-z]:\\[^\s"'<>|*?]+\.pdf)\b/gi;

function extractPdfPathFromMessage(text) {
  if (!text) return null;
  const matches = [...text.matchAll(PDF_PATH_REGEX)];
  if (!matches.length) return null;

  // Take the last match (most likely the one user just typed)
  const filePath = matches[matches.length - 1][1];
  return filePath;
}

function buildAttachmentFromLocalFile(filePath) {
  try {
    const normalizedPath = path.normalize(filePath);
    if (!fs.existsSync(normalizedPath)) {
      log(`local_pdf_not_found ${normalizedPath}`);
      return null;
    }

    const buffer = fs.readFileSync(normalizedPath);
    const base64 = buffer.toString("base64");
    const filename = path.basename(normalizedPath);

    log(`local_pdf_read ${normalizedPath} size=${buffer.length} base64_len=${base64.length}`);

    return {
      fileName: filename,
      mimeType: "application/pdf",
      sizeBytes: buffer.length,
      contentBase64: base64,
      _localPath: normalizedPath,
    };
  } catch (err) {
    log(`local_pdf_read_error ${filePath} => ${err.message}`);
    return null;
  }
}

// ── Detect if this is a diagram type answer ────────────────────────────────
function detectDiagramTypeAnswer(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Direct choices: "1", "2", "3", "4", "p&id", "elétrico", "tags", "document", etc.
  if (/^1$|^p\s*[&/]?\s*id$|^pid$/i.test(lower)) return "pid";
  if (/^2$|^el[eé]tric/i.test(lower)) return "electrical";
  if (/^electrical$/i.test(lower)) return "electrical";
  if (/^3$|^tags?\s*(only|apenas|somente)?$/i.test(lower)) return "tags-only";
  if (/^4$|^doc(ument[oa]?)?$/i.test(lower)) return "document";

  // Contained in a sentence
  if (lower.includes("p&id") || lower.includes("p&id") || /\bpid\b/.test(lower)) return "pid";
  if (lower.includes("elétr") || lower.includes("eletr") || lower.includes("electrical")) return "electrical";
  if (/\b(tags?\s*(only|apenas|somente)|extra[iç][aã]o\s+de\s+tags?|somente\s+tags?|hierarquia\s+apenas)\b/.test(lower)) return "tags-only";
  if (/\b(rfq|requisição|requisi[çc][aã]o|equipment\s*list|lista\s+de\s+equip|spec(ifica[çc][aã]o)?|datasheet|data\s*sheet|documento\s+geral|general\s+doc)\b/.test(lower)) return "document";

  return null;
}

// ── Has PDF attachment? ────────────────────────────────────────────────────
function hasPdfAttachment(info) {
  return info.pdfAttachment != null;
}

function shouldUseElectricalTiles(diagramType, userMessage) {
  if ((diagramType || "").toLowerCase() !== "electrical") return false;

  const text = String(userMessage || "").toLowerCase();
  if (!text) return false;

  if (/\b(sem\s+tiles?|without\s+tiles?|no\s+tiles?|sem\s+quadrantes?|without\s+quadrants?|grid\s*1)\b/.test(text)) {
    return false;
  }

  return /\b(usar\s+quadrantes?|use\s+quadrants?|usar\s+tiles?|use\s+tiles?|an[aá]lise\s+em\s+quadrantes?|analysis\s+in\s+quadrants?)\b/.test(text);
}

function clampGrid(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(6, Math.round(n)));
}

function gridFromQuadrantCount(totalQuadrants) {
  const q = Number(totalQuadrants);
  if (!Number.isFinite(q) || q <= 1) return 1;
  const root = Math.sqrt(q);
  if (Number.isInteger(root)) return clampGrid(root);
  return clampGrid(Math.ceil(root));
}

function resolveElectricalGridOptions(diagramType, userMessage) {
  if ((diagramType || "").toLowerCase() !== "electrical") {
    return { enableQuadrants: false, grid: 3 };
  }

  const text = String(userMessage || "").toLowerCase();
  if (!text) {
    return { enableQuadrants: false, grid: 1 };
  }

  if (/\b(sem\s+tiles?|without\s+tiles?|no\s+tiles?|sem\s+quadrantes?|without\s+quadrants?|sem\s+grid|without\s+grid|grid\s*1)\b/.test(text)) {
    return { enableQuadrants: false, grid: 1 };
  }

  let requestedGrid = null;

  const directGrid = text.match(/\bgrid\s*[:=]?\s*(\d+)\b/);
  if (directGrid) {
    requestedGrid = clampGrid(directGrid[1]);
  }

  if (requestedGrid == null) {
    const nxn = text.match(/\b(\d+)\s*[x×]\s*(\d+)\b/);
    if (nxn) {
      requestedGrid = clampGrid(Math.max(Number(nxn[1]), Number(nxn[2])));
    }
  }

  if (requestedGrid == null) {
    const quadrants = text.match(/\b(\d+)\s*quadrantes?\b/);
    if (quadrants) {
      requestedGrid = gridFromQuadrantCount(quadrants[1]);
    }
  }

  const asksQuadrants = /\b(usar\s+quadrantes?|use\s+quadrants?|usar\s+tiles?|use\s+tiles?|an[aá]lise\s+em\s+quadrantes?|analysis\s+in\s+quadrants?|grid\s+maior|larger\s+grid|bigger\s+grid|mais\s+quadrantes?)\b/.test(text);

  if (!asksQuadrants && requestedGrid == null) {
    return { enableQuadrants: false, grid: 1 };
  }

  if (requestedGrid == null) {
    requestedGrid = 2;
  }

  if (requestedGrid <= 1) {
    return { enableQuadrants: false, grid: 1 };
  }

  return { enableQuadrants: true, grid: requestedGrid };
}

function wantsElectricalCoordinateRefinement(userMessage) {
  const text = String(userMessage || "").toLowerCase();
  if (!text) return false;
  return /\b(refinar\s+coordenadas?|refine\s+coordinates?|geometric\s+refinement|alinhamento\s+pdf|pdf\s+alignment)\b/.test(text);
}

// ── Gateway digitization handler ───────────────────────────────────────────
async function handleDigitization(pdfAttachment, diagramType, userMessage, sessionId) {
  const filename = pdfAttachment.fileName || pdfAttachment.filename || pdfAttachment.name || "document.pdf";
  const pdfBase64 = pdfAttachment.contentBase64 || pdfAttachment.content_base64 ||
                    pdfAttachment.data || "";

  if (!pdfBase64) {
    return {
      error: true,
      message: "❌ Could not read the PDF content. Please try attaching the file again.",
    };
  }

  log(`digitize_start file=${filename} type=${diagramType} base64_len=${pdfBase64.length}`);

  // ── FAST PATH: call /comos/analyze-direct (no MCP spawn, no LLM) ────────
  // Save PDF to temp so gateway can read it via file_path (avoids sending
  // megabytes of base64 over JSON).
  const tempDir = path.join(os.tmpdir(), "comos_ai_digitize");
  fs.mkdirSync(tempDir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tempPath = path.join(tempDir, `${Date.now()}_${safeName}`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(pdfBase64, "base64"));
    log(`digitize_saved_temp ${tempPath}`);
  } catch (err) {
    log(`digitize_save_error ${err.message}`);
  }

  const useElectricalTiles = shouldUseElectricalTiles(diagramType, userMessage);
  const electricalOptions = resolveElectricalGridOptions(diagramType, userMessage);

  const enableElectricalQuadrants = (diagramType || "").toLowerCase() === "electrical"
    ? (electricalOptions.enableQuadrants || useElectricalTiles)
    : false;

  const enableElectricalRefinement = (diagramType || "").toLowerCase() === "electrical"
    ? wantsElectricalCoordinateRefinement(userMessage)
    : false;

  const electricalGrid = (diagramType || "").toLowerCase() === "electrical"
    ? (enableElectricalQuadrants ? electricalOptions.grid : 1)
    : 3;

  // Try file-path based direct call first, then fall back to base64 direct call
  const directPayload = fs.existsSync(tempPath)
    ? {
        file_path: tempPath.replace(/\\/g, "/"),
        diagram_type: diagramType,
        filename,
        grid: electricalGrid,
        enable_electrical_quadrants: enableElectricalQuadrants,
        use_tiles: enableElectricalQuadrants,
        split_by_quadrants: enableElectricalQuadrants,
        use_geometric_refinement_electrical: enableElectricalRefinement,
        use_pdf_alignment: false,
      }
    : {
        pdf_base64: pdfBase64,
        diagram_type: diagramType,
        filename,
        grid: electricalGrid,
        enable_electrical_quadrants: enableElectricalQuadrants,
        use_tiles: enableElectricalQuadrants,
        split_by_quadrants: enableElectricalQuadrants,
        use_geometric_refinement_electrical: enableElectricalRefinement,
        use_pdf_alignment: false,
      };

  const method = directPayload.file_path ? "file_path" : "base64";
  log(`digitize_direct_call method=${method} type=${diagramType} tiles=${enableElectricalQuadrants ? "on" : "off"} grid=${electricalGrid}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12 * 60 * 1000); // 12 min hard timeout

    const resp = await fetch(`${gatewayBase}/comos/analyze-direct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(directPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      log(`digitize_direct_error status=${resp.status} body=${errText.substring(0, 500)}`);
      return {
        error: true,
        message: `❌ Digitization error: the analysis service returned status ${resp.status}.\n` +
                 `Details: ${errText.substring(0, 300)}`,
      };
    }

    const result = await resp.json();
    log(`digitize_ok method=${method} pages=${Array.isArray(result) ? result.length : "?"}`);
    fs.unlink(tempPath, () => {});

    // Format analysis result as a readable message (includes Excel export)
    return await formatAnalysisResult(result, filename, diagramType, sessionId);
  } catch (err) {
    log(`digitize_error ${err.message}`);
    fs.unlink(tempPath, () => {});
    const isConnReset = /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(err.message);
    const errDetail = isConnReset
      ? `❌ The analysis service lost the connection mid-processing (${err.message}).\n\n` +
        `This usually means the PDF is very complex and exhausted the backend's resources.\n` +
        `**Please re-send the same PDF** — a second attempt often succeeds.\n\n` +
        `If it keeps failing, check that the ServiceiPID backend is running on port 8000.`
      : `❌ Digitization error: ${err.message}.\n` +
        `Please verify that the ServiceiPID gateway is running on port 8100.`;
    return { error: true, message: errDetail };
  }
}

// ── Export analysis result to Excel via gateway ────────────────────────────
// Local Excel cache directory (shim-managed, survives gateway restarts)
const EXCEL_LOCAL_CACHE_DIR = path.join(os.tmpdir(), "comos_ai_exports_shim");
try { fs.mkdirSync(EXCEL_LOCAL_CACHE_DIR, { recursive: true }); } catch (_) {}

async function exportToExcel(result, filename, diagramType) {
  try {
    const pages = Array.isArray(result) ? result : [result];
    const safeName = filename.replace(/\.pdf$/i, "") + "_analysis.xlsx";
    const payload = { pages, filename: safeName, diagram_type: diagramType };

    const resp = await fetch(`${gatewayBase}/comos/export-excel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      log(`excel_export_error status=${resp.status}`);
      return null;
    }

    const data = await resp.json();
    // Route download through the shim itself (same origin for CefSharp)
    const downloadUrl = `http://127.0.0.1:${listenPort}/comos/download/${data.file_id}`;

    // ── Immediately resolve and cache the local file path ──
    let localPath = "";
    try {
      const pathResp = await fetch(`${gatewayBase}/comos/excel-path/${data.file_id}`);
      if (pathResp.ok) {
        const pathData = await pathResp.json();
        localPath = pathData.path || "";
        log(`excel_local_path_resolved file_id=${data.file_id} path=${localPath}`);
      }
    } catch (e) { log(`excel_local_path_resolve_warn ${e.message}`); }

    // ── Fallback: download the file to our own local cache ──
    if (!localPath) {
      try {
        const dlResp = await fetch(`${gatewayBase}/comos/download/${data.file_id}`);
        if (dlResp.ok) {
          const buf = Buffer.from(await dlResp.arrayBuffer());
          localPath = path.join(EXCEL_LOCAL_CACHE_DIR, `${data.file_id}_${safeName}`);
          fs.writeFileSync(localPath, buf);
          log(`excel_local_cache_saved path=${localPath} size=${buf.length}`);
        }
      } catch (e) { log(`excel_local_cache_warn ${e.message}`); }
    }

    log(`excel_export_ok file_id=${data.file_id} url=${downloadUrl} localPath=${localPath || "none"}`);
    return { url: downloadUrl, filename: data.filename, fileId: data.file_id, localPath };
  } catch (err) {
    log(`excel_export_error ${err.message}`);
    return null;
  }
}

// Extract file_id from a download URL like http://127.0.0.1:56401/comos/download/<uuid>
function extractFileIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/comos\/download\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/**
 * Resolve the local Excel file path from the analysis cache.
 * Tries multiple strategies:
 *  1. Use cached excelLocalPath if it still exists on disk
 *  2. Resolve from gateway via /comos/excel-path/<file_id>
 *  3. Download from gateway and save to local cache
 *  4. Regenerate Excel from cached items by calling /comos/export-excel
 *
 * Mutates cached.excelLocalPath on success.
 * Returns the absolute path or "" on failure.
 */
async function resolveExcelLocalPath(cached) {
  // Strategy 1: already resolved and file exists
  if (cached.excelLocalPath) {
    try {
      if (fs.existsSync(cached.excelLocalPath)) {
        log(`excel_resolve_strategy=cached path=${cached.excelLocalPath}`);
        return cached.excelLocalPath;
      }
      log(`excel_resolve_cached_missing path=${cached.excelLocalPath}`);
      cached.excelLocalPath = ""; // invalidate stale path
    } catch (_) {}
  }

  // Strategy 2: resolve from gateway by file_id
  if (cached.excelFileId) {
    try {
      const pathResp = await fetch(`${gatewayBase}/comos/excel-path/${cached.excelFileId}`);
      if (pathResp.ok) {
        const pathData = await pathResp.json();
        const p = pathData.path || "";
        if (p && fs.existsSync(p)) {
          cached.excelLocalPath = p;
          log(`excel_resolve_strategy=gateway_path path=${p}`);
          return p;
        }
      }
    } catch (e) { log(`excel_resolve_gateway_path_err ${e.message}`); }
  }

  // Strategy 3: download from gateway and save locally
  if (cached.excelFileId) {
    try {
      const dlResp = await fetch(`${gatewayBase}/comos/download/${cached.excelFileId}`);
      if (dlResp.ok) {
        const buf = Buffer.from(await dlResp.arrayBuffer());
        const localPath = path.join(EXCEL_LOCAL_CACHE_DIR, `${cached.excelFileId}_analysis.xlsx`);
        fs.writeFileSync(localPath, buf);
        cached.excelLocalPath = localPath;
        log(`excel_resolve_strategy=download path=${localPath} size=${buf.length}`);
        return localPath;
      }
    } catch (e) { log(`excel_resolve_download_err ${e.message}`); }
  }

  // Strategy 4: regenerate Excel from cached items
  if (cached.items && cached.items.length > 0) {
    try {
      const pages = [{
        resultado: cached.items.map(it => ({
          tag: it.tag,
          descricao: it.descricao,
          Tipo_ref: it.Tipo_ref,
          SystemFullName: it.SystemFullName,
          x_mm: it.x_mm,
          y_mm: it.y_mm,
          from: it.from || "",
          to: it.to || "",
          "Confiança": 0,
        })),
      }];
      const safeName = `regen_${Date.now()}_analysis.xlsx`;
      const payload = { pages, filename: safeName, diagram_type: cached.diagramType || "electrical" };

      const resp = await fetch(`${gatewayBase}/comos/export-excel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const data = await resp.json();
        // Now download it immediately
        const dlResp2 = await fetch(`${gatewayBase}/comos/download/${data.file_id}`);
        if (dlResp2.ok) {
          const buf = Buffer.from(await dlResp2.arrayBuffer());
          const localPath = path.join(EXCEL_LOCAL_CACHE_DIR, `${data.file_id}_${safeName}`);
          fs.writeFileSync(localPath, buf);
          cached.excelLocalPath = localPath;
          cached.excelFileId = data.file_id;
          log(`excel_resolve_strategy=regenerate path=${localPath} items=${cached.items.length}`);
          return localPath;
        }
      }
    } catch (e) { log(`excel_resolve_regenerate_err ${e.message}`); }
  }

  log(`excel_resolve_FAILED all_strategies_exhausted`);
  return "";
}

// ── Format raw ServiceiPID analysis result into user-friendly message ──────
async function formatAnalysisResult(result, filename, diagramType, sessionKey) {
  const isElectrical = diagramType === "electrical";
  const dtLabel = isElectrical ? "Electrical Diagram" : "P&ID";

  if (!result || (Array.isArray(result) && result.length === 0)) {
    return {
      error: false,
      message: `✅ **Analysis complete** — ${dtLabel}: **${filename}**\n\nNo items were detected in the document.`,
    };
  }

  const pages = Array.isArray(result) ? result : [result];
  let totalItems = 0;
  let totalPipes = 0;
  let pidId = null;

  // Collect ALL items across all pages for the confidence table
  const allItems = [];

  for (const page of pages) {
    const items = page.resultado || page.result || [];
    const pipes = page.pipes || [];
    totalItems += items.length;
    totalPipes += pipes.length;
    if (page.pid_id && !pidId) pidId = page.pid_id;

    for (const item of items) {
      allItems.push(item);
    }
  }

  // Debug: log the first item's structure to help diagnose alternatives
  if (allItems.length > 0) {
    const first = allItems[0];
    const keys = Object.keys(first).join(", ");
    const altCount = Array.isArray(first.alternatives) ? first.alternatives.length : "none";
    log(`format_debug first_item_keys=[${keys}] alternatives=${altCount} total_items=${allItems.length}`);
  }

  let msg = `✅ **Analysis complete** — ${dtLabel}: **${filename}**\n\n`;
  msg += `📊 **Results:**\n`;
  msg += `- Pages analyzed: **${pages.length}**\n`;
  msg += `- ${isElectrical ? "Components" : "Items"} detected: **${totalItems}**\n`;
  if (totalPipes > 0) msg += `- ${isElectrical ? "Connections/wires" : "Pipes/connections"}: **${totalPipes}**\n`;
  if (pidId) msg += `- Knowledge base ID: **${pidId}**\n`;

  // List a few sample items (tags)
  const sampleItems = [];
  for (const page of pages) {
    const items = page.resultado || page.result || [];
    for (const item of items) {
      const tag = item.tag || item.TAG || item.name || item.label || "";
      const type = item.type || item.tipo || item.equipment_type || "";
      if (tag && sampleItems.length < 8) {
        sampleItems.push(`\`${tag}\`${type ? ` (${type})` : ""}`);
      }
    }
  }
  if (sampleItems.length > 0) {
    msg += `\n📋 **Sample ${isElectrical ? "components" : "items"}:** ${sampleItems.join(", ")}`;
    if (totalItems > sampleItems.length) {
      msg += ` and ${totalItems - sampleItems.length} more`;
    }
    msg += `\n`;
  }

  const idLabel = isElectrical ? "diagram" : "P&ID";
  msg += `\nThe analysis data has been stored in the knowledge base. ` +
         `You can query it using the ${idLabel} ID above.`;

  // Export to Excel and include download link
  const excel = await exportToExcel(result, filename, diagramType);
  if (excel) {
    msg += `\n\n📥 **[Download Excel Report](${excel.url})**`;
  }

  // ── Embed confidence/alternatives data for interactive table ──
  // The chat-app.js MutationObserver detects code blocks with language
  // "comos-data", parses the JSON, hides the block, and injects an
  // interactive HTML table with <select> dropdowns.
  // Show table for ALL items that have a SystemFullName (not just those with alternatives).
  const itemsForTable = allItems.filter(
    (it) => it.SystemFullName && it.SystemFullName !== "null"
  );

  const analysisId = `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  let confidenceData = null;

  if (itemsForTable.length > 0) {
    confidenceData = {
      analysisId,
      excelUrl: excel ? excel.url : "",
      items: itemsForTable.map((it) => ({
        tag: it.tag || it.TAG || "",
        descricao: it.descricao || it.Descricao || it.description || "",
        SystemFullName: it.SystemFullName || "",
        "Confiança": it["Confiança"] || it.Confianca || 0,
        Tipo_ref: it.Tipo_ref || "",
        alternatives: (it.alternatives || []).map((alt) => ({
          SystemFullName: alt.SystemFullName || "",
          "Confiança": alt["Confiança"] || alt.Confianca || 0,
          Tipo_ref: alt.Tipo_ref || "",
          Descricao_ref: alt.Descricao_ref || "",
        })),
      })),
    };

    msg += "\n\n```comos-data\n" + JSON.stringify(confidenceData) + "\n```";
    log(`confidence_table_embedded items=${itemsForTable.length} id=${analysisId} altsPresent=${itemsForTable.filter(i => i.alternatives && i.alternatives.length > 0).length}`);
  } else {
    log(`confidence_table_skipped no_items_with_systemfullname total=${allItems.length}`);
  }

  // ── Store analysis data for later import ──────────────────────────────
  const excelFileId = excel ? (excel.fileId || extractFileIdFromUrl(excel.url)) : null;
  const excelLocalPath = excel ? (excel.localPath || "") : "";
  if (sessionKey && allItems.length > 0) {
    completedAnalyses.set(sessionKey, {
      analysisId,
      excelUrl: excel ? excel.url : "",
      excelFileId,
      excelLocalPath,
      items: allItems.map((it) => ({
        tag: it.tag || it.TAG || "",
        descricao: it.descricao || it.Descricao || it.description || "",
        SystemFullName: it.SystemFullName || "",
        Tipo_ref: it.Tipo_ref || "",
        x_mm: it.x_mm || 0,
        y_mm: it.y_mm || 0,
        from: it.from || it.From || "",
        to: it.to || it.To || "",
      })),
      diagramType,
      storedAt: Date.now(),
    });
    log(`analysis_cached session=${sessionKey} items=${allItems.length} excelFileId=${excelFileId || "none"} localPath=${excelLocalPath || "none"}`);
    saveAnalysisCache();
  }

  // ── Append import offer ─────────────────────────────────────────────
  msg += "\n\n---\n";
  msg += "🏭 **Would you like to import these objects into a COMOS diagram?**\n\n";
  msg += "I can help you in two ways:\n";
  msg += "1. **Create automatically** — Uses the native tool to create objects in the COMOS hierarchy\n";
  msg += "2. **Generate VBS script** — I generate a script that creates the objects **and draws them on the diagram** (run in Object Debugger)\n\n";
  msg += "Just tell me **which diagram** you want to use (name or path in COMOS) and which option you prefer.\n";
  msg += "_Example: \"Import to diagram =A1.10, option 1\" or \"Automatic, FA.009\" (automatic import)_";

  return { error: false, message: msg };
}

// ── NL Circuit Generation — detect, generate, import ───────────────────────

/**
 * Detect user intent to generate a complete circuit from natural language.
 * Returns { match: true, diagramType?, prompt } or null.
 *
 * This is distinct from interactive drawing (single-object step-by-step).
 * Circuit generation means describing an entire circuit/diagram to be created
 * at once via the ServiceiPID backend.
 */
function detectCircuitGenerationIntent(msg) {
  if (!msg) return null;
  const lc = msg.toLowerCase();

  // If user explicitly asks for interactive/step-by-step drawing,
  // let the interactive drawing state machine handle it.
  const interactiveHints = [
    /\binteractive\b/,
    /\binteractive\s+(draw|drawing|mode)\b/,
    /\bdrawing\s+mode\b/,
    /\bstep\s*[- ]?by\s*[- ]?step\b/,
    /\bdraw\s+(an?\s+)?(object|component|equipment|device|symbol)\b/,
    /\binterativo\b/,
    /\bmodo\s+interativo\b/,
    /\bdesenho\s+interativo\b/,
    /\bpasso\s+a\s+passo\b/,
    /\bdesenhar\s+(um\s+)?(objeto|componente|equipamento|dispositivo|s[ií]mbolo)\b/,
  ];
  if (interactiveHints.some((p) => p.test(lc))) return null;

  // ── Must match at least one "circuit/diagram type" keyword ──
  const circuitTypePatterns = [
    // Portuguese – specific circuit types
    /partida\s+direta/,
    /partida\s+estrela/,
    /partida\s+compensadora/,
    /partida\s+suave/,
    /partida\s+soft/,
    /inversor\s+de\s+frequ[eê]ncia/,
    /circuito\s+de\s+(pot[eê]ncia|comando|controle|for[cç]a|sinaliza[cç][aã]o)/,
    /parte\s+de\s+(pot[eê]ncia|comando|controle|for[cç]a|sinaliza[cç][aã]o)/,
    /diagrama\s+(de\s+)?(partida|comando|pot[eê]ncia|controle|for[cç]a)/,
    /diagrama\s+completo/,
    /circuito\s+completo/,
    /\bcircuito\s+el[eé]trico\b/,
    /\bgerar\s+(um\s+)?(circuito|diagrama)/,
    /\bgere\s+(um\s+)?(circuito|diagrama)/,
    /\bcriar?\s+(um\s+)?(circuito)/,
    /\bcrie\s+(um\s+)?(circuito)/,
    /\bcriar?\s+a\s+parte\s+de/,
    /\bcrie\s+a\s+parte\s+de/,
    /\bgerar\s+do\s+zero\b/,
    /\bcircuito\s+de\s+\w+/,
    // English – specific circuit types
    /direct\s+start(er)?/,
    /star[\s-]delta\s+start(er)?/,
    /soft\s+start(er)?/,
    /motor\s+start(er)?\s+(circuit|diagram)/,
    /vfd\s+(circuit|diagram)/,
    /power\s+circuit/,
    /control\s+circuit/,
    /command\s+circuit/,
    /complete\s+(circuit|diagram)/,
    /full\s+(circuit|diagram)/,
    /\bgenerate\s+(a\s+)?(circuit|complete\s+diagram|full\s+diagram)/,
    /\bcreate\s+(a\s+)?(circuit|complete\s+diagram|full\s+diagram)/,
    /generate\s+from\s+(scratch|description|text)/,
  ];

  const matchedCircuit = circuitTypePatterns.some((p) => p.test(lc));
  if (!matchedCircuit) return null;

  // ── Determine diagram type from context (default: electrical for circuits) ──
  let diagramType = null;
  if (lc.includes("p&id") || /\bpid\b/.test(lc) || lc.includes("processo") || lc.includes("process")) {
    diagramType = "pid";
  } else if (lc.includes("elétr") || lc.includes("eletr") || lc.includes("electrical") ||
             /partida|circuito|circuit|comando|command|control|potência|potencia|power|for[cç]a|motor\s+start|direct\s+start|star[\s-]delta|soft\s+start|vfd|inversor/.test(lc)) {
    diagramType = "electrical";
  }

  // Build the prompt — use the full user message as the prompt for the LLM
  return {
    match: true,
    diagramType, // may be null → ask user
    prompt: msg.trim(),
  };
}

/**
 * Start NL circuit generation in the background.
 */
function startBackgroundCircuitGeneration(sessionKey, prompt, diagramType) {
  const job = {
    prompt,
    diagramType,
    startedAt: Date.now(),
    status: "processing",
    result: null,
    error: null,
  };
  activeCircuitGenerations.set(sessionKey, job);

  log(`bg_circuit_gen_start session=${sessionKey} type=${diagramType} prompt_len=${prompt.length}`);

  // Fire-and-forget
  handleCircuitGeneration(prompt, diagramType, sessionKey)
    .then((result) => {
      job.status = result.error ? "error" : "completed";
      job.result = result;
      log(`bg_circuit_gen_done session=${sessionKey} status=${job.status} elapsed=${formatElapsed(job.startedAt)}`);
      // Auto-push result on next /completions call
      activeCircuitGenerations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "circuit-gen-autopush" },
        storedAt: Date.now(),
      });
    })
    .catch((err) => {
      job.status = "error";
      job.result = {
        error: true,
        message: `❌ Unexpected circuit generation error: ${err.message}`,
      };
      log(`bg_circuit_gen_crash session=${sessionKey} err=${err.message}`);
      activeCircuitGenerations.delete(sessionKey);
      pendingPushResults.set(sessionKey, {
        body: buildCompletionResponse(job.result.message, defaultModel),
        header: { "X-Comos-Ai-Shim": "circuit-gen-autopush-error" },
        storedAt: Date.now(),
      });
    });

  return job;
}

/**
 * Check active circuit generation and return status/result.
 */
function checkActiveCircuitGeneration(sessionKey, model) {
  if (!activeCircuitGenerations.has(sessionKey)) return null;

  const job = activeCircuitGenerations.get(sessionKey);

  if (job.status === "processing") {
    const elapsed = formatElapsed(job.startedAt);
    const dtLabel = job.diagramType === "electrical" ? "Electrical Diagram" : "P&ID";
    const msg =
      `⏳ **Circuit generation in progress...**\n\n` +
      `Generating ${dtLabel} from description. Elapsed: **${elapsed}**\n\n` +
      `The LLM is creating components, assigning positions, and matching COMOS references.\n` +
      `This may take **1 to 3 minutes**. Send any message to check status.`;
    return { type: "progress", body: buildCompletionResponse(msg, model) };
  }

  if (job.status === "completed" || job.status === "error") {
    const result = job.result;
    activeCircuitGenerations.delete(sessionKey);
    return { type: "result", body: buildCompletionResponse(result.message, model) };
  }

  return null;
}

/**
 * Call the gateway /comos/generate-circuit endpoint and format results.
 * Returns the same structure as handleDigitization — { error, message }.
 */
async function handleCircuitGeneration(prompt, diagramType, sessionKey) {
  log(`circuit_gen_start type=${diagramType} prompt_len=${prompt.length}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min

    const payload = {
      prompt: prompt,
      diagram_type: diagramType,
    };

    const resp = await fetch(`${gatewayBase}/comos/generate-circuit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      log(`circuit_gen_error status=${resp.status} body=${errText.substring(0, 500)}`);
      return {
        error: true,
        message: `❌ Circuit generation error: status ${resp.status}.\n` +
                 `Details: ${errText.substring(0, 300)}`,
      };
    }

    const result = await resp.json();
    log(`circuit_gen_ok pages=${Array.isArray(result) ? result.length : "?"}`);

    // Format using the same function as PDF digitization
    const filename = `NL_circuit_${diagramType}_${Date.now()}`;
    return await formatAnalysisResult(result, filename, diagramType, sessionKey);
  } catch (err) {
    log(`circuit_gen_error ${err.message}`);
    return {
      error: true,
      message: `❌ Circuit generation error: ${err.message}.\n` +
               `Please verify that the ServiceiPID gateway is running on port 8100.`,
    };
  }
}

// ── Interactive Connection — detect, parse, and fabricate ──────────────────

/**
 * Detect if user wants to create a connection between two objects.
 * Returns true if the message is about connecting/wiring objects.
 */
function detectConnectionIntent(msg) {
  if (!msg) return false;
  const lc = msg.toLowerCase();
  const patterns = [
    // Portuguese
    /\bconect(?:ar|e)\b/,                      // conectar, conecte
    /\bliga(?:r|ção)\b/,                        // ligar, ligação
    /\bsaída\s+d[eo]\b/,                        // saída do/de
    /\bentrada\s+d[eo]\b/,                       // entrada do/de
    /\bfio\s+d[eo]\b/,                           // fio do/de
    /\bcabo\s+d[eo]\b/,                           // cabo do/de
    /\bde\s+\S+\s+para\s+\S+/,                   // de X para Y
    /\bconex[aã]o\s+entre\b/,                    // conexão entre
    /\bconex[aã]o\s+d[eo]\b/,                    // conexão do/de
    /\binterligar\b/,
    // English
    /\bconnect\b/,
    /\bwire\b/,
    /\blink\b.*\bto\b/,
    /\boutput\s+of\b/,
    /\binput\s+of\b/,
    /\bconnection\s+(from|between)\b/,
    /\bfrom\s+\S+\s+to\s+\S+/,                   // from X to Y
  ];
  return patterns.some(p => p.test(lc));
}

/**
 * Parse a connection request from user message.
 * Extracts sourceTag (upstream) and targetTag (downstream).
 *
 * Supports patterns like:
 *   "conectar K001 na saída do D001" → source=D001, target=K001
 *   "conecte a saída do D001 na entrada do K001" → source=D001, target=K001
 *   "connect D001 to K001" → source=D001, target=K001
 *   "ligar D001 em K001" → source=D001, target=K001
 *   "de D001 para K001" → source=D001, target=K001
 *
 * The connection direction is always: source.EB02 (output) → target.EB01 (input)
 */
function parseConnectionInput(msg) {
  if (!msg) return null;
  const trimmed = msg.trim();
  const lc = trimmed.toLowerCase();

  // Helper: extract all tag-like tokens from message
  // Tags look like: =M01.Q01, K001, D001, -F1, =A1.K01, etc.
  const TAG_PATTERN = /(?:=?[A-Za-z][\w.-]*\d[\w.-]*)/g;

  // ── Pattern 1: "saída do <source> ... entrada do <target>" or vice versa ──
  // "conecte a saída do D001 na entrada do K001"
  const saidaEntrada = trimmed.match(/sa[ií]da\s+d[eo]\s+([\w=.\-]+).*?entrada\s+d[eo]\s+([\w=.\-]+)/i);
  if (saidaEntrada) {
    return { sourceTag: saidaEntrada[1], targetTag: saidaEntrada[2] };
  }

  // "conecte a entrada do K001 na saída do D001"
  const entradaSaida = trimmed.match(/entrada\s+d[eo]\s+([\w=.\-]+).*?sa[ií]da\s+d[eo]\s+([\w=.\-]+)/i);
  if (entradaSaida) {
    return { sourceTag: entradaSaida[2], targetTag: entradaSaida[1] };
  }

  // ── Pattern 2: "conectar/connect <target> na/to saída/output do/of <source>" ──
  // "conectar K001 na saída do D001" → source=D001, target=K001
  const targetNaSaida = trimmed.match(/(?:conect(?:ar|e)|connect|wire|ligar?)\s+([\w=.\-]+)\s+(?:na|à|a)\s+sa[ií]da\s+d[eo]\s+([\w=.\-]+)/i);
  if (targetNaSaida) {
    return { sourceTag: targetNaSaida[2], targetTag: targetNaSaida[1] };
  }

  // "conectar K001 na entrada do D001" → source=K001, target=D001
  const sourceNaEntrada = trimmed.match(/(?:conect(?:ar|e)|connect|wire|ligar?)\s+([\w=.\-]+)\s+(?:na|à|a)\s+entrada\s+d[eo]\s+([\w=.\-]+)/i);
  if (sourceNaEntrada) {
    return { sourceTag: sourceNaEntrada[1], targetTag: sourceNaEntrada[2] };
  }

  // ── Pattern 3: "output of <source> to <target>" / "from <source> to <target>" ──
  const outputOf = trimmed.match(/output\s+of\s+([\w=.\-]+)\s+to\s+([\w=.\-]+)/i);
  if (outputOf) {
    return { sourceTag: outputOf[1], targetTag: outputOf[2] };
  }

  const fromTo = trimmed.match(/(?:de|from)\s+([\w=.\-]+)\s+(?:para|to|em|in)\s+([\w=.\-]+)/i);
  if (fromTo) {
    return { sourceTag: fromTo[1], targetTag: fromTo[2] };
  }

  // ── Pattern 4: "conectar/connect <A> em/to/with <B>" — A=source, B=target ──
  const connectAtoB = trimmed.match(/(?:conect(?:ar|e)|connect|wire|ligar?|interligar)\s+([\w=.\-]+)\s+(?:em|no|na|to|with|a|ao|com)\s+([\w=.\-]+)/i);
  if (connectAtoB) {
    return { sourceTag: connectAtoB[1], targetTag: connectAtoB[2] };
  }

  // ── Pattern 5: "conexão entre <A> e <B>" ──
  const entre = trimmed.match(/conex[aã]o\s+entre\s+([\w=.\-]+)\s+e\s+([\w=.\-]+)/i);
  if (entre) {
    return { sourceTag: entre[1], targetTag: entre[2] };
  }

  // ── Fallback: Extract any two tag-like tokens ──
  const allTags = [...trimmed.matchAll(TAG_PATTERN)].map(m => m[0]);
  if (allTags.length >= 2) {
    return { sourceTag: allTags[0], targetTag: allTags[1] };
  }

  return null;
}

function isAmbiguousConnectPrompt(msg) {
  if (!msg) return false;
  const lc = msg.trim().toLowerCase();
  return /^(connect|conectar|ligar|wire|link|connected\?|connect\?)$/.test(lc);
}

function isSmallTalkNoise(msg) {
  if (!msg) return false;
  const lc = msg.trim().toLowerCase();
  return /^(what'?s up\??|whats up\??|sup\??|oi\??|ola\??|ol[áa]\??|hello\??|hi\??)$/.test(lc);
}

/**
 * Resolve a tag to an object — first checking drawnObjects (current session),
 * then falling back to a stub for pre-existing objects already on the diagram.
 * This allows connecting to objects that existed before the drawing session started.
 */
function resolveTagForConnection(session, tag) {
  const obj = (session.drawnObjects || []).find(
    o => o.tag && o.tag.toLowerCase() === tag.toLowerCase()
  );
  if (obj) return obj;

  // Not in drawnObjects — check completedAnalyses for this session's SFN data.
  // This covers objects drawn by batch import before interactive mode started.
  const sessionKey = session._sessionKey || "__default__";
  const cached = completedAnalyses.get(sessionKey);
  if (cached && Array.isArray(cached.items)) {
    const cachedItem = cached.items.find(
      it => it.tag && it.tag.toLowerCase() === tag.toLowerCase()
    );
    if (cachedItem && cachedItem.SystemFullName) {
      log(`resolve_tag_from_cache tag=${tag} sfn=${cachedItem.SystemFullName}`);
      return {
        tag,
        description: cachedItem.descricao || "(from analysis)",
        systemFullName: cachedItem.SystemFullName,
        existing: true,
      };
    }
  }

  // Tag not drawn in this session and not in analysis cache —
  // assume it already exists on the diagram.
  // The DLL's connect_objects tool will find it by tag name on the document.
  log(`resolve_tag_existing tag=${tag} sfn=(empty)`);
  return { tag, description: "(existing on diagram)", systemFullName: "", existing: true };
}

/**
 * Build a fabricated tool_call response for connect_objects.
 */
function buildConnectToolCall(docUID, docType, sourceTag, targetTag, sourceSFN, targetSFN, model, useImportFallback) {
  const toolCallId = `call_connect_${Date.now()}`;
  // ALWAYS route through import_equipment_from_excel with __CONNECT__: prefix.
  // The built-in connect_objects tool doesn't have our FindDeviceOnDocument
  // fallback for pre-existing objects. Routing through import→Agent ensures
  // the DLL scans the diagram for objects by tag regardless of SFN.
  const connectJson = JSON.stringify({ sourceTag, targetTag, sourceSFN, targetSFN });
  let fnName = "import_equipment_from_excel";
  let argsStr = JSON.stringify({
    excelFilePath: `__CONNECT__:${connectJson}`,
    documentUID: docUID,
    documentType: docType,
  });

  const tcArray = [{
    id: toolCallId,
    type: "function",
    function: { name: fnName, arguments: argsStr },
  }];
  const fc = { name: fnName, arguments: argsStr };
  return {
    id: `chatcmpl-shim-connect-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "serviceipid-gateway",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        Role: "assistant",
        content: "",
        Content: "",
        tool_calls: tcArray,
        toolCalls: tcArray,
        function_call: fc,
        FunctionCall: fc,
      },
      finish_reason: "function_call",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Interactive Drawing — state machine ────────────────────────────────────

/**
 * Detect user intent to start interactive drawing mode.
 * Matches Portuguese and English phrases.
 */
function detectInteractiveDrawingIntent(msg) {
  if (!msg) return false;
  const lc = msg.toLowerCase();
  const patterns = [
    // Portuguese – explicit diagram creation
    /criar\s+(um\s+)?diagrama/,
    /desenhar\s+(um\s+)?diagrama/,
    /quero\s+criar\s+(um\s+)?diagrama/,
    /montar\s+(um\s+)?diagrama/,
    /criar\s+diagrama\s+el[eé]trico/,
    // Portuguese – "interativo" standalone or compound
    /\binterativo\b/,
    /\bmodo\s+interativo\b/,
    /\bdesenho\s+interativo\b/,
    /\bmodo\s+desenho\b/,
    // Portuguese – drawing objects/equipment
    /\bdesenhar\s+(um\s+)?(objeto|equipamento|motor|componente|dispositivo)/,
    /\bcolocar\s+(um\s+)?(objeto|equipamento|motor|componente|dispositivo)/,
    /\bposicionar\s+(um\s+)?(objeto|equipamento|motor|componente|dispositivo)/,
    /\binserir\s+(um\s+)?(objeto|equipamento|motor|componente|dispositivo)/,
    /\bquero\s+desenhar\b/,
    /\bquero\s+que\s+desenhe\b/,
    /\bpasso\s+a\s+passo\b/,
    // English
    /\bi\s+want\s+to\s+draw\b/,
    /\blet'?s\s+draw\b/,
    /\bstart\s+(interactive\s+)?drawing\b/,
    /\benter\s+drawing\s+mode\b/,
    /\bopen\s+drawing\s+mode\b/,
    /create\s+(an?\s+)?(electrical\s+)?diagram/,
    /create\s+(an?\s+)?diagram\s+interactively/,
    /draw[ns]?\s+(an?\s+)?(electrical\s+)?diagram/,
    /draw[ns]?\s+(an?\s+)?symbol/,
    /draw[ns]?\s+(an?\s+)?device/,
    /draw[ns]?\s+(an?\s+)?equipment/,
    /draw[ns]?\s+(an?\s+)?object/,
    /draw[ns]?\s+(an?\s+)?component/,
    /draw[ns]?\s+(an?\s+)?\d+\s+/,
    // English — "draw a <type> at/on/in [the] [diagram/document] <docCode>"
    // Catches: "Draw a Frequency Vector Starter at the diagram FS.001"
    //          "Draw a Frequency Vector Starter on FS.001"
    /draw[ns]?\s+(?:an?\s+)?\w[\w\s]*?\b(?:at|on|in)\s+(?:the\s+)?(?:(?:diagram|document)\s+)?[a-z]{2}\.\d/i,
    // Portuguese — "desenhar um <tipo> no/na [diagrama/documento] <docCode>"
    /desenhar\s+(?:um\s+)?\w[\w\s]*?\b(?:no|na|dentro)\s+(?:o\s+|a\s+)?(?:(?:diagrama|documento)\s+)?[a-z]{2}\.\d/i,
    /place\s+(an?\s+)?device/,
    /place\s+(an?\s+)?symbol/,
    /place\s+(an?\s+)?(object|equipment|component)/,
    // English — "place a <type> at/on/in [the] [diagram/document] <docCode>"
    /place\s+(?:an?\s+)?\w[\w\s]*?\b(?:at|on|in)\s+(?:the\s+)?(?:(?:diagram|document)\s+)?[a-z]{2}\.\d/i,
    /interactive\s+draw/,
    /drawing\s+mode/,
    /interactive\s+mode/,
    /\bstep\s*[- ]?by\s*[- ]?step\b/,
    // Batch drawing: "criar 4 partidas diretas", "draw 3 motors", "drawn 3 starters", etc.
    /\b(?:criar|desenhar|inserir|colocar|posicionar)\s+\d+\s+/,
    /\b(?:create|draw[ns]?|drawing|place|insert)\s+\d+\s+/,
  ];
  return patterns.some(p => p.test(lc));
}

/**
 * Parse a batch drawing request.
 * Detects patterns like:
 *   "criar 4 partidas diretas dentro do diagrama FA.009 distribuidas horizontalmente"
 *   "create 4 direct starters in FA.009 distributed horizontally"
 *   "desenhar 6 motores no FA.020 distribuidos verticalmente"
 * Returns { count, componentType, document, distribution, diagramType } or null.
 */
function parseBatchDrawingRequest(msg) {
  if (!msg) return null;
  const lc = msg.toLowerCase().trim();

  // Must contain a number >= 2
  const countMatch = lc.match(/\b(\d+)\s+/);
  if (!countMatch) return null;
  const count = parseInt(countMatch[1], 10);
  if (count < 2 || count > 50) return null;

  // Extract document name (FA.009, FS.001, GB.002, etc.) or SystemUID
  const docMatch = msg.match(/\b([A-Z]{2}\.\d[\w.]*)/i) ||
                   msg.match(/\b(?:diagrama|diagram|documento|document)\s+([\w.]+)/i) ||
                   msg.match(/\b(?:no|na|in|on|at|dentro\s+d[eo])\s+(?:the\s+|o\s+|a\s+)?(?:diagrama\s+|diagram\s+)?([A-Z][A-Z0-9]\.\d[\w.]*)/i);
  const document = docMatch ? docMatch[1] : null;

  // Extract component type: text between the count and the document/distribution keywords
  const afterCount = lc.substring(lc.indexOf(countMatch[0]) + countMatch[0].length);
  const compMatch = afterCount.match(/^(.+?)(?:\s+(?:dentro|no|na|in|on|at|distribu|horizontal|vertical|diagrama|document|em\s+\w+\.)|$)/);
  const componentType = compMatch ? compMatch[1].replace(/\s+d[eo]\s*$/i, "").trim() : null;
  if (!componentType || componentType.length < 2) return null;

  // Extract distribution pattern
  const isVertical = /vertical/i.test(lc);
  const distribution = isVertical ? "vertical" : "horizontal";

  // Detect diagram type
  const diagramType = /\b(p&?id|pid)\b/i.test(lc) ? "pid" : "electrical";

  return { count, componentType, document, distribution, diagramType };
}

/**
 * Parse a SINGLE draw request (count=1).
 * Detects patterns like:
 *   "Draw a Frequency Inverter Starter on FS.001"
 *   "Desenhar uma partida direta no FA.009"
 *   "Place a three-phase motor at the diagram GB.002"
 * Returns { componentType, document, diagramType } or null.
 */
function parseSingleDrawRequest(msg) {
  if (!msg) return null;
  const lc = msg.toLowerCase().trim();

  // Must NOT contain a count >= 2 (that is batch territory)
  const countMatch = lc.match(/\b(\d+)\s+/);
  if (countMatch) {
    const n = parseInt(countMatch[1], 10);
    if (n >= 2) return null; // batch, not single
  }

  // Must have a document code (XX.NNN)
  const docMatch = msg.match(/\b([A-Z]{2}\.\d[\w.]*)/i);
  if (!docMatch) return null;
  const document = docMatch[1];

  // Extract component type: text between the verb and the preposition+doc
  // EN: "draw a <type> on/at/in [the] [diagram] XX.NNN"
  // PT: "desenhar um/uma <type> no/na/dentro [do/da] [diagrama] XX.NNN"
  const compPat = lc.match(
    /(?:draw[ns]?|create|place|insert|desenhar|criar|inserir|colocar|posicionar)\s+(?:an?\s+|uma?\s+)?(.+?)\s+(?:on|at|in|no|na|dentro|em)\s+(?:the\s+|o\s+|a\s+|do\s+|da\s+)?(?:diagram[a]?\s+|document[o]?\s+)?[a-z]{2}\.\d/i
  );
  if (!compPat) return null;
  const componentType = compPat[1].replace(/\s+d[eo]\s*$/i, "").trim();
  if (!componentType || componentType.length < 2) return null;

  // Detect diagram type
  const diagramType = /\b(p&?id|pid)\b/i.test(lc) ? "pid" : "electrical";

  return { componentType, document, diagramType };
}

/** Max parallel draw tool calls per iteration (fits within 30s C# timeout) */
const MAX_DRAWS_PER_BATCH = 4;

/**
 * Detect if user wants to cancel/exit drawing mode.
 */
function detectDrawingExit(msg) {
  if (!msg) return false;
  const lc = msg.toLowerCase();
  return /\b(pronto|done|finalizar|sair|exit|cancelar|cancel|fechar|close|encerr)\b/.test(lc);
}

/**
 * Parse user input for a component: description, tag, X, Y
 * Accepts formats:
 *   "Motor, =M01.Q01, 100, 200"
 *   "Motor 3-phase | =M01.Q01 | 100 | 200"
 *   "description: Motor, tag: =M01.Q01, x: 100, y: 200"
 */
function parseComponentInput(msg) {
  if (!msg) return null;
  const trimmed = msg.trim();

  // Try key-value format first: "description: ..., tag: ..., x: ..., y: ..."
  const kvDesc = trimmed.match(/descri[cç][aã]o\s*[:=]\s*([^,|]+)/i) || trimmed.match(/description\s*[:=]\s*([^,|]+)/i);
  const kvTag  = trimmed.match(/tag\s*[:=]\s*([^,|]+)/i);
  const kvX    = trimmed.match(/x\s*[:=]\s*([\d.]+)/i);
  const kvY    = trimmed.match(/y\s*[:=]\s*([\d.]+)/i);

  if (kvDesc && kvTag && kvX && kvY) {
    return {
      description: kvDesc[1].trim(),
      tag: kvTag[1].trim(),
      x: parseFloat(kvX[1]),
      y: parseFloat(kvY[1]),
    };
  }

  // Try comma/pipe-separated: "description, tag, x, y" or "description | tag | x | y"
  const parts = trimmed.split(/[,|]/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 4) {
    const xVal = parseFloat(parts[parts.length - 2]);
    const yVal = parseFloat(parts[parts.length - 1]);
    if (!isNaN(xVal) && !isNaN(yVal)) {
      // tag is the second-to-last text part, description is everything before
      const tag = parts[parts.length - 3];
      const desc = parts.slice(0, parts.length - 3).join(", ");
      return {
        description: desc || tag,
        tag: tag,
        x: xVal,
        y: yVal,
      };
    }
  }

  // ── Natural language parser (Portuguese & English) ──
  // Handles: "motor elétrico trifásico nas coordenadas 50 X e 100Y TAG M001"
  //          "quero que desenhe um motor elétrico nas coordenadas 50 X e 100 Y TAG M001"
  //          "draw a three-phase motor at coordinates 50 X and 100 Y TAG M001"
  //          "create a motor named M001 at coordinate X 10 and coordinate Y 20"
  //          "crie um motor chamado M001 na coordenada X 10 e coordenada Y 20"
  const lc = trimmed.toLowerCase();

  // Extract TAG — many spoken patterns:
  //   "TAG M001" / "tag: M001" / "tag =M01.Q01"
  //   "named M001" / "called M001" / "chamado M001" / "denominado M001"
  //   "com nome M001" / "with name M001" / "com tag M001" / "with tag M001"
  let tag = null;
  const tagPatterns = [
    /\bTAG\s*[:=]?\s*([^\s,]+)/i,
    /\b(?:named|called|with\s+(?:tag|name))\s*[:=]?\s*([^\s,]+)/i,
    /\b(?:chamad[ao]|denominad[ao]|com\s+(?:tag|nome))\s*[:=]?\s*([^\s,]+)/i,
  ];
  for (const pat of tagPatterns) {
    const m = trimmed.match(pat);
    if (m) { tag = m[1].trim(); break; }
  }

  // Extract X, Y coordinates — many patterns
  let xVal = null, yVal = null;

  // Pattern: "50 X e 100Y", "50X e 100 Y", "50 x 100 y", "coordenadas 50 X e 100 Y"
  const xyPattern1 = trimmed.match(/(\d+(?:\.\d+)?)\s*X\s*(?:e\s*|,\s*|and\s*)?(\d+(?:\.\d+)?)\s*Y/i);
  if (xyPattern1) {
    xVal = parseFloat(xyPattern1[1]);
    yVal = parseFloat(xyPattern1[2]);
  }

  // Pattern: "coordinate X 10 and coordinate Y 20" / "coordenada X 10 e coordenada Y 20"
  //          "in the coordinate X 10" / "na coordenada X 10"
  if (xVal === null) {
    const coordXm = trimmed.match(/\bcoordena(?:te|da)s?\s+X\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    const coordYm = trimmed.match(/\bcoordena(?:te|da)s?\s+Y\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    if (coordXm && coordYm) {
      xVal = parseFloat(coordXm[1]);
      yVal = parseFloat(coordYm[1]);
    }
  }

  // Pattern: "X 50 Y 100", "X:50 Y:100", "X=50, Y=100"
  if (xVal === null) {
    const xm = trimmed.match(/\bX\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    const ym = trimmed.match(/\bY\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    if (xm && ym) {
      xVal = parseFloat(xm[1]);
      yVal = parseFloat(ym[1]);
    }
  }

  // Pattern: "coordinates (50, 100)", "coordenadas (50, 100)", "at (50, 100)"
  if (xVal === null) {
    const coordParen = trimmed.match(/(?:coordenadas|coordinates|at)\s*\(?\s*(\d+(?:\.\d+)?)\s*[,;]\s*(\d+(?:\.\d+)?)\s*\)?/i);
    if (coordParen) {
      xVal = parseFloat(coordParen[1]);
      yVal = parseFloat(coordParen[2]);
    }
  }

  if (tag && xVal !== null && yVal !== null) {
    // Extract description: everything before the first keyword (TAG, coordenadas, coordinates, X, Y number)
    let desc = trimmed;
    // Remove TAG/named/called portion
    desc = desc.replace(/\bTAG\s*[:=]?\s*[^\s,]+/i, "");
    desc = desc.replace(/\b(?:named|called|with\s+(?:tag|name))\s*[:=]?\s*[^\s,]+/i, "");
    desc = desc.replace(/\b(?:chamad[ao]|denominad[ao]|com\s+(?:tag|nome))\s*[:=]?\s*[^\s,]+/i, "");
    // Remove coordinate portions
    desc = desc.replace(/(\d+(?:\.\d+)?)\s*X\s*(?:e\s*|,\s*|and\s*)?(\d+(?:\.\d+)?)\s*Y/i, "");
    desc = desc.replace(/\bcoordena(?:te|da)s?\s+[XY]\s*[:=]?\s*\d+(?:\.\d+)?/ig, "");
    desc = desc.replace(/\bX\s*[:=]?\s*\d+(?:\.\d+)?/i, "");
    desc = desc.replace(/\bY\s*[:=]?\s*\d+(?:\.\d+)?/i, "");
    desc = desc.replace(/\b(?:(?:in\s+(?:the\s+)?)?coordena(?:te|da)s?|(?:at\s+)?coordinates)\b/ig, "");
    desc = desc.replace(/\b(?:quero\s+que\s+desenhe|desenhe|draw|create|crie?|add|adicione?)\s+(um\s+|uma\s+|an?\s+)?/i, "");
    desc = desc.replace(/\b(?:at|in|na|em|no|nas|nos|the|um|uma|a|an)\b\s*/ig, "");
    desc = desc.replace(/[,|]+$/, "").replace(/^[,|\s]+/, "").trim();
    // Clean up multiple spaces
    desc = desc.replace(/\s{2,}/g, " ").trim();
    if (!desc) desc = tag; // fallback

    return {
      description: desc,
      tag: tag,
      x: xVal,
      y: yVal,
    };
  }

  // Try 3-part: "description, tag, x, y" where parts.length === 4 handled above
  // or simpler: just description (no coordinates) — ask for more info
  return null;
}

/**
 * Parse document identifier from user message.
 * Could be a SystemUID (alphanumeric ~10 chars) or a document name.
 */
function parseDocumentInput(msg) {
  if (!msg) return null;
  const trimmed = msg.trim();

  // Try to extract a SystemUID-like string (alphanumeric, 8-12 chars like "A5B4Z726ZU")
  const uidMatch = trimmed.match(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])([A-Z0-9]{8,12})\b/i);

  // Check if user specified diagram type
  let diagramType = "electrical"; // default
  const lc = trimmed.toLowerCase();
  if (lc.includes("p&id") || /\bpid\b/.test(lc)) diagramType = "pid";

  return {
    docUID: uidMatch ? uidMatch[1] : trimmed.replace(/['"]/g, "").trim(),
    diagramType: diagramType,
  };
}

/**
 * Call the gateway /comos/match-component endpoint.
 */
async function matchComponent(description, tag, diagramType, diagramSubtype) {
  const url = `${gatewayBase}/comos/match-component`;
  const payload = {
    description: description,
    tag: tag || "",
    tipo: "",
    diagram_type: diagramType || "electrical",
    diagram_subtype: diagramSubtype || "",
  };

  try {
    const resp = await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-API-Key": process.env.COMOS_GATEWAY_API_KEY || "",
        },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ error: data }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    return resp;
  } catch (err) {
    log(`match_component_error ${err.message}`);
    return { SystemFullName: null, error: err.message };
  }
}

/**
 * Build a fabricated tool_call response for draw_single_object
 */
function buildDrawToolCall(docUID, docType, tag, description, systemFullName, x, y, model, useImportFallback) {
  const toolCallId = `call_draw_${Date.now()}`;
  let fnName = "draw_single_object";
  let argsStr = JSON.stringify({
    documentUID: docUID,
    documentType: docType,
    tag,
    description,
    systemFullName,
    x,
    y,
  });

  if (useImportFallback) {
    const inlineJson = JSON.stringify({ tag, description, systemFullName, x, y });
    fnName = "import_equipment_from_excel";
    argsStr = JSON.stringify({
      excelFilePath: `__INLINE__:${inlineJson}`,
      documentUID: docUID,
      documentType: docType,
    });
  }

  const tcArray = [{
    id: toolCallId,
    type: "function",
    function: { name: fnName, arguments: argsStr },
  }];
  const fc = { name: fnName, arguments: argsStr };
  return {
    id: `chatcmpl-shim-draw-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "serviceipid-gateway",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        Role: "assistant",
        content: "",
        Content: "",
        tool_calls: tcArray,
        toolCalls: tcArray,
        function_call: fc,
        FunctionCall: fc,
      },
      finish_reason: "function_call",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Build a fabricated response with MULTIPLE parallel tool_calls for batch drawing.
 * Each draw is { documentUID, documentType, tag, description, systemFullName, x, y }.
 */
function buildBatchDrawToolCalls(draws, model, useImportFallback) {
  const tcArray = [];
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i];
    const toolCallId = `call_batch_${Date.now()}_${i}`;
    let fnName = "draw_single_object";
    let argsStr = JSON.stringify({
      documentUID: d.documentUID,
      documentType: d.documentType,
      tag: d.tag,
      description: d.description,
      systemFullName: d.systemFullName,
      x: d.x,
      y: d.y,
    });

    if (useImportFallback) {
      const inlineJson = JSON.stringify({ tag: d.tag, description: d.description, systemFullName: d.systemFullName, x: d.x, y: d.y });
      fnName = "import_equipment_from_excel";
      argsStr = JSON.stringify({
        excelFilePath: `__INLINE__:${inlineJson}`,
        documentUID: d.documentUID,
        documentType: d.documentType,
      });
    }

    tcArray.push({
      id: toolCallId,
      type: "function",
      function: { name: fnName, arguments: argsStr },
    });
  }

  const firstFc = tcArray[0]
    ? { name: tcArray[0].function.name, arguments: tcArray[0].function.arguments }
    : null;

  return {
    id: `chatcmpl-shim-batch-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "serviceipid-gateway",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        Role: "assistant",
        content: "",
        Content: "",
        tool_calls: tcArray,
        toolCalls: tcArray,
        function_call: firstFc,
        FunctionCall: firstFc,
      },
      finish_reason: "function_call",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Parse ALL tool results from the current conversation iteration.
 * Returns an array of { success, tag, error, message } objects.
 */
function parseBatchToolResults(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const results = [];

  // Find the last assistant message with batch tool_calls
  let batchAssistantIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "assistant") continue;
    const tc = m.tool_calls || m.toolCalls;
    if (Array.isArray(tc) && tc.some(t => String(t.id || "").startsWith("call_batch_"))) {
      batchAssistantIdx = i;
      break;
    }
  }
  if (batchAssistantIdx < 0) return results;

  // Collect all tool result messages after the batch assistant message
  for (let i = batchAssistantIdx + 1; i < list.length; i++) {
    const m = list[i] || {};
    const role = String(m.role || m.Role || "").toLowerCase();
    if (role !== "tool" && role !== "function") continue;
    const content = String(m.content || m.Content || "").trim();
    const tcId = String(m.tool_call_id || m.toolCallId || m.ToolCallId || "");
    if (!tcId.startsWith("call_batch_")) continue;

    // Parse result content
    let success = null, tag = "", error = "", message = "";
    try {
      const normalized = content
        .replace(/^\{\s*/, "{")
        .replace(/\s*=\s*/g, ":")
        .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      const obj = JSON.parse(normalized);
      success = obj.success === true || obj.Success === true;
      tag = String(obj.tag || obj.Tag || obj.objectName || "").trim();
      error = String(obj.error || obj.Error || "").trim();
      message = String(obj.message || obj.Message || "").trim();
    } catch {
      const successTrue = /\bsuccess\s*[:=]\s*true\b/i.test(content);
      const successFalse = /\bsuccess\s*[:=]\s*false\b/i.test(content);
      success = successTrue ? true : (successFalse ? false : null);
      const tagMatch = content.match(/\btag\s*[:=]\s*([^,}\n]+)/i);
      if (tagMatch) tag = tagMatch[1].trim();
      const errMatch = content.match(/\berror\s*[:=]\s*([^,}\n]+)/i);
      if (errMatch) error = errMatch[1].trim();
    }
    results.push({ success, tag, error, message, toolCallId: tcId });
  }
  return results;
}

/**
 * Infer a tag prefix from component type for auto-generated tags.
 * Maps common electrical and P&ID component types to standard prefixes.
 */
function inferTagPrefix(componentType) {
  const lc = (componentType || "").toLowerCase();
  // Electrical components
  if (/partida|starter|arrancador/.test(lc)) return "Q";
  if (/motor/.test(lc)) return "M";
  if (/contator|contactor/.test(lc)) return "K";
  if (/disjuntor|breaker/.test(lc)) return "Q";
  if (/rel[eé]|relay/.test(lc)) return "K";
  if (/transform|trafo/.test(lc)) return "T";
  if (/fus[ií]vel|fuse/.test(lc)) return "F";
  if (/chave|switch/.test(lc)) return "S";
  if (/lamp|l[aâ]mp/.test(lc)) return "H";
  // P&ID components
  if (/bomba|pump/.test(lc)) return "P";
  if (/v[aá]lvula|valve/.test(lc)) return "XV";
  if (/tanque|tank|vaso|vessel/.test(lc)) return "TK";
  if (/trocador|exchanger/.test(lc)) return "E";
  if (/compressor/.test(lc)) return "C";
  if (/instrumento|instrument|transmissor|transmitter/.test(lc)) return "FT";
  return "D"; // generic default
}

/**
 * Main interactive drawing handler — processes state transitions.
 * Returns true if the request was handled, false to pass through.
 */
async function handleInteractiveDrawing(sessionKey, info, parsed, res) {
  const msg = (info.lastUserMsg || "").trim();
  const model = parsed.model;
  const sessionTools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const toolNames = sessionTools.map(t => t?.function?.name || t?.Function?.Name || "").filter(Boolean);
  const hasDirectDrawTool = toolNames.includes("draw_single_object");
  const hasDirectConnectTool = toolNames.includes("connect_objects");
  const hasImportTool = toolNames.includes("import_equipment_from_excel");

  // ── If user is already in a drawing session ──
  if (drawingSessions.has(sessionKey)) {
    const session = drawingSessions.get(sessionKey);
    // Ensure session has _sessionKey for resolveTagForConnection cache lookups
    if (!session._sessionKey) session._sessionKey = sessionKey;

    // Check for exit
    if (detectDrawingExit(msg)) {
      const successCount = session.drawnObjects ? session.drawnObjects.length : 0;
      const failCount = session.failedObjects ? session.failedObjects.length : 0;
      const connCount = session.connections ? session.connections.length : 0;
      drawingSessions.delete(sessionKey);

      let exitMsg = `✅ **Interactive Drawing finished.**\n\n`;

      if (successCount > 0 || failCount > 0) {
        exitMsg += `**${successCount}** object(s) created successfully`;
        if (failCount > 0) exitMsg += `, **${failCount}** failed`;
        exitMsg += `. **${connCount}** connection(s) placed.\n\n`;
      } else {
        exitMsg += `**${connCount}** connection(s) placed.\n\n`;
      }

      if (successCount > 0) {
        exitMsg += "**Objects created:**\n" + session.drawnObjects.map(
          (o, i) => `${i + 1}. ✅ **${o.tag}** — ${o.description} at (${o.x}, ${o.y})`
        ).join("\n") + "\n\n";
      }

      if (failCount > 0) {
        exitMsg += "**Failed objects:**\n" + session.failedObjects.map(
          (o, i) => `${i + 1}. ❌ **${o.tag}** — ${o.description} — _${o.error}_`
        ).join("\n") + "\n\n";
      }

      if (successCount === 0 && failCount === 0) {
        exitMsg += "_No objects were drawn._\n\n";
      }

      if (connCount > 0) {
        exitMsg += "**Connections created:**\n" + session.connections.map(
          (c, i) => `${i + 1}. **${c.sourceTag}** → **${c.targetTag}**`
        ).join("\n");
      }

      sendJsonResponse(res, 200, buildCompletionResponse(exitMsg, model), { "X-Comos-Ai-Shim": "drawing-exit" });
      log(`drawing_exit session=${sessionKey} success=${successCount} failed=${failCount} conns=${connCount}`);
      return true;
    }

    // ── STEP: batch_ask_document — user provides document for batch drawing ──
    if (session.step === "batch_ask_document") {
      const userInput = msg.trim();
      if (!userInput) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          `Please enter the document name (e.g., \`FA.009\`) or SystemUID.`, model
        ), { "X-Comos-Ai-Shim": "batch-ask-document-retry" });
        return true;
      }

      const batchReq = session.batchRequest;
      if (!batchReq) { drawingSessions.delete(sessionKey); return false; }

      batchReq.document = userInput;
      log(`batch_document_set session=${sessionKey} doc=${userInput}`);

      // Match the component type
      emitAgentEvent("tool_start", { label: `Matching: "${batchReq.componentType}"` });
      const matchResult = await matchComponent(batchReq.componentType, "", batchReq.diagramType, "");

      if (!matchResult || !matchResult.SystemFullName) {
        drawingSessions.delete(sessionKey);
        sendJsonResponse(res, 200, buildCompletionResponse(
          `❌ No match found for "${batchReq.componentType}". Session closed. Try again with a more specific description.`, model
        ), { "X-Comos-Ai-Shim": "batch-no-match" });
        return true;
      }

      const sfn = matchResult.SystemFullName;
      const refDesc = matchResult.Descricao_ref || matchResult.descricao_ref || batchReq.componentType;
      emitAgentEvent("tool_result", { label: `Matched: ${refDesc}` });

      // Calculate positions
      const tagPrefix = inferTagPrefix(batchReq.componentType);
      const startX = 50, startY = 50;
      const spacingH = 60, spacingV = 40;
      const allDraws = [];
      for (let i = 0; i < batchReq.count; i++) {
        const x = batchReq.distribution === "horizontal" ? startX + i * spacingH : startX;
        const y = batchReq.distribution === "vertical" ? startY + i * spacingV : startY;
        const tag = `${tagPrefix}${String(i + 1).padStart(3, "0")}`;
        allDraws.push({ documentUID: userInput, documentType: 29, tag, description: refDesc, systemFullName: sfn, x, y });
      }

      const currentBatch = allDraws.slice(0, MAX_DRAWS_PER_BATCH);
      const remaining = allDraws.slice(MAX_DRAWS_PER_BATCH);

      // Update session to batch_drawing
      session.step = "batch_drawing";
      session.docUID = userInput;
      session.batchDraws = remaining;
      session.batchTotal = batchReq.count;
      session.batchSent = currentBatch.length;
      session.batchComponentType = batchReq.componentType;
      session.batchRefDesc = refDesc;
      session.batchSFN = sfn;
      session.batchRequest = null;
      session.storedAt = Date.now();

      const resp = buildBatchDrawToolCalls(currentBatch, model, !hasDirectDrawTool && hasImportTool);
      const posDesc = currentBatch.map(d => `${d.tag}@(${d.x},${d.y})`).join(", ");
      emitAgentEvent("tool_start", { label: `Drawing batch 1: ${posDesc}` });
      sendJsonResponse(res, 200, resp, { "X-Comos-Ai-Shim": "batch-draw-tool-calls" });
      log(`batch_draw_start session=${sessionKey} batch=${currentBatch.length} remaining=${remaining.length}`);
      return true;
    }

    // ── STEP: batch_drawing — process results from parallel draw tool_calls ──
    if (session.step === "batch_drawing") {
      const batchResults = parseBatchToolResults(info.messages || parsed.messages || parsed.Messages || []);

      // Track results
      for (const result of batchResults) {
        if (result.success === true) {
          session.drawnObjects.push({
            tag: result.tag || `obj_${session.drawnObjects.length + 1}`,
            description: session.batchRefDesc || "",
            systemFullName: session.batchSFN || "",
            x: 0, y: 0,
          });
        } else if (result.success === false) {
          session.failedObjects.push({
            tag: result.tag || `obj_${session.failedObjects.length + 1}`,
            description: session.batchRefDesc || "",
            error: result.error || result.message || "Unknown error",
          });
        } else {
          // Ambiguous — count as success optimistically
          session.drawnObjects.push({
            tag: result.tag || `obj_${session.drawnObjects.length + 1}`,
            description: session.batchRefDesc || "",
            systemFullName: session.batchSFN || "",
            x: 0, y: 0,
          });
        }
      }

      log(`batch_draw_results session=${sessionKey} parsed=${batchResults.length} success=${session.drawnObjects.length} failed=${session.failedObjects.length}`);

      // Check if more draws remain
      if (session.batchDraws && session.batchDraws.length > 0) {
        const nextBatch = session.batchDraws.slice(0, MAX_DRAWS_PER_BATCH);
        session.batchDraws = session.batchDraws.slice(MAX_DRAWS_PER_BATCH);
        session.batchSent += nextBatch.length;
        session.storedAt = Date.now();

        const resp = buildBatchDrawToolCalls(nextBatch, model, !hasDirectDrawTool && hasImportTool);
        const posDesc = nextBatch.map(d => `${d.tag}@(${d.x},${d.y})`).join(", ");
        emitAgentEvent("tool_start", { label: `Drawing batch: ${posDesc} (${session.batchSent}/${session.batchTotal})` });
        sendJsonResponse(res, 200, resp, { "X-Comos-Ai-Shim": "batch-draw-continue" });
        log(`batch_draw_continue session=${sessionKey} next=${nextBatch.length} remaining=${session.batchDraws.length} sent=${session.batchSent}/${session.batchTotal}`);
        return true;
      }

      // All batches sent and results received — summarize
      const successCount = session.drawnObjects.length;
      const failCount = session.failedObjects.length;

      let summary = `✅ **Batch Drawing Complete** — ${session.batchComponentType}\n\n`;
      summary += `📄 Document: **${session.docUID}** | Total: **${session.batchTotal}** | `;
      summary += `Drawn: **${successCount}** | Failed: **${failCount}**\n\n`;

      if (successCount > 0) {
        summary += "**Objects drawn:**\n" + session.drawnObjects.map(
          (o, i) => `${i + 1}. ✅ **${o.tag}** — ${o.description}`
        ).join("\n") + "\n\n";
      }

      if (failCount > 0) {
        summary += "**Failed:**\n" + session.failedObjects.map(
          (o, i) => `${i + 1}. ❌ **${o.tag}** — ${o.error}`
        ).join("\n") + "\n\n";
      }

      // Transition: offer to continue in interactive mode or exit
      session.step = "ask_component";
      session.batchDraws = null;
      session.batchRequest = null;
      session.storedAt = Date.now();

      summary += `You can now:\n` +
        `- Draw more objects (natural language)\n` +
        `- **connect** objects: \`conectar Q001 em Q002\`\n` +
        `- Type **"done"** to finish.`;

      emitAgentEvent("tool_result", { label: `Batch complete: ${successCount}/${session.batchTotal} drawn` });
      sendJsonResponse(res, 200, buildCompletionResponse(summary, model), { "X-Comos-Ai-Shim": "batch-draw-complete" });
      log(`batch_draw_complete session=${sessionKey} success=${successCount} failed=${failCount} total=${session.batchTotal}`);
      return true;
    }

    // ── STEP: ask_document — user provides document name/UID ──
    if (session.step === "ask_document") {
      const userInput = msg.trim();
      // Accept document name (e.g., FA.020), SystemUID (e.g., A5BKD4FN3Y), or full path
      if (!userInput) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          `Please enter the document name (e.g., \`FA.020\`) or SystemUID.`, model
        ), { "X-Comos-Ai-Shim": "drawing-ask-document-retry" });
        return true;
      }

      // Store what the user typed — DLL's ResolveDocument handles name-to-object resolution
      session.docUID = userInput;
      session.diagramType = session.diagramType || "electrical";

      // For electrical diagrams, ask the subtype (single-line vs multiline)
      if (session.diagramType === "electrical") {
        session.step = "ask_subtype";
        session.storedAt = Date.now();

        const askSubtypeMsg =
          `📐 **Interactive Drawing Mode**\n\n` +
          `📄 Document: **${userInput}**\n\n` +
          `What type of electrical diagram is this?\n\n` +
          `1. **Single-line** (unipolar)\n` +
          `2. **Multiline** (multifilar)\n\n` +
          `Reply **1** or **single** for single-line, **2** or **multi** for multiline.`;

        sendJsonResponse(res, 200, buildCompletionResponse(askSubtypeMsg, model), { "X-Comos-Ai-Shim": "drawing-ask-subtype" });
        log(`drawing_ask_subtype session=${sessionKey} uid=${userInput}`);
        return true;
      }

      // For P&ID or other types, go directly to ask_component
      session.step = "ask_component";
      session.storedAt = Date.now();

      const askComponentMsg =
        `📐 **Interactive Drawing Mode**\n\n` +
        `📄 Document: **${userInput}**\n\n` +
        `Describe the component you want to place. Natural language is supported:\n\n` +
        `- \`create a motor named M001 at coordinate X 100 and coordinate Y 200\`\n` +
        `- \`motor trifásico chamado M001 coordenada X 100 coordenada Y 200\`\n` +
        `- \`three-phase motor TAG M001 X 100 Y 200\`\n` +
        `- \`Motor 3-phase, =M01.Q01, 100, 200\` (comma-separated)\n\n` +
        `You can also **connect** drawn objects:\n` +
        `> \`conectar D001 em K001\` or \`connect D001 to K001\`\n\n` +
        `Type **"done"** or **"pronto"** when finished.`;

      sendJsonResponse(res, 200, buildCompletionResponse(askComponentMsg, model), { "X-Comos-Ai-Shim": "drawing-doc-set" });
      log(`drawing_doc_set session=${sessionKey} uid=${userInput} type=${session.diagramType}`);
      return true;
    }

    // ── STEP: ask_subtype — user tells us if the diagram is single-line or multiline ──
    if (session.step === "ask_subtype") {
      const lc = msg.toLowerCase().trim();
      let subtype = "";

      if (/^(1|single|unipolar|single[- ]?line|unifil)/.test(lc)) {
        subtype = "unipolar";
      } else if (/^(2|multi|multifil|multiline|multi[- ]?line)/.test(lc)) {
        subtype = "multifilar";
      }

      if (!subtype) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          `Please reply **1** (single-line / unipolar) or **2** (multiline / multifilar).`,
          model
        ), { "X-Comos-Ai-Shim": "drawing-ask-subtype-retry" });
        return true;
      }

      session.diagramSubtype = subtype;
      session.step = "ask_component";
      session.storedAt = Date.now();

      const subtypeLabel = subtype === "unipolar" ? "Single-line (unipolar)" : "Multiline (multifilar)";
      const askComponentMsg =
        `📐 **Interactive Drawing Mode**\n\n` +
        `📄 Document: **${session.docUID}** — ${subtypeLabel}\n\n` +
        `Describe the component you want to place. Natural language is supported:\n\n` +
        `- \`create a motor named M001 at coordinate X 100 and coordinate Y 200\`\n` +
        `- \`motor trifásico chamado M001 coordenada X 100 coordenada Y 200\`\n` +
        `- \`three-phase motor TAG M001 X 100 Y 200\`\n` +
        `- \`Motor 3-phase, =M01.Q01, 100, 200\` (comma-separated)\n\n` +
        `You can also **connect** drawn objects:\n` +
        `> \`conectar D001 em K001\` or \`connect D001 to K001\`\n\n` +
        `Type **"done"** or **"pronto"** when finished.`;

      sendJsonResponse(res, 200, buildCompletionResponse(askComponentMsg, model), { "X-Comos-Ai-Shim": "drawing-subtype-set" });
      log(`drawing_subtype_set session=${sessionKey} subtype=${subtype}`);
      return true;
    }

    // ── STEP: ask_component — user provides description, tag, X, Y ──
    if (session.step === "ask_component") {

      if (isAmbiguousConnectPrompt(msg) || isSmallTalkNoise(msg)) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          "Use one of these commands:\n\n" +
          "- `connect D001 to K001`\n" +
          "- `conectar D001 em K001`\n\n" +
          "Or describe a component — natural language is supported:\n" +
          "- `create a motor named M001 at coordinate X 150 and coordinate Y 250`\n" +
          "- `motor trifásico chamado M001 coordenada X 150 coordenada Y 250`\n" +
          "- `Contactor 3-pole TAG K001 X 150 Y 250`\n" +
          "- `Contactor, K001, 150, 250` (comma-separated)",
          model
        ), { "X-Comos-Ai-Shim": "drawing-ambiguous-input" });
        return true;
      }

      // ── Check for connection intent FIRST ──
      if (detectConnectionIntent(msg)) {
        const connParsed = parseConnectionInput(msg);
        if (connParsed) {
          const { sourceTag, targetTag } = connParsed;
          // Resolve tags — checks drawnObjects first, then assumes pre-existing on diagram
          const srcObj = resolveTagForConnection(session, sourceTag);
          const tgtObj = resolveTagForConnection(session, targetTag);

          // Log when connecting to pre-existing objects
          if (srcObj.existing || tgtObj.existing) {
            const existingTags = [srcObj, tgtObj].filter(o => o.existing).map(o => o.tag).join(", ");
            log(`drawing_connect_existing session=${sessionKey} existing_tags=${existingTags}`);
          }

          // Build and send the connect_objects tool call
          const toolCallResp = buildConnectToolCall(
            session.docUID,
            session.docType || 29,
            srcObj.tag,
            tgtObj.tag,
            srcObj.systemFullName,
            tgtObj.systemFullName,
            model,
            !hasDirectConnectTool && hasImportTool
          );

          session.pendingConnection = {
            sourceTag: srcObj.tag,
            targetTag: tgtObj.tag,
            sourceSFN: srcObj.systemFullName,
            targetSFN: tgtObj.systemFullName,
            toolCallId: toolCallResp?.choices?.[0]?.message?.tool_calls?.[0]?.id || "",
          };

          session.step = "connecting";
          session.storedAt = Date.now();

          sendJsonResponse(res, 200, toolCallResp, { "X-Comos-Ai-Shim": "drawing-connect-tool-call" });
          log(`drawing_connect session=${sessionKey} src=${srcObj.tag} tgt=${tgtObj.tag}`);
          return true;
        }
        // Connection intent detected but couldn't parse tags — show help
        sendJsonResponse(res, 200, buildCompletionResponse(
          "🔗 I detected a connection request but couldn't identify the tags.\n\n" +
          "Please use one of these formats:\n\n" +
          "- `conectar D001 em K001`\n" +
          "- `connect D001 to K001`\n" +
          "- `de D001 para K001`\n" +
          "- `saída do D001 na entrada do K001`\n\n" +
          "Or describe the next component, e.g. `create a motor named M001 at coordinate X 100 and coordinate Y 200`.",
          model
        ), { "X-Comos-Ai-Shim": "drawing-connect-parse-retry" });
        return true;
      }

      const comp = parseComponentInput(msg);
      if (!comp) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          "I couldn't parse the component. You can speak naturally — for example:\n\n" +
          "- `create a motor named M001 at coordinate X 150 and coordinate Y 250`\n" +
          "- `motor trifásico chamado M001 coordenada X 150 coordenada Y 250`\n" +
          "- `three-phase motor TAG M001 X 150 Y 250`\n" +
          "- `Contactor 3-pole, =M01.K01, 150, 250` (comma-separated)\n\n" +
          "The key fields I need: **component description**, **tag**, **X position**, **Y position**.\n\n" +
          "You can also **connect** drawn objects: `connect D001 to K001`\n\n" +
          "Or type **\"done\"** to finish.",
          model
        ), { "X-Comos-Ai-Shim": "drawing-parse-retry" });
        return true;
      }

      // Store pending component and call the matcher
      session.pendingComponent = comp;
      session.storedAt = Date.now();

      // ── SystemFullName bypass: if description IS a SystemFullName, skip matcher ──
      const sfnPattern = /^@[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+$/;
      if (sfnPattern.test((comp.description || "").trim())) {
        const directSFN = comp.description.trim();
        log(`drawing_sfn_bypass session=${sessionKey} sfn=${directSFN} tag=${comp.tag}`);

        // Go directly to drawing — no matcher, no confirm
        const toolCallResp = buildDrawToolCall(
          session.docUID, session.docType || 29,
          comp.tag, comp.tag, directSFN,
          comp.x, comp.y, model,
          !hasDirectDrawTool && hasImportTool
        );

        session.lastDrawAttempt = {
          tag: comp.tag,
          description: directSFN,
          systemFullName: directSFN,
          x: comp.x,
          y: comp.y,
        };

        session.step = "drawing";
        session.storedAt = Date.now();

        sendJsonResponse(res, 200, toolCallResp, { "X-Comos-Ai-Shim": "drawing-tool-call-sfn-bypass" });
        log(`drawing_tool_call session=${sessionKey} tag=${comp.tag} sfn=${directSFN} (bypass)`);
        return true;
      }

      session.step = "matching";
      log(`drawing_matching session=${sessionKey} desc=${comp.description} tag=${comp.tag}`);

      // Call gateway matcher
      const matchResult = await matchComponent(comp.description, comp.tag, session.diagramType, session.diagramSubtype);

      if (!matchResult || !matchResult.SystemFullName) {
        session.step = "ask_component"; // back to ask
        const errDetail = matchResult && matchResult.error ? matchResult.error : "No match found";
        sendJsonResponse(res, 200, buildCompletionResponse(
          `❌ **No match found** for "${comp.description}".\n\n` +
          `Error: ${errDetail}\n\n` +
          `Please try a different description, or type **"done"** to finish.`,
          model
        ), { "X-Comos-Ai-Shim": "drawing-no-match" });
        log(`drawing_no_match session=${sessionKey} desc=${comp.description}`);
        return true;
      }

      // Match found — show to user and ask for confirmation
      session.pendingMatch = matchResult;
      session.step = "confirm_match";
      session.storedAt = Date.now();

      const confidence = matchResult["Confiança"] || matchResult.Confiança || matchResult.confidence || 0;
      const confPct = (confidence * 100).toFixed(1);
      const refDesc = matchResult.Descricao_ref || matchResult.descricao_ref || "";
      const refType = matchResult.Tipo_ref || matchResult.tipo_ref || "";
      const sfn = matchResult.SystemFullName;

      let altText = "";
      if (matchResult.alternatives && matchResult.alternatives.length > 1) {
        altText = "\n\n**Other options:**\n" + matchResult.alternatives.slice(1, 4).map(
          (a, i) => `${i + 2}. ${a.Descricao_ref || a.descricao_ref || "?"} — ${((a["Confiança"] || a.Confiança || 0) * 100).toFixed(1)}%`
        ).join("\n");
      }

      const confirmMsg =
        `🔍 **Match found for "${comp.description}":**\n\n` +
        `| Field | Value |\n|---|---|\n` +
        `| **Reference** | ${refDesc} |\n` +
        `| **Type** | ${refType} |\n` +
        `| **SystemFullName** | \`${sfn}\` |\n` +
        `| **Confidence** | ${confPct}% |\n` +
        `| **Tag** | ${comp.tag} |\n` +
        `| **Position** | (${comp.x}, ${comp.y}) |\n` +
        altText + "\n\n" +
        `Reply **"yes"** / **"sim"** to draw, **"no"** / **"não"** to skip, or type a new component.`;

      sendJsonResponse(res, 200, buildCompletionResponse(confirmMsg, model), { "X-Comos-Ai-Shim": "drawing-confirm" });
      log(`drawing_confirm session=${sessionKey} sfn=${sfn} conf=${confPct}`);
      return true;
    }

    // ── STEP: confirm_match — user confirms or rejects the match ──
    if (session.step === "confirm_match") {
      const lc = msg.toLowerCase();

      if (isSmallTalkNoise(msg)) {
        sendJsonResponse(res, 200, buildCompletionResponse(
          "Please reply `yes` to draw, `no` to skip, or provide a connection like `connect D001 to K001`.",
          model
        ), { "X-Comos-Ai-Shim": "drawing-confirm-smalltalk" });
        return true;
      }
      const isYes = /^(y|yes|s|si|sim|ok|confirmar?|draw|desenhar?)\b/.test(lc);
      const isNo  = /^(n|no|não|nao|skip|pular|next)\b/.test(lc);

      if (isNo) {
        session.step = "ask_component";
        session.pendingComponent = null;
        session.pendingMatch = null;
        session.storedAt = Date.now();
        sendJsonResponse(res, 200, buildCompletionResponse(
          "⏭️ Skipped. Describe the next component, or type **\"done\"** to finish.",
          model
        ), { "X-Comos-Ai-Shim": "drawing-skipped" });
        log(`drawing_skipped session=${sessionKey}`);
        return true;
      }

      if (isYes) {
        // Fabricate the draw_single_object tool call
        const comp = session.pendingComponent;
        const match = session.pendingMatch;
        const sfn = match.SystemFullName;

        const toolCallResp = buildDrawToolCall(
          session.docUID, session.docType || 29,
          comp.tag, comp.description, sfn,
          comp.x, comp.y, model,
          !hasDirectDrawTool && hasImportTool
        );

        // Store pending draw info — will be moved to drawnObjects or failedObjects
        // after the tool result comes back in the "drawing" step
        session.lastDrawAttempt = {
          tag: comp.tag,
          description: comp.description,
          systemFullName: sfn,
          x: comp.x,
          y: comp.y,
        };

        session.step = "drawing";
        session.storedAt = Date.now();

        sendJsonResponse(res, 200, toolCallResp, { "X-Comos-Ai-Shim": "drawing-tool-call" });
        log(`drawing_tool_call session=${sessionKey} tag=${comp.tag} sfn=${sfn}`);
        return true;
      }

      // User typed something else — maybe a connection or new component?
      // Check for connection intent first
      if (detectConnectionIntent(msg)) {
        const connParsed = parseConnectionInput(msg);
        if (connParsed) {
          const { sourceTag, targetTag } = connParsed;
          const srcObj = resolveTagForConnection(session, sourceTag);
          const tgtObj = resolveTagForConnection(session, targetTag);
          if (srcObj && tgtObj) {
            const toolCallResp = buildConnectToolCall(
              session.docUID, session.docType || 29,
              srcObj.tag, tgtObj.tag,
              srcObj.systemFullName, tgtObj.systemFullName, model
            );
            session.pendingConnection = {
              sourceTag: srcObj.tag, targetTag: tgtObj.tag,
              sourceSFN: srcObj.systemFullName, targetSFN: tgtObj.systemFullName,
              toolCallId: toolCallResp?.choices?.[0]?.message?.tool_calls?.[0]?.id || "",
            };
            session.step = "connecting";
            sendJsonResponse(res, 200, toolCallResp, { "X-Comos-Ai-Shim": "drawing-connect-tool-call" });
            log(`drawing_connect session=${sessionKey} src=${srcObj.tag} tgt=${tgtObj.tag}`);
            return true;
          }
        }
      }

      const newComp = parseComponentInput(msg);
      if (newComp) {
        // Treat as new component, discard previous match
        session.pendingComponent = newComp;
        session.storedAt = Date.now();

        // ── SystemFullName bypass for new component in confirm_match ──
        const sfnPat = /^@[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+$/;
        if (sfnPat.test((newComp.description || "").trim())) {
          const directSFN = newComp.description.trim();
          log(`drawing_sfn_bypass session=${sessionKey} sfn=${directSFN} tag=${newComp.tag} (from confirm_match)`);

          const toolCallResp = buildDrawToolCall(
            session.docUID, session.docType || 29,
            newComp.tag, newComp.tag, directSFN,
            newComp.x, newComp.y, model,
            !hasDirectDrawTool && hasImportTool
          );

          session.lastDrawAttempt = {
            tag: newComp.tag,
            description: directSFN,
            systemFullName: directSFN,
            x: newComp.x,
            y: newComp.y,
          };

          session.step = "drawing";
          session.storedAt = Date.now();
          sendJsonResponse(res, 200, toolCallResp, { "X-Comos-Ai-Shim": "drawing-tool-call-sfn-bypass" });
          return true;
        }

        session.step = "matching";
        const matchResult = await matchComponent(newComp.description, newComp.tag, session.diagramType, session.diagramSubtype);
        if (!matchResult || !matchResult.SystemFullName) {
          session.step = "ask_component";
          sendJsonResponse(res, 200, buildCompletionResponse(
            `❌ **No match** for "${newComp.description}". Try a different description or type **"done"**.`,
            model
          ), { "X-Comos-Ai-Shim": "drawing-no-match" });
          return true;
        }

        session.pendingMatch = matchResult;
        session.step = "confirm_match";
        const confidence = matchResult["Confiança"] || matchResult.Confiança || 0;
        const confPct = (confidence * 100).toFixed(1);
        sendJsonResponse(res, 200, buildCompletionResponse(
          `🔍 **Match:** ${matchResult.Descricao_ref || "?"} — \`${matchResult.SystemFullName}\` (${confPct}%)\n\n` +
          `Tag: **${newComp.tag}** at (${newComp.x}, ${newComp.y})\n\n` +
          `Reply **"yes"**/**"sim"** to draw, **"no"** to skip.`,
          model
        ), { "X-Comos-Ai-Shim": "drawing-confirm" });
        return true;
      }

      // Unrecognized input
      sendJsonResponse(res, 200, buildCompletionResponse(
        "Please reply **\"yes\"** to draw, **\"no\"** to skip, or describe another component.\n\n" +
        "Example: `create a motor named M001 at coordinate X 100 and coordinate Y 200`",
        model
      ), { "X-Comos-Ai-Shim": "drawing-confirm-retry" });
      return true;
    }

    // ── STEP: connecting — connect_objects tool_call was sent, waiting for result ──
    if (session.step === "connecting") {
      const latestTool = parseLatestConnectToolResult(
        info.messages || parsed.messages || parsed.Messages || [],
        session.pendingConnection || null
      );
      let connectResultMsg = "";

      // NOTE: Auto-retry removed — COMOS client can only handle ONE round of
      // tool calling per user message. Sending a second tool_call causes COMOS
      // to show "what's up?" instead of executing it. Retry logic now lives
      // inside the DLL ConnectObjects method (Close+Open report cycle).

      if (latestTool && latestTool.connected) {
        const connectedSource = latestTool.sourceTag || session.pendingConnection?.sourceTag || "?";
        const connectedTarget = latestTool.targetTag || session.pendingConnection?.targetTag || "?";
        if (!session.connections) session.connections = [];
        session.connections.push({
          sourceTag: connectedSource,
          targetTag: connectedTarget,
          sourceSFN: session.pendingConnection?.sourceSFN || "",
          targetSFN: session.pendingConnection?.targetSFN || "",
        });
        connectResultMsg = `🔗 **Connected:** ${connectedSource} → ${connectedTarget}\n\n`;
      } else if (latestTool) {
        connectResultMsg = `⚠️ Connection failed: ${latestTool.error || "Unknown error"}\n\n`;
      } else {
        connectResultMsg = `⚠️ Connection status not confirmed yet. Please repeat the connection command once.\n\n`;
      }

      session.step = "ask_component";
      session.pendingConnection = null;
      session.storedAt = Date.now();

      // Report last connection and ask for next action
      const lastConn = (session.connections || []).slice(-1)[0];
      const connMsg = lastConn
        ? `🔗 **Last confirmed connection:** ${lastConn.sourceTag} → ${lastConn.targetTag}\n\n`
        : "";
      sendJsonResponse(res, 200, buildCompletionResponse(
        connectResultMsg +
        connMsg +
        `What next?\n\n` +
        `- Describe a component (natural language):\n` +
        `  \`create a motor named M001 at coordinate X 100 and coordinate Y 200\`\n` +
        `  \`Motor 3-phase, =M01.Q01, 100, 200\`\n` +
        `- Connect objects: **conectar X em Y** / **connect X to Y**\n` +
        `- Type **"done"** to finish.`,
        model
      ), { "X-Comos-Ai-Shim": "drawing-connect-done" });
      return true;
    }

    // ── STEP: drawing — tool_call was sent, waiting for tool result ──
    if (session.step === "drawing") {
      const latestTool = parseLatestToolResult(info.messages || parsed.messages || parsed.Messages || []);

      // After tool execution, COMOS sends back tool result via /completions/evaluation
      // or the user sends a new message. Either way, transition back to ask_component.
      session.step = "ask_component";
      const drawAttempt = session.lastDrawAttempt || session.pendingComponent;
      session.pendingComponent = null;
      session.pendingMatch = null;
      session.lastDrawAttempt = null;
      session.storedAt = Date.now();

      // Classify the draw result and track accordingly
      let drawnMsg = "";
      if (latestTool && latestTool.success === false) {
        // FAILED — add to failedObjects, NOT drawnObjects
        const failureDetail =
          (latestTool.error && String(latestTool.error).trim()) ||
          (latestTool.message && String(latestTool.message).trim()) ||
          "Unknown error";
        if (!session.failedObjects) session.failedObjects = [];
        if (drawAttempt) {
          session.failedObjects.push({
            tag: drawAttempt.tag || "(unknown)",
            description: drawAttempt.description || "",
            systemFullName: drawAttempt.systemFullName || "",
            x: drawAttempt.x || 0,
            y: drawAttempt.y || 0,
            error: failureDetail,
          });
        }
        drawnMsg = `⚠️ Drawing failed for **${drawAttempt?.tag || "component"}**: ${failureDetail}.\n\n`;
      } else if (latestTool && latestTool.success === true) {
        // SUCCESS — add to drawnObjects
        if (!session.drawnObjects) session.drawnObjects = [];
        if (drawAttempt) {
          session.drawnObjects.push({
            tag: drawAttempt.tag,
            description: drawAttempt.description,
            systemFullName: drawAttempt.systemFullName,
            x: drawAttempt.x,
            y: drawAttempt.y,
          });
        }
        drawnMsg = `✅ Drawn: **${drawAttempt?.tag || "(component)"}**\n\n`;
      } else {
        // No tool result parsed (ambiguous) — add to drawnObjects optimistically
        // but mark with a warning
        if (!session.drawnObjects) session.drawnObjects = [];
        if (drawAttempt) {
          session.drawnObjects.push({
            tag: drawAttempt.tag,
            description: drawAttempt.description,
            systemFullName: drawAttempt.systemFullName,
            x: drawAttempt.x,
            y: drawAttempt.y,
          });
        }
        drawnMsg = `⚠️ Draw result for **${drawAttempt?.tag || "component"}** could not be confirmed.\n\n`;
      }

      sendJsonResponse(res, 200, buildCompletionResponse(
        drawnMsg +
        `What next?\n\n` +
        `- Describe a component (natural language):\n` +
        `  \`create a motor named M001 at coordinate X 100 and coordinate Y 200\`\n` +
        `  \`Motor 3-phase, =M01.Q01, 100, 200\`\n` +
        `- Connect objects: **conectar X em Y** / **connect X to Y**\n` +
        `- Type **"done"** to finish.`,
        model
      ), { "X-Comos-Ai-Shim": "drawing-done" });
      return true;
    }

    // Active session exists but no known step matched
    return true;
  }

  // Start a new interactive drawing session only on explicit intent
  if (!detectInteractiveDrawingIntent(msg)) {
    return false;
  }

  // ── BATCH DRAWING MODE ──────────────────────────────────────────────────
  // Detect requests like "criar 4 partidas diretas no diagrama FA.009 distribuidas horizontalmente"
  // Auto-plan all draws: match component once, calculate positions, send parallel tool_calls.
  const batchReq = parseBatchDrawingRequest(msg);
  if (batchReq) {
    log(`batch_drawing_detected session=${sessionKey} count=${batchReq.count} type="${batchReq.componentType}" doc=${batchReq.document} dist=${batchReq.distribution}`);
    emitAgentEvent("tool_start", { label: `Planning: ${batchReq.count} × ${batchReq.componentType}` });

    // If no document specified, ask for it before proceeding
    if (!batchReq.document) {
      const batchSession = {
        step: "batch_ask_document",
        batchRequest: batchReq,
        docUID: "",
        docType: 29,
        diagramType: batchReq.diagramType,
        diagramSubtype: "",
        drawnObjects: [],
        failedObjects: [],
        connections: [],
        pendingComponent: null,
        pendingMatch: null,
        lastDrawAttempt: null,
        storedAt: Date.now(),
        _sessionKey: sessionKey,
      };
      drawingSessions.set(sessionKey, batchSession);
      const askMsg =
        `📐 **Batch Drawing**: ${batchReq.count} × ${batchReq.componentType} (${batchReq.distribution})\n\n` +
        `Please provide the document name (e.g., \`FA.009\`).\n\n` +
        `> You can also paste the document's SystemUID.`;
      sendJsonResponse(res, 200, buildCompletionResponse(askMsg, model), { "X-Comos-Ai-Shim": "batch-ask-document" });
      return true;
    }

    // Match the component type using gateway matcher
    emitAgentEvent("tool_start", { label: `Matching: "${batchReq.componentType}"` });
    const matchResult = await matchComponent(batchReq.componentType, "", batchReq.diagramType, "");

    if (!matchResult || !matchResult.SystemFullName) {
      const errDetail = matchResult?.error || "No match found in component catalog";
      sendJsonResponse(res, 200, buildCompletionResponse(
        `❌ **No match found** for "${batchReq.componentType}".\n\n` +
        `Error: ${errDetail}\n\n` +
        `Try a more specific description (e.g., "partida direta", "motor trifásico", "contactor 3-pole").`,
        model
      ), { "X-Comos-Ai-Shim": "batch-no-match" });
      log(`batch_no_match session=${sessionKey} type="${batchReq.componentType}" err=${errDetail}`);
      return true;
    }

    const sfn = matchResult.SystemFullName;
    const refDesc = matchResult.Descricao_ref || matchResult.descricao_ref || batchReq.componentType;
    log(`batch_matched session=${sessionKey} sfn=${sfn} ref="${refDesc}"`);
    emitAgentEvent("tool_result", { label: `Matched: ${refDesc}` });

    // Calculate positions for all objects
    const tagPrefix = inferTagPrefix(batchReq.componentType);
    const startX = 50, startY = 50;
    const spacingH = 60, spacingV = 40;
    const allDraws = [];
    for (let i = 0; i < batchReq.count; i++) {
      const x = batchReq.distribution === "horizontal" ? startX + i * spacingH : startX;
      const y = batchReq.distribution === "vertical" ? startY + i * spacingV : startY;
      const tag = `${tagPrefix}${String(i + 1).padStart(3, "0")}`;
      allDraws.push({
        documentUID: batchReq.document,
        documentType: 29,
        tag,
        description: refDesc,
        systemFullName: sfn,
        x, y,
      });
    }

    // Split into first batch and remaining
    const currentBatch = allDraws.slice(0, MAX_DRAWS_PER_BATCH);
    const remaining = allDraws.slice(MAX_DRAWS_PER_BATCH);

    // Create session with batch state
    const batchSession = {
      step: "batch_drawing",
      docUID: batchReq.document,
      docType: 29,
      diagramType: batchReq.diagramType,
      diagramSubtype: "",
      drawnObjects: [],
      failedObjects: [],
      connections: [],
      batchDraws: remaining,       // draws still pending
      batchTotal: batchReq.count,
      batchSent: currentBatch.length,
      batchComponentType: batchReq.componentType,
      batchRefDesc: refDesc,
      batchSFN: sfn,
      pendingComponent: null,
      pendingMatch: null,
      lastDrawAttempt: null,
      storedAt: Date.now(),
      _sessionKey: sessionKey,
    };
    drawingSessions.set(sessionKey, batchSession);

    // Build multi-tool-call response for the first batch
    const resp = buildBatchDrawToolCalls(currentBatch, model, !hasDirectDrawTool && hasImportTool);

    const posDesc = currentBatch.map(d => `${d.tag}@(${d.x},${d.y})`).join(", ");
    emitAgentEvent("tool_start", { label: `Drawing batch 1: ${posDesc}` });
    sendJsonResponse(res, 200, resp, { "X-Comos-Ai-Shim": "batch-draw-tool-calls" });
    log(`batch_draw_start session=${sessionKey} batch=${currentBatch.length} remaining=${remaining.length} draws=[${posDesc}]`);
    return true;
  }

  // ── SINGLE INSTANT DRAW ─────────────────────────────────────────────────
  // "Draw a Frequency Inverter Starter on FS.001" → match + draw immediately
  const singleReq = parseSingleDrawRequest(msg);
  if (singleReq && singleReq.document) {
    log(`single_draw_detected session=${sessionKey} type="${singleReq.componentType}" doc=${singleReq.document}`);
    emitAgentEvent("tool_start", { label: `Matching: "${singleReq.componentType}"` });

    const matchResult = await matchComponent(singleReq.componentType, "", singleReq.diagramType, "");

    if (!matchResult || !matchResult.SystemFullName) {
      const errDetail = matchResult?.error || "No match found in component catalog";
      sendJsonResponse(res, 200, buildCompletionResponse(
        `❌ **No match found** for "${singleReq.componentType}".\n\n` +
        `Error: ${errDetail}\n\n` +
        `Try a more specific description (e.g., "partida direta", "motor trifásico", "contactor 3-pole").`,
        model
      ), { "X-Comos-Ai-Shim": "single-draw-no-match" });
      log(`single_draw_no_match session=${sessionKey} type="${singleReq.componentType}" err=${errDetail}`);
      return true;
    }

    const sfn = matchResult.SystemFullName;
    const refDesc = matchResult.Descricao_ref || matchResult.descricao_ref || singleReq.componentType;
    log(`single_draw_matched session=${sessionKey} sfn=${sfn} ref="${refDesc}"`);
    emitAgentEvent("tool_result", { label: `Matched: ${refDesc}` });

    const tagPrefix = inferTagPrefix(singleReq.componentType);
    const tag = `${tagPrefix}001`;
    const x = 50, y = 50;

    // Create a drawing session so the user can continue drawing more or connect
    const singleSession = {
      step: "drawing",
      docUID: singleReq.document,
      docType: 29,
      diagramType: singleReq.diagramType,
      diagramSubtype: "",
      drawnObjects: [],
      failedObjects: [],
      connections: [],
      pendingComponent: null,
      pendingMatch: null,
      lastDrawAttempt: { tag, description: refDesc, systemFullName: sfn, x, y },
      storedAt: Date.now(),
      _sessionKey: sessionKey,
    };
    drawingSessions.set(sessionKey, singleSession);

    // Send the draw tool_call immediately
    const resp = buildDrawToolCall(
      singleReq.document, 29, tag, refDesc, sfn, x, y,
      model, !hasDirectDrawTool && hasImportTool
    );
    emitAgentEvent("tool_start", { label: `Drawing: ${tag} (${refDesc})` });
    sendJsonResponse(res, 200, resp, { "X-Comos-Ai-Shim": "single-draw-tool-call" });
    log(`single_draw_start session=${sessionKey} tag=${tag} sfn=${sfn} doc=${singleReq.document}`);
    return true;
  }

  const lc = msg.toLowerCase();
  let initialType = "electrical";
  if (/\b(p&?id|pid)\b/i.test(lc)) {
    initialType = "pid";
  } else if (/\b(el[eé]trico|electrical)\b/i.test(lc)) {
    initialType = "electrical";
  }

    // Check if user already included a document name/UID in the message
    // (e.g., "start interactive mode on FA.020", "Draw a Starter at the diagram FS.001")
    let initialDocUID = "";
    const docInMsg = lc.match(/\b([a-z]{2}\.\d[\w.]*)\b/i) ||
                     lc.match(/\b(A[A-Z0-9]{9})\b/) ||
                     lc.match(/\b(?:at|on|in|no|na)\s+(?:the\s+|o\s+|a\s+)?(?:diagram[a]?\s+|document[o]?\s+)?([\w][\w.]+)/i);
    if (docInMsg) {
      initialDocUID = docInMsg[1];
    }

    // Seed drawnObjects from completedAnalyses if available (objects drawn by batch import)
    const seedObjects = [];
    const cachedAnalysis = completedAnalyses.get(sessionKey);
    if (cachedAnalysis && Array.isArray(cachedAnalysis.items)) {
      for (const it of cachedAnalysis.items) {
        if (it.tag && it.SystemFullName) {
          seedObjects.push({
            tag: it.tag,
            description: it.descricao || "",
            systemFullName: it.SystemFullName,
            x: it.x_mm || 0,
            y: it.y_mm || 0,
          });
        }
      }
      if (seedObjects.length > 0) {
        log(`drawing_seed_from_analysis session=${sessionKey} count=${seedObjects.length}`);
      }
    }

    // If we already have a document name/UID, decide next step based on diagram type
    let initialStep;
    if (!initialDocUID) {
      initialStep = "ask_document";
    } else if (initialType === "electrical") {
      initialStep = "ask_subtype";
    } else {
      initialStep = "ask_component";
    }

    const newSession = {
      step: initialStep,
      docUID: initialDocUID,
      docType: 29,
      diagramType: initialType,
      diagramSubtype: "",
      drawnObjects: seedObjects,
      failedObjects: [],
      connections: [],
      pendingConnection: null,
      pendingComponent: null,
      pendingMatch: null,
      lastDrawAttempt: null,
      storedAt: Date.now(),
      _sessionKey: sessionKey,
    };
    drawingSessions.set(sessionKey, newSession);

    if (initialStep === "ask_document") {
      // Ask user for the document name
      const askDocMsg =
        `📐 **Interactive Drawing Mode** (${initialType === "pid" ? "P&ID" : "Electrical"})\n\n` +
        `Please provide the **name** of the COMOS document (drawing) you want to work on.\n\n` +
        `> Example: \`FA.020\` or \`=S1.A1.FA.020\`\n\n` +
        `You can also paste the document's **SystemUID** (e.g., \`A5BKD4FN3Y\`).`;
      sendJsonResponse(res, 200, buildCompletionResponse(askDocMsg, model), { "X-Comos-Ai-Shim": "drawing-ask-document" });
      log(`drawing_started session=${sessionKey} step=ask_document type=${initialType}`);
    } else if (initialStep === "ask_subtype") {
      // Document known but need electrical subtype
      const askSubtypeMsg =
        `📐 **Interactive Drawing Mode** (Electrical)\n\n` +
        `📄 Document: **${initialDocUID}**\n\n` +
        `What type of electrical diagram is this?\n\n` +
        `1. **Single-line** (unipolar)\n` +
        `2. **Multiline** (multifilar)\n\n` +
        `Reply **1** or **single** for single-line, **2** or **multi** for multiline.`;
      sendJsonResponse(res, 200, buildCompletionResponse(askSubtypeMsg, model), { "X-Comos-Ai-Shim": "drawing-ask-subtype" });
      log(`drawing_started session=${sessionKey} docUID=${initialDocUID} step=ask_subtype`);
    } else {
      // Document already known, non-electrical — go straight to component input
      const readyMsg =
        `📐 **Interactive Drawing Mode** (${initialType === "pid" ? "P&ID" : "Electrical"})\n\n` +
        `📄 Document: **${initialDocUID}**\n\n` +
        `Describe the component to place:\n\n` +
        `> **description, tag, X, Y**\n\n` +
        `Example: \`Motor 3-phase, =M01.Q01, 100, 200\`\n\n` +
        `You can also **connect** drawn objects:\n` +
        `> \`conectar D001 em K001\` or \`connect D001 to K001\`\n\n` +
        `Type **"done"** or **"pronto"** when finished.`;
      sendJsonResponse(res, 200, buildCompletionResponse(readyMsg, model), { "X-Comos-Ai-Shim": "drawing-started" });
      log(`drawing_started session=${sessionKey} docUID=${initialDocUID} type=${initialType}`);
    }
    return true;
}

// ── SSE Agent Events infrastructure ────────────────────────────────────────
// Connected SSE clients (chat-app.js opens EventSource to /api/ai/v1/agent-events)
const sseClients = new Set();

/** Emit an agent event to all connected SSE clients */
function emitAgentEvent(eventType, data) {
  const payload = JSON.stringify({ type: eventType, ...data, ts: Date.now() });
  const message = `event: ${eventType}\ndata: ${payload}\n\n`;
  for (const client of sseClients) {
    try { client.write(message); } catch { sseClients.delete(client); }
  }
  log(`sse_emit type=${eventType} clients=${sseClients.size} data=${JSON.stringify(data).substring(0, 120)}`);
}

/** Friendly tool labels for agent status messages */
const TOOL_FRIENDLY_LABELS = {
  // Navigation tools
  navigate_to_comos_object_by_name: "Navigating to object",
  navigate_to_comos_object_by_name_or_label: "Navigating to object",
  navigate_to_comos_object_by_systemUID: "Navigating to object by UID",
  navigate_to_comos_document_by_name: "Opening document",
  navigate_to_attribute_by_name_or_description: "Locating attribute",
  // Attribute tools
  value_of_attribute_by_name_or_description: "Reading attribute value",
  set_attribute_value: "Writing attribute value",
  list_object_attributes: "Listing object attributes",
  // Query/search tools
  objects_with_name: "Searching objects by name",
  get_count_of_comos_objects_with_name: "Counting objects",
  create_and_run_query: "Running COMOS query",
  export_query_to_excel: "Exporting query to Excel",
  // Drawing/import tools
  draw_single_object: "Drawing object on diagram",
  import_equipment_from_excel: "Importing equipment from Excel",
  extract_and_create_tags: "Creating tags in hierarchy",
  connect_objects: "Connecting objects",
  scan_document_tags: "Scanning diagram tags",
  // Document/report tools
  open_report: "Opening report",
  open_report_twodc: "Opening report in TwoDC",
  show_last_revision_of_document: "Showing last revision",
  create_new_revision: "Creating new revision",
  // CDevice/catalog tools
  list_all_cdevice_sfn: "Listing base objects",
  get_info_about_all_available_printers_and_all_available_paper: "Getting printer info",
  get_print_paper_name_for_document: "Getting paper size",
  // Test
  test_hello_world: "Testing connection",
  // Internal synthetic — should never show in UI
  _comos_executed_tool: null,
};

function friendlyToolLabel(toolName) {
  const label = TOOL_FRIENDLY_LABELS[toolName];
  if (label === null) return null; // explicitly hidden (internal synthetic tool)
  return label || toolName.replace(/_/g, " ");
}

// Track step counter per session for "Step N" labeling
const agentStepCounters = new Map();

// ── 95-second safety timeout for LLM fetch ────────────────────────────────
// COMOS C# AI Client TimeoutPerIteration was IL-patched from 30s → 100s.
// We abort 5s before that limit so the C# client doesn't throw an
// unhandled timeout exception.
const LLM_SAFETY_TIMEOUT_MS = 95000;

/**
 * Fetch with 95-second safety abort.
 * Returns { response, timedOut } — if timedOut is true, response is null.
 */
async function fetchWithSafetyTimeout(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_SAFETY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { response, timedOut: false };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      log(`safety_timeout_95s label=${label} url=${url}`);
      return { response: null, timedOut: true };
    }
    throw err; // re-throw non-timeout errors
  }
}

// ── Build OpenAI-compatible response ───────────────────────────────────────
function buildCompletionResponse(message, model) {
  return {
    id: `chatcmpl-shim-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || defaultModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: message },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendJsonResponse(res, statusCode, body, extraHeaders) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(json);
}

// ── COMOS system prompt for normal chat (overrides gateway MCP identity) ────
const COMOS_SYSTEM_PROMPT =
  "You are the COMOS AI Engineering Assistant, integrated into the Siemens COMOS desktop application. " +
  "Your role is to help plant engineers with tasks inside COMOS such as navigating to objects, " +
  "opening reports, querying attributes, managing revisions, printing documents and searching objects. " +
  "\n\n" +
  "IMPORTANT RULES:\n" +
  "1. You MUST use ONLY the tools provided in the 'tools' array of this request. " +
  "These are COMOS native functions that the desktop application executes locally.\n" +
  "2. You MUST NOT mention, describe or offer capabilities related to: PDF analysis, PDF digitization, " +
  "P&ID generation, diagram analysis, knowledge base, base64, analyze_pdf, generate_pid, " +
  "store_pid_knowledge, list_knowledge_base, describe_pid, chat_about_pid, backend_health, backend_ping. " +
  "Those are NOT your tools.\n" +
  "3. When the user asks what you can do, list ONLY the capabilities matching the 'tools' array " +
  "(e.g. navigate to objects, open reports, query attributes, export data, manage revisions, print).\n" +
  "4. Always respond in the same language as the user's message (Portuguese if they write in Portuguese).\n" +
  "4b. You must understand both Portuguese and English intents for the same COMOS actions.\n" +
  "5. When calling a tool, use the exact function name and parameters defined in the 'tools' array.\n" +
  "6. If the user's request cannot be fulfilled with the available tools, assist with general COMOS knowledge.\n" +
  "7. Call AT MOST ONE tool per response. NEVER call multiple tools in a single response. " +
  "Wait for each tool result before deciding the next action.\n" +
  "8. If a tool call returns a failure (success=False or error), explain the failure clearly. " +
  "For navigation and attribute lookup requests, you MAY try up to 3 additional attempts (max 4 total) " +
  "using another lookup tool or a normalized query (trim spaces, remove quotes, try name vs label/description, " +
  "try partial keywords). For attribute lookups, ALWAYS include the systemUID in retries. " +
  "NEVER say 'I cannot access' or suggest manual steps if you haven't exhausted all retries. " +
  "For other operations, do not retry automatically.\n" +
  "9. You may call tools for both actions and COMOS data questions that require live project data " +
  "(e.g., attribute value, object count, object existence). " +
  "Do not answer these from memory when a matching tool exists.\n" +
  "10. For object navigation by text (e.g. 'go to PC-001', 'navigate to M-002'), " +
  "ALWAYS use navigate_to_comos_object_by_name as your FIRST choice. " +
  "This tool does a reliable full tree scan and will find the object. " +
  "Do NOT use objects_with_name for navigation — it uses an unreliable query and often returns 0 results even for objects that exist. " +
  "objects_with_name should ONLY be used for counting or existence checks, NOT for navigation. " +
  "If navigate_to_comos_object_by_name_or_label is available, you may use it as an alternative. " +
  "If the user provides a SystemUID, prefer navigate_to_comos_object_by_systemUID.\n" +
  "10a. IMPORTANT — Object name variations: COMOS object names may differ from how the user types them. " +
  "For example, the user may say 'PC-001' but the actual COMOS Name property is 'PC001' (no hyphen), or vice-versa. " +
  "If navigate_to_comos_object_by_name returns 'Object doesn't found', ALWAYS retry with the tag WITHOUT the separator " +
  "(e.g., 'PC-001' → try 'PC001'; 'AG 005' → try 'AG005'). If still not found, try WITH a hyphen " +
  "(e.g., 'PC001' → try 'PC-001'). Try at least 2 name variations before giving up.\n" +
  "11. CRITICAL FOR ATTRIBUTES: When the user asks for an attribute value (e.g., 'What is the Shaft Power of P-101?'), " +
  "you MUST call value_of_attribute_by_name_or_description IMMEDIATELY — do NOT navigate to the object first, " +
  "do NOT say 'I can't run the lookup', do NOT ask for confirmation, do NOT offer manual instructions. " +
  "The attribute tools execute locally inside COMOS and always have access. " +
  "ALWAYS pass the systemUID parameter when you have one from previous tool results. " +
  "For attribute navigation requests, use navigate_to_attribute_by_name_or_description instead.\n" +
  "11a. If an attribute tool returns 'Object doesn't found', DO NOT give up. Retry with these variations " +
  "(max 4 total attempts): " +
  "(1) original user text as-is, " +
  "(2) simplified/trimmed name (e.g., 'Shaft Power' → 'Power'), " +
  "(3) short alias (e.g., 'P_shaft', 'ShaftPower', 'Potência'), " +
  "(4) partial match with a single keyword (e.g., just 'Shaft' or just 'Power'). " +
  "Always include the systemUID in every retry. " +
  "Only after exhausting these retries, explain that the attribute was not found and " +
  "suggest the user check the exact attribute name or tab in COMOS.\n" +
  "11b. For count questions in Portuguese or English (e.g., 'quantos objetos X existem' / 'how many objects X do we have'), " +
  "use get_count_of_comos_objects_with_name with objectName=X before answering.\n" +
  "11c. If user asks broad class counts without exact tag/name (e.g., 'quantas bombas temos?' / 'how many pumps do we have?'), " +
  "infer the class term and call get_count_of_comos_objects_with_name with the normalized singular term before answering.\n" +
  "11d. If user asks count with equipment type + attribute filter (e.g., 'quantas bombas de 100 kW' / 'how many pumps with 100 kW'), " +
  "parse both parts and attempt filtered counting using available tools; if true filtered aggregation is not possible with available tools, explain this limitation and guide query-based filtering.\n" +
  "11e. CRITICAL: When a count tool (get_count_of_comos_objects_with_name) returns a result — even if the count is 0 — you MUST report the number to the user. " +
  "NEVER say 'I cannot run the count', 'I don't have access', or 'I'll run it when access is available' if the tool already returned a result. " +
  "If the count is 0, say something like 'There are 0 objects named X in the project. You may want to try a different name or tag prefix.' " +
  "The tool executes locally inside COMOS and always has access.\n" +
  "11f. CRITICAL FOR ATTRIBUTE RESULTS: When an attribute tool (value_of_attribute_by_name_or_description or navigate_to_attribute_by_name_or_description) returns a result — even if success is False — you MUST report the outcome to the user. " +
  "If the tool returned a value, present it clearly. If it returned an error like 'Object doesn't found', say 'The attribute X was not found on that object — it may be named differently in COMOS. Would you like me to try alternative names?' " +
  "NEVER say 'I can't run the lookup', 'I don't have access', 'I'll fetch it in the next step', or 'I'll run it when access is available' if the tool already returned a result. " +
  "These tools execute locally inside COMOS and always have access.\n" +
  "12. ATTRIBUTE WRITE WORKFLOW (MANDATORY 2-step process):\n" +
  "  a) FIRST call value_of_attribute_by_name_or_description to read the current value — " +
  "this validates the object exists and returns the systemUID you need.\n" +
  "  b) THEN call set_attribute_value passing the systemUID from step (a), the attributeName, and the newValue.\n" +
  "  c) If no write tool (set_attribute_value) exists in this request, explain that write is unavailable and offer to read/navigate instead.\n" +
  "  d) NEVER call set_attribute_value without first reading the attribute. The read tool resolves the object internally.\n" +
  "13. TOOL SELECTION GUIDE — use this mapping to choose the correct tool for each user intent:\n" +
  "  • COUNT objects ('how many X', 'quantos X', 'quantidade de X') → get_count_of_comos_objects_with_name\n" +
  "  • LIST objects ('list objects named X', 'listar objetos X') → objects_with_name (NOT for navigation)\n" +
  "  • GO TO / NAVIGATE to object ('go to X', 'ir para X', 'navegar até X', 'abrir X', 'selecionar X') → navigate_to_comos_object_by_name (or _by_name_or_label)\n" +
  "  • GO TO by SystemUID ('go to A541598NS5') → navigate_to_comos_object_by_systemUID\n" +
  "  • OPEN DOCUMENT / GO TO DOCUMENT ('open document X', 'abrir documento X', 'ir para documento X') → navigate_to_comos_document_by_name\n" +
  "  • GO TO ATTRIBUTE ('show attribute X', 'ir para atributo X', 'navegar até atributo X') → navigate_to_attribute_by_name_or_description\n" +
  "  • GET ATTRIBUTE VALUE ('what is the X of Y', 'qual o X de Y', 'valor do atributo X') → value_of_attribute_by_name_or_description\n" +
  "  • EXPORT QUERY ('export query X', 'exportar query X', 'exportar consulta') → export_query_to_excel\n" +
  "  • OPEN REPORT ('open report X', 'abrir relatório X', 'gerar relatório X') → open_report\n" +
  "  • OPEN REPORT IN TWODC ('open report in TwoDC', 'abrir relatório no TwoDC') → open_report_twodc\n" +
  "  • LIST PRINTERS ('list printers', 'listar impressoras', 'quais impressoras', 'available printers') → get_info_about_all_available_printers_and_all_available_paper\n" +
  "  • PAPER SIZE ('what paper for document', 'tamanho do papel', 'papel do documento') → get_print_paper_name_for_document\n" +
  "  • LAST REVISION ('last revision', 'última revisão', 'mostrar revisão', 'show revision') → show_last_revision_of_document\n" +
  "  • CREATE REVISION ('create revision', 'criar revisão', 'nova revisão', 'new revision') → create_new_revision\n" +
  "  • SET ATTRIBUTE VALUE ('set X to Y', 'change X to Y', 'alterar X para Y', 'defina X como Y') → ALWAYS read first with value_of_attribute_by_name_or_description, then set_attribute_value with the systemUID from the read result\n" +
  "  • LIST ATTRIBUTES ('list attributes', 'show attributes', 'listar atributos', 'quais atributos') → list_object_attributes — use when an attribute is not found to show what's available\n" +
  "\n" +
  "IMPORT WORKFLOW (after ServiceiPID analysis):\n" +
  "When the user asks to import/draw/create objects from an analysis in a COMOS diagram:\n" +
  "- The user will specify which diagram they want (by name or path like '=A1.10').\n" +
  "- You need the diagram's SystemUID — use 'objects_with_name' and then 'navigate_to_comos_document_by_name' " +
  "or 'navigate_to_comos_object_by_name' to find the document and obtain its SystemUID/UID.\n" +
  "- If the 'import_equipment_from_excel' tool is available in your tools list, use it to " +
  "import automatically. Pass the excelFilePath from the analysis, the documentUID, and documentType=29.\n" +
  "- If the user asks for a VBScript instead (option 2), inform them that you will generate " +
  "a script and include it in the response text.\n" +
  "- The Excel file path from the last analysis will be provided in the conversation context.\n";

// ── The question message sent when PDF is detected ─────────────────────────
const ASK_DIAGRAM_TYPE_MSG =
  "📄 **PDF received successfully!**\n\n" +
  "Before starting the digitization, I need to know the diagram type.\n" +
  "Please reply with one of the options:\n\n" +
  "**1** — P&ID (Piping and Instrumentation Diagram)\n" +
  "**2** — Electrical Diagram\n" +
  "**3** — Tags Only (Extract tags from diagrams → ISA/IEC descriptions → Hierarchy creation)\n" +
  "**4** — Document (Extract equipment/tags from RFQs, specs, equipment lists, datasheets)\n\n" +
  "_Reply by typing **1**, **2**, **3**, or **4**, or write the type (e.g. \"P&ID\", \"Electrical\", \"Tags only\", or \"Document\")._";

// ── Main HTTP server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const urlPath = req.url || "/";
  const basePath = urlPath.split("?")[0];   // strip query params for matching

  // Log EVERY incoming request for diagnostics
  log(`req_in ${method} ${urlPath}`);

  try {
    // ── HEAD validation (ValidateConnectionAsync) ────────────────────────
    if (method === "HEAD" && basePath === "/api/ai/v1/completions") {
      res.writeHead(200, { "X-Comos-Ai-Shim": "head-ok" });
      res.end();
      log(`head_ok ${urlPath}`);
      return;
    }

    // ── CORS preflight for upload endpoint ───────────────────────────────
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // ── SSE Agent Events endpoint ────────────────────────────────────────
    // Chat-app.js opens an EventSource here to receive real-time agent
    // status updates (thinking, tool calls, timeouts, completion).
    if (method === "GET" && basePath === "/api/ai/v1/agent-events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      // Send initial heartbeat
      res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      sseClients.add(res);
      log(`sse_client_connected total=${sseClients.size}`);
      req.on("close", () => {
        sseClients.delete(res);
        log(`sse_client_disconnected total=${sseClients.size}`);
      });
      // Keep-alive ping every 20s to prevent proxy/browser timeout
      const keepAlive = setInterval(() => {
        try { res.write(`:ping\n\n`); } catch { clearInterval(keepAlive); sseClients.delete(res); }
      }, 20000);
      req.on("close", () => clearInterval(keepAlive));
      return;
    }

    // ── Save-to-disk download: /api/ai/v1/save-download ──────────────────
    // CefSharp has no IDownloadHandler, so blob/anchor.click() downloads
    // silently fail.  Instead the JS sends the URL here and we save to disk.
    if (method === "POST" && basePath === "/api/ai/v1/save-download") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) {
        return sendJsonResponse(res, 400, { error: "Invalid JSON" });
      }
      const dlUrl = parsed.url;
      if (!dlUrl) return sendJsonResponse(res, 400, { error: "Missing url" });

      log(`save_download url=${dlUrl}`);
      try {
        // Fetch the file (supports both gateway direct and shim proxy URLs)
        const gwUrl = dlUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${gatewayBase.split(':').pop()}`);
        const finalUrl = gwUrl.includes(String(listenPort)) ? `${gatewayBase}${new URL(dlUrl).pathname}` : gwUrl;
        // Just fetch from gateway directly
        const gwResp = await fetch(`${gatewayBase}${new URL(dlUrl).pathname}`);
        if (!gwResp.ok) {
          return sendJsonResponse(res, 502, { error: `Gateway returned ${gwResp.status}` });
        }
        const buf = Buffer.from(await gwResp.arrayBuffer());

        // Extract filename from Content-Disposition or URL
        let filename = parsed.filename || "download";
        const disposition = gwResp.headers.get("content-disposition");
        if (disposition) {
          const m = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
          if (m) filename = decodeURIComponent(m[1].replace(/"/g, ""));
        }

        // Save to COMOS_Downloads folder
        const dlDir = path.join(os.homedir(), "Documents", "COMOS_Downloads");
        fs.mkdirSync(dlDir, { recursive: true });
        const savePath = path.join(dlDir, filename);
        fs.writeFileSync(savePath, buf);
        log(`save_download_ok path=${savePath} size=${buf.length}`);

        // Try to open the file with the default application
        try {
          const { exec } = require("node:child_process");
          exec(`start "" "${savePath}"`);
          log(`save_download_opened ${savePath}`);
        } catch (openErr) {
          log(`save_download_open_failed ${openErr.message}`);
        }

        return sendJsonResponse(res, 200, {
          status: "saved",
          path: savePath,
          filename: filename,
          size: buf.length
        });
      } catch (dlErr) {
        log(`save_download_error ${dlErr.message}`);
        return sendJsonResponse(res, 502, { error: dlErr.message });
      }
    }

    // ── Download proxy: /comos/download/:id → gateway ────────────────────
    // CefSharp loads the chat from file:// so fetch() to localhost:8100
    // is blocked by CORS.  Routing through the shim keeps it same-origin.
    if (method === "GET" && basePath.startsWith("/comos/download/")) {
      log(`download_proxy ${basePath}`);
      try {
        const gwUrl = `${gatewayBase}${basePath}`;
        const gwResp = await fetch(gwUrl);
        if (!gwResp.ok) {
          res.writeHead(gwResp.status, { "Content-Type": "text/plain" });
          res.end(await gwResp.text());
          log(`download_proxy_error status=${gwResp.status}`);
          return;
        }
        const buf = Buffer.from(await gwResp.arrayBuffer());
        const headers = {
          "Access-Control-Allow-Origin": "*",
        };
        // Forward relevant headers from gateway
        for (const hdr of ["content-type", "content-disposition"]) {
          const val = gwResp.headers.get(hdr);
          if (val) headers[hdr] = val;
        }
        headers["content-length"] = String(buf.length);
        res.writeHead(200, headers);
        res.end(buf);
        log(`download_proxy_ok ${basePath} size=${buf.length}`);
      } catch (dlErr) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Download proxy error: ${dlErr.message}`);
        log(`download_proxy_error ${dlErr.message}`);
      }
      return;
    }

    // ── Excel export proxy: /comos/export-excel → gateway ────────────────
    // Used by the "Export with Selections" button in the confidence table
    if (method === "POST" && basePath === "/comos/export-excel") {
      log(`export_proxy ${basePath}`);
      try {
        const bodyBuf = await readBody(req);
        const gwResp = await fetch(`${gatewayBase}/comos/export-excel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyBuf,
        });
        const respBuf = Buffer.from(await gwResp.arrayBuffer());
        const respHeaders = { "Access-Control-Allow-Origin": "*" };
        for (const [k, v] of gwResp.headers.entries()) {
          if (k.toLowerCase() !== "transfer-encoding") respHeaders[k] = v;
        }
        res.writeHead(gwResp.status, respHeaders);
        res.end(respBuf);
        log(`export_proxy_ok status=${gwResp.status}`);
      } catch (expErr) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Export proxy error: ${expErr.message}`);
        log(`export_proxy_error ${expErr.message}`);
      }
      return;
    }

    // ── Generate VBS import script: /comos/generate-import-script → gateway
    if (method === "POST" && basePath === "/comos/generate-import-script") {
      log(`vbs_script_proxy ${basePath}`);
      try {
        const bodyBuf = await readBody(req);
        const gwResp = await fetch(`${gatewayBase}/comos/generate-import-script`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyBuf,
        });
        const respBuf = Buffer.from(await gwResp.arrayBuffer());
        const respHeaders = { "Access-Control-Allow-Origin": "*" };
        for (const [k, v] of gwResp.headers.entries()) {
          if (k.toLowerCase() !== "transfer-encoding") respHeaders[k] = v;
        }
        res.writeHead(gwResp.status, respHeaders);
        res.end(respBuf);
        log(`vbs_script_proxy_ok status=${gwResp.status}`);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`VBS script proxy error: ${err.message}`);
        log(`vbs_script_proxy_error ${err.message}`);
      }
      return;
    }

    // ── Get Excel file local path: /comos/excel-path/:id → gateway ──────
    if (method === "GET" && basePath.startsWith("/comos/excel-path/")) {
      log(`excel_path_proxy ${basePath}`);
      try {
        const gwResp = await fetch(`${gatewayBase}${basePath}`);
        const respBuf = Buffer.from(await gwResp.arrayBuffer());
        const respHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
        res.writeHead(gwResp.status, respHeaders);
        res.end(respBuf);
        log(`excel_path_proxy_ok status=${gwResp.status}`);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Excel path proxy error: ${err.message}`);
        log(`excel_path_proxy_error ${err.message}`);
      }
      return;
    }

    let bodyBuffer = await readBody(req);

    // ── Power Automate Bridge routes ──────────────────────────────────────────
    // POST /bridge/query — bridge queues a COMOS query (called by comos-pa-bridge.js)
    if (method === "POST" && basePath === "/bridge/query") {
      try {
        const params = bodyBuffer.length ? JSON.parse(bodyBuffer.toString("utf8")) : {};
        const id = `bq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const now = Date.now();
        for (const [k, v] of bridgeCommandQueue) {
          if (now - v.created > BRIDGE_TTL_MS) bridgeCommandQueue.delete(k);
        }
        bridgeCommandQueue.set(id, {
          id, status: "pending",
          command: String(params.command || ""),
          callbackUrl: params.callbackUrl || null,
          result: null, error: null, created: now,
        });
        sendJsonResponse(res, 200, { id, status: "pending" }, { "X-Comos-Ai-Shim": "bridge-queued" });
        log(`bridge_query_queued id=${id} command=${params.command}`);
      } catch (e) {
        sendJsonResponse(res, 400, { error: String(e.message) }, { "X-Comos-Ai-Shim": "bridge-error" });
      }
      return;
    }

    // POST /bridge/result/:id — bridge writes the fulfilled result back
    if (method === "POST" && /^\/bridge\/result\/[^/]+$/.test(basePath)) {
      const id = basePath.slice("/bridge/result/".length);
      const entry = bridgeCommandQueue.get(id);
      if (!entry) {
        sendJsonResponse(res, 404, { error: "not_found", id }, { "X-Comos-Ai-Shim": "bridge-not-found" });
        return;
      }
      try {
        const body = bodyBuffer.length ? JSON.parse(bodyBuffer.toString("utf8")) : {};
        entry.status = body.error ? "error" : "done";
        entry.result = body.result || null;
        entry.error  = body.error  || null;
        sendJsonResponse(res, 200, entry, { "X-Comos-Ai-Shim": "bridge-result-written" });
        log(`bridge_result_written id=${id} status=${entry.status}`);
      } catch (e) {
        sendJsonResponse(res, 400, { error: String(e.message) }, { "X-Comos-Ai-Shim": "bridge-error" });
      }
      return;
    }

    // GET /bridge/result/:id — PA or bridge polls for status/result
    if (method === "GET" && /^\/bridge\/result\/[^/]+$/.test(basePath)) {
      const id = basePath.slice("/bridge/result/".length);
      const entry = bridgeCommandQueue.get(id);
      if (!entry) {
        sendJsonResponse(res, 404, { error: "not_found", id }, { "X-Comos-Ai-Shim": "bridge-not-found" });
      } else {
        sendJsonResponse(res, 200, entry, { "X-Comos-Ai-Shim": "bridge-result" });
      }
      log(`bridge_result_poll id=${id} status=${entry ? entry.status : "missing"}`);
      return;
    }

    // GET /bridge/status — list all queued commands (debugging / MCP tool)
    if (method === "GET" && basePath === "/bridge/status") {
      const entries = [...bridgeCommandQueue.values()].map(e => ({
        id: e.id, status: e.status, command: e.command,
        created: new Date(e.created).toISOString(),
      }));
      sendJsonResponse(res, 200, { count: entries.length, commands: entries }, { "X-Comos-Ai-Shim": "bridge-status" });
      return;
    }

    // ── POST /api/ai/v1/completions — Main chat endpoint ────────────────
    if (method === "POST" && basePath === "/api/ai/v1/completions") {
      try {
        const text = bodyBuffer.toString("utf8");
        const parsed = text ? JSON.parse(text) : {};

        // Log every request for debugging
        logRequest(urlPath, parsed);

        // Inject model if missing
        if (!parsed.model || String(parsed.model).trim().length === 0) {
          parsed.model = defaultModel;
        }

        const info = extractRequestInfo(parsed);
        const sessionKey = info.sessionId || "__default__";

        // Clean expired pending PDFs periodically
        cleanExpiredPending();

        // ── NL CIRCUIT GENERATION — check active jobs ───────────────────
        const circuitCheck = checkActiveCircuitGeneration(sessionKey, parsed.model);
        if (circuitCheck) {
          const headerVal = circuitCheck.type === "progress" ? "circuit-gen-progress" : "circuit-gen-result";
          sendJsonResponse(res, 200, circuitCheck.body, { "X-Comos-Ai-Shim": headerVal });
          log(`active_circuit_gen_${circuitCheck.type} session=${sessionKey}`);
          return;
        }

        // ── NL CIRCUIT GENERATION — pending diagram type answer ─────────
        if (pendingCircuits.has(sessionKey) && info.lastUserMsg) {
          const diagramType = detectDiagramTypeAnswer(info.lastUserMsg);
          if (diagramType) {
            const pending = pendingCircuits.get(sessionKey);
            pendingCircuits.delete(sessionKey);

            log(`circuit_gen_step_b session=${sessionKey} type=${diagramType}`);

            startBackgroundCircuitGeneration(sessionKey, pending.prompt, diagramType);

            const dtLabel2 = diagramType === "electrical" ? "Electrical Diagram" : "P&ID";
            const startMsg2 =
              `⏳ **Starting ${dtLabel2} generation from description...**\n\n` +
              `Your circuit description is being processed by the AI.\n` +
              `This may take **1 to 3 minutes**.\n\n` +
              `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

            sendJsonResponse(res, 200,
              buildCompletionResponse(startMsg2, parsed.model),
              { "X-Comos-Ai-Shim": "circuit-gen-started" },
            );
            return;
          }
          // User didn't answer with a valid type — remind them
          if (!hasPdfAttachment(info)) {
            const reminder =
              "I did not understand the diagram type. Please reply:\n\n" +
              "**1** — P&ID\n**2** — Electrical Diagram\n\n" +
              "_Or type \"P&ID\" or \"Electrical\"._";
            sendJsonResponse(res, 200,
              buildCompletionResponse(reminder, parsed.model),
              { "X-Comos-Ai-Shim": "circuit-gen-type-reminder" },
            );
            return;
          }
        }

        // ── NL CIRCUIT GENERATION — detect new circuit intent ───────────
        if (info.lastUserMsg && !drawingSessions.has(sessionKey)) {
          const circuitIntent = detectCircuitGenerationIntent(info.lastUserMsg);
          if (circuitIntent) {
            if (circuitIntent.diagramType) {
              // Diagram type is clear from context → start immediately
              log(`circuit_gen_direct session=${sessionKey} type=${circuitIntent.diagramType}`);

              startBackgroundCircuitGeneration(sessionKey, circuitIntent.prompt, circuitIntent.diagramType);

              const dtLabel = circuitIntent.diagramType === "electrical" ? "Electrical Diagram" : "P&ID";
              const startMsg =
                `⏳ **Starting ${dtLabel} generation from description...**\n\n` +
                `Your circuit description is being processed by the AI.\n` +
                `This may take **1 to 3 minutes**.\n\n` +
                `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

              sendJsonResponse(res, 200,
                buildCompletionResponse(startMsg, parsed.model),
                { "X-Comos-Ai-Shim": "circuit-gen-started" },
              );
              return;
            }

            // Diagram type unknown → ask user
            pendingCircuits.set(sessionKey, {
              prompt: circuitIntent.prompt,
              storedAt: Date.now(),
            });

            const askTypeMsg =
              "🔧 **NL Circuit Generation**\n\n" +
              "I detected that you want to generate a complete circuit from your description.\n\n" +
              "What type of diagram?\n\n" +
              "**1** — P&ID (Process & Instrumentation Diagram)\n" +
              "**2** — Electrical Diagram\n\n" +
              "_Or type \"P&ID\" or \"Electrical\"._";

            sendJsonResponse(res, 200,
              buildCompletionResponse(askTypeMsg, parsed.model),
              { "X-Comos-Ai-Shim": "circuit-gen-ask-type" },
            );
            log(`circuit_gen_ask_type session=${sessionKey}`);
            return;
          }
        }

        // ── INTERACTIVE DRAWING STATE MACHINE ───────────────────────────
        const drawingResult = await handleInteractiveDrawing(sessionKey, info, parsed, res);
        if (drawingResult) return; // handled by drawing state machine

        // ── PENDING PUSH RESULT: dequeue if a finished job was queued ──
        // (dequeue happens here, before active-check, so a just-finished
        //  job is delivered immediately rather than showing "progress")
        if (pendingPushResults.has(sessionKey)) {
          const push = pendingPushResults.get(sessionKey);
          pendingPushResults.delete(sessionKey);
          log(`pending_push_dequeue session=${sessionKey}`);
          sendJsonResponse(res, 200, push.body, push.header);
          return;
        }

        // ── CHECK: Active digitization in progress? ─────────────────────
        // (job is still running — pendingPushResults is only set when done)
        const activeCheck = checkActiveDigitization(sessionKey, parsed.model);
        if (activeCheck) {
          const headerVal = activeCheck.type === "progress" ? "digitize-progress" : "digitize-result";
          sendJsonResponse(res, 200, activeCheck.body, { "X-Comos-Ai-Shim": headerVal });
          log(`active_digitization_${activeCheck.type} session=${sessionKey}`);
          return;
        }

        // ── STEP B: Check if user is answering a diagram type question ──
        if (pendingPdfs.has(sessionKey) && info.lastUserMsg) {
          const diagramType = detectDiagramTypeAnswer(info.lastUserMsg);
          if (diagramType) {
            const pending = pendingPdfs.get(sessionKey);
            pendingPdfs.delete(sessionKey);

            log(`digitize_step_b session=${sessionKey} type=${diagramType} file=${pending.filename}`);

            if (diagramType === "tags-only" || diagramType === "document") {
              // Option 3 or 4: tag extraction (diagram tags or document tags)
              const typeLabel = diagramType === "document" ? "Document" : "TAG";
              startBackgroundTagExtraction(sessionKey, pending.pdfAttachment, pending.userMessage, diagramType);

              const startMsg =
                `⏳ **Starting ${typeLabel} extraction...**\n\n` +
                `File **${pending.filename}** will be scanned for instrumentation/equipment tags.\n` +
                `Tags will receive ISA/IEC descriptions and system matching.\n\n` +
                `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

              sendJsonResponse(res, 200,
                buildCompletionResponse(startMsg, parsed.model),
                { "X-Comos-Ai-Shim": "tags-extraction-started" },
              );
              log(`tags_extraction_started session=${sessionKey}`);
              return;
            }

            // Start processing in the background and respond immediately
            startBackgroundDigitization(sessionKey, pending.pdfAttachment, diagramType, pending.userMessage);

            const dtLabel = diagramType === "electrical" ? "Electrical Diagram" : "P&ID";
            const startMsg =
              `⏳ **Starting ${dtLabel} analysis...**\n\n` +
              `File **${pending.filename}** has been sent for digitization.\n` +
              `Analysis may take **1 to 5 minutes** depending on complexity.\n\n` +
              `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

            sendJsonResponse(res, 200,
              buildCompletionResponse(startMsg, parsed.model),
              { "X-Comos-Ai-Shim": "digitize-started" },
            );
            log(`digitize_started_bg session=${sessionKey}`);
            return;
          }
          // If user sent something that doesn't match a type, remind them
          if (!hasPdfAttachment(info)) {
            const reminder =
              "I did not understand the diagram type. Please reply:\n\n" +
              "**1** — P&ID\n**2** — Electrical Diagram\n**3** — Tags Only\n**4** — Document (RFQ, spec, equipment list)\n\n" +
              "_Or type \"P&ID\", \"Electrical\", \"Tags only\", or \"Document\"._";
            sendJsonResponse(res, 200,
              buildCompletionResponse(reminder, parsed.model),
              { "X-Comos-Ai-Shim": "digitize-reminder" },
            );
            log(`digitize_reminder session=${sessionKey}`);
            return;
          }
        }

        // ── STEP A: Check if request has a PDF attachment ────────────────
        // Also check for local PDF file paths in the message text
        let effectiveInfo = info;
        if (!hasPdfAttachment(info) && info.lastUserMsg) {
          const pdfPath = extractPdfPathFromMessage(info.lastUserMsg);
          if (pdfPath) {
            log(`local_pdf_path_detected path=${pdfPath}`);
            const localAtt = buildAttachmentFromLocalFile(pdfPath);
            if (localAtt) {
              effectiveInfo = { ...info, pdfAttachment: localAtt };
            } else {
              // File not found — tell the user
              const notFound =
                `❌ File not found:\n\`${pdfPath}\`\n\n` +
                `Please check that the path is correct and the file exists.`;
              sendJsonResponse(res, 200,
                buildCompletionResponse(notFound, parsed.model),
                { "X-Comos-Ai-Shim": "pdf-not-found" },
              );
              log(`local_pdf_not_found_response path=${pdfPath}`);
              return;
            }
          }
        }

        if (hasPdfAttachment(effectiveInfo)) {
          const pdfAtt = effectiveInfo.pdfAttachment;
          const filename = pdfAtt.fileName || pdfAtt.filename || pdfAtt.name || "document.pdf";

          // Check if user already specified the type in the message
          const lowerMsg = (info.lastUserMsg || "").toLowerCase();
          let explicitType = null;
          if (/\b(tags?\s*(only|apenas|somente)|extra[iç][aã]o\s+de\s+tags?|somente\s+tags?|hierarquia\s+apenas)\b/.test(lowerMsg)) {
            explicitType = "tags-only";
          } else if (/\b(rfq|requisição|requisi[çc][aã]o|equipment\s*list|lista\s+de\s+equip|spec(ifica[çc][aã]o)?|datasheet|data\s*sheet|documento\s+geral|general\s+doc)\b/.test(lowerMsg)) {
            explicitType = "document";
          } else if (lowerMsg.includes("elétr") || lowerMsg.includes("eletr") || lowerMsg.includes("electrical")) {
            explicitType = "electrical";
          } else if (lowerMsg.includes("p&id") || /\bpid\b/.test(lowerMsg)) {
            explicitType = "pid";
          }

          if (explicitType) {
            if (explicitType === "tags-only" || explicitType === "document") {
              // Tags-only or Document: use extract-tags endpoint
              const typeLabel = explicitType === "document" ? "Document" : "TAG";
              log(`tags_extraction_direct session=${sessionKey} file=${filename} type=${explicitType}`);

              startBackgroundTagExtraction(sessionKey, pdfAtt, info.lastUserMsg || "", explicitType);

              const startMsg =
                `⏳ **Starting ${typeLabel} extraction...**\n\n` +
                `File **${filename}** will be scanned for instrumentation/equipment tags.\n` +
                `Tags will receive ISA/IEC descriptions and system matching.\n\n` +
                `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

              sendJsonResponse(res, 200,
                buildCompletionResponse(startMsg, parsed.model),
                { "X-Comos-Ai-Shim": "tags-extraction-started" },
              );
              log(`tags_extraction_started_direct session=${sessionKey}`);
              return;
            }

            // User already said the type → start background processing
            log(`digitize_direct session=${sessionKey} type=${explicitType} file=${filename}`);

            startBackgroundDigitization(sessionKey, pdfAtt, explicitType, info.lastUserMsg || "");

            const dtLabel = explicitType === "electrical" ? "Electrical Diagram" : "P&ID";
            const startMsg =
              `⏳ **Starting ${dtLabel} analysis...**\n\n` +
              `File **${filename}** has been sent for digitization.\n` +
              `Analysis may take **1 to 5 minutes** depending on complexity.\n\n` +
              `When ready, send **any message** (e.g. \'ok\') to receive the result.`;

            sendJsonResponse(res, 200,
              buildCompletionResponse(startMsg, parsed.model),
              { "X-Comos-Ai-Shim": "digitize-started" },
            );
            log(`digitize_started_bg_direct session=${sessionKey}`);
            return;
          }

          // Store PDF and ask the user what type
          pendingPdfs.set(sessionKey, {
            pdfAttachment: pdfAtt,
            filename,
            userMessage: info.lastUserMsg || "",
            storedAt: Date.now(),
          });

          log(`digitize_step_a session=${sessionKey} file=${filename} base64_len=${(pdfAtt.contentBase64 || pdfAtt.content_base64 || pdfAtt.data || "").length}`);

          sendJsonResponse(res, 200,
            buildCompletionResponse(ASK_DIAGRAM_TYPE_MSG, parsed.model),
            { "X-Comos-Ai-Shim": "digitize-ask-type" },
          );
          return;
        }

        // ── Normal chat — ALL non-PDF requests go to raw LLM ─────────
        // Route directly to gateway raw endpoint (bypasses AI API and MCP).
        // MCP tools are ONLY used for PDF digitization (handled above).
        {
          const messages = parsed.messages || parsed.Messages || [];
          const hasTools = parsed.tools && parsed.tools.length > 0;
          const toolNames = hasTools
            ? parsed.tools.map(t => t.function?.name || t.Function?.Name || "").filter(Boolean)
            : [];
          const hasImportTool = toolNames.includes("import_equipment_from_excel");
          const hasAttributeReadTool = toolNames.includes("value_of_attribute_by_name_or_description");
          const hasAttributeNavTool = toolNames.includes("navigate_to_attribute_by_name_or_description");

          // ── TEMP DEBUG: dump tool schemas for attribute tools ──
          if (hasAttributeReadTool || hasAttributeNavTool) {
            const _attrTools = (parsed.tools || []).filter(t => {
              const n = t?.function?.name || t?.Function?.Name || "";
              return /value_of_attribute|navigate_to_attribute/.test(n);
            });
            _attrTools.forEach(t => {
              log(`TOOL_SCHEMA name=${t?.function?.name || t?.Function?.Name} schema=${JSON.stringify(t?.function?.parameters || t?.Function?.Parameters || {})}`);
            });
          }
          const hasCountTool = toolNames.includes("get_count_of_comos_objects_with_name");
          const hasObjectsWithNameTool = toolNames.includes("objects_with_name");
          const canWriteAttribute = hasAttributeWriteTool(toolNames);
          const lastUserText = String(info.lastUserMsg || getLastUserMessageText(messages) || "");
          const asksAttrValue = isAttributeValueIntent(lastUserText);
          const asksAttrNav = isAttributeNavigationIntent(lastUserText);
          const asksAttrWrite = isAttributeWriteIntent(lastUserText);

          // ── Count intent: check last user message first; if no match,
          //    scan earlier user messages (handles multi-user-message arrays
          //    like ["How many pumps", "Hello"] where the real intent is earlier).
          //    GUARD: skip earlier-message scan if the conversation already
          //    contains a tool/function result — that means we are in a
          //    tool-result round and should let the LLM process the result.
          const _hasToolResultInConversation = (Array.isArray(messages) ? messages : [])
            .some(m => { const r = String((m || {}).role || (m || {}).Role || "").toLowerCase(); return r === "tool" || r === "function"; });
          // ── NEW: detect if this POST is a fresh user request (last msg is "user")
          //    vs. a mid-fabrication round (last msg is "tool" with a result).
          //    In multi-turn conversations, previous turns' tool results should NOT
          //    block fabrication for the new user request.
          const _isNewUserRequest = (() => {
            if (!Array.isArray(messages) || messages.length === 0) return true;
            const lastRole = String(messages[messages.length - 1].role || messages[messages.length - 1].Role || "").toLowerCase();
            return lastRole === "user";
          })();
          let effectiveCountText = lastUserText;
          let asksObjectCount = isObjectCountIntent(lastUserText);
          if (!asksObjectCount && !_hasToolResultInConversation) {
            const pendingFromHistory = scanPendingCountIntentInHistory(messages.slice(0, -1));
            if (pendingFromHistory) {
              // Found a count intent in an earlier user message
              const matchingMsg = (Array.isArray(messages) ? messages : [])
                .filter(m => String(m.role || m.Role || "").toLowerCase() === "user")
                .reverse()
                .find(m => {
                  const txt = typeof (m.content ?? m.Content) === "string" ? (m.content ?? m.Content) : "";
                  return isObjectCountIntent(txt);
                });
              if (matchingMsg) {
                effectiveCountText = typeof (matchingMsg.content ?? matchingMsg.Content) === "string"
                  ? (matchingMsg.content ?? matchingMsg.Content) : lastUserText;
                asksObjectCount = true;
                log(`count_intent_from_earlier_message session=${sessionKey} effective="${effectiveCountText.substring(0,60)}"`);
              }
            }
          }
          const asksFilteredObjectCount = isFilteredObjectCountIntent(effectiveCountText);
          const objectNameForCount = extractObjectNameForCountQuery(effectiveCountText);
          const looseObjectNameForCount = extractLooseObjectNameForCountQuery(effectiveCountText);
          // Prefer the loose (normalized) extraction — it maps plurals to singular (pumps→pump).
          // The exact extraction is only used as fallback for specific tags like "P001".
          const rawCountTarget = looseObjectNameForCount || objectNameForCount;
          // Apply equipment plural→singular normalization even for exact extraction matches
          const _equipNorm = {pumps:"pump",pump:"pump",bombas:"bomba",bomba:"bomba",valves:"valve",valve:"valve",
            motors:"motor",motor:"motor",motores:"motor",instruments:"instrument",instrument:"instrument",
            instrumentos:"instrumento",instrumento:"instrumento",equipments:"equipment",equipment:"equipment",
            equipamentos:"equipamento",equipamento:"equipamento","válvulas":"válvula","valvulas":"valvula",
            "válvula":"válvula","valvula":"valvula"};
          const countEquipmentTarget = rawCountTarget ? (_equipNorm[rawCountTarget.toLowerCase()] || rawCountTarget) : "";
          const attributeFilterText = extractAttributeFilterFromCountQuery(effectiveCountText);
          const canFilterWithAvailableTools = hasFilterCapableTools(toolNames);

          if (hasTools && asksFilteredObjectCount && hasCountTool && !canFilterWithAvailableTools) {
            const isPt = detectPortugueseText(lastUserText);
            const eqTxt = countEquipmentTarget || (isPt ? "(tipo de equipamento não identificado)" : "(equipment type not identified)");
            const fltTxt = attributeFilterText || (isPt ? "(filtro de atributo não identificado)" : "(attribute filter not identified)");
            const msg = isPt
              ? `Entendi seu filtro: equipamento=${eqTxt}; atributo=${fltTxt}.\n\nCom as ferramentas disponíveis nesta sessão, só consigo contagem por nome e leitura de atributo pontual, sem contagem agregada com filtro de atributo em uma única execução.\n\nPosso:\n- Contar pelo tipo agora (ex.: \"bomba\")\n- Ou orientar a query no COMOS para aplicar o filtro de atributo e retornar o total.`
              : `I understood your filter: equipment=${eqTxt}; attribute=${fltTxt}.\n\nWith the tools available in this session, I can only do name-based counts and single-attribute reads, not aggregated attribute-filtered counting in one pass.\n\nI can:\n- Count by equipment type now (e.g., \"pump\")\n- Or guide a COMOS query to apply the attribute filter and return the total.`;
            sendJsonResponse(res, 200, buildCompletionResponse(msg, parsed.model), { "X-Comos-Ai-Shim": "filtered-count-limit" });
            log(`filtered_count_limit session=${sessionKey} eq=${eqTxt} filter=${fltTxt}`);
            return;
          }

          if (hasTools && asksFilteredObjectCount && hasCountTool && hasObjectsWithNameTool && countEquipmentTarget) {
            const fabricated = buildFabricatedToolCallResponse(
              "objects_with_name",
              { objectName: countEquipmentTarget },
              parsed.model
            );
            sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-filtered-count-seed" });
            log(`fabricated_tool_call session=${sessionKey} tool=objects_with_name object=${countEquipmentTarget} filter=${attributeFilterText || "none"}`);
            return;
          }

          if (hasTools && asksObjectCount && !asksFilteredObjectCount && hasCountTool && (objectNameForCount || looseObjectNameForCount)) {
            const countTarget = countEquipmentTarget;
            const fabricated = buildFabricatedToolCallResponse(
              "get_count_of_comos_objects_with_name",
              { objectName: countTarget },
              parsed.model
            );
            sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-count-tool-call" });
            log(`fabricated_tool_call session=${sessionKey} tool=get_count_of_comos_objects_with_name object=${countTarget}`);
            return;
          }

          if (hasTools && asksObjectCount && !asksFilteredObjectCount && hasCountTool && !objectNameForCount && !looseObjectNameForCount) {
            const isPt = detectPortugueseText(lastUserText);
            const msg = isPt
              ? "Para contar corretamente, preciso do nome/tag do objeto (ex.: \"P001\", \"XV-101\") ou da classe (ex.: \"bomba\", \"válvula\")."
              : "To count accurately, I need the object name/tag (e.g., \"P001\", \"XV-101\") or the class term (e.g., \"pump\", \"valve\").";
            sendJsonResponse(res, 200, buildCompletionResponse(msg, parsed.model), { "X-Comos-Ai-Shim": "count-clarification" });
            log(`count_clarification session=${sessionKey}`);
            return;
          }

          // ── Follow-up confirmation: "Yes", "Make it now", "Sim" etc.
          //    If the last message is a simple confirmation and the conversation
          //    history contains a pending count intent, re-fabricate the count call.
          if (hasTools && hasCountTool && !asksObjectCount && isFollowUpConfirmation(lastUserText)) {
            const pendingTarget = scanPendingCountIntentInHistory(messages);
            if (pendingTarget) {
              const fabricated = buildFabricatedToolCallResponse(
                "get_count_of_comos_objects_with_name",
                { objectName: pendingTarget },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-count-followup" });
              log(`fabricated_count_followup session=${sessionKey} tool=get_count_of_comos_objects_with_name object=${pendingTarget}`);
              return;
            }
          }

          // ── Fabrication budget: COMOS .NET allows max 3 iterations per user
          //    message (including the final text response). So we can fabricate
          //    at most 2 tool calls. Count how many we've already used by
          //    looking at tool result messages with call_shim_ IDs.
          //    IMPORTANT: Only count fabricated calls in the CURRENT turn
          //    (after the last "user" message), not across all turns.
          const _fabricatedCallCount = (() => {
            if (!Array.isArray(messages)) return 0;
            let lastUserIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (String(messages[i].role || messages[i].Role || "").toLowerCase() === "user") {
                lastUserIdx = i;
                break;
              }
            }
            return messages.slice(lastUserIdx + 1).filter(m => {
              const role = String(m.role || m.Role || "").toLowerCase();
              if (role !== "tool") return false;
              const tcId = String(m.tool_call_id || m.toolCallId || m.ToolCallId || "");
              return tcId.startsWith("call_shim_");
            }).length;
          })();
          const _maxFabricatedCalls = 2;
          if (_fabricatedCallCount >= _maxFabricatedCalls) {
            log(`fabrication_budget_exhausted session=${sessionKey} count=${_fabricatedCallCount} max=${_maxFabricatedCalls}`);
          }

          // ── Multi-step guard: route complex requests to agentic LLM ──────
          // When the user asks for multiple actions ("Navigate to GM-015 and then to PC-001"),
          // skip ALL fabrication and let the LLM handle it with its tool-calling loop.
          // Only applies to new user requests (not mid-turn tool result rounds).
          const _isMultiStep = _isNewUserRequest && isMultiStepIntent(lastUserText);
          if (_isMultiStep) {
            log(`multi_step_detected session=${sessionKey} text="${lastUserText.substring(0, 80)}" → routing to agentic LLM`);
          }

          // ── Shared: messages in the CURRENT turn (after the last user message) ──
          // All fabrication handlers must use this to avoid acting on stale tool
          // results from previous turns.
          const _lastUserIdxShared = (() => {
            if (!Array.isArray(messages)) return -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (String(messages[i].role || messages[i].Role || "").toLowerCase() === "user") return i;
            }
            return -1;
          })();
          const _currentTurnMsgsShared = Array.isArray(messages) ? messages.slice(_lastUserIdxShared + 1) : [];
          const _lastUserContentShared = _lastUserIdxShared >= 0 ? String(messages[_lastUserIdxShared].content || messages[_lastUserIdxShared].Content || "") : "";

          // ── Post-navigation attribute fabrication ────────────────────────
          // When the last tool result is a successful navigation AND there's a
          // pending attribute query that hasn't been attempted yet, fabricate the
          // attribute tool call WITH the systemUID from the navigation result.
          // Budget: allow +1 extra call here because nav→retry→attr_read needs 3
          // fabricated calls (the standard limit of 2 is for initial fabrication).
          if (_fabricatedCallCount < _maxFabricatedCalls + 1) {
            // Use shared current-turn scoping to avoid stale nav results
            const _lastToolMsgNav = _currentTurnMsgsShared.filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool"
            ).pop();
            const _navContent = String((_lastToolMsgNav || {}).content || (_lastToolMsgNav || {}).Content || "");
            const _isNavSuccess = _navContent.includes("Navigated to the object") || _navContent.includes("SystemUID");
            const _navUID = (_navContent.match(/SystemUID\s*[:=]\s*([A-Z0-9]{8,12})/i) || [])[1] || "";

            // Check if the CURRENT user message asks about an attribute
            const _hasPendingAttr = isAttributeValueIntent(_lastUserContentShared) || isAttributeNavigationIntent(_lastUserContentShared);

            // Check if attribute tool was already attempted IN CURRENT TURN
            const _attrAttempted = _currentTurnMsgsShared.some(m => {
              const r = String(m.role || m.Role || "").toLowerCase();
              if (r !== "assistant") return false;
              const tc = m.tool_calls || m.ToolCalls || [];
              return tc.some(c => {
                const fn = (c.function || c.Function || {}).name || (c.function || c.Function || {}).Name || "";
                return /value_of_attribute|navigate_to_attribute/i.test(fn);
              });
            });

            if (_isNavSuccess && _hasPendingAttr && !_attrAttempted && hasTools && (hasAttributeReadTool || hasAttributeNavTool)) {
              // Find the attribute name from the CURRENT user message
              let _attrName = "";
              if (_lastUserContentShared) {
                const extracted = extractAttributeAndObject(_lastUserContentShared);
                _attrName = extracted.attributeName || "";
              }
              if (_attrName) {
                const _preferToolNav = hasAttributeReadTool
                  ? "value_of_attribute_by_name_or_description"
                  : "navigate_to_attribute_by_name_or_description";
                // Pass systemUID from nav result so the DLL can find the object
                // (SelectedObject is unreliable across separate tool iterations)
                const _attrArgs = { objectNameOrDescription: _attrName };
                if (_navUID) _attrArgs.systemUID = _navUID;
                const fabricated = buildFabricatedToolCallResponse(
                  _preferToolNav,
                  _attrArgs,
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-after-nav" });
                log(`fabricated_attr_after_nav session=${sessionKey} attr="${_attrName}" systemUID=${_navUID || "(none)"}`);
                return;
              }
            }

            // ── Attribute-nav retry: navigation failed during attribute query ─────
            // fabricated_attr_nav_first now tries the de-separated form first
            // (PC-001 → PC001). If THAT fails, retry with the ORIGINAL user tag
            // (PC-001) since some COMOS objects do have hyphens in their Name.
            const _navFailedForAttr = _navContent.includes("Object doesn't found") || _navContent.includes("doesn't found");
            if (_navFailedForAttr && _hasPendingAttr && !_attrAttempted) {
              const _userAttrAndObj = extractAttributeAndObject(_lastUserContentShared);
              const _origTag = _userAttrAndObj.objectTag;
              if (_origTag) {
                // Count nav failures in current turn (call_shim_ IDs = shim-fabricated)
                const _attrNavFailCount = _currentTurnMsgsShared.filter(m =>
                  String(m.role || m.Role || "").toLowerCase() === "tool" &&
                  String(m.content || m.Content || "").includes("doesn't found") &&
                  String(m.tool_call_id || m.toolCallId || m.ToolCallId || "").startsWith("call_shim_")
                ).length;
                // Since we tried de-separated first, retry with original tag (which has separator)
                // Only retry once — must stay within C# 3-iteration budget
                const _sepM3 = _origTag.match(/^([A-Za-z]+)([-\s])(\d+[A-Za-z]?)$/);
                const _alreadyTriedDeSep = !!_sepM3; // we only de-separated if it had a separator
                const _retryTag = (_attrNavFailCount === 1 && _alreadyTriedDeSep) ? _origTag : null;

                if (_retryTag) {
                  const _navToolName = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                    ? "navigate_to_comos_object_by_name_or_label" : "navigate_to_comos_object_by_name";
                  const _navArgKey = _navToolName.includes("label") ? "objectNameOrLabel" : "objectName";
                  const fabricatedRetry = buildFabricatedToolCallResponse(
                    _navToolName,
                    { [_navArgKey]: _retryTag },
                    parsed.model
                  );
                  sendJsonResponse(res, 200, fabricatedRetry, { "X-Comos-Ai-Shim": "fabricated-attr-nav-retry" });
                  log(`fabricated_attr_nav_retry session=${sessionKey} deSep_failed retry="${_retryTag}" attr="${_userAttrAndObj.attributeName}" attempt=${_attrNavFailCount + 1}`);
                  return;
                }
              }
            }
          }

          // ── Direct list_object_attributes result handler ──────────────
          // When the user asked "list attributes" and we got the result back,
          // format it as a nice table and short-circuit (don't send to LLM).
          {
            const _lastToolMsgDirect = _currentTurnMsgsShared.filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool"
            ).pop();
            const _directContent = String((_lastToolMsgDirect || {}).content || (_lastToolMsgDirect || {}).Content || "");
            // Check if this is a list_object_attributes result (C# anonymous type format: success = True, attributeCount = N, attributes = ...)
            const _isListAttrsDirectResult = _directContent.includes("attributeCount") && /attributes\s*=/.test(_directContent);
            if (_isListAttrsDirectResult && isListAttributesIntent(lastUserText)) {
              const _isPtD = detectPortugueseText(lastUserText);
              // Parse C# anonymous type format (NOT JSON) using regex
              const _objNameM = _directContent.match(/objectName\s*=\s*([^,}]+)/);
              const _objLabelM = _directContent.match(/objectLabel\s*=\s*([^,}]+)/);
              // Extract everything after "attributes = " until end (it's the last field)
              const _attrsM = _directContent.match(/attributes\s*=\s*([\s\S]+?)\s*}\s*$/);
              const _attrStr = _attrsM ? _attrsM[1].trim() : "";
              const _attrs = _attrStr.split(";").map(a => a.trim()).filter(a => a.length > 0);
              const _objName = (_objNameM ? _objNameM[1].trim() : "") || (_objLabelM ? _objLabelM[1].trim() : "") || "object";

              let _msg;
              if (_attrs.length === 0) {
                _msg = _isPtD
                  ? `O objeto **${_objName}** não possui atributos preenchidos.`
                  : `Object **${_objName}** has no filled attributes.`;
              } else {
                // Format as markdown table
                _msg = _isPtD
                  ? `Atributos preenchidos de **${_objName}** (${_attrs.length}):\n\n`
                  : `Filled attributes of **${_objName}** (${_attrs.length}):\n\n`;
                _msg += `| Tab | Attribute | Value |\n|-----|-----------|-------|\n`;
                for (const attr of _attrs) {
                  // Parse: [TabName] AttrName (Desc) = Value
                  const tabMatch = attr.match(/^\[([^\]]*)\]\s*(.*)/);
                  let tab = "", rest = attr;
                  if (tabMatch) { tab = tabMatch[1]; rest = tabMatch[2]; }
                  const eqIdx = rest.indexOf(" = ");
                  let name = rest, val = "";
                  if (eqIdx > -1) { name = rest.substring(0, eqIdx); val = rest.substring(eqIdx + 3); }
                  _msg += `| ${tab} | ${name} | ${val} |\n`;
                }
              }
              const _scResp = {
                id: `chatcmpl-shim-listattrs-${Date.now()}`,
                object: "chat.completion",
                model: parsed.model || "serviceipid-gateway",
                choices: [{ index: 0, message: { role: "assistant", content: _msg }, finish_reason: "stop" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              };
              sendJsonResponse(res, 200, _scResp, { "X-Comos-Ai-Shim": "list-attrs-formatted" });
              log(`list_attrs_formatted session=${sessionKey} obj="${_objName}" count=${_attrs.length}`);
              return;
            }
          }

          // ── Attribute AUTO-RECOVERY: when the attribute tool returns "Object doesn't found",
          // instead of guessing alternative names, call list_object_attributes to get the
          // actual list of attributes on the object, then short-circuit with a helpful response.
          if (_fabricatedCallCount < _maxFabricatedCalls) {
            const _lastToolMsg = _currentTurnMsgsShared.filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool"
            ).pop();
            const _lastToolContent = String((_lastToolMsg || {}).content || (_lastToolMsg || {}).Content || "");
            const _attrFailed = _lastToolContent.includes("Object doesn't found") || _lastToolContent.includes("doesn't found");
            const _objectLookupFailed = /could\s+not\s+find\s+the\s+object|objectname\s*=|provide\s+the\s+object\s+name\/tag/i.test(_lastToolContent);
            const _userAttrObj = extractAttributeAndObject(lastUserText);
            const _hasExplicitObjectTagInQuery = !!_userAttrObj.objectTag;

            if (_attrFailed && !_objectLookupFailed && !_hasExplicitObjectTagInQuery && hasTools) {
              // Find the original attribute query from user messages
              const _userMsgs = (Array.isArray(messages) ? messages : []).filter(m =>
                String(m.role || m.Role || "").toLowerCase() === "user"
              );
              let _origAttrQuery = "";
              for (let ui = _userMsgs.length - 1; ui >= 0; ui--) {
                const uText = String(_userMsgs[ui].content || _userMsgs[ui].Content || "");
                if (isAttributeValueIntent(uText) || isAttributeNavigationIntent(uText)) {
                  _origAttrQuery = extractAttributeAndObject(uText).attributeName;
                  break;
                }
              }

              // If list_object_attributes tool is available, call it to get the real attribute list
              const hasListAttrsTool = toolNames.includes("list_object_attributes");
              const _lastToolCallId = String(_lastToolMsg?.tool_call_id || _lastToolMsg?.toolCallId || "");

              // Check if the last tool result is already FROM list_object_attributes
              // (to avoid infinite loop: attr-fail → list → attr-fail → list ...)
              const _lastAssistantMsg = _currentTurnMsgsShared.filter(m =>
                String(m.role || m.Role || "").toLowerCase() === "assistant" && m.tool_calls
              ).pop();
              const _lastCalledTool = _lastAssistantMsg?.tool_calls?.[0]?.function?.name || "";
              const _isListAttrsResult = _lastCalledTool === "list_object_attributes";

              if (_isListAttrsResult) {
                // We already called list_object_attributes — parse the result and short-circuit
                const _isPt = detectPortugueseText(lastUserText);
                let _attrList = "";
                try {
                  const _parsed = JSON.parse(_lastToolContent);
                  _attrList = _parsed.attributes || "";
                } catch {
                  _attrList = _lastToolContent;
                }

                // Parse semicolon-delimited list and format nicely
                const _attrs = _attrList.split(";").map(a => a.trim()).filter(a => a.length > 0);
                let _scMsg;
                if (_isPt) {
                  _scMsg = _origAttrQuery
                    ? `O atributo "${_origAttrQuery}" não foi encontrado neste objeto.`
                    : `O atributo solicitado não foi encontrado neste objeto.`;
                  if (_attrs.length > 0) {
                    _scMsg += `\n\nAtributos disponíveis neste objeto (${_attrs.length}):\n` +
                      _attrs.slice(0, 50).map(a => `  • ${a}`).join("\n");
                    if (_attrs.length > 50) _scMsg += `\n  ... e mais ${_attrs.length - 50} atributos.`;
                  }
                  _scMsg += `\n\nDiga o nome exato do atributo que deseja consultar.`;
                } else {
                  _scMsg = _origAttrQuery
                    ? `The attribute "${_origAttrQuery}" was not found on this object.`
                    : `The requested attribute was not found on this object.`;
                  if (_attrs.length > 0) {
                    _scMsg += `\n\nAvailable attributes on this object (${_attrs.length}):\n` +
                      _attrs.slice(0, 50).map(a => `  • ${a}`).join("\n");
                    if (_attrs.length > 50) _scMsg += `\n  ... and ${_attrs.length - 50} more.`;
                  }
                  _scMsg += `\n\nPlease specify the exact attribute name you want to query.`;
                }
                const _scResp = {
                  id: `chatcmpl-shim-attrlist-${Date.now()}`,
                  object: "chat.completion",
                  model: parsed.model || "serviceipid-gateway",
                  choices: [{ index: 0, message: { role: "assistant", content: _scMsg }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                };
                sendJsonResponse(res, 200, _scResp, { "X-Comos-Ai-Shim": "attr-not-found-list-attrs" });
                log(`attr_not_found_list_attrs session=${sessionKey} attr="${_origAttrQuery}" availableAttrs=${_attrs.length}`);
                return;
              } else if (hasListAttrsTool) {
                // Call list_object_attributes to discover available attributes
                // Extract object tag and systemType from prior nav in conversation
                const _tagMatchFail = String(lastUserText || "").match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
                const _tagForFail = _tagMatchFail ? _tagMatchFail[1] : "";
                let _uidForFail = "", _typeForFail = "";
                const _failToolMsgs = (Array.isArray(messages) ? messages : []).filter(m =>
                  String(m.role || m.Role || "").toLowerCase() === "tool");
                for (const _ftm of _failToolMsgs) {
                  const _ftmC = String(_ftm.content || _ftm.Content || "");
                  if (_ftmC.includes("Navigated to the object")) {
                    const _fUid = _ftmC.match(/SystemUID\s*[=:]\s*([A-Z0-9]+)/i);
                    if (_fUid) _uidForFail = _fUid[1];
                    const _fType = _ftmC.match(/SystemType\s*[=:]\s*(\d+)/i);
                    if (_fType) _typeForFail = _fType[1];
                    if (_uidForFail) break;
                  }
                }
                const fabricated = buildFabricatedToolCallResponse(
                  "list_object_attributes",
                  { systemUID: _uidForFail, objectName: _tagForFail, systemType: _typeForFail },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-list-attrs-after-fail" });
                log(`fabricated_list_attrs_after_fail session=${sessionKey} originalAttr="${_origAttrQuery}" objectName="${_tagForFail}" uid="${_uidForFail}" type=${_typeForFail}`);    
                return;
              } else {
                // No list_object_attributes tool available — short-circuit with generic message
                const _isPt2 = detectPortugueseText(lastUserText);
                const _scMsg2 = _isPt2
                  ? `O atributo "${_origAttrQuery || "solicitado"}" não foi encontrado neste objeto.\n\nVocê pode pedir: **"liste os atributos preenchidos"** para ver todos os atributos disponíveis com valor.`
                  : `The attribute "${_origAttrQuery || "requested"}" was not found on this object.\n\nYou can ask: **"list the filled attributes"** to see all available attributes with values.`;
                const _scResp2 = {
                  id: `chatcmpl-shim-attrsc-${Date.now()}`,
                  object: "chat.completion",
                  model: parsed.model || "serviceipid-gateway",
                  choices: [{ index: 0, message: { role: "assistant", content: _scMsg2 }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                };
                sendJsonResponse(res, 200, _scResp2, { "X-Comos-Ai-Shim": "attr-not-found-short-circuit" });
                log(`attr_not_found_short_circuit session=${sessionKey} attr="${_origAttrQuery}" (no list_object_attributes tool)`);
                return;
              }
            }
          }

          // ── Navigation AUTO-RETRY: when a nav tool returns "Object doesn't found",
          //    try name variations (with/without hyphens, spaces).
          //    COMOS object names may differ from how users type them:
          //    "PC-001" in hierarchy → "PC001" in Name property (most common).
          if (_fabricatedCallCount < _maxFabricatedCalls && isPureNavigationIntent(lastUserText)) {
            const _lastNavToolMsg = _currentTurnMsgsShared.filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool"
            ).pop();
            const _lastNavContent = String((_lastNavToolMsg || {}).content || (_lastNavToolMsg || {}).Content || "");
            const _navFailed = _lastNavContent.includes("Object doesn't found") || _lastNavContent.includes("doesn't found");

            if (_navFailed) {
              const navTarget = extractNavigationTarget(lastUserText);
              if (navTarget) {
                // Count nav-specific failures in CURRENT TURN (with call_shim_ IDs = shim-fabricated)
                const _navFailCount = _currentTurnMsgsShared.filter(m =>
                  String(m.role || m.Role || "").toLowerCase() === "tool" &&
                  (String(m.content || m.Content || "").includes("doesn't found")) &&
                  String(m.tool_call_id || m.toolCallId || m.ToolCallId || "").startsWith("call_shim_")
                ).length;

                // Since fabricated_nav_direct now tries de-separated first (PC-001→PC001),
                // on first retry try the ORIGINAL tag (with hyphen). On 2nd, try space variant.
                const _sepMR = navTarget.match(/^([A-Za-z]+)([-\s])(\d+[A-Za-z]?)$/);
                let _nextNavVariation = null;
                if (_navFailCount === 1 && _sepMR) {
                  // First retry: try original tag with separator (already de-separated on first attempt)
                  _nextNavVariation = navTarget;
                } else if (_navFailCount === 2 && _sepMR) {
                  // Second retry: try other separator variant
                  const otherSep = _sepMR[2] === "-" ? " " : "-";
                  _nextNavVariation = _sepMR[1].toUpperCase() + otherSep + _sepMR[3];
                } else if (_navFailCount === 1 && !_sepMR) {
                  // No separator in original — standard retry logic
                  const _navVariations = generateNavigationNameVariations(navTarget);
                  _nextNavVariation = _navVariations[0] || null;
                } else if (_navFailCount === 2 && !_sepMR) {
                  const _navVariations = generateNavigationNameVariations(navTarget);
                  _nextNavVariation = _navVariations[1] || null;
                }

                if (_nextNavVariation && _navFailCount <= 2) {
                  const _navToolName2 = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                    ? "navigate_to_comos_object_by_name_or_label" : "navigate_to_comos_object_by_name";
                  const _navArgKey2 = _navToolName2.includes("label") ? "objectNameOrLabel" : "objectName";
                  const fabricatedRetry = buildFabricatedToolCallResponse(
                    _navToolName2,
                    { [_navArgKey2]: _nextNavVariation },
                    parsed.model
                  );
                  sendJsonResponse(res, 200, fabricatedRetry, { "X-Comos-Ai-Shim": "fabricated-nav-retry" });
                  log(`fabricated_nav_retry session=${sessionKey} original="${navTarget}" retry="${_nextNavVariation}" attempt=${_navFailCount + 1}`);
                  return;
                } else if (_navFailCount > 2) {
                  log(`skip_nav_retry session=${sessionKey} reason=retry_cap_reached navFailCount=${_navFailCount}`);
                }
              }
            }
          }

          // ── Pure navigation fabrication — uses navigate_to_comos_object_by_name ──
          // Directly fabricates the correct navigation tool call to avoid the LLM
          // picking objects_with_name (unreliable QS) or wasting a tool iteration.
          if (hasTools && isPureNavigationIntent(lastUserText) && _isNewUserRequest && _fabricatedCallCount < _maxFabricatedCalls && !_isMultiStep) {
            const navTarget = extractNavigationTarget(lastUserText);
            if (navTarget) {
              // OPTIMIZATION: try de-separated tag first (PC-001 → PC001)
              const _sepMNav = navTarget.match(/^([A-Za-z]+)([-\s])(\d+[A-Za-z]?)$/);
              const navTargetClean = _sepMNav ? _sepMNav[1].toUpperCase() + _sepMNav[3] : navTarget;
              const _navToolName = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                ? "navigate_to_comos_object_by_name_or_label" : "navigate_to_comos_object_by_name";
              const _navArgKey = _navToolName.includes("label") ? "objectNameOrLabel" : "objectName";
              const fabricatedNav = buildFabricatedToolCallResponse(
                _navToolName,
                { [_navArgKey]: navTargetClean },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricatedNav, { "X-Comos-Ai-Shim": "fabricated-nav-direct" });
              log(`fabricated_nav_direct session=${sessionKey} target="${navTarget}" navTarget="${navTargetClean}" tool=${_navToolName}`);
              return;
            }
          }

          // ── Attribute VALUE fabrication ────────────────────────
          // When the user asks for an attribute value (e.g., "What's the Shaft Power of P-101?"),
          // fabricate the tool call directly instead of letting the LLM navigate first.
          // This avoids the navigate-then-read two-step which is blocked by force_tool_choice_none.
          // GUARD: skip fabrication if user explicitly references documents/RAG — let RAG handle it.
          if (hasTools && asksAttrValue && hasAttributeReadTool && _isNewUserRequest && _fabricatedCallCount < _maxFabricatedCalls && !hasExplicitDocumentSignals(lastUserText) && !_isMultiStep) {
            const { objectTag, attributeName } = extractAttributeAndObject(lastUserText);
            if (attributeName) {
              const recentUID = extractRecentObjectSystemUID(lastUserText, messages);
              if (!recentUID && objectTag) {
                // Reliable path: resolve SystemUID from the requested object IN THIS TURN,
                // then post-nav handler will call value_of_attribute... with that UID.
                // OPTIMIZATION: COMOS stores object names WITHOUT hyphens/spaces.
                // "PC-001" → "PC001" in the Name property. Try the de-separated form
                // FIRST to avoid a wasted iteration on the failing hyphenated form.
                // This saves 1 iteration within the C# API's 3-iteration limit.
                const _sepM = objectTag.match(/^([A-Za-z]+)([-\s])(\d+[A-Za-z]?)$/);
                const navTag = _sepM ? _sepM[1].toUpperCase() + _sepM[3] : objectTag;
                const _navToolName = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                  ? "navigate_to_comos_object_by_name_or_label"
                  : "navigate_to_comos_object_by_name";
                const _navArgKey = _navToolName.includes("label") ? "objectNameOrLabel" : "objectName";
                const fabricated = buildFabricatedToolCallResponse(
                  _navToolName,
                  { [_navArgKey]: navTag },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-nav-first" });
                log(`fabricated_attr_nav_first session=${sessionKey} tag="${objectTag}" navTag="${navTag}" attr="${attributeName}" tool=${_navToolName}`);
                return;
              }
              // Keep requests independent: if object tag is in the user's message,
              // call attribute tool directly with the full query text. Do NOT
              // force a navigation pre-step based on prior conversation state.
              const attrQueryText = extractAttributeQueryText(lastUserText);
              const objectScopedAttrQuery = objectTag
                ? (attrQueryText || `${attributeName} of ${objectTag}`)
                : attributeName;
              const attrArgs = { objectNameOrDescription: objectScopedAttrQuery };
              if (recentUID) attrArgs.systemUID = recentUID;
              const fabricated = buildFabricatedToolCallResponse(
                "value_of_attribute_by_name_or_description",
                attrArgs,
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-value" });
              log(`fabricated_attr_value session=${sessionKey} attr="${attributeName}" tag="${objectTag}" systemUID=${recentUID || "(none)"}`);
              return;
            }
          }

          // ── Attribute NAVIGATION fabrication ────────────────────────
          // GUARD: skip fabrication if user explicitly references documents/RAG — let RAG handle it.
          if (hasTools && asksAttrNav && hasAttributeNavTool && _isNewUserRequest && _fabricatedCallCount < _maxFabricatedCalls && !hasExplicitDocumentSignals(lastUserText) && !_isMultiStep) {
            const { objectTag, attributeName } = extractAttributeAndObject(lastUserText);
            if (attributeName) {
              const recentUID = extractRecentObjectSystemUID(lastUserText, messages);
              if (!recentUID && objectTag) {
                // OPTIMIZATION: try de-separated tag first (PC-001 → PC001)
                const _sepM2 = objectTag.match(/^([A-Za-z]+)([-\s])(\d+[A-Za-z]?)$/);
                const navTag2 = _sepM2 ? _sepM2[1].toUpperCase() + _sepM2[3] : objectTag;
                const _navToolName = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                  ? "navigate_to_comos_object_by_name_or_label"
                  : "navigate_to_comos_object_by_name";
                const _navArgKey = _navToolName.includes("label") ? "objectNameOrLabel" : "objectName";
                const fabricated = buildFabricatedToolCallResponse(
                  _navToolName,
                  { [_navArgKey]: navTag2 },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-nav-first" });
                log(`fabricated_attr_nav_first session=${sessionKey} tag="${objectTag}" navTag="${navTag2}" attr="${attributeName}" tool=${_navToolName}`);
                return;
              }
              const attrQueryText = extractAttributeQueryText(lastUserText);
              const objectScopedAttrQuery = objectTag
                ? (attrQueryText || `${attributeName} of ${objectTag}`)
                : attributeName;
              const attrArgs = { objectNameOrDescription: objectScopedAttrQuery };
              if (recentUID) attrArgs.systemUID = recentUID;
              const fabricated = buildFabricatedToolCallResponse(
                "navigate_to_attribute_by_name_or_description",
                attrArgs,
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-nav" });
              log(`fabricated_attr_nav session=${sessionKey} attr="${attributeName}" tag="${objectTag}" (no systemUID)`);
              return;
            }
          }

          // ── Document navigation fabrication ────────────────────────
          // "open document AA_001" / "abrir documento X" → navigate_to_comos_document_by_name
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep &&
              isDocumentNavigationIntent(lastUserText) && toolNames.includes("navigate_to_comos_document_by_name")) {
            const docTarget = extractDocumentTarget(lastUserText);
            if (docTarget) {
              const fabricated = buildFabricatedToolCallResponse(
                "navigate_to_comos_document_by_name",
                { documentName: docTarget },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-doc-nav" });
              log(`fabricated_doc_nav session=${sessionKey} target="${docTarget}"`);
              return;
            }
          }

          // ── Report open fabrication ────────────────────────
          // "open report X" / "abrir relatório X" → open_report or open_report_twodc
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep) {
            if (isReportTwoDCIntent(lastUserText) && toolNames.includes("open_report_twodc")) {
              const rptTarget = extractReportTarget(lastUserText);
              if (rptTarget) {
                const fabricated = buildFabricatedToolCallResponse(
                  "open_report_twodc",
                  { reportName: rptTarget },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-report-twodc" });
                log(`fabricated_report_twodc session=${sessionKey} target="${rptTarget}"`);
                return;
              }
            } else if (isReportOpenIntent(lastUserText) && toolNames.includes("open_report")) {
              const rptTarget = extractReportTarget(lastUserText);
              if (rptTarget) {
                const fabricated = buildFabricatedToolCallResponse(
                  "open_report",
                  { reportName: rptTarget },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-report-open" });
                log(`fabricated_report_open session=${sessionKey} target="${rptTarget}"`);
                return;
              }
            }
          }

          // ── Revision fabrication ────────────────────────
          // "show last revision" / "última revisão" → show_last_revision_of_document
          // "create revision" / "criar revisão" → create_new_revision
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep) {
            if (isCreateRevisionIntent(lastUserText) && toolNames.includes("create_new_revision")) {
              const fabricated = buildFabricatedToolCallResponse(
                "create_new_revision",
                {},
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-create-revision" });
              log(`fabricated_create_revision session=${sessionKey}`);
              return;
            } else if (isShowRevisionIntent(lastUserText) && toolNames.includes("show_last_revision_of_document")) {
              const fabricated = buildFabricatedToolCallResponse(
                "show_last_revision_of_document",
                {},
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-show-revision" });
              log(`fabricated_show_revision session=${sessionKey}`);
              return;
            }
          }

          // ── Printer fabrication ────────────────────────
          // "list printers" / "listar impressoras" → get_info_about_all_available_printers_and_all_available_paper
          // "paper for document" / "papel do documento" → get_print_paper_name_for_document
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep && isPrinterIntent(lastUserText)) {
            const hasPaperDocSignal = /\b(document|documento|for\s+document|para\s+documento|do\s+documento)\b/i.test(lastUserText);
            if (hasPaperDocSignal && toolNames.includes("get_print_paper_name_for_document")) {
              // Paper size for a specific document — let LLM fill in the document parameter
              const fabricated = buildFabricatedToolCallResponse(
                "get_print_paper_name_for_document",
                {},
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-paper-for-doc" });
              log(`fabricated_paper_for_doc session=${sessionKey}`);
              return;
            } else if (toolNames.includes("get_info_about_all_available_printers_and_all_available_paper")) {
              const fabricated = buildFabricatedToolCallResponse(
                "get_info_about_all_available_printers_and_all_available_paper",
                {},
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-list-printers" });
              log(`fabricated_list_printers session=${sessionKey}`);
              return;
            }
          }

          // ── Query export fabrication ────────────────────────
          // "export query X" / "exportar consulta X" → export_query_to_excel
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep &&
              isQueryExportIntent(lastUserText) && toolNames.includes("export_query_to_excel")) {
            const queryTarget = extractQueryTarget(lastUserText);
            const fabricated = buildFabricatedToolCallResponse(
              "export_query_to_excel",
              queryTarget ? { queryName: queryTarget } : {},
              parsed.model
            );
            sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-query-export" });
            log(`fabricated_query_export session=${sessionKey} target="${queryTarget}"`);
            return;
          }

          // ── ATTRIBUTE WRITE fabrication ───────────────────────────
          // "Set Power transmission of PC001 to 75" →
          //   Step 1: navigate_to_comos_object(PC001) to get systemUID
          //   Step 2: set_attribute_value(systemUID, "Power transmission", "75")
          // This MUST come BEFORE list-attributes fabrication to prevent hijacking.
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && asksAttrWrite && canWriteAttribute) {
            // Step 2: After navigation success, fabricate set_attribute_value
            const _awLastTool = (Array.isArray(messages) ? messages : []).filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool").pop();
            const _awContent = String((_awLastTool || {}).content || (_awLastTool || {}).Content || "");
            const _awNavSuccess = _awContent.includes("Navigated to the object");
            if (_awNavSuccess && toolNames.includes("set_attribute_value")) {
              const _wp = extractWriteParams(lastUserText);
              const _uidMatch = _awContent.match(/SystemUID\s*[=:]\s*([A-Z0-9]+)/i);
              const _uid = _uidMatch ? _uidMatch[1] : "";
              const _sTypeMatch = _awContent.match(/SystemType\s*[=:]\s*(\d+)/i);
              const _sType = _sTypeMatch ? _sTypeMatch[1] : "";
              const fabricated = buildFabricatedToolCallResponse(
                "set_attribute_value",
                { attributeName: _wp.attributeName, newValue: _wp.newValue, systemUID: _uid, objectName: _wp.objectTag, systemType: _sType },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-write" });
              log(`fabricated_attr_write session=${sessionKey} attr="${_wp.attributeName}" val="${_wp.newValue}" uid="${_uid}" type=${_sType} obj="${_wp.objectTag}"`);
              return;
            }
          }
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && _isNewUserRequest && !_isMultiStep &&
              asksAttrWrite && canWriteAttribute && toolNames.includes("set_attribute_value")) {
            // Step 1: Navigate to the object first to get the SystemUID
            const _wp = extractWriteParams(lastUserText);
            if (_wp.objectTag) {
              const _navTool = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                ? "navigate_to_comos_object_by_name_or_label" : "navigate_to_comos_object_by_name";
              const _navArg = _navTool.includes("label") ? "objectNameOrLabel" : "objectName";
              const fabricated = buildFabricatedToolCallResponse(
                _navTool, { [_navArg]: _wp.objectTag }, parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-attr-write-nav" });
              log(`fabricated_attr_write_nav session=${sessionKey} tag="${_wp.objectTag}" attr="${_wp.attributeName}" val="${_wp.newValue}"`);
              return;
            }
          }

          // ── List attributes fabrication ────────────────────────
          // "list attributes of PC001", "show me the attributes", etc.
          // → list_object_attributes (or navigate first if object tag present)
          // GUARD: do NOT fabricate if user is asking about documents/RAG ("according to the documents, what are the attributes of X")
          const _isDocKnowledge = isDocumentKnowledgeIntent(lastUserText) || hasExplicitDocumentSignals(lastUserText);
          if (hasTools && _fabricatedCallCount < _maxFabricatedCalls && !_isMultiStep && !asksAttrWrite && !_isDocKnowledge && isListAttributesIntent(lastUserText)) {
            const hasListAttrsTool2 = toolNames.includes("list_object_attributes");
            if (hasListAttrsTool2) {
              // Check if user mentions a specific object tag
              const tagMatch = String(lastUserText || "").match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
              if (tagMatch && _isNewUserRequest) {
                // Navigate to the object first, then list_object_attributes will use selected object
                const _navToolName = toolNames.includes("navigate_to_comos_object_by_name_or_label")
                  ? "navigate_to_comos_object_by_name_or_label" : "navigate_to_comos_object_by_name";
                const _navArgKey = _navToolName.includes("label") ? "objectNameOrLabel" : "objectName";
                const fabricated = buildFabricatedToolCallResponse(
                  _navToolName,
                  { [_navArgKey]: tagMatch[1] },
                  parsed.model
                );
                sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-list-attrs-nav-first" });
                log(`fabricated_list_attrs_nav_first session=${sessionKey} tag="${tagMatch[1]}"`);
                return;
              }
              // No tag or already navigated — call list_object_attributes directly.
              // CRITICAL: extract SystemUID from a prior nav success in the
              // conversation so the C# tool can use LoadObjectByType (Strategy 2)
              // even when SelectedObject is null due to COM timing.
              let _navUidForDirect = "";
              let _navTypeForDirect = "";
              const _directToolMsgs = (Array.isArray(messages) ? messages : []).filter(m =>
                String(m.role || m.Role || "").toLowerCase() === "tool"
              );
              for (const _dtm of _directToolMsgs) {
                const _dtmC = String(_dtm.content || _dtm.Content || "");
                if (_dtmC.includes("Navigated to the object") || (_dtmC.includes("success = True") && _dtmC.includes("SystemUID"))) {
                  const _uidM = _dtmC.match(/SystemUID\s*[=:]\s*([A-Z0-9]+)/i);
                  if (_uidM) { _navUidForDirect = _uidM[1]; }
                  const _typeM = _dtmC.match(/SystemType\s*[=:]\s*(\d+)/i);
                  if (_typeM) { _navTypeForDirect = _typeM[1]; }
                  if (_navUidForDirect) break;
                }
              }
              const _tagForDirect = tagMatch ? tagMatch[1] : "";
              const fabricated = buildFabricatedToolCallResponse(
                "list_object_attributes",
                { systemUID: _navUidForDirect, objectName: _tagForDirect, systemType: _navTypeForDirect },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-list-attrs-direct" });
              log(`fabricated_list_attrs_direct session=${sessionKey} objectName="${_tagForDirect}" uid="${_navUidForDirect}" type=${_navTypeForDirect}`);
              return;
            } else {
              // Tool not available — inform user
              const isPt = detectPortugueseText(lastUserText);
              const msg = isPt
                ? "A ferramenta de listagem de atributos não está disponível nesta sessão. Reinicie o COMOS para carregar a versão atualizada."
                : "The attribute listing tool is not available in this session. Restart COMOS to load the updated version.";
              sendJsonResponse(res, 200, buildCompletionResponse(msg, parsed.model), {
                "X-Comos-Ai-Shim": "list-attrs-unavailable",
              });
              log(`list_attrs_unavailable session=${sessionKey}`);
              return;
            }
          }

          // ── Post-nav follow-up for list attributes: if last tool was nav success
          //    and user asked for list_attributes, fabricate list_object_attributes
          if (_fabricatedCallCount < _maxFabricatedCalls && !asksAttrWrite && !_isDocKnowledge && isListAttributesIntent(lastUserText)) {
            const _lastToolMsgLA = (Array.isArray(messages) ? messages : []).filter(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool"
            ).pop();
            const _laContent = String((_lastToolMsgLA || {}).content || (_lastToolMsgLA || {}).Content || "");
            const _laIsNavSuccess = _laContent.includes("Navigated to the object");
            if (_laIsNavSuccess && toolNames.includes("list_object_attributes")) {
              // Extract tag, SystemUID and SystemType from nav result
              const _tagMatchLA = String(lastUserText || "").match(/\b([A-Z]{1,4}[- ]?\d{2,5}[A-Z]?)\b/i);
              const _tagForLA = _tagMatchLA ? _tagMatchLA[1] : "";
              const _uidMatchLA = _laContent.match(/SystemUID\s*[=:]\s*(\S+)/i);
              const _uidForLA = _uidMatchLA ? _uidMatchLA[1] : "";
              const _typeMatchLA = _laContent.match(/SystemType\s*[=:]\s*(\d+)/i);
              const _typeForLA = _typeMatchLA ? _typeMatchLA[1] : "";
              const fabricated = buildFabricatedToolCallResponse(
                "list_object_attributes",
                { systemUID: _uidForLA, objectName: _tagForLA, systemType: _typeForLA },
                parsed.model
              );
              sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-list-attrs-after-nav" });
              log(`fabricated_list_attrs_after_nav session=${sessionKey} objectName="${_tagForLA}" uid="${_uidForLA}" type=${_typeForLA}`);
              return;
            }
          }

          // ── ATTRIBUTE WRITE: keep read + write + nav tools ───────────
          // When write intent is detected and the write tool exists, keep
          // the READ tool available so the LLM can do read-first-then-write.
          // This is essential because the native read tool resolves the
          // object internally and returns the systemUID that the write tool
          // needs to locate the object reliably.
          if (hasTools && asksAttrWrite && canWriteAttribute && _isNewUserRequest && !_isMultiStep) {
            parsed.tools = (parsed.tools || []).filter(t => {
              const n = (t?.function?.name || t?.Function?.Name || "");
              return /set_attribute|value_of_attribute|navigate_to_comos_object|navigate_to_attribute|list_object_attr/i.test(n);
            });
            log(`attr_write_tool_keep session=${sessionKey} tools=${parsed.tools.map(t => t?.function?.name || t?.Function?.Name).join(",")}`);
          }

          if (hasTools && asksAttrWrite && !canWriteAttribute) {
            const isPt = detectPortugueseText(lastUserText);
            const msg = isPt
              ? "Não tenho ferramenta de escrita de atributo disponível nesta sessão.\n\nPosso:\n- Ler o valor atual do atributo\n- Navegar até o atributo para edição manual no COMOS\n\nDiga o nome/descrição do atributo (ex.: \"shaft power\")."
              : "I don’t have an attribute write tool available in this session.\n\nI can:\n- Read the current attribute value\n- Navigate to the attribute so you can edit it manually in COMOS\n\nTell me the attribute name/description (e.g., \"shaft power\").";
            sendJsonResponse(res, 200, buildCompletionResponse(msg, parsed.model), {
              "X-Comos-Ai-Shim": "attribute-write-unavailable",
            });
            log(`attribute_write_unavailable session=${sessionKey}`);
            return;
          }

          // ── DIAGNOSTIC: log messages containing tool roles or tool_calls ──
          const toolMsgs = messages.filter(m => m.role === "tool" || (m.tool_calls && m.tool_calls.length > 0));
          if (toolMsgs.length > 0) {
            log(`tool_msgs_in_request session=${sessionKey} count=${toolMsgs.length} roles=${toolMsgs.map(m => m.role).join(",")}`);
            for (const tm of toolMsgs) {
              const snippet = JSON.stringify(tm).substring(0, 300);
              log(`  tool_msg: ${snippet}`);
            }
          }

          // ── Normalize conversation history ──────────────────────────
          const cleanMessages = normalizeMessagesForOpenAI(messages);

          // ── IMPORT WORKFLOW: intercept BEFORE sending to LLM ────────
          // Detects user asking for option 1 / option 2 when there's a
          // cached analysis.  Generates VBS via gateway and returns a
          // comos-script data block that the chat UI renders as an
          // interactive execution panel.
          if (completedAnalyses.has(sessionKey) && info.lastUserMsg) {
            const lm = (info.lastUserMsg || "").toLowerCase().trim();
            const rawMsg = (info.lastUserMsg || "").trim();

            // Detect option 2 (VBS script: create + draw on diagram)
            const wantsVbs = (lm.includes("script") || lm.includes("vbs") || lm.includes("opção 2") ||
                             lm.includes("opcao 2") || lm.includes("option 2") || lm.includes("gerar script") ||
                             /^2[\s,.:;!]/.test(lm) || lm === "2");

            // Detect option 1 (auto-create objects using native tool)
            const isUidOnly = /^\s*[A-Z0-9]{8,12}\s*$/i.test(rawMsg);
            const isExecuteNow = /\b(executar\s+agora|execute\s+now|run\s+now)\b/.test(lm);
            const isConfirmYes = /^(sim|yes|ok|okay|confirmo|confirm|pode|pode\s+sim)$/i.test(rawMsg);
            const askedConfirm = assistantAskedImportConfirmation(messages);

            const wantsImport = (lm.includes("import") || lm.includes("criar") ||
                                lm.includes("opção 1") || lm.includes("opcao 1") || lm.includes("option 1") ||
                                lm.includes("criar automaticamente") || lm.includes("criar objetos") ||
                                lm.includes("automat") || lm.includes("automátic") ||
                                /^1[\s,.:;!]/.test(lm) || lm === "1" ||
                                isUidOnly || isExecuteNow || (isConfirmYes && askedConfirm));

            // ── Guard: skip re-fabrication if request already contains
            //    a tool result for import_equipment_from_excel.  After
            //    the shim fabricates a tool_call, COMOS executes the
            //    tool and sends back the result — lastUserMsg is still
            //    "1" so wantsImport fires again. This guard breaks the
            //    loop: let the tool_result flow to the LLM for summary.
            const importDiag = parseImportDiagnosticsFromMessages(messages);
            const hasImportToolResult = !!importDiag || messages.some(m =>
              (m.role === "tool" || m.role === "function") &&
              (JSON.stringify(m).includes("import_equipment_from_excel") ||
               JSON.stringify(m).includes("extract_and_create_tags"))
            );
            const hasImportToolCall = messages.some(m =>
              (m.role === "assistant") &&
              (JSON.stringify(m.tool_calls || m.toolCalls || m.function_call || m.FunctionCall || "")
                .includes("import_equipment_from_excel") ||
               JSON.stringify(m.tool_calls || m.toolCalls || m.function_call || m.FunctionCall || "")
                .includes("extract_and_create_tags"))
            );

            // ── Option 1: auto-create via native tool ─────────────────
            // Guard only applies when last message is a tool result (COMOS
            // just executed the import and sent back the result).  When the
            // last message is from the user (_isNewUserRequest), this is a
            // fresh request — allow fabrication UNLESS a successful import
            // already exists in the conversation (created > 0).  Re-running
            // import on retry would create duplicate objects.
            const _importAlreadySucceeded = importDiag && importDiag.created !== null && importDiag.created > 0;
            if (wantsImport && (hasImportToolResult || hasImportToolCall)) {
              if (_importAlreadySucceeded) {
                // Import already ran successfully — don't re-fabricate, let LLM summarize
                log(`import_guard_already_succeeded session=${sessionKey} created=${importDiag.created} errors=${importDiag.errorCount ?? 0} — skipping re-fabrication`);
              } else if (!_isNewUserRequest) {
                log(`import_guard_bypass session=${sessionKey} hasResult=${hasImportToolResult} hasCall=${hasImportToolCall} — letting tool result flow to LLM`);
              }
            }

            if (wantsImport && importDiag && importDiag.cdeviceNotFound && importDiag.created === 0) {
              const msg =
                "⚠️ Import was executed, but COMOS did not create any objects for this P&ID.\n\n" +
                `Reason: **CDevice not found for SFN** (${importDiag.missingSfn || "Invalid SFN for this project"}).\n` +
                `Created: **0** | Errors: **${importDiag.errorCount ?? "?"}**\n\n` +
                "This indicates that the `SystemFullName` values from the matcher do not exist in this COMOS P&ID catalog.\n" +
                "To resolve, we need to adjust the matcher mapping to valid SFNs for your environment.";
              sendJsonResponse(res, 200, buildCompletionResponse(msg, parsed.model), {
                "X-Comos-Ai-Shim": "import-sfn-mismatch",
              });
              log(`import_sfn_mismatch session=${sessionKey} created=0 errorCount=${importDiag.errorCount ?? "?"} sfn=${importDiag.missingSfn || "unknown"}`);
              return;
            }

            if (wantsImport && !wantsVbs && !_importAlreadySucceeded && (_isNewUserRequest || (!hasImportToolResult && !hasImportToolCall))) {
              const cached = completedAnalyses.get(sessionKey);
              const isTagsOnly = cached && (cached.extractionMode === "tags_only" || cached.diagramType === "tags-only");
              const hasTagsTool = toolNames.includes("extract_and_create_tags");

              // ── Tags-only: use extract_and_create_tags tool ──
              if (isTagsOnly && (hasTagsTool || hasImportTool)) {
                const tagsPayload = buildTagsOnlyPayload(cached);
                if (tagsPayload) {
                  let docUID = extractRecentDocumentUid(rawMsg, messages);

                  const toolName = hasTagsTool ? "extract_and_create_tags" : "import_equipment_from_excel";
                  const toolArgs = hasTagsTool
                    ? { tagsPayload: tagsPayload, documentType: 29 }
                    : { excelFilePath: tagsPayload, documentType: 29 };
                  // Always include documentUID — use "ACTIVE" as fallback
                  toolArgs.documentUID = docUID || "ACTIVE";

                  const fabricated = buildFabricatedToolCallResponse(toolName, toolArgs, parsed.model);
                  sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-tool-call" });
                  log(`fabricated_tool_call session=${sessionKey} tool=${toolName} mode=tags_only docUID=${docUID || "ACTIVE"}`);
                  return;
                }
                // No valid payload
                sendJsonResponse(res, 200,
                  buildCompletionResponse(
                    "❌ No valid TAG with SystemFullName found.\n\n" +
                    "Try extracting the PDF again to get TAGs with matching.",
                    parsed.model),
                  { "X-Comos-Ai-Shim": "tags-no-payload" },
                );
                return;
              }

              // ── Normal import (full analysis with coordinates) ──
              if (hasImportTool) {
                // Fast-path: import directly from cached items (no file I/O)
                const cachedPayload = buildCachedImportPayload(cached);

                // Fallback path: resolve local Excel only when cache payload unavailable
                const excelLocalPath = cachedPayload ? "" : await resolveExcelLocalPath(cached);

                const importSource = cachedPayload || excelLocalPath;

                if (importSource) {
                  // Try to extract documentUID from user message (UID or name like FA.020)
                  let docUID = extractRecentDocumentUid(rawMsg, messages);

                  // Fabricate a tool_call so COMOS client executes import_equipment_from_excel
                  const toolArgs = { excelFilePath: importSource, documentType: 29 };
                  // Always include documentUID — use "ACTIVE" as fallback so the DLL
                  // can fall back to the currently open document in COMOS.
                  toolArgs.documentUID = docUID || "ACTIVE";

                  const fabricated = buildFabricatedToolCallResponse(
                    "import_equipment_from_excel",
                    toolArgs,
                    parsed.model
                  );
                  sendJsonResponse(res, 200, fabricated, { "X-Comos-Ai-Shim": "fabricated-tool-call" });
                  log(`fabricated_tool_call session=${sessionKey} tool=import_equipment_from_excel source=${cachedPayload ? "cache" : "excel"} docUID=${docUID || "ACTIVE"}`);
                  return;
                }
                // Excel path not available after all strategies
                sendJsonResponse(res, 200,
                  buildCompletionResponse(
                    "❌ Could not resolve the Excel file path.\n\n" +
                    "The file may have expired or the gateway was restarted.\n" +
                    "Try **analyzing the PDF/circuit again**, or use **Option 2** (generate VBS script).",
                    parsed.model),
                  { "X-Comos-Ai-Shim": "import-no-excel" },
                );
                return;
              } else {
                // Native tool not registered — tell user
                sendJsonResponse(res, 200,
                  buildCompletionResponse(
                    "❌ The `import_equipment_from_excel` tool is not available in this session.\n\n" +
                    "Use **Option 2** to generate a VBS script that can be run in the **Object Debugger**.",
                    parsed.model),
                  { "X-Comos-Ai-Shim": "import-tool-unavailable" },
                );
                return;
              }
            }

            // ── Option 2: generate VBS script (create + draw) ─────────
            if (wantsVbs) {
              const cached = completedAnalyses.get(sessionKey);
              const diagMatch = lm.match(/(?:diagrama|diagram|documento|document)\s+([^\s,]+)/i);
              const diagName = diagMatch ? diagMatch[1] : "";
              const useActive = !diagName || lm.includes("selecionado") || lm.includes("ativo") ||
                               lm.includes("atual") || lm.includes("current") || lm.includes("selected");
              try {
                const vbsPayload = {
                  items: cached.items || [],
                  document_uid: useActive ? "ACTIVE" : "",
                  document_type: 29,
                  diagram_name: diagName || "currently selected document",
                };
                const vbsResp = await fetch(`${gatewayBase}/comos/generate-import-script`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(vbsPayload),
                });
                if (vbsResp.ok) {
                  const vbsData = await vbsResp.json();
                  const downloadUrl = `http://127.0.0.1:${listenPort}/comos/download/${vbsData.file_id}`;
                  const itemCount = vbsData.items_count || cached.items.length;
                  const scriptData = {
                    scriptId: `script-${Date.now()}`,
                    filename: vbsData.filename,
                    downloadUrl: downloadUrl,
                    path: vbsData.path,
                    itemsCount: itemCount,
                    diagramName: diagName || "documento selecionado",
                    script: vbsData.script,
                  };
                  const vbsMsg =
                    `✅ **Option 2 — VBS Script** generated with **${itemCount}** items!\n\n` +
                    `Objects will be **created in the hierarchy and drawn** on the diagram.\n\n` +
                    "```comos-script\n" + JSON.stringify(scriptData) + "\n```\n\n" +
                    `Open the COMOS **Object Debugger**, paste the script (**Ctrl+V**) and press **F5** to run.\n` +
                    `The script will use the **currently selected document** in the COMOS navigator.`;
                  sendJsonResponse(res, 200,
                    buildCompletionResponse(vbsMsg, parsed.model),
                    { "X-Comos-Ai-Shim": "vbs-generated" },
                  );
                  log(`vbs_generated session=${sessionKey} items=${itemCount} option=2-create-draw`);
                  return;
                }
              } catch (vbsErr) {
                log(`vbs_generation_error session=${sessionKey} ${vbsErr.message}`);
              }
            }
            // Neither option matched clearly → fall through to LLM
          }

          // ── Inject COMOS system prompt + analysis context ───────────
          if (hasTools) {
            const toolHint = toolNames.length
              ? `\nYour available COMOS tools are: ${toolNames.join(", ")}.`
              : "";

            let attributeIntentContext = "";
            if ((asksAttrValue && hasAttributeReadTool) || (asksAttrNav && hasAttributeNavTool)) {
              const recentObjectUID = extractRecentObjectSystemUID(lastUserText, messages);
              const attrQuery = extractAttributeQueryText(lastUserText).replace(/"/g, "'");
              const preferredTool = asksAttrValue
                ? "value_of_attribute_by_name_or_description"
                : "navigate_to_attribute_by_name_or_description";

              attributeIntentContext =
                `\n\nATTRIBUTE REQUEST DETECTED FOR THIS USER TURN:\n` +
                `- Preferred tool for this turn: ${preferredTool}\n` +
                `- Attribute query text (use as objectNameOrDescription): \"${attrQuery}\"\n` +
                (recentObjectUID
                  ? `- Include systemUID: \"${recentObjectUID}\"\n`
                  : "- If no systemUID is known, still call the preferred attribute tool first.\n") +
                `- Do not ask for clarification before one tool attempt unless the user input is empty.`;
            }

            let filteredCountContext = "";
            if (asksFilteredObjectCount) {
              filteredCountContext =
                `\n\nFILTERED COUNT REQUEST DETECTED FOR THIS USER TURN:\n` +
                `- Equipment target candidate: \"${countEquipmentTarget || "unknown"}\"\n` +
                `- Attribute filter candidate: \"${attributeFilterText || "unknown"}\"\n` +
                `- If filter-capable tools exist, apply equipment + attribute filter before final count answer.\n` +
                `- If tools are insufficient for true filtered aggregation, explain limitation clearly and suggest COMOS query workflow.`;
            }

            let analysisContext = "";
            if (completedAnalyses.has(sessionKey) && hasImportTool) {
              const cached = completedAnalyses.get(sessionKey);
              const itemCount = cached.items ? cached.items.length : 0;

              // Resolve Excel local path using robust multi-strategy resolver
              const excelLocalPath = await resolveExcelLocalPath(cached);

              analysisContext =
                `\n\nANALYSIS CONTEXT (from recent ServiceiPID digitization):\n` +
                `- ${itemCount} equipment items detected\n` +
                `- Excel file for import_equipment_from_excel tool: ${excelLocalPath || "not available"}\n` +
                `- When the user asks to import in a diagram:\n` +
                `  1. Ask the user which diagram they want (if they haven't said)\n` +
                `  2. Use navigate_to_comos_object_by_name or objects_with_name to find the document\n` +
                `  3. Call import_equipment_from_excel with:\n` +
                `     - excelFilePath = "${excelLocalPath}"\n` +
                `     - documentUID = the SystemUID from step 2\n` +
                `     - documentType = 29\n`;
              log(`analysis_context_injected session=${sessionKey} items=${itemCount} excelPath=${excelLocalPath || "none"}`);
            }

            // ── RAG document knowledge context (async fetch) ──────────
            let ragContext = "";
            if (lastUserText && isDocumentKnowledgeIntent(lastUserText)) {
              log(`rag_intent_detected session=${sessionKey} query="${lastUserText.substring(0, 80)}"`);

              // Handle meta-questions ("which documents do you have?") by fetching
              // the document list instead of doing vector search
              if (isRagDocumentListIntent(lastUserText)) {
                ragContext = await fetchRagDocumentList(gatewayBase);
                if (ragContext) {
                  log(`rag_doclist_injected session=${sessionKey} length=${ragContext.length}`);
                } else {
                  log(`rag_doclist_empty session=${sessionKey}`);
                }
              }

              // Always also do vector search (enriched for follow-ups)
              if (!ragContext) {
                const enrichedQuery = buildEnrichedRagQuery(lastUserText, cleanMessages);
                if (enrichedQuery !== lastUserText) {
                  log(`rag_query_enriched session=${sessionKey} original="${lastUserText.substring(0, 60)}" enriched="${enrichedQuery.substring(0, 80)}"`);
                }
                ragContext = await fetchRagContext(enrichedQuery, gatewayBase, 5);
                if (ragContext) {
                  log(`rag_context_injected session=${sessionKey} length=${ragContext.length}`);
                } else {
                  log(`rag_no_results session=${sessionKey}`);
                }
              }
            }

            // ── Multi-step override: allow parallel tool calls for complex requests ──
            let multiStepContext = "";
            if (_isMultiStep) {
              multiStepContext =
                "\n\nMULTI-STEP REQUEST DETECTED — OVERRIDE RULES:\n" +
                "The user is asking for MULTIPLE sequential actions in one message. " +
                "OVERRIDE rule 7: you MAY call MULTIPLE tools in a single response by returning " +
                "several entries in the tool_calls array. Plan your actions efficiently:\n" +
                "- For navigation to multiple objects, call navigate_to_comos_object_by_name for each one.\n" +
                "- For attribute reads on multiple objects, batch the calls.\n" +
                "- You have a MAXIMUM of 3 iterations (including your final text summary). Plan accordingly.\n" +
                "- Execute the most critical actions first.\n" +
                "- After all tool results arrive, provide a consolidated summary to the user.\n";
              log(`multi_step_system_prompt_override session=${sessionKey}`);
            }

            const systemMsg = { role: "system", content: COMOS_SYSTEM_PROMPT + multiStepContext + toolHint + analysisContext + attributeIntentContext + filteredCountContext + ragContext };
            const firstIdx = cleanMessages.findIndex(m => (m.role || "").toLowerCase() === "system");
            if (firstIdx >= 0) {
              cleanMessages[firstIdx] = systemMsg;
            } else {
              cleanMessages.unshift(systemMsg);
            }
            log(`comos_system_prompt_injected session=${sessionKey} tools=[${toolNames.join(",")}]`);

            // ── RAG-priority override: strip tools for document-based queries ──
            // When the user explicitly says "according to the documents" and RAG
            // context was successfully injected, the answer lives in the context —
            // not in COMOS tools. Strip tools and force tool_choice=none so the
            // LLM answers from the injected RAG context instead of calling tools
            // (which wastes 2 iterations, strips object names, and then times out).
            if (ragContext && _isNewUserRequest && hasExplicitDocumentSignals(lastUserText)) {
              delete parsed.tools;
              delete parsed.tool_choice;
              parsed.tool_choice = "none";
              log(`rag_priority_strip_tools session=${sessionKey} reason=explicit_document_signals_with_rag`);
            }
          }

          // ── Conversation trimming — keep LLM context manageable ──────
          // The LLM slows down dramatically as message count grows (3s at 6 msgs
          // → 60s at 12+ msgs), causing COMOS 30s per-iteration timeout errors.
          // Strategy: keep system[0] + last N non-system messages. Preserves the
          // most recent user question and tool results while discarding old turns.
          const MAX_NON_SYSTEM_MSGS = 6; // system + last 6 = 7 total max
          if (cleanMessages.length > MAX_NON_SYSTEM_MSGS + 1) {
            const sysMsg = cleanMessages[0]?.role === "system" ? cleanMessages[0] : null;
            const nonSystem = sysMsg ? cleanMessages.slice(1) : cleanMessages;
            const trimmed = nonSystem.slice(-MAX_NON_SYSTEM_MSGS);
            // Ensure first message after system is not an orphan tool result
            if (trimmed.length > 0 && trimmed[0].role === "tool") {
              trimmed.shift(); // drop orphan tool result
            }
            const finalMsgs = sysMsg ? [sysMsg, ...trimmed] : trimmed;
            const dropped = cleanMessages.length - finalMsgs.length;
            if (dropped > 0) {
              log(`conversation_trimmed session=${sessionKey} from=${cleanMessages.length} to=${finalMsgs.length} dropped=${dropped}`);
              cleanMessages.length = 0;
              cleanMessages.push(...finalMsgs);
            }
          }

          parsed.messages = cleanMessages;
          delete parsed.Messages;

          // ── Prevent tool-call retry loops ─────────────────────────
          // COMOS .NET client can only handle ONE round of tool calling per
          // user message.  If the last message is a tool result, the LLM
          // must reply with text — another tool_call would cause COMOS to
          // show "what's up?" instead of displaying the response.
          //
          // EXCEPTION: When the tool result is an intermediate navigation step
          // and the user's original question involves an attribute query that
          // hasn't been answered yet, we allow one more tool call so the LLM
          // can chain navigate → attribute lookup.
          const lastMsg = cleanMessages[cleanMessages.length - 1];
          if (lastMsg && lastMsg.role === "tool") {
            // Check if this is an intermediate navigation result with a pending attribute query
            const lastToolContent = String(lastMsg.content || "");
            const isNavigationResult = lastToolContent.includes("Navigated to the object") || lastToolContent.includes("SystemUID");
            const isAttrResult = lastToolContent.includes("attribute") || lastToolContent.includes("Attribute");
            // Check if the CURRENT user message asks about an attribute (not previous turns)
            const hasPendingAttrQuery = isAttributeValueIntent(lastUserText) || isAttributeNavigationIntent(lastUserText);
            // Check if attribute was already attempted in CURRENT TURN only
            const attrAlreadyAttempted = _currentTurnMsgsShared.some(m =>
              String(m.role || m.Role || "").toLowerCase() === "tool" && (String(m.content || "").includes("Object doesn't found") || isAttrResult)
            );

            // Also check if this is a read-before-write chain: the user asked to WRITE
            // and the last tool was an attribute READ — allow one more call for the write tool.
            const isAttrReadResult = /value_of_attribute|ValueOfAttribute/i.test(lastToolContent) ||
              (lastToolContent.includes('"value"') && lastToolContent.includes('"attribute"'));
            const hasPendingWrite = isAttributeWriteIntent(lastUserText);

            if (isNavigationResult && hasPendingAttrQuery && !attrAlreadyAttempted) {
              // Allow the LLM to make one more tool call for attribute lookup
              log(`skip_force_tool_choice_none session=${sessionKey} reason=pending_attribute_query_after_navigation`);
            } else if (hasPendingWrite && isAttrReadResult && !attrAlreadyAttempted) {
              // Allow the LLM to call set_attribute_value after reading the attribute
              log(`skip_force_tool_choice_none session=${sessionKey} reason=pending_attribute_write_after_read`);
            } else {
              parsed.tool_choice = "none";
              log(`force_tool_choice_none session=${sessionKey} reason=last_msg_is_tool`);
            }
          }

          // ── Tool-failure short-circuit ────────────────────────────────
          // When tool_choice is "none" (LLM must respond with text) AND the last
          // tool result is a clear unrecoverable error, synthesize the response
          // instantly instead of asking the LLM (which can take 35-60s to think
          // about an error and compose a message — exceeding the 30s DLL timeout).
          if (parsed.tool_choice === "none" && lastMsg && lastMsg.role === "tool") {
            const _tc = String(lastMsg.content || "");
            let _shortCircuitMsg = null;

            if (_tc.includes("Document not found")) {
              const uidMatch = _tc.match(/Document not found:\s*(\S+)/);
              _shortCircuitMsg = `The requested document was not found (${uidMatch ? uidMatch[1] : "unknown UID"}). ` +
                `This object may not have an associated document or diagram in the current project. ` +
                `Try using navigate_to_comos_document_by_name with the document name instead.`;
            } else if (_tc.includes("TIMEOUT_ERROR") || _tc.includes("timed out")) {
              _shortCircuitMsg = `The previous operation timed out. Please try again with a simpler request.`;
            } else if (_tc.includes("success = False") && _tc.includes("Object doesn't found")) {
              // Navigation failed — but this is already handled by nav-retry above.
              // Only short-circuit if we've exhausted retries.
              const navRetryExhausted = _fabricatedCallCount >= _maxFabricatedCalls;
              if (navRetryExhausted) {
                const nameMatch = _tc.match(/(?:Name|objectName)\s*=\s*([^,}]+)/);
                _shortCircuitMsg = `The object "${nameMatch ? nameMatch[1].trim() : "requested"}" was not found in COMOS. ` +
                  `Please verify the exact name in the COMOS Navigator (it may use a different spelling, ` +
                  `with or without hyphens/spaces).`;
              }
            } else if (_tc.includes("success = False") && _tc.includes("Could not find the object")) {
              // list_object_attributes or similar failed to locate the object
              const nameMatch = _tc.match(/objectName='([^']+)'/);
              const diagMatch = _tc.match(/\[DIAG:\s*([^\]]+)\]/);
              const errMatch = _tc.match(/error\s*=\s*([^}]+)/);
              _shortCircuitMsg = errMatch && errMatch[1]
                ? errMatch[1].trim()
                : `Could not find the object "${nameMatch ? nameMatch[1] : "requested"}" in COMOS. ` +
                  `The object may use a different name format. Please verify the exact tag in the COMOS Navigator.`;
              if (diagMatch && diagMatch[1]) {
                _shortCircuitMsg += `\nDiagnostic: ${diagMatch[1].trim()}`;
              }
            } else if (_tc.includes("success = False") && _tc.includes("not found on object") && asksAttrWrite) {
              // Attribute write failed: attribute not found on the object
              const _awErrM = _tc.match(/error\s*=\s*([^}]+)/);
              const _awClosest = _tc.match(/closestMatch\s*=\s*([^}]+)/);
              const _isPtF = detectPortugueseText(lastUserText);
              _shortCircuitMsg = _isPtF
                ? `❌ Não foi possível alterar o atributo: ${_awErrM ? _awErrM[1].trim() : "atributo não encontrado"}`
                  + (_awClosest ? `\nSugestão: **${_awClosest[1].trim()}**` : "")
                : `❌ Could not update the attribute: ${_awErrM ? _awErrM[1].trim() : "attribute not found"}`
                  + (_awClosest ? `\nClosest match: **${_awClosest[1].trim()}**` : "");
            } else if (_tc.includes("success = False") && asksAttrWrite && (_tc.includes("Value setter failed") || _tc.includes("specifications"))) {
              // Attribute write failed: setter error or no specs
              const _awErrM = _tc.match(/error\s*=\s*([^}]+)/);
              const _isPtF = detectPortugueseText(lastUserText);
              _shortCircuitMsg = _isPtF
                ? `❌ Não foi possível alterar o valor: ${_awErrM ? _awErrM[1].trim() : "erro na escrita"}`
                : `❌ Could not write the value: ${_awErrM ? _awErrM[1].trim() : "write error"}`;
            }

            if (_shortCircuitMsg) {
              const shortCircuitResp = {
                id: `chatcmpl-shim-sc-${Date.now()}`,
                object: "chat.completion",
                model: parsed.model || "serviceipid-gateway",
                choices: [{ index: 0, message: { role: "assistant", content: _shortCircuitMsg }, finish_reason: "stop" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              };
              sendJsonResponse(res, 200, shortCircuitResp, { "X-Comos-Ai-Shim": "tool-fail-short-circuit" });
              log(`tool_fail_short_circuit session=${sessionKey} msg="${_shortCircuitMsg.substring(0, 80)}..."`);
              return;
            }
          }

          // ── Tool-SUCCESS short-circuit ────────────────────────────────
          // When tool_choice is "none" AND the last tool result is a shim-
          // fabricated SUCCESS, synthesize the response instantly instead of
          // asking the LLM. The LLM would compose obvious text like "Navigated
          // to M001" but can take 30-60s causing timeout. Since WE fabricated
          // the tool call, we know exactly what the user asked for.
          if (parsed.tool_choice === "none" && lastMsg && lastMsg.role === "tool") {
            const _scContent = String(lastMsg.content || "");
            const _scTcId = String(lastMsg.tool_call_id || lastMsg.toolCallId || lastMsg.ToolCallId || "");
            const _scFabricated = _scTcId.startsWith("call_shim_");
            const _scSuccess = _scContent.includes("success = True");
            const _isPt = detectPortugueseText(lastUserText);

            if (_scFabricated && _scSuccess) {
              let _successMsg = null;

              // ─ Import success ─ (must come BEFORE count check because import results contain 'errorCount' which falsely matches 'Count =')
              const _isImportResult = /\bcreated\s*=\s*\d+/i.test(_scContent) && /\bdrawn\s*=\s*\d+/i.test(_scContent);
              if (_isImportResult) {
                const _crM = _scContent.match(/\bcreated\s*=\s*(\d+)/i);
                const _drM = _scContent.match(/\bdrawn\s*=\s*(\d+)/i);
                const _cnM = _scContent.match(/\bconnections\s*=\s*(\d+)/i);
                const _erM = _scContent.match(/\berrorCount\s*=\s*(\d+)/i);
                const _created = _crM ? _crM[1] : "0";
                const _drawn = _drM ? _drM[1] : "0";
                const _conns = _cnM ? _cnM[1] : "0";
                const _errors = _erM ? Number(_erM[1]) : 0;
                // Extract error details
                const _errDetailM = _scContent.match(/errors\s*=\s*(.+?)(?:,\s*message|$)/i);
                const _errDetails = _errDetailM ? _errDetailM[1].trim() : "";
                if (_isPt) {
                  _successMsg = `\u2705 **Importação concluída:**\n\n` +
                    `- Objetos criados: **${_created}**\n` +
                    `- Posicionados no diagrama: **${_drawn}**\n` +
                    `- Conexões: **${_conns}**\n` +
                    (_errors > 0 ? `- Erros: **${_errors}**` + (_errDetails ? `\n  ${_errDetails}` : "") : "");
                } else {
                  _successMsg = `\u2705 **Import complete:**\n\n` +
                    `- Objects created: **${_created}**\n` +
                    `- Positioned on diagram: **${_drawn}**\n` +
                    `- Connections: **${_conns}**\n` +
                    (_errors > 0 ? `- Errors: **${_errors}**` + (_errDetails ? `\n  ${_errDetails}` : "") : "");
                }
              }
              // ─ Navigation success ─ (BUT skip if write intent pending → step 2 needs to run)
              else if (_scContent.includes("Navigated to the object") && !asksAttrWrite) {
                const _scNameM = _scContent.match(/objectNameOrLabel\s*=\s*([^,}]+)/);
                const _scUidM = _scContent.match(/SystemUID\s*=\s*([A-Z0-9]+)/i);
                const _scObjName = _scNameM ? _scNameM[1].trim() : "the object";
                _successMsg = _isPt
                  ? `✅ Navegado para **${_scObjName}**` + (_scUidM ? ` (SystemUID: ${_scUidM[1]})` : "")
                  : `✅ Navigated to **${_scObjName}**` + (_scUidM ? ` (SystemUID: ${_scUidM[1]})` : "");
              }
              // ─ Attribute value success ─
              else if (_scContent.includes("Value of attribute") || _scContent.includes("DisplayValue")) {
                const _dvM = _scContent.match(/DisplayValue\s*=\s*([^,}]+)/);
                const _valM = _scContent.match(/(?:^|,\s*)Value\s*=\s*([^,}]+)/);
                const _displayVal = _dvM ? _dvM[1].trim() : (_valM ? _valM[1].trim() : "N/A");
                const _attrEx = extractAttributeAndObject(lastUserText);
                const _scAttrName = _attrEx.attributeName || "the attribute";
                const _scObjTag = _attrEx.objectTag || "the object";
                _successMsg = _isPt
                  ? `O valor de **${_scAttrName}** de **${_scObjTag}** é **${_displayVal}**.`
                  : `The **${_scAttrName}** of **${_scObjTag}** is **${_displayVal}**.`;
              }
              // ─ List attributes success ─ (must come BEFORE count check because attributeCount matches 'Count =')
              else if (_scContent.includes("attributeCount") && /attributes\s*=/.test(_scContent)) {
                // Format attributes directly in the shim — avoid 100s LLM timeout on 400+ attributes
                const _laObjM = _scContent.match(/objectName\s*=\s*([^,}]+)/);
                const _laAttrsM = _scContent.match(/attributes\s*=\s*([\s\S]+?)\s*}\s*$/);
                const _laAttrStr = _laAttrsM ? _laAttrsM[1].trim() : "";
                const _laAttrs = _laAttrStr.split(";").map(a => a.trim()).filter(a => a.length > 0);
                const _laObj = _laObjM ? _laObjM[1].trim() : "object";
                const _laIsPt = _isPt;
                if (_laAttrs.length === 0) {
                  _successMsg = _laIsPt
                    ? `O objeto **${_laObj}** não possui atributos preenchidos.`
                    : `Object **${_laObj}** has no filled attributes.`;
                } else {
                  _successMsg = _laIsPt
                    ? `Atributos preenchidos de **${_laObj}** (${_laAttrs.length}):\n\n`
                    : `Filled attributes of **${_laObj}** (${_laAttrs.length}):\n\n`;
                  _successMsg += `| Tab | Attribute | Value |\n|-----|-----------|-------|\n`;
                  for (const _laA of _laAttrs) {
                    const _laTabM = _laA.match(/^\[([^\]]*)\]\s*(.*)/);
                    let _laTab = "", _laRest = _laA;
                    if (_laTabM) { _laTab = _laTabM[1]; _laRest = _laTabM[2]; }
                    const _laEqIdx = _laRest.indexOf(" = ");
                    let _laName = _laRest, _laVal = "";
                    if (_laEqIdx > -1) { _laName = _laRest.substring(0, _laEqIdx); _laVal = _laRest.substring(_laEqIdx + 3); }
                    _successMsg += `| ${_laTab} | ${_laName} | ${_laVal} |\n`;
                  }
                }
              }
              // ─ Count success ─ (exclude import results and attribute lists)
              else if (!_isImportResult && !_scContent.includes("attributeCount") && (_scContent.includes("Count =") || _scContent.includes("count ="))) {
                const _cntM = _scContent.match(/[Cc]ount\s*=\s*(\d+)/);
                const _countVal = _cntM ? _cntM[1] : "0";
                const _navTarget = extractNavigationTarget(lastUserText) || "matching objects";
                _successMsg = _isPt
                  ? `Foram encontrados **${_countVal}** objetos com o nome "${_navTarget}".`
                  : `Found **${_countVal}** objects named "${_navTarget}".`;
              }
              // ─ Attribute WRITE success ─
              else if (_scContent.includes("success = True") && _scContent.includes("oldValue") && _scContent.includes("newValue") && asksAttrWrite) {
                const _awObjM = _scContent.match(/objectName\s*=\s*([^,}]+)/);
                const _awAttrM = _scContent.match(/attributeName\s*=\s*([^,}]+)/);
                const _awOldM = _scContent.match(/oldValue\s*=\s*([^,}]+)/);
                const _awNewM = _scContent.match(/newValue\s*=\s*([^,}]+)/);
                const _awObj = _awObjM ? _awObjM[1].trim() : "the object";
                const _awAttr = _awAttrM ? _awAttrM[1].trim() : "the attribute";
                const _awOld = _awOldM ? _awOldM[1].trim() : "(empty)";
                const _awNew = _awNewM ? _awNewM[1].trim() : "(unknown)";
                _successMsg = _isPt
                  ? `✅ Atributo atualizado com sucesso!\n\n**Objeto:** ${_awObj}\n**Atributo:** ${_awAttr}\n**Valor anterior:** ${_awOld}\n**Novo valor:** ${_awNew}`
                  : `✅ Attribute updated successfully!\n\n**Object:** ${_awObj}\n**Attribute:** ${_awAttr}\n**Old value:** ${_awOld}\n**New value:** ${_awNew}`;
              }

              if (_successMsg) {
                const _successResp = {
                  id: `chatcmpl-shim-ok-${Date.now()}`,
                  object: "chat.completion",
                  model: parsed.model || "serviceipid-gateway",
                  choices: [{ index: 0, message: { role: "assistant", content: _successMsg }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                };
                sendJsonResponse(res, 200, _successResp, { "X-Comos-Ai-Shim": "tool-success-short-circuit" });
                log(`tool_success_short_circuit session=${sessionKey} msg="${_successMsg.substring(0, 80)}..."`);
                return;
              }
            }
          }

          const rawUrl = `${gatewayBase}/v1/chat/completions/raw`;
          const rawBody = JSON.stringify(parsed);
          log(`proxy_raw_llm session=${sessionKey} msgs=${cleanMessages.length} tools_count=${(parsed.tools || []).length} url=${rawUrl}`);

          // DEBUG: Log every normalized message
          for (let mi = 0; mi < cleanMessages.length; mi++) {
            const m = cleanMessages[mi];
            const mRole = m.role || "?";
            const hasTC = m.tool_calls ? `tool_calls[${m.tool_calls.length}] id=${m.tool_calls[0]?.id}` : "";
            const hasFC = m.function_call ? `FC=${m.function_call.name}` : "";
            const hasTCID = m.tool_call_id ? `tcid=${m.tool_call_id}` : "";
            log(`comp_msg[${mi}] role=${mRole} ${hasTC} ${hasFC} ${hasTCID} content=${(m.content || "").substring(0, 60)}`);
          }
          // ── Detect intent for agent_started event ──
          const _userIntentSummary = lastUserText
            ? lastUserText.substring(0, 80).replace(/\n/g, " ")
            : "processing request";

          // Detect tool_calls in the request (COMOS sending back results means a tool step happened)
          const _reqToolCalls = cleanMessages.filter(m => m.role === "assistant" && m.tool_calls);
          const _reqToolResults = cleanMessages.filter(m => m.role === "tool" || m.role === "function");
          const _isFirstIteration = _reqToolCalls.length === 0;

          // Only emit agent_started on the FIRST iteration of a turn (not on continuations)
          if (_isFirstIteration) {
            emitAgentEvent("agent_started", { message: `Analyzing: ${_userIntentSummary}` });
          }

          if (_reqToolCalls.length > 0) {
            const _lastTC = _reqToolCalls[_reqToolCalls.length - 1];
            const _tcNames = (_lastTC.tool_calls || []).map(tc => tc.function?.name || "unknown");
            const stepNum = (agentStepCounters.get(sessionKey) || 0) + 1;
            agentStepCounters.set(sessionKey, stepNum);
            for (const tn of _tcNames) {
              const label = friendlyToolLabel(tn);
              if (label) emitAgentEvent("agent_tool_call", { message: `Step ${stepNum}: ${label}`, tool: tn, step: stepNum });
            }
          }

          // ── Contextual thinking message based on conversation state ──
          let _thinkingMsg;
          if (_isFirstIteration) {
            _thinkingMsg = `Processing: ${_userIntentSummary.substring(0, 60)}...`;
          } else {
            // On continuation: describe what we're doing based on last tool result
            const _lastToolResult = _reqToolResults.length > 0 ? String(_reqToolResults[_reqToolResults.length - 1].content || "") : "";
            if (_lastToolResult.includes("success = True") && _lastToolResult.includes("Navigated")) {
              _thinkingMsg = "Object found — reading attributes...";
            } else if (_lastToolResult.includes("success = False")) {
              _thinkingMsg = "Retrying with alternative approach...";
            } else {
              _thinkingMsg = "Analyzing results and planning next step...";
            }
          }
          emitAgentEvent("agent_thinking", { message: _thinkingMsg, substate: "llm_call" });

          try {
            const { response: rawResp, timedOut } = await fetchWithSafetyTimeout(rawUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: rawBody,
            }, `completions_session=${sessionKey}`);

            // ── 95s safety timeout: return soft message ──
            if (timedOut) {
              emitAgentEvent("agent_timeout", { message: "Agent timed out — synthesizing results..." });
              const safetyMsg =
                "⏳ Engineering copilot está processando sua solicitação. " +
                "Envie uma nova mensagem para continuar ou tente novamente.";
              sendJsonResponse(res, 200, buildCompletionResponse(safetyMsg, parsed.model), {
                "X-Comos-Ai-Shim": "safety-timeout-95s",
              });
              log(`safety_timeout_95s session=${sessionKey}`);
              agentStepCounters.delete(sessionKey);
              return;
            }

            const rawBuffer = Buffer.from(await rawResp.arrayBuffer());
            const adapted = adaptRawCompletionForComos(rawBuffer, parsed, sessionKey);

            try {
              const maybeObj = JSON.parse(adapted.buffer.toString("utf8"));
              const firstMsg = maybeObj?.choices?.[0]?.message;
              const firstContent = firstMsg?.content;
              if (isToolIterationTimeoutText(firstContent)) {
                const safeMsg =
                  "✅ A importação foi concluída, mas a confirmação automática excedeu o tempo limite. " +
                  "Pode continuar normalmente.";
                sendJsonResponse(res, 200, buildCompletionResponse(safeMsg, parsed.model), {
                  "X-Comos-Ai-Shim": "completions-timeout-softened",
                });
                log(`completions_timeout_softened session=${sessionKey}`);
                return;
              }
            } catch { /* ignore parsing issues and keep default flow */ }

            // ── Soften non-200 gateway responses into a friendly chat message ──
            // The C# AI Client does NOT handle HTTP errors gracefully — it throws
            // an exception and never calls window.addAssistantMessage(), leaving
            // the CefSharp chat UI permanently frozen with a spinning indicator.
            // By always returning 200 with an error-text in first choice content,
            // the C# client processes it normally and the UI stays responsive.
            if (rawResp.status !== 200) {
              let errDetail = "";
              try { errDetail = adapted.buffer.toString("utf8").substring(0, 300); } catch {}
              const friendlyMsg =
                "⚠️ The AI service returned an error (HTTP " + rawResp.status + "). " +
                "Please try again or start a new conversation.";
              log(
                `raw_llm_error_softened session=${sessionKey} status=${rawResp.status} ` +
                `detail=${errDetail.substring(0, 200)}`
              );
              sendJsonResponse(res, 200, buildCompletionResponse(friendlyMsg, parsed.model), {
                "X-Comos-Ai-Shim": "error-softened-" + rawResp.status,
              });
              return;
            }

            const rawHeaders = {};
            for (const [k, v] of rawResp.headers.entries()) {
              if (k.toLowerCase() === "transfer-encoding") continue;
              rawHeaders[k] = v;
            }
            rawHeaders["content-length"] = String(adapted.buffer.length);
            rawHeaders["X-Comos-Ai-Shim"] = adapted.changed ? "raw-llm-compat" : "raw-llm";

            // ── Emit agent_complete or agent_tool_call depending on response ──
            try {
              const _respObj = JSON.parse(adapted.buffer.toString("utf8"));
              const _respMsg = _respObj?.choices?.[0]?.message;
              const _hasTCResp = _respMsg?.tool_calls || _respMsg?.function_call;
              if (_hasTCResp) {
                const _tcList = _respMsg.tool_calls || [{ function: _respMsg.function_call }];
                const stepNum = (agentStepCounters.get(sessionKey) || 0) + 1;
                agentStepCounters.set(sessionKey, stepNum);
                for (const tc of _tcList) {
                  const tn = tc.function?.name || "unknown";
                  const label = friendlyToolLabel(tn);
                  if (label) emitAgentEvent("agent_tool_call", { message: `Step ${stepNum}: ${label}`, tool: tn, step: stepNum });
                }
                // Show what tool COMOS will execute next
                const _nextToolName = _tcList[0]?.function?.name || "";
                const _nextLabel = friendlyToolLabel(_nextToolName);
                const _waitMsg = _nextLabel ? `Executing: ${_nextLabel}...` : "Waiting for COMOS to execute tool...";
                emitAgentEvent("agent_thinking", { message: _waitMsg, substate: "continuation" });
              } else {
                emitAgentEvent("agent_complete", { message: "Response ready" });
                agentStepCounters.delete(sessionKey);
              }
            } catch { /* ignore */ }

            res.writeHead(rawResp.status, rawHeaders);
            res.end(adapted.buffer);
            log(
              `raw_llm_response session=${sessionKey} status=${rawResp.status} ` +
              `compat=${adapted.changed ? "on" : "off"}`
            );
          } catch (rawErr) {
            log(`raw_llm_error session=${sessionKey} ${rawErr.message}`);
            sendJsonResponse(res, 200, buildCompletionResponse(
              "⚠️ Error connecting to LLM gateway. Please verify the service is running.",
              parsed.model
            ), { "X-Comos-Ai-Shim": "gateway-connection-error" });
          }
          return;
        }
      } catch (parseErr) {
        log(`completions_parse_error ${parseErr && parseErr.message} stack=${parseErr && parseErr.stack}`);
        sendJsonResponse(res, 200, buildCompletionResponse(
          `⚠️ Internal shim error: ${parseErr && parseErr.message}. Please try again.`,
          defaultModel
        ), { "X-Comos-Ai-Shim": "completions-parse-error-softened" });
        return;  // NEVER fall through to native API
      }
    }

    // ── POST /evaluation — Route tool-result continuation through gateway ──
    if (method === "POST" && basePath.startsWith("/api/ai/v1/completions/evaluation")) {
      try {
        const text = bodyBuffer.toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        logRequest(urlPath, parsed);

        if (!parsed.model || String(parsed.model).trim().length === 0) {
          parsed.model = defaultModel;
        }

        // ── Intercept draw_single_object tool results for interactive drawing ──
        const evalMessages = parsed.messages || parsed.Messages || [];
        const evalSessionKey = parsed.sessionId || parsed.SessionId || "__eval__";
        const drawSession = drawingSessions.get(evalSessionKey);
        const evalTools = parsed.tools || parsed.Tools || [];
        const importToolRegistered = hasImportToolRegistered(evalTools);
        const hasToolResult = hasAnyToolResultMessage(evalMessages);

        // ── Fast navigation chaining — DISABLED ──
        // objects_with_name doesn't reliably find objects; letting LLM use
        // navigate_to_comos_object_by_name directly (timeout patched to 120s).

        // ── Intercept import_equipment_from_excel results to avoid slow eval round-trip ──
        if (
          (hasImportToolInMessages(evalMessages) || (importToolRegistered && hasToolResult && !drawSession)) &&
          !(drawSession && (drawSession.step === "drawing" || drawSession.step === "connecting"))
        ) {
          const result = parseLatestToolResult(evalMessages);
          let importMsg = "✅ Importação concluída com sucesso.";

          if (result && (result.success === false || result.error)) {
            importMsg = `⚠️ A importação terminou com aviso: ${result.error || "falha na validação do resultado"}.`;
          } else if (result && (result.success === true || typeof result.success === "undefined")) {
            const createdCount = parseImportCount(result);
            if (typeof createdCount === "number") {
              importMsg = `✅ Importação concluída com sucesso. Objetos processados: **${createdCount}**.`;
            }
          }

          sendJsonResponse(
            res,
            200,
            buildCompletionResponse(importMsg, parsed.model),
            { "X-Comos-Ai-Shim": "import-eval-shortcircuit" },
          );
          log(`import_eval_shortcircuit session=${evalSessionKey}`);
          return;
        }

        if (drawSession && drawSession.step === "drawing") {
          const result = parseLatestToolResult(evalMessages);
          let resultMsg = "";
          if (result && result.success) {
            resultMsg = `✅ **${result.tag || "Object"}** drawn at (${result.x || "?"}, ${result.y || "?"})` +
              (result.alreadyDrawn ? " _(already existed, description updated)_" : "") + "\n\n";
          } else if (result) {
            resultMsg = `⚠️ Drawing failed: ${result.error || "Unknown error"}\n\n`;
          }

          // Transition back to ask_component
          drawSession.step = "ask_component";
          drawSession.pendingComponent = null;
          drawSession.pendingMatch = null;
          drawSession.storedAt = Date.now();

          const count = drawSession.drawnObjects ? drawSession.drawnObjects.length : 0;
          const nextMsg = resultMsg +
            `**${count} object(s) drawn so far.** Describe the next component, or type **"done"** to finish.`;

          sendJsonResponse(res, 200, buildCompletionResponse(nextMsg, parsed.model), { "X-Comos-Ai-Shim": "drawing-eval-result" });
          log(`drawing_eval_result session=${evalSessionKey} count=${count}`);
          return;
        }

        // ── Intercept connect_objects tool results for interactive drawing ──
        if (drawSession && drawSession.step === "connecting") {
          const result = parseLatestConnectToolResult(evalMessages, drawSession.pendingConnection || null);
          let resultMsg = "";

          // NOTE: Auto-retry removed — COMOS client can only handle ONE round
          // of tool calling. Retry logic is now inside the DLL ConnectObjects
          // method (Close+Open report cycle to refresh COM DevObjects).

          if (result && result.connected) {
            const connectedSource = result.sourceTag || drawSession.pendingConnection?.sourceTag || "?";
            const connectedTarget = result.targetTag || drawSession.pendingConnection?.targetTag || "?";

            if (!drawSession.connections) drawSession.connections = [];
            drawSession.connections.push({
              sourceTag: connectedSource,
              targetTag: connectedTarget,
              sourceSFN: drawSession.pendingConnection?.sourceSFN || "",
              targetSFN: drawSession.pendingConnection?.targetSFN || "",
            });

            resultMsg = `🔗 **Connected:** ${connectedSource} → ${connectedTarget}\n\n`;
          } else if (result) {
            resultMsg = `⚠️ Connection failed: ${result.error || "Unknown error"}\n\n`;
          } else {
            const p = drawSession.pendingConnection;
            if (p) {
              resultMsg = `⚠️ Connection not confirmed for ${p.sourceTag} → ${p.targetTag}.\n\n`;
            }
          }

          drawSession.step = "ask_component";
          drawSession.pendingConnection = null;
          drawSession.storedAt = Date.now();

          const connCount = drawSession.connections ? drawSession.connections.length : 0;
          const objCount = drawSession.drawnObjects ? drawSession.drawnObjects.length : 0;
          const nextMsg = resultMsg +
            `**${objCount} object(s), ${connCount} connection(s) so far.**\n\n` +
            `What next?\n` +
            `- Describe a component: **description, tag, X, Y**\n` +
            `- Connect objects: **conectar X em Y** / **connect X to Y**\n` +
            `- Type **"done"** to finish.`;

          sendJsonResponse(res, 200, buildCompletionResponse(nextMsg, parsed.model), { "X-Comos-Ai-Shim": "drawing-connect-eval-result" });
          log(`drawing_connect_eval session=${evalSessionKey} connCount=${connCount}`);
          return;
        }

        // The COMOS client sends ToolsEvaluationRequest with messages that include
        // the assistant's function_call and the function result.
        // We need to convert this to OpenAI format and send to the gateway.
        const messages = parsed.messages || parsed.Messages || [];

        // Use shared normalizer (same one used for /completions)
        const normalizedMessages = normalizeMessagesForOpenAI(messages);

        // Re-read tools from the parsed request (COMOS sends them in evaluation too)
        const tools = parsed.tools || parsed.Tools || [];
        const hasTools = tools.length > 0;

        // Inject COMOS system prompt
        if (hasTools) {
          const toolNames = tools
            .map(t => t.function?.name || t.Function?.Name || "")
            .filter(Boolean);
          const toolHint = toolNames.length
            ? `\nYour available COMOS tools are: ${toolNames.join(", ")}.`
            : "";
          const sysContent = COMOS_SYSTEM_PROMPT + toolHint;
          const firstSysIdx = normalizedMessages.findIndex(m => (m.role || "").toLowerCase() === "system");
          if (firstSysIdx >= 0) {
            normalizedMessages[firstSysIdx] = { role: "system", content: sysContent };
          } else {
            normalizedMessages.unshift({ role: "system", content: sysContent });
          }
        }

        const gatewayPayload = {
          model: parsed.model,
          messages: normalizedMessages,
          tools: hasTools ? tools : undefined,
          temperature: parsed.temperature ?? 0.7,
          seed: parsed.seed,
        };

        const rawUrl = `${gatewayBase}/v1/chat/completions/raw`;
        const rawBody = JSON.stringify(gatewayPayload);
        const sessionKey = parsed.sessionId || parsed.SessionId || "__eval__";
        log(`eval_proxy_raw_llm session=${sessionKey} tools=${hasTools ? tools.length : 0} url=${rawUrl}`);

        // DEBUG: Log every normalized message so we can see exactly what goes to OpenAI
        for (let mi = 0; mi < normalizedMessages.length; mi++) {
          const m = normalizedMessages[mi];
          const mRole = m.role || "?";
          const hasTC = m.tool_calls ? `tool_calls[${m.tool_calls.length}] id=${m.tool_calls[0]?.id}` : "";
          const hasFC = m.function_call ? `function_call=${m.function_call.name}` : "";
          const hasTCID = m.tool_call_id ? `tool_call_id=${m.tool_call_id}` : "";
          log(`eval_msg[${mi}] role=${mRole} ${hasTC} ${hasFC} ${hasTCID} content=${(m.content || "").substring(0, 80)}`);
        }

        // ── Emit agent_thinking for eval continuation ──
        emitAgentEvent("agent_thinking", { message: "Analyzing tool results...", substate: "eval_continuation" });

        const { response: rawResp, timedOut } = await fetchWithSafetyTimeout(rawUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawBody,
        }, `eval_session=${sessionKey}`);

        // ── 95s safety timeout for eval ──
        if (timedOut) {
          emitAgentEvent("agent_timeout", { message: "Agent timed out during evaluation — synthesizing results..." });
          const safetyMsg =
            "⏳ Engineering copilot está processando sua solicitação. " +
            "Envie uma nova mensagem para continuar.";
          sendJsonResponse(res, 200, buildCompletionResponse(safetyMsg, parsed.model || defaultModel), {
            "X-Comos-Ai-Shim": "eval-safety-timeout-95s",
          });
          log(`eval_safety_timeout_95s session=${sessionKey}`);
          agentStepCounters.delete(sessionKey);
          return;
        }

        const rawBuffer = Buffer.from(await rawResp.arrayBuffer());

        // Apply the same COMOS compat adaptation (tool_calls → function_call, finish_reason)
        const adapted = adaptRawCompletionForComos(rawBuffer, gatewayPayload, sessionKey);

        // Ensure the COMOS .NET client can parse the response:
        // The native AI API returns { choices: [{ message: { content, role, toolCalls } }] }
        // We add a PascalCase `toolCalls` alias so that the .NET deserializer finds it.
        try {
          const evalParsed = JSON.parse(adapted.buffer.toString("utf8"));
          if (evalParsed && Array.isArray(evalParsed.choices)) {
            for (const choice of evalParsed.choices) {
              if (choice && choice.message) {
                // Add PascalCase alias for .NET compatibility
                if (choice.message.tool_calls) {
                  choice.message.toolCalls = choice.message.tool_calls;
                } else if (!("toolCalls" in choice.message)) {
                  choice.message.toolCalls = null;
                }
                // Also add PascalCase Role/Content aliases
                if (!("Role" in choice.message)) choice.message.Role = choice.message.role;
                if (!("Content" in choice.message)) choice.message.Content = choice.message.content;
              }
            }
            adapted.buffer = Buffer.from(JSON.stringify(evalParsed), "utf8");
          }
        } catch { /* ignore */ }

        // ── Soften non-200 eval responses (same rationale as completions) ──
        if (rawResp.status !== 200) {
          let errDetail = "";
          try { errDetail = adapted.buffer.toString("utf8").substring(0, 300); } catch {}
          const friendlyMsg =
            "⚠️ The AI service returned an error (HTTP " + rawResp.status + "). " +
            "Please try again or start a new conversation.";
          log(
            `eval_error_softened session=${sessionKey} status=${rawResp.status} ` +
            `detail=${errDetail.substring(0, 200)}`
          );
          sendJsonResponse(res, 200, buildCompletionResponse(friendlyMsg, parsed.model || defaultModel), {
            "X-Comos-Ai-Shim": "eval-error-softened-" + rawResp.status,
          });
          return;
        }

        const rawHeaders = {};
        for (const [k, v] of rawResp.headers.entries()) {
          if (k.toLowerCase() === "transfer-encoding") continue;
          rawHeaders[k] = v;
        }
        rawHeaders["content-length"] = String(adapted.buffer.length);
        rawHeaders["X-Comos-Ai-Shim"] = adapted.changed ? "eval-compat" : "eval-raw";

        // ── Emit agent_complete or agent_tool_call for eval response ──
        try {
          const _evalRespObj = JSON.parse(adapted.buffer.toString("utf8"));
          const _evalRespMsg = _evalRespObj?.choices?.[0]?.message;
          const _evalHasTC = _evalRespMsg?.tool_calls || _evalRespMsg?.toolCalls || _evalRespMsg?.function_call;
          if (_evalHasTC) {
            const _tcList = _evalRespMsg.tool_calls || _evalRespMsg.toolCalls || [{ function: _evalRespMsg.function_call }];
            const stepNum = (agentStepCounters.get(sessionKey) || 0) + 1;
            agentStepCounters.set(sessionKey, stepNum);
            for (const tc of (_tcList || [])) {
              const tn = tc?.function?.name || tc?.Function?.Name || "unknown";
              const label = friendlyToolLabel(tn);
              if (label) emitAgentEvent("agent_tool_call", { message: `Step ${stepNum}: ${label}`, tool: tn, step: stepNum });
            }
            const _nextToolName = (_tcList[0])?.function?.name || (_tcList[0])?.Function?.Name || "";
            const _nextLabel = friendlyToolLabel(_nextToolName);
            const _waitMsg = _nextLabel ? `Executing: ${_nextLabel}...` : "Waiting for COMOS to execute tool...";
            emitAgentEvent("agent_thinking", { message: _waitMsg, substate: "continuation" });
          } else {
            emitAgentEvent("agent_complete", { message: "Response ready" });
            agentStepCounters.delete(sessionKey);
          }
        } catch { /* ignore */ }

        res.writeHead(rawResp.status, rawHeaders);
        res.end(adapted.buffer);
        log(`eval_response session=${sessionKey} status=${rawResp.status} compat=${adapted.changed}`);
        return;
      } catch (evalErr) {
        log(`eval_error ${evalErr && evalErr.message} stack=${evalErr && evalErr.stack}`);

        const evalMsg = String((evalErr && evalErr.message) || "");
        if (/TIMEOUT_ERROR|Tool processing iteration|per-iteration timeout/i.test(evalMsg)) {
          sendJsonResponse(res, 200, buildCompletionResponse(
            "✅ A ação foi executada, mas a confirmação automática excedeu o tempo limite. Se necessário, envie uma nova mensagem para continuar.",
            defaultModel
          ), { "X-Comos-Ai-Shim": "eval-timeout-softened" });
          return;
        }

        sendJsonResponse(res, 200, buildCompletionResponse(
          `⚠️ Internal error during evaluation: ${evalErr && evalErr.message}. Please try again.`,
          defaultModel
        ), { "X-Comos-Ai-Shim": "eval-internal-error-softened" });
        return;  // NEVER fall through to native API
      }
    }

    // ── POST /api/ai/v1/transcribe — Speech-to-text via Azure Whisper ──
    // Accepts audio as base64 JSON or raw multipart, forwards to Azure
    // OpenAI Whisper deployment, returns { text }.
    if (method === "POST" && basePath === "/api/ai/v1/transcribe") {
      try {
        const WHISPER_ENDPOINT = "https://openai-aittack-msa-001070-swedencentral-aifordipaswidser-00.cognitiveservices.azure.com";
        const WHISPER_DEPLOYMENT = "whisper";
        const WHISPER_API_VERSION = "2024-06-01";
        const WHISPER_API_KEY = "a0c464250e2c48ea9fd07a455e807c58";

        let audioBuffer;
        let audioFilename = "audio.webm";

        const contentType = (req.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("application/json")) {
          // JSON body: { audio: "<base64>", filename?: "...", language?: "..." }
          const text = bodyBuffer.toString("utf8");
          const parsed = text ? JSON.parse(text) : {};
          if (!parsed.audio) {
            return sendJsonResponse(res, 400, { error: "Missing 'audio' base64 field" });
          }
          audioBuffer = Buffer.from(parsed.audio, "base64");
          audioFilename = parsed.filename || audioFilename;
        } else {
          // Raw binary body (audio data sent directly)
          audioBuffer = bodyBuffer;
          audioFilename = "audio.webm";
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          return sendJsonResponse(res, 400, { error: "Empty audio data" });
        }

        log(`transcribe audio_size=${audioBuffer.length} filename=${audioFilename}`);

        // Build multipart/form-data for Azure Whisper API
        const boundary = "----WhisperBoundary" + Date.now();
        const parts = [];

        // file part
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${audioFilename}"\r\n` +
          `Content-Type: audio/webm\r\n\r\n`
        ));
        parts.push(audioBuffer);
        parts.push(Buffer.from("\r\n"));

        // response_format part
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
          `json\r\n`
        ));

        // closing boundary
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const multipartBody = Buffer.concat(parts);

        // Use /audio/transcriptions (preserves source language)
        const whisperUrl = `${WHISPER_ENDPOINT}/openai/deployments/${WHISPER_DEPLOYMENT}/audio/transcriptions?api-version=${WHISPER_API_VERSION}`;

        log(`transcribe_request url=${whisperUrl}`);

        const whisperResp = await fetch(whisperUrl, {
          method: "POST",
          headers: {
            "api-key": WHISPER_API_KEY,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
        });

        const respText = await whisperResp.text();
        log(`transcribe_response status=${whisperResp.status} body=${respText.substring(0, 300)}`);

        if (!whisperResp.ok) {
          return sendJsonResponse(res, whisperResp.status, {
            error: `Whisper API error: ${respText}`,
          });
        }

        let result;
        try { result = JSON.parse(respText); } catch (_) {
          result = { text: respText };
        }

        return sendJsonResponse(res, 200, { text: result.text || "" });
      } catch (err) {
        log(`transcribe_error ${err.message}`);
        return sendJsonResponse(res, 500, { error: `Transcription failed: ${err.message}` });
      }
    }

    // ── POST /api/ai/v1/mic/start — Start server-side microphone recording ──
    // CefSharp's localfolder:// scheme is NOT a secure context, so
    // navigator.mediaDevices.getUserMedia() is unavailable in the browser.
    // Instead we record audio on the server side using Windows MCI (winmm.dll)
    // via a PowerShell child process.
    if (method === "POST" && basePath === "/api/ai/v1/mic/start") {
      try {
        const { spawn } = require("node:child_process");

        // Kill any existing recording
        if (global.__micProc) {
          log("mic_start killing_previous_recording");
          try { global.__micProc.stdin.write("STOP\n"); } catch (_) {}
          try { global.__micProc.kill(); } catch (_) {}
          global.__micProc = null;
        }
        if (global.__micTimer) {
          clearTimeout(global.__micTimer);
          global.__micTimer = null;
        }

        const wavFile = path.join(os.tmpdir(), `comos_mic_${Date.now()}.wav`);
        global.__micFile = wavFile;

        // Write the PowerShell recorder script (once)
        const psScript = path.join(os.tmpdir(), "comos_mic_record.ps1");
        if (!fs.existsSync(psScript)) {
          fs.writeFileSync(psScript, [
            "param([string]$OutputFile)",
            "Add-Type -TypeDefinition @'",
            "using System;",
            "using System.Runtime.InteropServices;",
            "using System.Text;",
            "public class MciAudio {",
            "    [DllImport(\"winmm.dll\", CharSet=CharSet.Unicode)]",
            "    public static extern int mciSendString(string cmd, StringBuilder ret, int retLen, IntPtr hwnd);",
            "}",
            "'@",
            "$sb = New-Object System.Text.StringBuilder 256",
            "[void][MciAudio]::mciSendString('close capture', $sb, 256, [IntPtr]::Zero)",
            "$r = [MciAudio]::mciSendString('open new Type waveaudio Alias capture', $sb, 256, [IntPtr]::Zero)",
            "if ($r -ne 0) { Write-Output \"ERROR_OPEN=$r\"; exit 1 }",
            "$r = [MciAudio]::mciSendString('record capture', $sb, 256, [IntPtr]::Zero)",
            "if ($r -ne 0) { Write-Output \"ERROR_RECORD=$r\"; exit 1 }",
            "Write-Output 'RECORDING'",
            "$null = [Console]::In.ReadLine()",
            "[void][MciAudio]::mciSendString('stop capture', $sb, 256, [IntPtr]::Zero)",
            "[void][MciAudio]::mciSendString(\"save capture `\"$OutputFile`\"\", $sb, 256, [IntPtr]::Zero)",
            "[void][MciAudio]::mciSendString('close capture', $sb, 256, [IntPtr]::Zero)",
            "Write-Output 'SAVED'",
          ].join("\r\n"), "utf8");
          log(`mic_start wrote_ps_script ${psScript}`);
        }

        const proc = spawn("powershell.exe", [
          "-NoProfile", "-ExecutionPolicy", "Bypass",
          "-File", psScript,
          "-OutputFile", wavFile,
        ], { stdio: ["pipe", "pipe", "pipe"] });

        global.__micProc = proc;
        let started = false;
        let startError = null;

        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (!started) { startError = "Recording start timed out (5s)"; resolve(); }
          }, 5000);

          proc.stdout.on("data", (chunk) => {
            const line = chunk.toString().trim();
            log(`mic_ps_stdout ${line}`);
            if (line === "RECORDING" && !started) {
              started = true;
              clearTimeout(timeout);
              resolve();
            }
          });

          proc.stderr.on("data", (chunk) => {
            const msg = chunk.toString().trim();
            log(`mic_ps_stderr ${msg}`);
            if (!started) { startError = msg; }
          });

          proc.on("error", (err) => {
            log(`mic_ps_error ${err.message}`);
            startError = err.message;
            clearTimeout(timeout);
            resolve();
          });

          proc.on("exit", (code) => {
            if (!started) {
              startError = startError || `PowerShell exited with code ${code}`;
              clearTimeout(timeout);
              resolve();
            }
          });
        });

        if (startError) {
          global.__micProc = null;
          log(`mic_start_failed ${startError}`);
          return sendJsonResponse(res, 500, { error: `Microphone error: ${startError}` });
        }

        // Safety timeout: auto-stop after 120s
        global.__micTimer = setTimeout(() => {
          if (global.__micProc) {
            log("mic_auto_stop after 120s");
            try { global.__micProc.stdin.write("STOP\n"); } catch (_) {}
            setTimeout(() => {
              try { global.__micProc.kill(); } catch (_) {}
              global.__micProc = null;
            }, 3000);
          }
        }, 120000);

        log(`mic_start_ok file=${wavFile} pid=${proc.pid}`);
        return sendJsonResponse(res, 200, { status: "recording", file: wavFile });
      } catch (err) {
        log(`mic_start_error ${err.message}`);
        return sendJsonResponse(res, 500, { error: `Mic start failed: ${err.message}` });
      }
    }

    // ── POST /api/ai/v1/mic/stop — Stop recording, transcribe with Whisper ──
    if (method === "POST" && basePath === "/api/ai/v1/mic/stop") {
      try {
        if (global.__micTimer) { clearTimeout(global.__micTimer); global.__micTimer = null; }

        const proc = global.__micProc;
        const wavFile = global.__micFile;
        global.__micProc = null;
        global.__micFile = null;

        if (!proc) {
          return sendJsonResponse(res, 400, { error: "No active recording" });
        }

        // Signal the PS script to stop and save
        log("mic_stop signaling_ps");
        proc.stdin.write("STOP\n");
        proc.stdin.end();

        // Wait for "SAVED" or process exit
        await new Promise((resolve) => {
          const timeout = setTimeout(() => { resolve(); }, 10000);
          let resolved = false;

          proc.stdout.on("data", (chunk) => {
            const line = chunk.toString().trim();
            log(`mic_stop_stdout ${line}`);
            if (line.includes("SAVED") && !resolved) {
              resolved = true; clearTimeout(timeout); resolve();
            }
          });

          proc.on("exit", () => {
            if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
          });
        });

        // Read the WAV file
        if (!wavFile || !fs.existsSync(wavFile)) {
          return sendJsonResponse(res, 500, { error: "WAV file not found after recording" });
        }

        const audioBuffer = fs.readFileSync(wavFile);
        try { fs.unlinkSync(wavFile); } catch (_) {}

        log(`mic_stop wav_size=${audioBuffer.length}`);

        if (audioBuffer.length < 1000) {
          return sendJsonResponse(res, 200, { text: "", error: "Recording too short" });
        }

        // Send to Whisper (same logic as /transcribe)
        const WHISPER_ENDPOINT = "https://openai-aittack-msa-001070-swedencentral-aifordipaswidser-00.cognitiveservices.azure.com";
        const WHISPER_DEPLOYMENT = "whisper";
        const WHISPER_API_VERSION = "2024-06-01";
        const WHISPER_API_KEY = "a0c464250e2c48ea9fd07a455e807c58";

        const boundary = "----WhisperBoundary" + Date.now();
        const parts = [];

        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`
        ));
        parts.push(audioBuffer);
        parts.push(Buffer.from("\r\n"));

        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
          `json\r\n`
        ));

        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const multipartBody = Buffer.concat(parts);
        const whisperUrl = `${WHISPER_ENDPOINT}/openai/deployments/${WHISPER_DEPLOYMENT}/audio/transcriptions?api-version=${WHISPER_API_VERSION}`;

        log(`mic_whisper_request url=${whisperUrl} body_size=${multipartBody.length}`);

        const whisperResp = await fetch(whisperUrl, {
          method: "POST",
          headers: {
            "api-key": WHISPER_API_KEY,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
        });

        const respText = await whisperResp.text();
        log(`mic_whisper_response status=${whisperResp.status} body=${respText.substring(0, 300)}`);

        if (!whisperResp.ok) {
          return sendJsonResponse(res, whisperResp.status, {
            error: `Whisper API error: ${respText}`,
          });
        }

        let result;
        try { result = JSON.parse(respText); } catch (_) { result = { text: respText }; }

        return sendJsonResponse(res, 200, { text: result.text || "" });
      } catch (err) {
        log(`mic_stop_error ${err.message}`);
        return sendJsonResponse(res, 500, { error: `Transcription failed: ${err.message}` });
      }
    }

    // ── POST /api/ai/v1/mic/abort — Cancel recording without transcribing ──
    if (method === "POST" && basePath === "/api/ai/v1/mic/abort") {
      if (global.__micTimer) { clearTimeout(global.__micTimer); global.__micTimer = null; }
      if (global.__micProc) {
        log("mic_abort killing_process");
        try { global.__micProc.stdin.write("STOP\n"); } catch (_) {}
        setTimeout(() => {
          try { global.__micProc.kill(); } catch (_) {}
          global.__micProc = null;
        }, 1000);
      }
      if (global.__micFile) {
        try { fs.unlinkSync(global.__micFile); } catch (_) {}
        global.__micFile = null;
      }
      return sendJsonResponse(res, 200, { status: "aborted" });
    }

    // ── POST /api/ai/v1/attach-pdf — Pre-load PDF for next message ─────
    // Called directly from the chat UI (CefSharp cannot forward attachments).
    // Stores the PDF in pendingPdfs so that the next /completions request
    // (sent through normal CefSharp → C# path) finds and processes it.
    if (method === "POST" && basePath === "/api/ai/v1/attach-pdf") {
      try {
        const text = bodyBuffer.toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        logRequest(urlPath, parsed);

        const att = parsed.attachment || {};
        const filename = att.fileName || att.filename || parsed.fileName || parsed.filename || "upload.pdf";
        const pdfBase64 = att.contentBase64 || att.content_base64 || parsed.contentBase64 || parsed.content_base64 || "";
        const userMessage = parsed.message || parsed.content || "";
        // Use __default__ so the next CefSharp completions request finds it
        const sessionKey = "__default__";

        if (!pdfBase64) {
          sendJsonResponse(res, 400, { error: "Missing contentBase64 in attachment" });
          return;
        }

        const pdfAttachment = {
          fileName: filename,
          mimeType: att.mimeType || "application/pdf",
          sizeBytes: att.sizeBytes || 0,
          contentBase64: pdfBase64,
        };

        pendingPdfs.set(sessionKey, {
          pdfAttachment,
          filename,
          userMessage,
          storedAt: Date.now(),
        });

        log(`attach_pdf session=${sessionKey} file=${filename} base64_len=${pdfBase64.length} msg=${userMessage.substring(0, 60)}`);

        sendJsonResponse(res, 200, {
          status: "attached",
          filename,
          message: "PDF stored. Send your next message to proceed.",
        });
        return;
      } catch (err) {
        log(`attach_pdf_error ${err.message}`);
        sendJsonResponse(res, 500, { error: err.message });
        return;
      }
    }

    // ── POST /api/ai/v1/upload-pdf — Direct PDF upload fallback ─────────
    if (method === "POST" && basePath === "/api/ai/v1/upload-pdf") {
      try {
        const text = bodyBuffer.toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        logRequest(urlPath, parsed);

        const filename = parsed.fileName || parsed.filename || "upload.pdf";
        const pdfBase64 = parsed.contentBase64 || parsed.content_base64 || parsed.data || "";
        const diagramType = parsed.diagramType || parsed.diagram_type || "pid";
        const sessionId = parsed.sessionId || parsed.session_id || "__upload__";

        if (!pdfBase64) {
          sendJsonResponse(res, 400, { error: "Missing contentBase64 field" });
          return;
        }

        log(`upload_pdf file=${filename} type=${diagramType} len=${pdfBase64.length}`);

        const pdfAttachment = { fileName: filename, mimeType: "application/pdf", contentBase64: pdfBase64 };
        startBackgroundDigitization(sessionId, pdfAttachment, diagramType, `Upload: ${filename}`);

        const dtLabel = diagramType === "electrical" ? "Electrical Diagram" : "P&ID";
        sendJsonResponse(res, 200,
          buildCompletionResponse(
            `⏳ **Starting ${dtLabel} analysis...**\n\n` +
            `File **${filename}** has been sent for digitization.\n` +
            `Analysis may take **1 to 5 minutes**.\n\n` +
            `When ready, send **any message** (e.g. \'ok\') to receive the result.`,
            defaultModel
          ),
          {
            "X-Comos-Ai-Shim": "upload-digitization",
            "Access-Control-Allow-Origin": "*",
          },
        );
        return;
      } catch (err) {
        log(`upload_pdf_error ${err.message}`);
        sendJsonResponse(res, 500, { error: err.message });
        return;
      }
    }

    // ── GET /api/ai/v1/shim-status — Health/debug endpoint ──────────────
    if (method === "GET" && basePath === "/api/ai/v1/shim-status") {
      const activeJobs = [];
      for (const [k, v] of activeDigitizations) {
        activeJobs.push({ session: k, file: v.filename, type: v.diagramType, status: v.status, elapsed: formatElapsed(v.startedAt) });
      }
      const status = {
        status: "ok",
        uptime: process.uptime(),
        pendingSessions: pendingPdfs.size,
        activeDigitizations: activeJobs,
        ports: { shim: listenPort, aiApi: targetBase, gateway: gatewayBase },
        logFile,
        reqLogFile,
      };
      sendJsonResponse(res, 200, status);
      return;
    }

    // ── GET /api/ai/v1/agent-events — SSE stream for agent status ──────
    if (method === "GET" && basePath === "/api/ai/v1/agent-events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("event: connected\ndata: {\"status\":\"ok\"}\n\n");
      agentSSEClients.add(res);
      log(`agent_sse_client_connected total=${agentSSEClients.size}`);
      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { clearInterval(keepAlive); agentSSEClients.delete(res); }
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        agentSSEClients.delete(res);
        log(`agent_sse_client_disconnected total=${agentSSEClients.size}`);
      });
      return;
    }

    // ── POST /generate-title — Route through gateway instead of native API ──
    if (method === "POST" && basePath === "/api/ai/v1/completions/generate-title") {
      try {
        const text = bodyBuffer.toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        logRequest(basePath, parsed);

        if (!parsed.model || String(parsed.model).trim().length === 0) {
          parsed.model = defaultModel;
        }

        const messages = parsed.messages || parsed.Messages || [];
        const cleanMessages = normalizeMessagesForOpenAI(messages);
        parsed.messages = cleanMessages;
        delete parsed.Messages;

        // Route to gateway for proper title generation
        const rawUrl = `${gatewayBase}/v1/chat/completions/raw`;
        const rawBody = JSON.stringify(parsed);
        log(`generate_title_proxy session=${parsed.sessionId || "__default__"} msgs=${cleanMessages.length}`);

        const rawResp = await fetch(rawUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawBody,
        });
        const rawBuffer = Buffer.from(await rawResp.arrayBuffer());

        // Add PascalCase aliases for COMOS .NET
        try {
          const titleParsed = JSON.parse(rawBuffer.toString("utf8"));
          if (titleParsed && titleParsed.choices) {
            for (const choice of titleParsed.choices) {
              if (choice.message) {
                if (!choice.message.Role) choice.message.Role = choice.message.role;
                if (!choice.message.Content) choice.message.Content = choice.message.content;
              }
            }
          }
          const outBuffer = Buffer.from(JSON.stringify(titleParsed), "utf8");
          const rawHeaders = {};
          for (const [k, v] of rawResp.headers.entries()) {
            if (k.toLowerCase() === "transfer-encoding") continue;
            rawHeaders[k] = v;
          }
          rawHeaders["content-length"] = String(outBuffer.length);
          rawHeaders["X-Comos-Ai-Shim"] = "generate-title";
          res.writeHead(rawResp.status, rawHeaders);
          res.end(outBuffer);
          log(`generate_title_response status=${rawResp.status}`);
          return;
        } catch {
          // If parsing fails, return the raw buffer as-is
          res.writeHead(rawResp.status);
          res.end(rawBuffer);
          log(`generate_title_response_raw status=${rawResp.status}`);
          return;
        }
      } catch (titleErr) {
        log(`generate_title_error ${titleErr && titleErr.message}`);
        sendJsonResponse(res, 200, buildCompletionResponse("COMOS AI Chat", defaultModel));
        return;
      }
    }

    // ── Default: proxy to AI API ────────────────────────────────────────
    log(`proxy_default ${method} ${urlPath}`);
    const forwardUrl = `${targetBase}${urlPath}`;
    const headers = sanitizeHeaders(req.headers);
    if (bodyBuffer.length > 0 && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(forwardUrl, {
      method,
      headers,
      body: bodyBuffer.length > 0 ? bodyBuffer : undefined,
    });

    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    for (const [k, v] of response.headers.entries()) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      responseHeaders[k] = v;
    }

    res.writeHead(response.status, responseHeaders);
    res.end(responseBuffer);
    const respPreview = responseBuffer.length < 300 ? responseBuffer.toString("utf8").substring(0, 200) : `[${responseBuffer.length} bytes]`;
    log(`proxy_default_response ${method} ${urlPath} => ${response.status} body=${respPreview}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`shim_error: ${message}`);
    log(`error ${method} ${urlPath} => ${message}`);
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  loadDigitizationState();
  loadAnalysisCache();
  log(`shim_started port=${listenPort} target=${targetBase} gateway=${gatewayBase} model=${defaultModel}`);
  console.log(`COMOS AI Shim listening on http://127.0.0.1:${listenPort}`);
  console.log(`  AI API target:  ${targetBase}`);
  console.log(`  Gateway target: ${gatewayBase}`);
  console.log(`  Default model:  ${defaultModel}`);
  console.log(`  Log file:       ${logFile}`);
  console.log(`  Request log:    ${reqLogFile}`);
  console.log(`  State file:     ${stateFile}`);
});

server.on("error", (err) => {
  const message = err && err.message ? err.message : String(err);
  if (err && err.code === "EADDRINUSE") {
    const friendly = `Port ${listenPort} is already in use (EADDRINUSE). Another ai-api-shim instance is already running. ` +
      `This is expected if you started the shim earlier: finishing a chat request does not stop the shim server process.`;
    console.error(`[SHIM] server_error: ${friendly}`);
    log(`server_error ${friendly} raw=${message}`);
  } else {
    console.error(`[SHIM] server_error: ${message}`);
    log(`server_error ${message}`);
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  log("shim_stopped SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("shim_stopped SIGTERM");
  process.exit(0);
});
