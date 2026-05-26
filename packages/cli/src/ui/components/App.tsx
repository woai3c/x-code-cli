// @x-code-cli/cli — Root App component
import fs from 'node:fs/promises'
import path from 'node:path'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  USER_XCODE_DIR,
  addKnownMarketplace,
  clearPluginEntry,
  createModelRegistry,
  detectScope,
  estimateTokenCount,
  expandCommandBody,
  fetchMarketplace,
  getAutoMemory,
  getAvailableProviders,
  getContextWindow,
  getMcpConfigPath,
  getPluginMcpServersFromDisk,
  getScopedDisabledSkills,
  getTokenStorage,
  installPlugin,
  listInstalledPlugins,
  listSessions,
  loadMergedConfigsFromDisk,
  loadSession,
  loadUserConfig,
  lookupPlugin,
  parseAdd,
  parseAddJson,
  parseRemove,
  pickLatestSession,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  readServerConfig,
  refreshPluginContributions,
  reloadSkillRegistry,
  removeKnownMarketplace,
  removeServerFromConfig,
  resolveContributions,
  resolveModelId,
  saveUserConfig,
  serverExists,
  setPluginEnabled,
  setSkillDisabled,
  skillSettingsPath,
  trustProject,
  uninstallPlugin,
  wrapActivatedSkill,
  writeServerToConfig,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  KnowledgeFact,
  LanguageModel,
  LoadedSession,
  PluginScope,
  PluginSource,
  SkillDefinition,
  SkillSettingsScope,
  TokenUsage,
} from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { buildThemePreview } from '../render-diff.js'
import { setSyntaxTheme } from '../syntax-highlight.js'
import { GLYPH_BULLET } from '../terminal-glyphs.js'
import { DEFAULT_THEME, THEMES, type ThemeName, getTheme, getThemeColors, parseThemeName, setTheme } from '../theme.js'
import { parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
import { ChatInput } from './ChatInput.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  /** Pre-loaded session from `xc --continue`. Hydrates the agent on
   *  first render so messages appear in scrollback before the user
   *  sends anything. Null when starting fresh. */
  initialSession?: LoadedSession | null
  /** When 'pick', App pops the resume picker on mount — the
   *  `xc --resume` flag path. Once Ink is ready (so askQuestion can
   *  render), the same code path as `/resume` runs. */
  resumeIntent?: 'pick' | null
  onCleanupReady?: (fn: () => Promise<void>) => void
  /** Hand the post-Ink resume hint a live snapshot of the session.
   *  Wired in app.tsx — the registered getter is called from
   *  index.ts's gracefulShutdown after the terminal is reset, so the
   *  hint lands in the user's shell prompt area where they can copy
   *  the `xc --resume <id>` command. */
  onSessionInfoReady?: (getter: () => { sessionId: string; taskSlug: string; messageCount: number } | null) => void
}

/** Slash commands — built-in static set used for help text and tab completion.
 *  Skill commands are appended dynamically at runtime from the skill registry. */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  {
    name: '/model',
    description: 'Pick a model (no-arg = interactive) — choice is saved',
    argumentHint: '[model-id]',
  },
  {
    name: '/thinking',
    description: 'Toggle extended thinking on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  {
    name: '/theme',
    description: 'Pick UI theme (no-arg = interactive picker) — drives diff colors + syntax palette',
    argumentHint: '[name]',
  },
  {
    name: '/plan',
    description: 'Toggle plan mode on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/resume', description: 'Pick a past session in this project to resume', argumentHint: '[id]' },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/review', description: 'Review a pull request (no-arg = list open PRs)', argumentHint: '[PR]' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage-history', description: 'List past sessions in this project' },
  { name: '/memory', description: 'Show auto-memory entries (project + user)' },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    // Subcommand menu fires on `/mcp ` or `/mcp <prefix>`. Order matches
    // handleMcp's switch in this file so the menu reflects every branch.
    subcommands: [
      { name: 'list', description: 'List configured MCP servers' },
      { name: 'tools', description: 'List tools from connected servers (optionally filter by server)' },
      { name: 'add', description: 'Add a new MCP server (stdio or http) to user / project config' },
      { name: 'add-json', description: 'Add an MCP server from a raw JSON config object' },
      { name: 'remove', description: 'Remove an MCP server from config' },
      { name: 'auth', description: 'Authenticate an HTTP MCP server via OAuth' },
      { name: 'logout', description: 'Clear stored OAuth tokens for a server' },
      { name: 'refresh', description: 'Reload mcpServers from disk and reconnect' },
    ],
  },
  {
    name: '/skill',
    description: 'Manage skills',
    subcommands: [
      { name: 'install', description: 'Fetch and install a skill from a URL' },
      { name: 'list', description: 'List installed skills (with on/off state)' },
      { name: 'refresh', description: 'Re-scan skills dirs and apply changes without restart' },
      { name: 'disable', description: 'Disable a skill (kept on disk; run /skill refresh to apply now)' },
      { name: 'enable', description: 'Re-enable a previously disabled skill' },
      { name: 'uninstall', description: 'Delete a skill directory from disk' },
    ],
  },
  {
    name: '/plugin',
    description: 'Manage plugins (bundled skills / agents / mcp / hooks)',
    // Subcommands mirror handlePlugin's switch. `marketplace` is itself a
    // sub-group with its own subcommands (add / remove / list / refresh / info).
    subcommands: [
      { name: 'list', description: 'List installed plugins (with enable state + source)' },
      { name: 'info', description: "Show a plugin's manifest, contributions, and hooks" },
      {
        name: 'install',
        description: 'Install a plugin from <name@marketplace>, git, github:owner/repo, or local path',
      },
      { name: 'uninstall', description: 'Remove a plugin (cache + settings entry; data dir preserved)' },
      {
        name: 'enable',
        description: 'Enable a plugin (writes settings — restart for full effect; --scope=user|project)',
      },
      { name: 'disable', description: 'Disable a plugin without uninstalling (--scope=user|project)' },
      { name: 'search', description: 'Search subscribed marketplaces by keyword' },
      { name: 'update', description: 'Reinstall a plugin from its recorded source' },
      { name: 'refresh', description: 'Live-reload plugins + skills/agents/commands/hooks/MCP servers' },
      { name: 'doctor', description: 'Show plugin load errors and integration warnings' },
      { name: 'marketplace', description: 'Manage marketplace subscriptions (add | remove | list | refresh | info)' },
    ],
  },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const

/** Render TokenUsage as a markdown block for /usage. cacheReadTokens is a
 *  subset of inputTokens, so the hit ratio is cacheRead / inputTokens — that
 *  matches what users care about ("of the prompt I sent, how much was cached"). */
function formatUsageReport(
  usage: TokenUsage,
  modelId: string,
  source: 'live' | 'snapshot' | 'history',
  sessionName?: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hitRatio = usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
  const headerMap = {
    live: '**Usage** (current session)',
    snapshot: '**Usage** (last session — no turns yet)',
    history: '**Usage** (history)',
  }
  const header = headerMap[source]
  const lines = [header, '']
  if (sessionName) lines.push(`- Session:         ${sessionName}`)
  lines.push(
    `- Model:           ${modelId}`,
    `- Input tokens:    ${fmt(usage.inputTokens)}`,
    `- Output tokens:   ${fmt(usage.outputTokens)}`,
    `- Cache read:      ${fmt(usage.cacheReadTokens)}  (${hitRatio} of input)`,
    `- Cache creation:  ${fmt(usage.cacheCreationTokens)}`,
    `- Total:           ${fmt(usage.totalTokens)}`,
    '',
    'Cache numbers depend on the provider — DeepSeek/Moonshot/Qwen may report 0 even when prefix caching is active.',
  )
  return lines.join('\n')
}

/** Build a "context X% used — consider /compact" hint when a resumed
 *  session's last-known input-token count (or character estimate, whichever
 *  is larger) is past 60% of the model's context window. Returns null
 *  below the threshold. We use the loaded `tokenUsage.inputTokens` first
 *  (the real number the provider reported on the last turn) and fall
 *  back to a character-based estimate when no usage line was recorded
 *  (e.g. interrupted before the first turn finished). The threshold is
 *  intentionally lower than the auto-compaction trigger (80%) so the
 *  user has a chance to /compact manually before the next turn either
 *  succeeds noisily or fires the auto path. */
function compactionHintForResume(tokens: number | null, estimatedTokens: number, modelId: string): string | null {
  const window = getContextWindow(modelId)
  const used = Math.max(tokens ?? 0, estimatedTokens)
  if (used === 0) return null
  const pct = (used / window) * 100
  if (pct < 60) return null
  return `\n\n_Context is at **${pct.toFixed(0)}%** of the ${window.toLocaleString('en-US')}-token window — consider \`/compact\` before continuing, or it'll auto-compress on the next turn._`
}

/** "5 minutes ago" / "2 hours ago" / "3 days ago" format, capped at days
 *  before falling back to a date. The picker shows this next to each
 *  session preview — relative time is more skimmable than ISO timestamps
 *  when you're scanning for "the one I worked on last week". */
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(epochMs).toISOString().slice(0, 10)
}

// formatUsageHistory was replaced by the interactive handleUsageHistory
// picker inside the component — see handleUsageHistory().

function buildHelpText(skillCommands: readonly { name: string; description: string }[]): string {
  const allCommands = [
    ...SLASH_COMMANDS,
    ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
  ]
  return (
    `X-Code CLI v${VERSION}\n\n` +
    allCommands.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
    `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
    `\nKeyboard: Esc to interrupt the current turn · ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} (twice) to exit`
  )
}

// Prompt body for `/init`. Submitted as the user message so the agent runs
// its full toolchain (Read/Glob/Grep/Edit/Write) over the codebase and
// authors AGENTS.md from real evidence rather than a static template.
//
// Style choices vs Claude Code's OLD_INIT:
//   - Targets AGENTS.md (our convention) rather than CLAUDE.md.
//   - Mentions AGENTS.local.md as the personal layer so the model doesn't
//     dump per-user preferences (sandbox URLs, role, tone) into the
//     team-shared file.
//   - Carries the NEW_INIT minimalism rule ("delete every line that, if
//     removed, would NOT cause the agent to make a mistake") — cheap to
//     port and the single biggest win against bloated AGENTS.md output.
//   - Asks the model to Edit-merge an existing AGENTS.md instead of
//     overwriting, so user-authored content survives a re-run of /init.
const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every X-Code CLI (\`xc\`) session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`

// Prompt body for `/review`. Mirrors Claude Code's local /review: a static
// template that points the agent at `gh` and asks for a structured review.
// `args` is the raw arg string after the command (PR number, or empty).
//
// The no-arg branch is intentionally locked down: empty `gh pr list` output =
// no open PRs, full stop. We've seen the model otherwise spend 8+ tool calls
// checking `gh auth`, branches, uncommitted diffs, etc. before pivoting to
// review whatever it found — wasteful and unrequested. The "use `gh`
// directly — no wrappers" line is there because models occasionally
// hallucinate generic wrappers (rtk, gh-aux, …) on the first call.
const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`

export function App({
  model,
  options,
  initialPrompt,
  initialSession,
  resumeIntent,
  onCleanupReady,
  onSessionInfoReady,
}: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    abort,
    cleanup,
    clear,
    compact,
    resume,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache,
    addInfoMessage,
    addUserMessage,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    setPermissionMode,
  } = useAgent(model, options, initialSession)

  // Bumped whenever /skill refresh mutates the registry in place. The
  // registry's object identity is stable across refresh (reload() rewrites
  // the internal map), so React needs an explicit dependency to know the
  // visible skill list changed — without this counter the memoized
  // skillCommands array would stay stale.
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)

  // Derived from options.skillRegistry. Recomputed when the registry
  // version bumps (via /skill refresh) so tab completion + /help reflect
  // the new skill set without restart.
  const skillCommands = useMemo(
    () => (options.skillRegistry ? options.skillRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // Combined command list: built-ins + loaded skills (for tab completion).
  const allCommands = useMemo(
    () => [...SLASH_COMMANDS, ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description }))],
    [skillCommands],
  )

  /** Skill pending injection: set when the user types `/skillname` with no
   *  argument (so we don't trigger an immediate AI response just to the skill
   *  XML). The skill content is prepended to the NEXT non-slash-command user
   *  message. Cleared on /clear or when consumed. */
  const pendingSkillRef = useRef<SkillDefinition | null>(null)

  // Transient one-line hint shown below the input box (in ChatInput's
  // footer slot, alongside the plan-mode / accept-edits indicators). Today
  // only used for the "Press Ctrl+C again to exit" double-press prompt —
  // kept narrow on purpose so future use-cases have a single rendering
  // slot to share. Mirrors Claude Code's PromptInputFooter placement.
  const [notice, setNotice] = useState<string | null>(null)
  // Timestamp of the most recent Ctrl+C. While inside the arm window the
  // next Ctrl+C exits; outside it, Ctrl+C just re-arms (and cancels the
  // running turn if any). Mirrors Claude Code's `useExitOnCtrlCD` 2s window.
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-clear the notice after the arm window expires.
  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  /** Ctrl+C handler — double-press to exit, single-press cancels in-flight
   *  turn (if any) and arms the exit hint. Mirrors Claude Code's behavior:
   *
   *    Idle   + 1st press → show "Press Ctrl+C again to exit", arm 2s window
   *    Idle   + 2nd press → exit
   *    Loading + 1st press → abort current turn, show hint, arm 2s window
   *    Loading + 2nd press → exit
   *
   *  The arm window auto-expires (notice clears via the effect above). */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // Second press within the window — user really means it. Exit cleanly
      // (Ink unmount → gracefulShutdown via onCleanupReady).
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  // Register cleanup function for graceful exit (SIGINT)
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // Register the post-exit session-info getter. Index.ts uses it after
  // resetTerminal to print "Resume: xc --resume <id>" to the shell.
  // Stable across renders since getSessionInfo reads loopStateRef
  // directly — registering once on mount is sufficient.
  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  /** /resume — list every past session in this project and let the user
   *  pick one to load. Reuses the askQuestion picker (same dialog as
   *  /model and the askUser tool) so we get consistent keyboard
   *  navigation, "Other"-as-freeform escape hatch, and Esc-to-cancel
   *  for free.
   *
   *  Picker label format: `[<short prompt>] <relative time> · N msgs`
   *  Each option carries the absolute file path in its description so
   *  the user can verify which session they're picking. After the user
   *  selects, we call `loadSession` (full file read this time, not the
   *  head/tail enrich pass) and pass it to `useAgent.resume` which
   *  hot-swaps the agent state. Wrapped in useCallback so the on-mount
   *  effect can reference it without tripping the react-hooks linter
   *  (function declarations defined later in the component body get
   *  flagged for closure-freshness even though JS hoists them). */
  const handleResume = useCallback(async () => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage(
        '**No past sessions found in this project.** Sessions are saved automatically — start working and one will appear here next time.',
      )
      return
    }
    const choices = sessions.slice(0, 30).map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}`,
        filePath: s.filePath,
      }
    })
    const answer = await askQuestion(
      `Pick a session to resume (${sessions.length} total in this project):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // User typed a free-form value into "Other". Treat as cancelled —
      // we don't try to fuzzy-match against session ids; the picker is
      // the supported way to pick.
      addInfoMessage('Resume cancelled.')
      return
    }
    const loaded = await loadSession(picked.filePath)
    if (!loaded) {
      addInfoMessage(`Failed to load session at ${picked.filePath}. The file may be corrupted.`)
      return
    }
    resume(loaded)
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /** Resolve a ThemeName back to its display label. */
  function themeLabel(name: ThemeName): string {
    return THEMES.find((t) => t.name === name)?.label ?? name
  }

  /** Apply a theme: update the active UI-theme state AND switch the
   *  syntax-highlight palette to the one bundled with the theme.
   *  Centralized so /theme, the first-run picker, and the startup
   *  loader all stay in sync — easy to forget one of the two and end
   *  up with bg colors that don't match the code colors. */
  function applyTheme(name: ThemeName) {
    setTheme(name)
    setSyntaxTheme(getThemeColors(name).syntaxPalette)
  }

  /**
   * First-run onboarding picker. Fires once when `config.json` has no
   * `theme` key — i.e. brand-new users on their first interactive
   * launch (resumes / `--print` / inline initial prompts skip it; see
   * the launch-flow effect below). After the user picks (or dismisses)
   * we persist the choice so the next launch never re-asks, even if
   * they bailed without an explicit selection — that's also their
   * answer ("default is fine").
   */
  async function runFirstRunThemePicker() {
    addInfoMessage(
      [
        '**Welcome to X-Code!**',
        '',
        'Choose the theme that looks best with your terminal. You can change it any time with `/theme`.',
      ].join('\n'),
    )

    const cols = Math.max(40, process.stdout.columns ?? 100)
    // Reserve room for the dialog's left margin (1 indent) + preview
    // sub-indent (2). The preview helper does its own padding to fill
    // the column, so being slightly generous on the budget is fine.
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))

    const answer = await askQuestion(
      'Pick a theme:',
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
    )

    const picked = choices.find((c) => c.label === answer)
    const parsedFree = parseThemeName(answer ?? '')
    const resolved = picked ? picked.name : (parsedFree ?? DEFAULT_THEME)

    applyTheme(resolved)
    saveUserConfig({ theme: resolved })

    if (picked || parsedFree !== null) {
      addInfoMessage(`Theme set to **${themeLabel(resolved)}**. Type a message to get started.`)
    } else {
      addInfoMessage(`Using default theme **${themeLabel(resolved)}**. Run \`/theme\` any time to switch.`)
    }
  }

  // On-mount resume handling. Three mutually-exclusive paths set up by
  // the CLI entry:
  //   - initialSession set: `xc -c` already loaded the most recent
  //     session synchronously. useAgent has hydrated the scrollback
  //     from it; we just need to drop a banner so the user knows they
  //     resumed (rather than thinking the messages are mysteriously
  //     pre-populated). No async work — just a visual hint.
  //   - resumeIntent === 'pick': `xc -r` wants the picker. We pop the
  //     same dialog as `/resume`.
  //   - neither: regular launch, optionally with initialPrompt to
  //     auto-submit.
  // The picker awaits askQuestion, which only resolves once the user
  // chooses, so we firewall it inside the effect and ignore the
  // returned promise — Ink doesn't care about pending async work in
  // effects.
  useEffect(() => {
    if (initialSession) {
      const preview = initialSession.firstPrompt.slice(0, 80) || '(no first prompt)'
      const hint =
        compactionHintForResume(
          initialSession.tokenUsage.inputTokens || null,
          estimateTokenCount(initialSession.messages),
          initialSession.modelId,
        ) ?? ''
      addInfoMessage(
        `**Resumed session** — ${preview}\n\nRestored ${initialSession.messages.length} message${initialSession.messages.length === 1 ? '' : 's'}. Continuing the same conversation.${hint}`,
      )
      return
    }
    if (resumeIntent === 'pick') {
      void handleResume()
      return
    }
    // First-run theme picker — only on plain interactive launches (no
    // resume, no auto-submitted initial prompt). Detected by absence of
    // `theme` in the on-disk config. Once the user picks (or dismisses)
    // we persist a value so this branch never re-fires. Resume / inline-
    // prompt launches deliberately skip — those users came here to
    // work, not to configure.
    if (!initialPrompt && loadUserConfig().theme === undefined) {
      void runFirstRunThemePicker()
      return
    }
    if (initialPrompt) {
      void submit(initialPrompt)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Print mode no longer flows through Ink — see packages/cli/src/print.ts.
  // The earlier effect tried to `cleanup().then(exit)` here, but the raw-stdin
  // ref from usePromptInput kept the event loop alive past unmount, so exit
  // would hang until a keypress or terminal resize.

  /** Echo a slash command to the message history (so the user can see what they typed) */
  function echoCommand(text: string) {
    addUserMessage(text)
  }

  /** Handle user input (including slash commands) */
  async function handleSubmit(text: string) {
    // Slash commands
    if (text.startsWith('/')) {
      const parts = text.slice(1).trim().split(/\s+/)
      const command = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ')

      switch (command) {
        case 'help':
          echoCommand(text)
          addInfoMessage(buildHelpText(skillCommands))
          return

        case 'model':
          handleModelSwitch(text, arg)
          return

        case 'thinking':
          handleThinkingToggle(text, arg)
          return

        case 'theme':
          await handleThemeSwitch(text, arg)
          return

        case 'plan':
          handlePlanToggle(text, arg)
          return

        case 'clear':
          // No echo / result message — ChatInput's shrink-detection path
          // wipes the visible terminal + scrollback so the user sees an
          // empty viewport with just the input box. Adding a "Conversation
          // cleared." line would force the cleared screen to immediately
          // start re-painting at row 1, defeating the "fresh launch" look
          // the user asked for.
          pendingSkillRef.current = null
          clear()
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
          return

        case 'resume':
          echoCommand(text)
          await handleResume()
          return

        case 'init':
          echoCommand(text)
          await submit(INIT_PROMPT, { silent: true })
          return

        case 'review':
          echoCommand(text)
          await submit(REVIEW_PROMPT(arg), { silent: true })
          return

        case 'usage':
          echoCommand(text)
          await handleUsage()
          return

        case 'usage-history':
          echoCommand(text)
          await handleUsageHistory()
          return

        case 'memory':
          echoCommand(text)
          handleMemory()
          return

        case 'skill':
          await handleSkill(text, arg)
          return

        case 'mcp':
          await handleMcp(text, arg)
          return

        case 'plugin':
          await handlePlugin(text, arg)
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default: {
          // Check if the command matches a loaded skill first.
          const skill = options.skillRegistry?.get(command)
          if (skill) {
            if (arg) {
              // Skill + immediate request — echo then inject and submit together
              // so the model applies the skill persona to the user's specific ask.
              // submit is silent so echoCommand provides the visible echo.
              // wrapActivatedSkill builds the same <activated_skill> envelope
              // (body + base directory + file list) used by the activateSkill
              // tool, so the two activation paths look byte-identical to the
              // model regardless of who triggered them.
              echoCommand(text)
              await submit(`${wrapActivatedSkill(skill)}\n\n${arg}`, {
                silent: true,
              })
            } else {
              // No follow-up yet — store the whole SkillDefinition so we can
              // re-format it with the same wrapper when the user's next
              // real message arrives. addCommandMessage handles the echo.
              pendingSkillRef.current = skill
              addCommandMessage(text, `Skill **${skill.name}** loaded. Type your request.`)
            }
            return
          }

          // Then check plugin-contributed slash commands. These map
          // `commands/<name>.md` files from any installed plugin to
          // `/<name>`. Body is sent as a model prompt with $ARGUMENTS
          // / ${CLAUDE_PLUGIN_ROOT} substitution applied.
          const cmd = options.commandRegistry?.get(command)
          if (cmd) {
            echoCommand(text)
            const expanded = expandCommandBody(cmd, arg)
            await submit(expanded, { silent: true })
            return
          }
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
        }
      }
    }

    // Prepend any pending skill context to the user's message, then clear it.
    const pendingSkill = pendingSkillRef.current
    if (pendingSkill) {
      pendingSkillRef.current = null
      await submit(`${wrapActivatedSkill(pendingSkill)}\n\n${text}`, { silent: true })
      return
    }
    await submit(text)
  }

  /** Look up a human-friendly label for a model id; falls back to the raw id. */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /**
   * Commit a model switch: rebuild the provider registry (so the new
   * provider's env-var API key is picked up), swap the live language-model
   * reference, persist to the user config, and echo a confirmation message.
   */
  function commitModelChange(commandText: string, newModelId: string) {
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleModelSwitch(commandText: string, arg: string) {
    // With an explicit arg: keep the old scriptable path (alias or full id).
    if (arg) {
      const newModelId = resolveModelId(arg)
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // No arg → interactive picker. Enumerate models whose provider has a
    // configured API key so the list is actionable, not aspirational.
    const providers = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      if (!providers.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `${GLYPH_BULLET} ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — set an API key (e.g. `ANTHROPIC_API_KEY`, `ALIBABA_API_KEY`) and restart.',
      )
      return
    }

    // askQuestion resolves to the chosen option's LABEL (not id). The
    // SelectOptions dialog is designed for human-readable choices, so we
    // look the id back up via the label we pushed.
    const answer = await askQuestion(
      `Current: ${state.modelId}\nPick a model (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // Empty answer = Esc-dismissed dialog. Quiet cancel — don't run
      // it through resolveModelId (which would print "Could not resolve
      // model: " with a blank id).
      if (!answer) {
        addCommandMessage(commandText, `Cancelled — model stays **${renderModelLabel(state.modelId)}**.`)
        return
      }
      // User chose "Other" or typed something free-form. Treat it as a
      // direct model id / alias so power users can still jump to exotic
      // models the picker doesn't list.
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    if (picked.id === state.modelId) {
      addCommandMessage(commandText, `Already on ${renderModelLabel(picked.id)} — no change.`)
      return
    }
    commitModelChange(commandText, picked.id)
  }

  /** Commit a thinking-mode change: update the live ref so the next
   *  agent turn uses it, persist to disk, and echo a Claude-style 2-line
   *  command block. */
  function commitThinkingChange(commandText: string, next: boolean) {
    setThinking(next)
    saveUserConfig({ thinking: next })
    addCommandMessage(commandText, `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`)
  }

  /**
   * `/thinking` — flip the extended-thinking toggle.
   *
   * No arg → interactive picker. Same UX as `/model` no-arg: shows the
   *   current state (`●` on the active option) and lets the user pick
   *   the other one with arrow keys + Enter. Cancelling / picking the
   *   already-active option results in no change.
   * `on` / `off` (and aliases like `true`/`false`/`enable`/`disable`)
   *   → direct switch, useful for scripting and muscle memory.
   * Any other arg → reject with a hint, don't silently swallow.
   *
   * The toggle is uniform across providers (see providers/thinking.ts):
   *   ON  applies the maximum reasoning each provider supports;
   *   OFF asks for minimum / disabled where exposed (Gemini 2.5 Pro
   *       can't be fully disabled — it gets clamped to its 128-token
   *       minimum).
   *
   * Persisted to ~/.x-code/config.json so the choice survives restarts.
   * The agent loop reads it on every turn via thinkingRef in useAgent,
   * so the next message after toggling already uses the new mode (no
   * model rebuild required, unlike /model).
   */
  async function handleThinkingToggle(commandText: string, arg: string) {
    const current = getThinking()
    const trimmed = arg.trim().toLowerCase()

    // Direct-switch shortcut path.
    if (trimmed) {
      const next = parseBooleanArg(trimmed)
      if (next === null) {
        addCommandMessage(
          commandText,
          `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`,
        )
        return
      }

      if (next === current) {
        addCommandMessage(commandText, `Extended thinking is already **${next ? 'on' : 'off'}** — no change.`)
        return
      }

      commitThinkingChange(commandText, next)
      return
    }

    // No-arg → interactive picker. We always show BOTH options so the
    // user sees the full state space, with `● ` marking the current
    // choice (mirroring `/model`'s rendering).
    const onMarker = current ? `${GLYPH_BULLET} ` : '  '
    const offMarker = current ? '  ' : `${GLYPH_BULLET} `
    const choices = [
      {
        label: `${onMarker}On`,
        description: 'Opt every supported provider into max reasoning. Slower, costs more, better on hard problems.',
      },
      {
        label: `${offMarker}Off`,
        description: 'Each provider runs its non-thinking default. Faster, cheaper, sufficient for most chat.',
      },
    ]
    const answer = await askQuestion(
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (${GLYPH_BULLET} = current):`,
      choices,
      { noOther: true },
    )
    const wantOn = answer === choices[0].label
    const wantOff = answer === choices[1].label
    if (!wantOn && !wantOff) {
      // User typed something free-form into the picker. Honour the
      // standard aliases; otherwise no-op (user probably wanted out).
      const free = (answer ?? '').trim().toLowerCase()
      if (free === 'on' || free === 'true' || free === '1' || free === 'enable' || free === 'enabled') {
        if (current) {
          addCommandMessage(commandText, 'Extended thinking is already **on** — no change.')
          return
        }
        commitThinkingChange(commandText, true)
        return
      }
      if (free === 'off' || free === 'false' || free === '0' || free === 'disable' || free === 'disabled') {
        if (!current) {
          addCommandMessage(commandText, 'Extended thinking is already **off** — no change.')
          return
        }
        commitThinkingChange(commandText, false)
        return
      }
      addCommandMessage(commandText, `Cancelled — extended thinking stays **${current ? 'on' : 'off'}**.`)
      return
    }
    const next = wantOn
    if (next === current) {
      addCommandMessage(commandText, `Already **${next ? 'on' : 'off'}** — no change.`)
      return
    }
    commitThinkingChange(commandText, next)
  }

  // themeLabel + applyTheme + runFirstRunThemePicker live ABOVE the
  // launch useEffect (the one at lines ~350) because that effect is what
  // fires the first-run picker. `react-compiler` flags references-before-
  // declaration inside effects with `[]` deps, so we hoist these helpers
  // up there. The /theme handlers (commitThemeChange, handleThemeSwitch)
  // stay near the other slash-command handlers since they're called from
  // the regular handleSubmit path which has looser hoisting requirements.

  /** Apply a theme switch: flip BOTH the active UI theme and its bundled
   *  syntax palette so the very next diff render uses the new colors,
   *  persist to user config, echo a confirmation. The agent loop /
   *  scrollback writer don't cache colors, so the change is visible
   *  immediately on the next tool result — no restart needed. */
  function commitThemeChange(commandText: string, name: ThemeName) {
    applyTheme(name)
    saveUserConfig({ theme: name })
    addCommandMessage(commandText, `Set theme to **${themeLabel(name)}**.`)
  }

  /**
   * `/theme` — pick the UI theme. Drives diff bg colors AND the
   * associated syntax-highlight palette.
   *
   * No arg → interactive picker showing all six themes with the current
   *   selection marked `●` and a live preview that recolors as the user
   *   arrows through. Same UX as `/model` and `/thinking`.
   * `<theme-name>` → direct switch. Accepts the canonical kebab-case
   *   names (`dark`, `light`, `dark-daltonized`, `light-daltonized`,
   *   `dark-ansi`, `light-ansi`) plus aliases (`colorblind`, `ansi`,
   *   etc.) — see `parseThemeName`.
   *
   * Persisted to ~/.x-code/config.json so the choice survives restarts.
   */
  async function handleThemeSwitch(commandText: string, arg: string) {
    const current = getTheme()

    if (arg.trim()) {
      const next = parseThemeName(arg)
      if (next === null) {
        const names = THEMES.map((t) => t.name).join(', ')
        addCommandMessage(commandText, `Unknown theme: \`${arg}\`. Available: ${names}.`)
        return
      }
      if (next === current) {
        addCommandMessage(commandText, `Theme is already **${themeLabel(next)}** — no change.`)
        return
      }
      commitThemeChange(commandText, next)
      return
    }

    // No arg → interactive picker. Show every theme; mark the current
    // one with `●`. Same dialog component the model picker uses, plus
    // a live preview pane that recolors as the user arrows through.
    const cols = Math.max(40, process.stdout.columns ?? 100)
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: `${t.name === current ? `${GLYPH_BULLET} ` : '  '}${t.label}`,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))
    const answer = await askQuestion(
      `Current: **${themeLabel(current)}**. Choose the text style that looks best with your terminal (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      const free = parseThemeName(answer ?? '')
      if (free === null) {
        addCommandMessage(commandText, `Cancelled — theme stays **${themeLabel(current)}**.`)
        return
      }
      if (free === current) {
        addCommandMessage(commandText, `Theme is already **${themeLabel(free)}** — no change.`)
        return
      }
      commitThemeChange(commandText, free)
      return
    }
    if (picked.name === current) {
      addCommandMessage(commandText, `Theme is already **${themeLabel(current)}** — no change.`)
      return
    }
    commitThemeChange(commandText, picked.name)
  }

  /** Toggle plan mode via /plan. Direct enter/exit, no picker —
   *  `/plan` is the user explicitly asking for plan mode, so we go
   *  directly. `/plan` toggles plan ↔ whatever-was-before; `/plan on`
   *  / `/plan off` are idempotent setters for scripted flows. Matches
   *  Claude Code's `/plan` single-line confirmation output. */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else {
      const parsed = parseBooleanArg(trimmed)
      if (parsed === null) {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
        return
      }
      next = parsed
    }

    if (next === current) {
      addCommandMessage(commandText, `Plan mode is already **${current ? 'on' : 'off'}** — no change.`)
      return
    }

    // /plan jumps directly between plan and default. We apply the mode
    // on loopState ourselves and let the existing onPlanModeChange
    // callback path do the React state / UI sync via setPermissionMode.
    setPermissionMode(next ? 'plan' : 'default')
    addCommandMessage(commandText, next ? 'Enabled plan mode' : 'Disabled plan mode')
  }

  async function handleCompact() {
    addInfoMessage('Compressing context...')
    await compact()
    addInfoMessage('Context compressed.')
  }

  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let sessionName: string | undefined
    const info = getSessionInfo()
    if (info?.firstPrompt) {
      sessionName = info.firstPrompt
    }
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
        sessionName = latest.firstPrompt.slice(0, 80) || undefined
      }
    }
    addInfoMessage(formatUsageReport(usage, modelId, source, sessionName))
  }

  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = sessions.map((s) => {
      const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
      const ago = formatRelativeTime(s.mtime)
      const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
      return {
        label: `${preview}  ·  ${ago}`,
        description: `${s.modelId}  ·  ${total} tokens`,
        session: s,
      }
    })

    const BACK_LABEL = '← Back to list'
    const tick = () => new Promise<void>((r) => setTimeout(r, 50))

    while (true) {
      const answer = await askQuestion(
        `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'}. Pick one to view details:`,
        choices.map((c) => ({ label: c.label, description: c.description })),
        { noOther: true },
      )

      const picked = choices.find((c) => c.label === answer)
      if (!picked) break

      const s = picked.session
      const usage = s.tokenUsage
      if (!usage) {
        addInfoMessage(
          `**${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(formatUsageReport(usage, s.modelId, 'history', s.firstPrompt.slice(0, 80) || undefined))
      }

      await tick()

      const back = await askQuestion(
        'Press Enter to return, or Esc to exit.',
        [{ label: BACK_LABEL, description: 'Go back to the session list.' }],
        { noOther: true },
      )

      if (!back) break
    }
  }

  /** Format a memory fact list for display in scrollback. */
  function formatMemoryList(scope: 'project' | 'user', facts: KnowledgeFact[]): string {
    if (facts.length === 0) {
      return `**Auto memory (${scope})** — empty.`
    }
    const byCategory = new Map<string, KnowledgeFact[]>()
    for (const f of facts) {
      const list = byCategory.get(f.category) ?? []
      list.push(f)
      byCategory.set(f.category, list)
    }
    const lines: string[] = [`**Auto memory (${scope})** — ${facts.length} fact${facts.length === 1 ? '' : 's'}.`, '']
    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`)
      for (const f of items) {
        lines.push(`- \`${f.key}\` — ${f.fact} _(${f.date})_`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }

  /** /memory — show all auto-memory entries (project + user). The
   *  extractor writes the underlying files in the background; users who
   *  want to delete or edit entries open `auto.md` directly. */
  function handleMemory() {
    const sections: string[] = []
    sections.push(formatMemoryList('project', getAutoMemory('project').getAll()))
    sections.push('')
    sections.push(formatMemoryList('user', getAutoMemory('user').getAll()))
    addInfoMessage(sections.join('\n'))
  }

  /** /mcp — manage MCP servers (list / tools / auth / logout / refresh).
   *
   *  Most subcommands are pure-read against `options.mcpRegistry`, which
   *  is the frozen snapshot from CLI startup. `auth` / `refresh` /
  /** Minimal YAML name extractor for SKILL.md frontmatter.
   *  Only needs to find `name: <value>` — full parse happens in the loader. */
  function extractSkillName(content: string): string | null {
    const match = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
    return match ? match[1].trim() : null
  }

  /** Split a skill argument into `(name, scope)`, recognizing
   *  `--scope=user` / `--scope=project` / `-s=user` etc. Bare arg with
   *  no flag returns `scope: undefined` so the caller can default off the
   *  skill's source. Unknown scope strings are ignored (scope stays
   *  undefined) — keeps the parser permissive. */
  function parseSkillScopeFlag(arg: string): { name: string; scope?: SkillSettingsScope } {
    const tokens = arg.split(/\s+/).filter(Boolean)
    let scope: SkillSettingsScope | undefined
    const remaining: string[] = []
    for (const tok of tokens) {
      const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
      if (m) {
        const value = m[1]?.toLowerCase()
        if (value === 'user' || value === 'project') scope = value
        continue
      }
      remaining.push(tok)
    }
    return { name: remaining.join(' '), scope }
  }

  async function handleSkill(text: string, arg: string) {
    const parts = arg.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()
    const subArg = parts.slice(1).join(' ').trim()

    if (sub === 'install') {
      if (!subArg) {
        addCommandMessage(text, 'Usage: `/skill install <url>`')
        return
      }
      let content: string
      try {
        const res = await fetch(subArg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        content = await res.text()
      } catch (err) {
        addCommandMessage(text, `Failed to fetch \`${subArg}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      const name = extractSkillName(content)
      if (!name) {
        addCommandMessage(text, 'Invalid SKILL.md: missing `name` in frontmatter.')
        return
      }

      const skillDir = path.join(USER_XCODE_DIR, 'skills', name)
      const skillFile = path.join(skillDir, 'SKILL.md')
      try {
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8')
      } catch (err) {
        addCommandMessage(text, `Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      addCommandMessage(
        text,
        `Skill **${name}** installed to \`${skillFile}\`\nRun \`/skill refresh\` to use \`/${name}\` now, or restart xc.`,
      )
      return
    }

    if (sub === 'list') {
      const skills = options.skillRegistry?.listAll() ?? []
      if (skills.length === 0) {
        const skillsPath = path.join(USER_XCODE_DIR, 'skills', '<name>', 'SKILL.md')
        addCommandMessage(
          text,
          `No skills loaded. Place SKILL.md files in \`${skillsPath}\` then run \`/skill refresh\` (or restart).`,
        )
        return
      }
      const lines = skills.map((s) => {
        const tag = s.disabled ? '[off]' : '[on] '
        return `- ${tag} **${s.name}** (${s.source}): ${s.description}`
      })
      addCommandMessage(text, `**Loaded skills** (${skills.length}):\n${lines.join('\n')}`)
      return
    }

    if (sub === 'refresh') {
      if (!options.skillRegistry) {
        addCommandMessage(text, 'No skill registry to refresh.')
        return
      }
      let summary
      try {
        summary = await reloadSkillRegistry(options.skillRegistry)
      } catch (err) {
        addCommandMessage(text, `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Invalidate prompt cache: both the system prompt's `## Available
      // Skills` block and the activateSkill tool description embed the
      // skill list. Better to take one cache miss than to send a stale
      // skill surface to the model. Same trade /mcp refresh makes.
      invalidateSystemPromptCache()
      // Drop a pending skill if the user `/<skillname>` for a skill that
      // was just removed or disabled — otherwise the next plain user
      // message would inject orphaned skill content.
      const pending = pendingSkillRef.current
      if (pending && !options.skillRegistry.get(pending.name)) {
        pendingSkillRef.current = null
      }
      // Force the slash-command tab completion + /help list to re-memo
      // off the new skill set. The registry object identity is stable
      // (reload() mutates in place), so the version counter is the
      // signal React needs to recompute the memoized list.
      setSkillRegistryVersion((v) => v + 1)

      const parts: string[] = []
      if (summary.added.length) parts.push(`added: ${summary.added.join(', ')}`)
      if (summary.removed.length) parts.push(`removed: ${summary.removed.join(', ')}`)
      if (summary.changed.length) parts.push(`changed: ${summary.changed.join(', ')}`)
      if (summary.unchanged.length) parts.push(`unchanged: ${summary.unchanged.join(', ')}`)
      if (parts.length === 0) parts.push('no skills found')
      const lines = [`Reloaded skills — ${parts.join('; ')}.`]
      // Tight `\n` between primary result and the advisory note — matches the
      // pattern used by /mcp refresh and the rest of /skill install / disable /
      // enable / remove. No blank line within a single command's result block.
      lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'disable' || sub === 'enable') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, `Usage: \`/skill ${sub} <name> [--scope=user|project]\``)
        return
      }
      const { name: bareName, scope } = parseSkillScopeFlag(name)
      const entry = options.skillRegistry?.getEntry(bareName)
      if (!entry) {
        addCommandMessage(
          text,
          `No skill named \`${bareName}\` is loaded. Run \`/skill list\` to see available skills.`,
        )
        return
      }
      // Default the disable scope to the skill's own source so users get the
      // expected "disable the project skill yansu" without typing --scope.
      // Re-enable is symmetric: clear from the source scope first; if the
      // skill is still effectively disabled it's because the OTHER scope
      // also lists it, and we'll surface that.
      const effectiveScope: SkillSettingsScope = scope ?? entry.source
      const disable = sub === 'disable'
      let result: 'changed' | 'noop'
      try {
        result = await setSkillDisabled(bareName, effectiveScope, disable)
      } catch (err) {
        addCommandMessage(text, `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const settingsFile = skillSettingsPath(effectiveScope)
      if (result === 'noop') {
        addCommandMessage(
          text,
          disable
            ? `Skill **${bareName}** is already disabled in ${effectiveScope} settings (\`${settingsFile}\`).`
            : `Skill **${bareName}** is not disabled in ${effectiveScope} settings (\`${settingsFile}\`).`,
        )
        return
      }
      // After re-enable, check whether the other scope is still hiding it
      // — common pitfall when the user disables at user scope and then expects
      // a project-level enable to revive it.
      let otherScopeNote = ''
      if (!disable) {
        const other: SkillSettingsScope = effectiveScope === 'user' ? 'project' : 'user'
        try {
          const stillDisabled = (await getScopedDisabledSkills(other)).includes(bareName)
          if (stillDisabled) {
            otherScopeNote = `\n_Note: \`${bareName}\` is also listed in ${other} settings (\`${skillSettingsPath(other)}\`). Run \`/skill enable ${bareName} --scope=${other}\` to fully re-enable._`
          }
        } catch {
          // best-effort hint — silent failure is fine
        }
      }
      const verb = disable ? 'Disabled' : 'Enabled'
      addCommandMessage(
        text,
        `${verb} skill **${bareName}** in ${effectiveScope} settings (\`${settingsFile}\`).${otherScopeNote}\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    if (sub === 'uninstall') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, 'Usage: `/skill uninstall <name>`')
        return
      }
      const entry = options.skillRegistry?.getEntry(name)
      if (!entry) {
        addCommandMessage(text, `No skill named \`${name}\` is loaded. Run \`/skill list\` to see available skills.`)
        return
      }
      // Plugin-contributed skills live under the plugin's cache dir, not
      // under <baseDir>/skills/. `/skill uninstall` here would compute the
      // wrong path and either no-op silently or remove an unrelated dir
      // — redirect the user to `/plugin uninstall` instead.
      if (entry.pluginId) {
        addCommandMessage(
          text,
          `Skill **${name}** comes from plugin \`${entry.pluginId}\` — uninstall it with \`/plugin uninstall ${entry.pluginId}\` instead of \`/skill uninstall\`.`,
        )
        return
      }
      const baseDir = entry.source === 'user' ? USER_XCODE_DIR : path.join(process.cwd(), '.x-code')
      const skillDir = path.join(baseDir, 'skills', name)
      try {
        await fs.rm(skillDir, { recursive: true, force: true })
      } catch (err) {
        addCommandMessage(text, `Failed to remove \`${skillDir}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Also clear any disable entries — leaving stale entries pointing
      // at an uninstalled skill would silently swallow a future re-install
      // with the same name (it'd come back disabled).
      try {
        await setSkillDisabled(name, 'user', false)
        await setSkillDisabled(name, 'project', false)
      } catch {
        // best-effort — main rm already succeeded
      }
      addCommandMessage(
        text,
        `Uninstalled skill **${name}** from \`${skillDir}\`.\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    addCommandMessage(
      text,
      'Usage: `/skill install <url>` · `/skill list` · `/skill refresh` · `/skill disable <name>` · `/skill enable <name>` · `/skill uninstall <name>`',
    )
  }

  /** Skills and MCP server config changes all require a CLI restart to take
   *  effect because the system prompt cache (and provider prefix caches) are
   *  stable for the session — same constraint as sub-agents (see CLAUDE.md).
   *  `logout` is the only mutator that takes effect immediately: it
   *  just deletes a token from disk; the actual reconnect happens at
   *  next launch. */
  // ── /plugin handler family ────────────────────────────────────────────
  //
  // Mirror /mcp / /skill in style: one top-level dispatcher (`handlePlugin`)
  // that switches on the first token, plus a marketplace sub-dispatcher
  // for the `marketplace` token's own sub-tree (add / remove / list /
  // refresh / info).
  //
  // A note on `/plugin refresh`: plugin contributions (skills / agents /
  // commands / hooks / MCP servers) get folded into their respective
  // long-lived registries at startup. `/plugin refresh` re-scans
  // installed plugins and folds the new state into those same registry
  // instances in place — that's why `/plugin install|enable|disable`
  // slash messages tell the user to run it. MCP servers are restarted
  // in the same pass via the shared restart path with `/mcp refresh`,
  // so a single command takes effect for all five contribution types.
  // The metadata view (`/plugin list`, `/plugin info`) reflects
  // in-memory state, so it's accurate the moment refresh completes.

  function formatPluginSource(s: PluginSource | undefined): string {
    if (!s) return '(unknown)'
    if (s.kind === 'local') return `local: ${s.path}`
    if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
    return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
  }

  async function handlePlugin(text: string, arg: string) {
    const trimmed = arg.trim()
    const parts = trimmed.split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === 'marketplace') return handlePluginMarketplace(text, rest)
    if (sub === '' || sub === 'list') return pluginList(text, arg)
    if (sub === 'info') return pluginInfo(text, rest)
    if (sub === 'install') return pluginInstall(text, rest)
    if (sub === 'uninstall') return pluginUninstall(text, rest)
    if (sub === 'enable') return pluginToggle(text, rest, true)
    if (sub === 'disable') return pluginToggle(text, rest, false)
    if (sub === 'search') return pluginSearch(text, rest)
    if (sub === 'update') return pluginUpdate(text, rest)
    if (sub === 'refresh') return void pluginRefresh(text)
    if (sub === 'doctor') return pluginDoctor(text)

    addCommandMessage(
      text,
      'Usage: `/plugin <list|info|install|uninstall|enable|disable|search|update|refresh|doctor|marketplace>`',
    )
  }

  function pluginList(text: string, raw: string) {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    // Optional filters: --enabled (only on), --disabled (only off), no flag = all.
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    let filter: 'all' | 'enabled' | 'disabled' = 'all'
    for (const t of tokens) {
      // Skip the subcommand word itself ('list') if present
      if (t === 'list') continue
      if (t === '--enabled') filter = 'enabled'
      else if (t === '--disabled') filter = 'disabled'
    }
    const all = reg.listAll()
    if (all.length === 0) {
      addCommandMessage(text, 'No plugins installed. Install one with `/plugin install <source>`.')
      return
    }
    const filtered =
      filter === 'enabled' ? all.filter((p) => p.enabled) : filter === 'disabled' ? all.filter((p) => !p.enabled) : all
    if (filtered.length === 0) {
      addCommandMessage(text, `No ${filter} plugins.`)
      return
    }
    const header =
      filter === 'all'
        ? `**Installed plugins** (${filtered.length}):`
        : `**Installed plugins** (${filter}, ${filtered.length} of ${all.length}):`
    // Match /skill list and /mcp list shape: header directly followed by
    // rows, no blank line in between. Sub-sections (e.g. the errors
    // footer below) keep their separator since they're a real visual break.
    const lines = [header]
    const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
    for (const p of filtered) {
      const badge = p.enabled ? '[on] ' : '[off]'
      const src = p.marketplace === 'local' ? '(local)' : `(${p.marketplace})`
      lines.push(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${src}`)
    }
    const errors = reg.loadErrors()
    if (errors.length > 0) {
      lines.push('', `${errors.length} load error${errors.length === 1 ? '' : 's'} — run \`/plugin doctor\`.`)
    }
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInfo(text: string, raw: string) {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin info <id>`  (id = `name@marketplace`)')
      return
    }
    const plugin = options.pluginRegistry?.getEntry(id)
    if (!plugin) {
      addCommandMessage(text, `No plugin \`${id}\` loaded. Check \`/plugin list\`.`)
      return
    }
    const c = await resolveContributions(plugin)
    const lines: string[] = [
      `**${plugin.id}** v${plugin.manifest.version}`,
      plugin.manifest.description ?? '_(no description)_',
      '',
      `- Enabled:     ${plugin.enabled ? 'yes' : 'no'}`,
      `- Source:      ${formatPluginSource(plugin.source)}`,
      `- Marketplace: ${plugin.marketplace}`,
      `- Root dir:    ${plugin.rootDir}`,
      `- Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`,
    ]
    if (plugin.manifest.author?.name) lines.push(`- Author:      ${plugin.manifest.author.name}`)
    if (plugin.manifest.homepage) lines.push(`- Homepage:    ${plugin.manifest.homepage}`)
    if (plugin.manifest.license) lines.push(`- License:     ${plugin.manifest.license}`)

    lines.push('', '**Contributions:**')
    let any = false
    if (c.skillsDir) {
      lines.push(`- skills:     ${c.skillsDir}`)
      any = true
    }
    if (c.agentsDir) {
      lines.push(`- agents:     ${c.agentsDir}`)
      any = true
    }
    if (c.commandsDir) {
      lines.push(`- commands:   ${c.commandsDir}`)
      any = true
    }
    if (c.mcpServers) {
      lines.push(`- mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
      any = true
    }
    if (c.hooks) {
      lines.push(`- hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
      any = true
    }
    if (!any) lines.push('- _(none)_')

    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInstall(text: string, raw: string) {
    if (!raw) {
      addCommandMessage(
        text,
        'Usage: `/plugin install <source>`\n' +
          '  Sources:\n' +
          '    `<name>@<marketplace>` — look up + install from subscribed marketplace\n' +
          '    `github:owner/repo[#ref]` — install from a GitHub repo\n' +
          '    `https://...` or `git@...` — install from any git URL\n' +
          '    `/abs/path` or `./relative/path` — install from a local directory',
      )
      return
    }

    // Slash-command args arrive as a single rest-of-line string; split
    // them so a stray `--yes` (carried over from the CLI subcommand
    // habit) doesn't get glued onto the path. `--yes` is implicit in
    // the slash form anyway — the TUI install path skips the consent
    // prompt because the modal flow isn't wired up yet. Anything else
    // unrecognised is surfaced rather than silently swallowed.
    const tokens = raw.trim().split(/\s+/)
    const source_str = tokens[0]!
    const extras = tokens.slice(1).filter((t) => t !== '--yes' && t !== '-y')
    if (extras.length > 0) {
      addCommandMessage(
        text,
        `Unrecognised arguments to \`/plugin install\`: ${extras.map((e) => `\`${e}\``).join(', ')}`,
      )
      return
    }
    raw = source_str

    let source: PluginSource
    let marketplace: string
    let expectedName: string | undefined

    const isPath = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(raw)
    const isGitUrl = /^https?:\/\//i.test(raw) || raw.startsWith('git@')
    const isGhShort = raw.startsWith('github:')
    const atIdx = raw.lastIndexOf('@')
    const isMarketplaceRef = atIdx > 0 && !isPath && !isGitUrl && !isGhShort

    if (isMarketplaceRef) {
      const name = raw.slice(0, atIdx)
      const mpName = raw.slice(atIdx + 1)
      const found = await lookupPlugin(`${name}@${mpName}`)
      if (!found) {
        addCommandMessage(
          text,
          `Plugin \`${name}\` not found in marketplace \`${mpName}\`. ` +
            `Run \`/plugin marketplace refresh ${mpName}\` or check the spelling.`,
        )
        return
      }
      source = found.entry.source
      marketplace = mpName
      expectedName = name
    } else if (isGhShort) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) {
        addCommandMessage(text, 'Invalid github source. Expected `github:owner/repo` or `github:owner/repo#ref`.')
        return
      }
      source = { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
      marketplace = 'local'
    } else if (isGitUrl) {
      source = { kind: 'git', url: raw }
      marketplace = 'local'
    } else if (isPath) {
      source = { kind: 'local', path: raw }
      marketplace = 'local'
    } else {
      addCommandMessage(
        text,
        `Unrecognised source: \`${raw}\`. Use \`name@marketplace\`, \`github:owner/repo\`, an https/git URL, or a path.`,
      )
      return
    }

    addCommandMessage(text, `Installing from ${formatPluginSource(source)} …`)
    try {
      const result = await installPlugin({ source, marketplace, expectedName })
      addCommandMessage(
        text,
        `Installed **${result.pluginId}** v${result.manifest.version}\n` +
          `Cache: \`${result.rootDir}\`\n` +
          `Run \`/plugin refresh\` to load this plugin's contributions now (skills / agents / commands / hooks). ` +
          `MCP servers need \`/mcp refresh\` separately.`,
      )
    } catch (err) {
      addCommandMessage(text, `Install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginUninstall(text: string, raw: string) {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin uninstall <id>` (id = `name@marketplace`)')
      return
    }
    try {
      const result = await uninstallPlugin(id)
      if (!result.removedRecord && result.removedVersions.length === 0) {
        addCommandMessage(text, `No plugin \`${id}\` installed.`)
        return
      }
      // Best-effort cleanup of settings entries in both scopes.
      for (const scope of ['user', 'project'] as PluginScope[]) {
        await clearPluginEntry(id, scope).catch(() => undefined)
      }
      const verCount = result.removedVersions.length
      addCommandMessage(
        text,
        `Uninstalled **${id}** (removed ${verCount} cached version${verCount === 1 ? '' : 's'}).\n` +
          `Plugin data dir preserved — reinstall will keep user state.\n` +
          `Run \`/plugin refresh\` to drop its contributions from active registries.`,
      )
    } catch (err) {
      addCommandMessage(text, `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Parse a `/plugin enable|disable` argument string, recognizing the
   *  shared `--scope=user|project` / `-s=user|project` flag (same parser
   *  shape as parseSkillScopeFlag). Default scope = 'user' so terse
   *  invocations stay terse. */
  function parsePluginScopeFlag(arg: string): { id: string; scope: PluginScope } {
    const tokens = arg.split(/\s+/).filter(Boolean)
    let scope: PluginScope = 'user'
    const remaining: string[] = []
    for (const tok of tokens) {
      const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
      if (m) {
        const value = m[1]?.toLowerCase()
        if (value === 'user' || value === 'project') scope = value
        continue
      }
      remaining.push(tok)
    }
    return { id: remaining.join(' '), scope }
  }

  async function pluginToggle(text: string, raw: string, enable: boolean) {
    const { id, scope } = parsePluginScopeFlag(raw)
    if (!id) {
      addCommandMessage(text, `Usage: \`/plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]\``)
      return
    }
    try {
      const result = await setPluginEnabled(id, scope, enable)
      const verb = enable ? 'enabled' : 'disabled'
      if (result === 'noop') {
        addCommandMessage(text, `Plugin \`${id}\` already ${verb} (${scope} scope).`)
      } else {
        addCommandMessage(text, `Plugin **${id}** ${verb} in ${scope} scope. Run \`/plugin refresh\` to apply now.`)
      }
    } catch (err) {
      addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginSearch(text: string, raw: string) {
    const kw = raw.trim().toLowerCase()
    if (!kw) {
      addCommandMessage(text, 'Usage: `/plugin search <keyword>`')
      return
    }
    const marketplaces = await readAllCachedMarketplaces()
    if (marketplaces.length === 0) {
      // Distinguish "no subscriptions" from "subscribed but no cache" so
      // the user can tell which fix to apply (add vs refresh).
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(
          text,
          'No subscribed marketplaces. Add one with `/plugin marketplace add <name> <source>` and `refresh` it.',
        )
      } else {
        const names = km.marketplaces.map((m) => m.name).join(', ')
        addCommandMessage(
          text,
          `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`/plugin marketplace refresh\` to fetch.`,
        )
      }
      return
    }
    const matches: Array<{ marketplace: string; name: string; description?: string; verified?: boolean }> = []
    for (const m of marketplaces) {
      for (const entry of m.plugins) {
        const hay = [entry.name, entry.description ?? '', ...(entry.keywords ?? [])].join(' ').toLowerCase()
        if (hay.includes(kw)) {
          matches.push({
            marketplace: m.name,
            name: entry.name,
            description: entry.description,
            verified: entry.verified,
          })
        }
      }
    }
    if (matches.length === 0) {
      addCommandMessage(
        text,
        `No plugins matching \`${kw}\` in ${marketplaces.length} subscribed marketplace${marketplaces.length === 1 ? '' : 's'}. ` +
          `Run \`/plugin marketplace refresh\` to pull latest indexes.`,
      )
      return
    }
    const lines = [`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`]
    for (const m of matches) {
      const tag = m.verified ? ' [verified]' : ''
      lines.push(`  ${m.name}@${m.marketplace}${tag}`)
      if (m.description) lines.push(`    ${m.description}`)
    }
    lines.push('', 'Install with `/plugin install <name>@<marketplace>`.')
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginUpdate(text: string, raw: string) {
    // Symmetric with the CLI: `<id>` updates one, `--all` updates every
    // installed plugin (sequential, skip-on-error). Bare invocation is
    // rejected so a typo doesn't accidentally re-clone everything.
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const all = tokens.includes('--all') || tokens.includes('-a')
    const positional = tokens.filter((t) => t !== '--all' && t !== '-a')

    if (all && positional.length > 0) {
      addCommandMessage(text, '`/plugin update`: pass either `--all` or a plugin id, not both.')
      return
    }
    if (!all && positional.length === 0) {
      addCommandMessage(
        text,
        'Usage: `/plugin update <id>` · `/plugin update --all`\n' +
          '  `<id>`: a `name@marketplace` from `/plugin list`\n' +
          '  `--all`: update every installed plugin (sequential, skip-on-error)',
      )
      return
    }

    if (all) {
      const records = await listInstalledPlugins()
      if (records.length === 0) {
        addCommandMessage(text, 'No plugins installed.')
        return
      }
      addCommandMessage(text, `Updating ${records.length} plugin${records.length === 1 ? '' : 's'} …`)
      const lines: string[] = []
      let updated = 0
      let unchanged = 0
      let failed = 0
      for (const rec of records) {
        try {
          const result = await installPlugin({
            source: rec.source,
            marketplace: rec.marketplace,
            expectedName: rec.name,
          })
          if (result.manifest.version === rec.version) {
            lines.push(`  ${rec.id}: reinstalled at ${rec.version}`)
            unchanged++
          } else {
            lines.push(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`)
            updated++
          }
        } catch (err) {
          lines.push(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      }
      lines.push('', `Summary: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`)
      if (updated > 0) lines.push('Run `/plugin refresh` to load the new versions.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    const id = positional[0]!
    const records = await listInstalledPlugins()
    const rec = records.find((r) => r.id === id)
    if (!rec) {
      addCommandMessage(text, `Plugin \`${id}\` not installed.`)
      return
    }
    addCommandMessage(text, `Reinstalling **${id}** from ${formatPluginSource(rec.source)} …`)
    try {
      const result = await installPlugin({
        source: rec.source,
        marketplace: rec.marketplace,
        expectedName: rec.name,
      })
      const versionMsg =
        result.manifest.version === rec.version
          ? `Reinstalled at the same version (${rec.version}).`
          : `Updated ${rec.version} → ${result.manifest.version}.`
      addCommandMessage(text, `${versionMsg} Run \`/plugin refresh\` to load the new version.`)
    } catch (err) {
      addCommandMessage(text, `Update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginRefresh(text: string) {
    if (!options.pluginRegistry) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    let summary
    try {
      summary = await refreshPluginContributions({
        pluginRegistry: options.pluginRegistry,
        skillRegistry: options.skillRegistry,
        subAgentRegistry: options.subAgentRegistry,
        commandRegistry: options.commandRegistry,
        hookBus: options.hookBus,
        // Pass mcpRegistry + askUser so plugin-contributed MCP servers
        // are restarted in the same refresh pass — installing a plugin
        // with an MCP server should take effect in one /plugin refresh,
        // not require a follow-up /mcp refresh.
        mcpRegistry: options.mcpRegistry,
        askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
        cwd: process.cwd(),
      })
    } catch (err) {
      addCommandMessage(text, `Failed to reload plugins: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // Invalidate the system prompt cache: plugin contributions feed into
    // skills, agents, commands — all of which the prompt mentions. Same
    // one-cache-miss trade /skill refresh + /mcp refresh make.
    invalidateSystemPromptCache()
    // Force the slash-command tab completion + /help list to re-memo off
    // the new skill set.
    setSkillRegistryVersion((v) => v + 1)

    const parts: string[] = []
    const p = summary.plugins
    if (p.added.length) parts.push(`added: ${p.added.join(', ')}`)
    if (p.removed.length) parts.push(`removed: ${p.removed.join(', ')}`)
    if (p.changed.length) parts.push(`changed: ${p.changed.join(', ')}`)
    if (parts.length === 0) parts.push(`no plugin changes (${p.unchanged.length} unchanged)`)
    const lines = [`Reloaded plugins — ${parts.join('; ')}.`]
    // Per-sub-registry deltas (only show ones that actually moved).
    const subBits: string[] = []
    if (summary.skills && (summary.skills.added.length || summary.skills.removed.length))
      subBits.push(`${summary.skills.added.length + summary.skills.removed.length} skill change(s)`)
    if (summary.subAgents && (summary.subAgents.added.length || summary.subAgents.removed.length))
      subBits.push(`${summary.subAgents.added.length + summary.subAgents.removed.length} sub-agent change(s)`)
    if (summary.commands && (summary.commands.added.length || summary.commands.removed.length))
      subBits.push(`${summary.commands.added.length + summary.commands.removed.length} command change(s)`)
    if (subBits.length) lines.push(`Downstream: ${subBits.join(', ')}.`)
    // MCP restart summary — same shape as /mcp refresh's output. Only
    // shown when this refresh actually moved an MCP server (in / out /
    // changed); the "all unchanged" case is silent to keep noise down.
    if (summary.mcp) {
      const m = summary.mcp
      const mcpBits: string[] = []
      if (m.added.length) mcpBits.push(`added: ${m.added.join(', ')}`)
      if (m.removed.length) mcpBits.push(`removed: ${m.removed.join(', ')}`)
      if (m.changed.length) mcpBits.push(`changed: ${m.changed.join(', ')}`)
      if (mcpBits.length) lines.push(`MCP — ${mcpBits.join('; ')}.`)
      else if (m.unchanged.length) lines.push(`MCP — ${m.unchanged.length} server(s) reconnected.`)
    }
    if (summary.mcpProjectSkipped) {
      lines.push('Note: project-level MCP servers were skipped (trust dialog declined).')
    }
    for (const e of summary.mcpConfigErrors ?? []) {
      lines.push(`MCP config error: ${e.name}: ${e.message}`)
    }
    lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
    addCommandMessage(text, lines.join('\n'))
  }

  function pluginDoctor(text: string) {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    const errors = reg.loadErrors()
    const all = reg.listAll()
    const lines: string[] = ['**Plugin doctor**']
    lines.push(`- Total loaded: ${all.length}`)
    lines.push(`- Enabled:      ${all.filter((p) => p.enabled).length}`)
    lines.push(`- Disabled:     ${all.filter((p) => !p.enabled).length}`)
    lines.push(`- Load errors:  ${errors.length}`)
    if (errors.length > 0) {
      lines.push('', '**Errors:**')
      for (const e of errors) {
        lines.push(`- ${e.id ?? '(unknown)'} at \`${e.path}\``)
        lines.push(`  ${e.message}`)
      }
    }
    lines.push(
      '',
      '_For deeper diagnostics (mcp collisions, hook errors, unsupported `commands` contributions), set `DEBUG_STDOUT=1` and check `~/.x-code/logs/debug.log`._',
    )
    addCommandMessage(text, lines.join('\n'))
  }

  async function handlePluginMarketplace(text: string, arg: string) {
    const parts = arg.trim().split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === '' || sub === 'list') {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(text, 'No marketplaces subscribed. Add one with `/plugin marketplace add <name> <source>`.')
        return
      }
      const lines = [`**Subscribed marketplaces** (${km.marketplaces.length}):`]
      const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
      for (const m of km.marketplaces) {
        const tag = m.reservedName ? ' [official]' : ''
        lines.push(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'add') {
      const argParts = rest.split(/\s+/)
      if (argParts.length < 2 || !argParts[0] || !argParts[1]) {
        addCommandMessage(
          text,
          'Usage: `/plugin marketplace add <name> <source>` (source: `github:owner/repo` or an https URL to a marketplace.json)',
        )
        return
      }
      const [name, ...sourceParts] = argParts
      const source = sourceParts.join(' ')
      try {
        await addKnownMarketplace({ name, source })
        addCommandMessage(
          text,
          `Subscribed to **${name}** (\`${source}\`). Run \`/plugin marketplace refresh ${name}\` to fetch its index.`,
        )
      } catch (err) {
        addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (sub === 'remove') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace remove <name>`')
        return
      }
      const result = await removeKnownMarketplace(rest)
      if (result === 'noop') addCommandMessage(text, `No marketplace \`${rest}\` subscribed.`)
      else addCommandMessage(text, `Unsubscribed from **${rest}**.`)
      return
    }

    if (sub === 'refresh') {
      const km = await readKnownMarketplaces()
      const targets = rest ? km.marketplaces.filter((m) => m.name === rest) : km.marketplaces
      if (targets.length === 0) {
        addCommandMessage(text, rest ? `No marketplace \`${rest}\` subscribed.` : 'No marketplaces subscribed.')
        return
      }
      const lines: string[] = [`Refreshing ${targets.length} marketplace${targets.length === 1 ? '' : 's'} …`]
      for (const t of targets) {
        try {
          const m = await fetchMarketplace(t)
          lines.push(`  ✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`)
        } catch (err) {
          lines.push(`  ✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'info') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace info <name>`')
        return
      }
      const all = await readAllCachedMarketplaces()
      const m = all.find((x) => x.name === rest)
      if (!m) {
        addCommandMessage(
          text,
          `No cached index for marketplace \`${rest}\`. Run \`/plugin marketplace refresh ${rest}\` first.`,
        )
        return
      }
      const lines: string[] = [`**${m.displayName ?? m.name}** (${m.name})`]
      if (m.upstreamName) lines.push(`Upstream name: ${m.upstreamName}`)
      if (m.description) lines.push(m.description)
      if (m.owner?.name) lines.push(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
      lines.push('', `${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
      for (const p of m.plugins) {
        const ver = p.verified ? ' [verified]' : ''
        const cat = p.category ? ` (${p.category})` : ''
        lines.push(`  ${p.name}${ver}${cat}`)
        if (p.description) lines.push(`    ${p.description}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    addCommandMessage(text, 'Usage: `/plugin marketplace <list|add|remove|refresh|info>`')
  }

  async function handleMcp(text: string, arg: string) {
    const argTrimmed = arg.trim()
    const sub = (argTrimmed.split(/\s+/)[0] ?? '').toLowerCase()
    const subArg = argTrimmed.slice(sub.length).trim()
    const registry = options.mcpRegistry

    switch (sub) {
      case '':
      case 'list': {
        const statuses = registry?.serverStatus() ?? []
        if (statuses.length === 0) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json then restart.')
          return
        }
        const lines = ['MCP servers:']
        const namePad = Math.max(...statuses.map((s) => s.name.length), 8) + 2
        for (const s of statuses) {
          let badge = ''
          switch (s.status.kind) {
            case 'connected':
              badge = `connected — ${s.status.toolCount} tool${s.status.toolCount === 1 ? '' : 's'}, ${s.status.resourceCount} resource${s.status.resourceCount === 1 ? '' : 's'}`
              break
            case 'disabled':
              badge = 'disabled'
              break
            case 'connecting':
              badge = 'connecting…'
              break
            case 'needs_auth':
              badge = `needs auth — run /mcp auth ${s.name} to log in`
              break
            case 'failed':
              badge = `failed — ${s.status.error}`
              break
          }
          lines.push(`  ${s.name.padEnd(namePad)} ${badge}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'tools': {
        const all = registry?.list() ?? []
        const filtered = subArg ? all.filter((t) => t.serverName === subArg) : all
        if (filtered.length === 0) {
          addCommandMessage(text, subArg ? `No tools on server "${subArg}".` : 'No MCP tools available.')
          return
        }
        const lines = [subArg ? `MCP tools on ${subArg}:` : 'All MCP tools:']
        for (const t of filtered) {
          const desc = t.description ? ` — ${t.description.slice(0, 160).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`  ${t.callableName}${desc}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'auth': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp auth <server-name>')
          return
        }
        if (!registry) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json first.')
          return
        }
        const config = registry.getConfig(subArg)
        if (!config) {
          addCommandMessage(text, `Unknown MCP server: "${subArg}". Run /mcp list to see configured servers.`)
          return
        }
        if (!('url' in config) || typeof config.url !== 'string') {
          addCommandMessage(
            text,
            `MCP server "${subArg}" is a stdio server — OAuth applies to HTTP servers (those with a "url" field) only.`,
          )
          return
        }
        // Drop stored tokens up front. If the user runs /mcp auth on a
        // server with valid tokens, we want a forced re-auth (matches
        // Gemini CLI semantics — running auth again is a "let me log in
        // from scratch", not "verify my existing session"). A separate
        // /mcp logout exists for users who just want to clear without
        // re-authing.
        try {
          await getTokenStorage().clear(subArg)
        } catch {
          // best-effort; an unwritable token store still lets the rest
          // of the flow run and the user will see the actual failure
          // when finishAuth tries to save.
        }
        addCommandMessage(text, `Authenticating "${subArg}" — opening browser...`)
        try {
          const server = await registry.authenticateServer(subArg, {
            onBrowserOpen: (url) => {
              // addCommandResult appends another `⎿` line under the same
              // echo — no leading blank, no trailing \n\n padding. Manual
              // ⎿/> prefixes are dropped because the helper supplies them.
              addCommandResult(`Opened ${url}\nWaiting for the authorization redirect...`)
            },
          })
          if (server.status.kind === 'connected') {
            // Tool surface may have grown — invalidate cache so the next
            // turn rebuilds the system prompt with the newly-available
            // tools.
            invalidateSystemPromptCache()
            addCommandResult(
              `✓ Authenticated "${subArg}" — ${server.status.toolCount} tool${
                server.status.toolCount === 1 ? '' : 's'
              }, ${server.status.resourceCount} resource${server.status.resourceCount === 1 ? '' : 's'}`,
            )
          } else if (server.status.kind === 'needs_auth') {
            addCommandResult(`⚠ Server still needs auth. The browser flow may have been cancelled.`)
          } else if (server.status.kind === 'failed') {
            addCommandResult(`✗ Auth completed but server failed to connect: ${server.status.error}`)
          } else {
            addCommandResult(`Server is now in state: ${server.status.kind}`)
          }
        } catch (err) {
          addCommandResult(`✗ Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'logout': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp logout <server-name>')
          return
        }
        try {
          await getTokenStorage().clear(subArg)
          addCommandMessage(
            text,
            `Removed stored OAuth tokens for "${subArg}". Run /mcp auth ${subArg} to log in again.`,
          )
        } catch (err) {
          addCommandMessage(text, `Failed to clear tokens: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'refresh': {
        if (!registry) {
          addCommandMessage(text, 'No MCP registry to refresh.')
          return
        }
        addCommandMessage(text, 'Re-reading MCP config and reconnecting servers...')
        try {
          // Include plugin-contributed mcpServers in the merged map. Without
          // this, a `/mcp refresh` run after a plugin install would silently
          // drop every plugin-contributed server because the merged map only
          // had user + project entries. The helper degrades to `{}` on any
          // plugin-scan failure (logged to debug.log) so an MCP-only refresh
          // doesn't fail because of an unrelated plugin-system hiccup.
          const extraServers = options.pluginRegistry ? await getPluginMcpServersFromDisk(process.cwd()) : undefined
          const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
            cwd: process.cwd(),
            askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
            extraServers,
          })
          const summary = await registry.restartAll(configs)
          // Invalidate prompt cache: the tool surface almost certainly
          // changed (even "all unchanged" servers re-list their tools
          // after reconnect, which can differ if the server has
          // hot-reloaded definitions). Better to take one cache miss
          // than to send a stale tool list.
          invalidateSystemPromptCache()

          const parts: string[] = []
          if (summary.added.length) parts.push(`added: ${summary.added.join(', ')}`)
          if (summary.removed.length) parts.push(`removed: ${summary.removed.join(', ')}`)
          if (summary.changed.length) parts.push(`changed: ${summary.changed.join(', ')}`)
          if (summary.unchanged.length) parts.push(`reconnected: ${summary.unchanged.join(', ')}`)
          if (parts.length === 0) parts.push('no servers configured')
          const lines = [`Reloaded MCP — ${parts.join('; ')}.`]
          lines.push(`Note: next message rebuilds the system prompt, so prompt-cache will miss once.`)
          if (projectSkipped) lines.push('Project-level MCP servers were skipped (not trusted).')
          for (const e of configErrors) lines.push(`Config error in ${e.name}: ${e.message}`)
          addCommandResult(lines.join('\n'))
        } catch (err) {
          addCommandResult(`✗ Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'add':
        await handleMcpAdd(text, subArg)
        return

      case 'add-json':
        await handleMcpAddJson(text, subArg)
        return

      case 'remove':
      case 'rm':
        await handleMcpRemove(text, subArg)
        return

      default: {
        addCommandMessage(
          text,
          `Unknown subcommand: /mcp ${sub}. Available: list, tools, add, add-json, remove, auth, logout, refresh.`,
        )
        return
      }
    }
  }

  /** /mcp add — write a new server to user (default) or project config.
   *
   *  Doesn't auto-connect: tool surface changes mid-session would invalidate
   *  the prompt cache and force a miss on the next turn (OpenAI-compatible
   *  providers' prefix cache). User is told to `/mcp refresh` or restart
   *  when they're ready — matches the design doc's "explicit refresh"
   *  philosophy.
   *
   *  --scope project also auto-trusts the project (the user running the
   *  command IS the consent signal — no point making them confirm a
   *  trust dialog for their own command on next start). Collaborators
   *  who clone the repo still go through the dialog normally. */
  async function handleMcpAdd(text: string, subArgRaw: string) {
    const res = parseAdd(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // Duplicate-check in the requested scope. We use serverExists rather
    // than detectScope here on purpose: cross-scope name reuse is allowed
    // (a user-scope and project-scope server can legitimately share a
    // name — e.g. a personal vs team-shared variant). Only same-scope
    // collisions block the add.
    if (await serverExists(name, scope, process.cwd())) {
      const existing = await readServerConfig(name, scope, process.cwd())
      const summary =
        existing && typeof existing === 'object'
          ? JSON.stringify(existing, null, 2)
              .split('\n')
              .map((l) => '  ' + l)
              .join('\n')
          : '(unreadable)'
      addCommandMessage(
        text,
        [
          `Server "${name}" already exists in ${scope} scope:`,
          summary,
          '',
          `Run /mcp remove --scope ${scope} ${name} first, or pick a different name.`,
        ].join('\n'),
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // For project scope, auto-trust this path so the user doesn't bump
    // into their own consent dialog on next launch.
    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // Non-fatal — they'll just see the trust dialog next launch.
      }
    }

    const transport = 'url' in config ? 'http' : 'stdio'
    const lines = [`Added MCP server "${name}" (${transport}) to ${written.path}.`]
    if (autoTrusted) {
      lines.push('Auto-trusted this project for future launches.')
    }
    if (scope === 'project') {
      lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    }
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp add-json — same as /mcp add but takes a raw JSON object for the
   *  config body. The escape hatch for complex configs that don't fit
   *  command-line flags (nested env, multiple headers, custom cwd, etc.). */
  async function handleMcpAddJson(text: string, subArgRaw: string) {
    const res = parseAddJson(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    if (await serverExists(name, scope, process.cwd())) {
      addCommandMessage(
        text,
        `Server "${name}" already exists in ${scope} scope. Run /mcp remove --scope ${scope} ${name} first.`,
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // best-effort
      }
    }

    const lines = [`Added MCP server "${name}" to ${written.path}.`]
    if (autoTrusted) lines.push('Auto-trusted this project for future launches.')
    if (scope === 'project') lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp remove — delete a server from config.json. Asks y/N before doing
   *  anything destructive (every other competitor skips this — we keep
   *  it because a typo can nuke a real entry and the cost of one extra
   *  keypress is near zero). Current session keeps running with whatever
   *  it had loaded — disconnecting mid-session has more downside (live
   *  tool calls get orphaned) than upside (the file change only matters
   *  at next launch / refresh). */
  async function handleMcpRemove(text: string, subArgRaw: string) {
    const res = parseRemove(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name } = res.command
    let scope = res.command.scope

    if (!scope) {
      // Auto-detect. The ambiguous case (both scopes) forces an explicit
      // --scope so we don't silently delete the wrong one.
      const detected = await detectScope(name, process.cwd())
      switch (detected.kind) {
        case 'not-found':
          addCommandMessage(text, `Server "${name}" is not in user or project config — nothing to remove.`)
          return
        case 'both':
          addCommandMessage(text, `Server "${name}" exists at both scopes. Specify --scope user or --scope project.`)
          return
        case 'user':
        case 'project':
          scope = detected.kind
          break
      }
    } else {
      // Explicit scope: verify presence before bothering the user with a
      // confirmation dialog.
      if (!(await serverExists(name, scope, process.cwd()))) {
        addCommandMessage(
          text,
          `Server "${name}" is not in ${scope} scope (${getMcpConfigPath(scope, process.cwd())}) — nothing to remove.`,
        )
        return
      }
    }

    const confirmAnswer = await askQuestion(
      `Remove MCP server "${name}" from ${scope} scope?\n  (${getMcpConfigPath(scope, process.cwd())})`,
      [
        { label: 'Remove', description: 'Delete this server entry. Current session unchanged.' },
        { label: 'Cancel', description: 'Keep the config as-is.' },
      ],
      { noOther: true },
    )
    if (confirmAnswer !== 'Remove') {
      addCommandMessage(text, `Cancelled — "${name}" not removed.`)
      return
    }

    let result: { path: string; removed: boolean }
    try {
      result = await removeServerFromConfig(name, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to remove "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.removed) {
      // Race: someone deleted the file or entry between detection and
      // remove. Idempotent path — just say so.
      addCommandMessage(text, `Server "${name}" was already gone from ${scope} scope.`)
      return
    }

    addCommandMessage(
      text,
      [
        `Removed "${name}" from ${scope} scope (${result.path}).`,
        'Current session unchanged — the running server (if any) keeps working until xc exits.',
        `Stored OAuth tokens (if any) kept — run /mcp logout ${name} to clear them too.`,
      ].join('\n'),
    )
  }

  // RENDERING ARCHITECTURE
  //
  // `ChatInput` owns the ENTIRE terminal region below the initial header:
  //   - scrollback messages are committed via direct stdout writes
  //   - spinner / input / separators / completions / errors / Permission
  //     dialog / SelectOptions dialog all render into a single cell-level
  //     diff buffer
  //
  // Ink's dynamic region is ALWAYS empty — we don't render any children
  // into Ink's own subtree. If Ink ever writes there, its internal use of
  // `\x1b7`/`\x1b8` clobbers our cursor anchor and leaves zombie frames.
  // Earlier versions kept SelectOptions as a direct Ink child, but when
  // the dialog grew taller than ChatInput, its rendering caused terminal
  // auto-scroll that left permanent blank rows in scrollback after the
  // dialog closed — so it's been moved into ChatInput's cell buffer too.
  const permissionRequest = state.permissionQueue[0]
  const selectActive = !!state.pendingQuestion

  return (
    <ChatInput
      messages={state.messages}
      initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={abort}
      permissionMode={state.permissionMode}
      isLoading={state.isLoading}
      notice={notice}
      // Suppress the spinner's "Thinking" line while a select dialog is up,
      // but keep ChatInput itself visible — the dialog is rendered INSIDE
      // its cell buffer now, not in Ink's top subtree.
      //
      // Permission dialogs must NOT suppress the spinner: the active-tool
      // list is rendered inside the `if (spinner)` block in ChatInput, so
      // nulling spinner hides those Running indicators — the user sees a
      // frozen screen with no visible permission prompt.
      spinner={
        state.isLoading && !selectActive
          ? {
              // While a chain of collapsible read tools is in flight the
              // per-tool live indicator is suppressed (would flash
              // "appear → vanish" on every fast read), and the generic
              // "Thinking…" label leaves a multi-second read chain
              // looking stuck. `bufferingReads` is sticky across the
              // 50-200ms gaps between consecutive reads — without it
              // the label would flicker Reading-Thinking-Reading on
              // every tool. Updated by useAgent on tool-call /
              // text-delta / loop-end / abort.
              label: state.bufferingReads ? 'Reading' : 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      contextUsage={
        // Footer indicator (`6.6k / 200k · 3%`) — uses the snapshot from the
        // most recent API response, NOT cumulative session counters.
        // Cumulative double-counts the message history every turn (cache-
        // served input still shows in `inputTokens`) so its numbers balloon
        // far past actual billing. Hidden until the first turn lands.
        state.usage.currentContextTokens > 0
          ? { used: state.usage.currentContextTokens, window: getContextWindow(state.modelId) }
          : null
      }
      activeToolCalls={state.activeToolCalls}
      todos={state.todos}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              mcp: permissionRequest.mcp,
              onResolve: resolvePermission,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
              dismissible: state.pendingQuestion.dismissible,
              layout: state.pendingQuestion.layout,
            }
          : null
      }
      commands={allCommands}
    />
  )
}
