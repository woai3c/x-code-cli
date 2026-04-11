# X-Code CLI

Terminal AI coding assistant -- interact with your codebase through natural language.

## Architecture Overview

```text
                          +---------------------------------------------+
                          |            @x-code/cli (TUI)                |
                          |                                             |
  User Input ---------->  |  index.ts -> app.tsx -> App.tsx             |
                          |                          |                  |
                          |                     useAgent Hook           |
                          |                   (state management)        |
                          |                          |                  |
                          |  +---------------------------+              |
                          |  | Components                |              |
                          |  | ChatInput / MessageList / |              |
                          |  | ToolCall / ShellOutput /  |              |
                          |  | Permission / SelectOptions|              |
                          |  | Spinner / AppHeader       |              |
                          |  +---------------------------+              |
                          +------------------+--------------------------+
                                             | callbacks
                                             v
                          +---------------------------------------------+
                          |           @x-code/core (Engine)             |
                          |                                             |
                          |  +-------------------------------------+   |
                          |  |         Agent Loop                   |   |
                          |  |                                      |   |
                          |  |  streamText() --> LLM Response       |   |
                          |  |       |                              |   |
                          |  |  finishReason?                       |   |
                          |  |  +-- stop --> Done                   |   |
                          |  |  +-- tool-calls                      |   |
                          |  |       |                              |   |
                          |  |  Permission Check                    |   |
                          |  |       |                              |   |
                          |  |  Execute Tool --> Result to LLM      |   |
                          |  |       |                              |   |
                          |  |  Context Compression (if needed)     |   |
                          |  |       |                              |   |
                          |  |  Continue Loop <---------------------+   |
                          |  +-------------------------------------+   |
                          |                                             |
                          |  +----------+ +-----------+ +-------+      |
                          |  |  Tools   | | Knowledge | |Permis.|      |
                          |  | 13 built-| |  Loader   | | 3-lvl |      |
                          |  | in tools | | 7 layers  | | model |      |
                          |  +----------+ +-----------+ +-------+      |
                          |                                             |
                          |  +----------+ +-----------+ +-------+      |
                          |  | Provider | |  System   | |Pricing|      |
                          |  | Registry | |  Prompt   | |  Est. |      |
                          |  | 8+custom | | Builder   | |       |      |
                          |  +----------+ +-----------+ +-------+      |
                          +---------------------------------------------+
```

## Source Code Reading Guide

Recommended reading order from entry point inward:

```text
Entry Layer
  1. packages/cli/src/index.ts          CLI entry: arg parsing, .env, model setup
  2. packages/cli/src/app.tsx            Ink app mount, cleanup, exit handling

UI Layer
  3. packages/cli/src/ui/components/App.tsx    Root component, slash commands
  4. packages/cli/src/ui/hooks/use-agent.ts    State management (UI <-> core bridge)

Core Types
  5. packages/core/src/types/index.ts    All interfaces: AgentCallbacks, LoopState, etc.

Core Engine (the heart)
  6. packages/core/src/agent/loop.ts     *** Main agent loop: stream, tools, compress ***
  7. packages/core/src/agent/system-prompt.ts  System prompt construction

Supporting Modules (read as needed)
  8. packages/core/src/tools/*.ts         Tool implementations (pick 1-2 to read)
  9. packages/core/src/knowledge/loader.ts     7-layer knowledge context assembly
 10. packages/core/src/permissions/index.ts    3-level permission model
 11. packages/core/src/providers/registry.ts   Multi-model provider setup
 12. packages/core/src/config/index.ts         API key detection, model resolution
 13. packages/core/src/knowledge/auto-memory.ts  Persistent fact storage (CRUD + TTL)
 14. packages/core/src/knowledge/session.ts      Cross-session continuation
```

**Call chain summary:**

```text
cli/index.ts -> app.tsx -> App.tsx -> useAgent.submit()
  -> core/agent/loop.ts::agentLoop()
    -> streamText() -> handle tool calls -> loop until done
```

## MVP Implementation Status

### Fully Implemented

| Feature                                    | Files                                  |
| ------------------------------------------ | -------------------------------------- |
| Agent Loop (stream + tool calls + loop)    | agent/loop.ts                          |
| 13 built-in tools                          | tools/\*.ts                            |
| 3-level permission model + --trust         | permissions/index.ts                   |
| Multi-model support (8 providers + custom) | providers/registry.ts, config/index.ts |
| Streaming text (buffered → stdout-writer)  | use-agent.ts streamBufferRef, stdout-writer.ts |
| Context compression                        | agent/loop.ts compressMessages()       |
| Token usage tracking (input/output/total)  | agent/loop.ts, use-agent.ts            |
| Knowledge system (7-layer loading)         | knowledge/loader.ts                    |
| Auto memory (CRUD + TTL eviction)          | knowledge/auto-memory.ts               |
| 4 rule loading modes                       | knowledge/loader.ts                    |
| Session memory (summary + continuation)    | knowledge/session.ts                   |
| xc init project initialization             | knowledge/init.ts                      |
| Plan Mode (enterPlanMode/exitPlanMode)     | agent/loop.ts, agent/plan-mode.ts      |
| Slash commands (/help /model /plan etc.)   | components/App.tsx                     |
| Cross-platform shell (PowerShell/bash/zsh) | tools/shell-utils.ts                   |
| Shell streaming output                     | ShellOutput.tsx                        |
| askUser interactive tool                   | SelectOptions.tsx                      |
| Error recovery (429 retry, 401/403/503)    | agent/loop.ts classifyApiError()       |
| Ctrl+C graceful exit + session save        | cli/index.ts, app.tsx                  |
| Non-interactive mode (--print + pipe)      | cli/index.ts                           |
| Tool result truncation (30KB limit)        | tools/index.ts                         |
| Max turns limit (--max-turns)              | agent/loop.ts                          |
| DeepSeek Reasoner workaround               | agent/loop.ts                          |
| Tab completion for slash commands          | ChatInput.tsx                          |

### Not Yet Implemented (Designed in MVP but not coded)

| Feature                     | Notes                                                   |
| --------------------------- | ------------------------------------------------------- |
| Setup Wizard                | Interactive first-time provider/key/model guided setup  |
| Permission diff preview     | Show edit diffs in permission confirmation UI           |
| Paste preview               | Truncate large pasted text in input, show char count    |
| esbuild single-file bundle  | Currently uses tsc, no esbuild config                   |
| Husky + lint-staged         | No git hooks configured                                 |
| Config file API key storage | Only env vars; config.json only stores model preference |

### Future Iterations (Post-MVP)

| Priority | Feature            | Description                                        |
| -------- | ------------------ | -------------------------------------------------- |
| P0       | MCP Protocol       | External tool integration (GitHub, DB, Jira, etc.) |
| P1       | Skills System      | Reusable operation manuals (Agent Skills standard) |
| P1       | Subagent           | Independent child LLM instances for parallel work  |
| P1       | Task Tracking      | todoWrite tool, checklist management               |
| P1       | Session History    | --resume, /sessions list                           |
| P2       | Image/PDF          | Multimodal input                                   |
| P2       | Browser Automation | Playwright integration                             |
| P3       | Plugin System      | Third-party extensions                             |
| P3       | VSCode Extension   | Reuse @x-code/core in IDE                          |

## Project Structure

```text
x-code-cli/
+-- packages/
|   +-- core/                     @x-code/core (AI engine, no UI)
|   |   +-- src/
|   |       +-- agent/            Agent loop, system prompt, pricing, plan mode
|   |       +-- config/           Model config, API key management
|   |       +-- knowledge/        Knowledge loader, auto-memory, session, project scan
|   |       +-- permissions/      3-level permission system
|   |       +-- providers/        AI SDK provider registry (8+ providers)
|   |       +-- tools/            13 tool implementations
|   |       +-- types/            Public TypeScript interfaces
|   |       +-- utils.ts          Shared utilities
|   |       +-- index.ts          Public API exports
|   |
|   +-- cli/                      @x-code/cli (Terminal UI)
|       +-- src/
|           +-- index.ts          CLI entry point
|           +-- app.tsx           Ink app root
|           +-- ui/
|               +-- components/   10 React components
|               +-- hooks/        useAgent state management
|               +-- theme.ts      Color palette
|               +-- render-markdown.ts
|
+-- .x-code/                      Project knowledge base
|   +-- memory/                   Auto-generated memory
|   +-- plans/                    Implementation plans
|   +-- rules/                    Custom agent rules
|   +-- sessions/                 Session summaries
|   +-- local/                    Personal preferences (.gitignored)
|
+-- .env.example                  Environment variable template
+-- pnpm-workspace.yaml           Monorepo config
+-- MVP-DESIGN.md                 Full design document
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run (requires at least one API key)
node packages/cli/dist/index.js

# Or with a prompt
node packages/cli/dist/index.js "explain this project"
```

## Environment Variables

At least one provider API key is required:

| Variable                     | Provider                     |
| ---------------------------- | ---------------------------- |
| ANTHROPIC_API_KEY            | Anthropic (Claude)           |
| OPENAI_API_KEY               | OpenAI (GPT)                 |
| DEEPSEEK_API_KEY             | DeepSeek                     |
| GOOGLE_GENERATIVE_AI_API_KEY | Google (Gemini)              |
| ALIBABA_API_KEY              | Alibaba (Qwen)               |
| XAI_API_KEY                  | xAI (Grok)                   |
| ZHIPU_API_KEY                | Zhipu (GLM)                  |
| MOONSHOT_API_KEY             | Moonshot (Kimi)              |
| TAVILY_API_KEY               | Tavily web search (optional) |

## CLI Options

```text
xc [options] [prompt]

--model, -m <id>      Model to use (e.g., sonnet, deepseek, openai:gpt-4.1)
--trust, -t           Trust mode: skip write confirmations
--print, -p           Non-interactive: output and exit
--max-turns <n>       Max agent loop turns (default: 100)
--version, -v         Show version
--help, -h            Show help
```

## Slash Commands

| Command        | Description                    |
| -------------- | ------------------------------ |
| /help          | Show available commands        |
| /model [alias] | Switch model or list available |
| /usage         | Show token usage and cost      |
| /clear         | Clear conversation             |
| /compact       | Manually compress context      |
| /init          | Initialize project knowledge   |
| /session save  | Save session without exiting   |
| /plan          | Enter plan mode                |
| /exit          | Save session and exit          |
