import type { TurnOwner } from './agent/turn-coordinator.js'

/** Slash commands that are safe to run without acquiring the active turn.
 * Keep this policy shared by the input gate and the command dispatcher. */
export function isSlashCommandAllowedWhileBusy(
  text: string,
  activeOwner: TurnOwner,
  hasStableForkBoundary: boolean,
): boolean {
  const [command = '', subcommand = ''] = text.trimStart().slice(1).trim().toLowerCase().split(/\s+/)
  if (command === 'fork') {
    return hasStableForkBoundary && (activeOwner === 'user' || activeOwner === 'peer' || activeOwner === 'goal')
  }
  return command === 'goal' && ['pause', 'cancel', 'steer'].includes(subcommand)
}
