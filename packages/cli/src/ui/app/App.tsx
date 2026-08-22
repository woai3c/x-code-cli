// @x-code-cli/cli — Root App component
import path from 'node:path'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  PROVIDER_BASE_URLS,
  createModelRegistry,
  errorMessage,
  estimateTokenCount,
  getAvailableProviders,
  getContextWindow,
  getOpenAIAuthStatus,
  getProviderModels,
  getReasoningTierOptions,
  listSessions,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  providerOf,
  refreshOpenAIChatGPTModels,
  resolveModelId,
  saveUserConfig,
  supportsReasoningTier,
  wrapActivatedSkill,
} from '@x-code-cli/core'
import type { AgentOptions, CacheMissSummary, DiffStats, LanguageModel, LoadedSession } from '@x-code-cli/core'
import type { SkillDefinition, StepStats, TokenUsage, UsageBreakdown } from '@x-code-cli/core'

import type { CliCleanupController } from '../../cleanup-controller.js'
import { drainPendingUpdateHint, registerUpdateHintHandler } from '../../startup-prints.js'
import { VERSION } from '../../version.js'
import { visibleBackgroundTerminals } from '../agent/shell-session-ui.js'
import { useAgent } from '../agent/use-agent.js'
import { usePeerInboxAdapter } from '../agent/use-peer-inbox-adapter.js'
import { isSlashCommandAllowedWhileBusy } from '../busy-command.js'
import { ChatInput } from '../chat-input/ChatInput.js'
import { rebuildPalette } from '../chat-input/palette.js'
import { buildThemePreview } from '../render/render-diff.js'
import { setShikiTheme } from '../render/shiki-highlight.js'
import { setSyntaxTheme } from '../render/syntax-highlight.js'
import { GLYPH_BULLET } from '../render/terminal-glyphs.js'
import {
  DEFAULT_THEME,
  THEMES,
  type ThemeName,
  getTheme,
  getThemeColors,
  parseThemeName,
  setTheme,
} from '../render/theme.js'
import { formatCompactionResult, formatTokenCount, parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
import { SLASH_COMMANDS } from './command-content.js'
import { formatStopResult } from './commands/background-terminal.js'
import { createBrowserCommandHandler } from './commands/browser.js'
import { createDoctorCommandHandler } from './commands/doctor.js'
import { parseGoalCreateArgs, tokenizeArgs } from './commands/goal.js'
import { createMcpCommandHandler } from './commands/mcp.js'
import { createPluginCommandHandler } from './commands/plugin.js'
import { routeSlashCommand } from './commands/router.js'
import { createSkillCommandHandler } from './commands/skill.js'
import type { SessionExitInfo } from './session-exit.js'
import {
  canResumeGoalStatus,
  compactionHintForResume,
  dedupeChoiceLabels,
  forkLineageHint,
  formatGoalStatus,
  formatRelativeTime,
} from './session-format.js'
import { formatUsageReport } from './usage-report.js'

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
  onCleanupReady?: (controller: CliCleanupController) => void
  /** Hand the post-Ink resume hint a live snapshot of the session.
   *  Wired in app.tsx — the registered getter is called from
   *  index.ts's gracefulShutdown after the terminal is reset, so the
   *  hint lands in the user's shell prompt area where they can copy
   *  the `xc --resume <id>` command. */
  onSessionInfoReady?: (getter: () => SessionExitInfo | null) => void
}

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
    activeTurnOwner,
    hasActiveForkBoundary,
    submit,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
    queueMessage,
    popQueuedMessage,
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    resolvePermission,
    resolveAuthority,
    resolveQuestion,
    abort,
    quiesce,
    cleanup,
    cleanupShells,
    listShellSessions,
    stopShellSessions,
    fork,
    clear,
    clearPeerContext,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getDiffStats,
    getContextBreakdown,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    reloadMemory,
    invalidateSystemPromptCache,
    addInfoMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    setPermissionMode,
  } = useAgent(model, options, initialSession)

  const peerInbox = usePeerInboxAdapter({
    service: options.peerService,
    activeOwner: activeTurnOwner,
    dialogsBlocked:
      state.permissionQueue.length > 0 || state.authorityRequest !== null || state.pendingQuestion !== null,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
    askQuestion,
  })

  // Bumped whenever /skill refresh mutates the registry in place. The
  // registry's object identity is stable across refresh (reload() rewrites
  // the internal map), so React needs an explicit dependency to know the
  // visible skill list changed — without this counter the memoized
  // skillCommands array would stay stale.
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)

  // Reasoning-effort tier label for the current model (e.g. "High", "Max"),
  // shown in the footer next to the model name. Kept in state instead of
  // recomputed on every render because resolveReasoningTierLabel does a sync
  // config-file read; refreshed on /model switches and tier picks.
  const [reasoningTierLabel, setReasoningTierLabel] = useState<string | null>(() =>
    resolveReasoningTierLabel(state.modelId),
  )

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
  // Track whether the current notice is an update hint (vs Ctrl+C notice).
  // Needed because the update hint string contains ANSI escape codes and
  // can't be distinguished from plain-text notices via startsWith.
  const isUpdateNoticeRef = useRef(false)
  // Timestamp of the most recent Ctrl+C. While inside the arm window the
  // next Ctrl+C exits; outside it, Ctrl+C just re-arms (and cancels the
  // running turn if any). Mirrors Claude Code's `useExitOnCtrlCD` 2s window.
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-clear the notice after the arm window expires.
  // Skip for update hints — they persist until the user sends their first
  // message (cleared in handleSubmit via isUpdateNoticeRef).
  useEffect(() => {
    if (!notice) return
    if (isUpdateNoticeRef.current) return
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
    onCleanupReady?.({ quiesce, terminateShells: cleanupShells, drain: cleanup })
  }, [cleanup, cleanupShells, quiesce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Register the post-exit session-info getter. Index.ts uses it after
  // resetTerminal to print "Resume: xc --resume <id>" to the shell.
  // Stable across renders since getSessionInfo reads loopStateRef
  // directly — registering once on mount is sufficient.
  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wire the update-hint callback (from startup-prints) into ChatInput's
  // footer `notice` slot, below the input box. This avoids the stderr
  // vs cell-grid rendering conflict that caused the leading character
  // ("U" in "Update") to be eaten.
  //
  // Two cases:
  //   a) cache-hit: hint arrived before mount → drainPendingUpdateHint now
  //   b) network-fetch: hint arrives later → registerUpdateHintHandler
  useEffect(() => {
    registerUpdateHintHandler((msg) => {
      isUpdateNoticeRef.current = true
      setNotice(msg)
    })
    const drained = drainPendingUpdateHint()
    if (drained) {
      isUpdateNoticeRef.current = true
      setNotice(drained)
    }
    return () => registerUpdateHintHandler(null)
  }, [])

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
    const byId = new Map(sessions.map((s) => [s.sessionId, s]))
    const choices = dedupeChoiceLabels(
      sessions.slice(0, 30).map((s) => {
        const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
        const ago = formatRelativeTime(s.mtime)
        const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
        const lineage = forkLineageHint(s, byId)
        return {
          label: `${s.name ? `${s.name}  ·  ` : ''}${preview}  ·  ${ago}`,
          description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}${lineage ? `  ·  ${lineage}` : ''}`,
          sessionId: s.sessionId,
          filePath: s.filePath,
        }
      }),
    )
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
    const resumed = await resume(loaded)
    if (!resumed.ok) {
      addInfoMessage(
        `Resume was not completed: ${resumed.reason}.${resumed.result ? `\n\n${formatStopResult(resumed.result)}` : ''}`,
      )
      return
    }
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.name ? `${loaded.name} — ` : ''}${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /** Format a DiffStats object into a compact string like "+42 -18 in main.ts". */
  function formatDiffStats(stats: DiffStats | null): string {
    if (!stats || stats.filesChanged.length === 0) return 'no code changes'
    const ins = `+${stats.insertions}`
    const del = `-${stats.deletions}`
    if (stats.filesChanged.length === 1) {
      return `${ins} ${del} in ${path.basename(stats.filesChanged[0]!)}`
    }
    return `${ins} ${del} in ${stats.filesChanged.length} files`
  }

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

        // Compute diff stats for each checkpoint in parallel.
        const statsArr = await Promise.all(ordered.slice(0, 30).map((c) => getDiffStats(c.ckptId)))

        const choices = ordered.slice(0, 30).map((c, i) => {
          const preview = (c.userPrompt || '(empty prompt)')
            .replace(/[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50)
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          const stats = statsArr[i]
          const diffLabel = formatDiffStats(stats ?? null)
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${diffLabel}  ·  ${c.ckptId}`,
            ckptId: c.ckptId,
            stats,
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

      // Step 2: confirmation — let the user choose what to restore.
      const stats = await getDiffStats(pickedId)
      const hasCodeChanges = stats !== null && stats.filesChanged.length > 0

      const restoreOptions = hasCodeChanges
        ? [
            { label: 'Restore code and conversation', description: `Rewind both (${formatDiffStats(stats)})` },
            { label: 'Restore conversation only', description: 'Keep current files unchanged' },
            { label: 'Restore code only', description: 'Keep full conversation, revert files' },
            { label: 'Cancel', description: '' },
          ]
        : [
            { label: 'Restore conversation', description: 'No code changes to revert' },
            { label: 'Cancel', description: '' },
          ]

      const restoreAnswer = await askQuestion('What would you like to restore?', restoreOptions)
      if (restoreAnswer === 'Cancel') {
        addInfoMessage('Rewind cancelled.')
        return
      }

      const restoreCode = restoreAnswer === 'Restore code and conversation' || restoreAnswer === 'Restore code only'
      const restoreConversation = restoreAnswer !== 'Restore code only'

      const mode = restoreCode && restoreConversation ? 'both' : restoreCode ? 'code' : 'conversation'
      const result = await rewind(pickedId, mode)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }

      const diffSummary = hasCodeChanges ? ` (${formatDiffStats(stats)})` : ''
      if (mode === 'both') {
        addInfoMessage(
          `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored${diffSummary}. Continue from here.`,
        )
      } else if (mode === 'code') {
        addInfoMessage(
          `**Code restored** to the state before: ${result.preview || '(empty prompt)'}${diffSummary}\n\nConversation unchanged.`,
        )
      } else {
        addInfoMessage(`**Conversation rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles unchanged.`)
      }
    },
    [addInfoMessage, askQuestion, getCheckpoints, getDiffStats, rewind],
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
    setShikiTheme(getThemeColors(name).syntaxPalette)
    rebuildPalette()
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
      { noOther: true },
    )

    const picked = choices.find((c) => c.label === answer)
    const resolved = picked?.name ?? DEFAULT_THEME

    applyTheme(resolved)
    saveUserConfig({ theme: resolved })

    if (picked) {
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
        `**Resumed session** — ${initialSession.name ? `${initialSession.name} — ` : ''}${preview}\n\nRestored ${initialSession.messages.length} message${initialSession.messages.length === 1 ? '' : 's'}. Continuing the same conversation.${hint}`,
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
    // Clear any update hint on first user action — the user saw it,
    // no need to keep it occupying the footer.
    if (isUpdateNoticeRef.current) {
      isUpdateNoticeRef.current = false
      setNotice(null)
    }

    // Mid-turn queue: while a turn is in flight, plain text doesn't start
    // a competing agentLoop (concurrent loops would corrupt the shared
    // message history) — it lands in the pending queue and gets injected
    // at the next tool boundary (see consumeQueuedInputs in use-agent).
    // Slash commands still route normally below; ChatInput and this handler
    // share the same explicit busy-safe command policy.
    const activeOwner = activeTurnOwner()
    if (activeOwner && !text.startsWith('/')) {
      const pendingSkill = pendingSkillRef.current
      if (pendingSkill) {
        pendingSkillRef.current = null
        // Display/inject split: the pending list + scrollback show the
        // user's own text; the model receives the skill envelope (same as
        // the idle path's silent submit).
        queueMessage(text, `${wrapActivatedSkill(pendingSkill)}\n\n${text}`)
      } else {
        queueMessage(text)
      }
      return
    }

    if (activeOwner && text.startsWith('/')) {
      if (!isSlashCommandAllowedWhileBusy(text, activeOwner, hasActiveForkBoundary())) {
        addInfoMessage(`Cannot run ${text.split(/\s+/, 1)[0]} while ${activeOwner} owns the active turn.`)
        return
      }
    }

    if (text.startsWith('/')) {
      await routeSlashCommand(text, {
        agent: {
          addCommandMessage,
          addCommandResult,
          addInfoMessage,
          clear,
          clearPeerContext,
          echoCommand,
          fork,
          listShellSessions,
          stopShellSessions,
          submit,
        },
        options,
        skillCommands,
        fileCommands,
        pendingSkillRef,
        handlers: {
          model: handleModelSwitch,
          thinking: handleThinkingToggle,
          theme: handleThemeSwitch,
          plan: handlePlanToggle,
          compact: handleCompact,
          goal: handleGoal,
          resume: handleResume,
          rewind: handleRewind,
          usage: handleUsage,
          usageHistory: handleUsageHistory,
          memory: handleMemory,
          skill: handleSkill,
          mcp: handleMcp,
          plugin: handlePlugin,
          browser: handleBrowser,
          doctor: handleDoctor,
        },
        exit,
      })
      return
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
    for (const models of Object.values(getProviderModels())) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /** Resolve the reasoning-effort tier label for a model (e.g. "High", "Max")
   *  from UserConfig.modelReasoningEffort, or null when the model has no tier
   *  configured or doesn't honor tiers. Mirrors the agent loop's effort
   *  resolution (getReasoningLevel) so the footer never shows a tier the
   *  loop would ignore. */
  function resolveReasoningTierLabel(modelId: string): string | null {
    if (!supportsReasoningTier(modelId)) return null
    const effort = loadUserConfig().modelReasoningEffort?.[modelId]
    if (!effort) return null
    return getReasoningTierOptions(modelId)?.find((option) => option.value === effort)?.label ?? effort
  }

  /**
   * Commit a model switch: rebuild the provider registry (so the new
   * provider's env-var API key is picked up), swap the live language-model
   * reference, persist to the user config, and echo a confirmation message.
   */
  function commitModelChange(commandText: string, newModelId: string) {
    if (
      getOpenAIAuthStatus().mode === 'chatgpt' &&
      newModelId.startsWith('openai:') &&
      !(getProviderModels().openai ?? []).some((model) => model.id === newModelId)
    ) {
      addCommandMessage(commandText, `${newModelId} is not available for the signed-in ChatGPT account.`)
      return
    }
    try {
      const registry = createModelRegistry()
      const newModel = registry.languageModel(newModelId as `${string}:${string}`)
      switchModel(newModelId, newModel)
      setReasoningTierLabel(resolveReasoningTierLabel(newModelId))
      saveUserConfig({ model: newModelId })
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleModelSwitch(commandText: string, arg: string) {
    const requestedModel = arg ? resolveModelId(arg) : undefined
    if (getOpenAIAuthStatus().mode === 'chatgpt' && (!requestedModel || requestedModel.startsWith('openai:'))) {
      await refreshOpenAIChatGPTModels(VERSION, { signal: AbortSignal.timeout(8_000) })
    }
    // With an explicit arg: keep the old scriptable path (alias or full id).
    if (arg) {
      const newModelId = requestedModel
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // No arg → interactive picker. Enumerate models whose provider has an
    // active authentication method so the list is actionable, not aspirational.
    const availableProviders = new Set(getAvailableProviders())
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(getProviderModels())) {
      if (!availableProviders.has(provider)) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `${GLYPH_BULLET} ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(
        commandText,
        'No models available — run `xc login` for ChatGPT or configure a provider API key, then restart.',
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
      // models the picker doesn't list. Skip tier/base-url dialogs for
      // free-form entries — they're edge-case one-offs.
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    const modelId = picked.id

    // ── Base URL picker (multi-endpoint providers) ──
    const modelProvider = providerOf(modelId)
    const baseUrlConfig = PROVIDER_BASE_URLS[modelProvider]
    if (baseUrlConfig) {
      const baseAnswer = await askQuestion(
        `Pick the API endpoint for ${modelProvider}:`,
        baseUrlConfig.options.map((o) => ({ label: o.label, description: o.url })),
        { noOther: true },
      )
      const chosen = baseUrlConfig.options.find((o) => o.label === baseAnswer)
      if (chosen) {
        const prev = loadUserConfig().baseUrls ?? {}
        saveUserConfig({ baseUrls: { ...prev, [modelProvider]: chosen.url } })
      }
      // Esc cancel keeps working — config stays as-is (may be empty,
      // may have a previous choice from an earlier picker session).
    }

    // ── Reasoning-tier picker ──
    // Only for models that actually honor a tier (e.g. thinkingLevel is
    // Gemini 3-only, Kimi reasoningEffort is K3-only); others keep the
    // binary /thinking toggle as their only knob.
    const tierOptions = getReasoningTierOptions(modelId)
    if (tierOptions?.length) {
      const tierAnswer = await askQuestion(
        `Reasoning effort for ${renderModelLabel(modelId)}:`,
        tierOptions.map((option) => ({ label: option.label, description: option.description })),
        { noOther: true },
      )
      const chosen = tierOptions.find((option) => option.label === tierAnswer)
      if (chosen) {
        const prev = loadUserConfig().modelReasoningEffort ?? {}
        saveUserConfig({ modelReasoningEffort: { ...prev, [modelId]: chosen.value } })
      }
      // Esc cancel = no tier saved; /thinking toggle fallback applies.
    }

    commitModelChange(commandText, modelId)
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
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // Empty answer = Esc-dismissed dialog (noOther removes the
      // free-form path, so a non-choice answer can only be Esc).
      addCommandMessage(commandText, `Cancelled — theme stays **${themeLabel(current)}**.`)
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

  async function handleGoal(arg: string) {
    try {
      const [subcommand = '', ...rest] = tokenizeArgs(arg)
      const goal = state.goalStatus
      const lower = subcommand.toLowerCase()

      if (!arg.trim() || lower === 'status') {
        addCommandResult(goal ? formatGoalStatus(goal, state.usage) : 'No current goal.')
        return
      }

      if (lower === 'pause') {
        const paused = await pauseGoal()
        addCommandResult(paused ? `Goal paused: ${paused.objective}` : 'No active goal to pause.')
        return
      }

      if (lower === 'resume') {
        const maxTurnsArg = rest[0] === '--max-turns' ? rest[1] : undefined
        if (maxTurnsArg && goal && canResumeGoalStatus(goal)) {
          if (maxTurnsArg.startsWith('+') && goal.maxTurns === undefined) {
            addCommandResult('Cannot add relative turns to an unlimited goal. Use an absolute --max-turns value.')
            return
          }
          const maxTurns = maxTurnsArg.startsWith('+')
            ? goal.maxTurns! + Number(maxTurnsArg.slice(1))
            : Number(maxTurnsArg)
          if (Number.isFinite(maxTurns) && maxTurns > 0) {
            await editGoal({ maxTurns })
          }
        }
        const resumed = await resumeGoal()
        addCommandResult(resumed ? `Goal resumed: ${resumed.objective}` : 'No goal to resume.')
        return
      }

      if (lower === 'cancel') {
        const cancelled = await cancelGoal()
        addCommandResult(cancelled ? `Goal cancelled: ${cancelled.objective}` : 'No goal to cancel.')
        return
      }

      if (lower === 'clear') {
        await clearGoal()
        addCommandResult('Goal cleared.')
        return
      }

      if (lower === 'steer') {
        const steering = rest.join(' ').trim()
        if (!steering) {
          addCommandResult('Usage: /goal steer <instruction>')
          return
        }
        const steered = await steerGoal(steering)
        addCommandResult(steered ? 'Goal steering queued.' : 'No goal to steer.')
        return
      }

      if (lower === 'edit') {
        const parsed = parseGoalCreateArgs(rest.join(' '))
        const edited = await editGoal({
          objective: parsed.objective || undefined,
          maxTurns: parsed.maxTurns,
        })
        addCommandResult(edited ? `Goal edited: ${edited.objective}` : 'No goal to edit.')
        return
      }

      if (lower === 'verify') {
        if (!goal) {
          addCommandResult('No goal to verify.')
          return
        }
        const verified = await verifyGoal()
        addCommandResult(
          verified
            ? `Goal verification ${verified.ok ? 'passed' : 'failed'}: ${verified.summary}`
            : 'No goal to verify.',
        )
        return
      }

      const parsed = parseGoalCreateArgs(arg)
      if (!parsed.objective) {
        addCommandResult(
          'Usage: /goal <objective> [--verify "cmd"] [--verifier-agent name] [--verifier-prompt "prompt"] [--max-turns n] [--token-budget n] [--confirm]',
        )
        return
      }
      if (goal?.status === 'active' || goal?.status === 'paused') {
        addCommandResult(`Cannot create a new goal while goal ${goal.id} is ${goal.status}`)
        return
      }
      addCommandResult(`Goal started: ${parsed.objective}`)
      await runGoal({
        objective: parsed.objective,
        maxTurns: parsed.maxTurns,
        tokenBudget: parsed.tokenBudget,
        verifiers: parsed.verifiers,
        requiresUserConfirmation: parsed.requiresUserConfirmation,
      })
    } catch (err) {
      addCommandResult(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCompact() {
    const result = await compact()
    switch (result.status) {
      case 'nothing':
        if (result.reason === 'no-conversation') {
          addCommandResult('Nothing to compress — no active conversation.')
        } else if (result.reason === 'too-few-messages') {
          addCommandResult(
            `Nothing to compress — ${result.messageCount} model message${result.messageCount === 1 ? '' : 's'}; at least ${result.minimumMessages} are required.`,
          )
        } else {
          addCommandResult(
            `Nothing to compress — conversation is ~${formatTokenCount(result.estimatedTokens)} tokens and fits within the ~${formatTokenCount(result.retentionTokens)} recent-message window.`,
          )
        }
        return
      case 'cancelled':
        addCommandResult('Compression cancelled.')
        return
      case 'failed':
        addCommandResult(`Compression failed: ${result.message}`)
        return
    }
    addCommandResult(formatCompactionResult(result.estimatedTokensBefore, result.estimatedTokensAfter))
  }

  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let breakdown: UsageBreakdown | null | undefined = state.usageBreakdown
    let cacheMissSummary: CacheMissSummary | null | undefined = state.cacheMissSummary
    let sessionName: string | undefined
    let steps: StepStats[] | undefined = state.stepStats.length > 0 ? state.stepStats : undefined
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
        steps = undefined
        breakdown = latest.usageBreakdown
        cacheMissSummary = latest.cacheMissSummary
      }
    }
    const contextEstimate = source === 'live' && usage.currentContextTokens > 0 ? getContextBreakdown() : null
    addInfoMessage(
      formatUsageReport(usage, modelId, source, sessionName, steps, breakdown, cacheMissSummary, contextEstimate),
    )
  }

  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const byId = new Map(sessions.map((s) => [s.sessionId, s]))
    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = dedupeChoiceLabels(
      sessions.map((s) => {
        const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
        const ago = formatRelativeTime(s.mtime)
        const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
        const lineage = forkLineageHint(s, byId)
        return {
          label: `${s.name ? `${s.name}  ·  ` : ''}${preview}  ·  ${ago}`,
          description: `${s.modelId}  ·  ${total} tokens${lineage ? `  ·  ${lineage}` : ''}`,
          sessionId: s.sessionId,
          session: s,
        }
      }),
    )

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
          `**${s.name ? `${s.name} — ` : ''}${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(
          formatUsageReport(
            usage,
            s.modelId,
            'history',
            s.name ?? (s.firstPrompt.slice(0, 80) || undefined),
            undefined,
            s.usageBreakdown,
            s.cacheMissSummary,
          ),
        )
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

  async function handleMemory(rawArg: string) {
    const service = options.memoryService
    if (!service) {
      addInfoMessage('Memory v2 is unavailable in this session.')
      return
    }
    const arg = rawArg.trim()
    if (!arg) {
      const topics = service.listTopics()
      if (topics.length === 0) {
        addInfoMessage('**Global memory** — empty.')
        return
      }
      const lines = [`**Global memory** — ${topics.length} topic${topics.length === 1 ? '' : 's'}.`, '']
      for (const topic of topics) {
        const detail = topic.summary || topic.description
        lines.push(`- ${topic.pinned ? '📌 ' : ''}\`${topic.id}\` · ${topic.type} · ${topic.facts} facts — ${detail}`)
      }
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg === 'status') {
      const status = await service.status()
      const lines = [
        `**Memory status** — ${status.error ? 'error' : status.initialized ? 'ready' : 'initializing'}`,
        '',
        `- Schema: ${status.schemaVersion ?? 'unsupported'} · generation ${status.generation}`,
        `- Topics: ${status.topics} · facts: ${status.facts}`,
        `- Queue: ${status.queue.pending} pending · ${status.queue.running} running · ${status.queue.failed} failed`,
        `- Worker: ${status.worker}`,
      ]
      if (status.lastRun) {
        lines.push(
          `- Last run: ${status.lastRun.status} · ${status.lastRun.operations} operations · ${status.lastRun.durationMs} ms`,
        )
      }
      if (status.error) lines.push(`- Error: ${status.error}`)
      for (const invalid of status.invalidTopics) lines.push(`- Invalid: \`${invalid.path}\` — ${invalid.error}`)
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg === 'reload') {
      try {
        await reloadMemory()
        const status = await service.status()
        addInfoMessage(
          `Memory reloaded — generation ${status.generation}, ${status.topics} topics, ${status.invalidTopics.length} invalid.`,
        )
      } catch (error) {
        addInfoMessage(`Memory reload failed: ${errorMessage(error)}`)
      }
      return
    }
    if (arg === 'explain') {
      const trace = service.getLastTrace()
      if (!trace) {
        addInfoMessage('No memory recall has run in this session yet.')
        return
      }
      const lines = [
        `**Memory recall** — generation ${trace.generation}${trace.selectorUsed ? ' · semantic selector used' : ''}`,
        '',
        `- Query: ${trace.query}`,
        `- Selected: ${trace.selectedTopicIds.join(', ') || '(none)'}`,
        `- Packed: ${trace.packedTokens} estimated tokens`,
        '',
        ...trace.candidates
          .slice(0, 10)
          .map(
            (candidate) =>
              `- \`${candidate.topicId}\` · ${candidate.score.toFixed(3)} · ${candidate.routes.join('+')} · coverage ${Math.round(candidate.coverage * 100)}%`,
          ),
      ]
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg.startsWith('search ')) {
      let query = arg.slice('search '.length).trim()
      const semantic = query.startsWith('--semantic ')
      if (semantic) query = query.slice('--semantic '.length).trim()
      if (!query) {
        addInfoMessage('Usage: /memory search [--semantic] <query>')
        return
      }
      try {
        const results = await service.search({ query, semantic, maxResults: 5 }, { repositoryId: process.cwd() })
        if (results.length === 0) {
          addInfoMessage(`No memory matched \`${query}\`.`)
          return
        }
        addInfoMessage(
          [`**Memory search** — ${results.length} results.`, '']
            .concat(
              results.map(
                (result) =>
                  `- \`${result.topicId}\` / ${result.section} — ${result.snippet.replace(/\s+/g, ' ').slice(0, 240)}`,
              ),
            )
            .join('\n'),
        )
      } catch (error) {
        addInfoMessage(`Memory search failed: ${errorMessage(error)}`)
      }
      return
    }
    addInfoMessage('Usage: /memory [status|search [--semantic] <query>|explain|reload]')
  }

  // Slash-command handlers live in ./commands/{skill,plugin,mcp}.ts. Each
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

  const { handleBrowser } = createBrowserCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
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
  const authorityRequest = state.authorityRequest
  const selectActive = !!state.pendingQuestion
  const visibleTerminals = visibleBackgroundTerminals(state.backgroundTerminals)

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
      peerInfluenced={state.peerInfluenced}
      trustMode={options.trustMode}
      pendingPeerCount={peerInbox.accepted + peerInbox.held}
      // Suppress the spinner's "Working" line while a select dialog is up,
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
              // "Working…" label leaves a multi-second read chain
              // looking stuck. `bufferingReads` is sticky across the
              // 50-200ms gaps between consecutive reads — without it
              // the label would flicker Reading-Working-Reading on
              // every tool. Updated by useAgent on tool-call /
              // text-delta / loop-end / abort.
              label: state.reconnectLabel
                ? state.reconnectLabel
                : state.compressionLabel
                  ? `Compressing — ${state.compressionLabel}`
                  : state.bufferingReads
                    ? 'Reading'
                    : 'Working',
              mode: state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      activeTurnOwner={activeTurnOwner()}
      hasStableForkBoundary={hasActiveForkBoundary()}
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
      // Footer right side: active model label, always shown. Re-renders
      // automatically on /model switch since switchModel updates
      // state.modelId. When the model has a reasoning-effort tier configured
      // (via the /model tier picker), it appends next to the name — e.g.
      // "deepseek-v4-flash · High".
      modelLabel={
        reasoningTierLabel
          ? `${renderModelLabel(state.modelId)} · ${reasoningTierLabel}`
          : renderModelLabel(state.modelId)
      }
      activeToolCalls={state.activeToolCalls}
      shellWaitStreak={state.shellWaitStreak}
      backgroundTerminalCount={visibleTerminals.length}
      backgroundTerminalWarningCount={
        visibleTerminals.filter((terminal) => terminal.status === 'termination-failed').length
      }
      todos={state.todos}
      queuedMessages={state.queuedMessages}
      onPopQueued={popQueuedMessage}
      draftRestore={state.restoredDraft}
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
      authorityRequest={
        authorityRequest
          ? {
              toolName: authorityRequest.toolName,
              preview: authorityRequest.preview,
              onResolve: resolveAuthority,
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
