// @x-code-cli/core — Permission system (3-level model)
import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel, PermissionMode } from '../types/index.js'

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
  saveKnowledge: () => 'always-allow',
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

/** Check permission with trust mode + permission-mode support.
 *
 *  `permissionMode` semantics:
 *    - 'default': behave exactly as before — `ask`-level tools prompt.
 *    - 'acceptEdits': auto-allow `writeFile` and `edit` (the two tools
 *      whose default level is `ask` purely because they write files —
 *      the user opted into accepting all such writes). Shell still goes
 *      through normal classification so destructive commands stay
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
  onAskPermission: (toolCall: { toolCallId: string; toolName: string; input: PermissionInput }) => Promise<boolean>,
  permissionMode: PermissionMode = 'default',
): Promise<boolean> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'deny') return false
  if (level === 'always-allow' || trustMode) return true
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    return true
  }
  return onAskPermission(toolCall)
}
