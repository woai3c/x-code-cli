import { MODEL_ALIASES } from '@x-code-cli/core'

import { VERSION } from '../../version.js'
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
  { name: '/ps', description: 'List managed background terminals' },
  { name: '/stop', description: 'Stop all or one managed background terminal', argumentHint: '[shell-id]' },
  { name: '/clear-peer-context', description: 'Remove the peer-influenced conversation suffix' },
  { name: '/list-agents', description: 'List reachable cross-session peers' },
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
    name: '/fork',
    description: 'Branch completed context into a new session, optionally named (working tree stays shared)',
    argumentHint: '[name]',
  },
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
    description: 'Configure interactive Browser Use and automatic local visual checks',
    subcommands: [
      { name: 'on', description: 'Enable interactive Browser Use via the browser agent' },
      { name: 'off', description: 'Disable interactive Browser Use' },
      { name: 'check-on', description: 'Enable automatic one-shot localhost screenshots' },
      { name: 'check-off', description: 'Disable automatic one-shot localhost screenshots' },
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

export const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every X-Code CLI (\`xc\`) session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`

export const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`
