// @x-code-cli/core — Hook command executor
//
// Spawns a hook's shell command, writes the event JSON on stdin, reads
// the decision JSON from stdout. The whole protocol is line-oriented:
// one JSON object in, one JSON object out (or empty stdout = default
// allow). Anything else on stdout is ignored — common pattern for hooks
// that just want to log to stderr without influencing the agent.
//
// Failure handling is deliberately permissive (default `failurePolicy:
// 'allow'`): a broken hook must never wedge the agent loop. Non-zero
// exit, timeout, or crash all degrade to `allow` and log a debug
// breadcrumb. The `block` policy is opt-in and reserved for hooks the
// plugin author has explicitly designed as gating hooks.
//
// AbortSignal propagation: passed to execa's `cancelSignal` so the
// child process is SIGKILL'd when the user hits Esc mid-hook. Same
// machinery the shell tool uses.
import { execa } from 'execa'

import { getPluginUserConfigEnv } from '../plugins/user-config.js'
import { debugLog } from '../utils.js'
import type { HookConfigEntry, HookDecision, HookEvent, RegisteredHook } from './types.js'
import { buildVariableContext, expandVariables } from './variables.js'

/** Return the command appropriate for the current OS. Plugin authors
 *  set `command` as a portable default and may add `commandWindows` /
 *  `commandDarwin` / `commandLinux` to handle per-OS differences (e.g.
 *  shebang line, executable name, quoting). Unknown platforms (freebsd,
 *  sunos, aix) fall through to the base. */
function pickPlatformCommand(entry: HookConfigEntry): string {
  switch (process.platform) {
    case 'win32':
      return entry.commandWindows ?? entry.command
    case 'darwin':
      return entry.commandDarwin ?? entry.command
    case 'linux':
      return entry.commandLinux ?? entry.command
    default:
      return entry.command
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export interface ExecuteHookOptions {
  /** Cancels the hook child process when fired. Agent loop's abort
   *  signal flows through here so Esc during a slow hook kills it
   *  promptly. */
  signal?: AbortSignal
  /** Override the default 5s timeout. Per-hook `entry.timeout` still
   *  wins when both are set. Both are capped at 30s. */
  defaultTimeoutMs?: number
}

/** Run one hook against one event. Returns the parsed decision (default
 *  allow on anything unexpected). Never throws unless the caller's
 *  AbortSignal fires — abort is the one error worth bubbling because
 *  the caller's loop is already shutting down. */
export async function executeHook(
  hook: RegisteredHook,
  event: HookEvent,
  opts: ExecuteHookOptions = {},
): Promise<HookDecision> {
  const timeoutMs = Math.min(hook.entry.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const vars = buildVariableContext({
    pluginDir: hook.pluginDir,
    cwd: event.session.cwd,
    pluginId: hook.pluginId,
  })
  const expandedCommand = expandVariables(pickPlatformCommand(hook.entry), vars)
  const stdinPayload = JSON.stringify(buildStdinPayload(hook, event))

  // Merge the owning plugin's userConfig values into the hook's env.
  // Hook scripts that need an API key declared in the manifest read it as
  // `process.env[KEY]` without writing any glue — `${env:KEY}` substitution
  // in the command string also resolves against this merged env. We fail
  // silent if the read errors (no userConfig set yet ⇒ empty map).
  let pluginEnv: Record<string, string> = {}
  try {
    pluginEnv = await getPluginUserConfigEnv(hook.pluginId)
  } catch (err) {
    debugLog('hooks.user-config-read-failed', `${hook.pluginId}: ${String(err)}`)
  }

  try {
    const result = await execa(expandedCommand, [], {
      shell: true,
      input: stdinPayload,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      stdio: 'pipe',
      reject: false, // Non-zero exits handled below explicitly, not as throws.
      cwd: event.session.cwd,
      env: { ...process.env, ...pluginEnv },
    })

    if (opts.signal?.aborted) {
      // Aborted mid-execution. Caller's loop is winding down — surface
      // by throwing so the bus stops cascading further hooks.
      throw new Error('aborted')
    }

    if (result.timedOut) {
      debugLog('hooks.exec-timeout', `${hook.pluginId} ${event.name}: timed out after ${timeoutMs}ms`)
      return failurePolicyDecision(hook, `hook timed out after ${timeoutMs}ms`)
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      const stderrTail = (result.stderr ?? '').toString().slice(0, 200)
      debugLog('hooks.exec-nonzero', `${hook.pluginId} ${event.name}: exit ${result.exitCode} stderr=${stderrTail}`)
      return failurePolicyDecision(hook, `hook exited ${result.exitCode}`)
    }

    const decision = parseDecision(result.stdout ?? '', hook, event)
    // Trace successful hook runs so plugin authors can confirm their
    // hook actually fired without needing to add their own logging.
    // Stdio is `pipe`d (we read the JSON decision out of stdout), so
    // anything the hook writes to its own stderr is otherwise invisible
    // — this breadcrumb is what `--plugin-debug` / `DEBUG_STDOUT=1`
    // users grep for to verify the wiring.
    debugLog('hooks.exec-ran', `${hook.pluginId} ${event.name}: decision=${decision.decision}`)
    return decision
  } catch (err) {
    if (opts.signal?.aborted) throw err
    debugLog('hooks.exec-error', `${hook.pluginId} ${event.name}: ${String(err)}`)
    return failurePolicyDecision(hook, `hook crashed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function failurePolicyDecision(hook: RegisteredHook, reason: string): HookDecision {
  if (hook.entry.failurePolicy === 'block') return { decision: 'deny', reason }
  return { decision: 'allow' }
}

/** Build the JSON object sent to the hook over stdin. Event-specific
 *  fields are flattened in at the top level (matches Claude Code's
 *  hook protocol shape). */
function buildStdinPayload(hook: RegisteredHook, event: HookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: event.name,
    session: event.session,
    plugin: { id: hook.pluginId, dir: hook.pluginDir },
  }
  switch (event.name) {
    case 'UserPromptSubmit':
      base.prompt = event.prompt
      break
    case 'PreToolUse':
      base.tool = event.tool
      break
    case 'PostToolUse':
      base.tool = event.tool
      break
    case 'PreCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.tokenEstimate = event.tokenEstimate
      break
    case 'PostCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.summary = event.summary
      break
    case 'SubagentStart':
      base.agent = event.agent
      break
    case 'SubagentStop':
      base.agent = event.agent
      base.durationMs = event.durationMs
      base.outcome = event.outcome
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    case 'TurnComplete':
      base.turn = event.turn
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    // SessionStart / SessionEnd have no extra fields beyond session/plugin.
  }
  return base
}

function parseDecision(stdout: string, hook: RegisteredHook, event: HookEvent): HookDecision {
  const trimmed = (stdout ?? '').toString().trim()
  if (!trimmed) return { decision: 'allow' }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const d = obj.decision
      if (d === 'allow' || d === 'deny' || d === 'modify') {
        return obj as HookDecision
      }
    }
  } catch {
    // Not JSON — many hooks intend stdout for human eyes (logs). Treat
    // as default allow but breadcrumb in case the user expected it to
    // influence the agent.
    debugLog(
      'hooks.decision-not-json',
      `${hook.pluginId} ${event.name}: ignoring non-JSON stdout: ${trimmed.slice(0, 200)}`,
    )
  }
  return { decision: 'allow' }
}
