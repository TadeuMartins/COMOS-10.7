# COMOS 10.7 — Team_AI Repository

## Visão Geral

Este repositório contém a instalação completa do **COMOS 10.7** com as customizações de IA (AI Engineering Assistant), incluindo:
- **AI API Shim** (Node.js) — proxy inteligente com detecção de intenção, fabricação de tool calls, RAG, voz
- **C# Agent DLLs** — ferramentas de importação, desenho e conexão em P&IDs
- **Chat UI** (CefSharp) — interface de chat embarcada no COMOS Desktop
- **Scripts de diagnóstico e teste**

---

## Estatísticas do Repositório

| Métrica | Valor |
|---------|-------|
| **Arquivos no repositório** | **4.806** |
| **Tamanho total (tracked)** | **~1.5 GB** |
| **Arquivos excluídos (.gitignore)** | 1.683 |
| **Tamanho excluído** | ~3.1 GB |

### Distribuição por pasta

| Pasta | Arquivos | Descrição |
|-------|----------|-----------|
| `Bin/` | 3.684 | Executáveis, DLLs, configurações, SDK/AI, ThirdParty |
| `ComosServices/` | 777 | Gateway, Hosting, plugins |
| `THIRDPARTYADDINS/` | 128 | SISAgents, DEXPI Toolbox |
| `Web/` | 94 | Worker, Client App |
| `config/` | 64 | Configurações COMOS |
| `scripts/` | 36 | **AI Shim**, startup, testes |
| `SDK/` | 14 | Kernel headers, lib |
| `ThirdParty Licenses/` | 3 | Licenças |
| Root | 5 | ARCHITECTURE.md, .gitignore, etc. |

### Distribuição por tipo de arquivo

| Extensão | Qtd | Exemplos |
|----------|-----|----------|
| `.dll` | 3.382 | Binários COMOS, ThirdParty, Agent DLLs |
| `.tlb` | 404 | Type libraries |
| `.ocx` | 217 | ActiveX controls |
| `.tx` | 123 | Kernel modules |
| `.config` | 67 | Configurações .NET |
| `.xml` | 66 | Definições, schemas |
| `.exe` | 58 | Executáveis |
| `.pak` | 58 | CefSharp resources |
| `.js` | 11 | **ai-api-shim.js**, chat-widget, etc. |
| `.ps1` | 8 | Scripts PowerShell |
| `.cs` | 3+ | **C# Agent source** |
| `.md` | 3+ | Documentação |

---

## Arquivos Excluídos (.gitignore)

Os seguintes arquivos **NÃO estão no repositório** (regeneráveis/muito grandes):

| Categoria | Arquivos | Tamanho | Motivo |
|-----------|----------|---------|--------|
| `*.pdb` (debug symbols) | 1.364 | ~2.1 GB | Regeneráveis via compilação |
| `Bin/ComosTestRunner/` | ~35 | ~850 MB | Test runners, não necessários em produção |
| `libcef.dll` (CefSharp) | 1 | 187 MB | Excede limite GitHub (100 MB) |
| `*.pyc` (Python cache) | 85 | < 1 MB | Regeneráveis automaticamente |
| `*.log`, `Thumbs.db`, etc. | ~5 | < 1 MB | Temporários |
| **TOTAL** | **1.683** | **~3.1 GB** | |

---

## Arquivos de Customização AI (Chave)

Estes são os arquivos **criados/modificados** pela equipe de IA. São o diferencial em relação à instalação COMOS vanilla:

### Core — AI API Shim
| Arquivo | Descrição |
|---------|-----------|
| `scripts/ai-api-shim.js` | Proxy inteligente Node.js (porta 56401) — detecção de intenção, tool fabrication, RAG, voz |
| `scripts/package.json` | Dependências Node.js do shim |
| `scripts/start-ai-api-localhost.ps1` | Script de inicialização do shim |

### C# Agent DLLs
| Arquivo | Descrição |
|---------|-----------|
| `Bin/SDK/AI/Comos.ServiceiPID.Agent.cs` | Source — importar, desenhar, conectar objetos em P&IDs |
| `Bin/SDK/AI/Comos.ServiceiPID.Agent.dll` | DLL compilada (ativa) |
| `Bin/SDK/AI/Comos.QueryCreator.Agent.cs` | Source — criação de queries SQL |
| `Bin/SDK/AI/Comos.QueryCreator.Agent.dll` | DLL compilada |
| `Bin/SDK/AI/compile.bat` | Script de compilação Roslyn |
| `Bin/SDK/AI/README_COMOS_AI_Tools.md` | Guia completo para criar COMOS AI tools |
| `Bin/SDK/AI/_backups/` | Backups versionados das DLLs |

### Chat UI
| Arquivo | Descrição |
|---------|-----------|
| `Bin/ThirdParty/TwoDcChat/chat-app.js` | Configuração do widget (voiceInput, etc.) |
| `Bin/ThirdParty/TwoDcChat/chat-widget.js` | Lógica do widget de chat |
| `Bin/ThirdParty/TwoDcChat/chat-widget.css` | Estilo do widget |
| `Bin/ThirdParty/TwoDcChat/speech-polyfill.js` | Polyfill de voz (MCI + Azure Whisper) |
| `Bin/ThirdParty/TwoDcChat/index.html` | Página do chat |

### DLL Nativa Patchada
| Arquivo | Descrição |
|---------|-----------|
| `Bin/Comos.EngineeringAssistant.BasicFunctions.dll` | DLL IL-patchada (navegação, atributos, contagem) |

### Configuração e Documentação
| Arquivo | Descrição |
|---------|-----------|
| `.github/copilot-instructions.md` | Instruções do Copilot para o projeto |
| `ARCHITECTURE.md` | Documentação completa da arquitetura |
| `Bin/Comos.Services.Ai.Api.exe.config` | Config do AI API service |

---

## Como Usar — Mesclar com Instalação COMOS Vanilla

### Pré-requisitos
- COMOS 10.7 instalado (instalação padrão Siemens)
- Node.js 18+ (para o shim)
- Python 3.11+ com venv (para o Backend/Gateway ServiceiPID)
- .NET Framework 4.x (para compilar agent DLLs)

### Passos para mesclar

```powershell
# 1. Clone o repositório
git clone https://github.com/TadeuMartins/COMOS-10.7.git

# 2. Entre no diretório
cd COMOS-10.7

# 3. Compare com sua instalação COMOS vanilla
# Os arquivos no repo devem SOBRESCREVER os da instalação,
# exceto os excluídos (.pdb, ComosTestRunner, libcef.dll)
# que permanecem da instalação original.
```

### Estratégia de merge

1. **Copie a instalação COMOS vanilla** para uma pasta de trabalho
2. **Extraia o repositório** sobre ela (sobrescrevendo arquivos existentes)
3. **Restaure os arquivos excluídos** da instalação original:
   - `*.pdb` — já existem na instalação vanilla
   - `Bin/ComosTestRunner/` — já existe
   - `Bin/ThirdParty/CefSharp/x86/libcef.dll` — já existe
4. **Instale dependências Node.js:**
   ```powershell
   cd scripts
   npm install
   ```
5. **Configure o Backend ServiceiPID** (repositório separado: [ServiceiPID](https://github.com/TadeuMartins/ServiceiPID))

### Ordem de inicialização dos serviços

```
Backend (:8000) → Gateway (:8100) → Shim (:56401) → COMOS Desktop (:56400 auto)
```

```powershell
# Health checks
Invoke-RestMethod http://127.0.0.1:8000/health     # Backend
Invoke-RestMethod http://127.0.0.1:8100/health     # Gateway
Invoke-RestMethod http://127.0.0.1:56401/api/ai/v1/shim-status  # Shim
```

---

## Repositórios Relacionados

| Repositório | Descrição |
|-------------|-----------|
| [ServiceiPID](https://github.com/TadeuMartins/ServiceiPID) | Backend Python (FastAPI) — P&ID analysis, RAG engine, COMOS Gateway |
| **COMOS-10.7** (este) | Instalação COMOS completa com customizações AI |

---

*Repositório criado em 21/02/2026. Última atualização: 21/02/2026.*
