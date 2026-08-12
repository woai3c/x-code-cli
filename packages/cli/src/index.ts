// @x-code-cli/cli — CLI entry point
import { Chalk } from 'chalk'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  McpPermissionStore,
  MemoryService,
  PROVIDER_DETECTION_ORDER,
  buildPluginIntegration,
  createCommandRegistry,
  createModelRegistry,
  createOAuthProviderFactory,
  createSkillRegistry,
  createSubAgentRegistry,
  debugLog,
  debugLogIntegrationDiagnostics,
  emptyHookBus,
  ensureDefaultMarketplaces,
  getAvailableProviders,
  getEnvVarName,
  getTokenStorage,
  listSessions,
  loadAllPlugins,
  loadMcpConfigsFromDisk,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  resolveStreamConfig,
  setPluginDebugMirror,
  shutdownBrowserMcp,
} from '@x-code-cli/core'
import type { AgentOptions, HookBus, LoadedSession, McpRegistry } from '@x-code-cli/core'

import { getCleanupFn, startApp } from './app.js'
import { parseCliArgs } from './cli-args.js'
import { restoreInvocationCwd } from './launch-cwd.js'
import { runPluginCli } from './plugins/cli.js'
import { checkForUpdate, printNoApiKeyMessage, printNoWebSearchKeyHint, printResumeHint } from './startup-prints.js'
import { rebuildPalette } from './ui/chat-input/palette.js'
import { setSyntaxTheme } from './ui/render/syntax-highlight.js'
import { getThemeColors, parseThemeName, setTheme } from './ui/render/theme.js'

restoreInvocationCwd()

// Route AI SDK warnings to debugLog instead of letting them blast straight
// to stderr. The default `console.warn` path bypasses ChatInput's
// cell-buffer rendering — every warning steals a row, knocks the input
// box's separators out of place, and drags zombie text into scrollback.
// Common offenders: `responseFormat JSON schema is used in a compatibility
// mode` (DeepSeek + structured-output combo), provider-side capability
// downgrades, etc. Captured to ~/.x-code/logs/debug.log when DEBUG_STDOUT
// is on, silently dropped otherwise.
//
// Must run BEFORE any code path that constructs an AI SDK call. Done at
// module top-level so it's set up before yargs even parses argv.
;(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: unknown[]
  provider?: string
  model?: string
}) => {
  for (const warning of options.warnings) {
    debugLog('ai-sdk.warning', `${options.provider ?? '?'}/${options.model ?? '?'}: ${JSON.stringify(warning)}`)
  }
}

const chalk = new Chalk({ level: process.stderr.isTTY && !process.env.NO_COLOR ? 3 : 0 })

const MIN_NODE_VERSION = [22, 0, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: X-Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────
//
// Single Ctrl+C path:
//   waitUntilExit() → gracefulShutdown() → resetTerminal → process.exit(0)
//
// Cleanup gets a short bounded drain window so session writes and child
// process shutdown can finish without making exit hang indefinitely.
// Token-usage summary is NOT printed on exit — none of the other
// four CLIs we compared (claude-code, codex, gemini-cli, opencode) do,
// and the delayed stdout flush made it appear after the shell prompt,
// confusing users.
let shutdownInProgress = false
/** Captured at startup so gracefulShutdown can close MCP servers
 *  (kill stdio child processes, terminate HTTP transports) on the way
 *  out. Without this, stdio servers would linger until they noticed
 *  their parent's stdin closed — usually fine, but explicit shutdown
 *  is faster and less surprising. */
let mcpRegistryForShutdown: McpRegistry | null = null
let memoryServiceForShutdown: MemoryService | null = null
/** Plugin hook bus captured at startup so gracefulShutdown can fire
 *  `SessionEnd` to plugin hooks before the process exits. */
let hookBusForShutdown: HookBus | null = null
const SHUTDOWN_DRAIN_TIMEOUT_MS = 1_500

// Belt-and-suspenders terminal restore. Runs synchronously before exit so even
// if Ink's unmount is partially broken (e.g. a useEffect cleanup threw, or the
// raw-mode ref-count leaked over a long session), the terminal is still left
// in a usable state. Safe to call multiple times — each escape is idempotent.
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try {
    fs.writeSync(1, '\x1b[0m') // reset SGR (colors, bold, inverse, ...) so the shell prompt isn't styled
    fs.writeSync(1, '\x1b[?2004l') // disable bracketed paste
    fs.writeSync(1, '\x1b[?25h') // show cursor
    fs.writeSync(1, '\x1b[?1049l') // exit alt screen (if ever entered)
    fs.writeSync(1, '\r\n') // land the shell prompt on a fresh line
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // Terminal may already be closed (SIGHUP, SSH disconnect) — ignore.
  }
}

async function gracefulShutdown(exitCode: number): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  const finalizers: Promise<unknown>[] = []
  const cleanup = getCleanupFn()
  if (cleanup) {
    finalizers.push(cleanup())
  } else if (memoryServiceForShutdown) {
    finalizers.push(memoryServiceForShutdown.shutdown(memoryServiceForShutdown.getConfig().drainTimeoutMs))
  }

  if (mcpRegistryForShutdown) {
    finalizers.push(mcpRegistryForShutdown.shutdown())
  }
  finalizers.push(shutdownBrowserMcp())

  if (hookBusForShutdown?.has('SessionEnd')) {
    finalizers.push(hookBusForShutdown.emit({ name: 'SessionEnd', session: { cwd: process.cwd(), modelId: '' } }))
  }

  let drainTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(finalizers),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (drainTimer) clearTimeout(drainTimer)
  }

  resetTerminal()
  // Print AFTER resetTerminal so the line lands cleanly above the
  // shell prompt — colors are reset, raw mode is off, cursor is
  // visible. The hint reads from a synchronously-captured snapshot
  // (registered by App via onSessionInfoReady), so we don't depend
  // on the still-running async cleanup.
  printResumeHint()
  process.exit(exitCode)
}

async function main() {
  checkNodeVersion()
  loadEnvFile()

  // Fire-and-forget update check — queries npm registry (with 24h disk
  // cache) and prints a one-line hint if a newer version exists. Never
  // blocks startup or throws. Suppressed for --print and non-TTY.
  void checkForUpdate().catch(() => undefined)

  // Non-interactive plugin management subcommand. Routed BEFORE yargs
  // parses the rest of argv — otherwise `xc plugin install ./foo`
  // would be treated as a prompt the agent should respond to. This
  // runs without mounting Ink and exits when done.
  const rawArgs = hideBin(process.argv)
  if (rawArgs[0] === 'plugin') {
    const exitCode = await runPluginCli(rawArgs.slice(1))
    process.exit(exitCode)
  }

  // Parse CLI arguments
  const argv = await parseCliArgs()

  const prompt = (argv._ as string[]).join(' ') || undefined

  // Check for stdin pipe input
  let stdinContent = ''
  if (!process.stdin.isTTY) {
    stdinContent = await readStdin()
  }

  const availableProviders = getAvailableProviders()

  // If no providers configured, show helpful message and exit
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    // Interactive startup keeps this as a configuration hint so `pnpm dev`
    // does not add package-manager noise. Print mode is automation-facing:
    // returning success there would make scripts mistake "nothing ran" for a
    // completed agent task.
    process.exit(argv.print ? 1 : 0)
  }

  // Resolve model
  let modelId = resolveModelId(argv.model)
  if (!modelId) {
    // User specified a model whose provider has no key
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      process.exit(1)
    } else {
      printNoApiKeyMessage()
      process.exit(0)
    }
  }

  // Guard against stale model ids whose provider isn't registered for this
  // launch — common when the user removes an env key but config.json still
  // points there, or when a provider was dropped from the build entirely
  // (e.g. kimicode after a feature revert). The registry would otherwise
  // throw NoSuchProviderError at `languageModel()` and fatal-exit before
  // the UI even mounts. For explicit `--model` we still hard-fail (the
  // user's intent is unambiguous); for persisted / smart-default ids we
  // fall back to the first available provider so the CLI stays usable.
  const requestedProvider = modelId.split(':')[0]
  if (!availableProviders.includes(requestedProvider)) {
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    if (argv.model) {
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
    if (!fallback) {
      // Defensive: availableProviders was non-empty above, so something
      // configured got us here — surface and exit cleanly.
      printNoApiKeyMessage()
      process.exit(0)
    }
    console.error(
      chalk.yellow(
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          `Falling back to '${fallback.defaultModel}'. Use /model to pick a different default.`,
      ),
    )
    modelId = fallback.defaultModel
  }

  // Apply persisted UI theme. Done early (before startApp) so the very
  // first scrollback row — including any messages we hydrate from a
  // resumed session containing edit / write tool calls — already paints
  // under the user's chosen theme (diff bg + syntax palette). Unknown
  // values (stale config, hand-edited file) silently fall back to the
  // default. The selected theme drives BOTH the diff bg colors (read
  // by render-diff.ts at render time) and the syntax-highlight palette
  // (set globally on the syntax-highlight module).
  {
    const t = parseThemeName(loadUserConfig().theme)
    if (t !== null) {
      setTheme(t)
      setSyntaxTheme(getThemeColors(t).syntaxPalette)
      rebuildPalette()
    }
  }

  // Create registries and get model
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)
  const memoryService = new MemoryService({
    resolveModel: (id) => providerRegistry.languageModel(id as `${string}:${string}`),
  })
  memoryServiceForShutdown = memoryService
  memoryService.setActiveModelId(modelId)
  await memoryService.initialize(process.cwd())

  // --plugin-debug / XC_PLUGIN_DEBUG=1: mirror plugin/hook/marketplace
  // debugLog breadcrumbs to stderr so they're visible live without
  // tailing ~/.x-code/logs/debug.log. Install BEFORE ensureDefaultMarketplaces
  // so first-run subscribe messages show up too. Done as a global hook on
  // debugLog rather than a new logger — keeps every existing call site
  // automatic and avoids two parallel logging paths.
  if (argv['plugin-debug'] || process.env.XC_PLUGIN_DEBUG === '1') {
    setPluginDebugMirror(true)
  }

  // Ensure the default `anthropic-marketplace` subscription is present.
  // Unrelated subscriptions are preserved; removing the default only lasts
  // until the next startup. Done before loadAllPlugins so the first run sees
  // a populated marketplaces list.
  if (argv.plugins !== false) {
    await ensureDefaultMarketplaces().catch((err) => debugLog('plugins.ensure-defaults-failed', String(err)))
  }

  // Plugins must load BEFORE skill / sub-agent / mcp registries so their
  // contributions can be folded into each. `--no-plugins` short-circuits
  // the entire chain. We surface non-fatal load errors to stderr in the
  // same style as `[mcp] config error in ...` below — one broken plugin
  // never blocks the others. Detailed diagnostics (collisions, unsupported
  // commands, hook errors) go to debug.log via
  // debugLogIntegrationDiagnostics for `/plugin doctor` to surface.
  const pluginLoad = await loadAllPlugins({ cwd: process.cwd(), disabled: argv.plugins === false })
  for (const e of pluginLoad.registry.loadErrors()) {
    console.error(chalk.yellow(`[plugin] ${e.id ?? e.path}: ${e.message}`))
  }
  const pluginIntegration = await buildPluginIntegration(pluginLoad)
  debugLogIntegrationDiagnostics(pluginIntegration)
  if (pluginIntegration.mcpErrors.length > 0) {
    for (const e of pluginIntegration.mcpErrors) {
      console.error(chalk.yellow(`[plugin] ${e.pluginId}: ${e.message}`))
    }
  }

  const subAgentRegistry = await createSubAgentRegistry({ extraDirs: pluginIntegration.agentsDirs })
  const skillRegistry = await createSkillRegistry({ extraDirs: pluginIntegration.skillsDirs })
  const commandRegistry = await createCommandRegistry({ extraDirs: pluginIntegration.commandsDirs })

  // MCP: Phase 1 — read configs + run trust dialog. This is fast (disk
  // reads + optional readline prompt) and MUST happen before Ink mounts
  // because the trust dialog uses raw readline on stdin. Actual server
  // connections are deferred to Phase 2 (post-render, async) so the UI
  // appears instantly even when remote HTTP MCP servers are slow.
  const tokenStorage = getTokenStorage()
  const mcpPermissionStore = new McpPermissionStore()
  const mcpLoadResult = await loadMcpConfigsFromDisk({
    cwd: process.cwd(),
    extraServers: pluginIntegration.mcpServers,
    askUser: (question, opts) => askInTerminal(question, opts),
    oauthProviderFor: createOAuthProviderFactory(tokenStorage, (server, url) => {
      debugLog('mcp.open-browser', `${server}: ${url}`)
    }),
    onExitRequested: () => process.exit(0),
  })
  mcpRegistryForShutdown = mcpLoadResult.registry
  // Don't fire SessionEnd hooks when --no-hooks is set — the user
  // explicitly opted out of all hook execution this session.
  hookBusForShutdown = argv.hooks === false ? null : pluginIntegration.hookBus

  if (mcpLoadResult.configErrors.length > 0) {
    for (const e of mcpLoadResult.configErrors) {
      console.error(chalk.yellow(`[mcp] config error in ${e.name}: ${e.message}`))
    }
  }
  if (mcpLoadResult.projectSkipped) {
    console.error(chalk.yellow(`[mcp] Project-level MCP servers skipped (not trusted).`))
  }
  // Preload the always-allow list so the first tool call doesn't pay
  // the file-read latency.
  await mcpPermissionStore.preload()

  const userConfig = loadUserConfig()
  const streamConfig = resolveStreamConfig(userConfig)
  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    printMode: argv.print,
    maxTurns: argv['max-turns'],
    streamMaxRetries: streamConfig.maxRetries,
    streamIdleTimeoutMs: streamConfig.idleTimeoutMs,
    // Read the persisted /thinking toggle from disk. Default false so a
    // launch on a config-less machine matches the pre-feature baseline
    // (provider-default thinking behavior, no surprise latency / cost
    // jumps). The /thinking command in App.tsx hot-swaps this flag
    // without restart via useAgent's setThinking.
    thinking: userConfig.thinking ?? false,
    toolProfile: userConfig.experimentalToolProfile === 'standard' ? 'standard' : 'full',
    browserVisualCheckEnabled: userConfig.browser?.visualCheck !== false,
    // Plan mode is session-scoped (matches Claude Code) — only the
    // `--plan` CLI flag opts in at startup. Mid-session toggles via
    // /plan don't persist, so each new launch starts in 'default'
    // unless explicitly requested.
    permissionMode: argv.plan ? 'plan' : 'default',
    modelRegistry: providerRegistry,
    memoryService,
    subAgentRegistry,
    skillRegistry,
    mcpRegistry: mcpLoadResult.registry,
    mcpPermissionStore,
    // --no-plugins: leave pluginRegistry undefined so the /plugin slash
    // commands can render "Plugin system is disabled..." instead of
    // falling through to the generic empty-state ("No plugins installed").
    // loadAllPlugins with disabled:true still returns a (non-null) empty
    // registry, so we have to drop it here at the wire-up site rather
    // than rely on the load result alone.
    pluginRegistry: argv.plugins === false ? undefined : pluginLoad.registry,
    commandRegistry,
    // --no-hooks: swap in an empty bus so emit-sites are no-ops without
    // touching the rest of plugin loading (skills / agents / mcp still
    // register, just nothing listens on lifecycle events).
    hookBus: argv.hooks === false ? emptyHookBus() : pluginIntegration.hookBus,
  }

  // Plugin SessionStart hooks. Fired at CLI launch so the hook can do
  // setup (env validation, context warm-up, etc.) BEFORE the user starts
  // interacting. Previously this lived in agentLoop's first-call branch,
  // which meant a session ending without any user message (e.g. the user
  // runs only slash commands then exits) never fired SessionStart, and
  // sessions that did fire saw it lag behind the first prompt. Symmetric
  // with the SessionEnd fire in `gracefulShutdown`. Fire-and-forget — a
  // slow hook must not block startup.
  if (options.hookBus?.has('SessionStart')) {
    options.hookBus
      .emit({ name: 'SessionStart', session: { cwd: process.cwd(), modelId } })
      .catch((err) => debugLog('agent.hook-session-start-error', String(err)))
  }

  // Resume / continue. Three resume entry points:
  //   1. `--continue` (-c): loads the most recent session synchronously
  //      here, no picker. Quick muscle-memory continuation.
  //   2. `--resume <id>`: looks up the session by id / slug / filename
  //      prefix and loads it directly. The post-exit hint we print
  //      ("Resume: xc --resume <id>") feeds back into this branch.
  //   3. `--resume` (no value): defer to the in-Ink picker via
  //      resumeIntent='pick', so the user can browse.
  // --continue takes precedence if both are set, matching CC.
  let initialSession: LoadedSession | null = null
  let resumeIntent: 'pick' | null = null
  if (argv.continue) {
    const latest = await pickLatestSession()
    if (!latest) {
      console.error('Note: --continue specified but no past sessions found in this project. Starting a fresh session.')
    } else {
      const loaded = await loadSession(latest.filePath)
      if (loaded) initialSession = loaded
    }
  } else if (typeof argv.resume === 'string') {
    if (argv.resume === '') {
      resumeIntent = 'pick'
    } else {
      const filePath = await findSessionFile(argv.resume)
      if (!filePath) {
        console.error(
          `Error: no session found matching "${argv.resume}". Run \`xc --resume\` to pick from the list, or \`xc -c\` for the most recent.`,
        )
        process.exit(1)
      }
      const loaded = await loadSession(filePath)
      if (!loaded) {
        console.error(`Error: failed to load session at ${filePath}. The file may be corrupted.`)
        process.exit(1)
      }
      initialSession = loaded
    }
  }

  // Combine prompt with stdin
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  // Print mode: bypass Ink entirely. Mounting the TUI refs raw stdin, which
  // keeps the Node event loop alive past the queued unmount — that's why -p
  // used to hang until a keypress. See packages/cli/src/print.ts.
  if (argv.print) {
    if (!fullPrompt) {
      console.error('Error: -p / --print requires a prompt (as an argument or via stdin).')
      process.exit(1)
    }
    // MCP Phase 2 (blocking): print mode is single-turn — all tools must
    // be available before agentLoop runs.
    await mcpLoadResult.registry.connectAll()
    const { runPrintMode } = await import('./print.js')
    const code = await runPrintMode(model, options, fullPrompt, initialSession)
    resetTerminal()
    process.exit(code)
  }

  // Heads-up: WebSearch needs a key. Print once, before Ink takes over, so
  // the hint lands in scrollback above the TUI. Not fatal — WebFetch still
  // works key-less, and the tool itself returns a detailed error if invoked
  // without a key configured.
  if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_API_KEY) {
    printNoWebSearchKeyHint()
  }

  // Start the app — waitUntilExit resolves when Ink unmounts (including on Ctrl+C)
  const waitUntilExit = startApp(model, options, fullPrompt || undefined, {
    initialSession,
    resumeIntent,
  })

  // MCP Phase 2 (non-blocking): fire connections in background while the
  // user sees the prompt immediately. onReady invalidates the system prompt
  // cache so the next turn picks up newly-discovered MCP tools.
  mcpLoadResult.registry
    .connectAll(() => {
      options.onMcpReady?.()
    })
    .catch((err) => debugLog('mcp.connectAll-error', String(err)))

  await waitUntilExit()

  // Normal exit path (including Ctrl+C which unmounts Ink first)
  await gracefulShutdown(0)
}

/** Resolve a user-provided session lookup key into a session jsonl
 *  path. Accepts the same forms a user might paste from the post-exit
 *  hint we print:
 *    - bare sessionId (`20260101-120000-000`)
 *    - legacy slug (`fix-login`)
 *    - legacy filename stem (`fix-login-20260101-120000-000`)
 *  Exact matches are preferred; if nothing exact matches, falls back
 *  to a prefix match against the sessionId (long enough to disambiguate).
 *  Returns the file path of the first match, newest first, or null. */
async function findSessionFile(input: string): Promise<string | null> {
  const sessions = await listSessions()
  for (const s of sessions) {
    if (s.sessionId === input) return s.filePath
    if (s.taskSlug && s.taskSlug === input) return s.filePath
    if (s.taskSlug && `${s.taskSlug}-${s.sessionId}` === input) return s.filePath
  }
  if (input.length >= 8) {
    for (const s of sessions) {
      if (s.sessionId.startsWith(input)) return s.filePath
    }
  }
  return null
}

/** Load .env file from cwd (walk up to find it, like dotenv convention) */
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // Ignore parse errors
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // reached root
    dir = parent
  }
}

/** Plain-terminal prompt used during startup, before Ink mounts.
 *  Currently the only caller is the MCP project-level trust dialog —
 *  loader.ts hands its `askUser` callback an arbitrary list of options
 *  and expects one of the option labels back.
 *
 *  Falls back gracefully when stdin isn't a TTY (piped input, CI,
 *  `--print` mode): we return the option whose label looks like
 *  "skip" if present, otherwise the second option (loader's convention
 *  is index 1 == safe default). This guarantees we never block waiting
 *  for input that will never arrive. */
async function askInTerminal(
  question: string,
  options: Array<{ label: string; description: string }>,
): Promise<string> {
  const safeDefault = options.find((o) => /skip/i.test(o.label))?.label ?? options[1]?.label ?? options[0]?.label ?? ''

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return safeDefault
  }

  const readline = await import('node:readline/promises')

  // Render to stderr so the prompt body lands in the same stream as
  // other CLI status messages; this keeps stdout clean if someone is
  // capturing it (rare during interactive startup but better-safe).
  process.stderr.write('\n' + chalk.yellow(question) + '\n')
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    process.stderr.write(`  ${chalk.bold(`${i + 1}.`)} ${o.label} — ${chalk.gray(o.description)}\n`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`\nChoose [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (Number.isFinite(idx) && idx >= 0 && idx < options.length) {
      return options[idx].label
    }
    return safeDefault
  } finally {
    rl.close()
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')

    const onData = (chunk: string): void => {
      data += chunk
    }
    const onEnd = (): void => {
      cleanup()
      resolve(data)
    }
    const cleanup = (): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      clearTimeout(timer)
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    // Timeout for stdin — don't hang forever
    const timer = setTimeout(() => {
      cleanup()
      resolve(data)
    }, 1000)
  })
}

// ── Fatal exception terminal restore ───────────────────────────────────
// Restore terminal state before Node reports a fatal uncaught error. A plain
// uncaughtException handler suppresses Node's default exit and can leave the
// process alive in an unknown state; the monitor observes without changing it.
process.on('uncaughtExceptionMonitor', () => {
  resetTerminal()
})

// ── SIGINT handler ──────────────────────────────────────────────────────
// Only a safety net: sets exitCode=0 so if the process exits before
// gracefulShutdown() runs, the exit code is still 0. On double Ctrl+C,
// force-exits immediately.
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
    // Double Ctrl+C → user wants out NOW. Skip async cleanup (gracefulShutdown
    // was already running from the first press) but ALWAYS restore the terminal
    // so the shell prompt is usable. Without this reset, raw mode / hidden
    // cursor / bracketed paste mode can leak into the shell.
    resetTerminal()
    printResumeHint()
    process.exit(0)
  }
})

main().catch((err) => {
  // If we're shutting down (Ctrl+C unmounted Ink, waitUntilExit rejected),
  // don't treat it as a fatal error — gracefulShutdown handles it.
  if (sigintCount > 0 || shutdownInProgress) {
    return
  }
  console.error('Fatal error:', err)
  process.exit(1)
})
