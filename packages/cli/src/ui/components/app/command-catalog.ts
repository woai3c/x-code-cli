import { MODEL_ALIASES } from '@x-code-cli/core'

import { VERSION } from '../../../version.js'
import type { SlashCommand } from '../chat-input/types.js'

export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show this help message' },
  {
    name: '/model',
    description: 'Pick a model (no-arg = interactive) — choice is saved',
    argumentHint: '[model-id]',
  },
  {
    name: '/thinking',
    description: 'Toggle extended thinking on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  {
    name: '/theme',
    description: 'Pick UI theme (no-arg = interactive picker) — drives diff colors + syntax palette',
    argumentHint: '[name]',
  },
  {
    name: '/plan',
    description: 'Toggle plan mode on/off (no-arg = show status) — saved',
    argumentHint: '[on|off]',
  },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Manually compress context' },
  {
    name: '/goal',
    description: 'Run a durable, verifiable goal loop',
    argumentHint: '<objective>|status|pause|resume|cancel|clear|steer|verify',
    subcommands: [
      { name: 'status', description: 'Show current goal state' },
      { name: 'pause', description: 'Pause the active goal loop' },
      { name: 'resume', description: 'Resume a paused or blocked goal loop' },
      { name: 'cancel', description: 'Cancel the current goal' },
      { name: 'clear', description: 'Clear current goal state' },
      { name: 'edit', description: 'Edit objective or max-turns for the current goal' },
      { name: 'steer', description: 'Add steering input for the next goal turn' },
      { name: 'verify', description: 'Wake the goal runner to verify/continue' },
    ],
  },
  { name: '/resume', description: 'Pick a past session in this project to resume', argumentHint: '[id]' },
  {
    name: '/rewind',
    description: 'Roll back files + conversation to a previous user message (no-arg = picker)',
    argumentHint: '[checkpoint-id]',
  },
  { name: '/init', description: 'Initialize project knowledge' },
  { name: '/review', description: 'Review a pull request (no-arg = list open PRs)', argumentHint: '[PR]' },
  { name: '/usage', description: 'Show current-session token usage (input/output/cache)' },
  { name: '/usage-history', description: 'List past sessions in this project' },
  {
    name: '/memory',
    description: 'Inspect and manage global long-term memory',
    subcommands: [
      { name: 'status', description: 'Show schema, generation, queue, worker, and invalid topics' },
      { name: 'search', description: 'Search memory locally; add --semantic for AI topic selection' },
      { name: 'explain', description: 'Explain the most recent recall decision' },
      { name: 'reload', description: 'Reload manually edited topics and rebuild MEMORY.md' },
    ],
  },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    subcommands: [
      { name: 'list', description: 'List configured MCP servers' },
      { name: 'tools', description: 'List tools from connected servers (optionally filter by server)' },
      { name: 'add', description: 'Add a new MCP server (stdio or http) to user / project config' },
      { name: 'add-json', description: 'Add an MCP server from a raw JSON config object' },
      { name: 'remove', description: 'Remove an MCP server from config' },
      { name: 'auth', description: 'Authenticate an HTTP MCP server via OAuth' },
      { name: 'logout', description: 'Clear stored OAuth tokens for a server' },
      { name: 'refresh', description: 'Reload mcpServers from disk and reconnect' },
    ],
  },
  {
    name: '/skill',
    description: 'Manage skills',
    subcommands: [
      { name: 'install', description: 'Fetch and install a skill from a URL' },
      { name: 'list', description: 'List installed skills (with on/off state)' },
      { name: 'refresh', description: 'Re-scan skills dirs and apply changes without restart' },
      { name: 'disable', description: 'Disable a skill (kept on disk; run /skill refresh to apply now)' },
      { name: 'enable', description: 'Re-enable a previously disabled skill' },
      { name: 'uninstall', description: 'Delete a skill directory from disk' },
    ],
  },
  {
    name: '/plugin',
    description: 'Manage plugins (bundled skills / agents / mcp / hooks)',
    subcommands: [
      { name: 'list', description: 'List installed plugins (with enable state + source)' },
      { name: 'info', description: "Show a plugin's manifest, contributions, and hooks" },
      {
        name: 'install',
        description: 'Install a plugin from <name@marketplace>, git, github:owner/repo, or local path',
      },
      { name: 'uninstall', description: 'Remove a plugin (cache + settings entry; data dir preserved)' },
      {
        name: 'enable',
        description: 'Enable a plugin (writes settings — restart for full effect; --scope=user|project)',
      },
      { name: 'disable', description: 'Disable a plugin without uninstalling (--scope=user|project)' },
      { name: 'search', description: 'Search subscribed marketplaces by keyword' },
      { name: 'update', description: 'Reinstall a plugin from its recorded source' },
      { name: 'refresh', description: 'Live-reload plugins + skills/agents/commands/hooks/MCP servers' },
      { name: 'doctor', description: 'Show plugin load errors and integration warnings' },
      { name: 'marketplace', description: 'Manage marketplace subscriptions (add | remove | list | refresh | info)' },
    ],
  },
  {
    name: '/browser',
    description: 'Toggle the browser sub-agent on/off (no-arg = status) — opt-in, saved',
    subcommands: [
      { name: 'on', description: 'Enable the browser agent (live web automation via @playwright/mcp)' },
      { name: 'off', description: 'Disable the browser agent and close any running browser' },
    ],
  },
  { name: '/doctor', description: 'Diagnose environment, API keys, MCP servers, plugins, and agents' },
  { name: '/exit', description: 'Exit (flushes session)' },
] as const satisfies readonly SlashCommand[]

export function buildHelpText(
  skillCommands: readonly { name: string; description: string }[],
  fileCommands: readonly { name: string; description?: string }[],
): string {
  const allCommands = [
    ...SLASH_COMMANDS,
    ...skillCommands.map((skill) => ({ name: `/${skill.name}`, description: skill.description })),
    ...fileCommands.map((command) => ({ name: `/${command.name}`, description: command.description ?? '' })),
  ]
  return (
    `X-Code CLI v${VERSION}\n\n` +
    allCommands.map((command) => `  ${command.name.padEnd(16)} ${command.description}`).join('\n') +
    `\n\nModel aliases: ${Object.keys(MODEL_ALIASES).join(', ')}` +
    `\nKeyboard: Esc to interrupt the current turn · ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} (twice) to exit`
  )
}
