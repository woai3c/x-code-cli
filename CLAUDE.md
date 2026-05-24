# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

X-Code CLI (`xc`) is a terminal AI coding assistant in the same shape as Claude Code / Gemini CLI: streaming agent loop, tool use, sub-agents, slash commands, plan mode, multi-provider support (Anthropic / OpenAI / DeepSeek / Google / Alibaba / xAI / Zhipu / Moonshot, plus an OpenAI-compatible escape hatch).

## Commands

This is a pnpm workspace; Node ≥20.19 is required.

```bash
pnpm install            # install all workspaces
pnpm build              # build core (tsc -b) then cli (esbuild bundle into dist/cli.js)
pnpm dev                # build core, then run the CLI from source via tsx (no watch)
pnpm typecheck          # tsc -b across both packages — strict, run before any PR
pnpm lint               # eslint --fix; ignores **/tests/** and *.js
pnpm format / format:check
pnpm test               # vitest run, all packages
pnpm test <pattern>     # single test file or directory:
                        #   pnpm test packages/core/tests/agent-loop.test.ts
                        #   pnpm test packages/core/tests/agent
pnpm ci                 # typecheck + lint + test + build (mirror CI)
pnpm release            # bump version + tag + publish (scripts/release.mjs); maintainers only
```

After editing **core** sources you must `pnpm build` (or run `tsc -b --watch` inside `packages/core` in another terminal); the CLI imports the compiled `dist/`, not the TS source. The `pnpm dev` script does a one-shot core build then runs CLI from source via tsx.

The published CLI binary is `xc` (alias `x-code`) → `packages/cli/dist/cli.js`.

## Architecture

Two packages, one direction of dependency: `cli` → `core`. The split is enforced — `core` has zero UI dependencies (no React, no Ink) so the agent engine can be reused or tested in isolation.

```
packages/
  core/    @x-code-cli/core    Agent engine: agentLoop, tools, providers, knowledge, permissions
  cli/     @x-code-cli/cli     Terminal UI: Ink/React shell, ChatInput renderer, slash commands
```

### Rendering: Ink is a lifecycle container, not a renderer

Every visible UI element — input box, scrollback messages, spinner, permission and select-options dialogs, progress lines — is drawn by `ChatInput.tsx` writing **directly to `process.stdout`** with a cell-level diff against a 2D cell grid. **Ink's dynamic region is permanently empty.** Ink is kept only for `render(<App>)` lifecycle (mount / unmount / Ctrl+C signal / stdin raw mode).

Why: Ink's Yoga layout and `log-update` redraw pipeline mismeasure CJK / IME / long streaming text and produce visible jitter on every terminal we tested. The fix has two parts:

1. **`package.json` aliases `ink` to `@jrichman/ink@6.6.9`** (Google fork used by Gemini CLI). All `import from 'ink'` calls resolve to the fork. Don't import from `@jrichman/ink` directly.
2. **`ChatInput` owns the bottom region.** Every state change rebuilds a cell grid in memory, diffs against the previous frame, and emits one `process.stdout.write()` wrapped in BSU/ESU (DEC 2026 synchronized update). Tool dialogs (permission, askUser select) render inside this same grid — never as Ink children — because Ink's `log-update` uses the terminal's single DECSC (`\x1b7`) cursor-save register and any second writer to the dynamic region clobbers the cursor anchor.

Practical consequence: don't add `<Box>` / `<Text>` Ink children that produce visible output. `App.tsx` returns a single `<ChatInput>`. New UI surfaces need to be added as cell-buffer rows inside `ChatInput.tsx`.

### Agent loop

`core/src/agent/loop.ts:agentLoop` is the entry point. One call processes one user message and runs as many `runTurn` rounds as the model wants:

```
agentLoop()
  └─ let turn = 0
     while (maxTurns === undefined || turn < maxTurns)
       ├─ turn++
       ├─ checkAndCompressContext()      — light compact + (rare) summarize on overflow
       ├─ runTurn()
       │   ├─ applyCacheControl()        — provider-specific cache breakpoints
       │   ├─ streamText({ abortSignal, ... })
       │   ├─ streamChunksToUI()         — text-delta / tool-call / tool-result events
       │   └─ collectTurnResponse()      — pushes response.messages to state.messages
       └─ branch on finishReason:
            'tool-calls'  → processToolCalls() then continue
            'length'      → push "resume" nudge, continue (capped at MAX_CONTINUATIONS)
            'stop' / err  → break

  returns { state, turnCount: turn }  // turnCount is per-invocation, not on state
```

`LoopState` is reused across submits within one CLI session (see `loopStateRef` in `use-agent.ts`). It carries `messages`, accumulated `tokenUsage`, `recentToolCalls` (the loop-guard window), and `systemPromptCache`. The per-invocation turn counter is **not** on `LoopState` — it's a local in `agentLoop` and surfaces via the return value, so re-entering the function (next user submit) starts at 0. Main interactive mode passes no `maxTurns` (unlimited; press Esc to stop); `--print` and sub-agents pass per-call caps.

**`systemPromptCache` must remain byte-stable for the entire session.** OpenAI-compatible providers (DeepSeek / Moonshot / Alibaba / Zhipu / xAI) auto-cache stable prefixes, and `buildSystemPrompt` is called only on the first turn. Any change that interpolates per-turn data (timestamps, frame-shifting context) into the system prompt silently disables prompt caching for those providers.

### Sub-agents

The `task` tool delegates a sub-task to a specialized sub-agent that runs in isolated context — only the sub-agent's final assistant message is returned to the parent. Implementation lives in `core/src/agent/sub-agents/`:

- `built-in.ts` — four hardcoded definitions (`explore`, `general-purpose`, `plan`, `code-reviewer`) with their tool whitelists and system prompts.
- `loader.ts` — scans `~/.x-code/agents/*.md` and `<repo-root>/.x-code/agents/*.md` for custom agents (YAML frontmatter + markdown body = system prompt). Project-level wins on name conflicts.
- `registry.ts` — built at CLI startup, frozen for the session. **Adding or editing an agent file requires a CLI restart**: the `task` tool description embeds the agent list, and that string lives in `systemPromptCache` which must stay byte-stable.
- `runner.ts:runSubAgent` — recursively calls `agentLoop` with a fresh `LoopState` (no parent message history), the agent's `toolFilter` (always denies `task` itself — recursion is forbidden), and the **same `abortSignal`** as the parent so Esc cascades cleanly. Token usage flows back into `parentState.tokenUsage`; nothing else does.

When the parent session is in `permissionMode === 'plan'`, sub-agents still launch in `'default'` mode but their tool filter additionally denies write tools, preserving plan-mode's read-only invariant.

### Cancellation flow (Esc / Ctrl+C)

A user's Esc cancels the in-flight turn without exiting; Ctrl+C double-press exits. The wiring:

- `usePromptInput` parses raw stdin and dispatches `'escape'` / Ctrl+C to `ChatInput`.
- `ChatInput.onKey` routes Esc to `onEscapeCancel` only when `isLoading` and no permission / select dialog is open. Modal gates above swallow Esc.
- `useAgent.abort()` flushes the stream buffer (preserves partial assistant text), appends `[Request interrupted by user]` (or `... for tool use` if `activeToolCalls.length > 0`) to both UI messages and `loopState.messages`, then calls `abortControllerRef.current.abort()`.
- The signal is passed all the way down: `useAgent.submit` → `agentLoop` via `options.abortSignal` → `streamText({ abortSignal })` → and through `executeShell` → `shell-provider.spawn({ signal })` → `execa({ cancelSignal })`, which SIGKILLs the running shell child process tree.
- `runTurn`'s catch blocks detect AbortError via `isAbortError(err, signal)` and return a `{ kind: 'aborted' }` outcome that `agentLoop` treats as a clean break (no `onError`).
- `processToolCalls` short-circuits on a mid-loop abort and pushes synthetic `[Tool execution interrupted by user]` results for skipped tool_calls to keep `state.messages` valid for the next API request.

When changing tool execution code, **always thread `options.abortSignal` through** — orphan tool_calls (without tool_results) cause the next API request to fail with "tool_use without tool_result".

### Knowledge & memory

`buildKnowledgeContext` (in `core/src/knowledge`) merges five layers, in order:

```
~/.x-code/AGENTS.md            user-scope preferences (human-written)
~/.x-code/memory/auto.md       user-scope auto-memory  (AI-written)
<repo-root>/AGENTS.md chain    walked from cwd up to .git root, root→leaf
.x-code/memory/auto.md         project auto-memory (AI-written)
<repo-root>/AGENTS.local.md    per-user, gitignored (personal preferences)
```

The AGENTS.md chain lets monorepo subpackages override repo-root guidance — leaf wins. `~/.x-code` is overridable via the `X_CODE_HOME` env var (used by tests).

### Provider configuration

API keys are read **only** from environment variables (never persisted to disk). Mapping lives in `core/src/config/index.ts:ENV_MAP`:

```
anthropic   ANTHROPIC_API_KEY              moonshotai  MOONSHOT_API_KEY
openai      OPENAI_API_KEY                 google      GOOGLE_GENERATIVE_AI_API_KEY
deepseek    DEEPSEEK_API_KEY               xai         XAI_API_KEY
alibaba     ALIBABA_API_KEY                zhipu       ZHIPU_API_KEY
```

Plus the OpenAI-compatible escape hatch: `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` (registered as the `custom` provider).

When adding a provider, also update `packages/core/tests/config.test.ts:PROVIDER_ENV_VARS` — the test cleanup helper enumerates every key explicitly so a developer running tests with one provider key live in their shell doesn't leak it into "no provider configured" assertions.

## Conventions

- **Imports**: ESM only (`"type": "module"`), `.js` extensions on relative imports even in `.ts` files (TS NodeNext).
- **Comments**: heavy comments are reserved for _why_ (especially terminal-protocol workarounds in `ChatInput.tsx` and `use-prompt-input.ts`). The codebase reads as a series of "we tried X first, then Y broke, so we do Z" notes — keep that style when adding new edge-case handling.
- **Per-user state**: `.x-code/` at repo root is **gitignored** and holds session summaries / auto-memory / local prefs / custom sub-agent definitions (`.x-code/agents/*.md`). Tests redirect this via `process.env.X_CODE_HOME = <tmpdir>`.
- **Logging**: `DEBUG_STDOUT=1 xc` writes to `~/.x-code/logs/debug.log` (10 MB rolling). `debugLog()` calls in core are no-ops without that env var.
- **Don't auto-commit.** Typecheck / build / tests passing is **not** authorization to commit — the user verifies UI and runtime behavior in the live CLI before anything lands in history. After making changes, stop, summarize what changed, and wait for an explicit go-ahead.
  - Phrases that DO authorize: `提交`, `commit`, `commit it`, `提交一下`, `ok ship it`.
  - Phrases that do **not**: `good`, `looks right`, `可以的`, `继续`, `不错` — those mean "the work looks done", not "land it in git".
  - One authorization covers one chunk only. After committing chunk A, follow-up changes B need a fresh authorization — do not roll the earlier "commit" instruction forward.
  - Don't `git commit --amend` or stage and commit "fix-forward" patches when a previous commit got criticism; revert/reset and let the user decide what to do with the change.
