// @x-code-cli/core — Permission system (3-level model)
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionDecision, PermissionLevel, PermissionMode } from '../types/index.js'
import { persistRule } from './persistence.js'
import { addSessionAllowRule, buildAllowRule, sessionRulesMatch } from './session-store.js'

type PermissionInput = Record<string, unknown>

/**
 * Cache of resolved shell permission levels keyed by the exact command string.
 * Destructiveness / read-only patterns are static for the process lifetime,
 * so a plain Map is safe — no TTL needed. An upper bound guards against a
 * long-running agent accumulating unique commands without limit.
 */
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

function evaluateShellPermission(command: string): PermissionLevel {
  const subCommands = splitShellCommands(command)
  // Any sub-command destructive → deny the whole command
  if (subCommands.some(isDestructive)) return 'deny'
  // All sub-commands read-only → auto-allow
  if (subCommands.every(isReadOnly)) return 'always-allow'
  // Otherwise → ask
  return 'ask'
}

function resolveShellPermission(input: PermissionInput): PermissionLevel {
  const cmd = (input.command as string) ?? ''
  const cached = shellPermissionCache.get(cmd)
  if (cached) {
    // Refresh recency: a hit moves the entry to the end so the oldest-
    // inserted eviction below is a real LRU, not FIFO.
    shellPermissionCache.delete(cmd)
    shellPermissionCache.set(cmd, cached)
    return cached
  }

  const level = evaluateShellPermission(cmd)

  if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = shellPermissionCache.keys().next().value
    if (oldest !== undefined) shellPermissionCache.delete(oldest)
  }
  shellPermissionCache.set(cmd, level)
  return level
}

/** Permission rules for each tool */
const rules: Record<string, (input: PermissionInput) => PermissionLevel> = {
  readFile: () => 'always-allow',
  glob: () => 'always-allow',
  grep: () => 'always-allow',
  listDir: () => 'always-allow',
  webSearch: () => 'always-allow',
  webFetch: () => 'always-allow',
  askUser: () => 'always-allow',
  edit: () => 'ask',
  writeFile: () => 'ask',
  shell: resolveShellPermission,
}

/** Get permission level for a tool call */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  const rule = rules[toolName]
  if (!rule) return 'ask' // Unknown tool defaults to ask
  return rule(input)
}

// ── Path safety for write tools ──
// Sensitive dotfile / config paths that should never be auto-approved even
// when acceptEdits is active. Matches Claude Code's isDangerousFilePathToAutoEdit.
const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.bashrc$/i,
  /[\\/]\.bash_profile$/i,
  /[\\/]\.profile$/i,
  /[\\/]\.zshrc$/i,
  /[\\/]\.zprofile$/i,
  /[\\/]\.gitconfig$/i,
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.env$/i,
  /[\\/]\.git[\\/]/i,
  /[\\/]\.vscode[\\/]/i,
  /[\\/]\.idea[\\/]/i,
]

/** Resolve the deepest existing ancestor through symlinks, then append any
 * nonexistent suffix. This keeps permission checks aligned with the path the
 * filesystem will actually mutate. */
export function resolvePhysicalPath(filePath: string, baseDir: string = process.cwd()): string {
  let candidate = path.resolve(baseDir, filePath)
  const suffix: string[] = []
  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...suffix.reverse())
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return path.resolve(baseDir, filePath)
      suffix.push(path.basename(candidate))
      candidate = parent
    }
  }
}

/** True when `filePath` physically resolves inside `projectDir` (or equals
 * it). Case folding is Windows-only; Linux and case-sensitive macOS volumes
 * must not conflate distinct paths. */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  const dir = resolvePhysicalPath(projectDir)
  const file = resolvePhysicalPath(filePath, projectDir)
  const relative = path.relative(dir, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))
}

/** Check permission with trust mode + permission-mode support.
 *
 *  `permissionMode` semantics:
 *    - 'default': behave exactly as before — `ask`-level tools prompt.
 *    - 'acceptEdits': auto-allow `writeFile` and `edit` **only if the
 *      target path is inside the project directory** and not a sensitive
 *      dotfile. Paths outside cwd or targeting .bashrc/.git/etc. fall
 *      back to `ask` so the user must explicitly consent. Shell still
 *      goes through normal classification so destructive commands stay
 *      gated, and `deny`-level results still deny.
 *    - 'plan': the agent dispatcher exposes a read/plan-only allowlist and
 *      rejects writes outside currentPlanPath before this function runs.
 *
 *  Trust mode is the global override and beats everything except an
 *  explicit `deny`. */
export interface PermissionGateResult {
  approved: boolean
  /** Free-text explanation the user typed when denying via the
   *  "No, and tell X-Code what to do instead" option; undefined for a
   *  plain No. Callers append it to the denial tool result. */
  feedback?: string
}

/** Detailed variant of checkPermission that also returns the user's
 *  denial feedback. The boolean wrapper below stays for callers that
 *  only care about allow/deny (goal verifier, existing tests). */
export async function checkPermissionDetailed(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<PermissionDecision>,
  permissionMode: PermissionMode = 'default',
  projectCwd?: string,
  executionCwd?: string,
): Promise<PermissionGateResult> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'always-allow' || trustMode) return { approved: true }
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    const filePath = (toolCall.input.filePath as string) ?? ''
    const projectDir = projectCwd ?? process.cwd()
    const physicalPath = filePath ? resolvePhysicalPath(filePath, projectDir) : ''
    if (
      filePath &&
      isPathWithinProject(filePath, projectDir) &&
      !isSensitivePath(filePath) &&
      !isSensitivePath(physicalPath)
    ) {
      return { approved: true }
    }
    // Path outside project or targeting sensitive file — fall through to ask
  }
  if (sessionRulesMatch(toolCall.toolName, toolCall.input, executionCwd)) return { approved: true }

  const decision = await onAskPermission(toolCall)
  if (typeof decision === 'object') return { approved: false, feedback: decision.feedback }
  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input, executionCwd)
    if (result) {
      // buildAllowRule may return >1 rule for compound shells like
      // `git commit && git push` — the user-visible label
      // ("git commit:*, git push:*") shows both, and we save both
      // here so the next compound invocation auto-approves.
      for (const rule of result.rules) {
        addSessionAllowRule(rule)
        if (result.persist && projectCwd) persistRule(projectCwd, rule)
      }
    }
    return { approved: true }
  }
  return { approved: decision === 'yes' }
}

export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<PermissionDecision>,
  permissionMode: PermissionMode = 'default',
  projectCwd?: string,
  executionCwd?: string,
): Promise<boolean> {
  return (await checkPermissionDetailed(toolCall, trustMode, onAskPermission, permissionMode, projectCwd, executionCwd))
    .approved
}

export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './session-store.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './session-store.js'
export { loadPersistedRules, persistRule } from './session-store.js'
export {
  MAX_EGRESS_APPROVAL_BYTES,
  authoritySnapshotHash,
  canonicalizeToolInput,
  classifyToolCall,
  evaluateToolAuthority,
  sha256Text,
  verifyAuthorityApproval,
} from './authority.js'
