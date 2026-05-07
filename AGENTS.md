# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.

## Project

X-Code CLI (`xc`) is a terminal AI coding assistant: streaming agent loop, tool use, sub-agents, slash commands, plan mode, multi-provider support (Anthropic / OpenAI / DeepSeek / Google / Alibaba / xAI / Zhipu / Moonshot, plus an OpenAI-compatible escape hatch).

## Commands

pnpm workspace; Node >= 20.19 required.

```
pnpm install            # install all workspaces
pnpm build              # build core (tsc -b) then cli (esbuild bundle into dist/cli.js)
pnpm dev                # build core, then run CLI from source via tsx (no watch)
pnpm typecheck          # tsc -b across both packages — strict, required before PR
pnpm lint               # eslint --fix; ignores tests/ and *.js
pnpm format / format:check
pnpm test               # vitest run, all packages
pnpm test <pattern>     # single test: pnpm test packages/core/tests/agent-loop.test.ts
pnpm ci                 # typecheck + lint + test + build (mirrors CI)
pnpm release            # bump + tag + publish (maintainers only)
```

After editing **core** sources you must `pnpm build` (or `tsc -b --watch` in `packages/core`). The CLI imports compiled `dist/`, not TS source.

The published binary is `xc` (alias `x-code`) -> `packages/cli/dist/cli.js`.

## Architecture

Two packages, one direction of dependency: `cli` -> `core`. The split is enforced — `core` has zero UI dependencies (no React, no Ink) so the agent engine can be reused in isolation.

```
packages/
  core/    Agent engine: agentLoop, tools, providers, knowledge, permissions, sub-agents
  cli/     Terminal UI: Ink/React shell, ChatInput renderer, slash commands
```

### Key data flows

- **Agent loop** (`core/src/agent/loop.ts:agentLoop`): one call processes one user message. Runs `runTurn` rounds until tool-calls finish or stop. `LoopState` carries messages, token usage, loop-guard window, and `systemPromptCache` — reused across submits within one CLI session.
- **`systemPromptCache` must be byte-stable for the entire session.** OpenAI-compatible providers auto-cache stable prefixes; `buildSystemPrompt` is called only on turn 1. Any per-turn interpolation (timestamps, frame-shifting context) silently disables prompt caching.
- **Tool registry** (`core/src/tools/index.ts`): 15 tools registered at startup. `task` tool is injected at loop start only when `subAgentRegistry` is provided. No memory-write tool exists — memory writes happen silently via the post-turn extractor (`memory-extractor.ts`).
- **Memory extractor** (`core/src/agent/memory-extractor.ts`): runs fire-and-forget after each `finishReason === 'stop'`. One `generateText` round-trip with `Output.object` (no agent loop). Capped at 3 memories per pass. Runs AFTER `agentLoop` returns — `onMemoryWrite` callbacks may fire into the next turn.
- **Loop guard** (`core/src/agent/loop-guard.ts`): two-stage duplicate tool-call detection. SHA256 over `{toolName, stableInputJson}`. Soft threshold (3) injects synthetic "change your approach" result; hard threshold (5) aborts the turn.
- **Permissions** (`core/src/permissions/index.ts`): three modes — `default` (ask on write), `acceptEdits` (auto-approve writeFile/edit, shell still gated), `plan` (prompt-based read-only). Three-level shell classification: destructive commands are `deny`, read-only commands `always-allow`, everything else `ask`.
- **Cancellation**: Esc cancels in-flight turn; Ctrl+C double-press exits. `abortSignal` threads through `agentLoop` -> `streamText` -> `executeShell` -> `execa({ cancelSignal })` which SIGKILLs child process trees. Always thread `abortSignal` through tool execution — orphan tool_calls (no tool_results) cause the next API call to fail.

### Rendering (Ink is a lifecycle container, not a renderer)

Every visible UI element is drawn by `ChatInput.tsx` writing directly to `process.stdout` with a cell-level diff. Ink's dynamic region is permanently empty — Ink is kept only for `render(<App>)` lifecycle (mount/unmount, Ctrl+C signal, stdin raw mode).

The `ink` package is aliased via `package.json` to `@jrichman/ink@6.6.9` (Google fork). Do NOT import from `@jrichman/ink` directly — always `import from 'ink'`. Do NOT add `<Box>` / `<Text>` Ink children that produce visible output. `App.tsx` returns a single `<ChatInput>`. New UI surfaces go as cell-buffer rows inside `ChatInput.tsx`.

### Sub-agents

Implementation in `core/src/agent/sub-agents/`:

- `built-in.ts` — four hardcoded definitions: `explore`, `general-purpose`, `plan`, `code-reviewer` with tool whitelists and system prompts.
- `loader.ts` — scans `~/.x-code/agents/*.md` and `<repo-root>/.x-code/agents/*.md` for custom agents (YAML frontmatter + markdown body = system prompt). Project-level wins on name conflicts.
- `registry.ts` — built at CLI startup, frozen for the session. Adding or editing an agent file requires a CLI restart.
- `runner.ts:runSubAgent` — recursively calls `agentLoop` with fresh `LoopState`, same `abortSignal` as parent. `task` is always blocked (no recursion). In `plan` mode, sub-agents additionally deny write tools.

### Knowledge loading

`buildKnowledgeContext` in `core/src/knowledge/loader.ts` merges five layers in order:

1. Global AGENTS.md (~/.x-code/) — fallback to CLAUDE.md
2. Global auto memory (~/.x-code/memory/auto.md)
3. Project AGENTS.md chain (cwd up to .git root, root->leaf)
4. Project auto memory (.x-code/memory/auto.md)
5. AGENTS.local.md at project root — gitignored, personal preferences

At each directory, AGENTS.md is tried first, then CLAUDE.md as fallback. When both exist, AGENTS.md wins. Writes always target AGENTS.md.

### Vision fallback for text-only providers

When the user attaches an image but the active model can't see images (DeepSeek), `vision-fallback.ts` automatically borrows any other configured vision-capable provider as a caption sub-agent. Priority: google -> zhipu -> alibaba -> openai -> anthropic -> moonshotai -> xai. Falls back to local tesseract OCR if no vision key is configured.

### Provider configuration

API keys come ONLY from environment variables (never disk). `ENV_MAP` in `core/src/config/index.ts`:

```
anthropic   ANTHROPIC_API_KEY              moonshotai  MOONSHOT_API_KEY
openai      OPENAI_API_KEY                 google      GOOGLE_GENERATIVE_AI_API_KEY
deepseek    DEEPSEEK_API_KEY               xai         XAI_API_KEY
alibaba     ALIBABA_API_KEY                zhipu       ZHIPU_API_KEY
```

Plus `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` (registered as `custom` provider).

When adding a provider, update `PROVIDER_ENV_VARS` in `packages/core/tests/config.test.ts` — the test cleanup helper enumerates every key so developer shell env doesn't leak into "no provider configured" assertions.

## Conventions

- **Imports**: ESM only (`"type": "module"`), `.js` extensions on relative imports in `.ts` files (TS NodeNext).
- **Comments**: heavy comments reserved for _why_, especially terminal-protocol workarounds. Keep the "we tried X first, then Y broke, so we do Z" style.
- **Per-user state**: `.x-code/` at repo root is gitignored (sessions, plans, auto-memory, custom sub-agents). Tests redirect via `process.env.X_CODE_HOME = <tmpdir>`.
- **Logging**: `DEBUG_STDOUT=1 xc` writes to `~/.x-code/logs/debug.log` (10 MB rolling, 1 KB per-line cap). `debugLog()` calls are no-ops without that env var. Sync I/O — ordering matches real-time event order.
- **Commit style**: conventional commits (commitlint enforced in CI). Types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `release`, `style`, `test`, `wip`.
- **Do NOT auto-commit**. Passing CI checks is not authorization to commit — stop, summarize changes, and wait for explicit go-ahead (`commit`, `commit it`, `提交`, `ok ship it`). Do not `--amend` or push fix-forward patches on criticism.
- **Prettier**: singleQuote, noSemi, trailingComma all, import sorting with `@trivago/prettier-plugin-sort-imports` (order: node -> react -> ink -> ai-sdk -> zod -> @x-code-cli -> relative).
- **Tests**: vitest with globals. CI runs on both ubuntu and windows (shell-provider tests are platform-specific).
