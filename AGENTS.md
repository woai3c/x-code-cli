# AGENTS.md

This is the repository instruction entrypoint. X-Code loads the applicable `AGENTS.md` chain into project context;
other agent hosts must use a verified discovery path or open this file explicitly. Keep it concise because it is prompt
context.

## Rules

- Use visualizations when they help explain complex concepts.
- Keep responses concise and direct, and clearly distinguish facts from assumptions.
- Base research on reliable sources.
- Stay aligned with the user's goals and constraints.
- Avoid unnecessary questions; ask only when a key decision requires confirmation.
- Use sub-agents judiciously and avoid unnecessary parallelism.
- Keep code changes minimal and avoid unrelated refactoring.
- Verify actual results through testing; do not assume something is complete just because it looks complete.
- Keep all features and tests compatible with Windows, macOS, and Linux. Do not assume POSIX paths, shells, signals, terminal glyphs, process behavior, or file-lock semantics. Platform-conditional tests are allowed only when the underlying capability cannot be tested equivalently, and the reason must be explicit.
- Protect existing code and data.
- Report key results without unnecessary progress updates.

## Commands

pnpm workspace; Node >= 22.

```bash
pnpm build              # tsc -b (core) then esbuild (cli → dist/cli.js)
pnpm dev                # build core, then run CLI from source via tsx (no watch)
pnpm typecheck          # tsc -b — strict, run before any PR
pnpm lint               # eslint --fix; ignores **/tests/** and *.js
pnpm test               # build + Unit/Fault/Package/PTY tests
pnpm test <pattern>     # single file: pnpm test packages/core/tests/agent-loop.test.ts
pnpm run ci             # typecheck + lint/format checks + pnpm test
```

After editing **core** sources you must `pnpm build` (or `tsc -b --watch` in `packages/core`). The CLI imports `packages/core/dist/`, not the TS source.

## Delivery workflow

Follow [`docs/development/agent-workflow.md`](docs/development/agent-workflow.md) for work definition, Human Plan Review, verification evidence, Human Local Acceptance, Draft/Ready PR handling, and continuous knowledge capture. Use [`.github/pull_request_template.md`](.github/pull_request_template.md) for the durable PR handoff. Capability status in that guide describes what can run; every task must report its own check outcomes separately.

## Architecture

Two packages, unidirectional: `cli` → `core`. Core has zero UI dependencies.

```
packages/
  core/    Agent engine: agentLoop, tools, providers, knowledge, permissions, sub-agents
  cli/     Terminal UI: Ink (lifecycle only), ChatInput cell-grid renderer, slash commands
```

**Rendering**: Ink's dynamic region is permanently empty. Every visible UI element is drawn by `ChatInput.tsx` writing directly to `process.stdout` via cell-level diff. `package.json` aliases `ink` to `@jrichman/ink@6.6.9` — never import from `@jrichman/ink` directly.

**Agent loop** (`core/src/agent/loop.ts:agentLoop`): one call = one user message, spinning `runTurn` rounds until stop/tool-calls/abort. `LoopState` is reused across submits within a CLI session. `systemPromptCache` must remain byte-stable between invalidation events (model switch, `/skill` or `/mcp` refresh, permission-mode flip) — any per-turn interpolation into the system prompt silently disables prompt caching for OpenAI-compatible providers.

**Deferred tools** (`core/src/agent/tool-search/`): MCP tools and non-core built-ins are listed by name under `## Deferred Tools` in the system prompt and loaded on demand via `toolSearch`; `buildDeferredCatalog` falls back to full injection for weak models and small catalogs so the prompt stays byte-stable. Sub-agents get no catalog and keep the inline `## MCP Tools` block.

**Sub-agents** (`core/src/agent/sub-agents/`): `task` tool delegates to isolated agentLoop with fresh LoopState. Registry is built at CLI startup and frozen. Adding/editing agent files requires a CLI restart because the agent list is embedded in the byte-stable `systemPromptCache`. Sub-agents always deny `task` (no recursion). In plan mode, write tools are denied via tool filter.

**Cross-session messaging** (`core/src/peers/`, `cli/src/peer-lifecycle.ts`): `--name` enables local discovery and messaging for interactive root sessions. Peer input taints the derived context and routes tool calls through the authority evaluator; do not bypass that path. Transport is local Unix sockets on macOS/Linux in this release; Windows must fail closed as unsupported until it has an audited native transport.

**Knowledge** (`core/src/knowledge/`): four layers merged into system prompt — user AGENTS.md, user memory Core profile (`~/.x-code/memory/MEMORY.md`), project AGENTS.md chain (root→leaf, leaf wins), AGENTS.local.md.

**Provider config**: `packages/core/src/providers/catalog.ts:PROVIDERS` is the single provider metadata table (envKey, defaultModel, /model picker entries, key URL, base URLs, reasoning tiers); `PROVIDER_*` derived views and the test env-var list all come from it. API keys read only from env vars, plus escape hatch `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL`. OpenAI also supports ChatGPT subscription OAuth through `auth/openai-chatgpt/`; stored ChatGPT credentials take exclusive precedence over `OPENAI_API_KEY` until `xc logout`, and authentication failures must never fall back to the key. Adding a provider = one catalog entry + a constructor branch in `providers/registry.ts`.

**Permissions**: 3-level model (always-allow / ask / deny). Shell commands classified via `shell-utils.ts` with quote-aware compound-command splitting and LRU cache.

**Shared internal modules** (`core/src/`):

- `frontmatter.ts` — unified YAML frontmatter parser (commands, skills, sub-agents). `coerceTypes` option enables array/number parsing (sub-agents only).
- `registry-diff.ts` — `diffNamedEntries()` for all registry `reload()` methods.
- `settings-io.ts` — fault-tolerant JSON settings read/modify/write (skills + plugins).
- `utils.ts:generateTimestampId` — canonical `YYYYMMDD-HHMMSS-mmm` for session/checkpoint IDs.

**User directory resolution**: `userXcodeDir()` for all file I/O (respects `X_CODE_HOME`). The frozen `USER_XCODE_DIR` constant is only for byte-stable system-prompt content and log init.

## Conventions

- **ESM only** (`"type": "module"`), `.js` extensions on relative imports even in `.ts` files (NodeNext).
- **No semicolons**, single quotes, trailing commas, print width 120. Import order enforced by prettier-plugin-sort-imports: `node:` → `react` → `ink` → `ai`/`@ai-sdk` → `zod` → `@x-code-cli/` → `./` relative.
- **Comments**: reserved for _why_ (terminal-protocol workarounds, provider-specific quirks). Keep that style.
- **Commit style**: conventional commits (`feat:`, `fix:`, `refactor:`, etc.) enforced by commitlint. Additional types: `release`, `wip`.
- **`.x-code/` at repo root is gitignored** — session summaries, auto-memory, local prefs, custom sub-agent definitions. Tests redirect via `X_CODE_HOME`.
- **`DEBUG_STDOUT=1 xc`** writes to `~/.x-code/logs/debug.log` (10 MB rolling). `debugLog()` in core is a no-op without it.
- **Tests use vitest** with globals (`describe`, `it`, `expect`, `vi` available without imports). Test files ignored by eslint.
- **API export snapshot** (`packages/core/tests/api-exports.test.ts`) locks the `@x-code-cli/core` public export list. Run `pnpm test -- -u` to update after intentional changes.

## Gotchas

- **Don't auto-commit.** Typecheck/build/tests passing is NOT authorization. Wait for explicit `提交`, `commit`, `commit it`, `提交一下`, or `ok ship it`. One authorization covers one chunk only.
- **When changing tool execution code, always thread `options.abortSignal` through.** Orphan tool_calls (without tool_results) cause the next API request to fail.
- **OpenAI-compatible providers auto-cache stable prefixes.** Don't interpolate timestamps or frame-shifting data into systemPromptCache or sub-agent tool descriptions.
- **Blocking the UI thread kills the TUI.** `ChatInput` renders via direct stdout writes on a setInterval timer. Long synchronous work in tool execution, permission callbacks, or slash-command handlers freezes the display. Use async I/O; offload heavy work.
- **Don't add `<Box>` / `<Text>` Ink children that produce visible output.** `App.tsx` returns a single `<ChatInput>`. New UI surfaces go inside `ChatInput.tsx`'s cell buffer.
