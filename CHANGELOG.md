## v0.3.3 (2026-06-10)

### Features

- replace hard deny with [dangerous] warning dialog for destructive commands (7516271)
- show compression progress in spinner and token stats on completion (a2cd0c3)

### Bug Fixes

- cap slash and @-mention menus to 8 visible rows with scroll indicators (5489e79)

## v0.3.2 (2026-06-03)

### Features

- reduce sub-agent overuse, add cache break detection, and smart tool_result truncation (fd2e45f)
- add /doctor slash command for environment diagnostics (b3defb6)
- startup version check with 24h disk cache (6eb68d6)
- per-message file snapshots backing /rewind (6951cf9)

## v0.3.1 (2026-06-01)

### Features

- load user + project slash commands from .x-code/commands (59f429d)
- smarter shell matching for PowerShell and compound commands (87b8586)

### Bug Fixes

- erase ghost frame when commit moves frame up via blankAbove (1dbf116)
- let multi-match suggestion menu win over history nav (f1bef22)

## v0.3.0 (2026-05-26)

### Features

- /plugin refresh now restarts MCP servers in the same pass (80dfdbb)
- enforce marketplace `sha` integrity pin on git installs (9da04f6)
- bulk update via `--all`; fix stale consent preview note (52774fc)
- plugin / marketplace / hooks system + bilingual docs (#13) (b310640)
- inject base directory + bundled file list on activation (2e7aa69)
- add skill support system (#12) (f605eb9)
- two-stage slash-command completion with argument hints (efdfe56)
- Model Context Protocol (MCP) client support (#11) (c7cffec)

### Bug Fixes

- cap grow-path LF scroll to real content rows above frame (2079723)
- accept flat .mcp.json and probe root for consent preview (8e11893)
- honor X_CODE_HOME for plugin paths and user-scope settings (da4f227)
- harden MCP env passthrough and plugin symlink copy (b947744)
- rename /skill remove to /skill uninstall (372414b)
- /skill disable slash menu hint points at refresh, not restart (469ae5a)
- fire SessionStart at CLI launch; add hook exec-ran log; dedupe userConfig label (10c1e8b)
- drop blank line between header and rows in slash command lists (ca17c6a)
- rotate-failure log counter sentinel; truncateForLog cuts bytes not chars (2338b95)
- --no-plugins drops pluginRegistry; better empty-cache search error (bc9e6f5)
- refresh-not-restart hints; slash arg parsing; cwd hint; document slash limitations (75c2b86)
- consistent marketplace alias; seed defaults on subcommands; broader blockedPlugins (c7264f5)
- tighten /mcp refresh and /mcp auth output blocks (f748d70)
- align MCP tool permission dialog with shell/edit dialogs (3d1b6d0)
- resolve package version at runtime instead of hardcoding (7a45cb0)

## v0.2.10 (2026-05-16)

### Bug Fixes

- tighten shell prefix extraction (ad57bdf)

### Performance

- cache Anthropic tools schema as 4th breakpoint (3c86961)

## v0.2.9 (2026-05-16)

### Bug Fixes

- short-circuit retries on permanent provider errors (0768329)
- keep arrow-history nav working on slash entries (b6a77ef)
- leave 1 cell margin to avoid phantom blank rows (383e35b)

## v0.2.8 (2026-05-12)

No user-facing changes.

## v0.2.7 (2026-05-12)

### Bug Fixes

- scope turnCount per agentLoop call, drop default cap (d960288)

## v0.2.6 (2026-05-10)

### Features

- up/down arrow recall of submitted prompts (5d220ad)

### Bug Fixes

- preserve role alternation in repairOrphanToolCalls (d43e3cb)
- graceful startup fallback + --continue in print mode (74eb53e)
- await saveSession before exit (36f8ee5)

## v0.2.5 (2026-05-10)

### Bug Fixes

- switch to ripgrep, fix mtime sort and ignore handling (605cba1)

## v0.2.4 (2026-05-08)

### Features

- add /review slash command for PR review (#9) (0d23951)

### Bug Fixes

- preserve scrollback bytes across superseded commit-throttle (#10) (5eb978d)

## v0.2.3 (2026-05-06)

### Bug Fixes

- bail to aborted state after reactive compaction if Esc fired (c59dbe0)
- restore blank line after markdown heading (df50c88)

## v0.2.2 (2026-05-06)

### Features

- dispatch consecutive task calls in parallel (e7b4a2f)
- collapse consecutive read-only tool calls into a summary line (6adf404)
- multiline input via Alt+Enter and trailing-backslash (a149873)

### Bug Fixes

- offer "don't ask again" for shell commands without a derivable prefix (fe86f50)
- skip already-fulfilled tool-calls; align general-purpose with Claude Code (3e55652)
- extract PowerShell command prefix when flags precede -Command (28316f7)
- seal blank gap above floating frame after large shrink (7c5384c)
- cap inlined file size and Read output to prevent context overflow (ce059a0)
- /clear actually clears the visible terminal area (1becd24)
- error in rendering the UI for diff text (f1c578d)
- footer narrow row, askUser dialog wrap, frame-engine race fixes (65c39b4)
- keep tool/assistant pairs intact during compaction (be70427)
- security hardening, performance safeguards, and code refactoring (d6ff572)

## v0.2.1 (2026-05-01)

### Features

- improve prefix extraction and session-only write rules (1511710)

### Bug Fixes

- sometimes cannot see the UI for asking permission (a42ef09)

## v0.2.0 (2026-05-01)

### Features

- enhance /usage-history, fix ghost cursor, remove /session-save (2ee4d47)
- add multi-layout select and align askUser/picker styling with CC (19d67e3)
- implement sub-agent system with task tool and live progress UI (e9a5e23)
- @-mention file completion menu (9190186)
- show context-window occupancy in footer (410fc15)
- structured edit diff + syntax highlighting + theme picker (2a8967d)
- per-session jsonl transcript with resume support (910a582)
- double-tap Esc to clear input in idle mode (3e47aa3)
- LLM-generated slug for non-ASCII session/plan filenames (ba3455c)
- wire askUser "Other" freeform input (e34900d)
- tighter scrollback rhythm + truncation + render diagnostics (c8aa40c)
- align todo panel with Claude Code, drop noise (ceba707)
- TodoWrite tool with live in-frame checklist (ff10c6d)
- plan mode aligned with Claude Code (interactive interview + acceptEdits) (2117291)
- Esc to cancel in-flight turn; Ctrl+C double-press to exit (ede95cd)

### Bug Fixes

- add platform-aware Unicode glyph fallbacks for legacy ConHost (44872c5)
- include output in currentContextTokens to match provider semantics (83f2d13)
- move "Press Ctrl+C again to exit" hint below input box (5efb0b9)
- eliminate flicker (d6218ba)
- replace orange accent with blue-purple in select dialogs (15cd584)
- smooth spinner animation during streaming, eliminate flicker (e1d1da0)
- align live tool-block spacing with committed scrollback (55d5f54)
- make weak-terminal rendering coherent during streaming (f12463d)
- reduce streaming flicker via timer-aware defer + shell-progress throttle (9807060)
- cap pre-scroll rows so large commits don't leak blank lines (ddc5128)
- repair orphan tool_calls so malformed model output doesn't poison the session (566f544)

## v0.1.11 (2026-04-27)

### Features

- float live frame to sit immediately below content (26106f4)

### Bug Fixes

- stabilize bottom-area rendering during streaming (483cddd)

## v0.1.10 (2026-04-26)

### Features

- add `/thinking` to uniformly toggle extended reasoning (102d86f)

### Performance

- cut streaming flicker and improve per-line streaming (cd3a806)

### Refactors

- dedupe tool errors, slim api-errors, cap ocr cache (94af860)

### Chores

- add S_GRAY_90 (1bb9d77)

## v0.1.9 (2026-04-25)

### Features

- /usage shows token + cache-hit stats per session (f58b8f2)

### Chores

- prep for publish — debug log + search-key docs (23fb9b9)
- gitignore .x-code/ project state (c7ff756)

## v0.1.8 (2026-04-25)

### Features

- auto vision sub-agent for text-only providers (1642ba3)
- attach files and images to user messages (a13aa28)

### Bug Fixes

- silence esbuild signal-exit shim 'import-is-undefined' warning (906ea61)
- use powershell -EncodedCommand to fix windows quoting (888e5d1)

### Performance

- cut context bloat with truncation, loop guard, and prompt caching (5af7760)

### Documentation

- update docs (0f1ef15)

### Tests

- drop tautology tests, keep behavioral coverage (329deaa)

## v0.1.7 (2026-04-24)

### Bug Fixes

- normalize signal-exit v3/v4 interop in esbuild shim (59e9ac6)

## v0.1.6 (2026-04-24)

### Bug Fixes

- remove repeat changelog (bf251a4)
- deepseek-v4 multi-turn thinking mode 400 error (ef0f9da)
- -p mode cannot show product logo correctly (be61dcf)

## v0.1.5 (2026-04-24)

### Chores

- update readme files (7f27ca8)

### CI

- update release.yml (08a0f9b)

## v0.1.4 (2026-04-24)

### Features

- render failed tool results in red (3b68760)
- upgrade to latest model ids and fix context windows (a699d89)
- optimize all tool output format (1232cfc)
- markdown tables, lists, tool results + streaming-safe drain (53e54ca)
- soft-wrap long lines at viewport width (5685d72)
- compact slash-command rendering + SelectOptions in cell buffer (3898884)
- interactive /model picker + persist choice to ~/.x-code/config.json (ffa11ff)
- auto-continue on length finishReason + raise maxOutputTokens (7878568)
- add Brave fallback + fix over-compressed summaries (fcf6f3d)
- name plan files by topic slug + timestamp (e21deb9)
- improve no-API-key UX and raise input line cap (87bcd8f)
- up/down arrow and PageUp/PageDown cursor movement in input (8cab8ff)
- add cursor navigation to input box (baa0884)
- rewrite input and message rendering pipeline (a184454)
- improve webFetch + webSearch with caching, CF fallback, year injection (3fce43d)
- frame prompt input with top/bottom rules and fix version (73e51d1)
- overhaul terminal UI inspired by Claude Code (#3) (7b1ca5d)

### Bug Fixes

- blanks and hang around permission prompts (9a1559b)
- terminal occasionally flickers and jitters when rendering content. (83040a1)
- writeFile tool result shows correct line count instead of always 1 lines (c5f711a)
- eliminate large blank areas that appear during the rendering process (4891fad)
- an error occurs in rendering area content when resizing terminal height or width (d42ca0a)
- ali model api error (50c614e)
- dispatch typing/backspace immediately, debounce only pastes (58a152a)
- /model picker choice beats X_CODE_MODEL env var (a1a3533)
- pre-drain stream-result promises to close the rejection race (0cb20d5)
- pair tool results with calls by id; align continuation indent (411e83c)
- eliminate the issue of two pointers (68c250d)
- drop fake inverse-video cursor, show real caret instead (81a6ae4)
- terminal UI occasionally has a jitter problem when inputting text (#5) (ae98ecf)
- DECSTBM scrollback insertion, cursor-position-neutral (570a541)
- adjust state during render instead of setState-in-effect (f087f9e)
- gate auto-memory writes + validate category whitelist (074e590)
- pin signal-exit shim to the real named export (6a424e4)
- fast Ctrl+C exit + drop token summary print (100bbe1)
- eliminate bottom-region flicker + margin-top on user echo (d8f9b66)
- prevent Ctrl+C hang by symmetric raw-mode cleanup + terminal reset (624edc4)
- tui rendering error (0e737f3)
- ChatInput owns bottom region to eliminate render jitter (363c79f)
- eliminate CJK input render jitter (#4) (cc0ce37)
- avoid exact-terminal-width separator to prevent intermittent jitter (bc34659)
- permission UI rendering and plan mode entry logic (6e1691b)
- replace Ink border Box with manual separator lines (0bdfd13)
- CJK-aware viewport and double-ESC to clear input (efea0e0)
- cursor visible on overflow, Ctrl+C works during loading, Mac ⌃C (d91181a)
- add viewport for long input lines to prevent border artifacts (795369a)
- prevent cursor from wrapping to next line in input box (a4502a7)
- align permission UI, error handling, context compression, and exit with Claude Code (f7a9fd3)
- improve cross-platform compatibility and unify global config directory (fdbb59e)
- restore first-turn reply and sync theme with Claude Code (0443742)
- signal-exit ESM/CJS interop in esbuild plugin (92afff7)

### Refactors

- align with the claude code markdown renderer (60cdedd)
- split large modules, consolidate theme, cache perms (e9bd3b5)
- drop config.json in favor of env-only configuration (d746666)
- adopt AGENTS.md convention for project knowledge (2b558b7)
- align color theme with Claude Code's dark palette (dc3c62d)
- drive context compression by real API token usage (68a3c72)
- remove dead streamingText state and unused components (f47046e)
- drop auto cost estimation; sync code-flow doc (40b5060)

### Documentation

- rewrite README with bilingual (zh-CN default + English) versions (160e3b8)
- update docs (eefcb64)
- sync with recent code changes (exit flow, web-search, length continuation, build fix) (da79925)
- sync knowledge system docs and add Q&A reference (9c358d7)
- sync documentation with latest code changes (67ab350)
- show persistent env-var setup instead of session-only examples (32450f2)
- sync all docs with current implementation (84d1818)
- update docs description (9aa2398)
- add code-flow-analysis.md (c32b520)
- update docs (46214b6)
- add tools-comparison md (9f84cae)

### Chores

- udpate readme files (55a2611)
- update readme file (9280848)
- update readme doc names (7ebda48)
- remove plan-mode tools and related scaffolding (1ed61ae)
- remove DEBUG_STDOUT_PAYLOAD env (83313d5)
- DEBUG_STDOUT=1 taps stream/buffer/stdout pipeline (4a5435e)
- add source.removeUnusedImports for JSX React imports (2ee73f8)
- repair fixAll-on-save and drop deprecated tseslint.config (7d704a6)
- satisfy eslint react-hooks rules (56f1221)
- add x-code files (e606ba1)

### Other Changes

- back out DECSTBM history insertion (d228dc8)

## v0.1.3 (2026-04-04)

### Bug Fixes

- add repository field to package.json for OIDC provenance verification (3ba6d71)

## v0.1.2 (2026-04-04)

### Bug Fixes

- use npm publish with OIDC provenance instead of pnpm (22bfcfc)
- use NPM_TOKEN for npm publish authentication (7444647)
