// @x-code/core — Permission system (3-level model)
import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel } from '../types/index.js'

type PermissionInput = Record<string, unknown>

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
  enterPlanMode: () => 'always-allow',
  exitPlanMode: () => 'always-allow',
  shell: (input) => {
    const cmd = (input.command as string) ?? ''
    const subCommands = splitShellCommands(cmd)

    // Any sub-command destructive → deny the whole command
    if (subCommands.some(isDestructive)) return 'deny'
    // All sub-commands read-only → auto-allow
    if (subCommands.every(isReadOnly)) return 'always-allow'
    // Otherwise → ask
    return 'ask'
  },
}

/** Get permission level for a tool call */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  const rule = rules[toolName]
  if (!rule) return 'ask' // Unknown tool defaults to ask
  return rule(input)
}

/** Check permission with trust mode support */
export async function checkPermission(
  toolCall: { toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: { toolName: string; input: PermissionInput }) => Promise<boolean>,
): Promise<boolean> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'deny') return false
  if (level === 'always-allow' || trustMode) return true
  return onAskPermission(toolCall)
}
