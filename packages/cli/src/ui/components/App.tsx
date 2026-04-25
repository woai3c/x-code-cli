// @x-code-cli/cli — Root App component
import { useEffect } from 'react'

import { useApp } from 'ink'

import {
  MODEL_ALIASES,
  PROVIDER_MODELS,
  createModelRegistry,
  getAvailableProviders,
  initProject,
  listSessionUsageSnapshots,
  loadLatestUsageSnapshot,
  resolveModelId,
  saveUserConfig,
} from '@x-code-cli/core'
import type { AgentOptions, LanguageModel, SessionUsageSnapshot, TokenUsage } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
import { useAgent } from '../hooks/use-agent.js'
import { getHeaderRowCount } from './AppHeader.js'
import { ChatInput } from './ChatInput.js'

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  onCleanupReady?: (fn: () => Promise<void>) => void
}

/** Slash commands — used for both help text and tab completion */
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  { name: '/model', description: 'Pick a model (no-arg = interactive) — choice is saved' },
  { name: '/thinking', description: 'Toggle extended thinking on/off (no-arg = show status) — saved' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage history', description: 'List past sessions in this project' },
  { name: '/session save', description: 'Save current session' },
  { name: '/exit', description: 'Exit (saves session)' },
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

/** Render the per-session history list. Newest first; same project only.
 *  Kept as a fenced code block so column alignment survives the markdown
 *  pipeline (otherwise the renderer collapses runs of spaces). */
function formatUsageHistory(snapshots: SessionUsageSnapshot[]): string {
  if (snapshots.length === 0) {
    return '**Usage history** — no past sessions found in this project.'
  }
  const fmt = (n: number) => n.toLocaleString('en-US')
  const rows = snapshots.map((s) => {
    const date = s.updatedAt.slice(0, 16).replace('T', ' ')
    const hit =
      s.usage.inputTokens > 0
        ? `${((s.usage.cacheReadTokens / s.usage.inputTokens) * 100).toFixed(0)}%`
        : '—'
    return { date, id: s.id, model: s.modelId, total: fmt(s.usage.totalTokens), hit }
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
  return `**Usage history** — ${snapshots.length} session${snapshots.length === 1 ? '' : 's'} in this project\n\n${body}`
}

const HELP_TEXT =
  `X-Code CLI v${VERSION}\n\n` +
  SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n') +
  `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
  `\nKeyboard: ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} to abort current operation`

export function App({ model, options, initialPrompt, onCleanupReady }: AppProps) {
  const { exit } = useApp()
  const {
    state,
    submit,
    resolvePermission,
    resolveQuestion,
    cleanup,
    clear,
    compact,
    switchModel,
    setThinking,
    getThinking,
    saveCurrentSession,
    addInfoMessage,
    addUserMessage,
    addCommandMessage,
    askQuestion,
  } = useAgent(model, options)

  // Register cleanup function for graceful exit (SIGINT)
  useEffect(() => {
    onCleanupReady?.(cleanup)
  }, [cleanup]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle initial prompt
  useEffect(() => {
    if (initialPrompt) {
      submit(initialPrompt)
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

        case 'clear':
          clear()
          addCommandMessage('/clear', 'Conversation cleared.')
          return

        case 'compact':
          echoCommand(text)
          await handleCompact()
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
   *  Prefers the live in-memory tally from useAgent (always current);
   *  on a fresh process with no turns yet, falls back to the last snapshot
   *  persisted in .x-code/sessions/latest.usage.json for this project.
   *  `/usage history` lists every past session in the current project. */
  async function handleUsage(arg: string) {
    if (arg.toLowerCase() === 'history') {
      const snapshots = await listSessionUsageSnapshots()
      addInfoMessage(formatUsageHistory(snapshots))
      return
    }
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    if (usage.totalTokens === 0) {
      const snapshot = await loadLatestUsageSnapshot()
      if (snapshot) {
        usage = snapshot.usage
        modelId = snapshot.modelId
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
      onInterrupt={exit}
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
            }
          : null
      }
      commands={SLASH_COMMANDS}
    />
  )
}
