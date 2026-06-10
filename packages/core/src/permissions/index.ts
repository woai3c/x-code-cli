// @x-code-cli/core — Permission system (3-level model)
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel, PermissionMode } from '../types/index.js'
import { addSessionAllowRule, buildAllowRule, persistRule, sessionRulesMatch } from './session-store.js'

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
  if (cached) return cached

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
  /[\\/]\.bashrc$/,
  /[\\/]\.bash_profile$/,
  /[\\/]\.profile$/,
  /[\\/]\.zshrc$/,
  /[\\/]\.zprofile$/,
  /[\\/]\.gitconfig$/,
  /[\\/]\.ssh[\\/]/,
  /[\\/]\.env$/,
  /[\\/]\.git[\\/]/,
  /[\\/]\.vscode[\\/]/,
  /[\\/]\.idea[\\/]/,
]

/** True when `filePath` is inside `projectDir` (or equals it). Normalizes
 *  both to forward-slash lower-case so Windows drive-letter differences and
 *  trailing separators don't cause false negatives. */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase()
  const file = normalize(filePath)
  const dir = normalize(projectDir)
  return file === dir || file.startsWith(dir + '/')
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
 *    - 'plan': pure prompt-based enforcement (mirrors Claude Code) —
 *      no permission-layer change. The system-prompt overlay tells the
 *      model not to write; if it ignores that, the regular `ask`
 *      prompt still fires.
 *
 *  Trust mode is the global override and beats everything except an
 *  explicit `deny`. */
export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<'yes' | 'always' | 'no'>,
  permissionMode: PermissionMode = 'default',
  cwd?: string,
): Promise<boolean> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'always-allow' || trustMode) return true
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    const filePath = (toolCall.input.filePath as string) ?? ''
    const projectDir = cwd ?? process.cwd()
    if (filePath && isPathWithinProject(filePath, projectDir) && !isSensitivePath(filePath)) {
      return true
    }
    // Path outside project or targeting sensitive file — fall through to ask
  }
  if (sessionRulesMatch(toolCall.toolName, toolCall.input)) return true

  const decision = await onAskPermission(toolCall)
  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input)
    if (result) {
      // buildAllowRule may return >1 rule for compound shells like
      // `git commit && git push` — the user-visible label
      // ("git commit:*, git push:*") shows both, and we save both
      // here so the next compound invocation auto-approves.
      for (const rule of result.rules) {
        addSessionAllowRule(rule)
        if (result.persist && cwd) persistRule(cwd, rule)
      }
    }
    return true
  }
  return decision === 'yes'
}

export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './session-store.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './session-store.js'
export { loadPersistedRules, persistRule } from './session-store.js'
