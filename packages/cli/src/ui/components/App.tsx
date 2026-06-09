// @x-code-cli/cli — Root App component
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  estimateTokenCount,
  expandCommandBody,
  getAutoMemory,
  getAvailableProviders,
  getContextWindow,
  listSessions,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  saveUserConfig,
  wrapActivatedSkill,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  KnowledgeFact,
  LanguageModel,
  LoadedSession,
  SkillDefinition,
  TokenUsage,
} from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { createDoctorCommandHandler } from '../commands/doctor.js'
import { createMcpCommandHandler } from '../commands/mcp.js'
import { createPluginCommandHandler } from '../commands/plugin.js'
import { createSkillCommandHandler } from '../commands/skill.js'
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
  {
    name: '/rewind',
    description: 'Roll back files + conversation to a previous user message (no-arg = picker)',
    argumentHint: '[checkpoint-id]',
  },
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
  { name: '/doctor', description: 'Diagnose environment, API keys, MCP servers, plugins, and agents' },
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

function buildHelpText(
  skillCommands: readonly { name: string; description: string }[],
  fileCommands: readonly { name: string; description?: string }[],
): string {
  const allCommands = [
    ...SLASH_COMMANDS,
    ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
    // User / project / plugin markdown commands. Description is optional
    // for these (frontmatter-less command files are still valid).
    ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
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
    rewind,
    getCheckpoints,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    invalidateSystemPromptCache,
    addInfoMessage,
    addUserMessage,
    echoCommand,
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

  // File-based slash commands (user / project / plugin markdown files).
  // Recomputed off the same version counter as skills — /plugin refresh
  // bumps it after reloading both registries.
  const fileCommands = useMemo(
    () => (options.commandRegistry ? options.commandRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // Combined command list: built-ins + loaded skills + file commands
  // (for tab completion).
  const allCommands = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
      ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
    ],
    [skillCommands, fileCommands],
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

  /** Picker + executor for `/rewind`. With an arg, jumps straight to the
   *  named checkpoint (full or sha1-style prefix). Without, lists every
   *  checkpoint in this session newest-first with the user prompt that
   *  triggered it as the preview. The picker silently no-ops when nothing
   *  has been checkpointed (e.g. on the first turn before any user
   *  message has landed). */
  const handleRewind = useCallback(
    async (arg: string) => {
      const checkpoints = getCheckpoints()
      if (checkpoints.length === 0) {
        addInfoMessage(
          '**No rewind points yet.** A checkpoint is taken at the start of every user message — type something first, then `/rewind` will offer it.',
        )
        return
      }

      // Direct arg: exact ckptId match, then prefix. No fuzzy match —
      // ambiguous prefixes would silently roll back the wrong point.
      let pickedId: string | null = null
      if (arg) {
        const exact = checkpoints.find((c) => c.ckptId === arg)
        if (exact) pickedId = exact.ckptId
        else {
          const prefixed = checkpoints.filter((c) => c.ckptId.startsWith(arg))
          if (prefixed.length === 1) pickedId = prefixed[0]!.ckptId
          else if (prefixed.length > 1) {
            addInfoMessage(
              `Ambiguous checkpoint prefix \`${arg}\` (${prefixed.length} matches). Run \`/rewind\` and pick.`,
            )
            return
          } else {
            addInfoMessage(`No checkpoint matches \`${arg}\`. Run \`/rewind\` and pick.`)
            return
          }
        }
      }

      if (!pickedId) {
        // Newest first matches what users intuit when they think "go back
        // a step or two" — the freshest decision points are at the top.
        const ordered = [...checkpoints].reverse()
        const choices = ordered.slice(0, 30).map((c) => {
          const preview = (c.userPrompt || '(empty prompt)').slice(0, 60).replace(/\s+/g, ' ').trim()
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${c.ckptId}  ·  message #${c.messageCount}`,
            ckptId: c.ckptId,
          }
        })
        const answer = await askQuestion(
          `Pick a checkpoint to rewind to (${ordered.length} total in this session):`,
          choices.map((c) => ({ label: c.label, description: c.description })),
        )
        const picked = choices.find((c) => c.label === answer)
        if (!picked) {
          addInfoMessage('Rewind cancelled.')
          return
        }
        pickedId = picked.ckptId
      }

      const result = await rewind(pickedId)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }
      addInfoMessage(
        `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored. Continue from here.`,
      )
    },
    [addInfoMessage, askQuestion, getCheckpoints, rewind],
  )

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
          addInfoMessage(buildHelpText(skillCommands, fileCommands))
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

        case 'rewind':
          echoCommand(text)
          await handleRewind(arg)
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

        case 'doctor':
          handleDoctor(text)
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
    const result = await compact()
    if (!result) {
      addCommandResult('Nothing to compress — conversation is too short.')
      return
    }
    const beforeK = Math.round(result.beforeTokens / 1000)
    const afterK = Math.round(result.afterTokens / 1000)
    addCommandResult(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
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

  // Slash-command handlers live in ../commands/{skill,plugin,mcp}.ts. Each
  // factory closes over the App-render-time deps and returns the handler
  // the dispatcher above calls. Same per-render identity behaviour as
  // when these were inline function declarations.
  const { handleSkill } = createSkillCommandHandler({
    options,
    addCommandMessage,
    invalidateSystemPromptCache,
    pendingSkillRef,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handlePlugin } = createPluginCommandHandler({
    options,
    addCommandMessage,
    askQuestion,
    invalidateSystemPromptCache,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handleMcp } = createMcpCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    invalidateSystemPromptCache,
  })

  const handleDoctor = createDoctorCommandHandler({
    options,
    modelId: state.modelId,
    addInfoMessage,
    echoCommand,
  })

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
              label: state.compressionLabel
                ? `Compressing — ${state.compressionLabel}`
                : state.bufferingReads
                  ? 'Reading'
                  : 'Thinking',
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
