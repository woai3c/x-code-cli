// @x-code-cli/cli — Root App component
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  estimateTokenCount,
  getAvailableProviders,
  getContextWindow,
  initProject,
  listSessions,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  saveUserConfig,
} from '@x-code-cli/core'
import type { AgentOptions, LanguageModel, LoadedSession, SessionListEntry, TokenUsage } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { buildThemePreview } from '../render-diff.js'
import { setSyntaxTheme } from '../syntax-highlight.js'
import {
  DEFAULT_THEME,
  THEMES,
  getTheme,
  getThemeColors,
  parseThemeName,
  setTheme,
  type ThemeName,
} from '../theme.js'
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
  onSessionInfoReady?: (
    getter: () => { sessionId: string; taskSlug: string; messageCount: number } | null,
  ) => void
}

/** Slash commands — used for both help text and tab completion */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  { name: '/model', description: 'Pick a model (no-arg = interactive) — choice is saved' },
  { name: '/thinking', description: 'Toggle extended thinking on/off (no-arg = show status) — saved' },
  { name: '/theme', description: 'Pick UI theme (no-arg = interactive picker) — drives diff colors + syntax palette' },
  { name: '/plan', description: 'Toggle plan mode on/off (no-arg = show status) — saved' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/resume', description: 'Pick a past session in this project to resume' },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage history', description: 'List past sessions in this project' },
  { name: '/session save', description: 'Force-flush the current session jsonl to disk' },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const

/** Render TokenUsage as a markdown block for /usage. cacheReadTokens is a
 *  subset of inputTokens, so the hit ratio is cacheRead / inputTokens — that
 *  matches what users care about ("of the prompt I sent, how much was cached"). */
function formatUsageReport(usage: TokenUsage, modelId: string, source: 'live' | 'snapshot'): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const hitRatio =
    usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
  const header = source === 'snapshot' ? '**Usage** (last session — no turns yet)' : '**Usage** (current session)'
  return [
    header,
    '',
    `- Model:           ${modelId}`,
    `- Input tokens:    ${fmt(usage.inputTokens)}`,
    `- Output tokens:   ${fmt(usage.outputTokens)}`,
    `- Cache read:      ${fmt(usage.cacheReadTokens)}  (${hitRatio} of input)`,
    `- Cache creation:  ${fmt(usage.cacheCreationTokens)}`,
    `- Total:           ${fmt(usage.totalTokens)}`,
    '',
    'Cache numbers depend on the provider — DeepSeek/Moonshot/Qwen may report 0 even when prefix caching is active.',
  ].join('\n')
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
function compactionHintForResume(
  tokens: number | null,
  estimatedTokens: number,
  modelId: string,
): string | null {
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

/** Render the per-session history list. Newest first; same project only.
 *  Sourced from the project's `.x-code/sessions/*.jsonl` files via
 *  `listSessions` — each row's totals come from the LAST `usage` meta
 *  entry in the file's tail (that's all the picker reads). Sessions
 *  with no usage line yet (interrupted before the first turn finished)
 *  show "—" for totals.
 *  Kept as a fenced code block so column alignment survives the markdown
 *  pipeline (otherwise the renderer collapses runs of spaces). */
function formatUsageHistory(sessions: SessionListEntry[]): string {
  if (sessions.length === 0) {
    return '**Usage history** — no past sessions found in this project.'
  }
  const fmt = (n: number) => n.toLocaleString('en-US')
  const rows = sessions.map((s) => {
    const date = new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')
    const usage = s.tokenUsage
    const total = usage ? fmt(usage.totalTokens) : '—'
    const hit =
      usage && usage.inputTokens > 0
        ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(0)}%`
        : '—'
    return { date, id: s.sessionId, model: s.modelId, total, hit }
  })
  const headers = { date: 'Updated', id: 'Session', model: 'Model', total: 'Total', hit: 'Cache' }
  const widths = {
    date: Math.max(headers.date.length, ...rows.map((r) => r.date.length)),
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
    total: Math.max(headers.total.length, ...rows.map((r) => r.total.length)),
    hit: Math.max(headers.hit.length, ...rows.map((r) => r.hit.length)),
  }
  const line = (r: typeof headers) =>
    `${r.date.padEnd(widths.date)}  ${r.id.padEnd(widths.id)}  ${r.model.padEnd(widths.model)}  ${r.total.padStart(widths.total)}  ${r.hit.padStart(widths.hit)}`
  const body = ['```', line(headers), ...rows.map(line), '```'].join('\n')
  return `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'} in this project\n\n${body}`
}

const HELP_TEXT =
  `X-Code CLI v${VERSION}\n\n` +
  SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
  `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
  `\nKeyboard: Esc to interrupt the current turn · ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} (twice) to exit`

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
    saveCurrentSession,
    addInfoMessage,
    addUserMessage,
    addCommandMessage,
    askQuestion,
    setPermissionMode,
  } = useAgent(model, options, initialSession)

  // Transient one-line hint shown above the spinner. Today only used for the
  // "Press Ctrl+C again to exit" double-press prompt — kept narrow on purpose
  // so future use-cases have a single rendering slot to share.
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
      addInfoMessage(
        `Using default theme **${themeLabel(resolved)}**. Run \`/theme\` any time to switch.`,
      )
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
          addInfoMessage(HELP_TEXT)
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
          clear()
          addCommandMessage('/clear', 'Conversation cleared.')
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
          await handleInit()
          return

        case 'usage':
          echoCommand(text)
          await handleUsage(arg)
          return

        case 'session':
          if (arg.toLowerCase() === 'save') {
            await handleSessionSave(text)
          } else {
            addCommandMessage(text, 'Unknown session command. Use `/session save`.')
          }
          return

        case 'exit':
          await cleanup()
          exit()
          return

        default:
          addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
          return
      }
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
        const marker = m.id === state.modelId ? '● ' : '  '
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
      `Current: ${state.modelId}\nPick a model (● = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
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
    addCommandMessage(
      commandText,
      `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`,
    )
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
      let next: boolean
      if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled') {
        next = true
      } else if (
        trimmed === 'off' ||
        trimmed === 'false' ||
        trimmed === '0' ||
        trimmed === 'disable' ||
        trimmed === 'disabled'
      ) {
        next = false
      } else {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`)
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
    const onMarker = current ? '● ' : '  '
    const offMarker = current ? '  ' : '● '
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
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (● = current):`,
      choices,
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
      label: `${t.name === current ? '● ' : '  '}${t.label}`,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))
    const answer = await askQuestion(
      `Current: **${themeLabel(current)}**. Choose the text style that looks best with your terminal (● = current):`,
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      const free = parseThemeName(answer ?? '')
      if (free === null) {
        addCommandMessage(
          commandText,
          `Cancelled — theme stays **${themeLabel(current)}**.`,
        )
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

  /** Toggle plan mode via /plan. Direct enter/exit, no picker — the
   *  Shift+Tab cycle (default → acceptEdits → plan → default) is
   *  multi-step, but `/plan` is the user explicitly asking for plan
   *  mode, so we go directly. `/plan` toggles plan ↔ whatever-was-
   *  before; `/plan on` / `/plan off` are idempotent setters for
   *  scripted flows. Matches Claude Code's `/plan` single-line
   *  confirmation output. */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled') {
      next = true
    } else if (
      trimmed === 'off' ||
      trimmed === 'false' ||
      trimmed === '0' ||
      trimmed === 'disable' ||
      trimmed === 'disabled'
    ) {
      next = false
    } else {
      addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
      return
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

  async function handleInit() {
    addInfoMessage('Initializing project structure...')
    try {
      const result = await initProject()
      const fileLines = result.createdFiles.map((f) => `  - ${f}`).join('\n')
      const body = result.createdFiles.length
        ? `**Project initialized**\n\nCreated:\n${fileLines}\n\nEdit \`AGENTS.md\` at the project root to describe your project — it is loaded into the agent's context every session.`
        : '**Project already initialized** — no new files created.'
      addInfoMessage(body)
    } catch (err) {
      addInfoMessage(`Init failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleSessionSave(commandText: string) {
    const saved = await saveCurrentSession()
    addCommandMessage(commandText, saved ? 'Session saved.' : 'No active session to save.')
  }

  /** /usage — show token totals and cache-hit ratio for this session.
   *  Prefers the live in-memory tally from useAgent (always current); on
   *  a fresh process with no turns yet, falls back to the most recent
   *  session jsonl in this project (its last `usage` meta line). The
   *  fallback path lets the user check yesterday's totals without
   *  starting a new turn. `/usage history` lists every past session. */
  async function handleUsage(arg: string) {
    if (arg.toLowerCase() === 'history') {
      const sessions = await listSessions()
      addInfoMessage(formatUsageHistory(sessions))
      return
    }
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
      }
    }
    addInfoMessage(formatUsageReport(usage, modelId, source))
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
      spinner={
        state.isLoading && !selectActive && !permissionRequest
          ? {
              label: 'Thinking',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
              totalTokens: state.usage.totalTokens,
            }
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
            }
          : null
      }
      commands={SLASH_COMMANDS}
    />
  )
}
