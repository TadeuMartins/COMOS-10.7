#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// COMOS Power Automate Bridge + MCP Server
//
//  This server does two things:
//
//  1. MCP Server (port 3100, path /sse + /messages)
//     VS Code GitHub Copilot connects here as a tool provider.
//     Tools available to Copilot:
//       • list_pa_requests          — show what Power Automate has requested
//       • fulfill_pa_request        — send COMOS attribute data back to PA
//       • send_to_power_automate    — push data directly to a fixed PA flow URL
//       • get_bridge_queue          — inspect the shim's internal bridge queue
//
//  2. Power Automate Webhook Receiver (POST /pa/trigger)
//     Power Automate calls this endpoint (via ngrok/Cloudflare tunnel) to request
//     COMOS data.  Requests are stored locally.  PA polls GET /pa/status/:id for
//     the result.
//
//  Flow (reverse — PA initiates):
//    PA HTTP trigger → POST /pa/trigger  → bridge stores request (id returned)
//    Copilot in VS Code → `list_pa_requests` tool → user sees what's needed
//    User reads attributes in COMOS → returns to Copilot
//    Copilot → `fulfill_pa_request(id, data)` → bridge POSTs to PA callback URL
//    PA sends approval email to customer
//
//  Flow (forward — Copilot initiates):
//    User tells Copilot: "send P-101 data to PA for approval"
//    Copilot → `send_to_power_automate(paUrl, objectTag, attributes, notes)`
//    Bridge POSTs to PA HTTP trigger URL → PA sends approval email
//
//  Prerequisites:
//    • Node.js 18+
//    • Shim running on localhost:56401 (for get_bridge_queue tool)
//    • For PA to reach this server: ngrok http 3100
//    • Set POWER_AUTOMATE_DEFAULT_URL env var for the default PA flow URL
//
//  Start:   node comos-pa-bridge.js [--port 3100] [--shim-port 56401]
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const http    = require("node:http");
const https   = require("node:https");
const fs      = require("node:fs");
const path    = require("node:path");
const os      = require("node:os");
const crypto  = require("node:crypto");

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return (idx >= 0 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : fallback;
}

const PORT       = Number(getArg("port", "3100"));
const SHIM_PORT  = Number(getArg("shim-port", "56401"));
const PA_DEFAULT = process.env.POWER_AUTOMATE_DEFAULT_URL || "";

// ── Persistence ───────────────────────────────────────────────────────────────
const dataDir   = path.join(os.tmpdir(), "comos_pa_bridge");
const storeFile = path.join(dataDir, "pa_requests.json");
fs.mkdirSync(dataDir, { recursive: true });

/** @type {Map<string, PaRequest>} */
const paRequests = new Map();

/**
 * @typedef {Object} PaRequest
 * @property {string}  id
 * @property {string}  status   "pending" | "fulfilled" | "cancelled"
 * @property {string}  objectTag
 * @property {string[]} attributes
 * @property {string}  [callbackUrl]
 * @property {string}  [notes]
 * @property {string}  created
 * @property {object}  [result]
 * @property {string}  [fulfilledAt]
 */

function saveStore() {
  try {
    const arr = [...paRequests.values()];
    fs.writeFileSync(storeFile, JSON.stringify(arr, null, 2), "utf8");
  } catch { /* ignore */ }
}

function loadStore() {
  try {
    const arr = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    for (const entry of arr) paRequests.set(entry.id, entry);
  } catch { /* first run */ }
}

loadStore();

// ── Helpers ───────────────────────────────────────────────────────────────────
function newId() {
  return `pa_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function json(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST JSON to an external URL (Power Automate trigger).
 * Returns { ok: boolean, status: number, body: string }
 */
async function postJson(url, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const u    = new URL(url);
    const mod  = u.protocol === "https:" ? https : http;
    const req  = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname + u.search,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        ok:     res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body:   Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", e => resolve({ ok: false, status: 0, body: e.message }));
    req.write(data);
    req.end();
  });
}

/**
 * Call the shim bridge queue endpoint.
 */
async function getShimBridgeStatus() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${SHIM_PORT}/bridge/status`, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({ error: "parse_error", raw: Buffer.concat(chunks).toString("utf8") }); }
      });
    });
    req.on("error", e => resolve({ error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

// ── MCP Protocol Implementation ───────────────────────────────────────────────
// Implements Model Context Protocol JSON-RPC 2.0 over HTTP (SSE transport).
// VS Code connects via GET /sse (event stream) and sends requests to POST /messages.
// ─────────────────────────────────────────────────────────────────────────────

const MCP_VERSION = "2024-11-05";
const SERVER_INFO = { name: "comos-pa-bridge", version: "1.0.0" };

/** Active SSE clients: Map<res, { id: string, sessionId: string }> */
const sseClients = new Map();

function sseInit(res, sessionId) {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  // Send the endpoint event (MCP HTTP transport spec)
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
  sseClients.set(res, { id: sessionId, sessionId });
  res.on("close", () => sseClients.delete(res));
}

function sseSend(clientRes, data) {
  try { clientRes.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}

/** MCP tools definition */
const MCP_TOOLS = [
  {
    name: "list_pa_requests",
    description:
      "List all Power Automate data requests that are waiting for COMOS attribute data. " +
      "Returns a list of pending requests including object tags and which attributes are needed.",
    inputSchema: {
      type: "object",
      properties: {
        statusFilter: {
          type: "string",
          enum: ["all", "pending", "fulfilled"],
          description: "Filter by status. Default: 'all'.",
        },
      },
    },
  },
  {
    name: "fulfill_pa_request",
    description:
      "Provide COMOS attribute data for a Power Automate request and trigger the PA callback. " +
      "Call this after reading the attributes from COMOS. PA will then send the approval email.",
    inputSchema: {
      type: "object",
      required: ["requestId", "attributeData"],
      properties: {
        requestId: {
          type: "string",
          description: "The ID of the PA request (from list_pa_requests).",
        },
        attributeData: {
          type: "object",
          description:
            "An object with attribute names as keys and their values as values. " +
            "Example: { \"Shaft Power\": \"75 kW\", \"Flow Rate\": \"100 m3/h\" }",
        },
        notes: {
          type: "string",
          description: "Optional notes or comments to include in the PA submission.",
        },
      },
    },
  },
  {
    name: "send_to_power_automate",
    description:
      "Send COMOS object attribute data directly to a Power Automate HTTP trigger URL. " +
      "Use this when the user says 'send P-101 data to Power Automate for approval' " +
      "or similar. The PA flow will then send the approval email to the customer.",
    inputSchema: {
      type: "object",
      required: ["objectTag", "attributeData"],
      properties: {
        paUrl: {
          type: "string",
          description:
            "The Power Automate HTTP trigger URL. If omitted, uses the POWER_AUTOMATE_DEFAULT_URL " +
            "environment variable.",
        },
        objectTag: {
          type: "string",
          description: "The COMOS object tag or name (e.g. 'P-101').",
        },
        attributeData: {
          type: "object",
          description:
            "Object with attribute names as keys and values as values. " +
            "Example: { \"Shaft Power\": \"75 kW\", \"Rated Flow\": \"100 m3/h\" }",
        },
        submittedBy: {
          type: "string",
          description: "Name or email of the engineer submitting for approval.",
        },
        notes: {
          type: "string",
          description: "Optional notes to include in the approval request.",
        },
      },
    },
  },
  {
    name: "get_bridge_queue",
    description:
      "Inspect the COMOS AI shim's internal bridge command queue. " +
      "Shows any commands that have been queued for injection into a COMOS session.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/** Execute an MCP tool call */
async function executeTool(name, args) {
  // ── list_pa_requests ──────────────────────────────────────────────────────
  if (name === "list_pa_requests") {
    const filter = args.statusFilter || "all";
    const list   = [...paRequests.values()]
      .filter(r => filter === "all" || r.status === filter)
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    if (list.length === 0) {
      return filter === "pending"
        ? "No pending Power Automate data requests."
        : "No PA requests found.";
    }

    const lines = list.map(r => {
      const attrs = (r.attributes || []).join(", ") || "all attributes";
      const since = new Date(r.created).toLocaleString();
      return [
        `**ID**: \`${r.id}\``,
        `**Status**: ${r.status}`,
        `**Object**: ${r.objectTag || "(not specified)"}`,
        `**Attributes needed**: ${attrs}`,
        `**Requested at**: ${since}`,
        r.notes ? `**Notes**: ${r.notes}` : null,
        r.callbackUrl ? `**Callback URL**: ${r.callbackUrl ? "configured ✅" : "none"}` : null,
      ].filter(Boolean).join("  \n");
    });

    return lines.join("\n\n---\n\n");
  }

  // ── fulfill_pa_request ────────────────────────────────────────────────────
  if (name === "fulfill_pa_request") {
    const { requestId, attributeData, notes } = args;
    const entry = paRequests.get(requestId);
    if (!entry) {
      return `❌ Request ID \`${requestId}\` not found. Use \`list_pa_requests\` to see valid IDs.`;
    }
    if (entry.status === "fulfilled") {
      return `⚠️ Request \`${requestId}\` was already fulfilled at ${entry.fulfilledAt}.`;
    }

    const payload = {
      requestId:     entry.id,
      objectTag:     entry.objectTag,
      attributes:    attributeData,
      notes:         notes || entry.notes || "",
      fulfilledAt:   new Date().toISOString(),
      source:        "COMOS AI Bridge",
    };

    let callbackResult = null;
    if (entry.callbackUrl) {
      callbackResult = await postJson(entry.callbackUrl, payload);
    } else if (PA_DEFAULT) {
      callbackResult = await postJson(PA_DEFAULT, payload);
    }

    // Update local store
    entry.status      = "fulfilled";
    entry.result      = attributeData;
    entry.fulfilledAt = payload.fulfilledAt;
    saveStore();

    if (!callbackResult) {
      return (
        `⚠️ Data stored locally but **no callback URL configured**.\n\n` +
        `Set \`POWER_AUTOMATE_DEFAULT_URL\` env var or provide \`callbackUrl\` in the PA trigger.\n\n` +
        `Fulfilled data:\n\`\`\`json\n${JSON.stringify(attributeData, null, 2)}\n\`\`\``
      );
    }

    if (callbackResult.ok) {
      return (
        `✅ **Sent to Power Automate successfully** (HTTP ${callbackResult.status}).\n\n` +
        `Object: **${entry.objectTag}**\n` +
        `Attributes sent:\n\`\`\`json\n${JSON.stringify(attributeData, null, 2)}\n\`\`\``
      );
    }

    return (
      `⚠️ PA returned HTTP ${callbackResult.status}.\n\n` +
      `Response: ${callbackResult.body.slice(0, 300)}\n\n` +
      `Data was saved locally as fulfilled.`
    );
  }

  // ── send_to_power_automate ────────────────────────────────────────────────
  if (name === "send_to_power_automate") {
    const { objectTag, attributeData, paUrl, submittedBy, notes } = args;
    const targetUrl = paUrl || PA_DEFAULT;

    if (!targetUrl) {
      return (
        `❌ No Power Automate URL provided.\n\n` +
        `Either:\n` +
        `- Pass \`paUrl\` in the tool arguments, OR\n` +
        `- Set the \`POWER_AUTOMATE_DEFAULT_URL\` environment variable before starting this server.`
      );
    }

    const payload = {
      objectTag,
      attributes:  attributeData,
      submittedBy: submittedBy || "COMOS AI Bridge",
      notes:       notes || "",
      timestamp:   new Date().toISOString(),
      source:      "COMOS Engineering Assistant",
    };

    const result = await postJson(targetUrl, payload);

    if (result.ok) {
      return (
        `✅ **Approval request sent to Power Automate** (HTTP ${result.status}).\n\n` +
        `Object: **${objectTag}**\n` +
        `Attributes:\n\`\`\`json\n${JSON.stringify(attributeData, null, 2)}\n\`\`\`\n\n` +
        `Power Automate will now send the approval email to the customer.`
      );
    }

    return (
      `❌ Power Automate returned HTTP ${result.status}.\n\n` +
      `URL: \`${targetUrl}\`\n` +
      `Response: ${result.body.slice(0, 400)}\n\n` +
      `Check that the PA HTTP trigger URL is correct and the flow is enabled.`
    );
  }

  // ── get_bridge_queue ──────────────────────────────────────────────────────
  if (name === "get_bridge_queue") {
    const status = await getShimBridgeStatus();
    if (status.error) {
      return `⚠️ Could not reach shim at localhost:${SHIM_PORT}: ${status.error}`;
    }
    if (!status.count) {
      return "Bridge queue is empty — no pending commands in the shim.";
    }
    const lines = status.commands.map(c =>
      `- **\`${c.id}\`** [${c.status}] "${c.command}" — ${c.created}`
    );
    return `**${status.count} command(s) in shim bridge queue:**\n${lines.join("\n")}`;
  }

  return `❌ Unknown tool: \`${name}\``;
}

/** Handle one JSON-RPC 2.0 request, return the response object */
async function handleJsonRpc(rpc, sessionId) {
  const { id, method, params } = rpc;

  const ok = (result) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (method === "initialize") {
    return ok({
      protocolVersion:  MCP_VERSION,
      serverInfo:       SERVER_INFO,
      capabilities:     { tools: {} },
    });
  }

  if (method === "notifications/initialized" || method === "ping") {
    return id != null ? ok({}) : null; // notifications don't need responses
  }

  if (method === "tools/list") {
    return ok({ tools: MCP_TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    const tool = MCP_TOOLS.find(t => t.name === toolName);
    if (!tool) return err(-32601, `Tool not found: ${toolName}`);

    try {
      const text = await executeTool(toolName, toolArgs);
      return ok({ content: [{ type: "text", text: String(text) }] });
    } catch (e) {
      return err(-32603, `Tool execution error: ${e.message}`);
    }
  }

  return err(-32601, `Method not found: ${method}`);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u    = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = u.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (method === "GET" && path_ === "/health") {
    json(res, 200, {
      status:      "ok",
      server:      SERVER_INFO,
      paRequests:  paRequests.size,
      paDefaultUrl: PA_DEFAULT ? "configured" : "not set",
      shimPort:    SHIM_PORT,
    });
    return;
  }

  // ── MCP SSE endpoint (VS Code connects here) ─────────────────────────────
  if (method === "GET" && path_ === "/sse") {
    const sessionId = u.searchParams.get("sessionId") || `s_${Date.now()}`;
    sseInit(res, sessionId);
    return;
  }

  // ── MCP messages endpoint (VS Code sends JSON-RPC here) ──────────────────
  if (method === "POST" && path_ === "/messages") {
    const sessionId = u.searchParams.get("sessionId") || "__default__";
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }

    // Could be a single RPC or a batch
    const isArray = Array.isArray(body);
    const rpcs    = isArray ? body : [body];
    const results = [];

    for (const rpc of rpcs) {
      const resp = await handleJsonRpc(rpc, sessionId);
      if (resp) results.push(resp);
    }

    // Find the SSE client for this session and push result via SSE
    for (const [clientRes, meta] of sseClients) {
      if (meta.sessionId === sessionId) {
        for (const r of results) sseSend(clientRes, r);
      }
    }

    // Also return result in HTTP response body (SSE transport fallback)
    json(res, 200, isArray ? results : (results[0] || {}));
    return;
  }

  // ── Power Automate Webhook: POST /pa/trigger ──────────────────────────────
  // PA calls this (via ngrok tunnel) to request COMOS data for an object.
  // Body: { objectTag, attributes?, callbackUrl?, notes? }
  // Returns: { id, status: "pending" }
  if (method === "POST" && path_ === "/pa/trigger") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "invalid json — expected { objectTag, attributes?, callbackUrl?, notes? }" });
      return;
    }

    if (!body.objectTag) {
      json(res, 400, { error: "objectTag is required" });
      return;
    }

    const id = newId();
    const entry = {
      id,
      status:      "pending",
      objectTag:   String(body.objectTag),
      attributes:  Array.isArray(body.attributes) ? body.attributes : [],
      callbackUrl: body.callbackUrl || null,
      notes:       body.notes || "",
      created:     new Date().toISOString(),
      result:      null,
      fulfilledAt: null,
    };

    paRequests.set(id, entry);
    saveStore();

    console.log(`[PA trigger] id=${id} object=${entry.objectTag} callback=${entry.callbackUrl || "none"}`);
    json(res, 200, {
      id,
      status:  "pending",
      message: "Request queued. Use VS Code Copilot with the COMOS PA Bridge MCP to fulfill this request.",
      pollUrl: `http://YOUR_NGROK_URL/pa/status/${id}`,
    });
    return;
  }

  // ── Status poll: GET /pa/status/:id ──────────────────────────────────────
  if (method === "GET" && /^\/pa\/status\/[^/]+$/.test(path_)) {
    const id    = path_.split("/")[3];
    const entry = paRequests.get(id);
    if (!entry) {
      json(res, 404, { error: "not_found", id });
    } else {
      json(res, 200, entry);
    }
    return;
  }

  // ── List all PA requests: GET /pa/requests ────────────────────────────────
  if (method === "GET" && path_ === "/pa/requests") {
    const list = [...paRequests.values()].sort(
      (a, b) => new Date(b.created) - new Date(a.created)
    );
    json(res, 200, { count: list.length, requests: list });
    return;
  }

  // ── Cancel a PA request: DELETE /pa/requests/:id ─────────────────────────
  if (method === "DELETE" && /^\/pa\/requests\/[^/]+$/.test(path_)) {
    const id    = path_.split("/")[3];
    const entry = paRequests.get(id);
    if (!entry) {
      json(res, 404, { error: "not_found" });
    } else {
      entry.status = "cancelled";
      saveStore();
      json(res, 200, { id, status: "cancelled" });
    }
    return;
  }

  json(res, 404, { error: "not_found", path: path_ });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n┌────────────────────────────────────────────────────────┐`);
  console.log(`│         COMOS Power Automate Bridge + MCP Server       │`);
  console.log(`├────────────────────────────────────────────────────────┤`);
  console.log(`│  MCP (VS Code):   http://localhost:${PORT}/sse              │`);
  console.log(`│  PA Webhook:      POST http://localhost:${PORT}/pa/trigger   │`);
  console.log(`│  PA Status poll:  GET  http://localhost:${PORT}/pa/status/:id│`);
  console.log(`│  Health check:    GET  http://localhost:${PORT}/health        │`);
  console.log(`├────────────────────────────────────────────────────────┤`);
  if (PA_DEFAULT) {
    console.log(`│  ✅ Default PA URL: configured                         │`);
  } else {
    console.log(`│  ⚠️  No default PA URL — set POWER_AUTOMATE_DEFAULT_URL │`);
  }
  console.log(`│  Shim expected at: http://localhost:${SHIM_PORT}           │`);
  console.log(`├────────────────────────────────────────────────────────┤`);
  console.log(`│  For PA to reach this server, run:                     │`);
  console.log(`│    ngrok http ${PORT}                                    │`);
  console.log(`│  Then configure the ngrok URL in your PA flow.         │`);
  console.log(`└────────────────────────────────────────────────────────┘\n`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} already in use. Use --port XXXX to choose another.`);
    process.exit(1);
  }
  throw e;
});
