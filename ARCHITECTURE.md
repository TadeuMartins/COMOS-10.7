# COMOS AI Engineering Assistant — Arquitetura Completa

> **Autor:** GitHub Copilot  
> **Data:** 16 de Fevereiro de 2026  
> **Versão:** 1.0

---

## Índice

1. [Visão Geral da Arquitetura](#1-visão-geral-da-arquitetura)
2. [Diagrama de Fluxo](#2-diagrama-de-fluxo)
3. [Componentes do Sistema](#3-componentes-do-sistema)
   - 3.1 [COMOS Desktop (C#/.NET) — NATIVO](#31-comos-desktop-cnet--nativo)
   - 3.2 [CefSharp Browser — NATIVO (com patches)](#32-cefsharp-browser--nativo-com-patches)
   - 3.3 [Chat UI (TwoDcChat) — NATIVO + CUSTOMIZADO](#33-chat-ui-twodcchat--nativo--customizado)
   - 3.4 [C# AI API Service (:56400) — NATIVO](#34-c-ai-api-service-56400--nativo)
   - 3.5 [AI API Shim (:56401) — CUSTOMIZADO](#35-ai-api-shim-56401--customizado)
   - 3.6 [COMOS Gateway (:8100) — CUSTOMIZADO](#36-comos-gateway-8100--customizado)
   - 3.7 [ServiceiPID Backend (:8000) — CUSTOMIZADO](#37-serviceipid-backend-8000--customizado)
4. [Arquivos Customizados vs Nativos](#4-arquivos-customizados-vs-nativos)
5. [DLLs Patcheadas (IL Assembly)](#5-dlls-patcheadas-il-assembly)
6. [Voice Input (Entrada por Voz)](#6-voice-input-entrada-por-voz)
7. [Funcionalidades Customizadas do Shim](#7-funcionalidades-customizadas-do-shim)
8. [Endpoints — Referência Completa](#8-endpoints--referência-completa)
9. [Configurações e Variáveis de Ambiente](#9-configurações-e-variáveis-de-ambiente)
10. [Como Inicializar o Sistema](#10-como-inicializar-o-sistema)
11. [Resumo de Tudo que Foi Feito](#11-resumo-de-tudo-que-foi-feito)

---

## 1. Visão Geral da Arquitetura

O sistema é composto por **4 camadas** que se comunicam via HTTP/REST:

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMOS Desktop (.NET/C#)                       │
│  ┌──────────────┐   ┌────────────────────────────────────────┐  │
│  │ COMOS Engine  │   │ CefSharp Browser (Chromium 136)        │  │
│  │  + AI Agent   │   │  ┌──────────────────────────────────┐  │  │
│  │  + DLLs       │   │  │ Chat UI (React)                  │  │  │
│  │  patched      │   │  │  index.html                      │  │  │
│  │               │   │  │  speech-polyfill.js  ←CUSTOM      │  │  │
│  │               │   │  │  chat-widget.js      ←NATIVO      │  │  │
│  │               │   │  │  chat-app.js         ←CUSTOM      │  │  │
│  └──────┬───────┘   │  └──────────────────────────────────┘  │  │
│         │            └─────────────────┬──────────────────────┘  │
└─────────┼──────────────────────────────┼────────────────────────┘
          │ API calls                    │ fetch()
          ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              AI API Shim (Node.js) — porta 56401                │
│              ─────────── CUSTOMIZADO ───────────                 │
│  • Proxy inteligente entre COMOS e LLM                          │
│  • Fabricação de tool calls                                      │
│  • System prompt injection                                       │
│  • Digitização P&ID (two-step)                                  │
│  • Gravação de voz server-side (MCI)                            │
│  • Azure Whisper transcrição                                     │
│  • Fuzzy matching (Levenshtein)                                  │
│  • Budget counter                                                │
└────────┬────────────────────────────┬───────────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────────┐   ┌───────────────────────────────────────┐
│ C# AI API (:56400)  │   │ COMOS Gateway (Python) — porta 8100   │
│ ──── NATIVO ─────   │   │ ────── CUSTOMIZADO ──────              │
│ ValidateConnection  │   │ • Chat com MCP tools                   │
│ Tool definitions    │   │ • Export Excel / VBS                   │
│ COMOS SDK bridge    │   │ • Análise PDF                          │
└─────────────────────┘   └──────────────┬────────────────────────┘
                                         │
                                         ▼
                          ┌───────────────────────────────────────┐
                          │ ServiceiPID Backend — porta 8000       │
                          │ ────── CUSTOMIZADO ──────              │
                          │ • Análise P&ID / Diagramas Elétricos  │
                          │ • OpenCV, PyMuPDF, GPT-5.x            │
                          │ • System matching                      │
                          └───────────────────────────────────────┘
```

---

## 2. Diagrama de Fluxo

### Fluxo de Chat Normal (Tool-Calling)

```
Usuário digita mensagem
    │
    ▼
CefSharp → chat-app.js → fetch POST /api/ai/v1/completions
    │
    ▼
AI API Shim (:56401)
    ├─ Injeta COMOS_SYSTEM_PROMPT (rules 1-12)
    ├─ Detecta intent (contagem? atributo? digitização?)
    ├─ Pode fabricar tool calls sem chamar LLM
    ├─ Normaliza mensagens (PascalCase ↔ camelCase)
    ├─ Enriquece/limpa tool calls (strip systemUID)
    └─ Proxy → Gateway (:8100) ou AI API (:56400)
         │
         ▼
    Gateway executa loop MCP:
         LLM → tool_call → MCP executa → resultado → LLM → ...
         │
         ▼
    Resposta final → Shim adapta formato → CefSharp → UI
```

### Fluxo de Digitização P&ID (Two-Step)

```
Usuário anexa PDF
    │
    ▼
Shim detecta PDF → Step A: "P&ID ou Diagrama Elétrico?"
    │
    ▼
Usuário responde "P&ID"
    │
    ▼
Shim → Step B: POST /comos/analyze-direct (Gateway :8100)
    │
    ▼
Gateway → ServiceiPID (:8000) POST /analyze
    │
    ▼
Resultado (Excel + links download) → Usuário
```

### Fluxo de Voice Input (Entrada por Voz)

```
Usuário clica 🎤
    │
    ▼
speech-polyfill.js → POST /api/ai/v1/mic/start
    │
    ▼
Shim spawna PowerShell + MCI (winmm.dll)
    → Grava do microfone padrão do Windows
    │
Usuário clica 🎤 novamente (stop)
    │
    ▼
speech-polyfill.js → POST /api/ai/v1/mic/stop
    │
    ▼
Shim: para gravação → salva WAV → envia para Azure Whisper
    │
    ▼
Whisper retorna texto → Shim responde { text: "..." }
    │
    ▼
polyfill dispara onresult → W2 hook atualiza transcript
    │ (120ms delay antes de onend)
    ▼
useEffect copia transcript → input field → Usuário vê texto
```

---

## 3. Componentes do Sistema

### 3.1 COMOS Desktop (C#/.NET) — NATIVO

| Item | Detalhes |
|------|---------|
| **Executável** | `Comos.exe` |
| **AI Agent** | `Comos.EngineeringAssistant.BasicFunctions.dll` (patcheado) |
| **Config** | `Bin\agent.conf` — porta 8080, assemblies no diretório atual |
| **Protocolo** | O COMOS .NET chama `/api/ai/v1/completions` com formato proprietário (PascalCase aliases) |
| **Limitação** | Máximo **3 iterações** por mensagem do usuário (incluindo resposta final de texto) |

### 3.2 CefSharp Browser — NATIVO (com patches)

| Item | Detalhes |
|------|---------|
| **Diretório** | `Bin\ThirdParty\CefSharp\x86\` |
| **Engine** | Chromium 136 |
| **Esquema** | `localfolder://twodcvisualizer` — **NÃO é secure context** |
| **Consequência** | `navigator.mediaDevices.getUserMedia()` indisponível |
| **Patches aplicados** | Flags `--enable-media-stream`, `--use-fake-ui-for-media-stream` (no DLL via IL) |
| **Nota** | Flags sozinhas são insuficientes; a solução final foi gravação server-side |

### 3.3 Chat UI (TwoDcChat) — NATIVO + CUSTOMIZADO

**Diretório:** `Bin\ThirdParty\TwoDcChat\`

| Arquivo | Status | Descrição |
|---------|--------|-----------|
| `index.html` | **CUSTOMIZADO** | Adicionado `<script src="speech-polyfill.js?v=4">` |
| `chat-widget.js` | **NATIVO** | React bundle — W2 hook (SpeechRecognition), Xf component (chat principal), I_ component (input bar) |
| `chat-widget.css` | **NATIVO** | Estilos do widget |
| `chat-app.js` | **CUSTOMIZADO** | Configuração do widget — `voiceInput: true`, endpoints, event handlers |
| `speech-polyfill.js` | **CUSTOMIZADO** (novo) | Polyfill SpeechRecognition via MCI + Azure Whisper |

**Configuração do Widget (chat-app.js):**
```javascript
{
    title: 'COMOS Engineering Copilot',
    features: {
        conversationSidebar: true,
        messageSearch: false,
        fileUpload: true,
        voiceInput: true          // ← CUSTOMIZADO (era false)
    }
}
```

### 3.4 C# AI API Service (:56400) — NATIVO

| Item | Detalhes |
|------|---------|
| **Executável** | `Comos.Services.Ai.Api.exe` |
| **Config** | `Comos.Services.Ai.Api.exe.config` |
| **Porta** | 56400 |
| **Função** | Bridge entre COMOS SDK e o mundo exterior |
| **Responsável por** | Validação de conexão (`HEAD /api/ai/v1/completions`), definição de tools COMOS, execução de tool calls no SDK |
| **Probing** | `ThirdParty\Microsoft`, `ThirdParty\Swashbuckle` |

### 3.5 AI API Shim (:56401) — CUSTOMIZADO

| Item | Detalhes |
|------|---------|
| **Arquivo** | `scripts\ai-api-shim.js` (~5.234 linhas) |
| **Runtime** | Node.js |
| **Porta** | 56401 (default) |
| **Logs** | `%TEMP%\comos_ai_shim\ai_api_shim.log` |
| **Request log** | `%TEMP%\comos_ai_shim\requests.jsonl` |

**Modos de operação:**
1. **Chat normal** — proxy inteligente com injeção de system prompt e fabricação de tool calls
2. **Digitização** — two-step flow (detecta PDF → pergunta tipo → analisa)
3. **Gravação de voz** — MCI recording + Azure Whisper

**Funcionalidades completas detalhadas na [Seção 7](#7-funcionalidades-customizadas-do-shim).**

### 3.6 COMOS Gateway (:8100) — CUSTOMIZADO

| Item | Detalhes |
|------|---------|
| **Arquivo** | `comos_gateway.py` (no projeto ServiceiPID) |
| **Framework** | FastAPI + Uvicorn |
| **Porta** | 8100 (`COMOS_GATEWAY_PORT`) |
| **Modelo LLM** | `gpt-5` (Azure OpenAI) |
| **Protocol** | MCP (Model Context Protocol) via `stdio_client` |

**Função:** Endpoint OpenAI-compatible que executa loop de tool-calling com MCP tools do ServiceiPID.

**System Prompt:** Assistente de engenharia industrial integrado com COMOS. Responde em português brasileiro por padrão.

### 3.7 ServiceiPID Backend (:8000) — CUSTOMIZADO

| Item | Detalhes |
|------|---------|
| **Arquivo** | `backend\backend.py` (no projeto ServiceiPID) |
| **Framework** | FastAPI + Uvicorn |
| **Porta** | 8000 |
| **Modelo primário** | `gpt-5.2` (`PRIMARY_MODEL`) |
| **Modelo fallback** | `gpt-5.1` (`FALLBACK_MODEL`) |
| **Dependências** | PIL, PyMuPDF (fitz), httpx, openai, numpy, OpenCV (cv2), pdf2image, pypdf |
| **Função** | Análise de P&ID e diagramas elétricos, geração de diagramas, matching de componentes |

---

## 4. Arquivos Customizados vs Nativos

### Arquivos CUSTOMIZADOS (criados ou modificados)

| Arquivo | Tipo | Localização |
|---------|------|-------------|
| `ai-api-shim.js` | Criado | `scripts\` |
| `speech-polyfill.js` | Criado | `Bin\ThirdParty\TwoDcChat\` |
| `chat-app.js` | Modificado | `Bin\ThirdParty\TwoDcChat\` (voiceInput: true) |
| `index.html` | Modificado | `Bin\ThirdParty\TwoDcChat\` (script tag speech-polyfill) |
| `comos_gateway.py` | Criado | Projeto ServiceiPID |
| `backend.py` | Criado | Projeto ServiceiPID |
| `mcp_server.py` | Criado | Projeto ServiceiPID |
| `BasicFunctions.dll` | Patcheado (IL) | `Bin\` (3 versões) |
| `ExtendedControls.dll` | Patcheado (IL) | `Bin\` (CefSharp flags) |

### Arquivos NATIVOS (não modificados)

| Arquivo | Localização |
|---------|-------------|
| `chat-widget.js` | `Bin\ThirdParty\TwoDcChat\` |
| `chat-widget.css` | `Bin\ThirdParty\TwoDcChat\` |
| `Comos.Services.Ai.Api.exe` | `Bin\` |
| `Comos.Services.Ai.Api.exe.config` | `Bin\` |
| `agent.conf` | `Bin\` |
| Todo o diretório CefSharp | `Bin\ThirdParty\CefSharp\x86\` |
| COMOS Engine e demais DLLs | `Bin\` |

---

## 5. DLLs Patcheadas (IL Assembly)

Todas as DLLs foram patcheadas usando `ildasm` (disassemble) → edição manual do `.il` → `ilasm` (reassemble).

### 5.1 Comos.EngineeringAssistant.BasicFunctions.dll

**Workspace de patch:** `%TEMP%\comos_patch\`

| Versão | Arquivo de Backup | Modificação |
|--------|-------------------|-------------|
| **Original** | `.dll.original` | Backup do DLL nativo |
| **v1** | `.dll.locked` / `.dll.locked_20260216_201625` | Adicionado `search_spec_recursive` — busca recursiva de especificações até 10 níveis de profundidade |
| **v2** | `.dll.locked_v2` / `.dll.locked_v2_20260216_202953` | Corrigido cast `isinst` quebrado em `ValueOfAttributeWithNameOrDescription` |
| **v3** | (versão ativa) | Adicionada concatenação de unidade (`sp.get_Unit()`) — valores retornados agora incluem a unidade (ex: "100 kW" em vez de "100") |

**Métodos alterados:**
- `SearchSpecRecursive` — helper recursivo para busca de specs
- `ValueOfAttributeWithNameOrDescription` — cast fix + unit concatenation
- `NavigateToAttributeByNameOrDescription` — integração com busca recursiva

### 5.2 Comos.WPF.ExtendedControls.dll

| Versão | Modificação |
|--------|-------------|
| **Original** | `.dll.original` — backup |
| **Patch** | Adicionadas flags CefSharp: `--enable-media-stream`, `--use-fake-ui-for-media-stream`, `--unsafely-treat-insecure-origin-as-secure=localfolder://twodcvisualizer` |

> **Nota:** Essas flags do CefSharp não são suficientes para resolver o problema do `getUserMedia` em `localfolder://`. A solução final foi a gravação server-side via MCI.

---

## 6. Voice Input (Entrada por Voz)

### Problema

O CefSharp carrega páginas via `localfolder://`, que **não é um secure context** no Chromium 136+. Consequências:
- `navigator.mediaDevices.getUserMedia()` fica **completamente indisponível**
- `SpeechRecognition.start()` dispara erro `"not-allowed"` mesmo com a classe existindo globalmente
- Nenhuma flag CefSharp resolve isso

### Solução: Gravação Server-Side (MCI + Azure Whisper)

```
Browser (CefSharp)                    Servidor (Node.js Shim)
─────────────────                    ──────────────────────────
speech-polyfill.js                   ai-api-shim.js
     │                                    │
     │  POST /mic/start ──────────►      │ Spawna PowerShell
     │                                    │ MCI: open waveaudio
     │                                    │ MCI: record capture
     │     "Recording..."                 │ Grava do mic Windows
     │                                    │
     │  POST /mic/stop ───────────►      │ MCI: stop capture
     │                                    │ MCI: save WAV
     │                                    │ Envia WAV → Azure Whisper
     │      { text: "Hello" }    ◄────── │ Retorna transcrição
     │                                    │
     │  onresult({ transcript })          │
     │  [120ms delay]                     │
     │  onend()                           │
     │                                    │
     │  useEffect copia para input        │
     ▼                                    ▼
```

### Componentes da Solução

1. **`speech-polyfill.js`** — substitui incondicionalmente `window.SpeechRecognition` e `window.webkitSpeechRecognition` com `WhisperSpeechRecognition`
2. **MCI (winmm.dll)** — grava áudio do microfone padrão do Windows via PowerShell + P/Invoke
3. **Azure Whisper** — transcreve o WAV em texto

### Timing Crítico (React 18 Batching Fix)

O widget React usa um `useEffect` que só copia transcript → input **enquanto `isListening` é `true`**:
```javascript
useEffect(() => {
    W && M && f !== W && (h(W), g(tg(W)))
}, [W, M, f, h, g])
```

Se `onresult` e `onend` dispararem no mesmo tick, React batcha as atualizações e o `useEffect` vê `isListening=false` → transcript é perdido. Solução: **120ms de delay** entre `onresult` e `_fireEnd()`.

---

## 7. Funcionalidades Customizadas do Shim

### 7.1 System Prompt Injection

O shim injeta `COMOS_SYSTEM_PROMPT` em toda chamada `/completions`. Contém 12+ regras:

| Regra | Descrição |
|-------|-----------|
| **1** | Só usar tools do array `tools` |
| **2** | Nunca mencionar PDF/P&ID/ServiceiPID |
| **7** | Máximo 1 tool call por resposta |
| **8** | Até 4 retentativas para lookup de atributos |
| **10** | Ordem de preferência para tools de navegação |
| **11** | Attribute lookups devem ser chamados imediatamente, sem confirmação |
| **11a-11f** | Sub-regras de retry, contagem (PT+EN), contagem filtrada, report obrigatório |
| **12** | Operações de escrita só com tool dedicado |

### 7.2 Fabricação de Tool Calls

O shim pode fabricar tool calls **sem chamar o LLM**, retornando diretamente ao COMOS:

| Cenário | Fabricação |
|---------|------------|
| **Contagem de equipamentos** | Detecta "quantos pumps?" → fabrica `get_count_of_comos_objects_with_name({objectName: "pump"})` |
| **Atributo VALUE** | Detecta "qual a potência?" → fabrica `ValueOfAttributeWithNameOrDescription({attributeName: "shaft power"})` |
| **Atributo NAVIGATION** | Detecta "navegar para pressão" → fabrica `NavigateToAttributeByNameOrDescription({attributeName: "pressure"})` |
| **Follow-up confirmation** | Detecta "sim" após contagem pendente → fabrica tool call |
| **Auto-retry** | Atributo retorna "not found" → fabrica retry com alternativas |

### 7.3 Detecção de Intent Bilíngue (PT + EN)

| Função | Propósito |
|--------|-----------|
| `isObjectCountIntent(text)` | Detecta "how many" / "quantos" / "contagem" / "qtd" |
| `extractObjectNameForCountQuery(text)` | Extrai nome do objeto da query de contagem |
| `normalizeLooseCountTarget(value)` | Mapeia plurais → singular (EN + PT) |
| `isFilteredObjectCountIntent(text)` | Detecta contagem com filtro (ex: "quantas bombas com 100 kW") |
| `isFollowUpConfirmation(text)` | Detecta "sim" / "yes" / "ok" / "pode" / "go ahead" |

### 7.4 Normalização de Equipamentos

Mapa bilíngue que normaliza nomes de equipamentos para a forma canônica:
```javascript
{ pumps: "pump", bombas: "bomba", válvulas: "válvula",
  motors: "motor", motores: "motor", instruments: "instrument", ... }
```

### 7.5 Fuzzy Matching (Levenshtein)

- `levenshteinDistance(a, b)` — distância de edição DP
- `generateAttributeAlternatives(name)` — gera aliases para nomes de atributos
- Mapa de aliases bilíngue: "shaft power", "pressure", "temperatura", etc.
- Tolerance: Levenshtein ≤ 2 (corrige typos como "Shatf Power" → "Shaft Power")

### 7.6 Budget Counter (Anti-Loop)

- COMOS .NET permite máximo **3 iterações** por mensagem
- O shim conta tool calls fabricados com prefixo `call_shim_`
- Limite: **2 fabricações** máximas (a 3ª iteração é para a resposta textual)
- Evita loops infinitos de re-fabricação

### 7.7 Stripping de systemUID

O shim **remove** qualquer `systemUID` que o LLM alucine em tool calls de navegação de atributos. Motivo:
- DLL path #1: `LoadObjectByType(systemUID)` → frequentemente falha
- DLL path #2: `get_navigator_selected_object()` → funciona após navegação
- Sem systemUID → DLL usa path #2 (mais confiável)

### 7.8 Adaptação de Formato COMOS

O COMOS .NET espera formato proprietário com aliases PascalCase. O shim:
- Normaliza mensagens de entrada: `function_call` legacy → `tool_calls` moderno
- Adapta respostas: adiciona `Role`, `Content`, `FunctionCall`, `toolCalls` (PascalCase)
- Repara tool messages órfãs (sem `tool_calls[].id` correspondente)

### 7.9 Digitização Two-Step

1. Detecta PDF anexado na mensagem
2. **Step A:** Pergunta ao usuário: "P&ID ou Diagrama Elétrico?"
3. **Step B:** Envia PDF + tipo para Gateway → ServiceiPID → análise completa
4. Retorna links de download (Excel, VBS import script)

### 7.10 force_tool_choice_none

Quando a última mensagem é um resultado de tool, o shim força `tool_choice: "none"` para obrigar o LLM a produzir resposta textual. **Exceção:** se o resultado é navegação com sucesso E há query de atributo pendente → permite encadear navigate → attribute lookup.

---

## 8. Endpoints — Referência Completa

### AI API Shim (:56401)

| Método | Path | Descrição |
|--------|------|-----------|
| `HEAD` | `/api/ai/v1/completions` | Validação de conexão (COMOS .NET) |
| `OPTIONS` | `*` | CORS preflight |
| `POST` | `/api/ai/v1/completions` | **Chat principal** — digitização + tool-calling + proxy |
| `POST` | `/api/ai/v1/completions/generate-title` | Gerar título de conversa |
| `POST` | `/api/ai/v1/transcribe` | Speech-to-text via Azure Whisper |
| `POST` | `/api/ai/v1/mic/start` | Iniciar gravação de microfone (MCI) |
| `POST` | `/api/ai/v1/mic/stop` | Parar gravação + transcrever |
| `POST` | `/api/ai/v1/mic/abort` | Cancelar gravação |
| `POST` | `/api/ai/v1/save-download` | Salvar arquivo em disco |
| `POST` | `/api/ai/v1/attach-pdf` | Pré-carregar PDF para próxima mensagem |
| `POST` | `/api/ai/v1/upload-pdf` | Upload direto de PDF |
| `GET` | `/api/ai/v1/shim-status` | Status/debug do shim |
| `GET` | `/comos/download/:id` | Proxy download → gateway |
| `POST` | `/comos/export-excel` | Proxy export Excel → gateway |
| `POST` | `/comos/generate-import-script` | Proxy VBS script → gateway |
| `*` | `*` | Default: proxy → AI API (:56400) |

### Gateway (:8100)

| Método | Path | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check |
| `GET` | `/comos/tools` | Listar MCP tools disponíveis |
| `POST` | `/comos/chat` | Chat COMOS (com MCP tool loop) |
| `POST` | `/v1/chat/completions` | Chat OpenAI-compatible (com MCP) |
| `POST` | `/v1/chat/completion` | Alias do acima |
| `POST` | `/v1/chat/completions/raw` | LLM passthrough direto (sem MCP) |
| `POST` | `/comos/analyze-direct` | Análise direta de PDF |
| `POST` | `/comos/generate-circuit` | Gerar circuito |
| `POST` | `/comos/match-component` | Matching de componentes |
| `POST` | `/comos/export-excel` | Export Excel com tabela de confiança |
| `GET` | `/comos/download/{file_id}` | Download de arquivo gerado |
| `GET` | `/comos/excel-path/{file_id}` | Obter path do Excel |
| `POST` | `/comos/generate-import-script` | Gerar script VBS de importação COMOS |

### ServiceiPID Backend (:8000)

| Método | Path | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check |
| `GET` | `/ping` | Ping |
| `GET` | `/progress` | Tracking de progresso |
| `POST` | `/analyze` | **Análise principal** de P&ID/diagramas |
| `POST` | `/generate` | Gerar diagrama |
| `GET` | `/describe` | Descrever P&ID |
| `POST` | `/chat` | Chat sobre P&IDs |
| `POST` | `/store` | Armazenar dados |
| `POST` | `/enable_cv2` | Habilitar OpenCV |

---

## 9. Configurações e Variáveis de Ambiente

### Azure OpenAI

| Configuração | Valor |
|-------------|-------|
| **Endpoint** | `https://openai-aittack-msa-001070-swedencentral-aifordipaswidser-00.openai.azure.com` |
| **API Key** | `arquivo .env` |
| **API Version** | `2024-12-01-preview` |
| **Modelo Chat** | `gpt-5` |

### Azure Whisper (Speech-to-Text)

| Configuração | Valor |
|-------------|-------|
| **Endpoint** | `https://openai-aittack-msa-001070-swedencentral-aifordipaswidser-00.cognitiveservices.azure.com` |
| **Deployment** | `whisper` |
| **API Version** | `2024-06-01` |
| **API Key** | mesma da Azure OpenAI |

### Variáveis de Ambiente do Gateway

| Variável | Default | Descrição |
|----------|---------|-----------|
| `COMOS_GATEWAY_PORT` | `8100` | Porta do gateway |
| `COMOS_GATEWAY_HOST` | `0.0.0.0` | Host do gateway |
| `COMOS_GATEWAY_MODEL` | `gpt-5` | Modelo LLM |
| `COMOS_MCP_COMMAND` | `sys.executable` | Comando MCP |
| `COMOS_MCP_ARGS` | `-m backend.mcp_server` | Args MCP |
| `COMOS_MCP_TOOL_TIMEOUT_S` | `600` | Timeout de tool (s) |
| `COMOS_TOOL_RESULT_CHAR_LIMIT` | `12000` | Limite chars por tool result |
| `SERVICEIPID_API_BASE_URL` | `http://127.0.0.1:8000` | URL do ServiceiPID |

### Variáveis do ServiceiPID Backend

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PRIMARY_MODEL` | `gpt-5.2` | Modelo primário |
| `FALLBACK_MODEL` | `gpt-5.1` | Modelo fallback |
| `OPENAI_REQUEST_TIMEOUT` | `600` | Timeout (s) |

---

## 10. Como Inicializar o Sistema

### Ordem de Inicialização

**Os serviços devem ser iniciados nesta ordem:**

```
1. ServiceiPID Backend (:8000)  ← deve subir primeiro (dependência do Gateway)
2. COMOS Gateway (:8100)        ← depende do Backend
3. AI API Shim (:56401)         ← depende do Gateway e AI API
4. COMOS Desktop                ← depende do Shim e AI API (:56400)
```

### Comandos

#### 1. ServiceiPID Backend (porta 8000)

```powershell
cd "c:\Users\z004uz0p\Downloads\ServiceiPID-main\ServiceiPID"
.\.venv\Scripts\python.exe -m uvicorn backend.backend:app --host 0.0.0.0 --port 8000
```

#### 2. COMOS Gateway (porta 8100)

```powershell
cd "c:\Users\z004uz0p\Downloads\ServiceiPID-main\ServiceiPID"
.\.venv\Scripts\python.exe -m uvicorn backend.comos_gateway:app --host 0.0.0.0 --port 8100
```

#### 3. AI API Shim (porta 56401)

```powershell
cd "c:\Program Files (x86)\COMOS\Team_AI\scripts"
node ai-api-shim.js --port 56401 --ai-api-base http://localhost:56400 --gateway-base http://localhost:8100
```

> O C# AI API (:56400) é iniciado automaticamente pelo COMOS Desktop.

#### 4. COMOS Desktop

Iniciar o COMOS normalmente através do atalho ou `Comos.exe`.

### Verificação de Saúde

```powershell
# Verificar todas as portas
netstat -ano | Select-String "LISTENING" | Select-String ":8000|:8100|:56400|:56401"

# Health checks
Invoke-RestMethod http://127.0.0.1:8000/health    # ServiceiPID
Invoke-RestMethod http://127.0.0.1:8100/health    # Gateway
Invoke-RestMethod http://127.0.0.1:56401/api/ai/v1/shim-status  # Shim
```

### Parar Tudo

```powershell
# Parar Shim
$sh = Get-NetTCPConnection -LocalPort 56401 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($sh) { Stop-Process -Id $sh.OwningProcess -Force }

# Parar Gateway
$gw = Get-NetTCPConnection -LocalPort 8100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gw) { Stop-Process -Id $gw.OwningProcess -Force }

# Parar Backend
$be = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($be) { Stop-Process -Id $be.OwningProcess -Force }
```

---

## 11. Resumo de Tudo que Foi Feito

### Fase 1 — Inteligência do Shim (Tool-Calling e Intent Detection)

1. **Detecção de intent de contagem bilíngue (PT + EN)** — o shim detecta perguntas como "quantos pumps?" e fabrica tool calls automaticamente sem chamar o LLM
2. **Normalização de equipamentos** — mapa bilíngue que converte plurais e variações para a forma canônica (ex: "bombas" → "bomba", "pumps" → "pump")
3. **Confirmação de follow-up** — detecta respostas curtas ("sim", "ok", "yes") e associa com intenção pendente na conversa
4. **`buildFabricatedToolCallResponse()`** — constrói respostas de tool call no formato exato que o COMOS .NET espera (PascalCase + camelCase aliases)
5. **Fix de loop infinito de re-fabricação** — sistema de budget counter para evitar loops
6. **`extractLastSystemUidFromConversation()`** — rastreia qual objeto COMOS está selecionado no momento
7. **`enrichAttributeToolCalls()`** — remove systemUIDs alucinados pelo LLM para forçar uso do path mais confiável (objeto selecionado no navigator)
8. **System prompt com 12+ regras** — injection em toda chamada, com regras 11a-11f para atributos
9. **Fix de LLM recusando attribute tools** — rules 11a-11f para forçar uso imediato sem confirmação
10. **Fabricação de tool calls para VALUE e NAVIGATION de atributos** — detecção de intent → fabricação direta
11. **Auto-retry de atributos** — quando "not found" → tenta com alternativas
12. **Smart `force_tool_choice_none`** — exceção para permitir encadeamento navigate → attribute
13. **Budget counter com LIMIT_REACHED** — limita a 2 fabricações por mensagem
14. **Fuzzy matching Levenshtein** — corrige typos em nomes de atributos (distância ≤ 2)
15. **Remoção de systemUID de todas as chamadas de atributo** — fix global

### Fase 2 — Patches de DLL (IL Assembly)

16. **DLL v1** — `search_spec_recursive`: helper recursivo para busca de especificações até 10 níveis de profundidade. Resolveu o problema de atributos não encontrados em objetos com specs aninhadas
17. **DLL v2** — Fix de cast `isinst` quebrado em `ValueOfAttributeWithNameOrDescription` que causava crash
18. **DLL v3** — Concatenação de unidade (`sp.get_Unit()`) — valores retornam com unidade (ex: "100 kW" em vez de "100")

> Todos os patches via workflow: `ildasm` → edição `.il` → `ilasm` → deploy

### Fase 3 — Voice Input (Entrada por Voz)

19. **Habilitação do botão de voz** — `voiceInput: false` → `true` em `chat-app.js`
20. **Patches CefSharp** — flags `--enable-media-stream`, `--use-fake-ui-for-media-stream`, `--unsafely-treat-insecure-origin-as-secure` no DLL `ExtendedControls`
21. **Descoberta:** CefSharp `localfolder://` não é secure context — `getUserMedia` é fundamentalmente indisponível no Chromium 136+, nenhuma flag resolve
22. **Solução server-side: Gravação MCI** — 3 novos endpoints no shim (`mic/start`, `mic/stop`, `mic/abort`) usando PowerShell + `winmm.dll` (MCI) para gravar do microfone padrão do Windows
23. **Criação do `speech-polyfill.js`** — polyfill que substitui `SpeechRecognition` nativa pela pipeline server-side (MCI + Azure Whisper)
24. **Endpoint `/api/ai/v1/transcribe`** — transcrição via Azure Whisper (deployment `whisper`, API version `2024-06-01`)
25. **Testes confirmados:** gravação funcional (WAV 38-57KB), transcrição precisa ("HELLO HELLO HELLO HELLO", "Hello. Hello.")
26. **Fix "Microphone access denied"** — Chromium 136 define `SpeechRecognition` globalmente mesmo em non-secure contexts, mas `start()` dispara `not-allowed`. Fix: instalação INCONDICIONAL do polyfill (sempre sobrescreve os globals)
27. **Fix "Transcript not appearing in chat"** — React 18 batching: `onresult` e `onend` disparavam synchronously → `useEffect` via `isListening=false` antes de processar transcript. Fix: 120ms `setTimeout` entre `onresult` e `_fireEnd()`
28. **Cache-busting** — `speech-polyfill.js?v=4` em index.html para forçar reload

### Fase 4 — Documentação

29. **Documento de arquitetura** — este documento (`ARCHITECTURE.md`)

---

## Apêndice: Estrutura de Diretórios

```
C:\Program Files (x86)\COMOS\Team_AI\
├── ARCHITECTURE.md               ← ESTE DOCUMENTO
├── scripts\
│   └── ai-api-shim.js            ← CUSTOMIZADO (5.234 linhas)
├── Bin\
│   ├── agent.conf                ← NATIVO (porta 8080)
│   ├── Comos.exe                 ← NATIVO
│   ├── Comos.Services.Ai.Api.exe ← NATIVO (porta 56400)
│   ├── Comos.EngineeringAssistant.BasicFunctions.dll      ← PATCHEADO v3
│   ├── Comos.EngineeringAssistant.BasicFunctions.dll.*    ← backups (original, locked, v2)
│   ├── Comos.WPF.ExtendedControls.dll                     ← PATCHEADO (CefSharp flags)
│   ├── Comos.WPF.ExtendedControls.dll.original            ← backup
│   └── ThirdParty\
│       ├── TwoDcChat\
│       │   ├── index.html            ← CUSTOMIZADO (script tag adicionada)
│       │   ├── chat-app.js           ← CUSTOMIZADO (voiceInput: true)
│       │   ├── chat-widget.js        ← NATIVO (React bundle)
│       │   ├── chat-widget.css       ← NATIVO
│       │   └── speech-polyfill.js    ← CUSTOMIZADO (novo, MCI+Whisper)
│       └── CefSharp\x86\            ← NATIVO (Chromium 136)
│
C:\Users\z004uz0p\Downloads\ServiceiPID-main\ServiceiPID\
├── backend\
│   ├── backend.py                ← CUSTOMIZADO (porta 8000)
│   ├── comos_gateway.py          ← CUSTOMIZADO (porta 8100)
│   └── mcp_server.py             ← CUSTOMIZADO (MCP tools)
└── .venv\                        ← Python virtual environment
```

---

*Documento gerado em 16/02/2026 por GitHub Copilot (Claude Opus 4.6)*
