# COMOS AI Engineering Assistant — Architecture

> **Author:** GitHub Copilot (Claude Opus 4.6) - Tadeu Martins
> **Date:** February 26, 2026
> **Version:** 2.0

---

## Table of Contents

### Part I — Management View
1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Key Capabilities](#3-key-capabilities)
4. [Integration Architecture](#4-integration-architecture)
5. [Technology Stack](#5-technology-stack)
6. [Deployment & Operations](#6-deployment--operations)

### Part II — Technical Detailed View
7. [Component Architecture](#7-component-architecture)
8. [AI API Shim — Smart Proxy](#8-ai-api-shim--smart-proxy)
9. [COMOS Gateway — MCP Orchestrator](#9-comos-gateway--mcp-orchestrator)
10. [ServiceiPID Backend — P&ID Analysis Engine](#10-serviceipid-backend--pid-analysis-engine)
11. [ServiceiPID MCP Server — Tool Interface](#11-serviceipid-mcp-server--tool-interface)
12. [COMOS SDK Tools — C# Agent DLLs](#12-comos-sdk-tools--c-agent-dlls)
13. [Native COMOS Tools — BasicFunctions DLL](#13-native-comos-tools--basicfunctions-dll)
14. [Voice Input — Speech Polyfill](#14-voice-input--speech-polyfill)
15. [Chat UI — Widget Configuration](#15-chat-ui--widget-configuration)
16. [DLL Patching (IL Assembly)](#16-dll-patching-il-assembly)
17. [System Prompt & LLM Intelligence](#17-system-prompt--llm-intelligence)
18. [Endpoints Reference](#18-endpoints-reference)
19. [Configuration Reference](#19-configuration-reference)
20. [Adding New MCP Tools](#20-adding-new-mcp-tools)
21. [Adding New C# SDK Tools](#21-adding-new-c-sdk-tools)
22. [Startup & Health Checks](#22-startup--health-checks)
23. [File Structure](#23-file-structure)

---

# Part I — Management View

## 1. Executive Summary

The COMOS AI Engineering Assistant is an AI-powered copilot integrated into the Siemens COMOS plant engineering desktop application. It allows engineers to interact with COMOS through natural language — navigating objects, querying and setting attributes, opening reports, managing revisions, digitizing P&ID and electrical diagrams from PDF, and generating import scripts — all through a conversational chat interface with voice support.

The system extends COMOS with **four custom service layers** that work together:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **AI API Shim** | Node.js | Smart proxy with intent detection, tool fabrication, voice recording |
| **COMOS Gateway** | Python/FastAPI | LLM orchestrator with MCP tool loop |
| **ServiceiPID Backend** | Python/FastAPI | P&ID/electrical diagram analysis via computer vision + GPT |
| **SDK Agent DLLs** | C#/.NET | COMOS COM interop tools (import, draw, connect, attributes) |

The AI uses **GPT-5** (Azure OpenAI) for reasoning, **GPT-5.2** for vision analysis, and **Azure Whisper** for voice input transcription. COMOS desktop tools are exposed via **MEF plugin DLLs** that execute locally through the COMOS COM SDK.

---

## 2. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                      COMOS Desktop (.NET/C#)                         │
│  ┌───────────────┐   ┌───────────────────────────────────────────┐  │
│  │  COMOS Engine  │   │  CefSharp Browser (Chromium 136)          │  │
│  │  + C# AI API   │   │  ┌───────────────────────────────────┐   │  │
│  │  + SDK DLLs    │   │  │ Chat UI (React Widget)             │   │  │
│  │  (MEF plugins) │   │  │  • speech-polyfill.js (voice)      │   │  │
│  │                │   │  │  • chat-app.js (config + PDF)      │   │  │
│  │                │   │  │  • chat-widget.js (native bundle)  │   │  │
│  └──────┬────────┘   │  └────────────────┬────────────────────┘  │  │
│         │             └──────────────────┬┘                       │  │
└─────────┼────────────────────────────────┼───────────────────────────┘
          │ C# API calls                   │ fetch() HTTP
          ▼                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                AI API Shim (Node.js :56401)                          │
│  • Intercepts all chat requests from COMOS                           │
│  • Fabricates tool calls without LLM (saves latency + cost)          │
│  • Detects intents bilingual (PT-BR + EN)                            │
│  • Records voice via Windows MCI + transcribes via Azure Whisper     │
│  • Injects system prompt with 13+ rules for LLM behavior            │
│  • Manages 2-call budget per message (3rd iteration = text response) │
└────────────┬─────────────────────────────┬───────────────────────────┘
             │                             │
             ▼                             ▼
┌────────────────────────┐   ┌─────────────────────────────────────────┐
│ C# AI API (:56400)     │   │ COMOS Gateway (Python/FastAPI :8100)     │
│ NATIVE — COMOS SDK     │   │  • OpenAI-compatible chat endpoint       │
│  • Tool definitions    │   │  • MCP tool loop (spawn → call → return) │
│  • Tool execution      │   │  • RAW LLM passthrough mode              │
│  • COM interop bridge  │   │  • RAG document search                   │
│  • 30s timeout/call    │   │  • Direct analysis proxy                 │
└────────────────────────┘   └──────────────────┬──────────────────────┘
                                                │
                                                ▼
                             ┌─────────────────────────────────────────┐
                             │ ServiceiPID Backend (Python/FastAPI :8000)│
                             │  • P&ID diagram analysis (GPT-5.2 vision)│
                             │  • Electrical diagram analysis            │
                             │  • Component system matching (embeddings) │
                             │  • TAG extraction (regex + LLM)           │
                             │  • Diagram generation from text           │
                             │  • Knowledge base & chatbot               │
                             └─────────────────────────────────────────┘
```

---

## 3. Key Capabilities

### Conversational Engineering (COMOS Desktop)
- **Object Navigation** — "Go to PC001", "Navigate to pump P-101"
- **Attribute Queries** — "What is the shaft power of P-101?", "List all design data attributes of PC001"
- **Attribute Modification** — "Set power transmission to 50", "Change operation mode to Continuous"
- **Object Counting** — "How many pumps do we have?", "Quantas bombas existem?"
- **Reports** — "Open report X", "Open report in TwoDC"
- **Revisions** — "Show last revision", "Create new revision"
- **Queries** — "Export query X to Excel", "Create and run query"
- **Printing** — "List available printers", "What paper size for document X?"

### P&ID & Electrical Diagram Digitization (ServiceiPID)
- **PDF Analysis** — Upload a P&ID or electrical diagram PDF → AI extracts all equipment, instruments, and connections with coordinates
- **System Matching** — Each detected component is automatically matched to a COMOS `SystemFullName` using semantic embeddings
- **Excel Export** — Analysis results exported as XLSX with Components and Connections sheets
- **COMOS Import** — Automatic import from Excel into COMOS diagrams (create devices, draw, connect)
- **VBScript Generation** — Generate COM automation scripts for manual import
- **TAG Extraction** — Extract ISA S5.1 / IEC tags from engineering documents
- **Diagram Generation** — Generate P&ID/electrical diagrams from natural language descriptions
- **Knowledge Base** — Store and query analyzed P&IDs for Q&A

### Voice Input
- Click the microphone button in the chat to speak
- Server-side recording via Windows MCI (bypasses CefSharp secure-context limitation)
- Transcription via Azure Whisper
- Supports both English and Portuguese

### Document Intelligence (RAG)
- Index project documents (PDF, DOCX, TXT, CSV, MD)
- Semantic search over indexed documents
- Full RAG pipeline: search + LLM answer with citations

---

## 4. Integration Architecture

### How COMOS 10.7 and ServiceiPID Integrate

The two repositories serve complementary roles:

| Repository | Role | Location |
|-----------|------|----------|
| **COMOS 10.7** | Desktop AI integration (shim, DLLs, UI, voice) | `C:\Program Files (x86)\COMOS\Team_AI` |
| **ServiceiPID** | Backend AI services (analysis, gateway, MCP, RAG) | `C:\Users\...\ServiceiPID-main\ServiceiPID` |

**Integration Points:**

1. **Shim → Gateway** (`http://localhost:8100`): The shim proxies chat requests to the gateway for LLM reasoning when native tool fabrication is not sufficient. The gateway runs the MCP tool loop and returns final answers.

2. **Shim → Gateway (Direct Analysis)**: For PDF digitization, the shim sends the PDF directly to `/comos/analyze-direct` on the gateway, which forwards to the backend's `/analyze` endpoint. This bypasses the MCP/LLM loop for faster processing.

3. **Gateway → MCP → Backend**: The gateway spawns the MCP server as a subprocess via `stdio`. MCP tool calls are forwarded as HTTP requests to the backend at `:8000`.

4. **Shim → C# AI API** (`http://localhost:56400`): For COMOS-native tool calls (navigation, attributes, reports), the shim forwards requests to the C# AI API which executes tools through the COMOS COM SDK.

5. **C# SDK DLLs**: The custom DLLs (`Comos.ServiceiPID.Agent.dll`, `Comos.QueryCreator.Agent.dll`) are discovered by MEF at COMOS startup and provide import/draw/connect/query tools that the LLM can call.

### Data Flow — Chat with COMOS Tools

```
User types "What is the shaft power of P-101?"
  → CefSharp → fetch POST /api/ai/v1/completions
  → Shim detects attribute query intent
  → Shim fabricates: value_of_attribute_by_name_or_description({attributeName: "shaft power"})
  → COMOS C# executes tool via COM SDK
  → Result: { success=True, Value="100 kW" }
  → Shim formats response
  → User sees: "The shaft power of P-101 is 100 kW"
```

### Data Flow — PDF Digitization

```
User attaches PDF → Shim asks: "P&ID or Electrical?"
  → User replies "P&ID"
  → Shim → POST /comos/analyze-direct (Gateway :8100)
  → Gateway → POST /analyze (Backend :8000)
  → Backend: PyMuPDF renders pages → grid quadrants → GPT-5.2 vision
  → Backend: system_matcher maps each component → COMOS SystemFullName
  → Gateway: generates Excel with Components + Connections
  → Shim: returns download links to user
  → User clicks "Import into COMOS"
  → Shim: import_equipment_from_excel tool call
  → C# DLL: reads Excel, creates devices, draws on diagram, connects
```

---

## 5. Technology Stack

| Component | Technology | Version/Details |
|-----------|-----------|----------------|
| **COMOS Desktop** | C#/.NET Framework 4.x | Siemens COMOS 10.4.x |
| **Browser Engine** | CefSharp (Chromium) | Chromium 136 |
| **Chat Widget** | React | Bundled in chat-widget.js |
| **AI API Shim** | Node.js | ~8,400 lines JavaScript |
| **COMOS Gateway** | Python + FastAPI + Uvicorn | ~1,700 lines |
| **ServiceiPID Backend** | Python + FastAPI + Uvicorn | ~6,700 lines |
| **MCP Server** | Python + FastMCP | ~245 lines, stdio transport |
| **LLM (Chat)** | GPT-5 | Azure OpenAI |
| **LLM (Vision)** | GPT-5.2 (primary), GPT-5.1 (fallback) | Azure OpenAI |
| **Speech-to-Text** | Azure Whisper | Cognitive Services |
| **Embeddings** | text-embedding-3-large | Azure OpenAI |
| **PDF Processing** | PyMuPDF (fitz), pdf2image, pypdf | |
| **Image Processing** | OpenCV, Pillow, scikit-image | |
| **COM Interop** | COMOS SDK (Interop.Plt, Interop.ComosQSGlobalObj) | .NET Framework 4.x |

---

## 6. Deployment & Operations

### Service Startup Order

Services **must** be started in this order:

```
1. ServiceiPID Backend (:8000)  ← must be running before Gateway
2. COMOS Gateway (:8100)        ← depends on Backend for MCP
3. AI API Shim (:56401)         ← depends on Gateway + AI API
4. COMOS Desktop                ← starts AI API (:56400) automatically
```

A convenience startup script is provided: `ServiceiPID\backend\start_all_services.ps1` (or `Start_COMOS_AI.bat`).

### Health Verification

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health     # Backend → {"status":"ok"}
Invoke-RestMethod http://127.0.0.1:8100/health     # Gateway → {"status":"ok"}
Invoke-RestMethod http://127.0.0.1:56401/api/ai/v1/shim-status  # Shim → status, uptime
```

### Logs

| Log | Location |
|-----|----------|
| Shim HTTP traffic | `%TEMP%\comos_ai_shim\ai_api_shim.log` |
| Shim request/response | `%TEMP%\comos_ai_shim\requests.jsonl` |
| P&ID analysis state | `%TEMP%\comos_ai_shim\completed_analyses.json` |
| C# AI API | `%TEMP%\comos_ai_api-YYYYMMDD.log` |
| Excel/analysis exports | `%TEMP%\comos_ai_exports\` |

---

# Part II — Technical Detailed View

## 7. Component Architecture

### 7.1 COMOS Desktop (C#/.NET) — Native

| Item | Details |
|------|---------|
| **Executable** | `Comos.exe` |
| **AI Agent** | `Comos.EngineeringAssistant.BasicFunctions.dll` (IL-patched) |
| **AI API** | `Comos.Services.Ai.Api.exe` (port 56400) |
| **Config** | `Bin\agent.conf` — port 8080, assemblies in current directory |
| **Protocol** | Proprietary PascalCase format for tool calls and results |
| **Limitation** | Maximum **3 iterations** per user message (tool → tool → text response) |

### 7.2 CefSharp Browser — Native (with patches)

| Item | Details |
|------|---------|
| **Directory** | `Bin\ThirdParty\CefSharp\x86\` |
| **Engine** | Chromium 136 |
| **URL Scheme** | `localfolder://twodcvisualizer` — **NOT a secure context** |
| **Consequence** | `navigator.mediaDevices.getUserMedia()` completely unavailable |
| **Patches** | CefSharp flags in `ExtendedControls.dll` (insufficient alone — server-side recording is the real fix) |

### 7.3 Chat UI (TwoDcChat)

| File | Status | Description |
|------|--------|-------------|
| `index.html` | **Modified** | Added `<script src="speech-polyfill.js?v=4">` |
| `chat-widget.js` | **Native** | React bundle — W2 SpeechRecognition hook, Xf chat component, I_ input bar |
| `chat-widget.css` | **Native** | Widget styles |
| `chat-app.js` | **Modified** | Widget config: `voiceInput: true`, PDF upload, script block handler (~1,565 lines) |
| `speech-polyfill.js` | **New** | Server-side voice polyfill via MCI + Azure Whisper |

---

## 8. AI API Shim — Smart Proxy

**File:** `scripts\ai-api-shim.js` (~8,440 lines)
**Port:** 56401
**Runtime:** Node.js

The shim sits between the COMOS desktop and all backend services. It intercepts every chat request and decides whether to fabricate a tool call locally (saving LLM latency/cost) or proxy to the gateway for full LLM reasoning.

### 8.1 Tool Call Fabrication

The shim can fabricate tool calls **without calling the LLM**, returning directly to COMOS:

| Intent | Detection | Fabricated Tool |
|--------|-----------|-----------------|
| Count objects | "how many pumps?" / "quantas bombas?" | `get_count_of_comos_objects_with_name` |
| Read attribute value | "what is the shaft power?" / "qual a potência?" | `value_of_attribute_by_name_or_description` |
| Navigate to attribute | "go to pressure attribute" | `navigate_to_attribute_by_name_or_description` |
| Navigate to object | "go to PC001" | `navigate_to_comos_object_by_name_or_label` |
| List attributes | "list attributes of PC001" / "list design data attributes" | Navigate → `list_object_attributes` (with optional tab filter) |
| Set attribute | "set power transmission of PC001 to 50" | Navigate → `set_attribute_value` |
| Set attribute (context) | "set power transmission to 50" (object from prior context) | `set_attribute_value` (with systemUID from conversation) |
| Follow-up confirmation | "yes" / "sim" / "ok" | Pending tool call from prior turn |
| Auto-retry | Attribute "not found" | Retry with alternative names (fuzzy) |

### 8.2 Budget Counter

COMOS .NET allows a maximum of **3 iterations** per user message. The shim tracks fabricated calls with prefix `call_shim_` and limits to **2 fabrications** per message, reserving the 3rd iteration for the LLM's text response.

### 8.3 Intent Detection (Bilingual PT + EN)

| Function | Detects |
|----------|---------|
| `isObjectCountIntent()` | "how many X" / "quantos X" / "qtd de X" |
| `isListAttributesIntent()` | "list attributes" / "listar atributos" / "show specs" |
| `isAttributeWriteIntent()` | "set X to Y" / "change X to Y" / "alterar X para Y" |
| `isPureNavigationIntent()` | "go to X" / "navegar até X" / "abrir X" |
| `isDocumentNavigationIntent()` | "open document X" / "abrir documento X" |
| `isMultiStepIntent()` | Multi-action with connectors ("do X and then Y") |
| `extractWriteParams()` | Extracts object tag, attribute name, new value from write requests |
| `extractTabFilter()` | Extracts tab name filter ("process data", "design data", etc.) |

### 8.4 False-Positive Tag Filter

The tag extraction regex `[A-Z]{1,4}[- ]?\d{2,5}` can match prepositions + numbers (e.g., "to 40" from "set power transmission to 40"). A validation step rejects tags starting with common prepositions (`to`, `of`, `at`, `de`, `para`, etc.) followed by digits, allowing the context-carry or LLM path to handle the request instead.

### 8.5 Context Carry for Attribute Writes

When user says "set power transmission to 50" without mentioning an object, the shim scans prior tool messages in the conversation for `systemUID`, `objectName`, and `SystemType` fields. If found, it fabricates `set_attribute_value` directly with the inferred context — no navigation needed.

### 8.6 Fuzzy Matching (Levenshtein)

- `levenshteinDistance(a, b)` — edit distance between two strings
- `generateAttributeAlternatives(name)` — generates aliases for attribute names
- Bilingual alias map: "shaft power", "pressure", "temperatura", "Potência do eixo", etc.
- Tolerance: Levenshtein ≤ 2 (corrects typos like "Shatf Power" → "Shaft Power")

### 8.7 System Prompt Injection

Every `/completions` request gets `COMOS_SYSTEM_PROMPT` injected (13+ rules):

| Rule | Summary |
|------|---------|
| **1** | Only use tools from the `tools` array |
| **2** | Never mention PDF/P&ID/ServiceiPID capabilities |
| **3** | List only COMOS-native capabilities |
| **4** | Respond in user's language (PT or EN) |
| **7** | Maximum 1 tool call per response |
| **8** | Up to 4 retries for attribute lookups |
| **10** | Prefer `navigate_to_comos_object_by_name` for navigation |
| **10a** | Try name variations (with/without hyphen) |
| **11** | Call attribute tools immediately — no confirmation |
| **11a-f** | Sub-rules for retry, counting, filtered counting, mandatory reporting |
| **12** | Attribute write workflow: use prior systemUID or read-first |
| **12a** | Extract object context from prior C# tool results |
| **13** | Tool selection guide (mapping intent → tool name) |

### 8.8 Digitization Two-Step Flow

1. User attaches PDF → Shim detects PDF
2. **Step A:** Ask user: "P&ID or Electrical Diagram?"
3. User replies → Shim sends PDF + type to Gateway `/comos/analyze-direct`
4. Gateway forwards to Backend `/analyze` → GPT vision analysis
5. Results returned with download links (Excel, VBS import script)

### 8.9 Format Adaptation

The COMOS .NET client expects a proprietary PascalCase format. The shim:
- Normalizes input: `function_call` (legacy) → `tool_calls` (modern OpenAI)
- Adapts responses: adds `Role`, `Content`, `FunctionCall`, `toolCalls` (PascalCase aliases)
- Heals orphan tool messages (missing corresponding `tool_calls[].id`)
- Strips systemUID from attribute tool calls to force reliable path (navigator-selected object)

### 8.10 SSE Agent Events

The shim broadcasts Server-Sent Events (SSE) on `GET /api/ai/v1/agent-events` for real-time UI updates:
- `agent_thinking` — "Analyzing your request...", "Retrying with alternative approach..."
- `agent_complete` — "Response ready"

---

## 9. COMOS Gateway — MCP Orchestrator

**File:** `ServiceiPID\backend\comos_gateway.py` (~1,700 lines)
**Port:** 8100
**Framework:** Python FastAPI + Uvicorn

The gateway provides an OpenAI-compatible chat endpoint that orchestrates the full tool-calling loop using MCP (Model Context Protocol).

### 9.1 MCP Tool Loop (`_run_llm_with_mcp`)

```
1. Spawn MCP stdio subprocess (python -m backend.mcp_server)
2. session.list_tools() → get available tools
3. Convert MCP schemas → OpenAI function-calling format
4. Build messages: system prompt → history → user message
5. LOOP (max_tool_calls + 1 iterations):
   a. Call LLM with tools + tool_choice: "auto"
   b. If no tool_calls → return final answer
   c. For each tool_call:
      - Parse arguments
      - Call mcp_session.call_tool(name, args, timeout)
      - Append tool response
      - Log execution
   d. Decrement remaining counter
6. If exhausted → RuntimeError
```

### 9.2 Operating Modes

| Mode | Endpoint | Description |
|------|----------|-------------|
| **MCP Chat** | `POST /comos/chat` | Full tool loop with ServiceiPID MCP tools |
| **OpenAI-Compatible** | `POST /v1/chat/completions` | Converts OpenAI format ↔ gateway format, runs MCP loop |
| **RAW LLM** | `POST /v1/chat/completions/raw` | Direct passthrough to LLM — no MCP, no gateway system prompt. Used by the shim for COMOS-native tool-calling. |
| **Direct Analysis** | `POST /comos/analyze-direct` | Bypasses MCP/LLM, calls backend `/analyze` directly via httpx |

### 9.3 RAG (Retrieval-Augmented Generation)

The gateway exposes RAG endpoints backed by `rag_engine.py`:

| Endpoint | Purpose |
|----------|---------|
| `POST /comos/rag-ingest` | Index documents folder |
| `POST /comos/rag-query` | Semantic search (top-k results) |
| `POST /comos/rag-ask` | Full RAG: search + LLM answer |
| `GET /comos/rag-stats` | Index statistics |
| `GET /comos/rag-documents` | List indexed documents |
| `POST /comos/rag-add-file` | Add file to index |

**Supported file types:** PDF, DOCX, DOC, TXT, CSV, MD, RTF
**Embedding model:** `text-embedding-3-large`
**Chunk size:** 1000 chars with 200 overlap

---

## 10. ServiceiPID Backend — P&ID Analysis Engine

**File:** `ServiceiPID\backend\backend.py` (~6,700 lines)
**Port:** 8000
**Framework:** Python FastAPI + Uvicorn

### 10.1 Core Analysis Pipeline (`POST /analyze`)

The main analysis endpoint processes P&ID and electrical diagram PDFs:

1. **PDF Rendering** — PyMuPDF renders each page at configurable DPI (100-600, default 400)
2. **Grid Quadrants** — Each page is split into a grid (1-6, default 3×3) of overlapping quadrant images
3. **GPT Vision Analysis** — Each quadrant image is sent to GPT-5.2 vision model with detailed prompts for equipment/instrument detection
4. **Coordinate Mapping** — Local quadrant coordinates (mm) are mapped to global page coordinates
5. **Deduplication** — Overlapping detections from adjacent quadrants are merged
6. **System Matching** — Each detected component is matched to a COMOS `SystemFullName` using semantic embeddings (via `system_matcher.py`)
7. **Output** — Per-page results with items (tag, description, type, coordinates, SystemFullName, confidence) and connections (source → target)

**Analysis Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dpi` | 400 | Rendering resolution (100-600) |
| `grid` | 3 | Grid subdivisions per axis (1-6) |
| `diagram_type` | "pid" | "pid" or "electrical" |
| `tol_mm` | 10.0 | Connection tolerance in mm |
| `use_dynamic_tolerance` | true | Auto-adjust tolerance based on diagram density |
| `use_overlap` | false | Overlap quadrants for better edge detection |
| `use_ocr_validation` | false | Post-validate with OCR |
| `use_geometric_refinement` | false | Refine positions using geometric analysis |
| `use_pdf_alignment` | false | Align to PDF vector coordinates |
| `enable_electrical_quadrants` | false | Use electrical-specific quadrant logic |

### 10.2 System Matcher (`system_matcher.py`)

Maps equipment tags/descriptions to COMOS `SystemFullName` values using OpenAI embeddings + cosine similarity.

**How it works:**
1. **Reference databases** — Two Excel files contain the mapping: `referencia_systems.xlsx` (P&ID) and `Referencia_systems_electrical.xlsx` (electrical). Each row has Type, Description, and SystemFullName.
2. **Embedding generation** — Reference descriptions are embedded with `text-embedding-3-large` and cached as `.pkl` files. Auto-regenerated if the Excel source is newer.
3. **Matching** — For each detected component, the tag+description is embedded and compared against all references using cosine similarity. The top match is returned with confidence score.
4. **Dual matching** — `match_system_fullname_dual()` tries both P&ID and electrical databases.
5. **Pole detection** — For electrical components, detects pole count ("trifásico" → 3-pole) for filtering.

### 10.3 TAG Extraction (`POST /extract-tags`)

Extracts engineering tags from PDF documents using:
- **Regex patterns** — ISA S5.1 patterns for P&ID, IEC patterns for electrical
- **LLM descriptions** — Optional GPT-generated technical descriptions for each tag
- **System matching** — Each tag is mapped to a COMOS SystemFullName
- **Document mode** — Special mode for RFQs, specs, equipment lists (broader patterns + blacklist)

### 10.4 Diagram Generation (`POST /generate`)

Generates P&ID or electrical diagrams from natural language:
- Input: natural language description (e.g., "a simple cooling water circuit with pump, heat exchanger, and control valve")
- Output: structured JSON with items (tag, description, type, XY coordinates) and connections
- Uses `FALLBACK_MODEL` (GPT-5.1) with temperature 0.7
- System matching applied to all generated items
- Supports A0 sheet for P&ID, A3 sheet for electrical

### 10.5 Knowledge Base & Chat

- **Store** (`POST /store`) — Store analyzed P&ID data in memory (per-session)
- **Describe** (`GET /describe`) — Generate/retrieve ultra-complete technical descriptions
- **Chat** (`POST /chat`) — Q&A about stored P&IDs with text/vision/hybrid modes

---

## 11. ServiceiPID MCP Server — Tool Interface

**File:** `ServiceiPID\backend\mcp_server.py` (~245 lines)
**Transport:** stdio (spawned by gateway as subprocess)
**Framework:** FastMCP

The MCP server is a thin wrapper that exposes ServiceiPID backend capabilities as MCP tools. It forwards all calls to the backend HTTP API at `:8000`.

### 11.1 MCP Tools (9 total)

| # | Tool | Parameters | Description |
|---|------|-----------|-------------|
| 1 | `backend_health` | — | Check if backend is running |
| 2 | `backend_ping` | — | Return backend model/runtime info |
| 3 | `analyze_pdf` | `file_path`, `dpi`, `grid`, `enable_electrical_quadrants`, `debug_quadrant_coords`, `tol_mm`, `use_overlap`, `use_dynamic_tolerance`, `use_ocr_validation`, `use_geometric_refinement`, `use_geometric_refinement_electrical`, `use_pdf_alignment`, `diagram_type` | Analyze a PDF from local file path |
| 4 | `analyze_pdf_base64` | `filename`, `pdf_base64`, `dpi`, `grid`, `diagram_type` | Analyze a PDF from base64 data |
| 5 | `generate_pid` | `prompt`, `diagram_type` | Generate diagram from natural language (min 10 chars) |
| 6 | `store_pid_knowledge` | `pid_id`, `data` | Store P&ID data in knowledge base |
| 7 | `list_knowledge_base` | — | List stored P&IDs |
| 8 | `describe_pid` | `pid_id`, `regenerate` | Get/regenerate P&ID description |
| 9 | `chat_about_pid` | `pid_id`, `question`, `mode` | Ask questions about a P&ID (text/vision/hybrid) |

### 11.2 How MCP Tools Work

Each MCP tool follows the same pattern:

1. The gateway spawns the MCP server as a subprocess via stdio
2. The LLM decides which tool to call based on the tool schema + user message
3. The gateway sends the tool call to the MCP server via stdio JSON-RPC
4. The MCP server makes an HTTP request to the backend (`:8000`)
5. The backend processes the request and returns JSON
6. The MCP server returns the result to the gateway
7. The gateway appends the tool result to the conversation and loops back to the LLM

### 11.3 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVICEIPID_API_BASE_URL` | `http://127.0.0.1:8000` | Backend URL |
| `SERVICEIPID_API_TIMEOUT_S` | `900` | HTTP timeout |
| `SERVICEIPID_MCP_TRANSPORT` | `stdio` | Transport: `stdio` or `streamable-http` |

---

## 12. COMOS SDK Tools — C# Agent DLLs

Custom DLLs compiled from C# source and placed in `Bin\SDK\AI\`. Discovered by MEF (Managed Extensibility Framework) at COMOS startup.

### 12.1 ServiceiPID Agent (`Comos.ServiceiPID.Agent.dll`)

**ToolScope:** `"ServiceiPID"` — 7 tools for import, drawing, connecting, and attribute management.

#### `import_equipment_from_excel`
Batch imports equipment from a ServiceiPID analysis Excel file. Creates COMOS devices, draws them on the diagram at XY coordinates, and establishes electrical/process connections (EB01/EB02 pins). Also supports inline JSON payloads for interactive operations. After connections are made, **AutoConnect** runs automatically to render physical connection lines on the diagram (`Comos.WSP.XDocElo.AutoConnect` COM object).

| Parameter | Type | Description |
|-----------|------|-------------|
| `excelFilePath` | string | Full path to the XLSX file from ServiceiPID analysis |
| `documentUID` | string | SystemUID of the target COMOS diagram |
| `documentType` | int | Document type (usually 29) |

#### `draw_single_object`
Interactive drawing — places a single device on a COMOS diagram at specific XY coordinates. Resolves CDevice from SystemFullName, creates/retrieves the logical device, draws on the Report, and links via COM.

| Parameter | Type | Description |
|-----------|------|-------------|
| `documentUID` | string | Target diagram SystemUID |
| `documentType` | int | Document type (29) |
| `tag` | string | Equipment tag (e.g., `=M01.Q01`) |
| `description` | string | Equipment description |
| `systemFullName` | string | COMOS SystemFullName from system_matcher |
| `x` | double | X coordinate (mm) |
| `y` | double | Y coordinate (mm) |

#### `connect_objects`
Connects two existing objects on a diagram by tag — wires source output pin (EB02) to target input pin (EB01) via `IComosDConnector.Connect()`. After a successful connection, **AutoConnect** runs automatically to render the physical connection line on the diagram (`Comos.WSP.XDocElo.AutoConnect` COM object). Error markers (ErrorNumber == 1) are cleaned up automatically.

| Parameter | Type | Description |
|-----------|------|-------------|
| `documentUID` | string | Diagram SystemUID |
| `documentType` | int | Document type (29) |
| `sourceTag` | string | Source (upstream) object tag |
| `targetTag` | string | Target (downstream) object tag |
| `sourceSystemFullName` | string | Source COMOS SystemFullName |
| `targetSystemFullName` | string | Target COMOS SystemFullName |

#### `scan_document_tags`
Diagnostic: enumerates all device objects on a diagram, returning Name, Label, and SystemUID. Use before `connect_objects` to verify tags exist.

| Parameter | Type | Description |
|-----------|------|-------------|
| `documentUID` | string | Diagram SystemUID (or `"ACTIVE"`) |
| `documentType` | int | Document type (29) |
| `maxTags` | int | Max tags to return (default 60) |

#### `extract_and_create_tags`
Bulk creation of COMOS devices from extracted tags (base64 TSV payload). Hierarchy-only — no diagram drawing, no connections. Used for PDF tag extraction import.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tagsPayload` | string | Base64-encoded TSV: `tag\tdescription\tSystemFullName` per line |
| `documentUID` | string | Target document SystemUID (or `"ACTIVE"`) |
| `documentType` | int | Document type (29) |

#### `list_object_attributes`
Lists all specification attributes of a COMOS object. Recursively searches up to 10 spec levels. Supports tab-level filtering (e.g., show only "Design data" attributes).

| Parameter | Type | Description |
|-----------|------|-------------|
| `systemUID` | string | Optional: Object SystemUID |
| `objectName` | string | Optional: Object name/tag |
| `systemType` | string | Optional: SystemType from navigation result |
| `tabFilter` | string | Optional: Filter by tab name (case-insensitive partial match) |

**Resolution strategy (4-cascade):** LoadByType → type-scan → name candidates → AllDevices scan.

#### `set_attribute_value`
Sets/overwrites a specification attribute value. Uses recursive fuzzy matching (Levenshtein distance) to find the attribute by name or description.

| Parameter | Type | Description |
|-----------|------|-------------|
| `attributeName` | string | Attribute name or description (fuzzy matched) |
| `newValue` | string | New value to write |
| `systemUID` | string | Optional: Object SystemUID |
| `objectName` | string | Optional: Object name/tag |
| `systemType` | string | Optional: SystemType from navigation result |

### 12.2 QueryCreator Agent (`Comos.QueryCreator.Agent.dll`)

**ToolScope:** `"QueryCreator"` — 2 tools for COMOS data enumeration.

#### `create_and_run_query`
Enumerates COMOS objects: Devices (queryType=0), CDevices/catalog (queryType=1), or Documents (queryType=4).

| Parameter | Type | Description |
|-----------|------|-------------|
| `queryType` | string | 0=Devices, 1=CDevices, 4=Documents |
| `columns` | string | Comma-separated: Name, Description, SystemFullName, FullName, Label, etc. |
| `sfnPrefix` | string | Optional SystemFullName prefix filter (`@30` for P&ID, `@10` for electrical) |
| `nameFilter` | string | Optional Name contains filter |
| `maxRows` | string | Max rows (default 200, max 500) |
| `exportPath` | string | Optional CSV export path |

#### `list_all_cdevice_sfn`
Lists CDevice SystemFullName values from the COMOS catalog. Shortcut for `create_and_run_query` with queryType=1.

| Parameter | Type | Description |
|-----------|------|-------------|
| `rootPrefix` | string | SFN prefix: `@30`=P&ID, `@10`=electrical, ``=all |
| `maxRows` | string | Max rows (default 200) |
| `exportPath` | string | Optional CSV export path |

### 12.3 TestTool Agent (`Comos.TestTool.Agent.dll`)

**ToolScope:** `"TestTool"` — 1 tool for pipeline verification.

#### `test_hello_world`
Returns `"Hello, {name}! Test tool is active."` — used to verify MEF discovery and tool registration.

### 12.4 Built-in SDK Agents

These are Siemens-provided DLLs without source code:

| DLL | ToolScope | Tools |
|-----|-----------|-------|
| `Comos.Query.Agent.dll` | `"Query"` | Database queries, export |
| `Comos.Report.Agent.dll` | `"Report"` | Report generation, opening |
| `Comos.Revsioning.Agent.dll` | `"Revsion"` | Revision management (note: intentional typo in COMOS) |

---

## 13. Native COMOS Tools — BasicFunctions DLL

These tools come from `Comos.EngineeringAssistant.BasicFunctions.dll` (IL-patched, in `Bin/`). They are registered by the native COMOS AI framework and execute through the C# AI API at port 56400.

### Navigation Tools

| Tool | Description |
|------|-------------|
| `navigate_to_comos_object_by_name` | Navigate to object by Name (full tree scan) |
| `navigate_to_comos_object_by_name_or_label` | Navigate by Name or Label |
| `navigate_to_comos_object_by_systemUID` | Navigate by SystemUID |
| `navigate_to_comos_document_by_name` | Open a COMOS document |

### Attribute Tools

| Tool | Description |
|------|-------------|
| `navigate_to_attribute_by_name_or_description` | Navigate to attribute tab/field (with recursive search) |
| `value_of_attribute_by_name_or_description` | Read attribute value (with recursive search + unit) |

### Query/Search Tools

| Tool | Description |
|------|-------------|
| `objects_with_name` | Search objects by name (for counting, NOT navigation) |
| `get_count_of_comos_objects_with_name` | Count objects matching a name pattern |
| `export_query_to_excel` | Export a COMOS query to Excel |

### Report/Document Tools

| Tool | Description |
|------|-------------|
| `open_report` | Open a COMOS report |
| `open_report_twodc` | Open a report in TwoDC viewer |
| `show_last_revision_of_document` | Show the last revision of a document |
| `create_new_revision` | Create a new document revision |

### Printing Tools

| Tool | Description |
|------|-------------|
| `get_info_about_all_available_printers_and_all_available_paper` | List printers and paper sizes |
| `get_print_paper_name_for_document` | Get paper size for a specific document |

### IL Patches Applied

| Patch | Version | Description |
|-------|---------|-------------|
| v1 | `SearchSpecRecursive` | Recursive specification search to 10 levels (fixed attributes not found for nested specs) |
| v2 | Cast fix | Fixed `isinst` cast in `ValueOfAttributeWithNameOrDescription` |
| v3 | Unit concatenation | `sp.get_Unit()` appended to values (e.g., "100 kW" instead of "100") |
| CefSharp | ExtendedControls.dll | Added `--enable-media-stream`, `--use-fake-ui-for-media-stream` flags |

---

## 14. Voice Input — Speech Polyfill

### Problem

CefSharp loads chat UI via `localfolder://`, which is **not a secure context** in Chromium 136+. This makes `navigator.mediaDevices.getUserMedia()` completely unavailable and `SpeechRecognition.start()` throw `not-allowed`, even with CefSharp flags.

### Solution: Server-Side Recording

```
Browser (CefSharp)                    Server (Node.js Shim)
──────────────────                    ─────────────────────
speech-polyfill.js                    ai-api-shim.js

  POST /mic/start ────────────►      Spawn PowerShell
                                      MCI: open waveaudio
                                      MCI: record capture
                                      (Records from Windows mic)

  POST /mic/stop ─────────────►      MCI: stop capture
                                      MCI: save WAV
                                      Send WAV → Azure Whisper
       { text: "Hello" }  ◄────────  Return transcription

  onresult({ transcript })
  [120ms delay]
  onend()

  useEffect copies to input
```

### Components

1. **`speech-polyfill.js`** — Unconditionally replaces `window.SpeechRecognition` and `window.webkitSpeechRecognition` with `WhisperSpeechRecognition`. Implements standard SpeechRecognition API interface so the React widget's W2 hook works transparently.

2. **MCI Recording (shim)** — Three endpoints: `/mic/start` (spawn PowerShell with MCI recording), `/mic/stop` (stop + save WAV + transcribe via Azure Whisper), `/mic/abort` (cancel).

3. **Azure Whisper** — Deployment: `whisper`, API version `2024-06-01`, endpoint: Azure Cognitive Services.

### Critical Fix: React 18 Batching

The widget's `useEffect` only copies transcript to input while `isListening=true`. If `onresult` and `onend` fire synchronously, React batches updates and `isListening` becomes `false` before the effect runs — transcript is lost. **Fix:** 120ms `setTimeout` between `onresult` and `onend`.

---

## 15. Chat UI — Widget Configuration

**File:** `Bin\ThirdParty\TwoDcChat\chat-app.js` (~1,565 lines)

### Widget Setup

```javascript
{
    title: 'COMOS Engineering Copilot',
    features: {
        conversationSidebar: true,
        messageSearch: false,
        fileUpload: true,
        voiceInput: true    // ← enabled (was false in native)
    }
}
```

### Custom Features

- **PDF Upload** — Hidden `<input type="file" accept=".pdf">` wired to the `+` button via `MutationObserver`. PDF-only policy with type selection dialog (P&ID / Electrical / Tags Only / Document).
- **CefSharp Interop** — `sendToBackend()` via `CefSharp.PostMessage()` for bidirectional communication.
- **Script Block Handler** — Watches for `comos-script` code blocks in assistant messages and injects interactive execution panels.
- **Application State** — Centralized `appState` with conversation management and widget instance reference.

---

## 16. DLL Patching (IL Assembly)

All DLL patches use the workflow: `ildasm` (disassemble) → manual `.il` editing → `ilasm` (reassemble).

### Patched DLLs

| DLL | Location | Patches |
|-----|----------|---------|
| `Comos.EngineeringAssistant.BasicFunctions.dll` | `Bin\` | v1: recursive spec search, v2: cast fix, v3: unit concatenation |
| `Comos.WPF.ExtendedControls.dll` | `Bin\` | CefSharp flags for media stream |

### Important Rules

- **Backups mandatory** — Always backup before replacing: `_backups/<name>.dll.locked_YYYYMMDD_HHMMSS_<reason>`
- **DLL is locked while COMOS runs** — Must close COMOS before replacing
- **Custom DLLs** (`Comos.ServiceiPID.Agent.dll`) are compiled from `.cs` source — **never** confuse with the native patched `BasicFunctions.dll`
- **Compilation** — Roslyn `csc.exe` with `/target:library /optimize+ /deterministic`

---

## 17. System Prompt & LLM Intelligence

The shim injects a comprehensive system prompt (`COMOS_SYSTEM_PROMPT`) into every LLM request. This prompt contains 13+ rules that govern tool selection, retry behavior, attribute handling, and context awareness.

### Key Behavioral Rules

| # | Rule | Effect |
|---|------|--------|
| 1 | Only use tools from `tools` array | Prevents hallucinated tool calls |
| 2 | Never mention PDF/P&ID capabilities | Clean separation between COMOS tools and ServiceiPID |
| 7 | Max 1 tool call per response | Works within COMOS 3-iteration limit |
| 10 | Prefer `navigate_to_comos_object_by_name` | Most reliable — full tree scan |
| 10a | Try name variations (with/without hyphen) | "PC-001" → "PC001" retry |
| 11 | Call attribute tools immediately | No confirmation prompts for lookups |
| 11a | Retry up to 4 times with variations | "Shaft Power" → "Power" → "P_shaft" → "Shaft" |
| 12 | Write workflow: use prior systemUID if available | Direct writes without read-first when context exists |
| 12a | Extract context from C# format tool results | Parse `{ success = True, objectName = PC001, systemUID = A541598NS5 }` |

---

## 18. Endpoints Reference

### AI API Shim (:56401)

| Method | Path | Description |
|--------|------|-------------|
| `HEAD` | `/api/ai/v1/completions` | Connection validation (COMOS .NET) |
| `POST` | `/api/ai/v1/completions` | **Main chat** — intent detection + fabrication + proxy |
| `POST` | `/api/ai/v1/completions/generate-title` | Generate conversation title |
| `POST` | `/api/ai/v1/transcribe` | Speech-to-text via Azure Whisper |
| `POST` | `/api/ai/v1/mic/start` | Start microphone recording (MCI) |
| `POST` | `/api/ai/v1/mic/stop` | Stop recording + transcribe |
| `POST` | `/api/ai/v1/mic/abort` | Cancel recording |
| `POST` | `/api/ai/v1/save-download` | Save file to disk |
| `POST` | `/api/ai/v1/attach-pdf` | Pre-load PDF for next message |
| `POST` | `/api/ai/v1/upload-pdf` | Direct PDF upload |
| `GET` | `/api/ai/v1/shim-status` | Shim status/debug |
| `GET` | `/api/ai/v1/agent-events` | SSE stream for agent thinking events |
| `GET` | `/comos/download/:id` | Proxy download → gateway |
| `POST` | `/comos/export-excel` | Proxy Excel export → gateway |
| `POST` | `/comos/generate-import-script` | Proxy VBS generation → gateway |
| `*` | `*` | Default: proxy → C# AI API (:56400) |

### COMOS Gateway (:8100)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/comos/tools` | List MCP tools |
| `POST` | `/comos/chat` | **MCP tool loop chat** |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (with MCP) |
| `POST` | `/v1/chat/completion` | Alias |
| `POST` | `/v1/chat/completions/raw` | **RAW LLM passthrough** (no MCP) |
| `POST` | `/comos/analyze-direct` | Direct PDF analysis (bypasses MCP) |
| `POST` | `/comos/extract-tags-direct` | Direct TAG extraction |
| `POST` | `/comos/generate-circuit` | Generate circuit from NL |
| `POST` | `/comos/match-component` | Single component matching |
| `POST` | `/comos/regen-embeddings` | Regenerate embedding caches |
| `POST` | `/comos/reload-cache` | Reload PKL caches |
| `POST` | `/comos/export-excel` | Generate Excel workbook |
| `GET` | `/comos/download/{file_id}` | Download generated file |
| `GET` | `/comos/excel-path/{file_id}` | Get file disk path |
| `POST` | `/comos/generate-import-script` | Generate VBScript |
| `POST` | `/comos/rag-ingest` | Index RAG documents |
| `POST` | `/comos/rag-query` | Semantic search |
| `POST` | `/comos/rag-ask` | RAG Q&A |
| `GET` | `/comos/rag-stats` | RAG statistics |
| `GET` | `/comos/rag-documents` | List RAG documents |
| `POST` | `/comos/rag-add-file` | Add file to RAG |

### ServiceiPID Backend (:8000)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/ping` | Model/runtime info |
| `GET` | `/progress` | SSE progress stream |
| `POST` | `/analyze` | **Main P&ID analysis** |
| `POST` | `/extract-tags` | TAG extraction |
| `POST` | `/generate` | Diagram generation from NL |
| `GET` | `/describe` | P&ID description |
| `POST` | `/chat` | P&ID chatbot |
| `POST` | `/store` | Store P&ID data |
| `GET` | `/knowledge-base` | List stored P&IDs |
| `POST` | `/enable_cv2` | Enable OpenCV at runtime |

---

## 19. Configuration Reference

### Azure OpenAI

| Setting | Value |
|---------|-------|
| Endpoint | `https://openai-aittack-msa-001070-swedencentral-aifordipaswidser-00.openai.azure.com` |
| API Key | `.env` file |
| API Version | `2024-12-01-preview` |
| Chat Model | `gpt-5` |

### Azure Whisper

| Setting | Value |
|---------|-------|
| Endpoint | `*.cognitiveservices.azure.com` |
| Deployment | `whisper` |
| API Version | `2024-06-01` |

### Environment Variables

| Variable | Default | Used By |
|----------|---------|---------|
| `OPENAI_API_KEY` | — | Gateway, Backend |
| `AZURE_OPENAI_ENDPOINT` | — | Gateway, Backend |
| `AZURE_OPENAI_API_KEY` | — | Gateway, Backend |
| `COMOS_GATEWAY_PORT` | `8100` | Gateway |
| `COMOS_GATEWAY_MODEL` | `gpt-5` | Gateway |
| `COMOS_MCP_TOOL_TIMEOUT_S` | `600` | Gateway |
| `COMOS_TOOL_RESULT_CHAR_LIMIT` | `12000` | Gateway |
| `SERVICEIPID_API_BASE_URL` | `http://127.0.0.1:8000` | MCP Server |
| `PRIMARY_MODEL` | `gpt-5.2` | Backend |
| `FALLBACK_MODEL` | `gpt-5.1` | Backend |
| `OPENAI_REQUEST_TIMEOUT` | `600` | Backend |

---

## 20. Adding New MCP Tools

To extend the system with new MCP tools that the LLM can call through the gateway:

### Step 1: Add the Tool Function in the MCP Server

Edit `ServiceiPID\backend\mcp_server.py` and add a new `@mcp.tool()` decorated function:

```python
@mcp.tool()
async def my_new_tool(
    param1: str,
    param2: int = 10,
) -> str:
    """
    Description of what the tool does.
    The LLM sees this docstring to decide when to call it.
    """
    result = await _request_backend("POST", "/my-endpoint", json_body={
        "param1": param1,
        "param2": param2,
    })
    return json.dumps(result, ensure_ascii=False)
```

### Step 2: Add the Backend Endpoint (if needed)

If the tool needs new backend logic, add a FastAPI endpoint in `backend.py`:

```python
@app.post("/my-endpoint")
async def my_endpoint(param1: str, param2: int = 10):
    # Your logic here
    return {"result": "..."}
```

### Step 3: Update the Gateway System Prompt (optional)

If you want the LLM to have specific policies for using the tool, edit the system prompt in `comos_gateway.py`:

```python
SYSTEM_PROMPT = """...
- Use `my_new_tool` when the user asks about X.
..."""
```

### Step 4: Update the Shim Hiding Rules (if needed)

The shim's `COMOS_SYSTEM_PROMPT` (rule 2) tells the LLM to NOT mention ServiceiPID tools. If your new tool should be visible in the COMOS chat context, update the hiding rules in `ai-api-shim.js`.

### Step 5: Restart Services

```powershell
# Restart Gateway (which re-spawns MCP subprocess)
$gw = Get-NetTCPConnection -LocalPort 8100 -State Listen | Select-Object -First 1
Stop-Process -Id $gw.OwningProcess -Force
# Start Gateway again
cd "C:\Users\...\ServiceiPID"
.\.venv\Scripts\python.exe -m uvicorn backend.comos_gateway:app --host 0.0.0.0 --port 8100
```

### Adding External MCP Servers

To connect a completely separate MCP server (not ServiceiPID):

1. **Deploy your MCP server** as a separate process (stdio or HTTP transport)
2. **Update `COMOS_MCP_COMMAND` and `COMOS_MCP_ARGS`** environment variables to point to your MCP server
3. OR **modify `comos_gateway.py`** to spawn multiple MCP sessions and merge their tool lists

For HTTP-based MCP (instead of stdio), the MCP server can use `streamable-http` transport:
```python
# In your MCP server:
mcp.run(transport="streamable-http", host="127.0.0.1", port=8765)
```

Then configure the gateway to connect via HTTP instead of spawning a subprocess.

---

## 21. Adding New C# SDK Tools

To add new tools that execute locally in COMOS through the COM SDK:

### Step 1: Create the Tool Class

Create a new `.cs` file in `Bin\SDK\AI\`:

```csharp
using System;
using System.ComponentModel.Composition;
using Comos.Ai.Functions;

namespace MyPlugin
{
    [Export(typeof(AIComosTool))]
    public class MyTool : AIComosTool
    {
        public string ToolScope => "MyScope"; // NEVER use "comos"

        // CRITICAL: Workset pattern — private get, public set
        private static IComosDWorkset _workset;
        public static IComosDWorkset Workset
        {
            private get { return _workset; }
            set { _workset = value; }
        }

        [AiFunction("Description of what this tool does")]
        public object my_tool_function(
            [DescribeParameter("Description of param1")] string param1,
            [DescribeParameter("Description of param2")] string param2 = "default")
        {
            // Access COMOS via Workset
            var project = Workset.Project;
            // ... your logic ...
            return new { success = true, message = "Done" };
        }
    }
}
```

### Step 2: Compile

```powershell
$CSC = "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
$BIN = "C:\Program Files (x86)\COMOS\Team_AI\Bin"
& $CSC /target:library /optimize+ /out:"$BIN\SDK\AI\MyTool.dll" `
    /reference:"$BIN\Comos.Ai.Functions.dll" `
    /reference:"$BIN\Comos.Ai.Contracts.dll" `
    /reference:"$BIN\Interop.Plt.dll" `
    /reference:"$BIN\Interop.ComosQSGlobalObj.dll" `
    /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll" `
    /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll" `
    "$BIN\SDK\AI\MyTool.cs"
```

### Step 3: Deploy

1. Close COMOS
2. Place `MyTool.dll` in `Bin\SDK\AI\`
3. Restart COMOS — MEF discovers the new DLL automatically

### Key Rules

| Rule | Details |
|------|---------|
| **Workset** | Must have `private get` + `public set` + `static` — or registration silently fails |
| **ToolScope** | Never `"comos"` — that's reserved for native tools |
| **Return types** | Anonymous types with simple fields. Use `string.Join("; ", list)` — never `.ToArray()` |
| **Timeout** | 30s per tool call (hardcoded). Batch `Report.Open/Save/Close` — never per-object |
| **Target** | .NET Framework 4.x only |
| **Directory** | Flat in `Bin\SDK\AI\` — no subdirectories scanned |

---

## 22. Startup & Health Checks

### Start All Services

```powershell
# 1. ServiceiPID Backend (port 8000)
cd "C:\Users\z004uz0p\Downloads\ServiceiPID-main\ServiceiPID"
.\.venv\Scripts\python.exe -m uvicorn backend.backend:app --host 0.0.0.0 --port 8000

# 2. COMOS Gateway (port 8100)
.\.venv\Scripts\python.exe -m uvicorn backend.comos_gateway:app --host 0.0.0.0 --port 8100

# 3. AI API Shim (port 56401)
cd "C:\Program Files (x86)\COMOS\Team_AI\scripts"
node ai-api-shim.js --port 56401 --ai-api-base http://localhost:56400 --gateway-base http://localhost:8100

# 4. COMOS Desktop — start normally (starts :56400 automatically)
```

Or use the convenience script: `ServiceiPID\backend\Start_COMOS_AI.bat`

### Health Checks

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health     # Backend
Invoke-RestMethod http://127.0.0.1:8100/health     # Gateway
Invoke-RestMethod http://127.0.0.1:56401/api/ai/v1/shim-status  # Shim
netstat -ano | Select-String ":8000|:8100|:56400|:56401" | Select-String "LISTEN"
```

### Stop All Services

```powershell
@(56401, 8100, 8000) | ForEach-Object {
    $conn = Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host "Stopped :$_" }
}
```

---

## 23. File Structure

```
C:\Program Files (x86)\COMOS\Team_AI\          ← COMOS 10.7 Repository
├── ARCHITECTURE.md                             ← This document
├── scripts\
│   └── ai-api-shim.js                         ← Smart proxy (~8,440 lines)
├── Bin\
│   ├── Comos.exe                               ← COMOS Desktop (native)
│   ├── Comos.Services.Ai.Api.exe               ← C# AI API (native, port 56400)
│   ├── Comos.EngineeringAssistant.BasicFunctions.dll  ← IL-patched (navigation, attributes)
│   ├── Comos.WPF.ExtendedControls.dll          ← IL-patched (CefSharp flags)
│   ├── SDK\
│   │   └── AI\
│   │       ├── Comos.ServiceiPID.Agent.cs      ← Custom DLL source (import/draw/connect/attrs)
│   │       ├── Comos.ServiceiPID.Agent.dll     ← Compiled custom DLL
│   │       ├── Comos.QueryCreator.Agent.cs     ← Custom DLL source (queries)
│   │       ├── Comos.QueryCreator.Agent.dll    ← Compiled custom DLL
│   │       ├── Comos.TestTool.Agent.cs         ← Test tool source
│   │       ├── Comos.TestTool.Agent.dll        ← Compiled test DLL
│   │       ├── Comos.Query.Agent.dll           ← Built-in (queries)
│   │       ├── Comos.Report.Agent.dll          ← Built-in (reports)
│   │       ├── Comos.Revsioning.Agent.dll      ← Built-in (revisions)
│   │       ├── compile.bat                     ← Roslyn build script
│   │       ├── README_COMOS_AI_Tools.md        ← SDK documentation
│   │       └── _backups\                       ← DLL backups
│   └── ThirdParty\
│       ├── TwoDcChat\
│       │   ├── index.html                      ← Modified (speech-polyfill script tag)
│       │   ├── chat-app.js                     ← Modified (voiceInput, PDF upload, ~1,565 lines)
│       │   ├── chat-widget.js                  ← Native React bundle
│       │   ├── chat-widget.css                 ← Native styles
│       │   └── speech-polyfill.js              ← Custom (MCI + Azure Whisper voice)
│       └── CefSharp\x86\                       ← Native Chromium 136

C:\Users\...\ServiceiPID-main\ServiceiPID\     ← ServiceiPID Repository
├── backend\
│   ├── backend.py                              ← P&ID analysis engine (~6,700 lines)
│   ├── comos_gateway.py                        ← MCP orchestrator (~1,700 lines)
│   ├── mcp_server.py                           ← MCP tool server (~245 lines)
│   ├── system_matcher.py                       ← Embedding-based component matching (~1,280 lines)
│   ├── rag_engine.py                           ← RAG document search engine (~623 lines)
│   ├── referencia_systems.xlsx                 ← P&ID reference data
│   ├── Referencia_systems_electrical.xlsx      ← Electrical reference data
│   ├── ref_embeddings_pid.pkl                  ← Cached P&ID embeddings
│   ├── ref_embeddings_electrical.pkl           ← Cached electrical embeddings
│   ├── rag_documents\                          ← RAG document storage
│   ├── rag_index.pkl                           ← Persisted RAG index
│   ├── start_all_services.ps1                  ← Startup script
│   ├── Start_COMOS_AI.bat                      ← BAT wrapper
│   ├── MCP_SETUP.md                            ← MCP setup guide
│   └── COMOS_GATEWAY_SETUP.md                  ← Gateway setup guide
├── .venv\                                      ← Python virtual environment
└── requirements.txt                            ← Python dependencies
```

---

*Generated on February 26, 2026 by GitHub Copilot (Claude Opus 4.6)*

