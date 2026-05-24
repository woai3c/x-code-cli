# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.

## Commands

pnpm workspace; Node >= 20.19.

```bash
pnpm build              # tsc -b (core) then esbuild (cli → dist/cli.js)
pnpm dev                # build core, then run CLI from source via tsx (no watch)
pnpm typecheck          # tsc -b — strict, run before any PR
pnpm lint               # eslint --fix; ignores **/tests/** and *.js
pnpm test               # vitest run, all packages
pnpm test <pattern>     # single file: pnpm test packages/core/tests/agent-loop.test.ts
pnpm ci                 # typecheck + lint + test + build
```

After editing **core** sources you must `pnpm build` (or `tsc -b --watch` in `packages/core`). The CLI imports `packages/core/dist/`, not the TS source.

## Architecture

Two packages, unidirectional: `cli` → `core`. Core has zero UI dependencies.

```
packages/
  core/    Agent engine: agentLoop, tools, providers, knowledge, permissions, sub-agents
  cli/     Terminal UI: Ink (lifecycle only), ChatInput cell-grid renderer, slash commands
```

**Rendering**: Ink's dynamic region is permanently empty. Every visible UI element is drawn by `ChatInput.tsx` writing directly to `process.stdout` via cell-level diff. `package.json` aliases `ink` to `@jrichman/ink@6.6.9` — never import from `@jrichman/ink` directly.

**Agent loop** (`core/src/agent/loop.ts:agentLoop`): one call = one user message, spinning `runTurn` rounds until stop/tool-calls/abort. `LoopState` is reused across submits within a CLI session. `systemPromptCache` must remain byte-stable for the entire session — any per-turn interpolation into the system prompt silently disables prompt caching for OpenAI-compatible providers.

**Sub-agents** (`core/src/agent/sub-agents/`): `task` tool delegates to isolated agentLoop with fresh LoopState. Registry is built at CLI startup and frozen. Adding/editing agent files requires a CLI restart because the agent list is embedded in the byte-stable `systemPromptCache`. Sub-agents always deny `task` (no recursion). In plan mode, write tools are denied via tool filter.

**Knowledge** (`core/src/knowledge/`): five layers merged into system prompt — user AGENTS.md, user auto-memory, project AGENTS.md chain (root→leaf, leaf wins), project auto-memory, AGENTS.local.md.

**Provider config**: API keys read only from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ALIBABA_API_KEY`, `XAI_API_KEY`, `ZHIPU_API_KEY`, `MOONSHOT_API_KEY`) plus escape hatch `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL`. When adding a provider, also update `packages/core/tests/config.test.ts:PROVIDER_ENV_VARS`.

**Permissions**: 3-level model (always-allow / ask / deny). Shell commands classified via `shell-utils.ts` with quote-aware compound-command splitting and LRU cache.

## Conventions

- **ESM only** (`"type": "module"`), `.js` extensions on relative imports even in `.ts` files (NodeNext).
- **No semicolons**, single quotes, trailing commas, print width 120. Import order enforced by prettier-plugin-sort-imports: `node:` → `react` → `ink` → `ai`/`@ai-sdk` → `zod` → `@x-code-cli/` → `./` relative.
- **Comments**: reserved for _why_ (terminal-protocol workarounds, provider-specific quirks). Keep that style.
- **Commit style**: conventional commits (`feat:`, `fix:`, `refactor:`, etc.) enforced by commitlint. Additional types: `release`, `wip`.
- **`.x-code/` at repo root is gitignored** — session summaries, auto-memory, local prefs, custom sub-agent definitions. Tests redirect via `X_CODE_HOME`.
- **`DEBUG_STDOUT=1 xc`** writes to `~/.x-code/logs/debug.log` (10 MB rolling). `debugLog()` in core is a no-op without it.
- **Tests use vitest** with globals (`describe`, `it`, `expect`, `vi` available without imports). Test files ignored by eslint.

## Gotchas

- **Don't auto-commit.** Typecheck/build/tests passing is NOT authorization. Wait for explicit `提交`, `commit`, `commit it`, `提交一下`, or `ok ship it`. One authorization covers one chunk only.
- **When changing tool execution code, always thread `options.abortSignal` through.** Orphan tool_calls (without tool_results) cause the next API request to fail.
- **OpenAI-compatible providers auto-cache stable prefixes.** Don't interpolate timestamps or frame-shifting data into systemPromptCache or sub-agent tool descriptions.
- **Blocking the UI thread kills the TUI.** `ChatInput` renders via direct stdout writes on a setInterval timer. Long synchronous work in tool execution, permission callbacks, or slash-command handlers freezes the display. Use async I/O; offload heavy work.
- **Don't add `<Box>` / `<Text>` Ink children that produce visible output.** `App.tsx` returns a single `<ChatInput>`. New UI surfaces go inside `ChatInput.tsx`'s cell buffer.
